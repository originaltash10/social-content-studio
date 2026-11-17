/**
 * Making cards: one card per photo and placement, as SPEC.md's "Pick targets" step describes.
 * A photo and placement that already have an original card (one that is not a duplicate) are
 * skipped and reported, so choosing Create cards twice does not make the same card twice.
 */

import { DEFAULT_QUALITY, defaultCrop } from '../render/plan';
import type { Asset, Card, PlacementSpec } from '../../types';
import { placementName } from './targets';
import { plannedValidation } from './renderValidation';

/** A card ready to add to the session; the store assigns its id and version. */
export type CardDraft = Omit<Card, 'id' | 'version' | 'parentId'>;

/** A new card for one photo and one placement, with the default crop from the focal point. */
export function draftCard(asset: Asset, spec: PlacementSpec): CardDraft {
  const fields: Pick<Card, 'copy' | 'edit'> = {
    edit: {
      crop: defaultCrop(asset, spec),
      overlays: [],
      format: 'jpg',
      quality: DEFAULT_QUALITY,
    },
    copy: { caption: '', firstComment: '', hashtags: [], altText: '' },
  };
  return {
    assetIds: [asset.id],
    platform: spec.platform,
    placement: spec.placement,
    status: 'draft',
    ...fields,
    validation: plannedValidation(fields, asset, spec),
    overrideFail: false,
    comments: [],
  };
}

export type Pairing = { asset: Asset; spec: PlacementSpec };

export type CreationPlan = {
  /** The cards to add, in photo order, then placement order. */
  drafts: CardDraft[];
  /** Pairs that already have a card, with a message for each. */
  skipped: (Pairing & { message: string })[];
};

/** True when `card` is the original (not a duplicate) card for this photo and placement. */
function isOriginalFor(card: Card, { asset, spec }: Pairing): boolean {
  return (
    card.parentId === undefined &&
    card.assetIds.length === 1 &&
    card.assetIds[0] === asset.id &&
    card.platform === spec.platform &&
    card.placement === spec.placement
  );
}

/** Works out which cards to create for the chosen photos and placements. */
export function planCreation(
  assets: readonly Asset[],
  specs: readonly PlacementSpec[],
  existing: readonly Card[],
): CreationPlan {
  const plan: CreationPlan = { drafts: [], skipped: [] };
  for (const asset of assets) {
    if (asset.kind !== 'image') continue;
    for (const spec of specs) {
      const pairing = { asset, spec };
      if (existing.some((card) => isOriginalFor(card, pairing))) {
        plan.skipped.push({
          ...pairing,
          message: `${placementName(spec)} already has a card for "${asset.fileName}".`,
        });
      } else {
        plan.drafts.push(draftCard(asset, spec));
      }
    }
  }
  return plan;
}

/** A one-line summary of a creation, for the board's status line. */
export function creationSummary(plan: CreationPlan): string {
  const made = plan.drafts.length;
  const parts: string[] = [];
  if (made > 0) parts.push(`Created ${made} ${made === 1 ? 'card' : 'cards'}.`);
  else parts.push('No new cards were created.');
  parts.push(...plan.skipped.map((skip) => skip.message));
  return parts.join(' ');
}
