/**
 * Validation for a board card, before and after its render. The validator itself is not changed:
 * this only gathers what `validate()` reads from the card, its photo and the rendered file.
 */

import { focalInFrame } from '../render/crop';
import { effectiveFocal } from '../render/focal';
import { defaultCrop } from '../render/plan';
import type { RenderPlan } from '../render/plan';
import { renderValidationFields } from '../render/validation';
import type { RenderedMeasure } from '../render/validation';
import { validate } from '../validate';
import type { ValidationInput } from '../validate';
import type { Asset, Card, ImageEdit, PlacementSpec, ValidationResult } from '../../types';

/** True when a card's edit is for a single still image (not a video or a carousel). */
export function isImageEdit(edit: Card['edit']): edit is ImageEdit {
  return 'format' in edit && !('slides' in edit) && !('inMs' in edit);
}

type CardText = Pick<Card, 'copy' | 'edit' | 'focal'>;

/** The fields every check reads from the card itself: its text, overlays and logo. */
function cardFields(
  card: CardText,
): Pick<ValidationInput, 'caption' | 'hashtags' | 'altText' | 'overlays' | 'logo'> {
  const fields: Pick<ValidationInput, 'caption' | 'hashtags' | 'altText' | 'overlays' | 'logo'> = {
    caption: card.copy.caption,
    hashtags: card.copy.hashtags,
    altText: card.copy.altText,
  };
  if (isImageEdit(card.edit)) {
    fields.overlays = card.edit.overlays.map((overlay) => overlay.rect);
    if (card.edit.logo) fields.logo = card.edit.logo.rect;
  }
  return fields;
}

/**
 * The result for a card that has not been rendered yet: the planned frame stands in for the
 * file, and the file-size rule is skipped until there is a file.
 */
export function plannedValidation(
  card: CardText,
  asset: Asset,
  spec: PlacementSpec,
): ValidationResult {
  const size = spec.sizes[0];
  if (!size) return validate({ kind: 'image', frames: [], ...cardFields(card) }, spec);
  const crop = isImageEdit(card.edit) ? card.edit.crop : defaultCrop(asset, spec);
  return validate(
    {
      kind: 'image',
      frames: [{ width: size.width, height: size.height }],
      focal: focalInFrame(effectiveFocal(card, asset), crop),
      ...cardFields(card),
    },
    spec,
  );
}

/** The result for a card from its finished render. */
export function renderedValidation(
  card: CardText,
  asset: Asset,
  spec: PlacementSpec,
  plan: Pick<RenderPlan, 'cropRect'>,
  rendered: RenderedMeasure,
): ValidationResult {
  return validate(
    { ...renderValidationFields(rendered, plan, effectiveFocal(card, asset)), ...cardFields(card) },
    spec,
  );
}

/** True when two results say the same thing: same level, same issues in the same order. */
export function sameResult(a: ValidationResult, b: ValidationResult): boolean {
  return (
    a.level === b.level &&
    a.issues.length === b.issues.length &&
    a.issues.every((issue, index) => {
      const other = b.issues[index];
      return (
        other !== undefined &&
        issue.rule === other.rule &&
        issue.level === other.level &&
        issue.message === other.message
      );
    })
  );
}
