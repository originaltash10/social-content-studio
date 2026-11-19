/**
 * Crop geometry. Pure arithmetic: no canvas, no platform data, no store access.
 *
 * Two kinds of rectangle appear here. A `Rect` (src/types.ts) is in fractions of the source
 * photo, which is how a card stores its crop. A `PixelRect` is in whole source pixels, which is
 * what the image worker draws from.
 *
 * A "ratio" is always width divided by height.
 *
 * Crop limits (SPEC.md, "Crop limits"). A crop may be larger than the photo, and the space
 * outside the photo is then padding. Each axis is treated separately. On an axis where the crop
 * is no longer than the photo, it stays inside the photo. On an axis where it is longer, it
 * contains the photo and stays inside the fit frame: the smallest crop of the target ratio that
 * contains the whole photo, centred on the photo. A crop is never larger than that.
 */

import type { Rect, Size } from '../../types';

export type Point = { x: number; y: number };

/**
 * A rectangle in whole pixels of the source photo. A crop with padding starts before 0 or ends
 * past the photo's size on the padded axis.
 */
export type PixelRect = { x: number; y: number; width: number; height: number };

/**
 * How much longer than the photo a crop must be, as a fraction of the photo, before that axis
 * counts as padded. Anything less is rounding, and the crop is treated as inside the photo.
 */
export const PADDING_TOLERANCE = 1e-9;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A fraction kept inside 0..1; anything that is not a number becomes the middle. */
const fraction = (value: number) => (Number.isFinite(value) ? clamp(value, 0, 1) : 0.5);

/** The largest width and height of the given ratio that fit inside a box, in the box's units. */
function largestFit(boxWidth: number, boxHeight: number, ratio: number): Size {
  return boxWidth / boxHeight > ratio
    ? { width: boxHeight * ratio, height: boxHeight }
    : { width: boxWidth, height: boxWidth / ratio };
}

/**
 * The fit size: the smallest width and height of the given ratio that contain the whole photo,
 * in fractions of the photo. One of the two is 1 and the other is 1 or more.
 */
export function fitSize(source: Size, ratio: number): Size {
  return source.width / source.height > ratio
    ? { width: 1, height: source.width / ratio / source.height }
    : { width: (source.height * ratio) / source.width, height: 1 };
}

/** A size centred on the photo's centre. The fit size placed this way is the fit frame. */
export function centredOnPhoto(size: Size): Rect {
  return {
    x: (1 - size.width) / 2,
    y: (1 - size.height) / 2,
    width: size.width,
    height: size.height,
  };
}

/**
 * Where a crop may start on one axis, in fractions of the photo. `length` is the crop's length
 * on that axis and `fitLength` the fit size's. A crop no longer than the photo stays inside the
 * photo. A longer one contains the photo and stays inside the fit frame, so at the full fit
 * length there is one place for it: centred.
 */
export function startRange(length: number, fitLength: number): { min: number; max: number } {
  if (length <= 1 + PADDING_TOLERANCE) return { min: 0, max: 1 - length };
  return {
    min: Math.max(1 - length, (1 - fitLength) / 2),
    max: Math.min(0, (1 + fitLength) / 2 - length),
  };
}

/** A crop slid, without changing its size, to where the crop limits allow it on each axis. */
export function slideIntoLimits(crop: Rect, fit: Size): Rect {
  const across = startRange(crop.width, fit.width);
  const down = startRange(crop.height, fit.height);
  return {
    x: clamp(crop.x, across.min, across.max),
    y: clamp(crop.y, down.min, down.max),
    width: crop.width,
    height: crop.height,
  };
}

/**
 * The default crop for a photo: the largest rectangle of the target ratio that fits inside the
 * photo, centred on the focal point, then slid back inside the photo where it would hang over
 * an edge. So the crop always uses the full height or the full width of the photo, and the
 * focal point is at its centre unless it is too close to an edge for that.
 */
export function focalCrop(source: Size, ratio: number, focal: Point): Rect {
  const fit = largestFit(source.width, source.height, ratio);
  const width = fit.width / source.width;
  const height = fit.height / source.height;
  return {
    x: clamp(fraction(focal.x) - width / 2, 0, 1 - width),
    y: clamp(fraction(focal.y) - height / 2, 0, 1 - height),
    width,
    height,
  };
}

/**
 * Makes a stored crop safe to render at the target ratio. A picture is never stretched to fit.
 *
 * A crop no longer than the photo on either axis is handled exactly as it always was: trimmed
 * to the photo, then, if its shape differs from the target, shrunk to the largest rectangle of
 * the target ratio centred inside it. A crop with no area left is replaced by the largest
 * centred crop of the photo.
 *
 * A crop longer than the photo on an axis has padding. It is shrunk to the target ratio about
 * its centre, then to the fit size if it is larger than that, and then slid to where the crop
 * limits allow (`slideIntoLimits`).
 */
export function fitCropToRatio(crop: Rect, source: Size, ratio: number): Rect {
  const padded =
    Number.isFinite(crop.x) &&
    Number.isFinite(crop.y) &&
    Number.isFinite(crop.width) &&
    Number.isFinite(crop.height) &&
    crop.width > 0 &&
    crop.height > 0 &&
    (crop.width > 1 + PADDING_TOLERANCE || crop.height > 1 + PADDING_TOLERANCE);
  return padded ? fitPaddedCrop(crop, source, ratio) : fitCropInsidePhoto(crop, source, ratio);
}

function fitPaddedCrop(crop: Rect, source: Size, ratio: number): Rect {
  const limit = fitSize(source, ratio);
  const shaped = largestFit(crop.width * source.width, crop.height * source.height, ratio);
  const width = Math.min(shaped.width / source.width, limit.width);
  const height = Math.min(shaped.height / source.height, limit.height);
  return slideIntoLimits(
    {
      x: crop.x + crop.width / 2 - width / 2,
      y: crop.y + crop.height / 2 - height / 2,
      width,
      height,
    },
    limit,
  );
}

/** The crop fitting used before crops could have padding, kept exactly as it was. */
function fitCropInsidePhoto(crop: Rect, source: Size, ratio: number): Rect {
  const left = fraction(crop.x);
  const top = fraction(crop.y);
  const right = fraction(crop.x + crop.width);
  const bottom = fraction(crop.y + crop.height);
  if (right <= left || bottom <= top) return focalCrop(source, ratio, { x: 0.5, y: 0.5 });

  const boxWidth = (right - left) * source.width;
  const boxHeight = (bottom - top) * source.height;
  const fit = largestFit(boxWidth, boxHeight, ratio);
  const width = fit.width / source.width;
  const height = fit.height / source.height;
  return {
    x: left + (right - left - width) / 2,
    y: top + (bottom - top - height) / 2,
    width,
    height,
  };
}

/** A whole number of pixels; never negative zero. */
const whole = (value: number) => Math.round(value) + 0;

/**
 * A fractional crop as whole source pixels, at least 1 x 1. The crop limits are kept in pixels
 * too: on an axis where the crop is no longer than the photo it is inside the photo, and on an
 * axis where it is longer it contains the photo.
 */
export function cropToPixels(crop: Rect, source: Size): PixelRect {
  const width = Math.max(1, whole(crop.width * source.width));
  const height = Math.max(1, whole(crop.height * source.height));
  const roomAcross = source.width - width;
  const roomDown = source.height - height;
  return {
    x: clamp(whole(crop.x * source.width), Math.min(0, roomAcross), Math.max(0, roomAcross)),
    y: clamp(whole(crop.y * source.height), Math.min(0, roomDown), Math.max(0, roomDown)),
    width,
    height,
  };
}

/** What one render draws: which part of the photo, and where in the output it goes. */
export type DrawRects = {
  /** The part of the crop that overlaps the photo, in source pixels. Never outside the photo. */
  source: PixelRect;
  /** Where that part goes in the output, in whole output pixels. */
  dest: PixelRect;
};

/**
 * Splits a crop into the part to draw from the photo and where it lands in the output. A crop
 * inside the photo is drawn whole, onto the whole output. A crop with padding is drawn only
 * where it overlaps the photo, and the rest of the output is padding.
 *
 * The four edges of `dest` are each rounded to a whole output pixel once. The padding is made
 * from the same four numbers (`paddingRects`), so the photo and the padding meet exactly, with
 * no seam and no gap.
 */
export function drawRects(crop: PixelRect, source: Size, target: Size): DrawRects {
  const left = Math.max(crop.x, 0);
  const top = Math.max(crop.y, 0);
  const right = Math.min(crop.x + crop.width, source.width);
  const bottom = Math.min(crop.y + crop.height, source.height);
  const across = (x: number) => whole(((x - crop.x) * target.width) / crop.width);
  const down = (y: number) => whole(((y - crop.y) * target.height) / crop.height);
  const dest = { x: across(left), y: down(top) };
  return {
    source: { x: left, y: top, width: right - left, height: bottom - top },
    dest: { ...dest, width: across(right) - dest.x, height: down(bottom) - dest.y },
  };
}

/**
 * The parts of the output that the photo does not cover, given where the photo is drawn: a
 * strip above it and one below it across the whole width, and one to each side of it. Only the
 * strips that have any area are returned, so a photo that covers the output gives none.
 */
export function paddingRects(dest: PixelRect, target: Size): PixelRect[] {
  const right = dest.x + dest.width;
  const bottom = dest.y + dest.height;
  return [
    { x: 0, y: 0, width: target.width, height: dest.y },
    { x: 0, y: bottom, width: target.width, height: target.height - bottom },
    { x: 0, y: dest.y, width: dest.x, height: dest.height },
    { x: right, y: dest.y, width: target.width - right, height: dest.height },
  ].filter((strip) => strip.width > 0 && strip.height > 0);
}

/**
 * Where the photo's focal point lands in the cropped output, as fractions (0..1) of the output
 * frame. This is the form the validator's safe-zone rule takes. A focal point outside the crop
 * is reported at the nearest edge. With padding the frame is larger than the photo, and the
 * point is still measured from the crop's own corner.
 */
export function focalInFrame(focal: Point, crop: Rect): Point {
  return {
    x: fraction((fraction(focal.x) - crop.x) / crop.width),
    y: fraction((fraction(focal.y) - crop.y) / crop.height),
  };
}
