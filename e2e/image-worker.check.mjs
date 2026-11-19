#!/usr/bin/env node
/**
 * Runs the image worker in real Chromium, against the dev server and against a production
 * build served under a subpath, and checks that importing still works in the built site.
 *
 *   node e2e/image-worker.check.mjs [--out <folder for the report and sample images>]
 *                                   [--compare-with <git commit, branch or tag>]
 *
 * With --compare-with, it also shows whether this version of the app and another one make the
 * same files. The other version's source is exported from git into a scratch folder (nothing in
 * the repository changes), given this version's check page, and served; both then render the
 * same ordinary cards (no colour, crop inside the photo), and every output file is compared
 * byte for byte by its checksum. Without the option that step is skipped.
 *
 * It needs Playwright with Chromium to be installed on the machine already; it is not a
 * dependency of this project yet, so this is not part of `npm test` or the deploy workflow.
 * Nothing it produces is written inside the repository except the normal `dist` build.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '/social-content-studio/';
const PORTS = { dev: 5191, site: 5192, harness: 5193, compare: 5187 };
const compareFlag = process.argv.indexOf('--compare-with');
const compareWith = compareFlag > -1 ? process.argv[compareFlag + 1] : null;
const outFlag = process.argv.indexOf('--out');
const outDir = resolve(
  outFlag > -1 ? process.argv[outFlag + 1] : join(tmpdir(), 'image-worker-check'),
);
const harnessDist = join(outDir, 'worker-check-dist');
mkdirSync(outDir, { recursive: true });

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('Playwright is not installed on this machine, so the browser check cannot run.');
  process.exit(2);
}

const servers = [];
function serve(args, env, url, cwd = root) {
  const child = spawn('npx', ['vite', ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    detached: true,
  });
  servers.push(child);
  return waitFor(url);
}
async function waitFor(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`server did not start at ${url}`);
}
function stopServers() {
  for (const child of servers.splice(0)) {
    try {
      process.kill(-child.pid);
    } catch {
      // already gone
    }
  }
}

/** Renders the comparison cards on a check page and returns each file's size and checksum. */
async function comparisonFiles(browser, url) {
  const { context, page, problems } = await openPage(browser, url);
  await page.waitForFunction(() => typeof window.renderForComparison === 'function');
  const files = await page.evaluate(() => window.renderForComparison());
  await context.close();
  if (problems.length) throw new Error(`comparison page: ${problems.join(' | ')}`);
  return files;
}

/**
 * The comparison files as another version of the app makes them. That version's source is
 * exported from git into a scratch folder, with this version's check page put in place of its
 * own so both run the same cards, and served on its own, before this version's servers
 * are started.
 */
async function filesFromOtherVersion(browser, ref) {
  const tree = join(outDir, 'compare-tree');
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  const commit = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  execFileSync('sh', ['-c', `git archive ${commit} | tar -x -C "${tree}"`], { cwd: root });
  // The installed packages are linked one by one into a folder of the other version's own, so
  // the dev server's prepared-dependency cache (node_modules/.vite) is not shared with this
  // version's. Sharing it makes this version's dev server prepare its dependencies again later,
  // which reloads the page in the middle of whichever check runs next.
  mkdirSync(join(tree, 'node_modules'));
  for (const entry of readdirSync(join(root, 'node_modules'))) {
    if (entry === '.vite' || entry === '.tmp') continue;
    symlinkSync(join(root, 'node_modules', entry), join(tree, 'node_modules', entry));
  }
  cpSync(join(root, 'e2e/worker-check'), join(tree, 'e2e/worker-check'), { recursive: true });
  const url = `http://localhost:${PORTS.compare}/`;
  await serve(['--port', String(PORTS.compare), '--strictPort'], {}, url, tree);
  try {
    return { commit, files: await comparisonFiles(browser, `${url}e2e/worker-check/index.html`) };
  } finally {
    stopServers();
  }
}

function printComparison(ref, other, mine) {
  console.log(`\n== Output files compared with ${ref} (${other.commit.slice(0, 7)})`);
  const names = [...new Set([...Object.keys(other.files), ...Object.keys(mine)])];
  const different = names.filter((name) => other.files[name] !== mine[name]);
  for (const name of different) {
    console.log(`  DIFFERENT  ${name}`);
    console.log(`          ${ref}: ${other.files[name] ?? 'not made'}`);
    console.log(`          this version: ${mine[name] ?? 'not made'}`);
  }
  const ok = different.length === 0 && names.length > 0;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${names.length - different.length} of ${names.length} files are ` +
      'identical, byte for byte',
  );
  return ok;
}

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory()
      ? listFiles(full, base)
      : [{ path: relative(base, full), bytes: statSync(full).size }];
  });
}

/** Opens a page and records every request it or its workers make, and every console error. */
async function openPage(browser, url) {
  const context = await browser.newContext();
  const requests = [];
  const problems = [];
  context.on('request', (request) => requests.push(request.url()));
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()}`));
  await page.goto(url, { waitUntil: 'load' });
  return { context, page, requests, problems };
}

function outside(requests, allowedPrefix) {
  return requests.filter((url) => !url.startsWith(allowedPrefix) && !/^(blob|data):/.test(url));
}

function printReports(reports) {
  for (const report of reports) {
    console.log(`  ${report.ok ? 'PASS' : 'FAIL'}  ${report.name}`);
    for (const check of report.checks) {
      if (!check.ok) console.log(`          x ${check.name}: ${check.detail}`);
    }
  }
}

async function runHarness(browser, label, url, allowedPrefix) {
  console.log(`\n== Worker checks: ${label} (${url})`);
  const { context, page, requests, problems } = await openPage(browser, url);
  await page.waitForFunction(() => typeof window.runImageWorkerChecks === 'function');
  const result = await page.evaluate(() => window.runImageWorkerChecks({ large: true }));
  await context.close();

  printReports(result.reports);
  for (const [name, dataUrl] of Object.entries(result.images)) {
    writeFileSync(join(outDir, `${label}-${name}`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  writeFileSync(
    join(outDir, `${label}-report.json`),
    JSON.stringify({ reports: result.reports, requests, problems }, null, 2),
  );
  const large = result.reports.find((report) => report.name.startsWith('large photo'));
  console.log(`  large photo: ${JSON.stringify(large?.info)}`);

  const stray = outside(requests, allowedPrefix);
  const heic = requests.filter((request) => /heic-to/.test(request));
  const worker = requests.filter((request) => /image\.worker/.test(request));
  console.log(`  requests: ${requests.length}, all under ${allowedPrefix}: ${stray.length === 0}`);
  console.log(
    `  worker file requests: ${worker.length}; HEIC decoder requests: ${heic.join(', ')}`,
  );
  if (stray.length) console.log(`  OUTSIDE: ${stray.join(', ')}`);
  if (problems.length) console.log(`  PROBLEMS: ${problems.join(' | ')}`);
  return result.ok && stray.length === 0 && problems.length === 0 && heic.length > 0;
}

async function importRegression(browser, url, allowedPrefix) {
  console.log(`\n== Import regression in the built site (${url})`);
  const { context, page, requests, problems } = await openPage(browser, url);
  const pngBase64 = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(320, 200);
    const context2d = canvas.getContext('2d');
    context2d.fillStyle = '#3366cc';
    context2d.fillRect(0, 0, 320, 200);
    const bytes = new Uint8Array(
      await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    );
    return btoa(String.fromCharCode(...bytes));
  });
  await page.getByRole('button', { name: 'New session' }).click();
  // The system's file picker cannot be driven, so the files are given to the input directly.
  await page.getByLabel('Photos to import').setInputFiles([
    { name: 'blue.png', mimeType: 'image/png', buffer: Buffer.from(pngBase64, 'base64') },
    {
      name: 'gradient.heic',
      mimeType: 'image/heic',
      buffer: readFileSync(join(root, 'e2e/fixtures/gradient.heic')),
    },
  ]);
  const thumbnails = page.locator('ul[aria-label="Imported photos"] img');
  let imported = 0;
  try {
    await thumbnails.nth(1).waitFor({ timeout: 60_000 });
    imported = await thumbnails.count();
  } catch {
    // reported below
  }
  const rows = await page.locator('ul[aria-label="Import results"] li').allInnerTexts();
  await context.close();

  const stray = outside(requests, allowedPrefix);
  const ok =
    imported === 2 &&
    rows.some((row) => row.includes('blue.png') && row.includes('Imported, 320 x 200')) &&
    rows.some((row) => row.includes('gradient.heic') && row.includes('Imported, 640 x 480')) &&
    stray.length === 0 &&
    problems.length === 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  PNG and HEIC imported with previews: ${imported} of 2`);
  for (const row of rows) console.log(`          ${row.replace(/\s+/g, ' ')}`);
  console.log(`  requests: ${requests.length}, all under ${allowedPrefix}: ${stray.length === 0}`);
  console.log(`  HEIC decoder requests: ${requests.filter((r) => /heic-to/.test(r)).join(', ')}`);
  if (stray.length) console.log(`  OUTSIDE: ${stray.join(', ')}`);
  if (problems.length) console.log(`  PROBLEMS: ${problems.join(' | ')}`);
  return ok;
}

let failed = false;
const browser = await chromium.launch();
try {
  console.log(`Chromium ${browser.version()}; report and sample images in ${outDir}`);
  const other = compareWith ? await filesFromOtherVersion(browser, compareWith) : null;

  await serve(['--port', String(PORTS.dev), '--strictPort'], {}, `http://localhost:${PORTS.dev}/`);
  const devUrl = `http://localhost:${PORTS.dev}/`;
  failed =
    !(await runHarness(browser, 'dev', `${devUrl}e2e/worker-check/index.html`, devUrl)) || failed;
  if (other) {
    const mine = await comparisonFiles(browser, `${devUrl}e2e/worker-check/index.html`);
    failed = !printComparison(compareWith, other, mine) || failed;
  }

  console.log(`\n== Production build with BASE_PATH=${BASE}`);
  const buildEnv = { ...process.env, BASE_PATH: BASE };
  execFileSync('npm', ['run', 'build'], { cwd: root, env: buildEnv, stdio: 'ignore' });
  const siteFiles = listFiles(join(root, 'dist'));
  for (const file of siteFiles)
    console.log(`  ${String(file.bytes).padStart(9)}  dist/${file.path}`);
  const leaked = siteFiles.filter(
    (file) =>
      /worker-check|e2e|harness|fixtures|gradient/i.test(file.path) ||
      (/\.(js|html)$/.test(file.path) &&
        readFileSync(join(root, 'dist', file.path), 'utf8').includes('runImageWorkerChecks')),
  );
  console.log(
    `  check page or its script in the site build: ${leaked.length === 0 ? 'no' : 'YES'}`,
  );
  failed = leaked.length > 0 || failed;

  execFileSync('npx', ['vite', 'build', '--config', 'e2e/vite.harness.config.ts'], {
    cwd: root,
    env: { ...buildEnv, HARNESS_OUT: harnessDist },
    stdio: 'ignore',
  });
  console.log('  separate build of the check page (scratch folder, not dist):');
  for (const file of listFiles(harnessDist).filter((f) => f.path.endsWith('.js'))) {
    console.log(`  ${String(file.bytes).padStart(9)}  ${file.path}`);
  }

  const siteUrl = `http://localhost:${PORTS.site}${BASE}`;
  const harnessUrl = `http://localhost:${PORTS.harness}${BASE}`;
  await serve(
    ['preview', '--port', String(PORTS.site), '--strictPort'],
    { BASE_PATH: BASE },
    siteUrl,
  );
  await serve(
    [
      'preview',
      '--config',
      'e2e/vite.harness.config.ts',
      '--port',
      String(PORTS.harness),
      '--strictPort',
    ],
    { BASE_PATH: BASE, HARNESS_OUT: harnessDist },
    `${harnessUrl}e2e/worker-check/index.html`,
  );
  failed =
    !(await runHarness(
      browser,
      'production',
      `${harnessUrl}e2e/worker-check/index.html`,
      harnessUrl,
    )) || failed;
  failed = !(await importRegression(browser, siteUrl, siteUrl)) || failed;
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser.close();
  stopServers();
}
console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: all checks passed');
process.exit(failed ? 1 : 0);
