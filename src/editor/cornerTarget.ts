/**
 * The size of the touch targets in the editor's crop area (src/editor/CropStage.tsx): one on each
 * corner of the crop, and the focal point's marker.
 */

/**
 * The largest size of each corner's touch target, in CSS pixels, and the size of the focal
 * point's. The square drawn inside a corner's target is smaller.
 */
export const HANDLE_TARGET = 44;
/** The smallest a corner's touch target gets, in CSS pixels. */
export const HANDLE_TARGET_MIN = 24;

/**
 * The size of a corner's touch target for a crop whose shorter side is `shorterSide` CSS pixels
 * on screen: a third of that side, never more than HANDLE_TARGET and never less than
 * HANDLE_TARGET_MIN. The targets are centred on the corners, so along that side they take up one
 * target's length between them and the rest of the side is free for pressing and moving the
 * crop: at least HANDLE_TARGET_MIN of it whenever the side is twice that or more.
 *
 * The browser works this out itself, in the `.crop-handle` rule in src/index.css, from the
 * variables CropStage sets on the photo's frame; this is the same rule in script, for the tests.
 */
export function cornerTargetSize(shorterSide: number): number {
  return Math.min(HANDLE_TARGET, Math.max(HANDLE_TARGET_MIN, shorterSide / 3));
}
