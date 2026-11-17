import { describe, expect, it } from 'vitest';
import platformData from '../../data/platforms.json';
import { cropToPixels } from '../render/crop';
import type { PlatformsFile, Rect, Size } from '../../types';
import {
  AUTOMATIC_TOLERANCE,
  MAX_ENLARGEMENT,
  NUDGE_BIG_STEP,
  NUDGE_STEP,
  arrowDelta,
  automaticCrop,
  constrainCrop,
  cropLimits,
  fitView,
  isAutomaticCrop,
  moveCrop,
  movePoint,
  rectToScreen,
  resizeCrop,
  resizeDelta,
  scaleCrop,
  toPhoto,
  toScreen,
} from './geometry';

// Output sizes come from the platform data, never from this file.
const sizeOf = (platform: string, placement: string): Size => {
  const spec = (platformData as PlatformsFile).placements.find(
    (p) => p.platform === platform && p.placement === placement,
  );
  return spec?.sizes[0] as Size;
};
const VERTICAL = sizeOf('instagram', 'feed-vertical');
const SQUARE = sizeOf('linkedin', 'image-square');

/** A landscape photo, deliberately not square, so swapping width and height shows. */
const PHOTO: Size = { width: 4000, height: 3000 };
const CENTRE = { x: 0.5, y: 0.5 };

/** The crop's shape in photo pixels, width over height. */
const pixelRatio = (crop: Rect, source: Size) =>
  (crop.width * source.width) / (crop.height * source.height);
const ratioOf = (size: Size) => size.width / size.height;

function expectRect(actual: Rect, expected: Rect) {
  expect(actual.x).toBeCloseTo(expected.x, 12);
  expect(actual.y).toBeCloseTo(expected.y, 12);
  expect(actual.width).toBeCloseTo(expected.width, 12);
  expect(actual.height).toBeCloseTo(expected.height, 12);
}

describe('cropLimits', () => {
  it('allows the largest crop of the output shape that fits in the photo', () => {
    const limits = cropLimits(PHOTO, VERTICAL);
    expect(limits.max.height).toBe(1);
    expect(pixelRatio({ x: 0, y: 0, ...limits.max }, PHOTO)).toBeCloseTo(ratioOf(VERTICAL), 12);
    const wide = cropLimits({ width: 3000, height: 4000 }, SQUARE);
    expect(wide.max.width).toBe(1);
    expect(wide.max.height).toBeCloseTo(0.75, 12);
  });

  it('stops at half the output size, so cropping never enlarges more than twice', () => {
    const limits = cropLimits(PHOTO, VERTICAL);
    const pixels = cropToPixels({ x: 0, y: 0, ...limits.min }, PHOTO);
    expect(pixels.width).toBe(Math.round(VERTICAL.width / MAX_ENLARGEMENT));
    expect(pixels.height).toBe(Math.round(VERTICAL.height / MAX_ENLARGEMENT));
    expect(limits.min.height).toBeCloseTo(limits.min.width * limits.shape, 12);
  });

  it('uses the whole fitting crop when the photo is smaller than half the output', () => {
    const tiny: Size = { width: 200, height: 100 };
    const limits = cropLimits(tiny, SQUARE);
    expect(limits.min).toEqual(limits.max);
    expect(limits.min.width).toBeCloseTo(0.5, 12);
    expect(limits.min.height).toBe(1);
  });
});

describe('moveCrop', () => {
  const crop: Rect = { x: 0.2, y: 0.3, width: 0.4, height: 0.5 };

  it('moves by the given distance and keeps the size', () => {
    expectRect(moveCrop(crop, 0.1, -0.05), { x: 0.3, y: 0.25, width: 0.4, height: 0.5 });
  });

  it('stops at every edge of the photo', () => {
    expectRect(moveCrop(crop, -1, -1), { ...crop, x: 0, y: 0 });
    expectRect(moveCrop(crop, 1, 1), { ...crop, x: 0.6, y: 0.5 });
  });
});

describe('resizeCrop', () => {
  // A square output on the 4000 x 3000 photo: a crop's height fraction is 4/3 of its width's.
  const limits = cropLimits(PHOTO, SQUARE);
  const crop: Rect = { x: 0.3, y: 0.2, width: 0.3, height: 0.4 };

  it('has a shape of four thirds for this photo', () => {
    expect(limits.shape).toBeCloseTo(4 / 3, 12);
  });

  it('follows the south-east corner and keeps the opposite corner in place', () => {
    const next = resizeCrop(crop, 'se', { x: 0.7, y: 0.3 }, limits);
    expectRect(next, { x: 0.3, y: 0.2, width: 0.4, height: 0.4 * (4 / 3) });
    expect(pixelRatio(next, PHOTO)).toBeCloseTo(1, 12);
  });

  it('follows the vertical movement when that is the larger', () => {
    // 0.6 down from the anchor is 0.45 across at this shape.
    const next = resizeCrop(crop, 'se', { x: 0.31, y: 0.8 }, limits);
    expectRect(next, { x: 0.3, y: 0.2, width: 0.45, height: 0.6 });
  });

  it('anchors the south-east corner when the north-west one is dragged', () => {
    const next = resizeCrop(crop, 'nw', { x: 0.45, y: 0.55 }, limits);
    expectRect(next, { x: 0.45, y: 0.4, width: 0.15, height: 0.2 });
    expect(next.x + next.width).toBeCloseTo(0.6, 12);
    expect(next.y + next.height).toBeCloseTo(0.6, 12);
  });

  it('anchors the south-west corner when the north-east one is dragged', () => {
    const next = resizeCrop(crop, 'ne', { x: 0.75, y: 0.5 }, limits);
    expectRect(next, { x: 0.3, y: 0, width: 0.45, height: 0.6 });
  });

  it('anchors the north-east corner when the south-west one is dragged', () => {
    const next = resizeCrop(crop, 'sw', { x: 0.15, y: 0.3 }, limits);
    expectRect(next, { x: 0.15, y: 0.2, width: 0.45, height: 0.6 });
  });

  it('stops at the edge of the photo, whichever edge comes first', () => {
    // Downwards there is room for 0.8 of height, which is 0.6 of width.
    const down = resizeCrop(crop, 'se', { x: 1, y: 1 }, limits);
    expectRect(down, { x: 0.3, y: 0.2, width: 0.6, height: 0.8 });
    // Leftwards from an anchor at x 0.6 there is 0.6 of width, but upwards only 0.6 of height.
    const up = resizeCrop(crop, 'nw', { x: 0, y: 0 }, limits);
    expectRect(up, { x: 0.15, y: 0, width: 0.45, height: 0.6 });
  });

  it('never goes below the smallest size, even when dragged past the anchor', () => {
    const next = resizeCrop(crop, 'se', { x: 0, y: 0 }, limits);
    expect(next.width).toBeCloseTo(limits.min.width, 12);
    expect(next.height).toBeCloseTo(limits.min.height, 12);
    expect(next.x).toBe(0.3);
    expect(next.y).toBe(0.2);
  });

  it('never goes above the largest size', () => {
    const narrow = cropLimits(PHOTO, SQUARE);
    const capped = { ...narrow, max: { width: 0.35, height: 0.35 * narrow.shape } };
    const next = resizeCrop(crop, 'se', { x: 1, y: 1 }, capped);
    expect(next.width).toBeCloseTo(0.35, 12);
  });

  it('keeps a crop that is already below the smallest size inside the photo', () => {
    // A corner with less room than the smallest size: the room wins.
    const cornered: Rect = { x: 0.95, y: 0.9, width: 0.03, height: 0.04 };
    const next = resizeCrop(cornered, 'se', { x: 1, y: 1 }, limits);
    expect(next.x + next.width).toBeLessThanOrEqual(1 + 1e-12);
    expect(next.y + next.height).toBeLessThanOrEqual(1 + 1e-12);
    expect(next.width).toBeLessThan(limits.min.width);
  });
});

describe('scaleCrop', () => {
  const limits = cropLimits(PHOTO, SQUARE);
  const crop: Rect = { x: 0.3, y: 0.2, width: 0.3, height: 0.4 };

  it('grows and shrinks about the centre and keeps the shape', () => {
    const bigger = scaleCrop(crop, 0.06, limits);
    expectRect(bigger, { x: 0.27, y: 0.16, width: 0.36, height: 0.48 });
    expect(pixelRatio(bigger, PHOTO)).toBeCloseTo(1, 12);
    const smaller = scaleCrop(crop, -0.06, limits);
    expectRect(smaller, { x: 0.33, y: 0.24, width: 0.24, height: 0.32 });
    expect(smaller.x + smaller.width / 2).toBeCloseTo(0.45, 12);
    expect(smaller.y + smaller.height / 2).toBeCloseTo(0.4, 12);
  });

  it('stops at the smallest and the largest size', () => {
    const smallest = scaleCrop(crop, -1, limits);
    expect(smallest.width).toBeCloseTo(limits.min.width, 12);
    expect(smallest.height).toBeCloseTo(limits.min.height, 12);
    // The largest crop is the photo's full height; it slides sideways to keep its centre.
    const largest = scaleCrop(crop, 1, limits);
    expectRect(largest, { x: 0.075, y: 0, width: 0.75, height: 1 });
    // At a limit already, the very same crop comes back.
    expect(scaleCrop(smallest, -0.01, limits)).toBe(smallest);
    expect(scaleCrop(largest, 0.01, limits)).toBe(largest);
  });

  it('slides back inside the photo when it would hang over an edge', () => {
    const topLeft = scaleCrop({ x: 0, y: 0, width: 0.3, height: 0.4 }, 0.06, limits);
    expectRect(topLeft, { x: 0, y: 0, width: 0.36, height: 0.48 });
    const bottomRight = scaleCrop({ x: 0.7, y: 0.6, width: 0.3, height: 0.4 }, 0.06, limits);
    expectRect(bottomRight, { x: 0.64, y: 0.52, width: 0.36, height: 0.48 });
  });
});

describe('resizeDelta', () => {
  it('grows for plus and equals, and shrinks for minus, on either part of the keyboard', () => {
    for (const key of ['+', '=', 'Add']) expect(resizeDelta(key, false)).toBe(NUDGE_STEP);
    for (const key of ['-', '_', 'Subtract']) expect(resizeDelta(key, false)).toBe(-NUDGE_STEP);
  });

  it('takes a bigger step with Shift', () => {
    expect(resizeDelta('+', true)).toBe(NUDGE_BIG_STEP);
    expect(resizeDelta('_', true)).toBe(-NUDGE_BIG_STEP);
  });

  it('is null for any other key', () => {
    expect(resizeDelta('ArrowUp', false)).toBeNull();
  });
});

describe('constrainCrop', () => {
  it('leaves a usable crop as the renderer would fit it', () => {
    const auto = automaticCrop(PHOTO, VERTICAL, CENTRE);
    expectRect(constrainCrop(auto, PHOTO, VERTICAL), auto);
  });

  it('trims a crop of the wrong shape to the output shape', () => {
    const next = constrainCrop({ x: 0, y: 0, width: 1, height: 1 }, PHOTO, SQUARE);
    expect(pixelRatio(next, PHOTO)).toBeCloseTo(1, 12);
    expectRect(next, { x: 0.125, y: 0, width: 0.75, height: 1 });
  });

  it('grows a crop that is too small about its centre', () => {
    const limits = cropLimits(PHOTO, SQUARE);
    const small: Rect = { x: 0.49, y: 0.49, width: 0.015, height: 0.02 };
    const next = constrainCrop(small, PHOTO, SQUARE);
    expect(next.width).toBeCloseTo(limits.min.width, 12);
    expect(next.height).toBeCloseTo(limits.min.height, 12);
    expect(next.x + next.width / 2).toBeCloseTo(0.4975, 12);
    expect(next.y + next.height / 2).toBeCloseTo(0.5, 12);
  });

  it('slides a grown crop back inside the photo', () => {
    const limits = cropLimits(PHOTO, SQUARE);
    const topLeft = constrainCrop({ x: 0, y: 0, width: 0.015, height: 0.02 }, PHOTO, SQUARE);
    expect(topLeft.x).toBe(0);
    expect(topLeft.y).toBe(0);
    const bottomRight = constrainCrop(
      { x: 0.985, y: 0.98, width: 0.015, height: 0.02 },
      PHOTO,
      SQUARE,
    );
    expect(bottomRight.x).toBeCloseTo(1 - limits.min.width, 12);
    expect(bottomRight.y).toBeCloseTo(1 - limits.min.height, 12);
  });
});

describe('isAutomaticCrop', () => {
  const focal = { x: 0.3, y: 0.6 };
  const auto = automaticCrop(PHOTO, VERTICAL, focal);

  it('is true for the automatic crop of the same focal point', () => {
    expect(isAutomaticCrop(auto, PHOTO, VERTICAL, focal)).toBe(true);
  });

  it('is true after a save and load, and after rounding in the last places', () => {
    const reloaded = JSON.parse(JSON.stringify(auto)) as Rect;
    expect(isAutomaticCrop(reloaded, PHOTO, VERTICAL, focal)).toBe(true);
    // The same crop reached by different arithmetic: 0.1 + 0.2 is not exactly 0.3.
    const drifted = automaticCrop(PHOTO, VERTICAL, { x: 0.1 + 0.2, y: 0.6 });
    expect(isAutomaticCrop(drifted, PHOTO, VERTICAL, focal)).toBe(true);
    const nudged = { ...auto, x: auto.x + AUTOMATIC_TOLERANCE / 2 };
    expect(isAutomaticCrop(nudged, PHOTO, VERTICAL, focal)).toBe(true);
  });

  it('is false when any one edge has moved by more than the tolerance', () => {
    const far = AUTOMATIC_TOLERANCE * 10;
    // Left edge only (the right edge is held still).
    expect(
      isAutomaticCrop(
        { ...auto, x: auto.x + far, width: auto.width - far },
        PHOTO,
        VERTICAL,
        focal,
      ),
    ).toBe(false);
    // Right edge only.
    expect(isAutomaticCrop({ ...auto, width: auto.width - far }, PHOTO, VERTICAL, focal)).toBe(
      false,
    );
    // Top edge only.
    expect(
      isAutomaticCrop(
        { ...auto, y: auto.y + far, height: auto.height - far },
        PHOTO,
        VERTICAL,
        focal,
      ),
    ).toBe(false);
    // Bottom edge only.
    expect(isAutomaticCrop({ ...auto, height: auto.height - far }, PHOTO, VERTICAL, focal)).toBe(
      false,
    );
  });

  it('is false for the automatic crop of a different focal point or placement', () => {
    expect(isAutomaticCrop(auto, PHOTO, VERTICAL, CENTRE)).toBe(false);
    expect(isAutomaticCrop(auto, PHOTO, SQUARE, focal)).toBe(false);
  });

  it('takes a wider tolerance when given one', () => {
    const moved = moveCrop(auto, 0.001, 0);
    expect(isAutomaticCrop(moved, PHOTO, VERTICAL, focal)).toBe(false);
    expect(isAutomaticCrop(moved, PHOTO, VERTICAL, focal, 0.01)).toBe(true);
  });
});

describe('movePoint', () => {
  it('moves a point and keeps it on the photo', () => {
    expect(movePoint({ x: 0.5, y: 0.5 }, 0.25, -0.25)).toEqual({ x: 0.75, y: 0.25 });
    expect(movePoint({ x: 0.5, y: 0.5 }, 2, -2)).toEqual({ x: 1, y: 0 });
    expect(movePoint({ x: 0.5, y: 0.5 }, -2, 2)).toEqual({ x: 0, y: 1 });
  });
});

describe('arrowDelta', () => {
  it('gives a small step for each arrow key', () => {
    expect(arrowDelta('ArrowLeft', false)).toEqual({ dx: -NUDGE_STEP, dy: 0 });
    expect(arrowDelta('ArrowRight', false)).toEqual({ dx: NUDGE_STEP, dy: 0 });
    expect(arrowDelta('ArrowUp', false)).toEqual({ dx: 0, dy: -NUDGE_STEP });
    expect(arrowDelta('ArrowDown', false)).toEqual({ dx: 0, dy: NUDGE_STEP });
  });

  it('gives a bigger step with Shift', () => {
    expect(arrowDelta('ArrowRight', true)).toEqual({ dx: NUDGE_BIG_STEP, dy: 0 });
    expect(NUDGE_BIG_STEP).toBeGreaterThan(NUDGE_STEP);
  });

  it('is null for any other key', () => {
    expect(arrowDelta('Enter', false)).toBeNull();
  });
});

describe('screen and photo', () => {
  // The 4000 x 3000 photo shown at a tenth of its size, in a box it does not fill.
  const box: Size = { width: 500, height: 300 };
  const view = fitView(PHOTO, box);

  it('fits the whole photo in the box at one scale, centred', () => {
    // Height is the tighter side: 300 / 3000. Width then takes 400 of the 500.
    expect(view).toEqual({ scale: 0.1, x: 50, y: 0 });
    const tall = fitView({ width: 3000, height: 4000 }, { width: 300, height: 600 });
    expect(tall.scale).toBeCloseTo(0.1, 12);
    expect(tall.x).toBeCloseTo(0, 12);
    expect(tall.y).toBeCloseTo(100, 12);
  });

  it('maps photo fractions to screen pixels using width for x and height for y', () => {
    expect(toScreen({ x: 0, y: 0 }, PHOTO, view)).toEqual({ x: 50, y: 0 });
    expect(toScreen({ x: 1, y: 1 }, PHOTO, view)).toEqual({ x: 450, y: 300 });
    // A swap of width and height would give (125, 100) here.
    expect(toScreen({ x: 0.25, y: 0.25 }, PHOTO, view)).toEqual({ x: 150, y: 75 });
  });

  it('maps screen pixels back to photo fractions', () => {
    // A swap of width and height would give (0.333…, 0.1875) here.
    expect(toPhoto({ x: 150, y: 75 }, PHOTO, view)).toEqual({ x: 0.25, y: 0.25 });
    const there = toScreen({ x: 0.8, y: 0.1 }, PHOTO, view);
    const back = toPhoto(there, PHOTO, view);
    expect(back.x).toBeCloseTo(0.8, 12);
    expect(back.y).toBeCloseTo(0.1, 12);
  });

  it('reports a position off the photo at the nearest edge', () => {
    expect(toPhoto({ x: 10, y: -20 }, PHOTO, view)).toEqual({ x: 0, y: 0 });
    expect(toPhoto({ x: 499, y: 900 }, PHOTO, view)).toEqual({ x: 1, y: 1 });
  });

  it('maps a crop to a screen rectangle of the same shape as its pixels', () => {
    const crop: Rect = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };
    const shown = rectToScreen(crop, PHOTO, view);
    expect(shown).toEqual({ x: 150, y: 150, width: 200, height: 75 });
    const pixels = cropToPixels(crop, PHOTO);
    expect(shown.width / shown.height).toBeCloseTo(pixels.width / pixels.height, 12);
  });

  it('agrees with the pixels the renderer draws from', () => {
    // Drag a square crop on screen, then check the renderer's pixel rectangle is square too.
    const limits = cropLimits(PHOTO, SQUARE);
    const start = automaticCrop(PHOTO, SQUARE, CENTRE);
    const pointer = toPhoto({ x: 300, y: 200 }, PHOTO, view);
    const pixels = cropToPixels(resizeCrop(start, 'se', pointer, limits), PHOTO);
    expect(pixels.width).toBe(pixels.height);
  });
});
