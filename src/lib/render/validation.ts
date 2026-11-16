/**
 * The bridge from a finished render to the validator. The validator itself is untouched: this
 * only shapes what a render measured into the fields `validate()` reads.
 */

import type { ValidationInput } from '../validate';
import type { Point } from './crop';
import { focalInFrame } from './crop';
import type { RenderPlan } from './plan';

/** What a finished render measured: the real output size and the encoded file's size. */
export type RenderedMeasure = { width: number; height: number; bytes: number };

/**
 * The validator fields a single rendered image supplies: its frame (rule 1), its file size
 * (rule 2) and where the asset's focal point sits in the output (rule 7). The caller adds the
 * caption, hashtags and alt text from the card.
 */
export function renderValidationFields(
  rendered: RenderedMeasure,
  plan: Pick<RenderPlan, 'cropRect'>,
  focal: Point,
): Pick<ValidationInput, 'kind' | 'frames' | 'fileBytes' | 'focal'> {
  return {
    kind: 'image',
    frames: [{ width: rendered.width, height: rendered.height }],
    fileBytes: rendered.bytes,
    focal: focalInFrame(focal, plan.cropRect),
  };
}
