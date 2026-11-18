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

export function focalLabel(fileName: string): string {
  return `Focal point of ${fileName}. Arrow keys move it. Hold Shift for bigger steps.`;
}

/** Where the focal point is, in words. */
export function focalReadout(focal: { x: number; y: number }): string {
  return `The focal point is ${whole(focal.x)}% from the left and ${whole(focal.y)}% from the top.`;
}
