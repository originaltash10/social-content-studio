/**
 * Wording and text handling for the Background colour control in a card's details. The colour
 * itself, and what counts as one in a saved session, is src/lib/render/background.ts.
 */

import { parseBackground } from '../lib/render/background';

export const BACKGROUND_LEGEND = 'Background colour';
export const BACKGROUND_NOTE =
  "Fills any space where the crop goes past the photo's edges. Choose Fit whole photo to see it.";
export const PICKER_NAME = 'Background colour picker';
export const HEX_LABEL = 'Hex code';

/** What the hex box says when what was typed is not a colour. */
export function invalidHexMessage(current: string): string {
  return (
    'That is not a colour code. Type six characters, each a number or a letter from A to F, ' +
    `for example 1A2B3C. The colour is still ${current}.`
  );
}

/**
 * What was typed in the hex box as a colour, "#rrggbb" in lowercase: six hex digits, with or
 * without a "#" in front, in any case, with any spaces around them ignored. Null for anything
 * else.
 */
export function parseHexInput(text: string): string | null {
  const trimmed = text.trim();
  return parseBackground(trimmed.startsWith('#') ? trimmed : `#${trimmed}`) ?? null;
}
