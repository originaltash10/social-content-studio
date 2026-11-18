/**
 * Which focal point a card uses. A photo has one focal point, shared by the cards made from it.
 * A card may instead carry its own (a duplicate does), and then only its own counts.
 *
 * Pure: no store access.
 */

import type { Asset, Card } from '../../types';
import type { Point } from './crop';

/** The focal point a card is cropped around and checked with: its own, or else its photo's. */
export function effectiveFocal(card: Pick<Card, 'focal'>, asset: Pick<Asset, 'focal'>): Point {
  return card.focal ?? asset.focal;
}
