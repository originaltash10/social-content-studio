/** Wording the editor shares with its tests. */

import type { Rect } from '../types';

/** What Shift does to a key, in the crop area's name and the marker's. */
const SHIFT_TEXT = 'Hold Shift for steps ten times as big.';

/**
 * The crop area's accessible name: what it is and what the keys do. It names the keys as they
 * are pressed without Shift (equals, not plus), because Shift is what makes a step bigger.
 */
export function stageLabel(fileName: string): string {
  return `Crop of ${fileName}. Arrow keys move the crop. Equals makes it bigger and minus makes it smaller. ${SHIFT_TEXT}`;
}

const whole = (fraction: number) => Math.round(fraction * 100);

/** Where a crop starts along one axis: inside the photo, or past its edge when padded. */
function startText(start: number, side: 'left' | 'top'): string {
  const percent = whole(start);
  return percent < 0 ? `${-percent}% past the ${side} edge` : `${percent}% from the ${side}`;
}

/**
 * Where the crop is, in words, for example for a screen reader after an arrow key. A crop that
 * is larger than the photo says so, and that the picture has padding.
 */
export function cropReadout(crop: Rect): string {
  const padded = whole(crop.width) > 100 || whole(crop.height) > 100;
  return (
    `The crop is ${whole(crop.width)}% of the photo's width and ${whole(crop.height)}% of its ` +
    `height, starting ${startText(crop.x, 'left')} and ${startText(crop.y, 'top')}.` +
    (padded ? ' It is larger than the photo, so the picture has padding.' : '')
  );
}

/** Which focal point a card uses: its photo's, shared with other cards, or its own. */
export type FocalKind = 'shared' | 'own';

/** The marker's accessible name: what it is, whose it is, and what the arrow keys do. */
export function focalLabel(fileName: string, kind: FocalKind): string {
  const keys = `Arrow keys move it. ${SHIFT_TEXT}`;
  return kind === 'own'
    ? `This card's own focal point on ${fileName}. Moving it changes only this card. ${keys}`
    : `Focal point of ${fileName}, shared with this photo's other cards. ${keys}`;
}

/** The same in a sentence shown under the photo: what moving the marker will change. */
export function focalKindText(kind: FocalKind): string {
  return kind === 'own'
    ? 'This card has its own focal point. Moving it changes only this card.'
    : "This card uses the photo's focal point. Moving it changes every card from this photo that shares it.";
}

/** Where the focal point is, in words. */
export function focalReadout(focal: { x: number; y: number }): string {
  return `The focal point is ${whole(focal.x)}% from the left and ${whole(focal.y)}% from the top.`;
}
