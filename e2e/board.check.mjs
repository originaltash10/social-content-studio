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
 * .scs download and reload, one HEIC render, that a tile keeps its height on every animation
 * frame while its card renders again, and that every request stays under the app's own address
 * with no failed requests and no console errors.
 *
 * Section 8 checks the caption, hashtags and first comment boxes in the card dialog: each is
 * reached by Tab from the dialog heading and typed into with the keyboard; the live counts; the
 * "…more" cut-off warning and the caption cap; Ctrl/Cmd-Z inside a box (the browser's typing
 * undo) and outside it (one undo step per visit); Esc keeping the text; the Story note on the
 * Reel / Story card only; and the boxes reached inside the dialog in a short window. 8i–8q
 * check the alt text box and the Copy buttons: the dialog's whole Tab order; alt text clearing
 * the rule 8 warning in the dialog and on the tile, and one Ctrl-Z taking it back; each Copy
 * button's clipboard text (read back through the clipboard, with a sentinel put there first),
 * pressed with Enter, Space or a mouse click; "Nothing to copy yet."; the alt text kept through a
 * page reload and .scs load; and the exported captions.csv alt_text and hashtags.
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

import { describeSampling, startSampling, steady, stopSampling } from './layoutSampler.mjs';
import { controlWorkers, holdRenders, releaseRenders, waitForHeld } from './workerHold.mjs';

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
const placementOf = (platform, placement) =>
  platforms.placements.find((p) => p.platform === platform && p.placement === placement);
/** Numbers written as the boxes write them (src/board/copyText.ts). */
const en = (n) => n.toLocaleString('en-US');
/** The note under the boxes on a placement that can be a Story (SPEC.md, "Caption boxes"). */
const STORY_NOTE =
  "Reels show this caption. Stories don't show captions, hashtags or a first comment.";
/** The export override's label (src/board/CardDetails.tsx). */
const OVERRIDE_LABEL = 'Export this card even though it fails its checks';
/** Put on the clipboard before each Copy press; a Copy that writes nothing leaves it there. */
const CLIPBOARD_SENTINEL = 'sentinel: not written by the app';

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

/**
 * Splits CSV text (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes) into rows
 * of fields. A leading byte order mark is dropped.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const body = text.startsWith('\u{FEFF}') ? text.slice(1) : text;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' && body[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += char;
  }
  if (field !== '' || row.length > 0) rows.push([...row, field]);
  return rows;
}

/** The text of everything a control's aria-describedby points at, in order. */
const describedText = (locator) =>
  locator.evaluate((element) =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? `(missing ${id})`),
  );

/** Presses `key` until `target` has focus; returns how many presses it took. */
async function pressUntilFocused(page, target, key = 'Tab', most = 40) {
  for (let presses = 0; presses <= most; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) return presses;
    await page.keyboard.press(key);
  }
  throw new Error(`${key} did not reach the control within ${most} presses`);
}

/**
 * Presses Tab until focus is on a control that holds no text, so Ctrl/Cmd-Z there is the app's
 * undo and not the browser's typing undo (the same test as src/app/keys.ts).
 */
async function tabOutOfText(page, most = 20) {
  for (let presses = 1; presses <= most; presses++) {
    await page.keyboard.press('Tab');
    const typing = await page.evaluate(() => {
      const element = document.activeElement;
      const notText = ['checkbox', 'radio', 'range', 'color', 'button', 'submit'];
      return (
        element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLInputElement && !notText.includes(element.type)) ||
        element?.isContentEditable === true
      );
    });
    if (!typing) return;
  }
  throw new Error(`Tab did not leave the text boxes within ${most} presses`);
}

// --------------------------------------------------------------------------- the check

async function runBoard(browser, name, url) {
  console.log(`\n== Board check: ${name} (${url})`);
  const context = await browser.newContext({ acceptDownloads: true });
  // Section 8 reads what the Copy buttons put on the clipboard, and puts a sentinel there.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(url).origin,
  });
  await context.addInitScript(recordWorkerMessages);
  // Lets section 7 hold a render back (see e2e/workerHold.mjs); nothing is held otherwise.
  await context.addInitScript(controlWorkers);
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
  /** Runs one step. If it cannot be carried out, that is its failure, and the next step runs. */
  const step = async (title, run) => {
    try {
      await run(title);
    } catch (error) {
      const lines = String(error).split('\n');
      const call = lines.find((line) => line.includes('- waiting for '));
      const waiting = call?.slice(call.indexOf('waiting for ')).split(String.fromCharCode(27))[0];
      check(title, false, waiting ? `${lines[0]} It was ${waiting.trim()}.` : (lines[0] ?? ''));
    }
  };

  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'New session' }).click();
    // The system's file picker cannot be driven, so files are given to the inputs directly
    // (here and wherever setInputFiles is used below).
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
    //    This one step is done inside the page, with element.click() and a key event sent to
    //    the window, and not with real clicks and page.keyboard. The reason: the undo has to
    //    arrive while the duplicate's job is still waiting in the worker, and real input takes
    //    long enough for the job to start first. The same undo from a real click and the real
    //    keyboard is checked in 4a.
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

    // 4a. The same with real input: a mouse click on Duplicate, then Ctrl-Z from the keyboard,
    //     which goes to whatever has focus (the Duplicate button).
    const duplicateButton = page.getByRole('button', {
      name: `Duplicate ${FEED_CARD}`,
      exact: true,
    });
    await duplicateButton.click();
    await page.getByRole('article', { name: /v2/ }).waitFor();
    const withCopy = await page.getByRole('article').count();
    const focusOnDuplicate = await duplicateButton.evaluate(
      (element) => element === document.activeElement,
    );
    await page.keyboard.press('Control+z');
    await page.getByRole('article', { name: /v2/ }).waitFor({ state: 'detached' });
    await waitForRendered(page, before);
    const withoutCopy = await page.getByRole('article').count();
    check(
      'Ctrl-Z from the keyboard, after a real click on Duplicate, removes the duplicate',
      withCopy === before + 1 && focusOnDuplicate && withoutCopy === before,
      `cards ${before} -> ${withCopy} -> ${withoutCopy}; focus was on the Duplicate button: ${focusOnDuplicate}`,
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

    // 7. A tile keeps its height while its card is rendered again: measured on every animation
    //    frame, from before Render again is clicked until the new file is shown, and each
    //    measurement must be within 1 px of the first. The render is held back with the
    //    worker-message hold (e2e/workerHold.mjs), because a render can finish within a frame
    //    or two and the tile would then never be measured while its file is being made.
    //    The window is made narrow enough for one tile per row first: in a wider grid each
    //    tile is stretched to the tallest in its row, which can hide a change in its own height.
    await page.setViewportSize({ width: 400, height: 900 });
    const feedTile = `article[aria-label="${FEED_CARD}"]`;
    await page.locator(feedTile).getByRole('img').waitFor({ timeout: 60_000 });
    await renderProgress(page)
      .filter({ hasText: /^Rendered \d+ cards?: / })
      .waitFor({ timeout: 60_000 });
    const againButton = page.getByRole('button', {
      name: `Render again ${FEED_CARD}`,
      exact: true,
    });
    // Scrolled to before sampling starts, so the click below does not move the page.
    await againButton.scrollIntoViewIfNeeded();
    await startSampling(
      page,
      { 'tile height': { selector: feedTile, edge: 'height' } },
      { 'a file being made': `${feedTile} [role=progressbar]` },
    );
    await holdRenders(page);
    await againButton.click();
    await waitForHeld(page);
    await page.waitForTimeout(400);
    await releaseRenders(page);
    await renderProgress(page)
      .filter({ hasText: /^Rendered \d+ cards?: / })
      .waitFor({ timeout: 60_000 });
    await page.waitForTimeout(300);
    const tileSampling = await stopSampling(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    check(
      'a tile keeps its height while its card is rendered again, with the render held and let through (one tile per row)',
      steady(tileSampling) && tileSampling.seen['a file being made'],
      describeSampling(tileSampling),
    );

    // 8. The caption, hashtags and first comment boxes (SPEC.md, "Caption boxes" and "Undo").
    //    Every box is reached with Tab or Shift+Tab and typed into with page.keyboard; Ctrl-Z is
    //    pressed with page.keyboard, inside a box or on the first control after the boxes that
    //    holds no text.
    const LINKEDIN = placementOf('linkedin', 'image-square');
    const squareOpener = page.getByRole('button', { name: `Open ${SQUARE_CARD}`, exact: true });
    const squareDialog = page.getByRole('dialog', { name: 'LinkedIn Image post square' });
    const box = (name) => squareDialog.getByLabel(name, { exact: true });
    const caption = box('Caption');
    const hashtags = box('Hashtags');
    const firstComment = box('First comment');
    /** "N of 3,000 characters, including hashtags", with the cap from platforms.json. */
    const linkedinCount = (n) =>
      `${en(n)} of ${en(LINKEDIN.captionCap)} characters, including hashtags`;
    const closeSquare = async () => {
      if (await squareDialog.isVisible()) {
        await page.keyboard.press('Escape');
        await squareDialog.waitFor({ state: 'hidden' });
      }
    };

    await step(
      '8a. each box is reached by Tab from the dialog heading, and its live count follows typing',
      async (title) => {
        await squareOpener.click();
        await squareDialog.waitFor();
        const headingFocused = await squareDialog
          .getByRole('heading', { level: 2 })
          .evaluate((element) => element === document.activeElement);
        const tabs = {};
        tabs.caption = await pressUntilFocused(page, caption);
        const empty = (await describedText(caption))[0];
        await page.keyboard.type('Topping out');
        const typed = (await describedText(caption))[0];
        tabs.hashtags = await pressUntilFocused(page, hashtags);
        await page.keyboard.type('#build');
        const tagCount = (await describedText(hashtags))[0];
        // LinkedIn posts the hashtags in the caption: "Topping out #build".
        const withTags = (await describedText(caption))[0];
        tabs.firstComment = await pressUntilFocused(page, firstComment);
        await page.keyboard.type('More soon');
        const commentCount = (await describedText(firstComment))[0];
        await tabOutOfText(page);
        // Two presses from one box to the next: each box's Copy button comes between them.
        check(
          title,
          headingFocused &&
            tabs.caption > 0 &&
            tabs.hashtags === 2 &&
            tabs.firstComment === 2 &&
            empty === linkedinCount(0) &&
            typed === linkedinCount(11) &&
            tagCount === '1 hashtag' &&
            withTags === linkedinCount(18) &&
            commentCount === '9 characters',
          `Tab presses ${JSON.stringify(tabs)}; counts "${empty}", "${typed}", "${tagCount}", "${withTags}", "${commentCount}"`,
        );
      },
    );

    await step(
      '8b. Ctrl-Z inside the caption box undoes only typing; the card and the other boxes keep their text',
      async (title) => {
        await pressUntilFocused(page, caption, 'Shift+Tab');
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' today');
        const typed = await caption.inputValue();
        await page.keyboard.press('Control+z');
        const afterUndo = await caption.inputValue();
        const tags = await hashtags.inputValue();
        const comment = await firstComment.inputValue();
        // Put the text back the way a person would, and leave the box.
        await page.keyboard.press('Control+a');
        await page.keyboard.type('Topping out today');
        await tabOutOfText(page);
        check(
          title,
          typed === 'Topping out today' &&
            afterUndo !== typed &&
            typed.startsWith(afterUndo) &&
            afterUndo.startsWith('Topping out') &&
            tags === '#build' &&
            comment === 'More soon',
          `typed "${typed}", after Ctrl-Z in the box "${afterUndo}"; hashtags "${tags}", first comment "${comment}"`,
        );
      },
    );

    await step(
      '8c. Ctrl-Z after Tab leaves the box restores the whole previous text in one step',
      async (title) => {
        // The visit in 8b changed "Topping out" to "Topping out today".
        await page.keyboard.press('Control+z');
        const restored = await caption.inputValue();
        const tags = await hashtags.inputValue();
        const comment = await firstComment.inputValue();
        check(
          title,
          restored === 'Topping out' && tags === '#build' && comment === 'More soon',
          `caption "${restored}", hashtags "${tags}", first comment "${comment}"`,
        );
      },
    );

    await step(
      '8d. two visits to the caption in one opening need two Ctrl-Z presses, one each',
      async (title) => {
        for (const added of [' (one)', ' (two)']) {
          await pressUntilFocused(page, caption, 'Shift+Tab');
          await page.keyboard.press('Control+End');
          await page.keyboard.type(added);
          await tabOutOfText(page);
        }
        const both = await caption.inputValue();
        await page.keyboard.press('Control+z');
        const first = await caption.inputValue();
        await page.keyboard.press('Control+z');
        const second = await caption.inputValue();
        const tags = await hashtags.inputValue();
        check(
          title,
          both === 'Topping out (one) (two)' &&
            first === 'Topping out (one)' &&
            second === 'Topping out' &&
            tags === '#build',
          `"${both}" -> "${first}" -> "${second}"; hashtags still "${tags}"`,
        );
      },
    );

    await step(
      '8e. the caption warns past the "…more" cut-off and fails past the cap, in words',
      async (title) => {
        const cutOff = Math.min(...LINKEDIN.truncation.map((t) => t.chars));
        const posted = (text) => [...`${text} #build`].length;
        await pressUntilFocused(page, caption, 'Shift+Tab');
        await page.keyboard.press('Control+a');
        await page.keyboard.type('Cut-off check ');
        // insertText stands in for a paste: it puts the long run of characters in as one
        // input, as pasting does. Typing hundreds of keys one by one would only slow the check.
        const pastCutOff = 'x'.repeat(cutOff + 1 - posted('Cut-off check '));
        await page.keyboard.insertText(pastCutOff);
        const atWarning = await describedText(caption);
        const pastCap = 'y'.repeat(LINKEDIN.captionCap + 1 - posted(`Cut-off check ${pastCutOff}`));
        await page.keyboard.insertText(pastCap);
        const atFail = await describedText(caption);
        const invalid = await caption.getAttribute('aria-invalid');
        // Back to a short caption, so the card does not fail for the rest of the check.
        await page.keyboard.press('Control+a');
        await page.keyboard.type('Topping out');
        const cleared = await describedText(caption);
        await tabOutOfText(page);
        const warningOk =
          atWarning[0] === linkedinCount(cutOff + 1) &&
          atWarning.length === 2 &&
          atWarning[1].startsWith(`Warning: Caption with hashtags is ${cutOff + 1} characters;`) &&
          atWarning[1].includes(`cuts it off after ${cutOff}:`) &&
          atWarning[1].endsWith('…more');
        const failOk =
          atFail[0] === linkedinCount(LINKEDIN.captionCap + 1) &&
          atFail[1].startsWith(
            `Fail: Caption with hashtags is ${LINKEDIN.captionCap + 1} characters;`,
          ) &&
          invalid === 'true';
        check(
          title,
          warningOk && failOk && cleared.length === 1,
          `at ${cutOff + 1}: ${JSON.stringify(atWarning)}; at ${LINKEDIN.captionCap + 1}: "${atFail[0]}", "${atFail[1]?.slice(0, 70)}…", aria-invalid ${invalid}`,
        );
      },
    );

    await step(
      '8f. Esc while typing in a box closes the dialog and keeps the text',
      async (title) => {
        await pressUntilFocused(page, firstComment, 'Shift+Tab');
        await page.keyboard.press('Control+a');
        await page.keyboard.type('See you on site');
        await page.keyboard.press('Escape');
        await squareDialog.waitFor({ state: 'hidden' });
        // Where focus went, and whether the dialog is really closed, for the report.
        const after = await page.evaluate(() => {
          const element = document.activeElement;
          const dialogs = [...document.querySelectorAll('dialog')];
          return {
            focus: `${element?.tagName} "${element?.getAttribute('aria-label') ?? element?.textContent?.slice(0, 30)}"`,
            open: dialogs.some((d) => d.open),
            // The card's details are drawn inside the dialog only while the board has a card open.
            cardStillOpen: dialogs.some((d) => d.querySelector('h2') !== null),
          };
        });
        // The board clears its open card when the dialog's close event arrives, which Chrome
        // fires a moment after the dialog is hidden. A key pressed inside that moment can run
        // first, and no person is that quick, so the check waits for the board to finish closing
        // (the card's details gone from the dialog) before it presses Enter.
        await page.waitForFunction(() =>
          [...document.querySelectorAll('dialog')].every((d) => d.querySelector('h2') === null),
        );
        const backOnOpener = await squareOpener.evaluate(
          (element) => element === document.activeElement,
        );
        // Focus is back on the Open button, so Enter opens the dialog again. If it is not, the
        // step has failed already; the dialog is opened with a click only to report the text.
        if (backOnOpener) await page.keyboard.press('Enter');
        else await squareOpener.click();
        const reopened = await squareDialog
          .waitFor({ timeout: 5_000 })
          .then(() => true)
          .catch(() => false);
        if (!reopened) {
          check(
            title,
            false,
            `the dialog did not open again; after Esc: ${JSON.stringify(after)}, back on Open: ${backOnOpener}`,
          );
          return;
        }
        const kept = await firstComment.inputValue();
        await closeSquare();
        check(
          title,
          backOnOpener && !after.open && kept === 'See you on site',
          `after Esc: ${JSON.stringify(after)}, back on Open: ${backOnOpener}; first comment after reopening "${kept}"`,
        );
      },
    );

    await step('8g. the Story note is on the Reel / Story card only', async (title) => {
      await closeSquare();
      await page.getByRole('button', { name: 'Create cards' }).click();
      const storyForm = page.getByRole('form', { name: 'Create cards' });
      await storyForm.getByRole('checkbox', { name: 'gradient.heic' }).uncheck();
      await storyForm.getByRole('checkbox', { name: /^Reel \/ Story \(/ }).check();
      await storyForm.getByRole('button', { name: 'Create' }).click();
      const storyCard = label('Instagram Reel / Story');
      await page
        .getByRole('article', { name: storyCard, exact: true })
        .getByRole('img')
        .waitFor({ timeout: 60_000 });
      const notes = {};
      for (const [cardLabel, dialogName] of [
        [storyCard, 'Instagram Reel / Story'],
        [FEED_CARD, 'Instagram Feed vertical'],
        [SQUARE_CARD, 'LinkedIn Image post square'],
      ]) {
        await page.getByRole('button', { name: `Open ${cardLabel}`, exact: true }).click();
        const open = page.getByRole('dialog', { name: dialogName });
        await open.getByLabel('First comment', { exact: true }).waitFor();
        notes[dialogName] = await open.getByText(STORY_NOTE, { exact: true }).count();
        await page.keyboard.press('Escape');
        await open.waitFor({ state: 'hidden' });
      }
      check(
        title,
        notes['Instagram Reel / Story'] === 1 &&
          notes['Instagram Feed vertical'] === 0 &&
          notes['LinkedIn Image post square'] === 0,
        JSON.stringify(notes),
      );
    });

    await step(
      '8h. in a short window, Tab reaches each box inside the dialog, and the dialog scrolls to show it whole; the page does not scroll',
      async (title) => {
        await page.setViewportSize({ width: 1280, height: 360 });
        const feedOpener = page.getByRole('button', { name: `Open ${FEED_CARD}`, exact: true });
        await feedOpener.scrollIntoViewIfNeeded();
        const pageScroll = await page.evaluate(() => window.scrollY);
        await feedOpener.click();
        const feedDialog = page.getByRole('dialog', { name: 'Instagram Feed vertical' });
        await feedDialog.waitFor();
        /** Where a box is in the dialog's visible area: its first line, and the whole box. */
        const placeOf = (target) =>
          target.evaluate((element) => {
            const dialogBox = element.closest('dialog');
            const rect = element.getBoundingClientRect();
            const area = dialogBox.getBoundingClientRect();
            const line = parseFloat(getComputedStyle(element).lineHeight) || 24;
            const top = Math.max(area.top, 0);
            const bottom = Math.min(area.bottom, window.innerHeight);
            return {
              firstLine: rect.top >= top && rect.top + line <= bottom,
              whole: rect.top >= top && rect.bottom <= bottom,
              focused: element === document.activeElement,
              dialogScroll: dialogBox.scrollTop,
              dialogScrolls: dialogBox.scrollHeight > dialogBox.clientHeight,
            };
          });
        const box = await feedDialog.boundingBox();
        const seen = [];
        for (const name of ['Caption', 'Hashtags', 'First comment']) {
          const target = feedDialog.getByLabel(name, { exact: true });
          await pressUntilFocused(page, target);
          const onFocus = await placeOf(target);
          // Chrome scrolls a focused text box only far enough to show where the typing goes. The
          // rest is brought into view the way a person would: the mouse wheel over the dialog.
          let now = onFocus;
          for (let turns = 0; turns < 20 && !now.whole; turns++) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, 60);
            await page.waitForTimeout(50);
            now = await placeOf(target);
          }
          seen.push({ name, onFocus, after: now });
        }
        const pageScrollAfter = await page.evaluate(() => window.scrollY);
        await page.keyboard.press('Escape');
        await feedDialog.waitFor({ state: 'hidden' });
        await page.setViewportSize({ width: 1280, height: 720 });
        check(
          title,
          seen.every(
            (s) =>
              s.onFocus.firstLine &&
              s.onFocus.focused &&
              s.after.whole &&
              s.after.focused &&
              s.after.dialogScrolls,
          ) &&
            seen.some((s) => s.onFocus.dialogScroll > 0) &&
            pageScrollAfter === pageScroll,
          `${seen
            .map(
              (s) =>
                `${s.name}: first line shown on Tab ${s.onFocus.firstLine}, whole after scrolling the dialog ${s.after.whole} (dialog scrolled ${s.onFocus.dialogScroll} -> ${s.after.dialogScroll} px)`,
            )
            .join('; ')}; page scroll ${pageScroll} -> ${pageScrollAfter}`,
        );
      },
    );

    // 8i–8p. The alt text box and the Copy buttons (SPEC.md, "Caption boxes" and "Copy
    //    buttons"). Every control is reached with Tab or Shift+Tab, or once with a real mouse
    //    click, and typed into with page.keyboard. Before each Copy press a sentinel string is put
    //    on the clipboard, so a Copy that writes nothing cannot pass by finding older text there.
    const feedOpener = page.getByRole('button', { name: `Open ${FEED_CARD}`, exact: true });
    const feedDialog = page.getByRole('dialog', { name: 'Instagram Feed vertical' });
    const feedBox = (name) => feedDialog.getByLabel(name, { exact: true });
    const feedArticle = page.getByRole('article', { name: FEED_CARD, exact: true });
    const copyButton = (name) => feedDialog.getByRole('button', { name, exact: true });
    /** The status message beside a Copy button. */
    const copyStatus = (name) => copyButton(name).locator('xpath=..').getByRole('status');
    const putSentinel = () =>
      page.evaluate((text) => navigator.clipboard.writeText(text), CLIPBOARD_SENTINEL);
    const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());
    /**
     * The status right after a press. "Copied." appears when the browser's clipboard write
     * resolves, which is a promise and not part of the key press, so this waits for that one
     * message to appear (at most 1.5 s, inside its 2 s), and never for the 2 s timer.
     */
    const copiedStatus = async (name) => {
      await copyStatus(name)
        .filter({ hasText: /^Copied\.$/ })
        .waitFor({ timeout: 1_500 })
        .catch(() => undefined);
      return copyStatus(name).innerText();
    };
    /**
     * What the tile shows: its result badge (its first span, a symbol then the word, e.g.
     * "✓Pass"), reduced to the word, and whether rule 8's reason is on it.
     */
    const tileState = async () => ({
      result: (
        await feedArticle.evaluate((card) => card.querySelector('span')?.textContent ?? '')
      ).replace(/^[^A-Za-z]+/, ''),
      altMissing: (await feedArticle.innerText()).includes('Alt text is missing'),
    });
    /** Opens the Feed vertical card's dialog with a click on its Open button, if not open. */
    const openFeed = async () => {
      if (!(await feedDialog.isVisible())) {
        await closeSquare();
        await feedOpener.click();
        await feedDialog.waitFor();
      }
    };
    const ALT = 'A crane lifts the final beam at the caf\u{E9} \u{1F3D7}\u{FE0F}';
    const CAPTION = 'Caf\u{E9} opening day \u{1F477}\nTopping out today';
    const TAGS_TYPED = 'build caf\u{E9}';
    const TAGS_COPIED = '#build #caf\u{E9}';
    const COMMENT = 'More soon \u{1F44B} at the caf\u{E9}';
    let copiedHashtags = null;

    await step(
      '8i. the card dialog Tab order is the one in SPEC.md, with the alt text box and the four Copy buttons',
      async (title) => {
        await closeSquare();
        // The export override is shown only on a failing card, so the caption is first taken
        // past the cap (insertText stands in for a paste, as in 8e) and written by leaving it.
        await squareOpener.click();
        await squareDialog.waitFor();
        await pressUntilFocused(page, caption);
        await page.keyboard.press('Control+a');
        await page.keyboard.insertText('y'.repeat(LINKEDIN.captionCap));
        await page.keyboard.press('Tab');
        const override = squareDialog.getByRole('checkbox', { name: OVERRIDE_LABEL });
        await override.waitFor({ timeout: 5_000 });
        // Opened again, so the walk starts where it does for a person: on the dialog heading.
        // The click on Open is the same as 8a's; the walk itself is Tab only.
        await closeSquare();
        await squareOpener.click();
        await squareDialog.waitFor();
        // The crop area appears once the photo has opened; until then Tab would skip it.
        await squareDialog.getByRole('application').waitFor({ timeout: 30_000 });
        const order = [];
        for (let presses = 0; presses < 30; presses++) {
          await page.keyboard.press('Tab');
          const reached = await page.evaluate(() => {
            const element = document.activeElement;
            if (element.getAttribute('role') === 'application') return 'crop area';
            if (element.dataset.testid === 'focal-marker') return 'focal point';
            if (element.tagName === 'TEXTAREA') return element.labels?.[0]?.textContent;
            if (element.tagName === 'INPUT') {
              const kinds = {
                color: 'colour picker',
                text: 'hex box',
                radio: 'file type',
                range: 'quality',
                checkbox: 'export override',
              };
              return kinds[element.type] ?? element.type;
            }
            return element.getAttribute('aria-label') ?? element.textContent.trim();
          });
          order.push(reached);
          if (reached === 'Close') break;
        }
        // Back to a short caption, so the card no longer fails, and the override goes away.
        await pressUntilFocused(page, caption, 'Shift+Tab');
        await page.keyboard.press('Control+a');
        await page.keyboard.type('Topping out');
        await page.keyboard.press('Tab');
        await override.waitFor({ state: 'detached', timeout: 5_000 });
        await closeSquare();
        const want = [
          'crop area',
          'focal point',
          'Fit whole photo',
          'colour picker',
          'hex box',
          'file type',
          'quality',
          'Caption',
          'Copy caption',
          'Hashtags',
          'Copy hashtags',
          'First comment',
          'Copy first comment',
          'Alt text',
          'Copy alt text',
          'export override',
          'Close',
        ];
        check(title, JSON.stringify(order) === JSON.stringify(want), order.join(' → '));
      },
    );

    await step(
      '8j. typing alt text and leaving the box clears the rule 8 warning in the dialog and on the tile',
      async (title) => {
        await openFeed();
        const checks = feedDialog.getByRole('region', { name: 'Checks' });
        const before = {
          checks: await checks.innerText(),
          box: await describedText(feedBox('Alt text')),
          tile: await tileState(),
        };
        await pressUntilFocused(page, feedBox('Alt text'));
        await page.keyboard.type(ALT);
        const count = (await describedText(feedBox('Alt text')))[0];
        // Leaving the box with Tab writes it; focus goes to Copy alt text.
        await page.keyboard.press('Tab');
        const onCopy = await copyButton('Copy alt text').evaluate(
          (element) => element === document.activeElement,
        );
        const after = {
          checks: await checks.innerText(),
          box: await describedText(feedBox('Alt text')),
          tile: await tileState(),
        };
        // Only rule 8 on this card before, so it must pass once rule 8 is cleared.
        const onlyRule8 =
          before.tile.result === 'Warning' &&
          before.tile.altMissing &&
          before.box.at(-1) === 'Warning: Alt text is missing.' &&
          before.checks.includes('Alt text is missing.') &&
          before.checks.split('Warning:').length === 2;
        check(
          title,
          onlyRule8 &&
            onCopy &&
            count === `${[...ALT].length} characters` &&
            !after.box.some((text) => text.includes('Alt text is missing')) &&
            !after.checks.includes('Alt text is missing') &&
            after.tile.result === 'Pass' &&
            !after.tile.altMissing,
          `before: tile ${JSON.stringify(before.tile)}, box ${JSON.stringify(before.box)}; after: tile ${JSON.stringify(after.tile)}, box ${JSON.stringify(after.box)}, count "${count}", focus on Copy alt text ${onCopy}`,
        );
      },
    );

    await step(
      '8k. Ctrl-Z after leaving the alt text box takes the whole visit back in one step, and the warning returns',
      async (title) => {
        await openFeed();
        // Focus is on Copy alt text, a button, so Ctrl-Z is the app's undo.
        await page.keyboard.press('Control+z');
        const box = await feedBox('Alt text').inputValue();
        const described = await describedText(feedBox('Alt text'));
        const tile = await tileState();
        check(
          title,
          box === '' &&
            described.at(-1) === 'Warning: Alt text is missing.' &&
            tile.result === 'Warning' &&
            tile.altMissing,
          `alt text "${box}", box ${JSON.stringify(described)}, tile ${JSON.stringify(tile)}`,
        );
      },
    );

    await step(
      '8l. Copy alt text on an empty box (Space) says "Nothing to copy yet." and leaves the clipboard alone',
      async (title) => {
        await openFeed();
        await pressUntilFocused(page, copyButton('Copy alt text'));
        await putSentinel();
        await page.keyboard.press(' ');
        // Set in the key press itself, with no clipboard call, so it is read straight away.
        const status = await copyStatus('Copy alt text').innerText();
        const clipboard = await readClipboard();
        check(
          title,
          status === 'Nothing to copy yet.' && clipboard === CLIPBOARD_SENTINEL,
          `status "${status}", clipboard ${JSON.stringify(clipboard)}`,
        );
      },
    );

    await step(
      '8m. Copy hashtags on "# #" (Enter) says "Nothing to copy yet." and leaves the clipboard alone',
      async (title) => {
        await openFeed();
        await pressUntilFocused(page, feedBox('Hashtags'), 'Shift+Tab');
        await page.keyboard.press('Control+a');
        await page.keyboard.type('# #');
        await page.keyboard.press('Tab');
        await putSentinel();
        await page.keyboard.press('Enter');
        const status = await copyStatus('Copy hashtags').innerText();
        const clipboard = await readClipboard();
        check(
          title,
          status === 'Nothing to copy yet.' && clipboard === CLIPBOARD_SENTINEL,
          `status "${status}", clipboard ${JSON.stringify(clipboard)}`,
        );
      },
    );

    await step(
      '8n. each Copy button puts its box text on the clipboard: caption (Enter), hashtags with "#" added (Space), alt text (Enter)',
      async (title) => {
        await openFeed();
        const got = {};
        // Caption, with an accent, an emoji and a line break; Copy pressed with Enter.
        await pressUntilFocused(page, feedBox('Caption'), 'Shift+Tab');
        await page.keyboard.press('Control+a');
        await page.keyboard.type(CAPTION);
        await page.keyboard.press('Tab');
        await putSentinel();
        await page.keyboard.press('Enter');
        got.caption = { status: await copiedStatus('Copy caption'), text: await readClipboard() };
        // Hashtags typed without "#"; Copy pressed with Space.
        await pressUntilFocused(page, feedBox('Hashtags'));
        await page.keyboard.press('Control+a');
        await page.keyboard.type(TAGS_TYPED);
        await page.keyboard.press('Tab');
        await putSentinel();
        await page.keyboard.press(' ');
        got.hashtags = { status: await copiedStatus('Copy hashtags'), text: await readClipboard() };
        copiedHashtags = got.hashtags.text;
        // Alt text again; Copy pressed with Enter.
        await pressUntilFocused(page, feedBox('Alt text'));
        await page.keyboard.type(ALT);
        await page.keyboard.press('Tab');
        await putSentinel();
        await page.keyboard.press('Enter');
        got.altText = { status: await copiedStatus('Copy alt text'), text: await readClipboard() };
        check(
          title,
          got.caption.status === 'Copied.' &&
            got.caption.text === CAPTION &&
            got.hashtags.status === 'Copied.' &&
            got.hashtags.text === TAGS_COPIED &&
            got.altText.status === 'Copied.' &&
            got.altText.text === ALT,
          JSON.stringify(got),
        );
      },
    );

    await step(
      '8o. Copy first comment by mouse click while still typing copies the typed text, and the box is written once',
      async (title) => {
        await openFeed();
        await pressUntilFocused(page, feedBox('First comment'), 'Shift+Tab');
        await page.keyboard.press('Control+a');
        await page.keyboard.type(COMMENT);
        await putSentinel();
        // A real click: the press moves focus to the button, which writes the box (one step),
        // and the click then copies the box's text.
        await copyButton('Copy first comment').click();
        const status = await copiedStatus('Copy first comment');
        const clipboard = await readClipboard();
        // One Ctrl-Z (focus is on the button) takes back exactly that one write: the first
        // comment empties and the hashtags written before it stay.
        await page.keyboard.press('Control+z');
        const afterUndo = {
          firstComment: await feedBox('First comment').inputValue(),
          hashtags: await feedBox('Hashtags').inputValue(),
        };
        // Typed again and left with Tab, for the reload and export below.
        await pressUntilFocused(page, feedBox('First comment'), 'Shift+Tab');
        await page.keyboard.type(COMMENT);
        await page.keyboard.press('Tab');
        check(
          title,
          status === 'Copied.' &&
            clipboard === COMMENT &&
            afterUndo.firstComment === '' &&
            afterUndo.hashtags === TAGS_TYPED,
          `status "${status}", clipboard ${JSON.stringify(clipboard)}; after one Ctrl-Z ${JSON.stringify(afterUndo)}`,
        );
      },
    );

    let feedCardId = null;
    await step(
      '8p. after a page reload and loading the .scs again, the card keeps its alt text',
      async (title) => {
        if (await feedDialog.isVisible()) {
          await page.keyboard.press('Escape');
          await feedDialog.waitFor({ state: 'hidden' });
        }
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'Download .scs' }).click(),
        ]);
        const bundlePath = join(outDir, `${name}-alt-text.scs`);
        await download.saveAs(bundlePath);
        const saved = JSON.parse(
          await (
            await JSZip.loadAsync(readFileSync(bundlePath))
          )
            .file('session.json')
            .async('string'),
        );
        const photoId = saved.assets.find((asset) => asset.fileName === PHOTO)?.id;
        const savedCard = saved.cards.find(
          (card) => card.placement === 'feed-vertical' && card.assetIds[0] === photoId,
        );
        feedCardId = savedCard?.id ?? null;
        // A real reload empties the page; the session comes back from the bundle (the file
        // picker cannot be driven, so the file is given to the input, as in section 5).
        await page.reload({ waitUntil: 'load' });
        await page.getByText('No session is open.').waitFor();
        await page.getByLabel('Session bundle file').setInputFiles(bundlePath);
        await page
          .getByRole('status')
          .filter({ hasText: /^Opened / })
          .first()
          .waitFor();
        await openFeed();
        const kept = {
          altText: await feedBox('Alt text').inputValue(),
          caption: await feedBox('Caption').inputValue(),
          hashtags: await feedBox('Hashtags').inputValue(),
          firstComment: await feedBox('First comment').inputValue(),
        };
        await page.keyboard.press('Escape');
        await feedDialog.waitFor({ state: 'hidden' });
        check(
          title,
          savedCard?.copy.altText === ALT &&
            kept.altText === ALT &&
            kept.caption === CAPTION &&
            kept.hashtags === TAGS_TYPED &&
            kept.firstComment === COMMENT,
          `saved alt text ${JSON.stringify(savedCard?.copy.altText)}; after reload ${JSON.stringify(kept)}`,
        );
      },
    );

    await step(
      '8q. the exported captions.csv row has the typed alt text, and the hashtags Copy put on the clipboard',
      async (title) => {
        await waitForRendered(page, await page.getByRole('article').count());
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'Download as .zip' }).click(),
        ]);
        const zipPath = join(outDir, `${name}-export.zip`);
        await download.saveAs(zipPath);
        const zip = await JSZip.loadAsync(readFileSync(zipPath));
        const csv = parseCsv(await zip.file('captions.csv').async('string'));
        const header = csv[0] ?? [];
        const rows = csv.slice(1).filter((row) => feedCardId && row[0].includes(`_${feedCardId}.`));
        const row = Object.fromEntries(header.map((column, index) => [column, rows[0]?.[index]]));
        check(
          title,
          rows.length === 1 &&
            row.alt_text === ALT &&
            copiedHashtags === TAGS_COPIED &&
            row.hashtags === copiedHashtags &&
            row.caption === CAPTION &&
            row.first_comment === COMMENT,
          `card ${feedCardId}: ${rows.length} row(s); alt_text ${JSON.stringify(row.alt_text)}, hashtags ${JSON.stringify(row.hashtags)} (Copy gave ${JSON.stringify(copiedHashtags)})`,
        );
      },
    );

    // 9. Network and console.
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
    // A timeout's first line does not say which step stalled. Playwright names what it was
    // waiting for on a later line, wrapped in terminal colour codes, which are cut off here.
    const lines = String(error).split('\n');
    const call = lines.find((line) => line.includes('- waiting for '));
    const waiting = call?.slice(call.indexOf('waiting for ')).split(String.fromCharCode(27))[0];
    check(
      'the check ran to the end',
      false,
      waiting ? `${lines[0]} It was ${waiting.trim()}.` : (lines[0] ?? ''),
    );
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
