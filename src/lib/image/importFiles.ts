/**
 * The import pipeline: turns dropped files into assets, one file at a time.
 *
 * For each file: identify it from its first bytes, hash the original bytes (the hash is the
 * asset id), skip it if the session already has it, then decode it for its size and thumbnail.
 * Every file ends in an outcome with a plain-language message; a failure on one file never stops
 * the rest of the batch, and nothing here throws.
 *
 * No store access: the caller says what the session already holds and adds the results itself.
 * The blob in an outcome holds the original bytes exactly as they were dropped, HEIC included;
 * they are the same bytes that were hashed.
 */

import type { Asset } from '../../types';
import { ImageDecodeError, inspectImage } from './decode';
import type { DecodeFailure } from './decode';
import { sniffFile } from './fileType';
import type { RejectReason } from './fileType';
import { sha256Hex } from './hash';
import type { HeicDecoder } from './heic';

/** What the session already holds, so duplicates can be skipped and missing files restored. */
export type KnownAssets = {
  assets: readonly Asset[];
  /** Ids of assets the session lists but whose file was not found when it was opened. */
  missingAssetIds: readonly string[];
};

export type ImportFailure = RejectReason | DecodeFailure | 'unreadable' | 'unexpected';

export type ImportOutcome =
  /** A new asset. `note` is set when the file's name and contents disagreed. */
  | {
      status: 'imported';
      asset: Asset;
      blob: Blob;
      thumbnail: Blob | null;
      message: string;
      note?: string;
    }
  /** The file of an asset the session listed as missing. `asset` is the existing asset. */
  | { status: 'restored'; asset: Asset; blob: Blob; thumbnail: Blob | null; message: string }
  /** Already in the session (or earlier in the same batch); nothing to add. */
  | { status: 'duplicate'; asset: Asset; message: string }
  | { status: 'failed'; reason: ImportFailure; message: string };

/** Where one file of a batch has got to. */
export type FileProgress =
  | { fileName: string; state: 'waiting' }
  | { fileName: string; state: 'working' }
  | { fileName: string; state: 'done'; outcome: ImportOutcome };

function failed(reason: ImportFailure, message: string): ImportOutcome {
  return { status: 'failed', reason, message };
}

function unreadableMessage(fileName: string): string {
  return (
    `"${fileName}" could not be read. It may have been moved, renamed or deleted, or it is on a ` +
    'drive that is no longer connected. Find the file again and try once more.'
  );
}

function unexpectedMessage(fileName: string): string {
  return (
    `"${fileName}" could not be imported because something unexpected went wrong. Try again; ` +
    'if it keeps happening, convert the file to JPG or PNG first.'
  );
}

/**
 * Imports one file. Never rejects: every problem becomes a `failed` outcome with a message.
 * `heicDecoder` is only for tests; by default the real decoder is loaded on first use.
 */
export async function importFile(
  file: File,
  known: KnownAssets,
  heicDecoder?: HeicDecoder,
): Promise<ImportOutcome> {
  let type: Awaited<ReturnType<typeof sniffFile>>;
  let bytes: ArrayBuffer;
  try {
    type = await sniffFile(file);
    if (type.kind === 'rejected') return failed(type.reason, type.message);
    bytes = await file.arrayBuffer();
  } catch {
    return failed('unreadable', unreadableMessage(file.name));
  }

  try {
    const id = await sha256Hex(bytes);
    const existing = known.assets.find((asset) => asset.id === id);
    const missing = known.missingAssetIds.includes(id);
    if (existing && !missing) {
      return {
        status: 'duplicate',
        asset: existing,
        message: `Already imported as "${existing.fileName}".`,
      };
    }

    // Built from the bytes that were hashed, so what is saved is exactly what was identified.
    const blob = new Blob([bytes], { type: file.type });
    const { width, height, thumbnail } = await inspectImage(
      blob,
      type.format,
      file.name,
      heicDecoder,
    );

    if (existing) {
      return {
        status: 'restored',
        asset: existing,
        blob,
        thumbnail,
        message: `This is the missing file for "${existing.fileName}". It has been restored.`,
      };
    }
    return {
      status: 'imported',
      asset: { id, kind: 'image', fileName: file.name, width, height, focal: { x: 0.5, y: 0.5 } },
      blob,
      thumbnail,
      message: `Imported, ${width} x ${height} pixels.`,
      ...(type.note === undefined ? {} : { note: type.note }),
    };
  } catch (error) {
    return error instanceof ImageDecodeError
      ? failed(error.reason, error.message)
      : failed('unexpected', unexpectedMessage(file.name));
  }
}

export type ImportOptions = {
  /** Called just before each file, so it reflects what earlier files in the batch added. */
  known: () => KnownAssets;
  /** Called as each file starts and finishes. `index` is the file's place in `files`. */
  onProgress?: (index: number, progress: FileProgress) => void;
  /** Only for tests. */
  heicDecoder?: HeicDecoder;
};

/**
 * Imports a batch one file at a time, in order, so only one full-size image is in memory at
 * once. A file repeated within the batch is a duplicate of its first appearance even if the
 * caller has not added that one to the session yet. Never rejects.
 */
export async function importFiles(
  files: readonly File[],
  options: ImportOptions,
): Promise<ImportOutcome[]> {
  const { onProgress = () => undefined } = options;
  files.forEach((file, index) => onProgress(index, { fileName: file.name, state: 'waiting' }));

  const added: Asset[] = [];
  const outcomes: ImportOutcome[] = [];
  for (const [index, file] of files.entries()) {
    onProgress(index, { fileName: file.name, state: 'working' });
    const { assets, missingAssetIds } = options.known();
    const earlier = added.filter((asset) => !assets.some((a) => a.id === asset.id));
    const outcome = await importFile(
      file,
      { assets: [...assets, ...earlier], missingAssetIds },
      options.heicDecoder,
    );
    if (outcome.status === 'imported') added.push(outcome.asset);
    outcomes.push(outcome);
    onProgress(index, { fileName: file.name, state: 'done', outcome });
  }
  return outcomes;
}
