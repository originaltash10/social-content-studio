/**
 * Crop geometry. Pure arithmetic: no canvas, no platform data, no store access.
 *
 * Two kinds of rectangle appear here. A `Rect` (src/types.ts) is in fractions (0..1) of the
 * source photo, which is how a card stores its crop. A `PixelRect` is in whole source pixels,
 * which is what the image worker draws from.
 *
 * A "ratio" is always width divided by height.
 */

import type { Rect, Size } from '../../types';

export type Point = { x: number; y: number };

/** A rectangle in whole pixels of the source photo. */
export type PixelRect = { x: number; y: number; width: number; height: number };

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
 * Makes a stored crop safe to render at the target ratio. The crop is first trimmed to the
 * photo, then, if its shape differs from the target, shrunk to the largest rectangle of the
 * target ratio centred inside it. A picture is never stretched to fit. A crop with no area left
 * is replaced by the largest centred crop of the photo.
 */
export function fitCropToRatio(crop: Rect, source: Size, ratio: number): Rect {
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

/** A fractional crop as whole source pixels, at least 1 x 1 and always inside the photo. */
export function cropToPixels(crop: Rect, source: Size): PixelRect {
  const width = clamp(Math.round(crop.width * source.width), 1, source.width);
  const height = clamp(Math.round(crop.height * source.height), 1, source.height);
  return {
    x: clamp(Math.round(crop.x * source.width), 0, source.width - width),
    y: clamp(Math.round(crop.y * source.height), 0, source.height - height),
    width,
    height,
  };
}

/**
 * Where the photo's focal point lands in the cropped output, as fractions (0..1) of the output
 * frame. This is the form the validator's safe-zone rule takes. A focal point outside the crop
 * is reported at the nearest edge.
 */
export function focalInFrame(focal: Point, crop: Rect): Point {
  return {
    x: fraction((fraction(focal.x) - crop.x) / crop.width),
    y: fraction((fraction(focal.y) - crop.y) / crop.height),
  };
}
