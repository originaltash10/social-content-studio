/**
 * What moving a photo's focal point does to that photo's cards. One focal point drives every
 * automatic crop, so a card still on its automatic crop is re-centred on the new point; a card
 * whose crop has been adjusted by hand is left exactly as it is.
 *
 * "Automatic" is decided by value, with no flag on the card: the card's crop equals the crop
 * the old focal point gives for its placement (see `isAutomaticCrop`).
 *
 * Pure: no store access. The output size of each card's placement is passed in by the caller,
 * which reads it from src/data/platforms.json.
 */

import { isImageEdit } from '../board/renderValidation';
import type { Asset, Card, Rect, Size } from '../../types';
import { automaticCrop, isAutomaticCrop } from './geometry';
import type { Point } from './geometry';

/** A card and the crop it should get. */
export type Recrop = { cardId: string; crop: Rect };

/**
 * The new crops for a move of `asset`'s focal point to `focal`: one for each single-photo card
 * of this photo that is still on its automatic crop and whose crop the move actually changes.
 * `targetOf` gives a card's output size, or undefined when its placement is not known.
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
    if (!isImageEdit(card.edit)) continue;
    const target = targetOf(card);
    if (!target || !isAutomaticCrop(card.edit.crop, source, target, asset.focal)) continue;
    // Still automatic for the new point too (the crop cannot move that way): nothing to change.
    if (isAutomaticCrop(card.edit.crop, source, target, focal)) continue;
    recrops.push({ cardId: card.id, crop: automaticCrop(source, target, focal) });
  }
  return recrops;
}
