/**
 * Saving and loading a session folder through the File System Access API (Chrome and Edge).
 *
 * Nothing here deletes anything: there is no call to removeEntry in this module.
 */

import { hasName } from './errors';
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

/** True in browsers that can open a folder (Chrome and Edge). */
export function supportsFolders(): boolean {
  return 'showDirectoryPicker' in window;
}

/** Asks the user to choose a session folder. Returns null if they cancel the picker. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (error) {
    if (hasName(error, 'AbortError')) return null;
    throw error;
  }
}

/**
 * Checks read/write permission on a folder. With `ask`, shows the browser's permission prompt
 * when access is not already granted; that only works inside a click or key handler.
 */
export async function ensurePermission(
  dir: FileSystemDirectoryHandle,
  ask: boolean,
): Promise<boolean> {
  const access = { mode: 'readwrite' } as const;
  if ((await dir.queryPermission(access)) === 'granted') return true;
  if (!ask) return false;
  return (await dir.requestPermission(access)) === 'granted';
}

/**
 * Writes one file. The browser writes to a temporary file and swaps it in on close, so a
 * failure part-way leaves the previous contents in place.
 */
async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: string | Blob) {
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

/** The file, or null when there is no file of that name. */
async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  try {
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch (error) {
    if (hasName(error, 'NotFoundError')) return null;
    throw error;
  }
}

/**
 * Reports whether a folder already holds a session, and which one. `id` is null when there is a
 * session.json that cannot be read as a session. Used to avoid saving one session over another.
 */
export async function existingSession(
  dir: FileSystemDirectoryHandle,
): Promise<{ found: false } | { found: true; id: string | null }> {
  const file = await readFile(dir, SESSION_FILE);
  if (!file) return { found: false };
  try {
    return { found: true, id: parseSession(await file.text()).id };
  } catch {
    return { found: true, id: null };
  }
}

/**
 * Saves a session into a folder using the SPEC.md layout.
 *
 * Both JSON documents are built before anything is written, so a session that fails validation
 * writes nothing. Asset files go first and session.json last, so session.json never lists an
 * asset that is not yet on disk. An asset file that already exists with the same size is left
 * alone: files are named by content hash, so it is the same file.
 */
export async function saveToFolder(
  dir: FileSystemDirectoryHandle,
  files: SessionFiles,
): Promise<void> {
  const sessionText = serializeSession(files.session);
  const brandText = serializeBrand(files.brand);

  const assets = await dir.getDirectoryHandle(ASSETS_DIR, { create: true });
  await dir.getDirectoryHandle(RENDERS_DIR, { create: true });
  await dir.getDirectoryHandle(EXPORTS_DIR, { create: true });

  for (const { id } of files.session.assets) {
    const blob = files.blobs.get(id);
    if (!blob) continue;
    const existing = await readFile(assets, id);
    if (existing?.size === blob.size) continue;
    await writeFile(assets, id, blob);
  }

  await writeFile(dir, BRAND_FILE, brandText);
  await writeFile(dir, SESSION_FILE, sessionText);
}

/**
 * Loads a session from a folder: session.json, brand.json, and the file for every asset that
 * session.json lists. A missing asset file does not stop the load; its id is reported in
 * `missingAssetIds`. A missing brand.json loads as an empty brand kit and sets `brandMissing`.
 * Writes nothing.
 */
export async function loadFromFolder(dir: FileSystemDirectoryHandle): Promise<LoadedSession> {
  const sessionFile = await readFile(dir, SESSION_FILE);
  if (!sessionFile) {
    throw new SessionFormatError(`This folder does not contain a ${SESSION_FILE}`);
  }
  const session = parseSession(await sessionFile.text());

  const brandFile = await readFile(dir, BRAND_FILE);
  const brand = brandFile ? parseBrand(await brandFile.text()) : emptyBrand();

  let assets: FileSystemDirectoryHandle | null = null;
  try {
    assets = await dir.getDirectoryHandle(ASSETS_DIR);
  } catch (error) {
    if (!hasName(error, 'NotFoundError')) throw error;
  }

  const blobs = new Map<string, Blob>();
  const missingAssetIds: string[] = [];
  for (const { id } of session.assets) {
    const file = assets ? await readFile(assets, id) : null;
    if (file) blobs.set(id, file);
    else missingAssetIds.push(id);
  }

  return { session, brand, blobs, missingAssetIds, brandMissing: !brandFile };
}
