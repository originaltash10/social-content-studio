/**
 * Where an export's files go (SPEC.md: "Streams to the session's exports/ folder; JSZip fallback
 * for download"):
 *
 * - `folderSink`: the session's own folder. Each file is written as soon as it is made, into
 *   exports/{platform}/, then captions.csv into exports/. Only one file is held in memory at a
 *   time. Nothing is ever deleted: a card exported again replaces its own file (same name), and
 *   files from earlier exports stay where they are.
 * - `zipSink`: a download, for a session without a folder. The files are collected in memory,
 *   stored without compression (JPG and PNG are already compressed), and the zip is built and
 *   downloaded once, at the end, with the same layout as exports/.
 *
 * Both accept only the paths the export makes: "{platform}/{file name}" with plain characters,
 * and captions.csv. A path that could reach outside exports/ is refused.
 *
 * No store access. The folder handle is passed in; the caller makes sure it is the folder of the
 * session being exported and that permission to write was granted.
 */

import JSZip from 'jszip';
import { downloadBlob } from '../session/download';
import { errorMessage, hasName } from '../session/errors';
import { EXPORTS_DIR } from '../session/layout';
import { CSV_MIME } from './captionsCsv';
import { CAPTIONS_FILE, zipFileName } from './names';
import type { ExportSink } from './runExport';

/** A part of a path the export may write: letters, digits, ".", "_" and "-", and not "." or "..". */
const SAFE_PART = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/** The folder and file name of an exported image. Throws for anything else. */
export function splitPath(path: string): { folder: string; name: string } {
  const parts = path.split('/');
  const [folder, name] = parts;
  if (parts.length !== 2 || !folder || !name || !SAFE_PART.test(folder) || !SAFE_PART.test(name)) {
    throw new Error(`"${path}" is not a place an export can write to.`);
  }
  return { folder, name };
}

/** A failure from the file system in words, for the status line. */
export function writeFailure(error: unknown): string {
  if (hasName(error, 'QuotaExceededError')) return 'There is not enough space on the disk.';
  if (hasName(error, 'NotAllowedError') || hasName(error, 'SecurityError')) {
    return 'Permission to write to the session folder was withdrawn.';
  }
  if (hasName(error, 'NotFoundError')) return 'The session folder was moved or deleted.';
  if (hasName(error, 'NoModificationAllowedError') || hasName(error, 'InvalidModificationError')) {
    return 'The file is open in another program. Close it and try again.';
  }
  return errorMessage(error);
}

/**
 * Writes one file. The browser writes to a temporary file and swaps it in on close, so a failure
 * part-way leaves any earlier file of that name as it was.
 */
async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

/** Writes into `dir`/exports/. Rejections carry a reason in words. */
export function folderSink(dir: FileSystemDirectoryHandle): ExportSink {
  const exportsDir = () => dir.getDirectoryHandle(EXPORTS_DIR, { create: true });
  return {
    keepsPartial: true,
    async write(path, bytes) {
      const { folder, name } = splitPath(path);
      try {
        const platformDir = await (await exportsDir()).getDirectoryHandle(folder, { create: true });
        await writeFile(platformDir, name, new Blob([bytes]));
      } catch (error) {
        throw new Error(writeFailure(error), { cause: error });
      }
    },
    async finish(csv) {
      try {
        await writeFile(await exportsDir(), CAPTIONS_FILE, new Blob([csv], { type: CSV_MIME }));
      } catch (error) {
        throw new Error(`Could not write ${CAPTIONS_FILE}: ${writeFailure(error)}`, {
          cause: error,
        });
      }
    },
    abandon() {
      // Files already written stay; there is nothing held in memory to drop.
    },
  };
}

export const ZIP_TOO_LARGE =
  'There is too much to zip in browser memory. Save the session to a folder and export there ' +
  'instead.';

/** Browsers report running out of memory in several ways; these are the usual ones. */
function isMemoryError(error: unknown): boolean {
  return (
    hasName(error, 'RangeError') ||
    hasName(error, 'NotReadableError') ||
    /out of memory|allocation failed|invalid (array|string) length/i.test(errorMessage(error))
  );
}

function zipFailure(error: unknown): string {
  return isMemoryError(error) ? ZIP_TOO_LARGE : `Could not build the zip: ${errorMessage(error)}`;
}

/**
 * Collects the files and, at the end, downloads them as "{session}_export.zip". If the run ends
 * without finishing (cancelled, or a write failed), nothing is downloaded and the files are let go.
 */
export function zipSink(
  sessionName: string,
  download: (blob: Blob, fileName: string) => void = downloadBlob,
): ExportSink {
  let zip: JSZip | null = new JSZip();
  const open = (): JSZip => {
    if (!zip) throw new Error('This export has already ended.');
    return zip;
  };
  return {
    keepsPartial: false,
    async write(path, bytes) {
      const { folder, name } = splitPath(path);
      const target = open();
      try {
        target.file(`${folder}/${name}`, bytes);
      } catch (error) {
        throw new Error(zipFailure(error), { cause: error });
      }
    },
    async finish(csv) {
      const target = open();
      zip = null;
      let blob: Blob;
      try {
        target.file(CAPTIONS_FILE, csv);
        blob = await target.generateAsync({
          type: 'blob',
          compression: 'STORE',
          streamFiles: true,
        });
      } catch (error) {
        throw new Error(zipFailure(error), { cause: error });
      }
      download(blob, zipFileName(sessionName));
    },
    abandon() {
      zip = null;
    },
  };
}
