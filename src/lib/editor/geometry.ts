/**
 * Geometry for the editor: moving and resizing a card's crop, the limits on its size, telling an
 * automatic crop from a hand-adjusted one, and mapping between the screen and the photo. Pure
 * arithmetic: no canvas, no DOM, no store access, and no platform numbers (the output size is
 * passed in, read from src/data/platforms.json by the caller).
 *
 * Coordinates. A crop and a focal point are stored as fractions (0..1) of the photo as it is
 * displayed, that is after any rotation recorded in the file has been applied. This is the same
 * space the renderer draws from (src/lib/render/crop.ts), and `source` is always the photo's
 * size in that space: `Asset.width` by `Asset.height`.
 *
 * A crop is locked to the shape of the placement, so one number, its width, fixes its size.
 *
 * A crop may be larger than the photo, up to the fit size, and the space outside the photo is
 * then padding. Where a crop may sit is decided for each axis separately; the rule is written
 * out in src/lib/render/crop.ts and SPEC.md ("Crop limits").
 */

import {
  centredOnPhoto,
  fitCropToRatio,
  fitSize,
  focalCrop,
  slideIntoLimits,
} from '../render/crop';
import type { Point } from '../render/crop';
import type { Rect, Size } from '../../types';

export type { Point };

/** The corner of the crop being dragged, by compass direction. */
export type Corner = 'nw' | 'ne' | 'sw' | 'se';

/** Cropping alone never enlarges a picture by more than this, unless the photo itself is small. */
export const MAX_ENLARGEMENT = 2;

/** How far apart two crop edges may be, as a fraction of the photo, and still count as equal. */
export const AUTOMATIC_TOLERANCE = 1e-9;

/** How far an arrow key moves the crop or the focal point, as a fraction of the photo. */
export const NUDGE_STEP = 0.01;
/** The same with Shift held. */
export const NUDGE_BIG_STEP = 0.1;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The smallest and largest crop a card may have, as fractions of the photo. */
export type CropLimits = {
  min: Size;
  max: Size;
  /** A crop's height for each unit of its width, in fractions of the photo. */
  shape: number;
  /** The fit size: the smallest crop of the output's shape that contains the whole photo. */
  fit: Size;
};

/**
 * The limits on a crop for a photo and an output size. The smallest crop is the output size
 * divided by MAX_ENLARGEMENT, or the largest crop that fits inside the photo when the photo is
 * too small even for that. The largest crop is the fit size, which shows the whole photo with
 * padding. The smallest crop is never larger than the fit size; if it ever were, it would be
 * the largest crop too.
 */
export function cropLimits(source: Size, target: Size): CropLimits {
  const ratio = target.width / target.height;
  const fill = focalCrop(source, ratio, { x: 0.5, y: 0.5 });
  const shape = fill.height / fill.width;
  const width = Math.min(target.width / MAX_ENLARGEMENT / source.width, fill.width);
  const min = { width, height: width * shape };
  const fit = fitSize(source, ratio);
  return {
    min,
    max: { width: Math.max(fit.width, min.width), height: Math.max(fit.height, min.height) },
    shape,
    fit,
  };
}

/**
 * The crop moved by a distance, in fractions of the photo, and kept within the crop limits: on
 * an axis where it is no longer than the photo it stays inside the photo, and on an axis where
 * it is longer it keeps the photo inside it and stays inside the fit frame.
 */
export function moveCrop(crop: Rect, dx: number, dy: number, limits: CropLimits): Rect {
  return slideIntoLimits({ ...crop, x: crop.x + dx, y: crop.y + dy }, limits.fit);
}

/**
 * The crop after dragging one corner to `pointer` (a point in fractions of the photo, which may
 * be outside it). The shape is kept, and the crop follows the pointer along whichever axis it
 * has travelled further, between the smallest size and the largest. The opposite corner stays
 * where it is for as long as the crop limits allow; a crop that grows past the photo's edge is
 * slid to where the limits allow, so at the largest size it is centred on the photo.
 */
export function resizeCrop(crop: Rect, corner: Corner, pointer: Point, limits: CropLimits): Rect {
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';
  const anchorX = west ? crop.x + crop.width : crop.x;
  const anchorY = north ? crop.y + crop.height : crop.y;
  const reachX = west ? anchorX - pointer.x : pointer.x - anchorX;
  const reachY = north ? anchorY - pointer.y : pointer.y - anchorY;
  const wanted = Math.max(reachX, reachY / limits.shape);
  const width = clamp(wanted, limits.min.width, limits.max.width);
  const height = width * limits.shape;
  return slideIntoLimits(
    {
      x: west ? anchorX - width : anchorX,
      y: north ? anchorY - height : anchorY,
      width,
      height,
    },
    limits.fit,
  );
}

/**
 * A stored crop made fit to edit: brought within the crop limits and the output's shape (as the
 * renderer does), then, if it is below the smallest size, grown about its centre and slid back
 * inside the photo.
 */
export function constrainCrop(crop: Rect, source: Size, target: Size): Rect {
  const limits = cropLimits(source, target);
  const fitted = fitCropToRatio(crop, source, target.width / target.height);
  if (fitted.width >= limits.min.width) return fitted;
  const { width, height } = limits.min;
  return slideIntoLimits(
    {
      x: fitted.x + fitted.width / 2 - width / 2,
      y: fitted.y + fitted.height / 2 - height / 2,
      width,
      height,
    },
    limits.fit,
  );
}

/**
 * The crop made wider by `delta` (a fraction of the photo's width; negative to shrink), about
 * its centre, with its shape kept. It stops at the size limits. A crop that would break the
 * crop limits is slid to where they allow, so a crop touching an edge of the photo can still
 * grow, and a crop at the largest size is centred on the photo. A crop that is already at the
 * limit is returned as it is.
 */
export function scaleCrop(crop: Rect, delta: number, limits: CropLimits): Rect {
  const width = clamp(crop.width + delta, limits.min.width, limits.max.width);
  // Already at the limit: the very same crop, so rounding cannot make it look changed.
  if (width === crop.width) return crop;
  const height = width * limits.shape;
  return slideIntoLimits(
    {
      x: crop.x + crop.width / 2 - width / 2,
      y: crop.y + crop.height / 2 - height / 2,
      width,
      height,
    },
    limits.fit,
  );
}

/** The crop a card gets when nobody has adjusted it: see `focalCrop`. */
export function automaticCrop(source: Size, target: Size, focal: Point): Rect {
  return focalCrop(source, target.width / target.height, focal);
}

/**
 * The crop "Fit whole photo" gives: the largest crop, centred on the photo's centre. It shows
 * the whole photo, with padding wherever the photo's shape differs from the output's. It is
 * also the fit frame, the area every crop stays inside.
 */
export function fitWholeCrop(source: Size, target: Size): Rect {
  return centredOnPhoto(cropLimits(source, target).max);
}

/** True when each of the four edges of two crops is within `tolerance` of the other's. */
export function sameCrop(a: Rect, b: Rect, tolerance = AUTOMATIC_TOLERANCE): boolean {
  const near = (p: number, q: number) => Math.abs(p - q) <= tolerance;
  return (
    near(a.x, b.x) &&
    near(a.y, b.y) &&
    near(a.x + a.width, b.x + b.width) &&
    near(a.y + a.height, b.y + b.height)
  );
}

/**
 * True when a crop is the automatic one for this focal point: each of its four edges is within
 * `tolerance` of the automatic crop's. Compared by value, so rounding in the arithmetic or in a
 * saved file never makes an automatic crop look hand-adjusted.
 */
export function isAutomaticCrop(
  crop: Rect,
  source: Size,
  target: Size,
  focal: Point,
  tolerance = AUTOMATIC_TOLERANCE,
): boolean {
  return sameCrop(crop, automaticCrop(source, target, focal), tolerance);
}

/** A point moved by a distance and kept on the photo. All in fractions of the photo. */
export function movePoint(point: Point, dx: number, dy: number): Point {
  return { x: clamp(point.x + dx, 0, 1), y: clamp(point.y + dy, 0, 1) };
}

/**
 * How far an arrow key moves things, in fractions of the photo: NUDGE_STEP, or NUDGE_BIG_STEP
 * with Shift. Null for any other key.
 */
export function arrowDelta(key: string, big: boolean): { dx: number; dy: number } | null {
  const step = big ? NUDGE_BIG_STEP : NUDGE_STEP;
  switch (key) {
    case 'ArrowLeft':
      return { dx: -step, dy: 0 };
    case 'ArrowRight':
      return { dx: step, dy: 0 };
    case 'ArrowUp':
      return { dx: 0, dy: -step };
    case 'ArrowDown':
      return { dx: 0, dy: step };
    default:
      return null;
  }
}

/**
 * How much a key resizes the crop, as a change in its width in fractions of the photo: plus
 * (or the equals key it shares) grows it and minus shrinks it, by NUDGE_STEP, or NUDGE_BIG_STEP
 * with Shift. The number pad's keys count too. Null for any other key.
 */
export function resizeDelta(key: string, big: boolean): number | null {
  const step = big ? NUDGE_BIG_STEP : NUDGE_STEP;
  if (key === '+' || key === '=' || key === 'Add') return step;
  if (key === '-' || key === '_' || key === 'Subtract') return -step;
  return null;
}

// ---------------------------------------------------------------------------
// Screen and photo
// ---------------------------------------------------------------------------

/**
 * How the photo is shown: `scale` screen pixels for each photo pixel, with the photo's top left
 * corner at (`x`, `y`) on the screen. The scale is the same in both directions.
 */
export type View = { scale: number; x: number; y: number };

/** The view that shows the whole photo as large as fits in a box, centred. */
export function fitView(source: Size, box: Size): View {
  const scale = Math.min(box.width / source.width, box.height / source.height);
  return {
    scale,
    x: (box.width - source.width * scale) / 2,
    y: (box.height - source.height * scale) / 2,
  };
}

/** Where a point on the photo (in fractions) is on the screen, in pixels. */
export function toScreen(point: Point, source: Size, view: View): Point {
  return {
    x: view.x + point.x * source.width * view.scale,
    y: view.y + point.y * source.height * view.scale,
  };
}

/**
 * The point under a screen position, in fractions of the photo. A position off the photo gives
 * a point below 0 or above 1, which is what a corner dragged past the photo's edge needs.
 */
export function toPhotoPlane(screen: Point, source: Size, view: View): Point {
  return {
    x: (screen.x - view.x) / (source.width * view.scale),
    y: (screen.y - view.y) / (source.height * view.scale),
  };
}

/** The point on the photo (in fractions) under a screen position; the nearest edge if outside. */
export function toPhoto(screen: Point, source: Size, view: View): Point {
  const point = toPhotoPlane(screen, source, view);
  return { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) };
}

/** A rectangle on the photo (in fractions) as a rectangle on the screen, in pixels. */
export function rectToScreen(rect: Rect, source: Size, view: View): Rect {
  const corner = toScreen(rect, source, view);
  return {
    x: corner.x,
    y: corner.y,
    width: rect.width * source.width * view.scale,
    height: rect.height * source.height * view.scale,
  };
}
