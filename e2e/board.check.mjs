#!/usr/bin/env node
/**
 * Checks the board in real Chromium, against the dev server and against a production build
 * served under a subpath:
 *
 *   node e2e/board.check.mjs [--out <folder for the report>]
 *
 * It imports a photo made in the browser (no personal images), creates Instagram Feed vertical
 * and LinkedIn Image post square cards, and checks each rendered file's type, size in pixels
 * and size in bytes. It also checks the details dialog, Cancel and Render again, Ctrl-Z, a
 * .scs download and reload, one HEIC render, and that every request stays under the app's own
 * address with no failed requests and no console errors.
 *
 * Like e2e/image-worker.check.mjs, it needs Playwright with Chromium already installed on the
 * machine, and is not part of `npm test` or the deploy workflow. Nothing it produces is written
 * inside the repository except the normal `dist` build.
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
const PORTS = { dev: 5196, site: 5197 };
const outFlag = process.argv.indexOf('--out');
const outDir = resolve(outFlag > -1 ? process.argv[outFlag + 1] : join(tmpdir(), 'board-check'));
mkdirSync(outDir, { recursive: true });

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed on this machine, so the browser check cannot run.');
  process.exit(2);
}
const JSZip = require('jszip');

// Sizes come from the platform data, never from this file.
const platforms = JSON.parse(readFileSync(join(root, 'src/data/platforms.json'), 'utf8'));
const sizeOf = (platform, placement) =>
  platforms.placements.find((p) => p.platform === platform && p.placement === placement).sizes[0];
const FEED = sizeOf('instagram', 'feed-vertical');
const SQUARE = sizeOf('linkedin', 'image-square');

const PHOTO = 'board-check.jpg';
const label = (name, version = 'v1', file = PHOTO) => `${name} for ${file}, ${version}`;
const FEED_CARD = label('Instagram Feed vertical');
const SQUARE_CARD = label('LinkedIn Image post square');

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

// --------------------------------------------------------------------------- helpers

/** The same wording as the board's file-size label (src/lib/board/view.ts). */
function fileSizeLabel(bytes) {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Records every message the page sends to a worker, so jobs and cancels can be counted. */
function recordWorkerMessages() {
  window.__toWorker = [];
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function postMessage(message, ...rest) {
    if (message && typeof message === 'object') {
      window.__toWorker.push({ type: message.type, id: message.id ?? message.job?.id });
    }
    return post.call(this, message, ...rest);
  };
}

/** A landscape test photo drawn in the browser: a gradient and two shapes. */
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

/** Reads a card's preview file in the page: its type from its bytes, its pixels, its size. */
async function inspectPreview(page, cardLabel) {
  const card = page.getByRole('article', { name: cardLabel, exact: true });
  const src = await card.getByRole('img').getAttribute('src');
  const file = await page.evaluate(async (url) => {
    const blob = await (await fetch(url)).blob();
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const type =
      head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
        ? 'jpeg'
        : head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
          ? 'png'
          : 'unknown';
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return { type, bytes: blob.size, ...size };
  }, src);
  const text = await card.innerText();
  return { ...file, text };
}

const renderProgress = (page) => page.getByRole('status', { name: 'Render progress' });
/** Waits until the board says `count` files are finished (and, optionally, `cancelled`). */
async function waitForRendered(page, count, cancelled = 0) {
  const tail =
    cancelled > 0
      ? `.*, ${cancelled} cancelled\\.$`
      : '[^,]*(, [0-9]+ with warnings)?(, [0-9]+ fail)?\\.$';
  await renderProgress(page)
    .filter({ hasText: new RegExp(`^Rendered ${count} cards?: ${tail}`) })
    .waitFor({ timeout: 60_000 });
}

async function createCards(page, ...placements) {
  await page.getByRole('button', { name: 'Create cards' }).click();
  const form = page.getByRole('form', { name: 'Create cards' });
  for (const name of placements) {
    await form.getByRole('checkbox', { name: new RegExp(`^${name} \\(`) }).check();
  }
  await form.getByRole('button', { name: 'Create' }).click();
}

// --------------------------------------------------------------------------- the check

async function runBoard(browser, name, url) {
  console.log(`\n== Board check: ${name} (${url})`);
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(recordWorkerMessages);
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
  const toWorker = () => page.evaluate(() => window.__toWorker);

  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'New session' }).click();
    await page.getByLabel('Photos to import').setInputFiles({
      name: PHOTO,
      mimeType: 'image/jpeg',
      buffer: await makePhoto(page),
    });
    await page.getByRole('status').filter({ hasText: 'Import finished' }).first().waitFor();

    // 1. Two cards, rendered to the right files.
    await createCards(page, 'Feed vertical', 'Image post square');
    await waitForRendered(page, 2);
    for (const [cardLabel, size] of [
      [FEED_CARD, FEED],
      [SQUARE_CARD, SQUARE],
    ]) {
      const file = await inspectPreview(page, cardLabel);
      const expected = `${size.width} × ${size.height} JPG · ${fileSizeLabel(file.bytes)}`;
      check(
        `${cardLabel}: JPEG file, ${size.width} × ${size.height}, size matches the card`,
        file.type === 'jpeg' &&
          file.width === size.width &&
          file.height === size.height &&
          file.text.includes(expected),
        `${file.type}, ${file.width} × ${file.height}, ${file.bytes} bytes, card shows "${expected}"`,
      );
    }

    // 2. The details dialog: a real modal, Esc closes it, focus goes back to its Open button.
    const opener = page.getByRole('button', { name: `Open ${SQUARE_CARD}`, exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'LinkedIn Image post square' });
    await dialog.waitFor();
    const modal = await dialog.evaluate((element) => element.open && element.matches(':modal'));
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    check(
      'details dialog opens as a modal, Esc closes it, focus returns to its Open button',
      modal && focused === `Open ${SQUARE_CARD}`,
      `modal: ${modal}, focus on "${focused}"`,
    );

    // 3. Cancel a waiting render, then Render again. Create and Cancel run in one browser task,
    //    so the last card's job is certainly still waiting when it is cancelled.
    await page.getByRole('button', { name: 'Create cards' }).click();
    const form = page.getByRole('form', { name: 'Create cards' });
    for (const placement of ['Feed square', 'Image post vertical', 'Link preview']) {
      await form.getByRole('checkbox', { name: new RegExp(`^${placement} \\(`) }).check();
    }
    const cancelled = label('LinkedIn Link preview');
    const cancelledEarly = await page.evaluate(async (cardLabel) => {
      const form = document.querySelector('form[aria-label="Create cards"]');
      [...form.querySelectorAll('button')].find((b) => b.textContent === 'Create').click();
      // React applies the click in a microtask. Waiting only on microtasks keeps this in the
      // same browser task, before any file can be read or any job sent to the worker.
      let cancel = null;
      for (let i = 0; i < 1000 && !cancel; i++) {
        await Promise.resolve();
        cancel = document.querySelector(`button[aria-label="Cancel ${cardLabel}"]`);
      }
      if (!cancel) return false;
      cancel.click();
      return true;
    }, cancelled);
    await waitForRendered(page, 4, 1);
    const cancelledCard = page.getByRole('article', { name: cancelled, exact: true });
    const cancelledText = await cancelledCard.innerText();
    const sentBeforeAgain = (await toWorker()).filter((m) => m.type === 'render').length;
    await page.getByRole('button', { name: `Render again ${cancelled}`, exact: true }).click();
    await cancelledCard.getByRole('img').waitFor({ timeout: 60_000 });
    const linkPreview = sizeOf('linkedin', 'link-preview');
    const again = await inspectPreview(page, cancelled);
    check(
      'Cancel stops a waiting render, and Render again completes it',
      cancelledText.includes('Cancelled before the file was made.') &&
        cancelledEarly &&
        sentBeforeAgain === 4 &&
        again.width === linkPreview.width &&
        again.height === linkPreview.height,
      `jobs sent before Render again: ${sentBeforeAgain} of 5 cards; then ${again.width} × ${again.height}`,
    );

    // 4. Ctrl-Z removes the duplicate just made, and its job (queued in the worker behind two
    //    others) is cancelled there.
    const before = await page.getByRole('article').count();
    const undone = await page.evaluate(
      async (labels) => {
        const click = (text) => document.querySelector(`button[aria-label="${text}"]`).click();
        const renders = () => window.__toWorker.filter((m) => m.type === 'render');
        const start = renders().length;
        click(`Render again ${labels.feed}`);
        click(`Render again ${labels.square}`);
        click(`Duplicate ${labels.feed}`);
        // Wait until the duplicate's job has been sent to the worker.
        while (renders().length < start + 3) await new Promise((r) => requestAnimationFrame(r));
        const jobId = renders().at(-1).id;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
        return { jobId };
      },
      { feed: FEED_CARD, square: SQUARE_CARD },
    );
    await waitForRendered(page, before);
    const after = await page.getByRole('article').count();
    const duplicateGone = (await page.getByRole('article', { name: /v2/ }).count()) === 0;
    const cancelSent = (await toWorker()).some((m) => m.type === 'cancel' && m.id === undone.jobId);
    check(
      'Ctrl-Z removes the duplicate just made and cancels its job in the worker',
      after === before && duplicateGone && cancelSent,
      `cards ${before} -> ${after}; cancel sent for ${undone.jobId}: ${cancelSent}`,
    );

    // 5. Session round trip: Download .scs, Clear, Load .scs.
    const changes = page.locator('dt:text-is("Changes") + dd');
    const results = async () =>
      page.$$eval('article', (cards) =>
        cards.map((card) => [
          card.getAttribute('aria-label'),
          card.querySelector('span')?.textContent,
        ]),
      );
    const resultsBefore = await results();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download .scs' }).click(),
    ]);
    const bundlePath = join(outDir, `${name}-session.scs`);
    await download.saveAs(bundlePath);
    const zip = await JSZip.loadAsync(readFileSync(bundlePath));
    const saved = JSON.parse(await zip.file('session.json').async('string'));
    const savedResults = saved.cards.map((card) => [card.placement, card.validation]);
    const storedOk =
      saved.cards.length === 5 &&
      saved.cards.every(
        (card) =>
          card.validation.level === 'warn' && card.validation.issues.some((i) => i.rule === 8),
      );
    await page.getByRole('button', { name: 'Clear session' }).click();
    await page.getByText('No session is open.').waitFor();
    await page.getByLabel('Session bundle file').setInputFiles(bundlePath);
    await page
      .getByRole('status')
      .filter({ hasText: /^Opened / })
      .first()
      .waitFor();
    const changesOnLoad = await changes.innerText();
    await waitForRendered(page, 5);
    const resultsAfter = await results();
    const changesAfterRender = await changes.innerText();
    const reloadedFeed = await inspectPreview(page, FEED_CARD);
    check(
      'Download .scs, Clear, Load .scs: cards, stored results and previews come back unchanged',
      storedOk &&
        JSON.stringify(resultsAfter) === JSON.stringify(resultsBefore) &&
        reloadedFeed.width === FEED.width &&
        reloadedFeed.height === FEED.height &&
        changesOnLoad === 'All changes saved' &&
        changesAfterRender === 'All changes saved',
      `${saved.cards.length} cards saved with results ${JSON.stringify([
        ...new Set(savedResults.map(([, v]) => `${v.level}/rules ${v.issues.map((i) => i.rule)}`)),
      ])}; after reload: "${changesOnLoad}", after previews: "${changesAfterRender}"`,
    );

    // 6. HEIC: import the fixture and render one card from it.
    const heicBefore = requests.filter((r) => /heic-to/.test(r)).length;
    await page
      .getByLabel('Photos to import')
      .setInputFiles(join(root, 'e2e/fixtures/gradient.heic'));
    await page.getByRole('status').filter({ hasText: 'Import finished' }).first().waitFor();
    await page.getByRole('button', { name: 'Create cards' }).click();
    const heicForm = page.getByRole('form', { name: 'Create cards' });
    await heicForm.getByRole('checkbox', { name: PHOTO }).uncheck();
    await heicForm.getByRole('checkbox', { name: /^Feed vertical \(/ }).check();
    await heicForm.getByRole('button', { name: 'Create' }).click();
    const heicCard = label('Instagram Feed vertical', 'v1', 'gradient.heic');
    await page
      .getByRole('article', { name: heicCard, exact: true })
      .getByRole('img')
      .waitFor({ timeout: 60_000 });
    const heicFile = await inspectPreview(page, heicCard);
    const heicRequests = requests.filter((r) => /heic-to/.test(r));
    check(
      `HEIC photo renders to ${FEED.width} × ${FEED.height}`,
      heicFile.width === FEED.width && heicFile.height === FEED.height && heicBefore === 0,
      `${heicFile.type}, ${heicFile.width} × ${heicFile.height}`,
    );
    console.log(`  heic-to files fetched for one HEIC import and render: ${heicRequests.length}`);
    for (const request of heicRequests) console.log(`          ${request}`);

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
      JSON.stringify({ checks, heicRequests, requests, problems }, null, 2),
    );
    await page
      .getByRole('region', { name: 'Board', exact: true })
      .screenshot({ path: join(outDir, `${name}-board.png`) });
  } catch (error) {
    check('the check ran to the end', false, String(error).split('\n')[0]);
  } finally {
    await context.close();
  }
  return checks.every((c) => c.ok);
}

let failed = false;
const browser = await chromium.launch();
try {
  console.log(`Chromium ${browser.version()}; report in ${outDir}`);

  const devUrl = `http://localhost:${PORTS.dev}/`;
  await serve(['--port', String(PORTS.dev), '--strictPort'], {}, devUrl);
  failed = !(await runBoard(browser, 'dev', devUrl)) || failed;

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
  failed = !(await runBoard(browser, 'production', siteUrl)) || failed;
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser.close();
  stopServers();
}
console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: all checks passed');
process.exit(failed ? 1 : 0);
