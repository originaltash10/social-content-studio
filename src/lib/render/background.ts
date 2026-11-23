/**
 * A card's background colour: what fills any space where its crop goes past the photo's edges
 * (SPEC.md, "Background colour"). It is stored on the card as "#rrggbb" in lowercase, and a card
 * without one is white.
 *
 * Pure: no DOM, no store access.
 */

import type { Card } from '../../types';

/** The colour of a card that has none of its own. */
export const DEFAULT_BACKGROUND = '#ffffff';

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

/**
 * A stored colour made safe to use: a "#" and six hex digits, in any case, comes back in
 * lowercase. Anything else (no "#", three or eight digits, a colour name, something that is not
 * text) is not a colour here, and comes back undefined.
 */
export function parseBackground(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_COLOUR.test(value) ? value.toLowerCase() : undefined;
}

/** The colour a card is drawn with: its own if that is usable, or else white. */
export function backgroundOf(card: Pick<Card, 'background'>): string {
  return parseBackground(card.background) ?? DEFAULT_BACKGROUND;
}
