/**
 * Remembers the open session folder across reloads. A directory handle can be stored in
 * IndexedDB as it is; after a reload the browser asks for permission again before it can be
 * used (see ensurePermission in fsAccess.ts).
 *
 * Only the folder handle is kept here. API keys have their own storage (Settings, Phase 2).
 */

import { createStore, del, get, set } from 'idb-keyval';

const KEY = 'session-folder';

/** Opened on first use, so importing this module does not touch IndexedDB. */
let db: ReturnType<typeof createStore> | undefined;
const store = () => (db ??= createStore('social-content-studio-session', 'handles'));

export async function rememberFolder(dir: FileSystemDirectoryHandle): Promise<void> {
  await set(KEY, dir, store());
}

/** The folder remembered from an earlier visit, or null. */
export async function recallFolder(): Promise<FileSystemDirectoryHandle | null> {
  return (await get<FileSystemDirectoryHandle>(KEY, store())) ?? null;
}

export async function forgetFolder(): Promise<void> {
  await del(KEY, store());
}
