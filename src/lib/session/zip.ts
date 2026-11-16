/**
 * The .scs bundle: the fallback for browsers without the File System Access API (SPEC.md:
 * "download a .scs bundle as fallback"). A bundle is a zip of the session folder, with the same
 * layout as layout.ts describes.
 *
 * What goes into a bundle is fixed: the two serializer outputs, the files of assets that
 * session.json lists, and two empty folders. There is no "add everything" path, so nothing
 * outside the data model (an API key, for example) can end up in one.
 *
 * Limitation: a bundle is built and read in browser memory. A session with a lot of video can
 * be too large; that is reported as a BundleError, never swallowed.
 */

import JSZip from 'jszip';
import { errorMessage, hasName } from './errors';
import { ASSETS_DIR, EXPORTS_DIR, RENDERS_DIR, emptyBrand } from './layout';
import type { LoadedSession, SessionFiles } from './layout';
import {
  BRAND_FILE,
  SESSION_FILE,
  SessionFormatError,
  parseBrand,
  parseSession,
  serializeBrand,
  serializeSession,
} from './serialize';

export const BUNDLE_EXTENSION = '.scs';

/** A bundle could not be built or read. The message is written for the status line. */
export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

const TOO_LARGE_TO_BUILD =
  'This session is too large to bundle in browser memory. ' +
  'Save it to a folder in Chrome or Edge instead.';
const TOO_LARGE_TO_READ =
  'This .scs bundle is too large to open in browser memory. ' +
  'Unzip it and open the folder in Chrome or Edge instead.';

/** Browsers report running out of memory in several ways; these are the usual ones. */
function isMemoryError(error: unknown): boolean {
  return (
    hasName(error, 'RangeError') ||
    hasName(error, 'NotReadableError') ||
    /out of memory|allocation failed|invalid (array|string) length/i.test(errorMessage(error))
  );
}

/** A download name for the bundle, e.g. "Topping out.scs". */
export function bundleFileName(sessionName: string): string {
  const safe = sessionName.replace(/[^A-Za-z0-9 _-]+/g, '_').trim();
  return `${safe || 'session'}${BUNDLE_EXTENSION}`;
}

/**
 * Builds a .scs bundle. Throws SessionFormatError if the session or brand kit fails validation,
 * and BundleError if the zip cannot be built (with a specific message when memory ran out).
 */
export async function buildBundle(files: SessionFiles): Promise<Blob> {
  const sessionText = serializeSession(files.session);
  const brandText = serializeBrand(files.brand);

  try {
    const zip = new JSZip();
    zip.file(SESSION_FILE, sessionText);
    zip.file(BRAND_FILE, brandText);
    zip.folder(ASSETS_DIR);
    zip.folder(RENDERS_DIR);
    zip.folder(EXPORTS_DIR);
    for (const { id } of files.session.assets) {
      const blob = files.blobs.get(id);
      // Read to bytes here rather than inside JSZip, so a failed read is reported, not hidden.
      if (blob) zip.file(`${ASSETS_DIR}/${id}`, await blob.arrayBuffer());
    }
    // Photos and video are already compressed; storing them as-is is faster and uses less memory.
    return await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true });
  } catch (error) {
    throw new BundleError(
      isMemoryError(error)
        ? TOO_LARGE_TO_BUILD
        : `Could not build the .scs bundle: ${errorMessage(error)}`,
    );
  }
}

/**
 * Finds where the session sits inside the zip: at the top level (bundles made by this app), or
 * inside a single wrapping folder (a session folder zipped by hand). macOS extras (__MACOSX/
 * entries and .DS_Store files) are never mistaken for the session.
 */
function findSession(zip: JSZip): { root: string; entry: JSZip.JSZipObject } | null {
  const top = zip.file(SESSION_FILE);
  if (top) return { root: '', entry: top };
  // Finder's Compress adds a __MACOSX/ tree of resource forks beside the real folder; skip it.
  const wrapped = zip
    .file(/^[^/]+\/session\.json$/)
    .filter((entry) => !entry.name.startsWith('__MACOSX/'));
  const only = wrapped.length === 1 ? wrapped[0] : undefined;
  return only ? { root: only.name.slice(0, -SESSION_FILE.length), entry: only } : null;
}

/**
 * Reads a .scs bundle. Only session.json, brand.json, and the files of assets that session.json
 * lists are read; anything else in the zip is ignored. A missing asset file does not stop the
 * load (see `missingAssetIds`), and a missing brand.json loads as an empty brand kit.
 */
export async function readBundle(file: Blob): Promise<LoadedSession> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch (error) {
    throw new BundleError(
      isMemoryError(error) ? TOO_LARGE_TO_READ : 'This file is not a valid .scs bundle.',
    );
  }

  const found = findSession(zip);
  if (!found) throw new SessionFormatError(`This bundle does not contain a ${SESSION_FILE}`);
  const { root, entry: sessionEntry } = found;

  try {
    const session = parseSession(await sessionEntry.async('string'));
    const brandEntry = zip.file(`${root}${BRAND_FILE}`);
    const brand = brandEntry ? parseBrand(await brandEntry.async('string')) : emptyBrand();

    const blobs = new Map<string, Blob>();
    const missingAssetIds: string[] = [];
    for (const { id } of session.assets) {
      const entry = zip.file(`${root}${ASSETS_DIR}/${id}`);
      if (entry) blobs.set(id, new Blob([await entry.async('arraybuffer')]));
      else missingAssetIds.push(id);
    }
    return { session, brand, blobs, missingAssetIds, brandMissing: !brandEntry };
  } catch (error) {
    if (error instanceof SessionFormatError) throw error;
    throw new BundleError(
      isMemoryError(error)
        ? TOO_LARGE_TO_READ
        : `Could not read the .scs bundle: ${errorMessage(error)}`,
    );
  }
}
