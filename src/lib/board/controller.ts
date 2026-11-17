/**
 * Keeps each card's rendered file in step with the card. The board hands it the open session
 * after every change (`sync`); it works out which cards need a new file, sends those jobs to the
 * image worker, tracks their progress, and, when a file is finished, runs the validator and
 * passes the result to `writeResult`.
 *
 * No DOM and no store access: the worker client, the asset files and the place results go are
 * all passed in, so this can be tested with fakes.
 *
 * A finished file is used only if it is still wanted. It is thrown away, unseen and never
 * validated, when it arrives after the card's render plan changed, after the card was removed,
 * or after another session was opened or this one was closed. A file is given an object URL
 * only after that check, so a discarded file never holds one.
 *
 * Files stay in memory. Nothing is written to the session's renders/ or exports/ folders.
 */

import { sniffBlob } from '../image/fileType';
import type { FileType } from '../image/fileType';
import { getPlacement } from '../platforms';
import type { ImageWorkerClient } from '../render/client';
import { RenderPlanError, planRender } from '../render/plan';
import type { OutputFormat, RenderPlan } from '../render/plan';
import { RenderError, unexpectedError } from '../render/protocol';
import type { RenderProgress, RenderResult, RenderStage } from '../render/protocol';
import type { Asset, Card, PlacementSpec, Platform, ValidationResult } from '../../types';
import { ObjectUrls } from './objectUrls';
import type { UrlApi } from './objectUrls';
import { isImageEdit, renderedValidation, sameResult } from './renderValidation';

/** Where a card's file has got to. */
export type CardRender =
  | { kind: 'waiting' }
  | { kind: 'working'; stage: RenderStage }
  | {
      kind: 'done';
      /** An object URL for the file, for previews. */
      url: string;
      width: number;
      height: number;
      bytes: number;
      format: OutputFormat;
      upscaled: boolean;
    }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

/** The parts of the open session the controller reads. */
export type BoardSession = {
  /** Null when no session is open. */
  id: string | null;
  cards: readonly Card[];
  assets: readonly Asset[];
  missingAssetIds: readonly string[];
};

export type ControllerDeps = {
  client: Pick<ImageWorkerClient, 'render' | 'cancel'>;
  /** The asset's original file, if it is in memory. */
  blobOf: (assetId: string) => Blob | undefined;
  /** Records a card's validation result. Called only for a fresh file, and only on a change. */
  writeResult: (cardId: string, result: ValidationResult) => void;
  specOf?: (platform: Platform, placement: string) => PlacementSpec | undefined;
  sniff?: (blob: Blob, fileName: string) => Promise<FileType>;
  urls?: UrlApi;
};

export type RenderController = {
  /** Brings every card's file up to date with the session. */
  sync(session: BoardSession): void;
  /** Renders a card again, even if its plan has not changed. */
  renderAgain(cardId: string): void;
  /** Cancels a card's render if it is waiting or under way. Returns false otherwise. */
  cancel(cardId: string): boolean;
  /** Cancels every render that is waiting or under way. Returns how many were cancelled. */
  cancelAll(): number;
  /** Cancels everything, releases every file, and stops listening. */
  dispose(): void;
  /**
   * Resolves once every render that has started has finished, one way or the other. A render
   * sent to the worker finishes when the worker answers or the job is cancelled.
   */
  idle(): Promise<void>;
  /** The state of each card's file, by card id. A new map is made on every change. */
  snapshot(): ReadonlyMap<string, CardRender>;
  subscribe(listener: () => void): () => void;
};

type Tracked = {
  /** What the file is made from; a different key means the file must be made again. */
  key: string;
  /** The job whose file is wanted; null when none is (finished, failed, or cancelled). */
  jobId: string | null;
  render: CardRender;
  /** Set once a file has been made: what the validator needs to check it again. */
  made?: { plan: RenderPlan; result: Pick<RenderResult, 'width' | 'height' | 'bytes'> };
};

/** Messages for cards that cannot be rendered. */
export function missingFileMessage(fileName: string): string {
  return `The original file for "${fileName}" is missing. Open the session folder that has it to render this card.`;
}
export const NO_PHOTO_MESSAGE =
  "This card's photo is not in the session, so the card cannot be rendered.";
export function unknownPlacementMessage(platform: string, placement: string): string {
  return (
    `"${platform} ${placement}" is no longer listed in the app's platform data, so this card ` +
    'cannot be rendered.'
  );
}
export const NOT_SINGLE_IMAGE_MESSAGE =
  'Only cards for a single photo are rendered on the board so far.';

/** What a card needs to be rendered, or the reason it cannot be. */
type Target =
  | { ok: true; key: string; asset: Asset; spec: PlacementSpec; plan: RenderPlan; blob: Blob }
  | { ok: false; key: string; message: string };

export function createRenderController(deps: ControllerDeps): RenderController {
  const specOf = deps.specOf ?? ((platform, placement) => getPlacement(platform, placement));
  const sniff = deps.sniff ?? sniffBlob;
  const urls = new ObjectUrls(deps.urls);
  const tracked = new Map<string, Tracked>();
  const listeners = new Set<() => void>();
  let current: BoardSession = { id: null, cards: [], assets: [], missingAssetIds: [] };
  let view: ReadonlyMap<string, CardRender> = new Map();
  let nextJob = 0;
  let disposed = false;
  /** Renders that have started and not finished. */
  const runs = new Set<Promise<void>>();
  /**
   * Results found during `sync`, recorded once it has finished. Recording a result changes the
   * store, and a store listener may call `sync` again; holding the results until the end means
   * that can never happen part-way through a sync.
   */
  let held: [string, ValidationResult][] | null = null;

  function record(cardId: string, result: ValidationResult): void {
    if (held) held.push([cardId, result]);
    else deps.writeResult(cardId, result);
  }

  function changed(): void {
    view = new Map([...tracked].map(([id, entry]) => [id, entry.render]));
    for (const listener of listeners) listener();
  }

  function targetFor(card: Card): Target {
    const assetId = card.assetIds[0];
    const asset = current.assets.find((a) => a.id === assetId);
    if (card.assetIds.length !== 1 || !isImageEdit(card.edit)) {
      return { ok: false, key: 'not-single-image', message: NOT_SINGLE_IMAGE_MESSAGE };
    }
    if (!asset) return { ok: false, key: 'no-photo', message: NO_PHOTO_MESSAGE };
    const spec = specOf(card.platform, card.placement);
    if (!spec) {
      return {
        ok: false,
        key: 'no-placement',
        message: unknownPlacementMessage(card.platform, card.placement),
      };
    }
    const blob = current.missingAssetIds.includes(asset.id) ? undefined : deps.blobOf(asset.id);
    if (!blob) return { ok: false, key: 'missing', message: missingFileMessage(asset.fileName) };
    let plan: RenderPlan;
    try {
      plan = planRender({ asset, spec, edit: card.edit });
    } catch (error) {
      const message =
        error instanceof RenderPlanError ? error.message : unexpectedError(asset.fileName).message;
      return { ok: false, key: `plan-error:${message}`, message };
    }
    return { ok: true, key: JSON.stringify([asset.id, plan]), asset, spec, plan, blob };
  }

  /** Drops a card's job, if any. A job whose id no longer matches is discarded when it ends. */
  function stopJob(entry: Tracked): void {
    if (entry.jobId === null) return;
    const jobId = entry.jobId;
    entry.jobId = null;
    deps.client.cancel(jobId);
  }

  /** Stops tracking a card. Only called with ids that are tracked. */
  function forget(cardId: string): void {
    stopJob(tracked.get(cardId) as Tracked);
    urls.drop(cardId);
    tracked.delete(cardId);
  }

  /** True when the job's file is still wanted. */
  function wanted(cardId: string, jobId: string, sessionId: string | null): boolean {
    return !disposed && current.id === sessionId && tracked.get(cardId)?.jobId === jobId;
  }

  /** Checks a finished file against the card as it is now, and records any change. */
  function validateMade(
    card: Card,
    made: NonNullable<Tracked['made']>,
    { asset, spec }: Extract<Target, { ok: true }>,
  ): void {
    const result = renderedValidation(card, asset, spec, made.plan, made.result);
    if (!sameResult(result, card.validation)) record(card.id, result);
  }

  function start(card: Card, target: Target): void {
    urls.drop(card.id);
    if (!target.ok) {
      tracked.set(card.id, {
        key: target.key,
        jobId: null,
        render: { kind: 'failed', message: target.message },
      });
      return;
    }
    nextJob += 1;
    const jobId = `${card.id}#${nextJob}`;
    const entry: Tracked = { key: target.key, jobId, render: { kind: 'waiting' } };
    tracked.set(card.id, entry);
    const running = run(card.id, jobId, current.id, target);
    runs.add(running);
    void running.finally(() => runs.delete(running));
  }

  async function run(
    cardId: string,
    jobId: string,
    sessionId: string | null,
    target: Extract<Target, { ok: true }>,
  ): Promise<void> {
    const { asset, plan, blob } = target;
    const settle = (render: CardRender) => {
      const entry = tracked.get(cardId) as Tracked;
      entry.jobId = null;
      entry.render = render;
      changed();
    };
    let type: FileType;
    try {
      type = await sniff(blob, asset.fileName);
    } catch {
      type = {
        kind: 'rejected',
        reason: 'damaged',
        message: unexpectedError(asset.fileName).message,
      };
    }
    if (!wanted(cardId, jobId, sessionId)) return;
    if (type.kind === 'rejected') {
      settle({ kind: 'failed', message: type.message });
      return;
    }

    const onProgress = (progress: RenderProgress) => {
      if (!wanted(cardId, jobId, sessionId)) return;
      const entry = tracked.get(cardId) as Tracked;
      if (progress === 'queued') entry.render = { kind: 'waiting' };
      else if (progress === 'decoding' || progress === 'drawing' || progress === 'encoding') {
        entry.render = { kind: 'working', stage: progress };
      } else return;
      changed();
    };

    let result: RenderResult;
    try {
      result = await deps.client.render(
        { id: jobId, blob, fileName: asset.fileName, sourceFormat: type.format, plan },
        onProgress,
      );
    } catch (error) {
      if (!wanted(cardId, jobId, sessionId)) return;
      if (error instanceof RenderError && error.reason === 'cancelled') {
        settle({ kind: 'cancelled' });
      } else {
        const message =
          error instanceof RenderError ? error.message : unexpectedError(asset.fileName).message;
        settle({ kind: 'failed', message });
      }
      return;
    }

    // Discard a file nobody wants any more: no URL, no validation.
    if (!wanted(cardId, jobId, sessionId)) return;
    const entry = tracked.get(cardId) as Tracked;
    const made = {
      plan,
      result: { width: result.width, height: result.height, bytes: result.bytes },
    };
    entry.made = made;
    const url = urls.set(cardId, result.blob);
    settle({
      kind: 'done',
      url,
      width: result.width,
      height: result.height,
      bytes: result.bytes,
      format: result.format,
      upscaled: result.upscaled,
    });
    // The plan is unchanged (or the file would not be wanted), so `target` still fits the card.
    validateMade(current.cards.find((c) => c.id === cardId) as Card, made, target);
  }

  function sync(session: BoardSession): void {
    if (disposed) return;
    const found: [string, ValidationResult][] = [];
    held = found;
    if (session.id !== current.id) {
      for (const id of [...tracked.keys()]) forget(id);
    }
    current = session;
    const ids = new Set(session.cards.map((card) => card.id));
    for (const id of [...tracked.keys()]) if (!ids.has(id)) forget(id);
    for (const card of session.cards) {
      const target = targetFor(card);
      const entry = tracked.get(card.id);
      if (entry && entry.key === target.key) {
        // A file is kept only for a plan that could be rendered, so a finished file implies
        // `target.ok`; the check narrows the type.
        if (target.ok && entry.made) validateMade(card, entry.made, target);
        continue;
      }
      if (entry) stopJob(entry);
      start(card, target);
    }
    held = null;
    changed();
    for (const [cardId, result] of found) deps.writeResult(cardId, result);
  }

  function renderAgain(cardId: string): void {
    const card = current.cards.find((c) => c.id === cardId);
    if (disposed || !card) return;
    // Every card in the session is tracked once it has been synced.
    stopJob(tracked.get(cardId) as Tracked);
    start(card, targetFor(card));
    changed();
  }

  function cancelEntry(entry: Tracked): boolean {
    if (
      entry.jobId === null ||
      (entry.render.kind !== 'waiting' && entry.render.kind !== 'working')
    ) {
      return false;
    }
    stopJob(entry);
    entry.render = { kind: 'cancelled' };
    return true;
  }

  function cancel(cardId: string): boolean {
    const entry = tracked.get(cardId);
    if (!entry || !cancelEntry(entry)) return false;
    changed();
    return true;
  }

  function cancelAll(): number {
    let count = 0;
    for (const entry of tracked.values()) if (cancelEntry(entry)) count += 1;
    if (count > 0) changed();
    return count;
  }

  function dispose(): void {
    if (disposed) return;
    for (const id of [...tracked.keys()]) forget(id);
    disposed = true;
    current = { id: null, cards: [], assets: [], missingAssetIds: [] };
    changed();
    listeners.clear();
  }

  async function idle(): Promise<void> {
    while (runs.size > 0) await Promise.allSettled([...runs]);
  }

  return {
    sync,
    renderAgain,
    cancel,
    cancelAll,
    dispose,
    idle,
    snapshot: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** How far along a card's render is, 0 to 100, for its progress bar. */
export function progressPercent(render: CardRender | undefined): number {
  if (render?.kind === 'done') return 100;
  if (render?.kind !== 'working') return 0;
  return { decoding: 25, drawing: 60, encoding: 85 }[render.stage];
}

/** The step a card's render is on, in words. */
export function progressLabel(render: CardRender | undefined): string {
  if (render?.kind === 'working') {
    return {
      decoding: 'Opening the photo',
      drawing: 'Cropping and resizing',
      encoding: 'Saving the file',
    }[render.stage];
  }
  return render?.kind === 'waiting' ? 'Waiting to render' : '';
}
