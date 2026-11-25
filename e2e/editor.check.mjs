#!/usr/bin/env node
/**
 * Checks the editor in real Chromium, against the dev server and against a production build
 * served under a subpath:
 *
 *   node e2e/editor.check.mjs [--out <folder for the report>]
 *
 * It imports a photo made in the browser (four plain colours, one in each quarter, with no
 * personal content and no metadata), creates an Instagram Feed vertical and a LinkedIn Image
 * post square card, and opens the editor. Because the colours meet in the middle of the photo,
 * where they meet in a rendered file shows exactly which part of the photo was cropped.
 *
 * It checks: dragging the crop and resizing it from a corner (exact output size, and the
 * pixels move as expected); moving and resizing with the keyboard, reached with Tab and after a
 * mouse click, for the crop and for the focal point; that the board behind the dialog does not
 * scroll and is where it was when the dialog closes; Reset crop; a focal point
 * move that re-centres a card on its automatic crop and leaves a hand-adjusted card alone; one
 * Ctrl-Z that reverses that move as a whole; a .scs download and reload that keeps the crops
 * and the focal point; that opening the editor requests no new script; and that every request
 * stays under the app's own address with no failed requests and no console errors.
 *
 * It then duplicates a card and checks that the duplicate has its own focal point: moving it
 * changes the duplicate alone, moving the photo's leaves the duplicate alone, one Ctrl-Z
 * reverses each, and a .scs download and reload keeps the duplicate's own point.
 *
 * Last, the file type and quality in the card dialog: clicking the type the card already has
 * adds no undo step; choosing PNG makes the card again as a PNG at its size, with the caption
 * under the preview saying so, and one Ctrl-Z goes back to JPG; and a mouse drag, a touch drag
 * (real touch input, sent through the DevTools protocol) and a held arrow key on the quality
 * slider are each one undo step.
 *
 * Then the dialog's size while the card renders again: with the crop small enough for the
 * enlarged-to-fit note, a held arrow key and a mouse drag of the crop, at 1280 × 900 (editor
 * beside the details) and 900 × 900 (editor above them), each leave the dialog's height and the
 * crop area's and the Close button's positions within 1 px on every animation frame.
 *
 * Last of all, in a fresh session, padding and the background colour (`runPadding`): the Tab
 * order of the card dialog; a corner dragged past the photo's edge stops at the fit size; the
 * corner targets shrink on a small crop, where a press in the middle moves it and a press on a
 * corner resizes it; Fit whole photo reached with Tab and pressed from the keyboard; a colour
 * typed into the hex box shows in the editor and in the rendered file; Ctrl-Z steps back
 * through the colour and the fit; a colour tried in the colour picker is kept when a click
 * outside closes the picker, as one undo step; the arrow keys keep to the crop limits; Reset
 * crop removes the padding and keeps the colour; a .scs download and reload keeps both; and a
 * duplicate has the colour. Each of these is its own step, so one that cannot run (in a version of the app
 * without the control it needs) fails by itself and the rest still run.
 *
 * How it reaches things. Every control is reached the way a person reaches it: with Tab, or
 * with a real mouse click or drag. Keys are sent with page.keyboard, to whatever has focus. It
 * never calls element.focus() and never dispatches an event straight at an element. The two
 * exceptions, each with its reason where it is used: files are given to the file inputs with
 * setInputFiles, because the system's file picker cannot be driven; touch input is sent
 * through the DevTools protocol, because Playwright's mouse cannot make a touch; and a colour
 * tried in the colour picker is set on the input with the `input` event Chrome sends, because
 * Chrome's colour picker is browser UI that Playwright cannot open or click in.
 *
 * Like e2e/board.check.mjs, it needs Playwright with Chromium already installed on the machine,
 * and is not part of `npm test` or the deploy workflow. Nothing it produces is written inside
 * the repository except the normal `dist` build.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeSampling, startSampling, steady, stopSampling } from './layoutSampler.mjs';
import { describePadding, measurePadding, paddingOk, rgbOf } from './paddingPixels.mjs';
import { controlWorkers, holdRenders, releaseRenders, waitForHeld } from './workerHold.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const BASE = '/social-content-studio/';
const PORTS = { dev: 5194, site: 5195 };
const outFlag = process.argv.indexOf('--out');
const outDir = resolve(outFlag > -1 ? process.argv[outFlag + 1] : join(tmpdir(), 'editor-check'));
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

const PHOTO = 'editor-check.jpg';
const SOURCE = { width: 4000, height: 3000 };
const FEED_CARD = `Instagram Feed vertical for ${PHOTO}, v1`;
const SQUARE_CARD = `LinkedIn Image post square for ${PHOTO}, v1`;
/** The duplicate of the feed card. */
const COPY_CARD = `Instagram Feed vertical for ${PHOTO}, v2`;

/** How close a measured position must be to the expected one, as a fraction of the picture. */
const NEAR = 0.006;
const near = (a, b, tolerance = NEAR) => Math.abs(a - b) <= tolerance;
const show = (value) => (value === null ? 'none' : value.toFixed(3));

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

/** The test photo, drawn in the browser: a different plain colour in each quarter. */
async function makePhoto(page) {
  const base64 = await page.evaluate(async ({ width, height }) => {
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d');
    const colours = ['#4548cc', '#ffb38a', '#1b9c63', '#ffffff'];
    [
      [0, 0],
      [width / 2, 0],
      [0, height / 2],
      [width / 2, height / 2],
    ].forEach(([x, y], index) => {
      g.fillStyle = colours[index];
      g.fillRect(x, y, width / 2, height / 2);
    });
    const bytes = new Uint8Array(
      await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer(),
    );
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  }, SOURCE);
  return Buffer.from(base64, 'base64');
}

/** A card on the board. Found by attribute, because an open dialog hides the board from roles. */
const tile = (page, cardLabel) => page.locator(`article[aria-label="${cardLabel}"]`);
const tileSrc = (page, cardLabel) =>
  tile(page, cardLabel).locator('img').getAttribute('src', { timeout: 60_000 });

/** Waits for a card's file to be made again, and returns the new file's address. */
async function nextRender(page, cardLabel, previous) {
  await page.waitForFunction(
    ([selector, old]) => {
      const img = document.querySelector(`${selector} img`);
      return img && img.getAttribute('src') !== old;
    },
    [`article[aria-label="${cardLabel}"]`, previous],
    { timeout: 60_000 },
  );
  return tileSrc(page, cardLabel);
}

/**
 * Reads a rendered file in the page: its type from its bytes, its size in pixels, and where the
 * photo's colours meet in it: `across` is how far along the top edge the colour changes, and
 * `down` how far along the left edge, each as a fraction (null when it does not change).
 */
function inspect(page, src) {
  return page.evaluate(async (url) => {
    const blob = await (await fetch(url)).blob();
    const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
    const type =
      head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
        ? 'jpeg'
        : head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e
          ? 'png'
          : 'other';
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d');
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    const colours = [
      [0x45, 0x48, 0xcc],
      [0xff, 0xb3, 0x8a],
      [0x1b, 0x9c, 0x63],
      [0xff, 0xff, 0xff],
    ];
    const nearest = (data, offset) => {
      let best = 0;
      let least = Infinity;
      colours.forEach((colour, index) => {
        const distance =
          (data[offset] - colour[0]) ** 2 +
          (data[offset + 1] - colour[1]) ** 2 +
          (data[offset + 2] - colour[2]) ** 2;
        if (distance < least) {
          least = distance;
          best = index;
        }
      });
      return best;
    };
    const change = (data, count) => {
      const first = nearest(data, 0);
      for (let i = 1; i < count; i++) if (nearest(data, i * 4) !== first) return i / count;
      return null;
    };
    return {
      type,
      width,
      height,
      bytes: blob.size,
      across: change(g.getImageData(0, 3, width, 1).data, width),
      down: change(g.getImageData(3, 0, 1, height).data, height),
    };
  }, src);
}

/** Where the colours should meet in a file made from `crop` (fractions of the photo). */
function expected(crop) {
  const along = (start, size) => {
    const at = (0.5 - start) / size;
    return at > NEAR && at < 1 - NEAR ? at : null;
  };
  return { across: along(crop.x, crop.width), down: along(crop.y, crop.height) };
}
const meets = (file, crop) => {
  const want = expected(crop);
  const one = (got, wanted) => (wanted === null ? got === null : got !== null && near(got, wanted));
  return one(file.across, want.across) && one(file.down, want.down);
};
const describeFile = (file, crop) => {
  const want = expected(crop);
  return (
    `${file.type}, ${file.width} × ${file.height}; colours meet ${show(file.across)} across ` +
    `(expected ${show(want.across)}) and ${show(file.down)} down (expected ${show(want.down)})`
  );
};

/**
 * The crop and the focal point the editor is showing, as fractions of the photo, with what the
 * editor says about whose focal point it is: the marker's label and the line under the photo.
 */
function shown(page) {
  return page.evaluate(() => {
    const fraction = (text) => parseFloat(text) / 100;
    const rect = document.querySelector('[data-testid=crop-rect]').style;
    const element = document.querySelector('[data-testid=focal-marker]');
    const marker = element.style;
    const centre = (text) => parseFloat(text.replace('calc(', '')) / 100;
    return {
      label: element.getAttribute('aria-label'),
      kind: document.querySelector('[data-testid=focal-kind]').textContent,
      crop: {
        x: fraction(rect.left),
        y: fraction(rect.top),
        width: fraction(rect.width),
        height: fraction(rect.height),
      },
      focal: { x: centre(marker.left), y: centre(marker.top) },
    };
  });
}
const sameCrop = (a, b, tolerance = 0.004) =>
  near(a.x, b.x, tolerance) &&
  near(a.y, b.y, tolerance) &&
  near(a.width, b.width, tolerance) &&
  near(a.height, b.height, tolerance);
const cropText = (c) =>
  `x ${c.x.toFixed(3)}, y ${c.y.toFixed(3)}, ${c.width.toFixed(3)} × ${c.height.toFixed(3)}`;

/** The automatic crop for an output size and a focal point: the same rule as the app's. */
function automatic(target, focal) {
  const ratio = target.width / target.height;
  const wide = SOURCE.width / SOURCE.height > ratio;
  const width = wide ? (SOURCE.height * ratio) / SOURCE.width : 1;
  const height = wide ? 1 : SOURCE.width / ratio / SOURCE.height;
  const clamp = (value, max) => Math.min(max, Math.max(0, value));
  return {
    x: clamp(focal.x - width / 2, 1 - width),
    y: clamp(focal.y - height / 2, 1 - height),
    width,
    height,
  };
}

/**
 * Drags an element by a distance given in fractions of the photo's frame. The drag starts at
 * `from`, a point on the element in fractions of its own size: its middle unless told otherwise.
 */
async function drag(page, testId, dx, dy, from = { x: 0.5, y: 0.5 }) {
  const box = await page.getByTestId(testId).boundingBox();
  const frame = await page.getByTestId('crop-frame').boundingBox();
  const x = box.x + box.width * from.x;
  const y = box.y + box.height * from.y;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx * frame.width, y + dy * frame.height, { steps: 8 });
  await page.mouse.up();
}

/** A point in the crop that is clear of the focal point's marker and of the corner handles. */
async function cropPoint(page) {
  const crop = await page.getByTestId('crop-rect').boundingBox();
  const marker = await page.getByTestId('focal-marker').boundingBox();
  const centre = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
  for (const [fx, fy] of [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ]) {
    const point = { x: crop.x + crop.width * fx, y: crop.y + crop.height * fy };
    if (Math.hypot(point.x - centre.x, point.y - centre.y) > marker.width) return point;
  }
  throw new Error('no point in the crop is clear of the focal point marker');
}
/** A real mouse click inside the crop, away from the marker: press and release, no movement. */
async function clickCrop(page) {
  const point = await cropPoint(page);
  await page.mouse.click(point.x, point.y);
}

/** Whether an element is the one with keyboard focus. */
const hasFocus = (locator) => locator.evaluate((element) => element === document.activeElement);
/** What has focus, in a few words, for the report. */
const focusName = (page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    const name = element?.getAttribute('aria-label') ?? element?.textContent ?? '';
    return `${element?.tagName.toLowerCase() ?? 'nothing'} "${name.trim().slice(0, 32)}"`;
  });
/** Presses Tab, as a person would, until the element has focus. Fails if it never does. */
async function tabTo(page, locator, what, limit = 12) {
  for (let presses = 1; presses <= limit; presses++) {
    await page.keyboard.press('Tab');
    if (await hasFocus(locator)) return presses;
  }
  throw new Error(
    `Tab did not reach ${what} in ${limit} presses; focus is on ${await focusName(page)}`,
  );
}
/**
 * Whether the focused element shows the app's focus ring: it matches :focus-visible and has a
 * solid outline in the accent colour, which is read from the theme, not written here.
 */
function ringShown(locator) {
  return locator.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-accent)';
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(element);
    return (
      element.matches(':focus-visible') &&
      style.outlineStyle === 'solid' &&
      parseFloat(style.outlineWidth) >= 2 &&
      style.outlineColor === accent
    );
  });
}

/** How far down the page (the board) is scrolled. */
const pageY = (page) => page.evaluate(() => window.scrollY);
/** Lets a scroll that was asked for happen, if it is going to. */
const settle = (page) => page.waitForTimeout(150);
/**
 * Tries to scroll with whatever has focus: the arrow keys, Page Down, Space, and the mouse wheel
 * over the dialog and over the backdrop beside it. Returns where the page was after each.
 */
async function tryToScroll(page) {
  const seen = [];
  for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'Space']) {
    await page.keyboard.press(key);
    await settle(page);
    seen.push(await pageY(page));
  }
  const dialog = await page.getByRole('dialog').boundingBox();
  for (const x of [dialog.x + dialog.width / 2, dialog.x / 2]) {
    await page.mouse.move(x, dialog.y + dialog.height / 2);
    await page.mouse.wheel(0, 300);
    await settle(page);
    seen.push(await pageY(page));
  }
  return seen;
}

const renderProgress = (page) => page.getByRole('status', { name: 'Render progress' });
async function waitForRendered(page, count) {
  await renderProgress(page)
    .filter({ hasText: new RegExp(`^Rendered ${count} cards?: `) })
    .waitFor({ timeout: 60_000 });
}

async function openEditor(page, cardLabel) {
  await page.getByRole('button', { name: `Open ${cardLabel}`, exact: true }).click();
  await page.getByRole('application').waitFor({ timeout: 60_000 });
}
async function closeEditor(page) {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

// --------------------------------------------------------------------------- the check

/** Starts a session with the test photo and the two cards, and waits for their files. */
async function startSession(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'New session' }).click();
  // The system's file picker cannot be driven, so the file is given to the input directly.
  await page.getByLabel('Photos to import').setInputFiles({
    name: PHOTO,
    mimeType: 'image/jpeg',
    buffer: await makePhoto(page),
  });
  await page.getByRole('status').filter({ hasText: 'Import finished' }).first().waitFor();
  await page.getByRole('button', { name: 'Create cards' }).click();
  const form = page.getByRole('form', { name: 'Create cards' });
  for (const placement of ['Feed vertical', 'Image post square']) {
    await form.getByRole('checkbox', { name: new RegExp(`^${placement} \\(`) }).check();
  }
  await form.getByRole('button', { name: 'Create' }).click();
  await waitForRendered(page, 2);
}

async function runEditor(browser, scrollbarBrowser, name, url) {
  console.log(`\n== Editor check: ${name} (${url})`);
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  });
  // Lets section 18 hold a render back (see e2e/workerHold.mjs); nothing is held otherwise.
  await context.addInitScript(controlWorkers);
  const requests = [];
  const problems = [];
  context.on('request', (request) =>
    requests.push({ url: request.url(), type: request.resourceType() }),
  );
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
  /** Checks the open card's file after an edit: exact size, and the crop it was made from. */
  async function checkFile(title, cardLabel, target, previous) {
    const src = await nextRender(page, cardLabel, previous);
    const { crop } = await shown(page);
    const file = await inspect(page, src);
    check(
      title,
      file.type === 'jpeg' &&
        file.width === target.width &&
        file.height === target.height &&
        meets(file, crop),
      `crop ${cropText(crop)}; ${describeFile(file, crop)}`,
    );
    return src;
  }

  try {
    await startSession(page, url);

    // 1. Opening the editor on a JPG asks for nothing new: no script, no chunk.
    const before = requests.length;
    await openEditor(page, FEED_CARD);
    const opened = requests.slice(before).filter((r) => !/^(blob|data):/.test(r.url));
    check(
      'opening the editor on a JPG photo requests no new script or chunk',
      opened.length === 0,
      opened.length ? opened.map((r) => `${r.type} ${r.url}`).join(', ') : 'no requests',
    );

    // 2. It opens on the automatic crop, with the focal point in the middle.
    const feedAuto = automatic(FEED, { x: 0.5, y: 0.5 });
    let feedSrc = await tileSrc(page, FEED_CARD);
    const start = await shown(page);
    const startFile = await inspect(page, feedSrc);
    check(
      'the editor opens on the automatic crop, which is what was rendered',
      sameCrop(start.crop, feedAuto) && near(start.focal.x, 0.5) && meets(startFile, feedAuto),
      `crop ${cropText(start.crop)}; ${describeFile(startFile, feedAuto)}`,
    );

    // 3. Drag the crop a tenth of the photo to the right. It is held away from its middle,
    //    where the focal point's marker sits on top of it.
    await drag(page, 'crop-rect', 0.1, 0, { x: 0.25, y: 0.25 });
    const dragged = await shown(page);
    feedSrc = await checkFile(
      `dragging the crop moves it, and the file is still ${FEED.width} × ${FEED.height}`,
      FEED_CARD,
      FEED,
      feedSrc,
    );
    check(
      'the crop moved by the distance dragged and kept its size',
      sameCrop(dragged.crop, { ...feedAuto, x: feedAuto.x + 0.1 }),
      cropText(dragged.crop),
    );

    // 4. Drag the bottom right corner up and to the left, well outside the handle itself.
    await drag(page, 'crop-handle-se', -0.2, -0.5);
    const resized = await shown(page);
    feedSrc = await checkFile(
      `resizing from a corner keeps the shape, and the file is still ${FEED.width} × ${FEED.height}`,
      FEED_CARD,
      FEED,
      feedSrc,
    );
    const shape = (resized.crop.width * SOURCE.width) / (resized.crop.height * SOURCE.height);
    check(
      'the resized crop kept its top left corner and the shape of the placement',
      near(resized.crop.x, dragged.crop.x, 0.004) &&
        near(resized.crop.y, 0, 0.004) &&
        resized.crop.width < dragged.crop.width - 0.1 &&
        near(shape, FEED.width / FEED.height, 0.01),
      `${cropText(resized.crop)}; shape ${shape.toFixed(3)}`,
    );

    // 5. Keyboard. The dialog is closed and opened again, so everything below starts where a
    //    person starts: the dialog has just opened, and nothing in it has been clicked. The
    //    board is first scrolled away from its top with the mouse wheel, so that "the board did
    //    not move" further down means something.
    await closeEditor(page);
    const stage = page.getByRole('application');
    const marker = page.getByTestId('focal-marker');
    const openFeed = page.getByRole('button', { name: `Open ${FEED_CARD}`, exact: true });
    const jpgChoice = page.getByRole('dialog').getByRole('radio', { name: 'JPG' });
    await page.mouse.move(640, 450);
    await page.mouse.wheel(0, 120);
    await settle(page);
    const boardY = await pageY(page);
    await openEditor(page, FEED_CARD);
    const openedY = await pageY(page);
    /** Presses a key that changes the feed card's crop, and waits for the card's new file. */
    const cropKey = async (key) => {
      await page.keyboard.press(key);
      feedSrc = await nextRender(page, FEED_CARD, feedSrc);
    };

    // 5a. Tab, from the dialog as it opens: the crop area first, then the focal point.
    await page.keyboard.press('Tab');
    const firstTab = await focusName(page);
    const stageByTab = (await hasFocus(stage)) && (await ringShown(stage));
    await page.keyboard.press('Tab');
    const secondTab = await focusName(page);
    const markerByTab = (await hasFocus(marker)) && (await ringShown(marker));
    check(
      'Tab from the open dialog reaches the crop area, then the focal point, each with the focus ring showing',
      boardY > 0 && openedY === boardY && stageByTab && markerByTab,
      `board scrolled to ${boardY}; first Tab: ${firstTab}, ring ${stageByTab}; second Tab: ${secondTab}, ring ${markerByTab}`,
    );

    // 5b. Back to the crop area with Shift+Tab. Arrows move the crop.
    await page.keyboard.press('Shift+Tab');
    const backOnStage = await hasFocus(stage);
    await cropKey('Shift+ArrowLeft');
    const moved = await shown(page);
    await page.keyboard.press('ArrowDown');
    feedSrc = await checkFile(
      'arrow keys move the crop, and the file follows',
      FEED_CARD,
      FEED,
      feedSrc,
    );
    const nudged = await shown(page);
    check(
      'Shift with an arrow key moves a tenth of the photo, an arrow key alone a hundredth',
      backOnStage &&
        near(moved.crop.x, resized.crop.x - 0.1, 0.002) &&
        near(nudged.crop.y, moved.crop.y + 0.01, 0.002),
      `crop area reached with Shift+Tab: ${backOnStage}; x ${resized.crop.x.toFixed(3)} -> ${moved.crop.x.toFixed(3)}, y ${moved.crop.y.toFixed(3)} -> ${nudged.crop.y.toFixed(3)}`,
    );

    // 5c. Minus and equals resize the crop by a hundredth.
    await page.keyboard.press('Minus');
    feedSrc = await checkFile(
      'minus shrinks the crop about its centre, and the file follows',
      FEED_CARD,
      FEED,
      feedSrc,
    );
    const smaller = await shown(page);
    await cropKey('Equal');
    const larger = await shown(page);
    const centre = (c) => c.x + c.width / 2;
    check(
      'minus and equals change the width by a hundredth of the photo and keep the centre',
      near(smaller.crop.width, nudged.crop.width - 0.01, 0.002) &&
        near(larger.crop.width, nudged.crop.width, 0.002) &&
        near(centre(smaller.crop), centre(nudged.crop), 0.002),
      `width ${nudged.crop.width.toFixed(3)} -> ${smaller.crop.width.toFixed(3)} -> ${larger.crop.width.toFixed(3)}`,
    );

    // 5d. The other keys: Shift makes a step ten times as big (Shift with equals is how plus is
    //     typed), and the number pad's plus and minus do the same, with and without Shift.
    const widths = [larger.crop.width];
    const resizeKeys = [
      ['Shift+Minus', -0.1],
      ['Shift+Equal', 0.1],
      ['NumpadSubtract', -0.01],
      ['NumpadAdd', 0.01],
      ['Shift+NumpadSubtract', -0.1],
      ['Shift+NumpadAdd', 0.1],
    ];
    for (const [key] of resizeKeys) {
      await cropKey(key);
      widths.push((await shown(page)).crop.width);
    }
    check(
      'Shift makes minus and equals resize by a tenth, and the number pad plus and minus resize too',
      resizeKeys.every(([, change], index) =>
        near(widths[index + 1], widths[index] + change, 0.002),
      ),
      `width ${widths.map((width) => width.toFixed(3)).join(' -> ')} after ${resizeKeys.map(([key]) => key).join(', ')}`,
    );

    // 5e. After a mouse click. Focus is first put on the JPG choice with a real click (it is
    //     already chosen, so that changes nothing). Before the fix, a click on the crop left
    //     focus there, and the arrow key then switched the card to PNG.
    await jpgChoice.click();
    const beforeClick = await shown(page);
    await clickCrop(page);
    const afterClick = await shown(page);
    const stageByClick = await hasFocus(stage);
    const clickY = await pageY(page);
    await cropKey('ArrowRight');
    const afterClickKey = await shown(page);
    const stillJpg = await jpgChoice.isChecked();
    check(
      'a click on the crop gives the crop area focus; the arrow keys then move it and the file type stays the same',
      stageByClick &&
        sameCrop(afterClick.crop, beforeClick.crop, 0.0005) &&
        clickY === boardY &&
        near(afterClickKey.crop.x, beforeClick.crop.x + 0.01, 0.002) &&
        stillJpg,
      `focus on the crop area: ${stageByClick}; the click moved nothing: ${sameCrop(afterClick.crop, beforeClick.crop, 0.0005)}; x ${beforeClick.crop.x.toFixed(3)} -> ${afterClickKey.crop.x.toFixed(3)}; JPG still chosen: ${stillJpg}`,
    );

    // 5f. After a corner drag, with focus first moved off the crop area by Tab.
    await page.keyboard.press('Tab');
    const awayFirst = await hasFocus(marker);
    await drag(page, 'crop-handle-se', 0.05, 0.05);
    feedSrc = await nextRender(page, FEED_CARD, feedSrc);
    const afterCorner = await shown(page);
    const stageByCorner = await hasFocus(stage);
    await cropKey('ArrowRight');
    const afterCornerKey = await shown(page);
    check(
      'after a corner drag the keys still go to the crop',
      awayFirst &&
        stageByCorner &&
        afterCorner.crop.width > afterClickKey.crop.width + 0.02 &&
        near(afterCornerKey.crop.x, afterCorner.crop.x + 0.01, 0.002),
      `focus was on the focal point: ${awayFirst}; after the drag on the crop area: ${stageByCorner}; x ${afterCorner.crop.x.toFixed(3)} -> ${afterCornerKey.crop.x.toFixed(3)}`,
    );

    // The crop the rest of this opening must come back to. Everything from here to 5j moves
    // the focal point or nudges the crop, and is undone with Ctrl-Z before Reset crop.
    const settled = await shown(page);

    // 5g. The focal point, reached with Tab from the crop area. Arrows move it; minus and
    //     equals are the crop's keys and do nothing here.
    await page.keyboard.press('Tab');
    const markerFocused = (await hasFocus(marker)) && (await ringShown(marker));
    await page.keyboard.press('ArrowLeft');
    const focalLeft = await shown(page);
    await page.keyboard.press('Shift+ArrowDown');
    const focalDown = await shown(page);
    await page.keyboard.press('Minus');
    await page.keyboard.press('Equal');
    const focalAfterResizeKeys = await shown(page);
    check(
      'Tab to the focal point: arrow keys move it, and minus and equals do nothing',
      markerFocused &&
        near(focalLeft.focal.x, settled.focal.x - 0.01, 0.002) &&
        near(focalLeft.focal.y, settled.focal.y, 0.002) &&
        near(focalDown.focal.y, settled.focal.y + 0.1, 0.002) &&
        near(focalAfterResizeKeys.focal.x, focalDown.focal.x, 0.0005) &&
        near(focalAfterResizeKeys.focal.y, focalDown.focal.y, 0.0005) &&
        sameCrop(focalAfterResizeKeys.crop, settled.crop, 0.0005),
      `focal ${settled.focal.x.toFixed(3)}, ${settled.focal.y.toFixed(3)} -> ${focalDown.focal.x.toFixed(3)}, ${focalDown.focal.y.toFixed(3)}; crop ${cropText(focalAfterResizeKeys.crop)}`,
    );

    // 5h. The focal point after a mouse click on it, with focus first put elsewhere.
    await jpgChoice.click();
    const markerBox = await marker.boundingBox();
    await page.mouse.click(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
    const markerByClick = await hasFocus(marker);
    const focalClicked = await shown(page);
    await page.keyboard.press('ArrowRight');
    const focalRight = await shown(page);
    check(
      'a click on the focal point gives it focus, and the arrow keys then move it',
      markerByClick &&
        near(focalClicked.focal.x, focalDown.focal.x, 0.0005) &&
        near(focalRight.focal.x, focalDown.focal.x + 0.01, 0.002) &&
        (await jpgChoice.isChecked()) &&
        (await pageY(page)) === boardY,
      `focus on the focal point: ${markerByClick}; x ${focalClicked.focal.x.toFixed(3)} -> ${focalRight.focal.x.toFixed(3)}`,
    );

    // 5i. The board behind the dialog stays where it is, whatever has focus: the focal point,
    //     the crop area, and the dialog itself (after a click on plain text in it).
    const scrolledWith = {};
    scrolledWith['the focal point'] = await tryToScroll(page);
    await clickCrop(page);
    scrolledWith['the crop area'] = await tryToScroll(page);
    await page.getByRole('dialog').getByText('Photo', { exact: true }).click();
    const onDialog = await hasFocus(page.getByRole('dialog'));
    scrolledWith['the dialog'] = await tryToScroll(page);
    const stayed = Object.values(scrolledWith).every((seen) => seen.every((y) => y === boardY));
    check(
      'arrow keys, Page Down, Space and the mouse wheel leave the board where it was',
      stayed && onDialog,
      `board at ${boardY}; ${Object.entries(scrolledWith)
        .map(([where, seen]) => `focus on ${where}: ${[...new Set(seen)].join(', ')}`)
        .join('; ')}`,
    );

    // 5j. Ctrl-Z, one press at a time, takes back everything since 5f, and nothing more is
    //     needed: the crop and the focal point are where they were.
    let undoPresses = 0;
    const isSettled = async () => {
      const now = await shown(page);
      return (
        sameCrop(now.crop, settled.crop, 0.0005) &&
        near(now.focal.x, settled.focal.x, 0.0005) &&
        near(now.focal.y, settled.focal.y, 0.0005)
      );
    };
    while (!(await isSettled()) && undoPresses < 12) {
      await page.keyboard.press('Control+z');
      undoPresses += 1;
    }
    if (!(await isSettled())) throw new Error('Ctrl-Z did not put back the crop and focal point');
    // Let both cards' files catch up before going on.
    await settle(page);
    await waitForRendered(page, 2);
    feedSrc = await tileSrc(page, FEED_CARD);

    // 6. Reset crop.
    await page.getByRole('button', { name: 'Reset crop' }).click();
    feedSrc = await checkFile(
      'Reset crop returns the card to the automatic crop',
      FEED_CARD,
      FEED,
      feedSrc,
    );
    const reset = await shown(page);
    const resetDisabled = await page.getByRole('button', { name: 'Reset crop' }).isDisabled();
    check(
      'after Reset crop the crop is the automatic one and the button has nothing left to do',
      sameCrop(reset.crop, feedAuto) && resetDisabled,
      cropText(reset.crop),
    );

    // 6a. Closing puts the board back exactly where it was, and focus on the Open button: with
    //     the Close button, and with Esc.
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await settle(page);
    const closedY = await pageY(page);
    const closedFocus = await hasFocus(openFeed);
    await openFeed.click();
    await stage.waitFor({ timeout: 60_000 });
    await closeEditor(page);
    await settle(page);
    const escapedY = await pageY(page);
    const escapedFocus = await hasFocus(openFeed);
    check(
      'closing the dialog, with Close or with Esc, leaves the board at the same scroll position and focus on the Open button',
      closedY === boardY && escapedY === boardY && closedFocus && escapedFocus,
      `board at ${boardY} before; ${closedY} after Close (focus on Open: ${closedFocus}); ${escapedY} after Esc (focus on Open: ${escapedFocus})`,
    );

    // 6b. In a short window the dialog is taller than the window: it scrolls inside itself,
    //     and the board still does not move.
    await page.setViewportSize({ width: 1280, height: 480 });
    await openFeed.scrollIntoViewIfNeeded();
    await settle(page);
    const shortY = await pageY(page);
    await openFeed.click();
    await stage.waitFor({ timeout: 60_000 });
    const inside = () =>
      page.evaluate(() => {
        // The open one: the page also has the Settings dialog, closed, earlier in the page.
        const element = document.querySelector('dialog[open]');
        return { top: element.scrollTop, room: element.scrollHeight - element.clientHeight };
      });
    const insideBefore = await inside();
    await page.mouse.move(640, 240);
    await page.mouse.wheel(0, 120);
    await settle(page);
    const insideAfter = await inside();
    // Past the dialog's own end: the scroll must not carry on into the board.
    await page.mouse.wheel(0, 5000);
    await settle(page);
    await page.mouse.wheel(0, 5000);
    await settle(page);
    const insideEnd = await inside();
    const shortDuring = await pageY(page);
    await closeEditor(page);
    await settle(page);
    const shortAfter = await pageY(page);
    check(
      'a dialog taller than the window scrolls inside itself, and the board stays still',
      insideBefore.room > 0 &&
        insideBefore.top === 0 &&
        insideAfter.top > 0 &&
        insideEnd.top >= insideEnd.room - 1 &&
        shortDuring === shortY &&
        shortAfter === shortY,
      `dialog scrolled ${insideBefore.top} -> ${insideAfter.top} -> ${insideEnd.top} of ${insideEnd.room}; board at ${shortY}, ${shortDuring} while scrolling, ${shortAfter} after closing`,
    );
    await page.setViewportSize({ width: 1280, height: 900 });

    // 7. Adjust the square card by hand, so the focal move below must leave it alone.
    await openEditor(page, SQUARE_CARD);
    let squareSrc = await tileSrc(page, SQUARE_CARD);
    await clickCrop(page);
    await page.keyboard.press('ArrowRight');
    squareSrc = await nextRender(page, SQUARE_CARD, squareSrc);
    const squareAdjusted = (await shown(page)).crop;
    await closeEditor(page);

    // 8. Move the focal point from the feed card, which is on its automatic crop.
    await openEditor(page, FEED_CARD);
    await drag(page, 'focal-marker', -0.2, 0);
    feedSrc = await checkFile(
      'moving the focal point re-centres the card on its automatic crop',
      FEED_CARD,
      FEED,
      feedSrc,
    );
    const focused = await shown(page);
    const squareAfterMove = await tileSrc(page, SQUARE_CARD);
    check(
      'the automatic crop follows the focal point, and the hand-adjusted card is left alone',
      near(focused.focal.x, 0.3, 0.004) &&
        sameCrop(focused.crop, automatic(FEED, focused.focal)) &&
        squareAfterMove === squareSrc,
      `focal x ${focused.focal.x.toFixed(3)}; feed crop ${cropText(focused.crop)}; square file ${squareAfterMove === squareSrc ? 'unchanged' : 'made again'}`,
    );

    // 9. One Ctrl-Z reverses the focal point and the crop it changed, together.
    await page.keyboard.press('Control+z');
    feedSrc = await nextRender(page, FEED_CARD, feedSrc);
    const undone = await shown(page);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    const afterMore = await shown(page);
    const cardCount = await page.locator('article').count();
    check(
      'one Ctrl-Z puts back the focal point and the crop; further presses do nothing',
      near(undone.focal.x, 0.5, 0.002) &&
        sameCrop(undone.crop, feedAuto) &&
        sameCrop(afterMore.crop, feedAuto) &&
        near(afterMore.focal.x, 0.5, 0.002) &&
        cardCount === 2 &&
        (await tileSrc(page, SQUARE_CARD)) === squareSrc,
      `focal x ${undone.focal.x.toFixed(3)}; crop ${cropText(undone.crop)}; ${cardCount} cards`,
    );

    // 10. Move it again, also down, and save: the session file holds the point and both crops.
    await drag(page, 'focal-marker', -0.2, 0.2);
    feedSrc = await nextRender(page, FEED_CARD, feedSrc);
    const kept = await shown(page);
    await closeEditor(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download .scs' }).click(),
    ]);
    const bundlePath = join(outDir, `${name}-session.scs`);
    await download.saveAs(bundlePath);
    const zip = await JSZip.loadAsync(readFileSync(bundlePath));
    const saved = JSON.parse(await zip.file('session.json').async('string'));
    const savedFocal = saved.assets[0].focal;
    const savedCrop = (placement) => saved.cards.find((c) => c.placement === placement).edit.crop;
    const savedOk =
      near(savedFocal.x, kept.focal.x, 0.002) &&
      near(savedFocal.y, 0.7, 0.004) &&
      sameCrop(savedCrop('feed-vertical'), kept.crop) &&
      sameCrop(savedCrop('image-square'), squareAdjusted);

    await page.getByRole('button', { name: 'Clear session' }).click();
    await page.getByText('No session is open.').waitFor();
    await page.getByLabel('Session bundle file').setInputFiles(bundlePath);
    await page
      .getByRole('status')
      .filter({ hasText: /^Opened / })
      .first()
      .waitFor();
    await waitForRendered(page, 2);
    const reloadedFeed = await inspect(page, await tileSrc(page, FEED_CARD));
    const reloadedSquare = await inspect(page, await tileSrc(page, SQUARE_CARD));
    await openEditor(page, FEED_CARD);
    const reopened = await shown(page);
    await closeEditor(page);
    check(
      'Download .scs, Clear, Load .scs: the focal point and both crops come back',
      savedOk &&
        sameCrop(reopened.crop, kept.crop) &&
        near(reopened.focal.x, kept.focal.x, 0.002) &&
        near(reopened.focal.y, kept.focal.y, 0.002) &&
        meets(reloadedFeed, kept.crop) &&
        meets(reloadedSquare, squareAdjusted) &&
        reloadedFeed.width === FEED.width &&
        reloadedSquare.width === SQUARE.width &&
        reloadedSquare.height === SQUARE.height,
      `saved focal ${savedFocal.x.toFixed(3)}, ${savedFocal.y.toFixed(3)}; feed crop ${cropText(reopened.crop)}; square crop ${cropText(savedCrop('image-square'))}`,
    );

    // 11. Duplicate the feed card. The copy starts where its source is and has its own point.
    const sharedPoint = kept.focal;
    const feedKept = kept.crop;
    feedSrc = await tileSrc(page, FEED_CARD);
    squareSrc = await tileSrc(page, SQUARE_CARD);
    await page.getByRole('button', { name: `Duplicate ${FEED_CARD}`, exact: true }).click();
    await waitForRendered(page, 3);
    let copySrc = await tileSrc(page, COPY_CARD);
    const copyFile = await inspect(page, copySrc);
    await openEditor(page, FEED_CARD);
    const sourceSays = await shown(page);
    await closeEditor(page);
    await openEditor(page, COPY_CARD);
    const copyStart = await shown(page);
    await closeEditor(page);
    check(
      'a duplicate starts on the same crop and point as its source, and says the point is its own',
      sameCrop(copyStart.crop, feedKept) &&
        near(copyStart.focal.x, sharedPoint.x, 0.002) &&
        near(copyStart.focal.y, sharedPoint.y, 0.002) &&
        meets(copyFile, feedKept) &&
        copyStart.label.startsWith("This card's own focal point on ") &&
        copyStart.kind.startsWith('This card has its own focal point.') &&
        sourceSays.label.startsWith('Focal point of ') &&
        sourceSays.kind.startsWith("This card uses the photo's focal point.") &&
        // Opening and closing either card wrote nothing: no file was made again.
        (await tileSrc(page, COPY_CARD)) === copySrc &&
        (await tileSrc(page, FEED_CARD)) === feedSrc &&
        (await tileSrc(page, SQUARE_CARD)) === squareSrc,
      `duplicate: "${copyStart.kind}" source: "${sourceSays.kind}"`,
    );

    // 12. Move the duplicate's point. Only the duplicate changes.
    await openEditor(page, COPY_CARD);
    await drag(page, 'focal-marker', 0.3, 0);
    copySrc = await checkFile(
      "moving a duplicate's focal point re-centres the duplicate on its automatic crop",
      COPY_CARD,
      FEED,
      copySrc,
    );
    const copyMoved = await shown(page);
    const othersAfterCopyMove =
      (await tileSrc(page, FEED_CARD)) === feedSrc &&
      (await tileSrc(page, SQUARE_CARD)) === squareSrc;

    // 13. One Ctrl-Z reverses that move: the point and the crop together, and nothing else.
    await page.keyboard.press('Control+z');
    copySrc = await nextRender(page, COPY_CARD, copySrc);
    const copyUndone = await shown(page);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    const copyAfterMore = await shown(page);
    const cardsAfterUndo = await page.locator('article').count();
    check(
      "one Ctrl-Z puts back a duplicate's focal point and crop; further presses do nothing",
      near(copyUndone.focal.x, sharedPoint.x, 0.002) &&
        sameCrop(copyUndone.crop, feedKept) &&
        near(copyAfterMore.focal.x, sharedPoint.x, 0.002) &&
        sameCrop(copyAfterMore.crop, feedKept) &&
        cardsAfterUndo === 3 &&
        (await tileSrc(page, FEED_CARD)) === feedSrc &&
        (await tileSrc(page, SQUARE_CARD)) === squareSrc,
      `focal x ${copyUndone.focal.x.toFixed(3)}; crop ${cropText(copyUndone.crop)}; ${cardsAfterUndo} cards`,
    );

    // Move it again and leave it there, then look at the original.
    await drag(page, 'focal-marker', 0.3, 0);
    copySrc = await nextRender(page, COPY_CARD, copySrc);
    const copyKept = await shown(page);
    await closeEditor(page);
    await openEditor(page, FEED_CARD);
    const sourceAfter = await shown(page);
    check(
      "moving a duplicate's focal point leaves the original and the photo's other card alone",
      near(copyMoved.focal.x, sharedPoint.x + 0.3, 0.004) &&
        sameCrop(copyMoved.crop, automatic(FEED, copyMoved.focal)) &&
        !sameCrop(copyMoved.crop, feedKept) &&
        othersAfterCopyMove &&
        near(sourceAfter.focal.x, sharedPoint.x, 0.002) &&
        near(sourceAfter.focal.y, sharedPoint.y, 0.002) &&
        sameCrop(sourceAfter.crop, feedKept) &&
        (await tileSrc(page, FEED_CARD)) === feedSrc &&
        (await tileSrc(page, SQUARE_CARD)) === squareSrc,
      `duplicate focal x ${copyMoved.focal.x.toFixed(3)}, crop ${cropText(copyMoved.crop)}; original focal x ${sourceAfter.focal.x.toFixed(3)}, crop ${cropText(sourceAfter.crop)}; other files ${othersAfterCopyMove ? 'unchanged' : 'made again'}`,
    );

    // 14. Move the photo's point from the original. The duplicate does not move.
    await drag(page, 'focal-marker', 0.1, -0.2);
    feedSrc = await checkFile(
      "moving the photo's focal point still re-centres the original",
      FEED_CARD,
      FEED,
      feedSrc,
    );
    const sourceMoved = await shown(page);
    const copyAfterSourceMove = (await tileSrc(page, COPY_CARD)) === copySrc;

    // 15. One Ctrl-Z reverses the photo's move; the duplicate is where it was throughout.
    await page.keyboard.press('Control+z');
    feedSrc = await nextRender(page, FEED_CARD, feedSrc);
    const sourceUndone = await shown(page);
    const copyAfterSourceUndo = (await tileSrc(page, COPY_CARD)) === copySrc;
    await closeEditor(page);
    await openEditor(page, COPY_CARD);
    const copyAfter = await shown(page);
    await closeEditor(page);
    check(
      "moving the photo's focal point leaves the duplicate alone, and so does the Ctrl-Z of it",
      near(sourceMoved.focal.x, sharedPoint.x + 0.1, 0.004) &&
        near(sourceMoved.focal.y, sharedPoint.y - 0.2, 0.004) &&
        sameCrop(sourceMoved.crop, automatic(FEED, sourceMoved.focal)) &&
        copyAfterSourceMove &&
        near(sourceUndone.focal.x, sharedPoint.x, 0.002) &&
        near(sourceUndone.focal.y, sharedPoint.y, 0.002) &&
        sameCrop(sourceUndone.crop, feedKept) &&
        copyAfterSourceUndo &&
        near(copyAfter.focal.x, copyKept.focal.x, 0.002) &&
        near(copyAfter.focal.y, copyKept.focal.y, 0.002) &&
        sameCrop(copyAfter.crop, copyKept.crop) &&
        (await tileSrc(page, SQUARE_CARD)) === squareSrc,
      `original focal ${sourceMoved.focal.x.toFixed(3)}, ${sourceMoved.focal.y.toFixed(3)} then ${sourceUndone.focal.x.toFixed(3)}, ${sourceUndone.focal.y.toFixed(3)}; duplicate focal x ${copyAfter.focal.x.toFixed(3)}, file ${copyAfterSourceMove && copyAfterSourceUndo ? 'unchanged' : 'made again'}`,
    );

    // 16. Save and reload: only the duplicate has a point of its own in the file, and it is kept.
    const [copyDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download .scs' }).click(),
    ]);
    const copyBundlePath = join(outDir, `${name}-session-with-duplicate.scs`);
    await copyDownload.saveAs(copyBundlePath);
    const copyZip = await JSZip.loadAsync(readFileSync(copyBundlePath));
    const withCopy = JSON.parse(await copyZip.file('session.json').async('string'));
    const savedCopy = withCopy.cards.find((c) => c.parentId !== undefined);
    const savedShared = withCopy.cards.filter((c) => c.parentId === undefined);
    const savedCopyOk =
      withCopy.cards.length === 3 &&
      savedCopy !== undefined &&
      savedCopy.focal !== undefined &&
      near(savedCopy.focal.x, copyKept.focal.x, 0.002) &&
      near(savedCopy.focal.y, copyKept.focal.y, 0.002) &&
      sameCrop(savedCopy.edit.crop, copyKept.crop) &&
      savedShared.length === 2 &&
      savedShared.every((c) => !Object.hasOwn(c, 'focal')) &&
      near(withCopy.assets[0].focal.x, sharedPoint.x, 0.002) &&
      near(withCopy.assets[0].focal.y, sharedPoint.y, 0.002);

    await page.getByRole('button', { name: 'Clear session' }).click();
    await page.getByText('No session is open.').waitFor();
    await page.getByLabel('Session bundle file').setInputFiles(copyBundlePath);
    await page
      .getByRole('status')
      .filter({ hasText: /^Opened / })
      .first()
      .waitFor();
    await waitForRendered(page, 3);
    const reloadedCopy = await inspect(page, await tileSrc(page, COPY_CARD));
    const reloadedSource = await inspect(page, await tileSrc(page, FEED_CARD));
    await openEditor(page, COPY_CARD);
    const copyReopened = await shown(page);
    await closeEditor(page);
    await openEditor(page, FEED_CARD);
    const sourceReopened = await shown(page);
    await closeEditor(page);
    check(
      "Download .scs, Clear, Load .scs: the duplicate's own focal point comes back, and only it has one",
      savedCopyOk &&
        near(copyReopened.focal.x, copyKept.focal.x, 0.002) &&
        near(copyReopened.focal.y, copyKept.focal.y, 0.002) &&
        sameCrop(copyReopened.crop, copyKept.crop) &&
        copyReopened.kind.startsWith('This card has its own focal point.') &&
        meets(reloadedCopy, copyKept.crop) &&
        near(sourceReopened.focal.x, sharedPoint.x, 0.002) &&
        near(sourceReopened.focal.y, sharedPoint.y, 0.002) &&
        sameCrop(sourceReopened.crop, feedKept) &&
        sourceReopened.kind.startsWith("This card uses the photo's focal point.") &&
        meets(reloadedSource, feedKept),
      `saved duplicate focal ${savedCopy?.focal ? `${savedCopy.focal.x.toFixed(3)}, ${savedCopy.focal.y.toFixed(3)}` : 'missing'}; cards with their own point in the file: ${withCopy.cards.filter((c) => Object.hasOwn(c, 'focal')).length} of ${withCopy.cards.length}; photo focal ${withCopy.assets[0].focal.x.toFixed(3)}, ${withCopy.assets[0].focal.y.toFixed(3)}`,
    );

    // 17. File type and quality, on the square card, all in one opening of its dialog.
    const dialog = page.getByRole('dialog');
    const jpgRadio = dialog.getByRole('radio', { name: 'JPG' });
    const pngRadio = dialog.getByRole('radio', { name: 'PNG' });
    const slider = dialog.getByRole('slider', { name: 'Quality' });
    const qualityLine = () => dialog.getByText(/^Quality: \d+%$/).innerText();
    const caption = dialog.getByRole('region', { name: 'Rendered file' }).locator('figcaption');
    /** Waits for the dialog's caption to describe the card's newest file, and returns it. */
    async function captionFor(file) {
      const type = file.type === 'png' ? 'PNG' : 'JPG';
      await caption
        .filter({ hasText: `${file.width} × ${file.height} ${type} · ` })
        .waitFor({ timeout: 60_000 });
      return caption.innerText();
    }
    squareSrc = await tileSrc(page, SQUARE_CARD);
    await openEditor(page, SQUARE_CARD);

    // 17a. Clicking the file type the card already has is not a change: no undo step.
    const squareBefore = (await shown(page)).crop;
    await tabTo(page, page.getByRole('application'), 'the crop area');
    await page.keyboard.press('Shift+ArrowLeft');
    if (sameCrop((await shown(page)).crop, squareBefore)) {
      await page.keyboard.press('Shift+ArrowRight');
    }
    const squareMoved = (await shown(page)).crop;
    squareSrc = await nextRender(page, SQUARE_CARD, squareSrc);
    const wasJpg = await jpgRadio.isChecked();
    await jpgRadio.click();
    await page.keyboard.press('Control+z');
    const squareUndone = (await shown(page)).crop;
    squareSrc = await nextRender(page, SQUARE_CARD, squareSrc);
    check(
      'clicking the file type the card already has adds no undo step: one Ctrl-Z then undoes the crop move before it',
      wasJpg &&
        (await jpgRadio.isChecked()) &&
        !sameCrop(squareMoved, squareBefore) &&
        sameCrop(squareUndone, squareBefore),
      `before ${cropText(squareBefore)}; moved ${cropText(squareMoved)}; after Ctrl-Z ${cropText(squareUndone)}`,
    );

    // 17b. PNG: the card is made again as a PNG at its size, and the caption says so.
    await pngRadio.check();
    squareSrc = await nextRender(page, SQUARE_CARD, squareSrc);
    const pngFile = await inspect(page, squareSrc);
    const pngCaption = await captionFor(pngFile);
    const pngNote = await dialog
      .getByText('PNG files are lossless, so there is no quality setting.')
      .isVisible();
    check(
      'choosing PNG makes the card again as a PNG at its size from platforms.json; the caption says PNG',
      pngFile.type === 'png' &&
        pngFile.width === SQUARE.width &&
        pngFile.height === SQUARE.height &&
        meets(pngFile, squareBefore) &&
        pngCaption.startsWith(`${SQUARE.width} × ${SQUARE.height} PNG · `) &&
        pngNote &&
        (await slider.count()) === 0,
      `${describeFile(pngFile, squareBefore)}; caption "${pngCaption}"; note ${pngNote}`,
    );

    // 17c. One Ctrl-Z, with focus on the PNG radio, goes back to JPG at the quality it had.
    //      Focus is there because the radio was just clicked.
    const onPngRadio = await hasFocus(pngRadio);
    await page.keyboard.press('Control+z');
    squareSrc = await nextRender(page, SQUARE_CARD, squareSrc);
    const backFile = await inspect(page, squareSrc);
    const backCaption = await captionFor(backFile);
    check(
      'one Ctrl-Z on the PNG radio goes back to JPG at 90%, made again as a JPG',
      onPngRadio &&
        backFile.type === 'jpeg' &&
        (await jpgRadio.isChecked()) &&
        (await qualityLine()) === 'Quality: 90%' &&
        backCaption.startsWith(`${SQUARE.width} × ${SQUARE.height} JPG · `),
      `${backFile.type} ${backFile.width} × ${backFile.height}; ${await qualityLine()}; caption "${backCaption}"`,
    );

    // The slider's own position for a percentage, for the drags below.
    await slider.scrollIntoViewIfNeeded();
    const track = await slider.boundingBox();
    const trackY = track.y + track.height / 2;
    // The thumb's centre runs from half a thumb in from each end; Chromium's is 16 px wide.
    const trackX = (percent) => track.x + 8 + (track.width - 16) * ((percent - 10) / 90);
    await page.evaluate(() => {
      window.__pointerTypes = [];
      window.addEventListener(
        'pointerdown',
        (event) => window.__pointerTypes.push(event.pointerType),
        true,
      );
    });

    // 17d. A mouse drag is one undo step, written on release.
    await page.mouse.move(trackX(90), trackY);
    await page.mouse.down();
    await page.mouse.move(trackX(60), trackY, { steps: 6 });
    const mouseDuring = await qualityLine();
    await page.mouse.move(trackX(40), trackY, { steps: 6 });
    await page.mouse.up();
    const mouseAfter = await qualityLine();
    squareSrc = await nextRender(page, SQUARE_CARD, squareSrc);
    const lowFile = await inspect(page, squareSrc);
    await page.keyboard.press('Control+z');
    const mouseUndone = await qualityLine();
    squareSrc = await nextRender(page, SQUARE_CARD, squareSrc);
    check(
      'a mouse drag on the quality slider shows the value as it moves and is one undo step',
      mouseDuring !== 'Quality: 90%' &&
        mouseAfter !== 'Quality: 90%' &&
        mouseAfter !== mouseDuring &&
        lowFile.type === 'jpeg' &&
        lowFile.bytes < backFile.bytes &&
        mouseUndone === 'Quality: 90%',
      `during "${mouseDuring}", after "${mouseAfter}" (${lowFile.bytes} bytes against ${backFile.bytes} at 90%), after one Ctrl-Z "${mouseUndone}"`,
    );

    // 17e. A touch drag, sent as real touch input, is one undo step too. It goes through the
    //      DevTools protocol because Playwright's mouse cannot make a touch; the browser still
    //      turns it into its own pointer events, which is what is checked below.
    const cdp = await context.newCDPSession(page);
    const touch = (type, x) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y: trackY }],
      });
    await touch('touchStart', trackX(90));
    for (let i = 1; i <= 8; i++) await touch('touchMove', trackX(90 - (55 * i) / 8));
    const touchDuring = await qualityLine();
    await touch('touchEnd');
    const touchAfter = await qualityLine();
    squareSrc = await nextRender(page, SQUARE_CARD, squareSrc);
    await page.keyboard.press('Control+z');
    const touchUndone = await qualityLine();
    squareSrc = await nextRender(page, SQUARE_CARD, squareSrc);
    const pointerTypes = await page.evaluate(() => window.__pointerTypes);
    check(
      'a touch drag on the quality slider is one undo step',
      pointerTypes.at(-1) === 'touch' &&
        touchDuring === 'Quality: 35%' &&
        touchAfter === 'Quality: 35%' &&
        touchUndone === 'Quality: 90%',
      `pointer types ${pointerTypes.join(', ')}; during "${touchDuring}", after "${touchAfter}", after one Ctrl-Z "${touchUndone}"`,
    );

    // 17f. A key held down is one undo step; with nothing left, Ctrl-Z changes nothing.
    //      The slider is reached with Tab from the JPG choice, which is clicked first (it is
    //      already chosen, so the click changes nothing).
    await jpgRadio.click();
    await tabTo(page, slider, 'the quality slider');
    for (let i = 0; i < 3; i++) await page.keyboard.down('ArrowLeft');
    const heldDuring = await qualityLine();
    await page.keyboard.up('ArrowLeft');
    squareSrc = await nextRender(page, SQUARE_CARD, squareSrc);
    await page.keyboard.press('Control+z');
    const heldUndone = await qualityLine();
    squareSrc = await nextRender(page, SQUARE_CARD, squareSrc);
    await page.keyboard.press('Control+z');
    const spareCrop = (await shown(page)).crop;
    check(
      'a held arrow key on the slider is one undo step; once the dialog’s steps are used up, Ctrl-Z changes nothing',
      heldDuring === 'Quality: 87%' &&
        heldUndone === 'Quality: 90%' &&
        (await qualityLine()) === 'Quality: 90%' &&
        (await jpgRadio.isChecked()) &&
        sameCrop(spareCrop, squareBefore),
      `held "${heldDuring}", after one Ctrl-Z "${heldUndone}", after another "${await qualityLine()}", crop ${cropText(spareCrop)}`,
    );
    await closeEditor(page);

    // 18. The dialog keeps its size while the card is rendered again: its height, where the
    //     crop area is and where the Close button is are measured on every animation frame
    //     while the crop changes, and each must stay within 1 px of where it was before. The
    //     crop is made small first, so the file is enlarged to fit and the note about it shows.
    //     Each run holds one render back with the worker-message hold (e2e/workerHold.mjs):
    //     a render can finish within a frame or two, so without the hold the state while a
    //     file is being made might never be measured. The crop is then changed again without
    //     the hold, so renders that finish while the crop moves are measured too.
    await openEditor(page, FEED_CARD);
    await clickCrop(page);
    for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+Minus');
    const dialogBox = page.getByRole('dialog');
    const enlargedNote = dialogBox.getByText(/^Note: enlarged to fit\./);
    const allRendered = () =>
      renderProgress(page)
        .filter({ hasText: /^Rendered \d+ cards?: / })
        .waitFor({ timeout: 60_000 });
    await enlargedNote.waitFor({ timeout: 60_000 });
    await allRendered();
    const PROBES = {
      'dialog height': { selector: 'dialog[open]', edge: 'height' },
      'crop area top': { selector: 'dialog[open] [role=application]', edge: 'top' },
      'crop area left': { selector: 'dialog[open] [role=application]', edge: 'left' },
      'Close top': { selector: 'dialog[open] button', text: 'Close', edge: 'top' },
      'Close left': { selector: 'dialog[open] button', text: 'Close', edge: 'left' },
    };
    const WATCHES = { 'a file being made': 'dialog[open] [role=progressbar]' };
    /** Samples while `change` runs: first with one render held, then with renders let through. */
    const sampleWhile = async (change) => {
      await allRendered();
      await page.waitForTimeout(300);
      const noteBefore = await enlargedNote.isVisible();
      await startSampling(page, PROBES, WATCHES);
      await holdRenders(page);
      await change(1);
      await waitForHeld(page);
      // Held in the updating state for a while, so several frames measure it.
      await page.waitForTimeout(400);
      await releaseRenders(page);
      await change(-1);
      await allRendered();
      await page.waitForTimeout(300);
      const result = await stopSampling(page);
      return { result, notes: noteBefore && (await enlargedNote.isVisible()) };
    };
    /** A held arrow key: repeated key-downs with one key-up, as a key held down sends them. */
    const holdArrow = async (direction) => {
      const key = direction > 0 ? 'ArrowRight' : 'ArrowLeft';
      for (let i = 0; i < 8; i++) {
        await page.keyboard.down(key);
        await page.waitForTimeout(30);
      }
      await page.keyboard.up(key);
    };
    /** A mouse drag of the crop, in steps, from a point clear of the marker and the corners. */
    const dragCrop = async (direction) => {
      const start = await cropPoint(page);
      const frame = await page.getByTestId('crop-frame').boundingBox();
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(start.x + direction * i * frame.width * 0.01, start.y);
        await page.waitForTimeout(30);
      }
      await page.mouse.up();
    };
    const steadyTitle = (how, size) =>
      `the dialog keeps its height, and the crop area and the Close button stay put, while ${how} and its render is held and let through (${size}, with the enlarged-to-fit note)`;
    const sizes = [
      ['1280 × 900, editor beside the details', { width: 1280, height: 900 }],
      ['900 × 900, editor above the details', { width: 900, height: 900 }],
    ];
    for (const [sizeName, viewport] of sizes) {
      await page.setViewportSize(viewport);
      // A real click in the crop gives the crop area focus; it changes nothing.
      await clickCrop(page);
      const keys = await sampleWhile(holdArrow);
      check(
        steadyTitle('an arrow key held on the crop area moves the crop', sizeName),
        steady(keys.result) && keys.result.seen['a file being made'] && keys.notes,
        `${describeSampling(keys.result)}; note shown before and after: ${keys.notes}`,
      );
      const drags = await sampleWhile(dragCrop);
      check(
        steadyTitle('a mouse drag moves the crop', sizeName),
        steady(drags.result) && drags.result.seen['a file being made'] && drags.notes,
        `${describeSampling(drags.result)}; note shown before and after: ${drags.notes}`,
      );
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await closeEditor(page);

    // 19. With scrollbars that take up room (this browser is started with them; the one above
    //     hides them), opening and closing the dialog does not move the board sideways.
    const wide = await scrollbarBrowser.newContext({ viewport: { width: 1280, height: 600 } });
    try {
      const other = await wide.newPage();
      await startSession(other, url);
      const firstCard = () =>
        other.evaluate(() => ({
          x: document.querySelector('article').getBoundingClientRect().x,
          scrollbar: window.innerWidth - document.documentElement.clientWidth,
        }));
      const sideBefore = await firstCard();
      await openEditor(other, FEED_CARD);
      const sideOpen = await firstCard();
      await closeEditor(other);
      // The page is let go by the dialog's close event, which the browser sends a moment after
      // the dialog is hidden. Until then the page is still locked and its scrollbar measures
      // as no width at all, so the measurement waits for the page to be let go.
      await other.waitForFunction(() => document.documentElement.style.overflow !== 'hidden');
      const sideAfter = await firstCard();
      check(
        'with scrollbars that take up room, opening and closing the dialog does not move the board sideways',
        sideBefore.scrollbar > 0 &&
          sideOpen.x === sideBefore.x &&
          sideAfter.x === sideBefore.x &&
          sideAfter.scrollbar === sideBefore.scrollbar,
        `scrollbar ${sideBefore.scrollbar}px wide; first card's x ${sideBefore.x} before, ${sideOpen.x} open, ${sideAfter.x} after`,
      );
    } finally {
      await wide.close();
    }

    // 20. Network and console.
    const outside = requests.filter((r) => !r.url.startsWith(url) && !/^(blob|data):/.test(r.url));
    check(
      `every request stays under ${url}`,
      outside.length === 0,
      `${requests.length} requests${outside.length ? `; outside: ${outside.map((r) => r.url).join(', ')}` : ''}`,
    );
    check('no failed requests and no console errors', problems.length === 0, problems.join(' | '));

    writeFileSync(
      join(outDir, `${name}-report.json`),
      JSON.stringify({ checks, requests, problems }, null, 2),
    );
    await openEditor(page, FEED_CARD);
    await page.getByRole('dialog').screenshot({ path: join(outDir, `${name}-editor.png`) });
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

// --------------------------------------------------------------------------- padding

/**
 * The colour typed into the hex box, as typed (capitals, no "#") and as the app stores it. It
 * is at least 128 away, in some channel, from each of the four colours of the test photo, so no
 * pixel of the photo can pass for padding.
 */
const TYPED_COLOUR = '00E5FF';
const COLOUR = '#00e5ff';
const COLOUR_CSS = 'rgb(0, 229, 255)';
const WHITE = '#ffffff';
/**
 * How long to wait for a control that only this feature has. Short, so a version of the app
 * without it fails that step quickly and by name; every other wait keeps its usual time.
 */
const NEW_CONTROL_MS = 5_000;

/** The whole photo in an output's shape, centred: the same rule as the app's, worked out here. */
function fitWhole(target) {
  const ratio = target.width / target.height;
  const wide = SOURCE.width / SOURCE.height > ratio;
  const width = wide ? 1 : (SOURCE.height * ratio) / SOURCE.width;
  const height = wide ? SOURCE.width / ratio / SOURCE.height : 1;
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

/** The corner target's size for a crop whose shorter side on screen is `side`: the app's rule. */
const cornerTarget = (side) => Math.min(44, Math.max(24, side / 3));

async function runPadding(browser, name, url) {
  console.log(`\n== Editor check, padding and background colour: ${name} (${url})`);
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  });
  const problems = [];
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

  const dialog = page.getByRole('dialog');
  const stage = dialog.getByRole('application');
  const fitButton = dialog.getByRole('button', { name: 'Fit whole photo', exact: true });
  const resetButton = dialog.getByRole('button', { name: 'Reset crop', exact: true });
  const picker = dialog.getByLabel('Background colour picker');
  const hex = dialog.getByRole('textbox', { name: 'Hex code' });
  const FIT = fitWhole(FEED);
  const AUTO = automatic(FEED, { x: 0.5, y: 0.5 });
  const paddingStyle = () =>
    dialog
      .getByTestId('crop-padding')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  const boxOf = (testId) => dialog.getByTestId(testId).boundingBox();
  const cardCount = () => page.locator('article').count();
  /** The open card's file once it has been made again, measured for padding in `colour`. */
  const fileAfter = async (cardLabel, previous, crop, colour) => {
    const src = await nextRender(page, cardLabel, previous);
    return { src, report: await measurePadding(page, { url: src }, crop, rgbOf(colour)) };
  };
  /** What Tab reaches in the dialog, from its heading to Close, each named by what it is. */
  const tabOrder = async () => {
    // A real click on the heading puts focus where it is when the dialog opens.
    await dialog.getByRole('heading', { level: 2 }).click();
    const order = [];
    for (let presses = 0; presses < 24; presses++) {
      await page.keyboard.press('Tab');
      const reached = await page.evaluate(() => {
        const element = document.activeElement;
        if (element.getAttribute('role') === 'application') return 'crop area';
        if (element.dataset.testid === 'focal-marker') return 'focal point';
        if (element.tagName === 'TEXTAREA') return element.labels?.[0]?.textContent ?? 'text box';
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
        // The Copy buttons all say "Copy"; their accessible names tell them apart.
        return element.getAttribute('aria-label') ?? element.textContent.trim();
      });
      order.push(reached);
      if (reached === 'Close') break;
    }
    return order;
  };
  const focusCrop = async () => {
    // Tab through the whole dialog leaves it scrolled down to Close, past the caption boxes, so
    // the crop area is scrolled back into view first, as a person would, before it is clicked.
    await dialog.getByRole('application').scrollIntoViewIfNeeded();
    await clickCrop(page);
  };
  const undo = () => page.keyboard.press('Control+z');

  try {
    await startSession(page, url);
    let feedSrc = await tileSrc(page, FEED_CARD);
    await openEditor(page, FEED_CARD);
    const sizes = { dialog: [], area: [] };
    const measureLayout = async () => {
      const box = await dialog.boundingBox();
      const area = await stage.boundingBox();
      sizes.dialog.push(`${box.width} × ${box.height}`);
      sizes.area.push(`${area.width} × ${area.height}`);
    };
    await measureLayout();

    // 1. The Tab order of the dialog, on a new card: Reset crop is disabled, so Tab passes it.
    await step('the Tab order of the card dialog is the one in the spec', async (title) => {
      const fresh = await tabOrder();
      await focusCrop();
      await page.keyboard.press('ArrowRight');
      feedSrc = await nextRender(page, FEED_CARD, feedSrc);
      const moved = await tabOrder();
      await focusCrop();
      await undo();
      feedSrc = await nextRender(page, FEED_CARD, feedSrc);
      const rest = [
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
        'Close',
      ];
      const want = ['crop area', 'focal point', ...rest];
      const wantMoved = ['crop area', 'focal point', 'Reset crop', ...rest];
      check(
        title,
        JSON.stringify(fresh) === JSON.stringify(want) &&
          JSON.stringify(moved) === JSON.stringify(wantMoved),
        `new card: ${fresh.join(' → ')}; after moving the crop: ${moved.join(' → ')}`,
      );
    });

    // 2. A corner dragged far past the photo's edge: the crop stops at the fit size, centred.
    await step(
      "a corner dragged past the photo's edge stops at the fit size, with padding",
      async (title) => {
        await drag(page, 'crop-handle-se', 1.5, 1.5);
        await settle(page);
        const first = (await shown(page)).crop;
        if (!sameCrop(first, FIT)) {
          // Said here, before waiting for a file that a crop that did not grow would not make.
          check(
            title,
            false,
            `the corner stopped at ${cropText(first)}, not at the fit size ${cropText(FIT)}`,
          );
          return;
        }
        const { src, report } = await fileAfter(FEED_CARD, feedSrc, FIT, WHITE);
        feedSrc = src;
        // Dragged further still, it does not move.
        await drag(page, 'crop-handle-se', 0.5, 0.5);
        await settle(page);
        const second = (await shown(page)).crop;
        check(
          title,
          sameCrop(first, FIT) &&
            sameCrop(second, FIT) &&
            (await tileSrc(page, FEED_CARD)) === feedSrc &&
            report.width === FEED.width &&
            report.height === FEED.height &&
            paddingOk(report, { photoMayMatch: true }),
          `crop ${cropText(first)}, then ${cropText(second)} (fit size ${cropText(FIT)}); ${describePadding(report)}`,
        );
        await focusCrop();
        await undo();
        feedSrc = await nextRender(page, FEED_CARD, feedSrc);
      },
    );

    // 3. The corner targets: 44 px on a crop of normal size, smaller on the smallest crop, where
    //    a press in the middle of the crop moves it and a press on a corner target resizes it.
    await step(
      'on the smallest crop the corner targets shrink: a press in the middle moves it, a press on a corner resizes it',
      async (title) => {
        const normal = await boxOf('crop-handle-se');
        await focusCrop();
        for (let presses = 0; presses < 9; presses++) await page.keyboard.press('Shift+Minus');
        // Away from the focal point's marker, which sits in the middle of the photo and would
        // otherwise be what a press in the middle of this small crop lands on.
        for (let presses = 0; presses < 3; presses++) await page.keyboard.press('Shift+ArrowLeft');
        for (let presses = 0; presses < 2; presses++) await page.keyboard.press('Shift+ArrowUp');
        await settle(page);
        const small = await boxOf('crop-rect');
        const target = await boxOf('crop-handle-se');
        const wanted = cornerTarget(Math.min(small.width, small.height));
        const before = (await shown(page)).crop;
        // The middle of the crop, which the corner targets leave free.
        const middle = { x: small.x + small.width / 2, y: small.y + small.height / 2 };
        await page.mouse.move(middle.x, middle.y);
        await page.mouse.down();
        await page.mouse.move(middle.x + 30, middle.y, { steps: 5 });
        await page.mouse.up();
        await settle(page);
        const moved = (await shown(page)).crop;
        // The outer part of the south-east corner's target, outside the crop itself.
        const corner = await boxOf('crop-handle-se');
        const outer = { x: corner.x + corner.width - 4, y: corner.y + corner.height - 4 };
        await page.mouse.move(outer.x, outer.y);
        await page.mouse.down();
        await page.mouse.move(outer.x + 40, outer.y + 50, { steps: 5 });
        await page.mouse.up();
        await settle(page);
        const resized = (await shown(page)).crop;
        check(
          title,
          near(normal.width, 44, 0.5) &&
            near(normal.height, 44, 0.5) &&
            wanted < 44 &&
            near(target.width, wanted, 0.5) &&
            near(target.height, wanted, 0.5) &&
            Math.min(small.width, small.height) - target.width >= 24 &&
            moved.x > before.x + 0.02 &&
            near(moved.width, before.width, 0.002) &&
            near(moved.y, before.y, 0.002) &&
            resized.width > moved.width + 0.02 &&
            near(resized.x, moved.x, 0.004),
          `targets ${normal.width.toFixed(1)} px on the automatic crop and ${target.width.toFixed(1)} px ` +
            `on a ${small.width.toFixed(1)} × ${small.height.toFixed(1)} px crop (rule gives ${wanted.toFixed(1)}); ` +
            `crop ${cropText(before)}, after the middle press ${cropText(moved)}, after the corner press ${cropText(resized)}`,
        );
        await resetButton.click();
        await settle(page);
        feedSrc = await tileSrc(page, FEED_CARD);
      },
    );

    // The steps from here count the dialog's own undo steps, so start a dialog with none.
    await closeEditor(page);
    await waitForRendered(page, 2);
    feedSrc = await tileSrc(page, FEED_CARD);
    await openEditor(page, FEED_CARD);

    // 4. Fit whole photo, reached with Tab and pressed from the keyboard.
    await step(
      'Tab reaches Fit whole photo; Enter shows the whole photo with white padding',
      async (title) => {
        await fitButton.waitFor({ timeout: NEW_CONTROL_MS });
        feedSrc = await tileSrc(page, FEED_CARD);
        await dialog.getByRole('heading', { level: 2 }).click();
        const presses = await tabTo(page, fitButton, 'the Fit whole photo button');
        await page.keyboard.press('Enter');
        const { src, report } = await fileAfter(FEED_CARD, feedSrc, FIT, WHITE);
        feedSrc = src;
        const { crop } = await shown(page);
        await measureLayout();
        check(
          title,
          sameCrop(crop, FIT) &&
            (await paddingStyle()) === 'rgb(255, 255, 255)' &&
            paddingOk(report, { photoMayMatch: true }),
          `${presses} Tab presses; crop ${cropText(crop)}; ${describePadding(report)}`,
        );
      },
    );

    // 5. A colour typed into the hex box, reached with Tab from the Fit whole photo button.
    await step(
      'a colour typed into the hex box shows in the editor and in the rendered file',
      async (title) => {
        await hex.waitFor({ timeout: NEW_CONTROL_MS });
        await dialog.getByRole('heading', { level: 2 }).click();
        await tabTo(page, hex, 'the hex box');
        await page.keyboard.press('Control+a');
        await page.keyboard.type(TYPED_COLOUR);
        await page.keyboard.press('Enter');
        const { src, report } = await fileAfter(FEED_CARD, feedSrc, FIT, COLOUR);
        feedSrc = src;
        // The preview in the dialog is the same file as the board's tile.
        const preview = await dialog.locator('figure img').getAttribute('src');
        const inDialog = await measurePadding(page, { url: preview }, FIT, rgbOf(COLOUR));
        await measureLayout();
        check(
          title,
          (await hex.inputValue()) === COLOUR &&
            (await picker.inputValue()) === COLOUR &&
            (await paddingStyle()) === COLOUR_CSS &&
            paddingOk(report) &&
            paddingOk(inDialog),
          `typed "${TYPED_COLOUR}"; hex box "${await hex.inputValue()}", editor padding ${await paddingStyle()}; ` +
            `file: ${describePadding(report)}; preview in the dialog: ${describePadding(inDialog)}`,
        );
      },
    );

    // 6. Ctrl-Z, after Tab has left the hex box: the colour goes first, then the fit.
    await step(
      'Ctrl-Z steps back through the colour and then the fit, one press each, and then does nothing',
      async (title) => {
        await hex.waitFor({ timeout: NEW_CONTROL_MS });
        // In the hex box Ctrl-Z belongs to typing. One Tab moves on, to the file type.
        await page.keyboard.press('Tab');
        const onFileType = await dialog
          .getByRole('radio', { name: 'JPG' })
          .evaluate((e) => e === document.activeElement);
        await undo();
        feedSrc = await nextRender(page, FEED_CARD, feedSrc);
        const afterOne = {
          crop: (await shown(page)).crop,
          colour: await paddingStyle(),
          hex: await hex.inputValue(),
        };
        await undo();
        feedSrc = await nextRender(page, FEED_CARD, feedSrc);
        const afterTwo = { crop: (await shown(page)).crop, colour: await paddingStyle() };
        await undo();
        await settle(page);
        const afterThree = (await shown(page)).crop;
        check(
          title,
          onFileType &&
            sameCrop(afterOne.crop, FIT) &&
            afterOne.colour === 'rgb(255, 255, 255)' &&
            afterOne.hex === WHITE &&
            sameCrop(afterTwo.crop, AUTO) &&
            sameCrop(afterThree, AUTO) &&
            (await tileSrc(page, FEED_CARD)) === feedSrc &&
            (await cardCount()) === 2,
          `after one press: crop ${cropText(afterOne.crop)}, padding ${afterOne.colour}, hex "${afterOne.hex}"; ` +
            `after two: crop ${cropText(afterTwo.crop)}; after three: crop ${cropText(afterThree)}, ${await cardCount()} cards`,
        );
      },
    );

    // 6b. The colour picker closed by a click outside it, which sends no change event first.
    await step(
      'a colour tried in the picker is kept when a click outside closes it, as one undo step',
      async (title) => {
        await picker.waitFor({ timeout: NEW_CONTROL_MS });
        const heading = dialog.getByRole('heading', { level: 2 });
        await heading.click();
        await tabTo(page, picker, 'the colour picker');
        // Chrome's colour picker is browser UI that Playwright cannot open or click in, so the
        // colour tried in it is set on the input here, with the one `input` event Chrome sends
        // for each colour tried, and no `change` event. The value is set through the input's
        // own setter, as the browser sets it, so React sees the change. Everything after this
        // is real: the click on the dialog's heading moves focus off the picker, as a click
        // outside the open picker does, and Ctrl-Z is a real key press.
        await picker.evaluate((element, colour) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(element, colour);
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }, COLOUR);
        const tried = await paddingStyle();
        await heading.click();
        await settle(page);
        const kept = {
          hex: await hex.inputValue(),
          picker: await picker.inputValue(),
          padding: await paddingStyle(),
        };
        const seen =
          `while tried: padding ${tried}; after the click outside: hex box "${kept.hex}", ` +
          `picker "${kept.picker}", padding ${kept.padding}`;
        if (kept.hex !== COLOUR) {
          check(title, false, `${seen}; the colour was not kept`);
          return;
        }
        feedSrc = await nextRender(page, FEED_CARD, feedSrc);
        await focusCrop();
        await undo();
        feedSrc = await nextRender(page, FEED_CARD, feedSrc);
        const afterOne = { hex: await hex.inputValue(), padding: await paddingStyle() };
        await undo();
        await settle(page);
        const afterTwo = { hex: await hex.inputValue(), src: await tileSrc(page, FEED_CARD) };
        check(
          title,
          tried === COLOUR_CSS &&
            kept.picker === COLOUR &&
            kept.padding === COLOUR_CSS &&
            afterOne.hex === WHITE &&
            afterOne.padding === 'rgb(255, 255, 255)' &&
            afterTwo.hex === WHITE &&
            afterTwo.src === feedSrc &&
            (await cardCount()) === 2,
          `${seen}; after one Ctrl-Z: hex box "${afterOne.hex}", padding ${afterOne.padding}; ` +
            `after a second: hex box "${afterTwo.hex}", file unchanged: ${afterTwo.src === feedSrc}`,
        );
      },
    );

    // 7. The arrow keys and the crop limits.
    await step(
      'a fit-size crop cannot be moved, and the arrow keys stop where each axis allows',
      async (title) => {
        await fitButton.click({ timeout: NEW_CONTROL_MS });
        feedSrc = await nextRender(page, FEED_CARD, feedSrc);
        await focusCrop();
        for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
          await page.keyboard.press(key);
          await page.keyboard.press(`Shift+${key}`);
        }
        await settle(page);
        const atFit = (await shown(page)).crop;
        const unmoved = (await tileSrc(page, FEED_CARD)) === feedSrc;
        // One step smaller: 0.9 of the width and 1.5 of the height, inside a fit frame that
        // reaches a third of the photo's height above it and below it.
        await page.keyboard.press('Shift+Minus');
        const width = FIT.width - 0.1;
        const height = (width * FIT.height) / FIT.width;
        const press = async (key, times) => {
          for (let i = 0; i < times; i++) await page.keyboard.press(key);
          await settle(page);
          return (await shown(page)).crop;
        };
        const up = await press('Shift+ArrowUp', 5);
        const down = await press('Shift+ArrowDown', 5);
        const left = await press('Shift+ArrowLeft', 5);
        const right = await press('Shift+ArrowRight', 5);
        // Down the page the crop is taller than the photo: it must hold the photo and stay in the
        // fit frame. Across it is narrower than the photo: it stays inside the photo.
        const top = Math.max(1 - height, FIT.y);
        const bottom = Math.min(0, FIT.y + FIT.height - height);
        check(
          title,
          sameCrop(atFit, FIT) &&
            unmoved &&
            near(up.y, top, 0.004) &&
            near(down.y, bottom, 0.004) &&
            near(left.x, 0, 0.004) &&
            near(right.x, 1 - width, 0.004) &&
            near(right.width, width, 0.004) &&
            near(right.height, height, 0.004),
          `at the fit size: ${cropText(atFit)}, file unchanged: ${unmoved}; 0.9 wide: up to y ${up.y.toFixed(3)} ` +
            `(limit ${top.toFixed(3)}), down to y ${down.y.toFixed(3)} (limit ${bottom.toFixed(3)}), ` +
            `left to x ${left.x.toFixed(3)}, right to x ${right.x.toFixed(3)} (limit ${(1 - width).toFixed(3)})`,
        );
        await settle(page);
        feedSrc = await tileSrc(page, FEED_CARD);
      },
    );

    // 8. Reset crop: the padding goes, the colour stays.
    await step('Reset crop removes the padding and keeps the colour', async (title) => {
      await hex.click({ timeout: NEW_CONTROL_MS });
      await page.keyboard.press('Control+a');
      await page.keyboard.type(TYPED_COLOUR);
      await page.keyboard.press('Enter');
      feedSrc = await nextRender(page, FEED_CARD, feedSrc);
      await resetButton.click();
      feedSrc = await nextRender(page, FEED_CARD, feedSrc);
      const { crop } = await shown(page);
      const plain = await inspect(page, feedSrc);
      const keptHex = await hex.inputValue();
      // The colour is still the card's: Fit whole photo again pads in it.
      await fitButton.click();
      const { src, report } = await fileAfter(FEED_CARD, feedSrc, FIT, COLOUR);
      feedSrc = src;
      check(
        title,
        sameCrop(crop, AUTO) && meets(plain, AUTO) && keptHex === COLOUR && paddingOk(report),
        `after Reset crop: crop ${cropText(crop)}, ${describeFile(plain, AUTO)}, hex box "${keptHex}"; ` +
          `after Fit whole photo again: ${describePadding(report)}`,
      );
    });

    // 9. The dialog and the crop area are the same size whatever the crop and the colour are.
    await step(
      'the dialog and the crop area keep their size as padding and a colour are added',
      async (title) => {
        await measureLayout();
        const same = (list) => list.length >= 4 && list.every((size) => size === list[0]);
        check(
          title,
          same(sizes.dialog) && same(sizes.area),
          `dialog ${sizes.dialog.join(', ')}; crop area ${sizes.area.join(', ')}`,
        );
      },
    );

    // 10. Save, reload and reopen: the padded crop and the colour come back.
    await step(
      'Download .scs, Clear, Load .scs: the padded crop and the colour come back',
      async (title) => {
        await hex.waitFor({ timeout: NEW_CONTROL_MS });
        await closeEditor(page);
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'Download .scs' }).click(),
        ]);
        const bundlePath = join(outDir, `${name}-padding-session.scs`);
        await download.saveAs(bundlePath);
        const zip = await JSZip.loadAsync(readFileSync(bundlePath));
        const saved = JSON.parse(await zip.file('session.json').async('string'));
        const savedFeed = saved.cards.find((card) => card.placement === 'feed-vertical');
        const savedSquare = saved.cards.find((card) => card.placement === 'image-square');
        await page.getByRole('button', { name: 'Clear session' }).click();
        await page.getByText('No session is open.').waitFor();
        await page.getByLabel('Session bundle file').setInputFiles(bundlePath);
        await page
          .getByRole('status')
          .filter({ hasText: /^Opened / })
          .first()
          .waitFor();
        await waitForRendered(page, 2);
        feedSrc = await tileSrc(page, FEED_CARD);
        const report = await measurePadding(page, { url: feedSrc }, FIT, rgbOf(COLOUR));
        await openEditor(page, FEED_CARD);
        const reopened = {
          crop: (await shown(page)).crop,
          hex: await hex.inputValue(),
          colour: await paddingStyle(),
        };
        check(
          title,
          savedFeed.background === COLOUR &&
            sameCrop(savedFeed.edit.crop, FIT) &&
            // The card that was never given a colour has none in the file.
            !('background' in savedSquare) &&
            saved.version === 1 &&
            paddingOk(report) &&
            sameCrop(reopened.crop, FIT) &&
            reopened.hex === COLOUR &&
            reopened.colour === COLOUR_CSS,
          `saved: background ${JSON.stringify(savedFeed.background)}, crop ${cropText(savedFeed.edit.crop)}, ` +
            `other card has a colour: ${'background' in savedSquare}; after reload: ${describePadding(report)}; ` +
            `reopened: crop ${cropText(reopened.crop)}, hex box "${reopened.hex}", padding ${reopened.colour}`,
        );
      },
    );

    // 11. A duplicate has the colour, and the padded crop.
    await step('Duplicate copies the colour and the padded crop', async (title) => {
      await hex.waitFor({ timeout: NEW_CONTROL_MS });
      await closeEditor(page);
      await page.getByRole('button', { name: `Duplicate ${FEED_CARD}`, exact: true }).click();
      await waitForRendered(page, 3);
      const copySrc = await tileSrc(page, COPY_CARD);
      const report = await measurePadding(page, { url: copySrc }, FIT, rgbOf(COLOUR));
      await openEditor(page, COPY_CARD);
      const copy = {
        crop: (await shown(page)).crop,
        hex: await hex.inputValue(),
        colour: await paddingStyle(),
      };
      check(
        title,
        paddingOk(report) &&
          sameCrop(copy.crop, FIT) &&
          copy.hex === COLOUR &&
          copy.colour === COLOUR_CSS,
        `the copy's file: ${describePadding(report)}; in its editor: crop ${cropText(copy.crop)}, ` +
          `hex box "${copy.hex}", padding ${copy.colour}`,
      );
    });

    check('no failed requests and no console errors', problems.length === 0, problems.join(' | '));
    writeFileSync(
      join(outDir, `${name}-padding-report.json`),
      JSON.stringify({ checks, problems }, null, 2),
    );
  } catch (error) {
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
// The same browser, but with its scrollbars left on: Playwright hides them by default.
const scrollbarBrowser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
try {
  console.log(`Chromium ${browser.version()}; report in ${outDir}`);

  const devUrl = `http://localhost:${PORTS.dev}/`;
  await serve(['--port', String(PORTS.dev), '--strictPort'], {}, devUrl);
  failed = !(await runEditor(browser, scrollbarBrowser, 'dev', devUrl)) || failed;
  failed = !(await runPadding(browser, 'dev', devUrl)) || failed;

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
  failed = !(await runEditor(browser, scrollbarBrowser, 'production', siteUrl)) || failed;
  failed = !(await runPadding(browser, 'production', siteUrl)) || failed;
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser.close();
  await scrollbarBrowser.close();
  stopServers();
}
console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: all checks passed');
process.exit(failed ? 1 : 0);
