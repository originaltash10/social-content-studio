/**
 * Which cards can be exported. SPEC.md: "Export only includes cards that pass or that the user
 * explicitly overrides" and "Fail blocks export unless overridden". Only Fail blocks: a card
 * with warnings is exported (every card warns until alt text arrives in Phase 2), and a failing
 * card is exported only when its `overrideFail` is set.
 *
 * The decision that counts is made on the file made at export time (see runExport.ts);
 * `readiness` only previews it from each card's last result.
 *
 * Pure: no DOM, no store access.
 */

import { sniffBlob } from '../image/fileType';
import type { FileType } from '../image/fileType';
import { getPlacement } from '../platforms';
import {
  NOT_SINGLE_IMAGE_MESSAGE,
  NO_PHOTO_MESSAGE,
  missingFileMessage,
  unknownPlacementMessage,
} from '../board/controller';
import { isImageEdit } from '../board/renderValidation';
import { RenderPlanError, planRender } from '../render/plan';
import type { RenderPlan } from '../render/plan';
import { unexpectedError } from '../render/protocol';
import type { Asset, Card, Issue, PlacementSpec, Platform, ValidationResult } from '../../types';

/** The parts of the open session an export reads. */
export type ExportSession = {
  id: string;
  name: string;
  cards: readonly Card[];
  assets: readonly Asset[];
  missingAssetIds: readonly string[];
};

/** The functions an export looks things up with; tests replace them. */
export type Lookups = {
  /** The asset's original file, if it is in memory. */
  blobOf: (assetId: string) => Blob | undefined;
  specOf?: (platform: Platform, placement: string) => PlacementSpec | undefined;
  sniff?: (blob: Blob, fileName: string) => Promise<FileType>;
};

/** How an exported file did: passed, warned, or failed and was exported by override. */
export type ExportedResult = 'pass' | 'warn' | 'override';

/** What a card needs to be exported, or why it cannot be. */
export type ExportTarget =
  | { ok: true; asset: Asset; spec: PlacementSpec; plan: RenderPlan; blob: Blob }
  | { ok: false; message: string };

/**
 * Works out how a card's file is made, with the same checks and messages as the board: one
 * photo, an image edit, a known placement, the original file in memory, and a render plan.
 */
export function exportTarget(card: Card, session: ExportSession, lookups: Lookups): ExportTarget {
  const specOf = lookups.specOf ?? getPlacement;
  if (card.assetIds.length !== 1 || !isImageEdit(card.edit)) {
    return { ok: false, message: NOT_SINGLE_IMAGE_MESSAGE };
  }
  const asset = session.assets.find((a) => a.id === card.assetIds[0]);
  if (!asset) return { ok: false, message: NO_PHOTO_MESSAGE };
  const spec = specOf(card.platform, card.placement);
  if (!spec) return { ok: false, message: unknownPlacementMessage(card.platform, card.placement) };
  const blob = session.missingAssetIds.includes(asset.id) ? undefined : lookups.blobOf(asset.id);
  if (!blob) return { ok: false, message: missingFileMessage(asset.fileName) };
  try {
    return { ok: true, asset, spec, plan: planRender({ asset, spec, edit: card.edit }), blob };
  } catch (error) {
    const message =
      error instanceof RenderPlanError ? error.message : unexpectedError(asset.fileName).message;
    return { ok: false, message };
  }
}

/** True when two targets make the same file: same photo, same plan. */
export function sameFile(
  a: Extract<ExportTarget, { ok: true }>,
  b: Extract<ExportTarget, { ok: true }>,
): boolean {
  return JSON.stringify([a.asset.id, a.plan]) === JSON.stringify([b.asset.id, b.plan]);
}

/** How a file with this result is exported, or null when it is blocked (Fail, no override). */
export function exportedResult(
  result: Pick<ValidationResult, 'level'>,
  overrideFail: boolean,
): ExportedResult | null {
  if (result.level !== 'fail') return result.level;
  return overrideFail ? 'override' : null;
}

/** The first reason a result fails. Only called for a result whose level is 'fail'. */
export function firstFailure(result: ValidationResult): string {
  return (result.issues.find((issue) => issue.level === 'fail') as Issue).message;
}

export type Readiness = {
  /** Every card in the session, whatever the board's filters show. */
  total: number;
  /** Cards whose last result allows export: Pass, Warning, or Fail with the override set. */
  ready: number;
  /** Cards whose last result is Fail, without the override. */
  failing: number;
};

/** A preview of what an export would include, from each card's last result. */
export function readiness(cards: readonly Pick<Card, 'validation' | 'overrideFail'>[]): Readiness {
  const failing = cards.filter((card) => !exportedResult(card.validation, card.overrideFail));
  return { total: cards.length, ready: cards.length - failing.length, failing: failing.length };
}

/** The file type of an original, for the image worker. Never rejects. */
export async function sourceType(
  blob: Blob,
  fileName: string,
  lookups: Lookups,
): Promise<FileType> {
  try {
    return await (lookups.sniff ?? sniffBlob)(blob, fileName);
  } catch {
    return { kind: 'rejected', reason: 'damaged', message: unexpectedError(fileName).message };
  }
}
