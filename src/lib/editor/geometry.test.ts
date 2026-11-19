import { describe, expect, it } from 'vitest';
import platformData from '../../data/platforms.json';
import { cropToPixels, fitSize, focalCrop } from '../render/crop';
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
  fitWholeCrop,
  isAutomaticCrop,
  moveCrop,
  movePoint,
  rectToScreen,
  resizeCrop,
  resizeDelta,
  sameCrop,
  scaleCrop,
  toPhoto,
  toPhotoPlane,
  toScreen,
} from './geometry';
import type { Corner } from './geometry';

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

// Every output size the app makes, and photos of every shape, for the limits that must hold
// whatever the photo and the placement.
const TARGETS: { name: string; target: Size }[] = (
  platformData as PlatformsFile
).placements.flatMap((spec) =>
  spec.sizes.map((size) => ({
    name: `${spec.platform} ${spec.placement} ${size.width} x ${size.height}`,
    target: { width: size.width, height: size.height },
  })),
);
const SOURCES: { name: string; source: Size }[] = [
  { name: 'landscape', source: PHOTO },
  { name: 'portrait', source: { width: 3000, height: 4000 } },
  { name: 'square', source: { width: 3000, height: 3000 } },
  { name: 'small landscape', source: { width: 200, height: 100 } },
  { name: 'small portrait', source: { width: 240, height: 320 } },
  { name: 'small square', source: { width: 150, height: 150 } },
  { name: 'one pixel', source: { width: 1, height: 1 } },
];

/** True when the crop is within the crop limits, allowing for rounding in the last places. */
function expectWithinLimits(crop: Rect, source: Size, target: Size) {
  const limits = cropLimits(source, target);
  const frame = fitWholeCrop(source, target);
  const slack = 1e-12;
  const axes = [
    { start: crop.x, length: crop.width, from: frame.x, fit: frame.width },
    { start: crop.y, length: crop.height, from: frame.y, fit: frame.height },
  ];
  for (const { start, length, from, fit } of axes) {
    if (length <= 1 + slack) {
      // No longer than the photo: inside the photo.
      expect(start).toBeGreaterThanOrEqual(-slack);
      expect(start + length).toBeLessThanOrEqual(1 + slack);
    } else {
      // Longer than the photo: it holds the photo and stays inside the fit frame.
      expect(start).toBeLessThanOrEqual(slack);
      expect(start + length).toBeGreaterThanOrEqual(1 - slack);
      expect(start).toBeGreaterThanOrEqual(from - slack);
      expect(start + length).toBeLessThanOrEqual(from + fit + slack);
    }
  }
  expect(crop.width).toBeGreaterThanOrEqual(limits.min.width - slack);
  expect(crop.width).toBeLessThanOrEqual(limits.max.width + slack);
  expect(pixelRatio(crop, source)).toBeCloseTo(ratioOf(target), 9);
}

describe('cropLimits', () => {
  it('allows a crop as large as the fit size, which holds the whole photo', () => {
    const limits = cropLimits(PHOTO, VERTICAL);
    expect(limits.max).toEqual({ width: 1, height: 5 / 3 });
    expect(limits.fit).toEqual(limits.max);
    expect(pixelRatio({ x: 0, y: 0, ...limits.max }, PHOTO)).toBeCloseTo(ratioOf(VERTICAL), 12);
    const wide = cropLimits({ width: 3000, height: 4000 }, SQUARE);
    expect(wide.max).toEqual({ width: 4 / 3, height: 1 });
  });

  it('keeps the shape of the crop that fills the frame', () => {
    const limits = cropLimits(PHOTO, VERTICAL);
    const fill = focalCrop(PHOTO, ratioOf(VERTICAL), CENTRE);
    expect(limits.shape).toBe(fill.height / fill.width);
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
    // The smallest crop is the one that fills the frame, exactly as it was before padding.
    expect(limits.min).toEqual({ width: 0.5, height: 1 });
    // The largest is the fit size, so even a tiny photo can be shown whole.
    expect(limits.max).toEqual({ width: 1, height: 2 });
  });

  describe.each(SOURCES)('for a $name photo', ({ source }) => {
    it.each(TARGETS)(
      'the smallest crop is unchanged and never above the fit size: $name',
      ({ target }) => {
        const limits = cropLimits(source, target);
        const ratio = ratioOf(target);
        // The smallest crop, worked out the way it was before crops could have padding.
        const fill = focalCrop(source, ratio, CENTRE);
        const width = Math.min(target.width / MAX_ENLARGEMENT / source.width, fill.width);
        expect(limits.min).toEqual({ width, height: width * (fill.height / fill.width) });
        // The largest is the fit size, and the smallest never exceeds it, so it never wins.
        expect(limits.fit).toEqual(fitSize(source, ratio));
        expect(limits.max).toEqual(limits.fit);
        expect(limits.min.width).toBeLessThanOrEqual(limits.max.width);
        expect(limits.min.height).toBeLessThanOrEqual(limits.max.height);
      },
    );
  });

  it.each(TARGETS)('has no padding to give when the photo has the shape of $name', ({ target }) => {
    const limits = cropLimits({ width: target.width * 2, height: target.height * 2 }, target);
    expect(limits.max.width).toBeCloseTo(1, 12);
    expect(limits.max.height).toBeCloseTo(1, 12);
  });
});

describe('moveCrop', () => {
  const crop: Rect = { x: 0.2, y: 0.3, width: 0.4, height: 0.5 };

  // A square output on the 4000 x 3000 photo: the fit size is 1 wide and 4/3 tall.
  const limits = cropLimits(PHOTO, SQUARE);

  it('moves by the given distance and keeps the size', () => {
    expectRect(moveCrop(crop, 0.1, -0.05, limits), { x: 0.3, y: 0.25, width: 0.4, height: 0.5 });
  });

  it('stops at every edge of the photo', () => {
    expectRect(moveCrop(crop, -1, -1, limits), { ...crop, x: 0, y: 0 });
    expectRect(moveCrop(crop, 1, 1, limits), { ...crop, x: 0.6, y: 0.5 });
  });

  it('moves a crop inside the photo exactly as it did before padding', () => {
    for (const [dx, dy] of [
      [0.1, -0.05],
      [-1, -1],
      [1, 1],
      [0.013, 0.027],
    ] as const) {
      expect(moveCrop(crop, dx, dy, limits)).toEqual({
        ...crop,
        x: Math.min(1 - crop.width, Math.max(0, crop.x + dx)),
        y: Math.min(1 - crop.height, Math.max(0, crop.y + dy)),
      });
    }
  });

  it('slides a padded crop only while it holds the photo and stays in the fit frame', () => {
    // 0.9 wide and 1.2 tall, in a fit frame from -1/6 to 7/6. Across it stays in the photo.
    // Down it may start from -1/6 (the fit frame's top) to 7/6 - 1.2 (its bottom).
    const padded: Rect = { x: 0.05, y: -0.1, width: 0.9, height: 1.2 };
    expectRect(moveCrop(padded, 0, 0.05, limits), { ...padded, y: -0.05 });
    expectRect(moveCrop(padded, 0, 1, limits), { ...padded, y: 7 / 6 - 1.2 });
    expectRect(moveCrop(padded, 0, -1, limits), { ...padded, y: -1 / 6 });
    // 0.78 wide and 1.04 tall: here holding the photo is the tighter limit, from -0.04 to 0.
    const slightly: Rect = { x: 0.1, y: -0.02, width: 0.78, height: 1.04 };
    expectRect(moveCrop(slightly, 0, 1, limits), { ...slightly, y: 0 });
    expectRect(moveCrop(slightly, 0, -1, limits), { ...slightly, y: 1 - 1.04 });
    expectRect(moveCrop(padded, 1, 0, limits), { ...padded, x: 0.1 });
    expectRect(moveCrop(padded, -1, 0, limits), { ...padded, x: 0 });
  });

  it('cannot move a crop of the fit size at all', () => {
    const fit = fitWholeCrop(PHOTO, SQUARE);
    for (const [dx, dy] of [
      [0.01, 0],
      [-0.1, 0],
      [0, 0.01],
      [0, -0.1],
      [1, 1],
    ] as const) {
      expectRect(moveCrop(fit, dx, dy, limits), fit);
    }
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

  it('reaches the edge of the photo with the opposite corner still in place', () => {
    // Downwards there is room for 0.8 of height, which is 0.6 of width.
    const down = resizeCrop(crop, 'se', { x: 0.9, y: 1 }, limits);
    expectRect(down, { x: 0.3, y: 0.2, width: 0.6, height: 0.8 });
    // Upwards from an anchor at y 0.6 there is 0.6 of height, which is 0.45 of width.
    const up = resizeCrop(crop, 'nw', { x: 0.15, y: 0 }, limits);
    expectRect(up, { x: 0.15, y: 0, width: 0.45, height: 0.6 });
  });

  it('keeps growing past the edge of the photo, sliding to stay inside it', () => {
    // 0.7 wide is 14/15 tall: no longer than the photo, so it slides up to stay inside.
    const down = resizeCrop(crop, 'se', { x: 1, y: 1 }, limits);
    expectRect(down, { x: 0.3, y: 1 - 14 / 15, width: 0.7, height: 14 / 15 });
    // 0.6 wide is 0.8 tall: it slides down from the top edge.
    const up = resizeCrop(crop, 'nw', { x: 0, y: 0 }, limits);
    expectRect(up, { x: 0, y: 0, width: 0.6, height: 0.8 });
  });

  it('adds padding once it is longer than the photo, and holds the photo', () => {
    // 0.78 wide is 1.04 tall. The anchor is at the top of the photo, so the padding is below.
    const top: Rect = { x: 0.1, y: 0, width: 0.3, height: 0.4 };
    const below = resizeCrop(top, 'se', { x: 0.88, y: 0.5 }, limits);
    expectRect(below, { x: 0.1, y: 0, width: 0.78, height: 1.04 });
    // 0.9 wide is 1.2 tall, which reaches past the fit frame's bottom edge at 7/6, so the crop
    // slides up to stay inside the fit frame.
    const framed = resizeCrop(top, 'se', { x: 1, y: 0.5 }, limits);
    expectRect(framed, { x: 0.1, y: 7 / 6 - 1.2, width: 0.9, height: 1.2 });
    // From a crop in the middle, the crop slides up until it holds the whole height.
    const middle = resizeCrop(crop, 'se', { x: 1.08, y: 0.5 }, limits);
    expectRect(middle, { x: 0.22, y: 0, width: 0.78, height: 1.04 });
  });

  it.each(['nw', 'ne', 'sw', 'se'] as Corner[])(
    'stops at the fit size, centred, when the %s corner is dragged far past the photo',
    (corner) => {
      const far = { x: corner.endsWith('w') ? -5 : 6, y: corner.startsWith('n') ? -5 : 6 };
      const next = resizeCrop(crop, corner, far, limits);
      expectRect(next, { x: 0, y: -1 / 6, width: 1, height: 4 / 3 });
      // Dragging further changes nothing.
      const further = resizeCrop(next, corner, { x: far.x * 2, y: far.y * 2 }, limits);
      expectRect(further, next);
    },
  );

  it('shrinks a crop of the fit size from any corner back inside the photo', () => {
    const fit = fitWholeCrop(PHOTO, SQUARE);
    // The south-east corner dragged to the middle: 0.5 wide, 2/3 tall, back inside the photo.
    const next = resizeCrop(fit, 'se', { x: 0.5, y: 0.2 }, limits);
    expectRect(next, { x: 0, y: 0, width: 0.5, height: 2 / 3 });
  });

  it('resizes as it did before padding while the corner stays inside the photo', () => {
    /** The resize as it was before crops could have padding. */
    function oldResizeCrop(from: Rect, corner: Corner, pointer: { x: number; y: number }): Rect {
      const fill = focalCrop(PHOTO, ratioOf(SQUARE), CENTRE);
      const clamp = (value: number, min: number, max: number) =>
        Math.min(max, Math.max(min, value));
      const west = corner === 'nw' || corner === 'sw';
      const north = corner === 'nw' || corner === 'ne';
      const anchorX = west ? from.x + from.width : from.x;
      const anchorY = north ? from.y + from.height : from.y;
      const reachX = west ? anchorX - pointer.x : pointer.x - anchorX;
      const reachY = north ? anchorY - pointer.y : pointer.y - anchorY;
      const roomX = west ? anchorX : 1 - anchorX;
      const roomY = north ? anchorY : 1 - anchorY;
      const room = Math.min(roomX, roomY / limits.shape, fill.width);
      const wanted = Math.max(reachX, reachY / limits.shape);
      const width = clamp(wanted, Math.min(limits.min.width, room), room);
      const height = width * limits.shape;
      return {
        x: west ? anchorX - width : anchorX,
        y: north ? anchorY - height : anchorY,
        width,
        height,
      };
    }
    const pointers: Record<Corner, { x: number; y: number }[]> = {
      se: [
        { x: 0.7, y: 0.3 },
        { x: 0.31, y: 0.8 },
        { x: 0.9, y: 1 },
        { x: 0, y: 0 },
      ],
      nw: [
        { x: 0.45, y: 0.55 },
        { x: 0.15, y: 0 },
        { x: 0.2, y: 0.5 },
      ],
      ne: [
        { x: 0.75, y: 0.5 },
        { x: 0.61, y: 0.3 },
      ],
      sw: [
        { x: 0.15, y: 0.3 },
        { x: 0.2, y: 0.7 },
      ],
    };
    for (const corner of ['nw', 'ne', 'sw', 'se'] as Corner[]) {
      for (const pointer of pointers[corner]) {
        const next = resizeCrop(crop, corner, pointer, limits);
        const old = oldResizeCrop(crop, corner, pointer);
        // The size is the very same number. The position is too, except that a crop reaching
        // exactly to an edge of the photo may differ in the last binary place.
        expect(next.width).toBe(old.width);
        expect(next.height).toBe(old.height);
        expect(Math.abs(next.x - old.x)).toBeLessThanOrEqual(Number.EPSILON);
        expect(Math.abs(next.y - old.y)).toBeLessThanOrEqual(Number.EPSILON);
      }
    }
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

  it('brings a crop that is below the smallest size up to it, inside the photo', () => {
    // A corner with less room than the smallest size: the crop slides back to make room.
    const cornered: Rect = { x: 0.95, y: 0.9, width: 0.03, height: 0.04 };
    const next = resizeCrop(cornered, 'se', { x: 1, y: 1 }, limits);
    expect(next.x + next.width).toBeLessThanOrEqual(1 + 1e-12);
    expect(next.y + next.height).toBeLessThanOrEqual(1 + 1e-12);
    expect(next.width).toBeCloseTo(limits.min.width, 12);
    expect(next.height).toBeCloseTo(limits.min.height, 12);
  });

  describe.each(SOURCES)('on a $name photo', ({ source }) => {
    it.each(TARGETS)('every corner drag ends within the limits: $name', ({ target }) => {
      const all = cropLimits(source, target);
      const start = automaticCrop(source, target, { x: 0.3, y: 0.7 });
      for (const corner of ['nw', 'ne', 'sw', 'se'] as Corner[]) {
        for (const pointer of [
          { x: -3, y: -3 },
          { x: 4, y: 4 },
          { x: 0.5, y: 0.5 },
          { x: 1.2, y: -0.1 },
          { x: -0.2, y: 1.3 },
          { x: 0, y: 1 },
        ]) {
          expectWithinLimits(resizeCrop(start, corner, pointer, all), source, target);
        }
      }
    });
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
    // The largest crop is the fit size, which shows the whole photo, centred on it.
    const largest = scaleCrop(crop, 1, limits);
    expectRect(largest, { x: 0, y: -1 / 6, width: 1, height: 4 / 3 });
    expectRect(largest, fitWholeCrop(PHOTO, SQUARE));
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

describe('scaleCrop with padding', () => {
  const limits = cropLimits(PHOTO, SQUARE);

  it('grows past the crop that fills the frame, adding padding above and below', () => {
    // The crop that fills the frame, off to the left: 0.75 wide, the full height.
    const fill: Rect = { x: 0.05, y: 0, width: 0.75, height: 1 };
    const next = scaleCrop(fill, 0.15, limits);
    // 0.9 wide and 1.2 tall, about the same centre.
    expectRect(next, { x: -0.025 + 0.025, y: -0.1, width: 0.9, height: 1.2 });
  });

  it('keeps uneven padding when it has room to', () => {
    // 0.78 by 1.04 with all of its padding below the photo, growing a little.
    const uneven: Rect = { x: 0.1, y: 0, width: 0.78, height: 1.04 };
    const next = scaleCrop(uneven, 0.03, limits);
    // 0.81 by 1.08 about the same centre starts at -0.02; that holds the photo, so it stays.
    expectRect(next, { x: 0.085, y: -0.02, width: 0.81, height: 1.08 });
  });

  it('is pushed towards the centre by the fit frame as it nears the fit size', () => {
    const uneven: Rect = { x: 0.1, y: 0, width: 0.78, height: 1.04 };
    const next = scaleCrop(uneven, 0.2, limits);
    // 0.98 wide is 3.92/3 tall; the fit frame ends at 7/6, so the crop ends there.
    expectRect(next, { x: 0, y: 7 / 6 - 3.92 / 3, width: 0.98, height: 3.92 / 3 });
  });

  it('shrinks from the fit size about the centre of the photo', () => {
    const next = scaleCrop(fitWholeCrop(PHOTO, SQUARE), -0.1, limits);
    expectRect(next, { x: 0.05, y: -0.1, width: 0.9, height: 1.2 });
  });

  it('returns the very same crop at the fit size', () => {
    const fit = scaleCrop({ x: 0.3, y: 0.2, width: 0.3, height: 0.4 }, 5, limits);
    expect(scaleCrop(fit, 0.01, limits)).toBe(fit);
    expect(scaleCrop(fit, 0.1, limits)).toBe(fit);
  });

  describe.each(SOURCES)('on a $name photo', ({ source }) => {
    it.each(TARGETS)(
      'every step from smallest to largest is within the limits: $name',
      ({ target }) => {
        const all = cropLimits(source, target);
        let crop = automaticCrop(source, target, { x: 0.9, y: 0.1 });
        for (let step = 0; step < 400 && crop.width > all.min.width; step++) {
          crop = scaleCrop(crop, -NUDGE_STEP, all);
        }
        expect(crop.width).toBe(all.min.width);
        for (let step = 0; step < 400; step++) {
          expectWithinLimits(crop, source, target);
          const next = scaleCrop(crop, NUDGE_STEP, all);
          if (next === crop) break;
          crop = next;
        }
        // It ends at the fit size, which is the Fit whole photo crop.
        expect(crop.width).toBe(all.max.width);
        expect(sameCrop(crop, fitWholeCrop(source, target))).toBe(true);
      },
    );
  });
});

describe('fitWholeCrop', () => {
  it('is the fit size centred on the photo, whatever the focal point', () => {
    expectRect(fitWholeCrop(PHOTO, SQUARE), { x: 0, y: -1 / 6, width: 1, height: 4 / 3 });
    expectRect(fitWholeCrop({ width: 3000, height: 4000 }, SQUARE), {
      x: -1 / 6,
      y: 0,
      width: 4 / 3,
      height: 1,
    });
  });

  describe.each(SOURCES)('for a $name photo', ({ source }) => {
    it.each(TARGETS)('holds the whole photo in the shape of $name', ({ target }) => {
      const fit = fitWholeCrop(source, target);
      expectWithinLimits(fit, source, target);
      expect(fit.x).toBeLessThanOrEqual(0);
      expect(fit.y).toBeLessThanOrEqual(0);
      expect(fit.x + fit.width).toBeGreaterThanOrEqual(1 - 1e-12);
      expect(fit.y + fit.height).toBeGreaterThanOrEqual(1 - 1e-12);
      // Centred on the photo's centre.
      expect(fit.x + fit.width / 2).toBeCloseTo(0.5, 12);
      expect(fit.y + fit.height / 2).toBeCloseTo(0.5, 12);
      // The renderer and the editor leave it as it is.
      expect(sameCrop(constrainCrop(fit, source, target), fit)).toBe(true);
    });
  });

  it.each(TARGETS)(
    'is the whole photo, with no padding, for a photo shaped like $name',
    ({ target }) => {
      const source = { width: target.width * 2, height: target.height * 2 };
      const whole = { x: 0, y: 0, width: 1, height: 1 };
      expect(sameCrop(fitWholeCrop(source, target), whole)).toBe(true);
      // It is the automatic crop too, wherever the focal point is.
      expect(
        isAutomaticCrop(fitWholeCrop(source, target), source, target, { x: 0.1, y: 0.9 }),
      ).toBe(true);
    },
  );

  it('is not the automatic crop when the shapes differ', () => {
    expect(isAutomaticCrop(fitWholeCrop(PHOTO, SQUARE), PHOTO, SQUARE, CENTRE)).toBe(false);
  });
});

describe('sameCrop', () => {
  const crop: Rect = { x: 0, y: -1 / 6, width: 1, height: 4 / 3 };

  it('is true for crops whose edges differ by no more than the tolerance', () => {
    expect(sameCrop(crop, { ...crop })).toBe(true);
    expect(sameCrop(crop, { ...crop, y: crop.y + 5e-10, height: crop.height - 5e-10 })).toBe(true);
    expect(sameCrop(crop, JSON.parse(JSON.stringify(crop)) as Rect)).toBe(true);
  });

  it('is false when any one edge differs by more', () => {
    const step = 2 * AUTOMATIC_TOLERANCE;
    expect(sameCrop(crop, { ...crop, x: crop.x + step, width: crop.width - step })).toBe(false);
    expect(sameCrop(crop, { ...crop, y: crop.y + step, height: crop.height - step })).toBe(false);
    expect(sameCrop(crop, { ...crop, width: crop.width + step })).toBe(false);
    expect(sameCrop(crop, { ...crop, height: crop.height + step })).toBe(false);
  });

  it('takes a wider tolerance when given one', () => {
    expect(sameCrop(crop, { ...crop, x: 0.001 }, 0.01)).toBe(true);
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

describe('constrainCrop with padding', () => {
  it('leaves a padded crop that is within the limits as the renderer would fit it', () => {
    const crop: Rect = { x: 0.05, y: -0.1, width: 0.9, height: 1.2 };
    expectRect(constrainCrop(crop, PHOTO, SQUARE), crop);
  });

  it('brings a crop larger than the fit size down to it, centred', () => {
    expectRect(constrainCrop({ x: -1, y: -1, width: 3, height: 4 }, PHOTO, SQUARE), {
      x: 0,
      y: -1 / 6,
      width: 1,
      height: 4 / 3,
    });
  });

  it('slides a padded crop that does not hold the photo until it does', () => {
    expectRect(constrainCrop({ x: 0.05, y: 0.3, width: 0.78, height: 1.04 }, PHOTO, SQUARE), {
      x: 0.05,
      y: 0,
      width: 0.78,
      height: 1.04,
    });
  });

  it('slides a padded crop back inside the fit frame', () => {
    expectRect(constrainCrop({ x: 0.05, y: 0, width: 0.9, height: 1.2 }, PHOTO, SQUARE), {
      x: 0.05,
      y: 7 / 6 - 1.2,
      width: 0.9,
      height: 1.2,
    });
  });

  describe.each(SOURCES)('on a $name photo', ({ source }) => {
    it.each(TARGETS)('whatever is stored comes out within the limits: $name', ({ target }) => {
      for (const stored of [
        { x: -2, y: -2, width: 5, height: 5 },
        { x: 0.4, y: -0.3, width: 1.1, height: 0.2 },
        { x: -0.3, y: 0.4, width: 0.2, height: 1.1 },
        { x: 0.9, y: 0.9, width: 1.2, height: 1.2 },
        { x: 0.2, y: 0.2, width: 0.001, height: 0.001 },
        { x: 0, y: 0, width: 1, height: 1 },
      ]) {
        expectWithinLimits(constrainCrop(stored, source, target), source, target);
      }
    });
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
    const moved = moveCrop(auto, 0.001, 0, cropLimits(PHOTO, VERTICAL));
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

  it('can also report a position off the photo as it is, below 0 or above 1', () => {
    const inside = toPhotoPlane({ x: 150, y: 75 }, PHOTO, view);
    expect(inside).toEqual(toPhoto({ x: 150, y: 75 }, PHOTO, view));
    const before = toPhotoPlane({ x: 10, y: -20 }, PHOTO, view);
    expect(before.x).toBeLessThan(0);
    expect(before.y).toBeLessThan(0);
    const after = toPhotoPlane({ x: 499, y: 900 }, PHOTO, view);
    expect(after.x).toBeGreaterThan(1);
    expect(after.y).toBeGreaterThan(1);
    // The same scale as on the photo: twice as far off is twice the fraction.
    const edge = toScreen({ x: 1, y: 1 }, PHOTO, view);
    const beyond = toPhotoPlane({ x: edge.x + 40, y: edge.y + 30 }, PHOTO, view);
    const further = toPhotoPlane({ x: edge.x + 80, y: edge.y + 60 }, PHOTO, view);
    expect(further.x - 1).toBeCloseTo(2 * (beyond.x - 1), 12);
    expect(further.y - 1).toBeCloseTo(2 * (beyond.y - 1), 12);
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
