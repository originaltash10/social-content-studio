/**
 * Save, load, autosave and clear for the session store. This is the only place where the store
 * meets the disk; the readers and writers themselves live in src/lib/session/.
 *
 * Rules this file enforces:
 * - A folder belongs to one session. The folder handle is held together with the id of the
 *   session it was opened or chosen for, and is only ever written with that session. A new or
 *   different session can never be saved over it by accident.
 * - Autosave writes only when there are unsaved changes and the open session has a folder. It
 *   never opens a picker, never shows a permission prompt, and never starts a download.
 * - No function here rejects. Every failure ends up in the store's status line.
 * - Clearing deletes nothing on disk and makes no file-system calls at all.
 * - Remembering or forgetting the folder waits for the browser's database, which can be slow.
 *   Nothing is written to the store after that wait, so a clear or a load that is still
 *   finishing can never put its status over that of a session started since.
 */

import { downloadBlob } from '../lib/session/download';
import { errorMessage } from '../lib/session/errors';
import {
  ensurePermission,
  existingSession,
  loadFromFolder,
  pickFolder,
  saveToFolder,
  supportsFolders,
} from '../lib/session/fsAccess';
import { forgetFolder, recallFolder, rememberFolder } from '../lib/session/handleStore';
import type { LoadedSession } from '../lib/session/layout';
import { buildBundle, bundleFileName, readBundle } from '../lib/session/zip';
import type { Session } from '../types';
import { assetBlobs, useSessionStore } from './sessionStore';
import type { Status } from './sessionStore';

/** SPEC.md: "autosaves every 30 s". */
export const AUTOSAVE_MS = 30_000;

/** The exact wording asked for when a load finds no brand.json. */
export const BRAND_MISSING_NOTE = 'brand.json not found; starting with an empty brand kit.';

/** The open folder and the id of the session it belongs to. */
let bound: { dir: FileSystemDirectoryHandle; sessionId: string } | null = null;

/** True while a folder save is running, so two saves never overlap. */
let saving = false;

const store = () => useSessionStore.getState();

function say(kind: Status['kind'], message: string) {
  store().setStatus({ kind, message });
}

/** The folder `session` saves to, or null if it has none. */
function folderFor(session: Session | null): FileSystemDirectoryHandle | null {
  return session && bound?.sessionId === session.id ? bound.dir : null;
}

/** The name of the folder the open session saves to, for display. */
export function currentFolderName(): string | null {
  return folderFor(store().session)?.name ?? null;
}

/**
 * The folder the session `sessionId` saves to, for writing its exports into exports/. Null when
 * that session is not the open one, has no folder, or write permission was not granted. Call it
 * from a click handler, before any other await: it may show the browser's permission prompt,
 * which only appears in response to a user action. Makes no other file-system calls.
 */
export async function exportFolderFor(
  sessionId: string,
): Promise<FileSystemDirectoryHandle | null> {
  const { session } = store();
  const dir = session?.id === sessionId ? folderFor(session) : null;
  if (!dir) return null;
  return (await ensurePermission(dir, true)) ? dir : null;
}

/**
 * Remembering or forgetting the folder for "Reopen last" is a convenience. If IndexedDB refuses,
 * the session itself is unaffected, so the failure is not allowed to break a save or a clear.
 */
async function ignoreFailure(work: Promise<void>): Promise<void> {
  try {
    await work;
  } catch {
    // Nothing to do: the only effect is that "Reopen last" may not offer this folder.
  }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * Writes `session` into `dir`. Catches every failure, reports it in the status line, and leaves
 * the unsaved-changes flag set. `manual` decides whether a permission prompt may be shown.
 */
async function writeTo(
  dir: FileSystemDirectoryHandle,
  session: Session,
  manual: boolean,
): Promise<boolean> {
  const { brand, revision } = store();
  saving = true;
  try {
    if (!(await ensurePermission(dir, manual))) {
      say(
        'error',
        manual
          ? `Permission to write to folder "${dir.name}" was not granted. Nothing was saved.`
          : `Autosave is paused: folder "${dir.name}" needs permission again. Press Save to continue.`,
      );
      return false;
    }
    await saveToFolder(dir, { session, brand, blobs: assetBlobs() });
  } catch (error) {
    say('error', `Could not save: ${errorMessage(error)}`);
    return false;
  } finally {
    saving = false;
  }
  // If the session was cleared or replaced while the save ran, leave the new state alone.
  if (store().session?.id === session.id) {
    store().markSaved(revision);
    say('info', `Saved to folder "${dir.name}".`);
  }
  return true;
}

/** Asks for a folder for a session that has none yet, refusing one that holds another session. */
async function chooseFolder(session: Session): Promise<FileSystemDirectoryHandle | null> {
  try {
    const dir = await pickFolder();
    if (!dir) {
      say('info', 'Save cancelled; no folder was chosen.');
      return null;
    }
    const existing = await existingSession(dir);
    if (existing.found && existing.id !== session.id) {
      say(
        'error',
        `Folder "${dir.name}" already holds another session, so nothing was saved. ` +
          'Choose an empty folder, or use Open folder to load that session.',
      );
      return null;
    }
    bound = { dir, sessionId: session.id };
    await ignoreFailure(rememberFolder(dir));
    return dir;
  } catch (error) {
    say('error', `Could not use that folder: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Manual save. Call from a click or key handler: it may open the folder picker (first save) or
 * the browser's permission prompt (first save after a reload).
 */
export async function saveSession(): Promise<boolean> {
  const { session } = store();
  if (!session) {
    say('info', 'There is no session to save.');
    return false;
  }
  if (saving) {
    say('info', 'A save is already in progress.');
    return false;
  }
  let dir = folderFor(session);
  if (!dir) {
    if (!supportsFolders()) {
      say('info', 'This browser cannot save to a folder. Use Download .scs instead.');
      return false;
    }
    dir = await chooseFolder(session);
    if (!dir) return false;
  }
  return writeTo(dir, session, true);
}

/**
 * One autosave check. Writes only when there are unsaved changes, the open session has a folder,
 * and no save is already running. Never prompts and never downloads.
 */
export async function autosave(): Promise<boolean> {
  const { session, dirty } = store();
  const dir = folderFor(session);
  if (!session || !dir || !dirty || saving) return false;
  return writeTo(dir, session, false);
}

/** Starts the 30-second autosave timer. Returns a function that stops it. */
export function startAutosave(): () => void {
  const timer = setInterval(() => void autosave(), AUTOSAVE_MS);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function loadedStatus(loaded: LoadedSession, from: string): Status {
  const notes: string[] = [];
  if (loaded.brandMissing) notes.push(BRAND_MISSING_NOTE);
  if (loaded.missingAssetIds.length > 0) {
    const names = loaded.session.assets
      .filter((asset) => loaded.missingAssetIds.includes(asset.id))
      .map((asset) => asset.fileName);
    notes.push(`Missing asset ${names.length === 1 ? 'file' : 'files'}: ${names.join(', ')}.`);
  }
  return {
    kind: notes.length > 0 ? 'warning' : 'info',
    message: [`Opened "${loaded.session.name}" from ${from}.`, ...notes].join(' '),
  };
}

/** Puts a loaded session into the store and ties it to its folder, if it came from one. */
async function adopt(loaded: LoadedSession, dir: FileSystemDirectoryHandle | null, from: string) {
  store().loadSession(loaded);
  bound = dir ? { dir, sessionId: loaded.session.id } : null;
  // Before the folder is remembered, not after: see the last rule at the top of this file.
  store().setStatus(loadedStatus(loaded, from));
  if (dir) await ignoreFailure(rememberFolder(dir));
}

/** Opens the folder picker and loads the session in the chosen folder. */
export async function openSessionFolder(): Promise<boolean> {
  try {
    const dir = await pickFolder();
    if (!dir) return false;
    await adopt(await loadFromFolder(dir), dir, `folder "${dir.name}"`);
    return true;
  } catch (error) {
    say('error', `Could not open the folder: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * Reopens the folder remembered from an earlier visit. Call from a click handler: after a reload
 * the browser has to ask for permission again, and it only does so in response to a user action.
 */
export async function reopenLastSession(): Promise<boolean> {
  try {
    const dir = await recallFolder();
    if (!dir) {
      say('info', 'There is no earlier session folder to reopen.');
      return false;
    }
    if (!(await ensurePermission(dir, true))) {
      say(
        'error',
        `Permission to open folder "${dir.name}" was not granted, so the session was not reopened. ` +
          'Press Reopen last to be asked again, or Open folder to choose it.',
      );
      return false;
    }
    await adopt(await loadFromFolder(dir), dir, `folder "${dir.name}"`);
    return true;
  } catch (error) {
    say('error', `Could not reopen the last session: ${errorMessage(error)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// .scs bundle (fallback for browsers without folder access)
// ---------------------------------------------------------------------------

/** Loads a session from a .scs file the user picked. The session then has no folder. */
export async function loadBundle(file: Blob, fileName = 'session.scs'): Promise<boolean> {
  try {
    await adopt(await readBundle(file), null, `bundle "${fileName}"`);
    return true;
  } catch (error) {
    say('error', errorMessage(error));
    return false;
  }
}

/**
 * Builds a .scs bundle and hands it to the browser to download. For a session without a folder
 * this is the save, so it clears the unsaved-changes flag; a session with a folder keeps its
 * flag, because the folder is still behind.
 */
export async function downloadBundle(): Promise<boolean> {
  const { session, brand, revision } = store();
  if (!session) {
    say('info', 'There is no session to download.');
    return false;
  }
  try {
    const bundle = await buildBundle({ session, brand, blobs: assetBlobs() });
    const fileName = bundleFileName(session.name);
    downloadBlob(bundle, fileName);
    if (!folderFor(session)) store().markSaved(revision);
    say('info', `Downloaded ${fileName}.`);
    return true;
  } catch (error) {
    say('error', errorMessage(error));
    return false;
  }
}

// ---------------------------------------------------------------------------
// New and clear
// ---------------------------------------------------------------------------

/**
 * Starts a new session. The folder of the previous session is released first, so the new session
 * has no folder until the user saves it and chooses one.
 */
export function newSession(name: string): void {
  bound = null;
  store().createSession(name);
  say('info', `Started "${name}". It is not saved yet.`);
}

/**
 * Clears the session if `confirm` returns true: empties the store, the asset contents and the
 * undo history, then releases and forgets the folder. Makes no file-system calls, so nothing on
 * disk is deleted or changed.
 */
export async function requestClearSession(confirm: () => boolean): Promise<boolean> {
  if (!store().clearSession(confirm)) return false;
  bound = null;
  // Before the folder is forgotten, not after: see the last rule at the top of this file.
  say('info', 'Session cleared. Nothing on disk was deleted.');
  await ignoreFailure(forgetFolder());
  return true;
}
