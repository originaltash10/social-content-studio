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
 * pixels move as expected); moving and resizing with the keyboard; Reset crop; a focal point
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

async function runEditor(browser, name, url) {
  console.log(`\n== Editor check: ${name} (${url})`);
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  });
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
    await page.goto(url, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'New session' }).click();
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

    // 5. Keyboard: Tab reaches the crop area; arrows move it; minus and equals resize it.
    await page.getByRole('application').focus();
    await page.keyboard.press('Shift+ArrowLeft');
    feedSrc = await nextRender(page, FEED_CARD, feedSrc);
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
      near(moved.crop.x, resized.crop.x - 0.1, 0.002) &&
        near(nudged.crop.y, moved.crop.y + 0.01, 0.002),
      `x ${resized.crop.x.toFixed(3)} -> ${moved.crop.x.toFixed(3)}, y ${moved.crop.y.toFixed(3)} -> ${nudged.crop.y.toFixed(3)}`,
    );
    await page.keyboard.press('Minus');
    feedSrc = await checkFile(
      'minus shrinks the crop about its centre, and the file follows',
      FEED_CARD,
      FEED,
      feedSrc,
    );
    const smaller = await shown(page);
    await page.keyboard.press('Equal');
    feedSrc = await nextRender(page, FEED_CARD, feedSrc);
    const larger = await shown(page);
    const centre = (c) => c.x + c.width / 2;
    check(
      'minus and plus change the width by a hundredth of the photo and keep the centre',
      near(smaller.crop.width, nudged.crop.width - 0.01, 0.002) &&
        near(larger.crop.width, nudged.crop.width, 0.002) &&
        near(centre(smaller.crop), centre(nudged.crop), 0.002),
      `width ${nudged.crop.width.toFixed(3)} -> ${smaller.crop.width.toFixed(3)} -> ${larger.crop.width.toFixed(3)}`,
    );

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
    await closeEditor(page);

    // 7. Adjust the square card by hand, so the focal move below must leave it alone.
    await openEditor(page, SQUARE_CARD);
    let squareSrc = await tileSrc(page, SQUARE_CARD);
    await page.getByRole('application').focus();
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
    await page.getByRole('application').focus();
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
    await pngRadio.focus();
    await page.keyboard.press('Control+z');
    squareSrc = await nextRender(page, SQUARE_CARD, squareSrc);
    const backFile = await inspect(page, squareSrc);
    const backCaption = await captionFor(backFile);
    check(
      'one Ctrl-Z on the PNG radio goes back to JPG at 90%, made again as a JPG',
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

    // 17e. A touch drag, sent as real touch input, is one undo step too.
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
    await slider.focus();
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

    // 18. Network and console.
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
  failed = !(await runEditor(browser, 'dev', devUrl)) || failed;

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
  failed = !(await runEditor(browser, 'production', siteUrl)) || failed;
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser.close();
  stopServers();
}
console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: all checks passed');
process.exit(failed ? 1 : 0);
