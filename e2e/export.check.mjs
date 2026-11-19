#!/usr/bin/env node
/**
 * Checks export in real Chromium, against the dev server and against a production build served
 * under a subpath:
 *
 *   node e2e/export.check.mjs [--out <folder for the report>]
 *
 * It proves the Phase 1 gate (SPEC.md: "One photo becomes two valid files; session survives a
 * browser reload"). It imports one photo made in the browser (no personal images, no metadata),
 * creates an Instagram Feed vertical and a LinkedIn Image post square card, and checks:
 *
 * - while the board is making its previews, both export buttons are disabled with a hint;
 * - "Download as .zip": exactly two images and captions.csv, named
 *   {session}_{platform}_{placement}_{cardId}.{ext} in per-platform folders, each a valid JPG at
 *   the size in src/data/platforms.json, with no EXIF, GPS, XMP, ICC, comment or other hidden
 *   data (read with this file's own parser, not the app's), and a captions.csv that lists them;
 * - PNG: the session is downloaded as .scs, one card's format is set to PNG in session.json (the
 *   app has no format control yet), and the reloaded session exports a valid PNG with only
 *   IHDR, IDAT and IEND chunks;
 * - the override: in the same edit, the other card gets a caption one character over its cap
 *   (no generated photo can make a card fail: every render is the exact size and these
 *   placements have no file-size cap). That card is left out of the zip with its reason; after
 *   ticking "Export this card even though it fails its checks" it is exported and captions.csv
 *   says "Fail, exported with override";
 * - "Export to session folder", with the folder picker replaced by a browser-private (OPFS)
 *   folder: the same files appear in exports/instagram/, exports/linkedin/ and captions.csv;
 * - nothing stale is written: while an export job is held back, the card's crop is moved; the
 *   card is listed as changed, its earlier file is left exactly as it was, and captions.csv
 *   lists only the file that was written;
 * - the session survives a reload ("Reopen last"), with the exported files still there;
 * - every request stays under the app's own address, with no failed requests and no console
 *   errors.
 *
 * Like the other checks in this folder, it needs Playwright with Chromium already installed on
 * the machine, and is not part of `npm test` or the deploy workflow. Nothing it produces is
 * written inside the repository except the normal `dist` build.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const BASE = '/social-content-studio/';
const PORTS = { dev: 5188, site: 5189 };
const outFlag = process.argv.indexOf('--out');
const outDir = resolve(outFlag > -1 ? process.argv[outFlag + 1] : join(tmpdir(), 'export-check'));
mkdirSync(outDir, { recursive: true });

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed on this machine, so the browser check cannot run.');
  process.exit(2);
}
const JSZip = require('jszip');

// Sizes and caps come from the platform data, never from this file.
const platforms = JSON.parse(readFileSync(join(root, 'src/data/platforms.json'), 'utf8'));
const placementOf = (platform, placement) =>
  platforms.placements.find((p) => p.platform === platform && p.placement === placement);
const FEED = placementOf('instagram', 'feed-vertical');
const SQUARE = placementOf('linkedin', 'image-square');
const SIZE = { 'feed-vertical': FEED.sizes[0], 'image-square': SQUARE.sizes[0] };

const SESSION_NAME = 'Export check: phase 1';
/** The session part of every file name, worked out here independently of the app. */
const SESSION_PART = 'Export-check-phase-1';
const ZIP_NAME = `${SESSION_PART}_export.zip`;
const PHOTO = 'export-check.jpg';
const FEED_CARD = `Instagram Feed vertical for ${PHOTO}, v1`;
const SQUARE_CARD = `LinkedIn Image post square for ${PHOTO}, v1`;
const BUSY_HINT = 'Export will be available when the board has finished making its previews.';
const OVERRIDE_LABEL = 'Export this card even though it fails its checks';
const OPFS_FOLDER = 'export-check-session';
const FILE_NAME = new RegExp(
  `^(instagram|linkedin)/${SESSION_PART}_(instagram|linkedin)_(feed-vertical|image-square)_[0-9a-f-]{36}\\.(jpg|png)$`,
);

// --------------------------------------------------------------------------- servers

const servers = [];
function serve(args, env, url) {
  const child = spawn('npx', ['vite', ...args], {
    cwd: root,
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
  for (const child of servers) {
    try {
      process.kill(-child.pid);
    } catch {
      // already gone
    }
  }
}

// --------------------------------------------------------------------------- in the page

/**
 * Runs in the page before the app. Render jobs sent to a worker can be held back on request:
 * `__hold = 'board'` holds the board's jobs, `__hold = 'export'` holds the export's jobs (their
 * ids start with "export-"). `__release()` sends everything held.
 */
function controlWorkers() {
  window.__hold = null;
  window.__held = [];
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function postMessage(message, ...rest) {
    const id = message && message.type === 'render' ? message.job.id : null;
    const isExport = typeof id === 'string' && id.startsWith('export-');
    if (id !== null && window.__hold !== null && (window.__hold === 'export') === isExport) {
      window.__held.push(() => post.call(this, message, ...rest));
      return undefined;
    }
    return post.call(this, message, ...rest);
  };
  window.__release = () => {
    window.__hold = null;
    const held = window.__held.splice(0);
    for (const send of held) send();
    return held.length;
  };
}

/**
 * Runs in the page before the app. The folder picker returns a browser-private (OPFS) folder,
 * which supports the same reads and writes as a folder on disk, so the folder path can be
 * checked without a real picker.
 */
function folderStandIn(folderName) {
  window.showDirectoryPicker = async () => {
    const opfs = await navigator.storage.getDirectory();
    return opfs.getDirectoryHandle(folderName, { create: true });
  };
  const proto = FileSystemHandle.prototype;
  if (!('queryPermission' in proto)) proto.queryPermission = async () => 'granted';
  if (!('requestPermission' in proto)) proto.requestPermission = async () => 'granted';
}

/** The test photo, drawn in the browser: a gradient and two shapes. No metadata. */
async function makePhoto(page) {
  const base64 = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(4032, 3024);
    const g = canvas.getContext('2d');
    const gradient = g.createLinearGradient(0, 0, 4032, 3024);
    gradient.addColorStop(0, '#4548cc');
    gradient.addColorStop(0.5, '#ffb38a');
    gradient.addColorStop(1, '#1b9c63');
    g.fillStyle = gradient;
    g.fillRect(0, 0, 4032, 3024);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(2016, 1300, 500, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0b1140';
    g.fillRect(1700, 1900, 640, 900);
    const bytes = new Uint8Array(
      await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer(),
    );
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  });
  return Buffer.from(base64, 'base64');
}

/** Decodes an image in the browser and returns its size in pixels, or null if it will not open. */
async function decodedSize(page, bytes) {
  return page.evaluate(async (base64) => {
    const binary = atob(base64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    try {
      const bitmap = await createImageBitmap(new Blob([data]));
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch {
      return null;
    }
  }, Buffer.from(bytes).toString('base64'));
}

/** Every file under exports/ in the stand-in folder, by path, as bytes. */
async function readExportsFolder(page) {
  const files = await page.evaluate(async (folderName) => {
    const opfs = await navigator.storage.getDirectory();
    const session = await opfs.getDirectoryHandle(folderName);
    const out = {};
    async function walk(dir, prefix) {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') await walk(handle, `${prefix}${name}/`);
        else {
          const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
          let text = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          out[`${prefix}${name}`] = btoa(text);
        }
      }
    }
    await walk(await session.getDirectoryHandle('exports'), '');
    return out;
  }, OPFS_FOLDER);
  return new Map(Object.entries(files).map(([path, b64]) => [path, Buffer.from(b64, 'base64')]));
}

// --------------------------------------------------------------------------- file parsers

/**
 * Lists a JPG's markers, independently of the app's own code. Returns the hidden-data findings:
 * any APP1 to APP15 segment, any comment, a JFIF thumbnail, or data after the end marker.
 */
function jpegFindings(bytes) {
  const found = [];
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return ['not a JPG'];
  let i = 2;
  for (;;) {
    if (i + 2 > bytes.length || bytes[i] !== 0xff) return [...found, 'damaged'];
    const marker = bytes[i + 1];
    if (marker === 0xd9) {
      if (i + 2 < bytes.length) found.push('data after the end');
      return found;
    }
    if (i + 4 > bytes.length) return [...found, 'damaged'];
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xe1 && marker <= 0xef) found.push(`APP${marker - 0xe0}`);
    if (marker === 0xfe) found.push('comment');
    if (marker === 0xe0 && (bytes[i + 16] !== 0 || bytes[i + 17] !== 0 || length !== 16)) {
      found.push('JFIF thumbnail');
    }
    i += 2 + length;
    if (marker === 0xda) {
      // Skip the coded data to the next real marker.
      while (i + 1 < bytes.length) {
        if (
          bytes[i] === 0xff &&
          bytes[i + 1] !== 0 &&
          !(bytes[i + 1] >= 0xd0 && bytes[i + 1] <= 0xd7)
        ) {
          if (bytes[i + 1] === 0xff) {
            i += 1;
            continue;
          }
          break;
        }
        i += 1;
      }
    }
  }
}

/** Lists a PNG's chunks. Returns any chunk other than IHDR, PLTE, tRNS, IDAT and IEND. */
function pngFindings(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) return ['not a PNG'];
  const found = [];
  let i = 8;
  for (;;) {
    if (i + 12 > bytes.length) return [...found, 'damaged'];
    const length = bytes.readUInt32BE(i);
    const type = bytes.toString('latin1', i + 4, i + 8);
    if (!['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) found.push(type);
    i += 12 + length;
    if (type === 'IEND') {
      if (i < bytes.length) found.push('data after the end');
      return found;
    }
  }
}

/** Text that only hidden data would contain. */
const TELLTALES = ['Exif', 'ICC_PROFILE', 'http://ns.adobe.com', 'Photoshop', 'GPS'];

/** The type, size and hidden-data findings of one exported image. */
async function inspectImage(page, path, bytes) {
  const type =
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? 'jpg'
      : bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG'
        ? 'png'
        : 'unknown';
  const findings = type === 'png' ? pngFindings(bytes) : jpegFindings(bytes);
  for (const text of TELLTALES)
    if (bytes.includes(Buffer.from(text, 'latin1'))) findings.push(text);
  const size = await decodedSize(page, bytes);
  const placement = FILE_NAME.exec(path)?.[3];
  const expected = placement ? SIZE[placement] : null;
  return {
    path,
    type,
    extensionMatches: path.endsWith(`.${type}`),
    size,
    sizeOk: !!expected && size?.width === expected.width && size?.height === expected.height,
    findings,
  };
}

/** Reads captions.csv: checks the byte order mark, then splits the quoted fields. */
function readCsv(bytes) {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = bytes.subarray(bom ? 3 : 0).toString('utf8');
  const rows = text
    .split('\r\n')
    .filter(Boolean)
    .map((line) =>
      line
        .slice(1, -1)
        .split('","')
        .map((field) => field.replaceAll('""', '"')),
    );
  return { bom, header: rows[0], rows: rows.slice(1) };
}

const HEADER = 'file,platform,placement,caption,hashtags,first_comment,alt_text,result';

// --------------------------------------------------------------------------- the check

async function runExportCheck(browser, name, url) {
  console.log(`\n== Export check: ${name} (${url})`);
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(controlWorkers);
  await context.addInitScript(folderStandIn, OPFS_FOLDER);
  const requests = [];
  const problems = [];
  context.on('request', (request) => requests.push(request.url()));
  context.on('response', (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  context.on('requestfailed', (request) => problems.push(`request failed: ${request.url()}`));
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('dialog', (dialog) => dialog.accept());

  const checks = [];
  const check = (title, ok, detail = '') => {
    checks.push({ title, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${detail ? `: ${detail}` : ''}`);
  };

  const exportRegion = page.getByRole('region', { name: 'Export', exact: true });
  const zipButton = page.getByRole('button', { name: 'Download as .zip' });
  const folderButton = page.getByRole('button', { name: 'Export to session folder' });
  const resultsRegion = page.getByRole('region', { name: 'Export results' });
  const renderProgress = page.getByRole('status', { name: 'Render progress' });
  const waitForRendered = (count) =>
    renderProgress
      .filter({ hasText: new RegExp(`^Rendered ${count} cards?: `) })
      .waitFor({ timeout: 60_000 });
  const waitForResults = () => resultsRegion.waitFor({ timeout: 60_000 });
  const resultsFocused = () =>
    page
      .getByRole('heading', { name: 'Export results' })
      .evaluate((heading) => heading === document.activeElement);

  /** Clicks "Download as .zip" and returns the zip's name and entries. */
  async function downloadZip(tag) {
    const [download] = await Promise.all([page.waitForEvent('download'), zipButton.click()]);
    const path = join(outDir, `${name}-${tag}.zip`);
    await download.saveAs(path);
    await waitForResults();
    const zip = await JSZip.loadAsync(readFileSync(path));
    const files = new Map();
    for (const [entry, file] of Object.entries(zip.files)) {
      if (!file.dir) files.set(entry, Buffer.from(await file.async('uint8array')));
    }
    return { fileName: download.suggestedFilename(), files };
  }

  /** Checks a set of exported files: images valid and clean, captions.csv listing exactly them. */
  async function checkFiles(title, files, expect) {
    const images = [...files.keys()].filter((path) => path !== 'captions.csv').sort();
    const inspected = [];
    for (const path of images) inspected.push(await inspectImage(page, path, files.get(path)));
    const csvBytes = files.get('captions.csv');
    const csv = csvBytes ? readCsv(csvBytes) : null;
    const csvPaths = csv ? csv.rows.map((row) => row[0]).sort() : [];
    const namesOk = images.every((path) => FILE_NAME.test(path));
    const typesOk = inspected.every(
      (file) => file.type === expect.types[file.path.split('/')[0]] && file.extensionMatches,
    );
    const sizesOk = inspected.every((file) => file.sizeOk);
    const clean = inspected.every((file) => file.findings.length === 0);
    check(
      `${title}: ${expect.count} images and captions.csv, named {session}_{platform}_{placement}_{cardId}.{ext}`,
      images.length === expect.count && !!csvBytes && namesOk,
      images.join(', '),
    );
    check(
      `${title}: every image opens at its size from platforms.json, in the expected format`,
      sizesOk && typesOk,
      inspected
        .map((f) => `${f.path.split('/')[0]} ${f.type} ${f.size?.width}x${f.size?.height}`)
        .join('; '),
    );
    check(
      `${title}: no EXIF, GPS, XMP, ICC, comments, text chunks or trailing data`,
      clean,
      inspected
        .map(
          (f) => `${f.path.split('/')[0]}: ${f.findings.length ? f.findings.join(', ') : 'clean'}`,
        )
        .join('; '),
    );
    check(
      `${title}: captions.csv has a byte order mark, the agreed header, and one row per image`,
      !!csv &&
        csv.bom &&
        csv.header.join(',') === HEADER &&
        JSON.stringify(csvPaths) === JSON.stringify(images) &&
        csv.rows.every((row) => expect.results.includes(row[7])),
      csv ? `results: ${csv.rows.map((row) => row[7]).join(', ')}` : 'no captions.csv',
    );
    return { inspected, csv };
  }

  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.getByLabel('Name').fill(SESSION_NAME);
    await page.getByRole('button', { name: 'New session' }).click();
    const photo = await makePhoto(page);
    await page.getByLabel('Photos to import').setInputFiles({
      name: PHOTO,
      mimeType: 'image/jpeg',
      buffer: photo,
    });
    await page.getByRole('status').filter({ hasText: 'Import finished' }).first().waitFor();

    // 0. A control: this file's parser finds the ICC profile the browser puts in a plain canvas
    // JPG (the source photo), so a clean result below means the export really removed it.
    const sourceFindings = jpegFindings(photo);
    check(
      "this check's parser finds the browser's ICC profile (APP2) in the unexported source photo",
      sourceFindings.includes('APP2'),
      sourceFindings.join(', ') || 'nothing found',
    );

    // 1. While the board is making its previews, export waits.
    await page.evaluate(() => {
      window.__hold = 'board';
    });
    await page.getByRole('button', { name: 'Create cards' }).click();
    const form = page.getByRole('form', { name: 'Create cards' });
    for (const placement of ['Feed vertical', 'Image post square']) {
      await form.getByRole('checkbox', { name: new RegExp(`^${placement} \\(`) }).check();
    }
    await form.getByRole('button', { name: 'Create' }).click();
    await page.waitForFunction(() => window.__held.length >= 1);
    const busy = {
      zip: await zipButton.isDisabled(),
      folder: await folderButton.isDisabled(),
      hint: await exportRegion.getByText(BUSY_HINT).isVisible(),
    };
    await page.evaluate(() => window.__release());
    await waitForRendered(2);
    const ready = {
      zip: await zipButton.isEnabled(),
      hint: (await exportRegion.getByText(BUSY_HINT).count()) === 0,
    };
    check(
      'while the board makes its previews, both buttons are disabled with the hint; enabled after',
      busy.zip && busy.folder && busy.hint && ready.zip && ready.hint,
      `busy ${JSON.stringify(busy)}, after ${JSON.stringify(ready)}`,
    );
    const summary = await exportRegion.locator('p').first().innerText();
    check(
      'the summary covers every card in the session',
      summary === 'All 2 cards in this session can be exported.',
      summary,
    );

    // 2. The Phase 1 gate: one photo becomes two valid files, as a zip.
    const first = await downloadZip('first');
    check('the zip is named after the session', first.fileName === ZIP_NAME, first.fileName);
    await checkFiles('zip', first.files, {
      count: 2,
      types: { instagram: 'jpg', linkedin: 'jpg' },
      results: ['Warning'],
    });
    const firstText = await resultsRegion.innerText();
    check(
      'the results say what was downloaded and take keyboard focus',
      firstText.includes(`Downloaded "${ZIP_NAME}" with 2 files and captions.csv.`) &&
        (await resultsFocused()),
      firstText.replace(/\s+/g, ' '),
    );

    // 3. PNG and the override: edit the session file, as the app has no controls for these yet.
    const [bundle] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download .scs' }).click(),
    ]);
    const bundlePath = join(outDir, `${name}-session.scs`);
    await bundle.saveAs(bundlePath);
    const sessionZip = await JSZip.loadAsync(readFileSync(bundlePath));
    const session = JSON.parse(await sessionZip.file('session.json').async('string'));
    const feedCard = session.cards.find((card) => card.placement === 'feed-vertical');
    const squareCard = session.cards.find((card) => card.placement === 'image-square');
    feedCard.edit.format = 'png';
    squareCard.copy.caption = 'x'.repeat(SQUARE.captionCap + 1);
    sessionZip.file('session.json', JSON.stringify(session, null, 2));
    const editedPath = join(outDir, `${name}-session-edited.scs`);
    writeFileSync(editedPath, await sessionZip.generateAsync({ type: 'nodebuffer' }));
    await page.getByRole('button', { name: 'Clear session' }).click();
    await page.getByText('No session is open.').waitFor();
    await page.getByLabel('Session bundle file').setInputFiles(editedPath);
    await page
      .getByRole('status')
      .filter({ hasText: /^Opened / })
      .first()
      .waitFor();
    await waitForRendered(2);
    await zipButton.waitFor();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('button')].find((b) => b.textContent === 'Download as .zip')
          ?.disabled,
    );

    const second = await downloadZip('png-and-fail');
    const leftOut = await resultsRegion.getByRole('list', { name: 'Cards left out' }).innerText();
    check(
      'a card that fails its checks is left out of the zip, with its name and reason',
      second.files.size === 2 &&
        [...second.files.keys()].every((path) => !path.startsWith('linkedin/')) &&
        leftOut.startsWith(`${SQUARE_CARD}: fails its checks.`),
      leftOut,
    );
    await checkFiles('PNG zip', second.files, {
      count: 1,
      types: { instagram: 'png' },
      results: ['Warning'],
    });

    await page.getByRole('button', { name: `Open ${SQUARE_CARD}`, exact: true }).click();
    const overrideBox = page.getByRole('checkbox', { name: OVERRIDE_LABEL });
    const offeredUnticked = (await overrideBox.isVisible()) && !(await overrideBox.isChecked());
    await overrideBox.check();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const third = await downloadZip('override');
    const thirdText = await resultsRegion.innerText();
    const { csv: overrideCsv } = await checkFiles('override zip', third.files, {
      count: 2,
      types: { instagram: 'png', linkedin: 'jpg' },
      results: ['Warning', 'Fail, exported with override'],
    });
    const squareRow = overrideCsv?.rows.find((row) => row[2] === 'image-square');
    check(
      'after ticking the override, the failing card is exported and captions.csv says so',
      offeredUnticked &&
        squareRow?.[7] === 'Fail, exported with override' &&
        thirdText.includes('1 file was exported with an override'),
      `${squareRow?.[0]}: ${squareRow?.[7]}`,
    );

    // 4. The session folder (a browser-private stand-in for a folder on disk).
    const folderDisabledBefore = await folderButton.isDisabled();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page
      .getByRole('status')
      .filter({ hasText: /^Saved to folder/ })
      .first()
      .waitFor();
    await folderButton.click();
    await page.getByRole('heading', { name: 'Export results' }).waitFor();
    await page.waitForFunction(
      () =>
        document.activeElement?.textContent === 'Export results' &&
        !!document.querySelector('[aria-label="Export results"]'),
      undefined,
      { timeout: 60_000 },
    );
    const folderText = await resultsRegion.innerText();
    const folderFiles = await readExportsFolder(page);
    check(
      'without a folder only the zip is offered; once saved, "Export to session folder" works',
      folderDisabledBefore &&
        folderText.includes(`to the exports folder in folder "${OPFS_FOLDER}"`) &&
        folderText.includes('never deleted'),
      folderText.replace(/\s+/g, ' '),
    );
    await checkFiles('folder', folderFiles, {
      count: 2,
      types: { instagram: 'png', linkedin: 'jpg' },
      results: ['Warning', 'Fail, exported with override'],
    });

    // 5. Nothing stale: move the crop while the export's first job is held back.
    const feedPath = [...folderFiles.keys()].find((path) => path.startsWith('instagram/'));
    const squarePath = [...folderFiles.keys()].find((path) => path.startsWith('linkedin/'));
    await page.evaluate(() => {
      window.__hold = 'export';
    });
    await folderButton.click();
    await page.waitForFunction(() => window.__held.length >= 1, undefined, { timeout: 60_000 });
    await page.getByRole('button', { name: `Open ${FEED_CARD}`, exact: true }).click();
    await page.getByRole('application').waitFor({ timeout: 60_000 });
    await page.getByRole('application').focus();
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.__release());
    await page.getByRole('list', { name: 'Cards left out' }).waitFor({ timeout: 60_000 });
    const staleText = await resultsRegion.innerText();
    const afterStale = await readExportsFolder(page);
    const staleCsv = readCsv(afterStale.get('captions.csv'));
    check(
      'a card changed during its export is listed as changed and its file is not written',
      staleText.includes(`${FEED_CARD}: This card changed while its file was being made`) &&
        Buffer.compare(afterStale.get(feedPath), folderFiles.get(feedPath)) === 0 &&
        JSON.stringify(staleCsv.rows.map((row) => row[0])) === JSON.stringify([squarePath]) &&
        (await resultsFocused()),
      `left out: ${staleText.split('Left out of this export:')[1]?.trim().replace(/\s+/g, ' ')}; captions.csv rows: ${staleCsv.rows.map((row) => row[0]).join(', ')}`,
    );

    // 6. The session survives a reload; the exported files are still in the folder.
    await waitForRendered(2);
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('button')].find((b) => b.textContent === 'Save')?.disabled,
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page
      .getByRole('status')
      .filter({ hasText: /^Saved to folder/ })
      .first()
      .waitFor();
    await page.reload({ waitUntil: 'load' });
    await page.getByRole('button', { name: 'Reopen last' }).click();
    await page
      .getByRole('status')
      .filter({ hasText: /^Opened / })
      .first()
      .waitFor();
    await waitForRendered(2);
    const cardsAfterReload = await page
      .getByRole('article')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label')));
    const afterReload = await readExportsFolder(page);
    check(
      'the session survives a reload, and the exported files are still in the folder',
      cardsAfterReload.length === 2 &&
        cardsAfterReload.includes(FEED_CARD) &&
        cardsAfterReload.includes(SQUARE_CARD) &&
        afterReload.has(feedPath) &&
        afterReload.has(squarePath) &&
        (await folderButton.isEnabled()),
      `${cardsAfterReload.join('; ')}; exports: ${[...afterReload.keys()].join(', ')}`,
    );

    // 7. Network and console.
    const outside = requests.filter((r) => !r.startsWith(url) && !/^(blob|data):/.test(r));
    check(
      `every request stays under ${url}`,
      outside.length === 0,
      `${requests.length} requests${outside.length ? `; outside: ${outside.join(', ')}` : ''}`,
    );
    check('no failed requests and no console errors', problems.length === 0, problems.join(' | '));

    writeFileSync(
      join(outDir, `${name}-report.json`),
      JSON.stringify({ checks, requests, problems }, null, 2),
    );
    await exportRegion.screenshot({ path: join(outDir, `${name}-export.png`) });
  } catch (error) {
    check('the check ran to the end', false, String(error).split('\n')[0]);
  } finally {
    await context.close();
  }
  console.log(`  ${checks.filter((c) => c.ok).length} of ${checks.length} checks passed`);
  return checks.every((c) => c.ok);
}

let failed = false;
const browser = await chromium.launch();
try {
  console.log(`Chromium ${browser.version()}; report in ${outDir}`);

  const devUrl = `http://localhost:${PORTS.dev}/`;
  await serve(['--port', String(PORTS.dev), '--strictPort'], {}, devUrl);
  failed = !(await runExportCheck(browser, 'dev', devUrl)) || failed;

  console.log(`\n== Production build with BASE_PATH=${BASE}`);
  execFileSync('npm', ['run', 'build'], {
    cwd: root,
    env: { ...process.env, BASE_PATH: BASE },
    stdio: 'ignore',
  });
  const siteUrl = `http://localhost:${PORTS.site}${BASE}`;
  await serve(
    ['preview', '--port', String(PORTS.site), '--strictPort'],
    { BASE_PATH: BASE },
    siteUrl,
  );
  failed = !(await runExportCheck(browser, 'production', siteUrl)) || failed;
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser.close();
  stopServers();
}
console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: all checks passed');
process.exit(failed ? 1 : 0);
