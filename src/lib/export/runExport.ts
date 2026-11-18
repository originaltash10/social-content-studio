/**
 * One export run: every card in the open session, one at a time, rendered afresh, checked,
 * stripped of hidden information, and handed to a sink (the session's exports/ folder, or a zip).
 *
 * Each card's file is made at export time from the card as it is when its turn comes, on the
 * export's own image worker, one card at a time; nothing rendered for the board is reused.
 * The file is checked with the same validator as the board (rules 1 and 2 against the file
 * itself), and a card whose file fails is skipped unless its override is set.
 *
 * Nothing stale is ever written. Just before a file is handed to the sink, the card is looked up
 * again: if it was removed, or its render plan (crop, focal point, format, quality, size) or
 * photo changed while its file was being made, the file is thrown away and the card is listed
 * as changed. If the session was closed or another one opened, the run stops and nothing more is
 * written, not even captions.csv.
 *
 * captions.csv always matches the files written in this run. It is handed to the sink once, at
 * the end, listing exactly those files:
 * - when the run completes;
 * - when it is cancelled or a write fails, only for a sink that keeps what it has written (a
 *   folder). A zip is never handed over part-way, so a cancelled zip export downloads nothing.
 * If no file was written, the sink is never finished, so an earlier captions.csv is left alone.
 *
 * No DOM and no store access: the worker client, the session and the sink are passed in.
 */

import { errorMessage } from '../session/errors';
import { isImageEdit, renderedValidation } from '../board/renderValidation';
import { RenderError, unexpectedError } from '../render/protocol';
import type { ImageWorkerClient } from '../render/client';
import type { RenderResult } from '../render/protocol';
import type { Card, Issue } from '../../types';
import { captionsCsv } from './captionsCsv';
import type { CaptionRow } from './captionsCsv';
import { exportTarget, exportedResult, firstFailure, sameFile, sourceType } from './eligibility';
import type { ExportSession, ExportedResult, Lookups } from './eligibility';
import { MetadataError, stripMetadata } from './metadata';
import { assertUniquePaths, exportPath } from './names';
import type { FileNameParts } from './names';

/** Where the files go. */
export type ExportSink = {
  /** True when files already written stay put if the run stops early (a folder, not a zip). */
  keepsPartial: boolean;
  /** Writes one file at `path` ("{platform}/{file name}"). Rejects with a reason on failure. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Called at most once, at the end, with captions.csv. Writes it, or builds and hands over the zip. */
  finish(csv: string): Promise<void>;
  /** Called instead of `finish` when the run ends without handing anything over. */
  abandon(): void;
};

export type ExportDeps = Lookups & {
  client: Pick<ImageWorkerClient, 'render' | 'cancel'>;
  /** The open session as it is now; null when none is open. Read again at every step. */
  current: () => ExportSession | null;
  sink: ExportSink;
  /** Hears which card is being worked on, and how many are done. */
  onProgress?: (progress: ExportProgress) => void;
  /** Aborting it cancels the run; a file being made is cancelled with it. */
  signal?: AbortSignal;
};

export type ExportProgress = {
  /** Cards finished, exported or skipped. */
  done: number;
  total: number;
  /** The card being worked on; null once the run has finished. */
  cardId: string | null;
};

export type ExportOutcome =
  /** Every card was looked at. */
  | 'complete'
  /** The user cancelled. */
  | 'cancelled'
  /** A file could not be written, or the zip could not be built. */
  | 'write-error'
  /** The session was closed or another one opened; nothing more was written. */
  | 'session-closed'
  /** Nothing could be exported at all (two files would have had the same name). */
  | 'failed';

export type ExportedFile = {
  cardId: string;
  path: string;
  result: ExportedResult;
  /** The exported file's warnings and, for an override, its failures. */
  issues: Issue[];
};

export type SkipReason =
  /** The file failed its checks and the card is not overridden. */
  | 'fails-checks'
  /** The card changed or was removed while its file was being made. */
  | 'changed'
  /** The file could not be made: no photo, unknown placement, a render error, ... */
  | 'cannot-export';

export type SkippedCard = { cardId: string; reason: SkipReason; message: string };

export type ExportReport = {
  outcome: ExportOutcome;
  /** Cards in the session when the run started. */
  total: number;
  exported: ExportedFile[];
  skipped: SkippedCard[];
  /** True when captions.csv was written (folder) or the zip was handed over. */
  finished: boolean;
  /** What went wrong, for 'write-error' and 'failed'; written for the user. */
  error: string | null;
};

export const REMOVED_MESSAGE = 'This card was removed while the export was running.';
export const CHANGED_MESSAGE =
  'This card changed while its file was being made, so the file was not saved. ' +
  'Export again to include it.';
export const NO_SESSION_MESSAGE = 'There is no open session to export.';

type Step =
  | { kind: 'exported'; file: ExportedFile; row: CaptionRow }
  | { kind: 'skipped'; skipped: SkippedCard }
  | { kind: 'stop'; outcome: Exclude<ExportOutcome, 'complete' | 'failed'>; error?: string };

export async function runExport(deps: ExportDeps): Promise<ExportReport> {
  const { client, sink, signal } = deps;
  const start = deps.current();
  const report: ExportReport = {
    outcome: 'complete',
    total: start?.cards.length ?? 0,
    exported: [],
    skipped: [],
    finished: false,
    error: null,
  };
  if (!start) {
    sink.abandon();
    return { ...report, outcome: 'session-closed', error: NO_SESSION_MESSAGE };
  }
  const sessionId = start.id;
  const sessionName = start.name;
  const nameParts = (card: Card, format: FileNameParts['format']): FileNameParts => ({
    sessionName,
    platform: card.platform,
    placement: card.placement,
    cardId: card.id,
    format,
  });
  const progress = (cardId: string | null) =>
    deps.onProgress?.({
      done: report.exported.length + report.skipped.length,
      total: report.total,
      cardId,
    });

  // Two cards with the same file name would overwrite each other: refuse before writing anything.
  try {
    assertUniquePaths(
      start.cards.flatMap((card) =>
        isImageEdit(card.edit) ? [exportPath(nameParts(card, card.edit.format))] : [],
      ),
    );
  } catch (error) {
    sink.abandon();
    return { ...report, outcome: 'failed', error: errorMessage(error) };
  }

  /** The session, if it is still the one being exported. */
  const live = (): ExportSession | null => {
    const session = deps.current();
    return session?.id === sessionId ? session : null;
  };
  /** Why the run must stop now, if it must. A closed session outranks a cancel. */
  const stopReason = (): 'session-closed' | 'cancelled' | null => {
    if (!live()) return 'session-closed';
    return signal?.aborted ? 'cancelled' : null;
  };

  let jobId: string | null = null;
  let jobs = 0;
  const onAbort = () => {
    if (jobId !== null) client.cancel(jobId);
  };
  signal?.addEventListener('abort', onAbort);

  const written: string[] = [];
  const rows: CaptionRow[] = [];

  async function exportCard(cardId: string): Promise<Step> {
    const skip = (reason: SkipReason, message: string): Step => ({
      kind: 'skipped',
      skipped: { cardId, reason, message },
    });
    const stop = (outcome: 'session-closed' | 'cancelled'): Step => ({ kind: 'stop', outcome });

    const session = live() as ExportSession;
    const card = session.cards.find((c) => c.id === cardId);
    if (!card) return skip('changed', REMOVED_MESSAGE);
    const target = exportTarget(card, session, deps);
    if (!target.ok) return skip('cannot-export', target.message);
    const { asset } = target;

    const type = await sourceType(target.blob, asset.fileName, deps);
    const afterSniff = stopReason();
    if (afterSniff) return stop(afterSniff);
    if (type.kind === 'rejected') return skip('cannot-export', type.message);

    jobs += 1;
    jobId = `export-${jobs}`;
    let result: RenderResult;
    try {
      result = await client.render({
        id: jobId,
        blob: target.blob,
        fileName: asset.fileName,
        sourceFormat: type.format,
        plan: target.plan,
      });
    } catch (error) {
      const stopped = stopReason();
      if (stopped) return stop(stopped);
      const message =
        error instanceof RenderError ? error.message : unexpectedError(asset.fileName).message;
      return skip('cannot-export', message);
    } finally {
      jobId = null;
    }

    let bytes: Uint8Array;
    try {
      bytes = stripMetadata(new Uint8Array(await result.blob.arrayBuffer()), result.format);
    } catch (error) {
      const message =
        error instanceof MetadataError ? error.message : unexpectedError(asset.fileName).message;
      return skip('cannot-export', message);
    }

    // The last look before writing: is this file still the card's file?
    const stopped = stopReason();
    if (stopped) return stop(stopped);
    const nowSession = live() as ExportSession;
    const now = nowSession.cards.find((c) => c.id === cardId);
    if (!now) return skip('changed', REMOVED_MESSAGE);
    const again = exportTarget(now, nowSession, deps);
    if (!again.ok || !sameFile(again, target)) return skip('changed', CHANGED_MESSAGE);

    const validation = renderedValidation(now, again.asset, again.spec, target.plan, result);
    const exported = exportedResult(validation, now.overrideFail);
    if (!exported) return skip('fails-checks', firstFailure(validation));

    const path = exportPath(nameParts(now, result.format));
    try {
      assertUniquePaths([...written, path]);
    } catch (error) {
      return skip('cannot-export', errorMessage(error));
    }
    try {
      await sink.write(path, bytes);
    } catch (error) {
      return {
        kind: 'stop',
        outcome: 'write-error',
        error: `Could not write "${path}": ${errorMessage(error)}`,
      };
    }
    written.push(path);
    return {
      kind: 'exported',
      file: { cardId, path, result: exported, issues: validation.issues },
      row: { path, card: now, result: exported },
    };
  }

  try {
    for (const { id } of start.cards) {
      const stopped = stopReason();
      if (stopped) {
        report.outcome = stopped;
        break;
      }
      progress(id);
      const step = await exportCard(id);
      if (step.kind === 'stop') {
        report.outcome = step.outcome;
        report.error = step.error ?? null;
        break;
      }
      if (step.kind === 'skipped') report.skipped.push(step.skipped);
      else {
        report.exported.push(step.file);
        rows.push(step.row);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  // A session closed after the last card was looked at still stops the hand-over.
  if (!live()) report.outcome = 'session-closed';
  const handOver =
    written.length > 0 &&
    (report.outcome === 'complete' ||
      (sink.keepsPartial && (report.outcome === 'cancelled' || report.outcome === 'write-error')));
  if (!handOver) {
    sink.abandon();
    progress(null);
    return report;
  }
  try {
    await sink.finish(captionsCsv(rows));
    report.finished = true;
  } catch (error) {
    const message = errorMessage(error);
    if (report.error) report.error += ` ${message}`;
    else {
      report.outcome = 'write-error';
      report.error = message;
    }
  }
  progress(null);
  return report;
}
