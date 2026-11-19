import platformData from '../../data/platforms.json';
import type { PlatformsFile, Rect, Size } from '../../types';
import {
  PADDING_TOLERANCE,
  centredOnPhoto,
  cropToPixels,
  fitCropToRatio,
  fitSize,
  focalCrop,
  focalInFrame,
  slideIntoLimits,
  startRange,
} from './crop';

const landscape = { width: 4000, height: 3000 };
const portrait = { width: 3000, height: 4000 };
const square = { width: 3000, height: 3000 };

// Every output shape the app makes, read from the platform data, never written here.
const SHAPES: { name: string; size: Size; ratio: number }[] = (
  platformData as PlatformsFile
).placements.flatMap((spec) =>
  spec.sizes.map((size) => ({
    name: `${spec.platform} ${spec.placement} ${size.width} x ${size.height}`,
    size,
    ratio: size.width / size.height,
  })),
);
const PHOTOS: { name: string; source: Size }[] = [
  { name: 'landscape', source: landscape },
  { name: 'portrait', source: portrait },
  { name: 'square', source: square },
];

/** The crop's shape in photo pixels, width over height. */
const pixelRatio = (crop: Rect | Size, source: Size) =>
  (crop.width * source.width) / (crop.height * source.height);

// ---------------------------------------------------------------------------
// The code as it was before crops could have padding, kept here to compare against: a crop
// inside the photo must come out of the new code exactly as it came out of this.
// ---------------------------------------------------------------------------

const oldClamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const oldFraction = (value: number) => (Number.isFinite(value) ? oldClamp(value, 0, 1) : 0.5);

function oldFitCropToRatio(crop: Rect, source: Size, ratio: number): Rect {
  const left = oldFraction(crop.x);
  const top = oldFraction(crop.y);
  const right = oldFraction(crop.x + crop.width);
  const bottom = oldFraction(crop.y + crop.height);
  if (right <= left || bottom <= top) return focalCrop(source, ratio, { x: 0.5, y: 0.5 });
  const boxWidth = (right - left) * source.width;
  const boxHeight = (bottom - top) * source.height;
  const fit =
    boxWidth / boxHeight > ratio
      ? { width: boxHeight * ratio, height: boxHeight }
      : { width: boxWidth, height: boxWidth / ratio };
  const width = fit.width / source.width;
  const height = fit.height / source.height;
  return {
    x: left + (right - left - width) / 2,
    y: top + (bottom - top - height) / 2,
    width,
    height,
  };
}

function oldCropToPixels(crop: Rect, source: Size) {
  const width = oldClamp(Math.round(crop.width * source.width), 1, source.width);
  const height = oldClamp(Math.round(crop.height * source.height), 1, source.height);
  return {
    x: oldClamp(Math.round(crop.x * source.width), 0, source.width - width),
    y: oldClamp(Math.round(crop.y * source.height), 0, source.height - height),
    width,
    height,
  };
}

/** Crops inside the photo for one photo and shape: the automatic ones and ones at each edge. */
function unpaddedCrops(source: Size, ratio: number): Rect[] {
  const fill = focalCrop(source, ratio, { x: 0.5, y: 0.5 });
  const half = { width: fill.width / 2, height: fill.height / 2 };
  const third = { width: fill.width / 3, height: fill.height / 3 };
  return [
    fill,
    focalCrop(source, ratio, { x: 0, y: 0 }),
    focalCrop(source, ratio, { x: 1, y: 1 }),
    focalCrop(source, ratio, { x: 0.37, y: 0.61 }),
    // Touching the left, top, right and bottom edges in turn, then two corners.
    { x: 0, y: 0.21, ...half },
    { x: 0.17, y: 0, ...half },
    { x: 1 - half.width, y: 0.33, ...half },
    { x: 0.29, y: 1 - half.height, ...half },
    { x: 0, y: 0, ...third },
    { x: 1 - third.width, y: 1 - third.height, ...third },
    // Not touching any edge, and one of the wrong shape.
    { x: 0.123, y: 0.234, ...third },
    { x: 0.1, y: 0.2, width: 0.5, height: 0.3 },
    // The whole photo, and a crop hanging over an edge without being longer than the photo.
    { x: 0, y: 0, width: 1, height: 1 },
    { x: 0.6, y: -0.2, width: 0.7, height: 0.9 },
  ];
}

describe('focalCrop', () => {
  it('uses the full height of a photo that is wider than the target', () => {
    const crop = focalCrop(landscape, 1, { x: 0.5, y: 0.5 });
    expect(crop).toEqual({ x: 0.125, y: 0, width: 0.75, height: 1 });
  });

  it('uses the full width of a photo that is taller than the target', () => {
    const crop = focalCrop(portrait, 1, { x: 0.5, y: 0.5 });
    expect(crop).toEqual({ x: 0, y: 0.125, width: 1, height: 0.75 });
  });

  it('keeps the whole photo when it already has the target ratio', () => {
    expect(focalCrop(landscape, 4 / 3, { x: 0.2, y: 0.9 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it('centres the crop on the focal point', () => {
    const crop = focalCrop(landscape, 1, { x: 0.6, y: 0.5 });
    expect(crop.x + crop.width / 2).toBeCloseTo(0.6);
  });

  it('slides the crop back inside when the focal point is near an edge', () => {
    expect(focalCrop(landscape, 1, { x: 0.95, y: 0.5 }).x).toBeCloseTo(0.25);
    expect(focalCrop(landscape, 1, { x: 0.05, y: 0.5 }).x).toBe(0);
    expect(focalCrop(portrait, 1, { x: 0.5, y: 1 }).y).toBeCloseTo(0.25);
    expect(focalCrop(portrait, 1, { x: 0.5, y: 0 }).y).toBe(0);
  });

  it('treats a focal point outside 0..1 as the nearest edge and a non-number as the middle', () => {
    expect(focalCrop(landscape, 1, { x: 7, y: -3 }).x).toBeCloseTo(0.25);
    expect(focalCrop(landscape, 1, { x: Number.NaN, y: Number.NaN }).x).toBeCloseTo(0.125);
  });
});

describe('fitCropToRatio', () => {
  it('leaves a crop that already has the target ratio alone', () => {
    const crop = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }; // 1200 x 1200 px
    const fitted = fitCropToRatio(crop, landscape, 1);
    expect(fitted.x).toBeCloseTo(0.1);
    expect(fitted.y).toBeCloseTo(0.2);
    expect(fitted.width).toBeCloseTo(0.3);
    expect(fitted.height).toBeCloseTo(0.4);
  });

  it('shrinks a crop that is too wide, keeping it centred, without stretching', () => {
    const fitted = fitCropToRatio({ x: 0, y: 0, width: 1, height: 1 }, landscape, 1);
    expect(fitted).toEqual({ x: 0.125, y: 0, width: 0.75, height: 1 });
  });

  it('shrinks a crop that is too tall, keeping it centred', () => {
    const fitted = fitCropToRatio({ x: 0, y: 0, width: 1, height: 1 }, portrait, 1);
    expect(fitted).toEqual({ x: 0, y: 0.125, width: 1, height: 0.75 });
  });

  it('trims a crop that hangs outside the photo, and is no longer than it, before fitting it', () => {
    const fitted = fitCropToRatio({ x: 0.5, y: -0.25, width: 1, height: 0.75 }, landscape, 4 / 3);
    expect(fitted.x).toBeCloseTo(0.5);
    expect(fitted.y).toBeCloseTo(0);
    expect(fitted.width).toBeCloseTo(0.5);
    expect(fitted.height).toBeCloseTo(0.5);
  });

  it('brings a crop longer than the photo down to the fit size, centred', () => {
    // The photo already has this shape, so the fit size is the photo and there is no padding.
    const fitted = fitCropToRatio({ x: 0.5, y: -0.5, width: 2, height: 2 }, landscape, 4 / 3);
    expect(fitted).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('falls back to the largest centred crop when the crop has no area', () => {
    const centred = { x: 0.125, y: 0, width: 0.75, height: 1 };
    expect(fitCropToRatio({ x: 0.4, y: 0.4, width: 0, height: 0.2 }, landscape, 1)).toEqual(
      centred,
    );
    expect(fitCropToRatio({ x: 0.4, y: 0.4, width: 0.2, height: 0 }, landscape, 1)).toEqual(
      centred,
    );
    expect(
      fitCropToRatio({ x: Number.NaN, y: 0, width: Number.NaN, height: 1 }, landscape, 1),
    ).toEqual(centred);
  });
});

describe('cropToPixels', () => {
  it('converts fractions to whole source pixels', () => {
    expect(cropToPixels({ x: 0.125, y: 0, width: 0.75, height: 1 }, landscape)).toEqual({
      x: 500,
      y: 0,
      width: 3000,
      height: 3000,
    });
  });

  it('rounds to the nearest pixel', () => {
    expect(
      cropToPixels({ x: 0.3334, y: 0.3334, width: 0.3333, height: 0.3333 }, landscape),
    ).toEqual({ x: 1334, y: 1000, width: 1333, height: 1000 });
  });

  it('never returns an empty rectangle or one outside the photo', () => {
    expect(cropToPixels({ x: 1, y: 1, width: 0, height: 0 }, landscape)).toEqual({
      x: 3999,
      y: 2999,
      width: 1,
      height: 1,
    });
  });

  it('keeps a crop longer than the photo around the photo', () => {
    expect(cropToPixels({ x: -1, y: -1, width: 5, height: 5 }, landscape)).toEqual({
      x: -4000,
      y: -3000,
      width: 20000,
      height: 15000,
    });
    // Too far left and too far down to contain the photo: slid until it does.
    expect(cropToPixels({ x: -3, y: 0.5, width: 2, height: 2 }, landscape)).toEqual({
      x: -4000,
      y: 0,
      width: 8000,
      height: 6000,
    });
  });

  it('gives padding in whole pixels on the padded axis only', () => {
    // A square crop showing the whole landscape photo: 4000 x 4000, 500 px above and below.
    const crop = centredOnPhoto(fitSize(landscape, 1));
    expect(cropToPixels(crop, landscape)).toEqual({ x: 0, y: -500, width: 4000, height: 4000 });
  });

  it('never returns negative zero', () => {
    const pixels = cropToPixels({ x: -0.0001, y: -0.0001, width: 1, height: 1.0002 }, landscape);
    expect(Object.is(pixels.x, 0)).toBe(true);
    expect(Object.is(pixels.y, 0)).toBe(true);
  });

  describe.each(PHOTOS)('a crop inside a $name photo', ({ source }) => {
    it.each(SHAPES)('comes out exactly as before for $name', ({ ratio }) => {
      for (const crop of unpaddedCrops(source, ratio)) {
        const fitted = fitCropToRatio(crop, source, ratio);
        expect(cropToPixels(fitted, source)).toEqual(oldCropToPixels(fitted, source));
        expect(cropToPixels(crop, source)).toEqual(oldCropToPixels(crop, source));
      }
    });
  });
});

describe('fitSize', () => {
  describe.each(PHOTOS)('for a $name photo', ({ source }) => {
    it.each(SHAPES)('is the smallest crop of $name that holds the whole photo', ({ ratio }) => {
      const fit = fitSize(source, ratio);
      expect(pixelRatio(fit, source)).toBeCloseTo(ratio, 12);
      // It holds the photo on both axes, and is exactly the photo's length on one of them.
      expect(fit.width).toBeGreaterThanOrEqual(1);
      expect(fit.height).toBeGreaterThanOrEqual(1);
      expect(Math.min(fit.width, fit.height)).toBe(1);
      // It is never smaller than the crop that fills the frame.
      const fill = focalCrop(source, ratio, { x: 0.5, y: 0.5 });
      expect(fit.width).toBeGreaterThanOrEqual(fill.width);
      expect(fit.height).toBeGreaterThanOrEqual(fill.height);
    });
  });

  it('pads above and below a photo that is wider than the shape', () => {
    expect(fitSize(landscape, 1)).toEqual({ width: 1, height: 4 / 3 });
  });

  it('pads left and right of a photo that is taller than the shape', () => {
    expect(fitSize(portrait, 1)).toEqual({ width: 4 / 3, height: 1 });
  });

  it.each(SHAPES)('is the whole photo when the photo has the shape of $name', ({ size }) => {
    for (const scale of [1, 2, 3]) {
      const source = { width: size.width * scale, height: size.height * scale };
      const fit = fitSize(source, size.width / size.height);
      expect(fit.width).toBeCloseTo(1, 12);
      expect(fit.height).toBe(1);
      // Close enough to the photo that neither axis counts as padded.
      expect(fit.width).toBeLessThanOrEqual(1 + PADDING_TOLERANCE);
    }
  });
});

describe('centredOnPhoto', () => {
  it('puts the same padding on both sides', () => {
    expect(centredOnPhoto({ width: 1, height: 1.5 })).toEqual({
      x: 0,
      y: -0.25,
      width: 1,
      height: 1.5,
    });
    expect(centredOnPhoto({ width: 0.5, height: 0.5 })).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });
  });
});

describe('startRange', () => {
  it('keeps a crop no longer than the photo inside the photo', () => {
    expect(startRange(0.4, 1.5)).toEqual({ min: 0, max: 0.6 });
    expect(startRange(1, 1.5)).toEqual({ min: 0, max: 0 });
  });

  it('lets a longer crop slide while it holds the photo and stays in the fit frame', () => {
    // Fit length 1.5: the fit frame runs from -0.25 to 1.25.
    const slightly = startRange(1.1, 1.5);
    // Holding the photo is the tighter limit here: from -0.1 to 0.
    expect(slightly.min).toBeCloseTo(-0.1, 12);
    expect(slightly.max).toBe(0);
    const nearly = startRange(1.4, 1.5);
    // The fit frame is the tighter limit here: from -0.25 to -0.15.
    expect(nearly.min).toBe(-0.25);
    expect(nearly.max).toBeCloseTo(-0.15, 12);
  });

  it('leaves one place, centred, at the full fit length', () => {
    expect(startRange(1.5, 1.5)).toEqual({ min: -0.25, max: -0.25 });
    for (const fit of [4 / 3, 5 / 3, 1.91, 3.1604938271604937]) {
      const { min, max } = startRange(fit, fit);
      expect(min).toBeCloseTo((1 - fit) / 2, 12);
      expect(max).toBeCloseTo((1 - fit) / 2, 12);
    }
  });

  it('treats a length past the photo by no more than rounding as the photo length', () => {
    const dust = 1 + Number.EPSILON;
    expect(startRange(dust, 1.5)).toEqual({ min: 0, max: 1 - dust });
    expect(startRange(1 + PADDING_TOLERANCE, 1.5).min).toBe(0);
    // Just past the tolerance it is padded, and the range is still next to nothing.
    const padded = startRange(1 + 2 * PADDING_TOLERANCE, 1.5);
    expect(padded.min).toBeLessThan(0);
    expect(padded.min).toBeGreaterThan(-3 * PADDING_TOLERANCE);
    expect(padded.max).toBe(0);
  });

  it('has no room to slide on the axis where the fit size is the photo', () => {
    expect(startRange(1, 1)).toEqual({ min: 0, max: 0 });
  });
});

describe('slideIntoLimits', () => {
  const fit = { width: 1, height: 1.5 };

  it('leaves a crop that is within the limits exactly as it is', () => {
    const inside = { x: 0.2, y: 0.3, width: 0.4, height: 0.6 };
    expect(slideIntoLimits(inside, fit)).toEqual(inside);
    const padded = { x: 0.1, y: -0.1, width: 0.8, height: 1.2 };
    expect(slideIntoLimits(padded, fit)).toEqual(padded);
  });

  it('slides each axis by its own rule and keeps the size', () => {
    // Across, no longer than the photo: back inside. Down, longer: until it holds the photo.
    expect(slideIntoLimits({ x: 0.5, y: 0.1, width: 0.8, height: 1.2 }, fit)).toEqual({
      x: 1 - 0.8,
      y: 0,
      width: 0.8,
      height: 1.2,
    });
    expect(slideIntoLimits({ x: -0.5, y: -0.9, width: 0.8, height: 1.2 }, fit)).toEqual({
      x: 0,
      y: 1 - 1.2,
      width: 0.8,
      height: 1.2,
    });
  });

  it('keeps a padded crop inside the fit frame', () => {
    // 1.4 long in a fit frame from -0.25 to 1.25: it may start from -0.25 to -0.15.
    expect(slideIntoLimits({ x: 0, y: -0.4, width: 1, height: 1.4 }, fit).y).toBe(-0.25);
    expect(slideIntoLimits({ x: 0, y: 0, width: 1, height: 1.4 }, fit).y).toBeCloseTo(-0.15, 12);
  });

  it('centres a crop of the fit size wherever it was', () => {
    for (const y of [-2, -0.25, 0, 3]) {
      expect(slideIntoLimits({ x: 0.3, y, width: 1, height: 1.5 }, fit)).toEqual({
        x: 0,
        y: -0.25,
        width: 1,
        height: 1.5,
      });
    }
  });
});

describe('fitCropToRatio with padding', () => {
  // A square from the landscape photo: the fit size is 1 wide and 4/3 tall.
  const fit = fitSize(landscape, 1);

  it('leaves a padded crop that is within the limits where it is', () => {
    const crop = { x: 0.05, y: -0.1, width: 0.9, height: 1.2 };
    const fitted = fitCropToRatio(crop, landscape, 1);
    expect(fitted.x).toBeCloseTo(crop.x, 12);
    expect(fitted.y).toBeCloseTo(crop.y, 12);
    expect(fitted.width).toBeCloseTo(crop.width, 12);
    expect(fitted.height).toBeCloseTo(crop.height, 12);
  });

  it('leaves the fit frame where it is', () => {
    const frame = centredOnPhoto(fit);
    const fitted = fitCropToRatio(frame, landscape, 1);
    expect(fitted.x).toBeCloseTo(0, 12);
    expect(fitted.y).toBeCloseTo(-1 / 6, 12);
    expect(fitted.width).toBeCloseTo(1, 12);
    expect(fitted.height).toBeCloseTo(4 / 3, 12);
  });

  it('gives the same answer when it is given its own answer', () => {
    for (const crop of [
      { x: 0.05, y: -0.1, width: 0.9, height: 1.2 },
      { x: -3, y: 4, width: 9, height: 2 },
      centredOnPhoto(fit),
    ]) {
      const once = fitCropToRatio(crop, landscape, 1);
      const twice = fitCropToRatio(once, landscape, 1);
      expect(twice.x).toBeCloseTo(once.x, 12);
      expect(twice.y).toBeCloseTo(once.y, 12);
      expect(twice.width).toBeCloseTo(once.width, 12);
      expect(twice.height).toBeCloseTo(once.height, 12);
    }
  });

  it('shrinks a padded crop of the wrong shape about its centre, without stretching', () => {
    // 3600 x 4500 px, centred on (0.5, 0.5): the square inside it is 3600 px, 0.9 by 1.2.
    const fitted = fitCropToRatio({ x: 0.05, y: -0.25, width: 0.9, height: 1.5 }, landscape, 1);
    expect(fitted.x).toBeCloseTo(0.05, 12);
    expect(fitted.y).toBeCloseTo(-0.1, 12);
    expect(fitted.width).toBeCloseTo(0.9, 12);
    expect(fitted.height).toBeCloseTo(1.2, 12);
    expect(pixelRatio(fitted, landscape)).toBeCloseTo(1, 12);
  });

  it('slides a crop that no longer needs padding back inside the photo', () => {
    // 1.2 tall but only 0.3 wide: the square inside it is 0.3 by 0.4, and it hangs over the top.
    const fitted = fitCropToRatio({ x: 0.2, y: -0.5, width: 0.3, height: 1.2 }, landscape, 1);
    expect(fitted.x).toBeCloseTo(0.2, 12);
    expect(fitted.y).toBeCloseTo(0, 12);
    expect(fitted.width).toBeCloseTo(0.3, 12);
    expect(fitted.height).toBeCloseTo(0.4, 12);
  });

  it('never returns a crop larger than the fit size, and centres one that was', () => {
    for (const crop of [
      { x: -1, y: -1, width: 3, height: 4 },
      { x: 0.4, y: 0.4, width: 1.5, height: 2 },
      { x: -7, y: 2, width: 1.0001, height: 4.0004 / 3 },
    ]) {
      const fitted = fitCropToRatio(crop, landscape, 1);
      expect(fitted.width).toBe(fit.width);
      expect(fitted.height).toBe(fit.height);
      expect(fitted.x).toBe(0);
      expect(fitted.y).toBeCloseTo(-1 / 6, 12);
    }
  });

  it('slides a padded crop until it holds the photo', () => {
    // 0.78 by 1.04, placed so the photo sticks out below it, then above it.
    const low = fitCropToRatio({ x: 0, y: -0.6, width: 0.78, height: 1.04 }, landscape, 1);
    expect(low.y).toBeCloseTo(1 - 1.04, 12);
    const high = fitCropToRatio({ x: 0, y: 0.3, width: 0.78, height: 1.04 }, landscape, 1);
    expect(high.y).toBe(0);
    // Across it is no longer than the photo, so it is slid back inside.
    const right = fitCropToRatio({ x: 0.5, y: -0.02, width: 0.78, height: 1.04 }, landscape, 1);
    expect(right.x).toBeCloseTo(0.22, 12);
  });

  it('keeps a padded crop inside the fit frame', () => {
    // 0.99 by 1.32 in a fit frame from -1/6 to 7/6: it may start no higher than 7/6 - 1.32.
    const fitted = fitCropToRatio({ x: 0, y: 0, width: 0.99, height: 1.32 }, landscape, 1);
    expect(fitted.y).toBeCloseTo(7 / 6 - 1.32, 12);
    expect(fitted.y + fitted.height).toBeCloseTo(7 / 6, 12);
  });

  it('treats a crop past the photo by no more than rounding exactly as before', () => {
    const dust = 1 + Number.EPSILON;
    for (const crop of [
      { x: 0.2, y: 0, width: 0.6, height: dust },
      { x: 0, y: 0.125, width: dust, height: 0.75 },
      { x: 0, y: 0, width: 1 + PADDING_TOLERANCE, height: 1 + PADDING_TOLERANCE },
    ]) {
      expect(fitCropToRatio(crop, landscape, 1)).toEqual(oldFitCropToRatio(crop, landscape, 1));
    }
  });

  it('falls back as before for a large crop that is not made of usable numbers', () => {
    const centred = { x: 0.125, y: 0, width: 0.75, height: 1 };
    for (const crop of [
      { x: Number.NaN, y: 0, width: 2, height: 2 },
      { x: 0, y: Number.NaN, width: 2, height: 2 },
      { x: 0, y: 0, width: 2, height: 0 },
      { x: 0, y: 0, width: -1, height: 2 },
    ]) {
      expect(fitCropToRatio(crop, landscape, 1)).toEqual(centred);
    }
    for (const crop of [
      { x: 0, y: 0, width: 2, height: Number.NaN },
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 2 },
      { x: 0, y: 0, width: 2, height: Number.POSITIVE_INFINITY },
      { x: Number.NEGATIVE_INFINITY, y: 0, width: 2, height: 2 },
      { x: 0, y: Number.NEGATIVE_INFINITY, width: 2, height: 2 },
    ]) {
      expect(fitCropToRatio(crop, landscape, 1)).toEqual(oldFitCropToRatio(crop, landscape, 1));
    }
  });

  describe.each(PHOTOS)('a crop inside a $name photo', ({ source }) => {
    it.each(SHAPES)('is fitted exactly as before for $name', ({ ratio }) => {
      for (const crop of unpaddedCrops(source, ratio)) {
        expect(fitCropToRatio(crop, source, ratio)).toEqual(oldFitCropToRatio(crop, source, ratio));
      }
    });
  });

  describe.each(PHOTOS)('the fit frame of a $name photo', ({ source }) => {
    it.each(SHAPES)('is kept, within the limits, for $name', ({ ratio }) => {
      const limit = fitSize(source, ratio);
      const fitted = fitCropToRatio(centredOnPhoto(limit), source, ratio);
      expect(fitted.width).toBeCloseTo(limit.width, 12);
      expect(fitted.height).toBeCloseTo(limit.height, 12);
      expect(fitted.x).toBeCloseTo((1 - limit.width) / 2, 12);
      expect(fitted.y).toBeCloseTo((1 - limit.height) / 2, 12);
      // It holds the whole photo.
      expect(fitted.x).toBeLessThanOrEqual(1e-12);
      expect(fitted.y).toBeLessThanOrEqual(1e-12);
      expect(fitted.x + fitted.width).toBeGreaterThanOrEqual(1 - 1e-12);
      expect(fitted.y + fitted.height).toBeGreaterThanOrEqual(1 - 1e-12);
    });
  });
});

describe('focalInFrame', () => {
  const crop = { x: 0.25, y: 0, width: 0.5, height: 1 };

  it('maps the focal point into fractions of the output frame', () => {
    expect(focalInFrame({ x: 0.5, y: 0.3 }, crop)).toEqual({ x: 0.5, y: 0.3 });
    expect(focalInFrame({ x: 0.375, y: 1 }, crop)).toEqual({ x: 0.25, y: 1 });
  });

  it('measures from the corner of a crop with padding', () => {
    // 0.25 of padding above the photo in a crop 1.5 tall: the photo's top is 1/6 down the frame.
    const padded = { x: 0, y: -0.25, width: 1, height: 1.5 };
    expect(focalInFrame({ x: 0.5, y: 0 }, padded).y).toBeCloseTo(1 / 6, 12);
    expect(focalInFrame({ x: 0.5, y: 1 }, padded).y).toBeCloseTo(5 / 6, 12);
    expect(focalInFrame({ x: 0.25, y: 0.5 }, padded)).toEqual({ x: 0.25, y: 0.5 });
  });

  it('reports a focal point outside the crop at the nearest edge', () => {
    expect(focalInFrame({ x: 0.1, y: 0.5 }, crop).x).toBe(0);
    expect(focalInFrame({ x: 0.9, y: 0.5 }, crop).x).toBe(1);
  });
});
