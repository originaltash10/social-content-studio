/** Wording the editor shares with its tests. */

import type { Rect } from '../types';

export function stageLabel(fileName: string): string {
  return `Crop of ${fileName}. Arrow keys move the crop. Plus and minus resize it. Hold Shift for bigger steps.`;
}

const whole = (fraction: number) => Math.round(fraction * 100);

/** Where the crop is, in words, for example for a screen reader after an arrow key. */
export function cropReadout(crop: Rect): string {
  return (
    `The crop is ${whole(crop.width)}% of the photo's width and ${whole(crop.height)}% of its ` +
    `height, starting ${whole(crop.x)}% from the left and ${whole(crop.y)}% from the top.`
  );
}

/** Which focal point a card uses: its photo's, shared with other cards, or its own. */
export type FocalKind = 'shared' | 'own';

/** The marker's accessible name: what it is, whose it is, and what the arrow keys do. */
export function focalLabel(fileName: string, kind: FocalKind): string {
  const keys = 'Arrow keys move it. Hold Shift for bigger steps.';
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
