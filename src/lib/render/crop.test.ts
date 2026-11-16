import { cropToPixels, fitCropToRatio, focalCrop, focalInFrame } from './crop';

const landscape = { width: 4000, height: 3000 };
const portrait = { width: 3000, height: 4000 };

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

  it('trims a crop that hangs outside the photo before fitting it', () => {
    const fitted = fitCropToRatio({ x: 0.5, y: -0.5, width: 2, height: 2 }, landscape, 4 / 3);
    expect(fitted.x).toBeCloseTo(0.5);
    expect(fitted.y).toBeCloseTo(0.25);
    expect(fitted.width).toBeCloseTo(0.5);
    expect(fitted.height).toBeCloseTo(0.5);
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
    expect(cropToPixels({ x: -1, y: -1, width: 5, height: 5 }, landscape)).toEqual({
      x: 0,
      y: 0,
      width: 4000,
      height: 3000,
    });
  });
});

describe('focalInFrame', () => {
  const crop = { x: 0.25, y: 0, width: 0.5, height: 1 };

  it('maps the focal point into fractions of the output frame', () => {
    expect(focalInFrame({ x: 0.5, y: 0.3 }, crop)).toEqual({ x: 0.5, y: 0.3 });
    expect(focalInFrame({ x: 0.375, y: 1 }, crop)).toEqual({ x: 0.25, y: 1 });
  });

  it('reports a focal point outside the crop at the nearest edge', () => {
    expect(focalInFrame({ x: 0.1, y: 0.5 }, crop).x).toBe(0);
    expect(focalInFrame({ x: 0.9, y: 0.5 }, crop).x).toBe(1);
  });
});
