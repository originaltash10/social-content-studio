/**
 * What moving a focal point does to cards.
 *
 * A photo's focal point is shared by the cards made from it and drives their automatic crops,
 * so a card still on its automatic crop is re-centred on the new point; a card whose crop has
 * been adjusted by hand is left exactly as it is. A card with its own focal point (a duplicate)
 * takes no part in that: the photo's point never moves its crop, and moving its own point
 * changes that card only (`ownFocalMove`).
 *
 * "Automatic" is decided by value, with no flag on the card: the card's crop equals the crop
 * the focal point it uses gives for its placement (see `isAutomaticCrop`).
 *
 * Pure: no store access. The output size of each card's placement is passed in by the caller,
 * which reads it from src/data/platforms.json.
 */

import { isImageEdit } from '../board/renderValidation';
import type { Asset, Card, ImageEdit, Rect, Size } from '../../types';
import { automaticCrop, isAutomaticCrop } from './geometry';
import type { Point } from './geometry';

/** A card and the crop it should get. */
export type Recrop = { cardId: string; crop: Rect };

/**
 * The new crops for a move of `asset`'s focal point to `focal`: one for each single-photo card
 * of this photo that shares the photo's point, is still on its automatic crop, and whose crop
 * the move actually changes. A card with its own focal point is never listed, even when its
 * crop happens to equal the automatic one. `targetOf` gives a card's output size, or undefined
 * when its placement is not known.
 */
export function recentredCrops(
  cards: readonly Card[],
  asset: Asset,
  focal: Point,
  targetOf: (card: Card) => Size | undefined,
): Recrop[] {
  const source = { width: asset.width, height: asset.height };
  const recrops: Recrop[] = [];
  for (const card of cards) {
    if (card.assetIds.length !== 1 || card.assetIds[0] !== asset.id) continue;
    if (card.focal !== undefined || !isImageEdit(card.edit)) continue;
    const target = targetOf(card);
    if (!target || !isAutomaticCrop(card.edit.crop, source, target, asset.focal)) continue;
    // Still automatic for the new point too (the crop cannot move that way): nothing to change.
    if (isAutomaticCrop(card.edit.crop, source, target, focal)) continue;
    recrops.push({ cardId: card.id, crop: automaticCrop(source, target, focal) });
  }
  return recrops;
}

/** A fraction kept inside 0..1; anything that is not a number becomes the middle. */
const unit = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5);

/** What a move of a card's own focal point writes to that card. */
export type OwnFocalMove = {
  /** The new point, always inside 0..1. */
  focal: Point;
  /** The card's new crop; absent when the crop stays as it is. */
  crop?: Rect;
};

/**
 * A move of a card's own focal point to `focal`, for a single-photo card that has one. The
 * point is kept inside 0..1. The card gets a new crop only if it is on its automatic crop,
 * judged by its own point as it is now, and the move actually changes that crop; a crop
 * adjusted by hand is left alone. Null when the point would not move, so there is nothing to
 * write. `source` is the photo's size and `target` the card's output size.
 */
export function ownFocalMove(
  card: { focal: Point; edit: Pick<ImageEdit, 'crop'> },
  source: Size,
  target: Size,
  focal: Point,
): OwnFocalMove | null {
  const next = { x: unit(focal.x), y: unit(focal.y) };
  if (next.x === card.focal.x && next.y === card.focal.y) return null;
  const { crop } = card.edit;
  const recentre =
    isAutomaticCrop(crop, source, target, card.focal) &&
    !isAutomaticCrop(crop, source, target, next);
  return recentre ? { focal: next, crop: automaticCrop(source, target, next) } : { focal: next };
}
