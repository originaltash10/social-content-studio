import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from '../lib/session/download';
import { saveToFolder } from '../lib/session/fsAccess';
import { forgetFolder, recallFolder, rememberFolder } from '../lib/session/handleStore';
import { serializeBrand, serializeSession } from '../lib/session/serialize';
import { buildBundle } from '../lib/session/zip';
import {
  CARD_COLOUR,
  PADDED_CROP,
  hash,
  makeAsset,
  makeBrand,
  makeCard,
  makeSession,
} from '../test/fixtures';
import { MockDir, domError } from '../test/mockFs';
import type { Card, ImageEdit, Session } from '../types';
import {
  AUTOSAVE_MS,
  autosave,
  currentFolderName,
  downloadBundle,
  exportFolderFor,
  loadBundle,
  newSession,
  openSessionFolder,
  reopenLastSession,
  requestClearSession,
  saveSession,
  startAutosave,
} from './persistence';
import { assetBlobs, getAssetBlob, useSessionStore } from './sessionStore';

// The remembered folder lives in IndexedDB in the app; here it is one variable.
const remembered = vi.hoisted(() => ({ dir: null as FileSystemDirectoryHandle | null }));
vi.mock('../lib/session/handleStore', () => ({
  rememberFolder: vi.fn((dir: FileSystemDirectoryHandle) => {
    remembered.dir = dir;
    return Promise.resolve();
  }),
  recallFolder: vi.fn(() => Promise.resolve(remembered.dir)),
  forgetFolder: vi.fn(() => {
    remembered.dir = null;
    return Promise.resolve();
  }),
}));
vi.mock('../lib/session/download', () => ({ downloadBlob: vi.fn() }));

const A = hash('a');
const B = hash('b');

const store = () => useSessionStore.getState();
const status = () => store().status;

function open(): Session {
  const { session } = store();
  if (!session) throw new Error('expected an open session');
  return session;
}

/** Makes the folder picker return `dir`, or behave as if the user cancelled when null. */
function pickerReturns(dir: MockDir | null) {
  const picker = vi.fn(() =>
    dir ? Promise.resolve(dir.handle) : Promise.reject(domError('AbortError')),
  );
  Object.defineProperty(window, 'showDirectoryPicker', { value: picker, configurable: true });
  return picker;
}

/** A folder on "disk" that already holds the fixture session with both asset files. */
async function folderWithSession(name = 'MySession'): Promise<MockDir> {
  const dir = new MockDir(name);
  await saveToFolder(dir.handle, {
    session: makeSession(),
    brand: makeBrand(),
    blobs: new Map([
      [A, new Blob(['photo bytes'])],
      [B, new Blob(['video bytes!'])],
    ]),
  });
  dir.log.length = 0;
  return dir;
}

/** Opens a saved folder through the app, as the Open folder button does. */
async function openFolder(dir: MockDir) {
  pickerReturns(dir);
  expect(await openSessionFolder()).toBe(true);
  dir.log.length = 0;
}

/** Makes an edit so there is something to save. */
function edit(caption = 'Edited') {
  store().updateCard('card-1', (card) => {
    card.copy.caption = caption;
  });
}

/** Breaks the open session so the serializer rejects it, as a bug elsewhere might. */
function corruptSession() {
  useSessionStore.setState((state) => {
    if (state.session) (state.session as unknown as { name: unknown }).name = 42;
    state.dirty = true;
  });
}

/** Spies on every method of a folder that touches the file system. */
function watchFileSystem(dir: MockDir) {
  return [
    vi.spyOn(dir, 'getFileHandle'),
    vi.spyOn(dir, 'getDirectoryHandle'),
    vi.spyOn(dir, 'removeEntry'),
    vi.spyOn(dir, 'queryPermission'),
    vi.spyOn(dir, 'requestPermission'),
  ];
}

const writes = (dir: MockDir) => dir.log.filter((entry) => entry.startsWith('write '));

beforeEach(async () => {
  // Only the autosave interval and the clock are faked; JSZip needs real timers to run.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
  await requestClearSession(() => true);
  remembered.dir = null;
  store().setStatus(null);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'showDirectoryPicker');
});

describe('manual save', () => {
  it('says so when there is no session', async () => {
    expect(await saveSession()).toBe(false);
    expect(status()).toEqual({ kind: 'info', message: 'There is no session to save.' });
  });

  it('asks for a folder on the first save, writes the layout, and clears dirty', async () => {
    const dir = new MockDir('Fresh');
    const picker = pickerReturns(dir);
    newSession('Topping out');
    expect(store().dirty).toBe(true);
    expect(await saveSession()).toBe(true);
    expect(picker).toHaveBeenCalledTimes(1);
    expect(await dir.text('session.json')).toBe(serializeSession(open()));
    expect(await dir.text('brand.json')).toBe(serializeBrand(store().brand));
    expect([...dir.dirs.keys()].sort()).toEqual(['assets', 'exports', 'renders']);
    expect(store().dirty).toBe(false);
    expect(store().lastSavedAt).toBe('2026-11-16T12:00:00.000Z');
    expect(status()).toEqual({ kind: 'info', message: 'Saved to folder "Fresh".' });
    expect(currentFolderName()).toBe('Fresh');
  });

  it('writes the asset files held in memory', async () => {
    const dir = new MockDir();
    pickerReturns(dir);
    newSession('S');
    store().addAssets([{ asset: makeAsset(), blob: new Blob(['photo bytes']) }]);
    await saveSession();
    expect(await dir.dirs.get('assets')?.text(A)).toBe('photo bytes');
  });

  it('remembers the folder so a reload can reopen it', async () => {
    const dir = new MockDir();
    pickerReturns(dir);
    newSession('S');
    await saveSession();
    expect(rememberFolder).toHaveBeenCalledWith(dir.handle);
    expect(await recallFolder()).toBe(dir.handle);
  });

  it('does not ask for a folder again on later saves', async () => {
    const dir = new MockDir();
    const picker = pickerReturns(dir);
    newSession('S');
    await saveSession();
    store().addAssets([{ asset: makeAsset() }]);
    expect(await saveSession()).toBe(true);
    expect(picker).toHaveBeenCalledTimes(1);
    expect(store().dirty).toBe(false);
  });

  it('saves nothing when the folder picker is cancelled', async () => {
    pickerReturns(null);
    newSession('S');
    expect(await saveSession()).toBe(false);
    expect(store().dirty).toBe(true);
    expect(status()).toEqual({ kind: 'info', message: 'Save cancelled; no folder was chosen.' });
    expect(currentFolderName()).toBeNull();
  });

  it('refuses to save over a folder that holds a different session', async () => {
    const dir = await folderWithSession('Other');
    const before = await dir.text('session.json');
    pickerReturns(dir);
    newSession('Brand new');
    expect(await saveSession()).toBe(false);
    expect(dir.log).toEqual([]);
    expect(await dir.text('session.json')).toBe(before);
    expect(store().dirty).toBe(true);
    expect(status()?.kind).toBe('error');
    expect(status()?.message).toContain('Folder "Other" already holds another session');
    expect(currentFolderName()).toBeNull();
  });

  it('refuses a folder whose session.json cannot be read, rather than overwrite it', async () => {
    const dir = new MockDir('Odd').seed('session.json', 'garbage');
    pickerReturns(dir);
    newSession('S');
    expect(await saveSession()).toBe(false);
    expect(await dir.text('session.json')).toBe('garbage');
  });

  it('accepts a folder that already holds this same session', async () => {
    const dir = await folderWithSession();
    await loadBundle(
      await buildBundle({ session: makeSession(), brand: makeBrand(), blobs: new Map() }),
    );
    edit();
    pickerReturns(dir);
    expect(await saveSession()).toBe(true);
    expect(await dir.text('session.json')).toBe(serializeSession(open()));
  });

  it('reports a picker failure in the status line', async () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: () => Promise.reject(domError('SecurityError', 'Blocked by policy')),
      configurable: true,
    });
    newSession('S');
    expect(await saveSession()).toBe(false);
    expect(status()).toEqual({
      kind: 'error',
      message: 'Could not use that folder: Blocked by policy',
    });
  });

  it('points to the .scs download in a browser without folder access', async () => {
    newSession('S');
    expect(await saveSession()).toBe(false);
    expect(status()).toEqual({
      kind: 'info',
      message: 'This browser cannot save to a folder. Use Download .scs instead.',
    });
    expect(store().dirty).toBe(true);
  });

  it('asks for permission again after a reload, and saves when it is given', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit();
    dir.permission = 'prompt';
    expect(await saveSession()).toBe(true);
    expect(dir.prompts).toBe(1);
    expect(store().dirty).toBe(false);
  });

  it('saves nothing when permission is refused', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit();
    dir.permission = 'prompt';
    dir.permissionAfterPrompt = 'denied';
    expect(await saveSession()).toBe(false);
    expect(dir.log).toEqual([]);
    expect(store().dirty).toBe(true);
    expect(status()).toEqual({
      kind: 'error',
      message: 'Permission to write to folder "MySession" was not granted. Nothing was saved.',
    });
  });

  it('still saves when the folder cannot be remembered for next time', async () => {
    vi.mocked(rememberFolder).mockRejectedValueOnce(new Error('IndexedDB is unavailable'));
    const dir = new MockDir();
    pickerReturns(dir);
    newSession('S');
    expect(await saveSession()).toBe(true);
    expect(store().dirty).toBe(false);
  });
});

describe('a save that fails', () => {
  it('manual: a session that fails validation is caught, stays dirty, and writes nothing', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const before = await dir.text('session.json');
    corruptSession();
    expect(await saveSession()).toBe(false);
    expect(store().dirty).toBe(true);
    expect(status()).toEqual({
      kind: 'error',
      message: 'Could not save: session.name must be a string',
    });
    expect(dir.log).toEqual([]);
    expect(await dir.text('session.json')).toBe(before);
  });

  it('autosave: a session that fails validation is caught, stays dirty, and writes nothing', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const before = await dir.text('session.json');
    corruptSession();
    const stop = startAutosave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    stop();
    expect(store().dirty).toBe(true);
    expect(status()).toEqual({
      kind: 'error',
      message: 'Could not save: session.name must be a string',
    });
    expect(dir.log).toEqual([]);
    expect(await dir.text('session.json')).toBe(before);
  });

  it('autosave: a disk error part-way leaves the previous session.json and stays dirty', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const before = await dir.text('session.json');
    edit();
    dir.shared.beforeClose = (path) => {
      if (path === 'session.json') throw domError('QuotaExceededError', 'The disk is full');
    };
    const stop = startAutosave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(store().dirty).toBe(true);
    expect(status()).toEqual({ kind: 'error', message: 'Could not save: The disk is full' });
    expect(dir.log).not.toContain('write session.json');
    expect(await dir.text('session.json')).toBe(before);

    // The next autosave tries again and succeeds once the disk has room.
    dir.shared.beforeClose = undefined;
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    stop();
    expect(store().dirty).toBe(false);
    expect(await dir.text('session.json')).toBe(serializeSession(open()));
  });

  it('a failed autosave does not stop the timer or throw', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit();
    vi.spyOn(dir, 'queryPermission').mockRejectedValue(new Error('Handle is gone'));
    const stop = startAutosave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    stop();
    expect(status()).toEqual({ kind: 'error', message: 'Could not save: Handle is gone' });
    expect(store().dirty).toBe(true);
  });
});

describe('autosave', () => {
  it('runs every 30 seconds', () => {
    expect(AUTOSAVE_MS).toBe(30_000);
  });

  it('writes when there are unsaved changes and a folder is held, not before 30 seconds', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit('Autosaved');
    const stop = startAutosave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1);
    expect(dir.log).toEqual([]);
    expect(store().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    stop();
    expect(writes(dir)).toEqual(['write brand.json', 'write session.json']);
    expect(await dir.text('session.json')).toContain('Autosaved');
    expect(store().dirty).toBe(false);
  });

  it('does not write when nothing has changed', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const watched = watchFileSystem(dir);
    const stop = startAutosave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 4);
    stop();
    expect(dir.log).toEqual([]);
    for (const spy of watched) expect(spy).not.toHaveBeenCalled();
  });

  it('writes once per change, then goes quiet again', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const stop = startAutosave();
    edit('one');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    expect(writes(dir).filter((w) => w === 'write session.json')).toHaveLength(1);
    edit('two');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    stop();
    expect(writes(dir).filter((w) => w === 'write session.json')).toHaveLength(2);
  });

  it('does nothing for a session with no folder: no picker, no download', async () => {
    const picker = pickerReturns(new MockDir());
    newSession('Unsaved');
    const stop = startAutosave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    stop();
    expect(picker).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(store().dirty).toBe(true);
  });

  it('never triggers a download in bundle mode', async () => {
    const bundle = await buildBundle({
      session: makeSession(),
      brand: makeBrand(),
      blobs: new Map(),
    });
    await loadBundle(bundle, 'topping-out.scs');
    edit();
    const stop = startAutosave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 5);
    stop();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(store().dirty).toBe(true);
    expect(await autosave()).toBe(false);
  });

  it('does nothing when no session is open', async () => {
    expect(await autosave()).toBe(false);
    expect(status()).toBeNull();
  });

  it('never shows a permission prompt; it pauses and says so instead', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit();
    dir.permission = 'prompt';
    const stop = startAutosave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    stop();
    expect(dir.prompts).toBe(0);
    expect(dir.log).toEqual([]);
    expect(store().dirty).toBe(true);
    expect(status()).toEqual({
      kind: 'error',
      message:
        'Autosave is paused: folder "MySession" needs permission again. Press Save to continue.',
    });
  });

  it('stops when the stop function is called', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit();
    const stop = startAutosave();
    stop();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    expect(dir.log).toEqual([]);
  });

  it('does not overlap a save that is still running', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit();
    let release: (state: PermissionState) => void = () => undefined;
    vi.spyOn(dir, 'queryPermission').mockImplementationOnce(
      () => new Promise<PermissionState>((resolve) => (release = resolve)),
    );
    const first = saveSession();
    expect(await autosave()).toBe(false);
    expect(await saveSession()).toBe(false);
    expect(status()).toEqual({ kind: 'info', message: 'A save is already in progress.' });
    release('granted');
    expect(await first).toBe(true);
    expect(writes(dir).filter((w) => w === 'write session.json')).toHaveLength(1);
  });

  it('keeps dirty set when an edit lands while the save is running', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit('before');
    let release: (state: PermissionState) => void = () => undefined;
    vi.spyOn(dir, 'queryPermission').mockImplementationOnce(
      () => new Promise<PermissionState>((resolve) => (release = resolve)),
    );
    const running = autosave();
    edit('during');
    release('granted');
    expect(await running).toBe(true);
    expect(store().dirty).toBe(true);
  });
});

describe('validation results', () => {
  const result = {
    level: 'fail' as const,
    issues: [
      { rule: 1 as const, level: 'fail' as const, message: 'Wrong size.' },
      { rule: 8 as const, level: 'warn' as const, message: 'Alt text is missing.' },
    ],
  };

  it('set with setValidation survive a save and reopening the folder', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    expect(store().setValidation('card-1', result)).toBe(true);
    expect(await saveSession()).toBe(true);
    await requestClearSession(() => true);
    expect(store().session).toBeNull();
    await openFolder(dir);
    expect(open().cards.find((card) => card.id === 'card-1')?.validation).toEqual(result);
    expect(store().dirty).toBe(false);
  });

  it('do not trigger an autosave when the same result is recorded again', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const stop = startAutosave();
    store().setValidation('card-1', structuredClone(makeCard().validation));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    expect(dir.log).toEqual([]);
    store().setValidation('card-1', result);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    stop();
    expect(writes(dir)).toEqual(['write brand.json', 'write session.json']);
  });
});

describe('a background colour and a crop with padding', () => {
  const crop = PADDED_CROP;

  function padAndColour() {
    expect(
      store().updateCard('card-1', (card) => {
        card.background = CARD_COLOUR;
        if ('format' in card.edit) card.edit.crop = { ...crop };
      }),
    ).toBe(true);
  }
  const card1 = () => open().cards.find((card) => card.id === 'card-1') as Card;

  it('survive a save and reopening the folder', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    padAndColour();
    expect(await saveSession()).toBe(true);
    await requestClearSession(() => true);
    expect(store().session).toBeNull();
    await openFolder(dir);
    expect(card1().background).toBe(CARD_COLOUR);
    expect((card1().edit as ImageEdit).crop).toEqual(crop);
    expect(store().dirty).toBe(false);
    expect(store().undoStack).toEqual([]);
  });

  it('survive a .scs download and loading it again', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    padAndColour();
    expect(await downloadBundle()).toBe(true);
    const [bundle] = vi.mocked(downloadBlob).mock.calls[0] ?? [];
    await requestClearSession(() => true);
    expect(await loadBundle(bundle ?? new Blob(), 'padded.scs')).toBe(true);
    expect(card1().background).toBe(CARD_COLOUR);
    expect((card1().edit as ImageEdit).crop).toEqual(crop);
    expect(store().dirty).toBe(false);
  });

  it('a card with no colour is saved and reopened with none, and no colour is written', async () => {
    // The fixture session is like one the app has just made: no card has a colour.
    const dir = await folderWithSession();
    await openFolder(dir);
    expect(Object.hasOwn(card1(), 'background')).toBe(false);
    edit();
    expect(await saveSession()).toBe(true);
    expect(await dir.text('session.json')).not.toContain('background');
    await requestClearSession(() => true);
    await openFolder(dir);
    for (const card of open().cards) expect(Object.hasOwn(card, 'background')).toBe(false);
  });

  it('a colour that is taken off again is not written', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    padAndColour();
    expect(await saveSession()).toBe(true);
    expect(await dir.text('session.json')).toContain(`"background": "${CARD_COLOUR}"`);
    expect(store().undo()).toBe(true);
    expect(await saveSession()).toBe(true);
    expect(await dir.text('session.json')).not.toContain('background');
  });
});

describe('opening a folder', () => {
  it('loads the session, the brand kit and the asset files', async () => {
    const dir = await folderWithSession();
    pickerReturns(dir);
    expect(await openSessionFolder()).toBe(true);
    expect(open()).toEqual(makeSession());
    expect(store().brand).toEqual(makeBrand());
    expect(await getAssetBlob(A)?.text()).toBe('photo bytes');
    expect(await getAssetBlob(B)?.text()).toBe('video bytes!');
    expect(store().missingAssetIds).toEqual([]);
    expect(store().dirty).toBe(false);
    expect(status()).toEqual({
      kind: 'info',
      message: 'Opened "Topping out" from folder "MySession".',
    });
    expect(currentFolderName()).toBe('MySession');
    expect(await recallFolder()).toBe(dir.handle);
    expect(dir.log).toEqual([]);
  });

  it('status line names the missing asset files, and the session still loads', async () => {
    const dir = await folderWithSession();
    dir.dirs.get('assets')?.files.delete(B);
    pickerReturns(dir);
    expect(await openSessionFolder()).toBe(true);
    expect(open().assets).toHaveLength(2);
    expect(store().missingAssetIds).toEqual([B]);
    expect(status()).toEqual({
      kind: 'warning',
      message: 'Opened "Topping out" from folder "MySession". Missing asset file: clip.mp4.',
    });
  });

  it('status line lists several missing files by name', async () => {
    const dir = await folderWithSession();
    dir.dirs.delete('assets');
    pickerReturns(dir);
    await openSessionFolder();
    expect(status()?.message).toBe(
      'Opened "Topping out" from folder "MySession". Missing asset files: site.jpg, clip.mp4.',
    );
  });

  it('status line says when brand.json was not found', async () => {
    const dir = await folderWithSession();
    dir.files.delete('brand.json');
    pickerReturns(dir);
    expect(await openSessionFolder()).toBe(true);
    expect(status()).toEqual({
      kind: 'warning',
      message:
        'Opened "Topping out" from folder "MySession". brand.json not found; starting with an empty brand kit.',
    });
  });

  it('status line carries both notes when both apply', async () => {
    const dir = await folderWithSession();
    dir.files.delete('brand.json');
    dir.dirs.get('assets')?.files.delete(A);
    pickerReturns(dir);
    await openSessionFolder();
    expect(status()?.message).toBe(
      'Opened "Topping out" from folder "MySession". ' +
        'brand.json not found; starting with an empty brand kit. Missing asset file: site.jpg.',
    );
  });

  it('changes nothing when the picker is cancelled', async () => {
    newSession('Keep me');
    const before = status();
    pickerReturns(null);
    expect(await openSessionFolder()).toBe(false);
    expect(open().name).toBe('Keep me');
    expect(status()).toEqual(before);
  });

  it('keeps the current session and reports the error when the folder cannot be loaded', async () => {
    newSession('Keep me');
    pickerReturns(new MockDir('Empty'));
    expect(await openSessionFolder()).toBe(false);
    expect(open().name).toBe('Keep me');
    expect(status()).toEqual({
      kind: 'error',
      message: 'Could not open the folder: This folder does not contain a session.json',
    });
    expect(currentFolderName()).toBeNull();
  });
});

describe('reopening the last session', () => {
  it('says so when no folder is remembered', async () => {
    expect(await reopenLastSession()).toBe(false);
    expect(status()).toEqual({
      kind: 'info',
      message: 'There is no earlier session folder to reopen.',
    });
  });

  it('re-requests permission after a reload and loads the session when it is given', async () => {
    const dir = await folderWithSession();
    remembered.dir = dir.handle;
    dir.permission = 'prompt';
    expect(await reopenLastSession()).toBe(true);
    expect(dir.prompts).toBe(1);
    expect(open()).toEqual(makeSession());
    expect(await getAssetBlob(A)?.text()).toBe('photo bytes');
    expect(currentFolderName()).toBe('MySession');
    expect(status()?.message).toBe('Opened "Topping out" from folder "MySession".');
  });

  it('does not prompt when permission is still granted', async () => {
    const dir = await folderWithSession();
    remembered.dir = dir.handle;
    expect(await reopenLastSession()).toBe(true);
    expect(dir.prompts).toBe(0);
  });

  it('handles the user denying permission with a clear message, and loads nothing', async () => {
    const dir = await folderWithSession();
    remembered.dir = dir.handle;
    dir.permission = 'prompt';
    dir.permissionAfterPrompt = 'denied';
    const lookups = vi.spyOn(dir, 'getFileHandle');
    expect(await reopenLastSession()).toBe(false);
    expect(dir.prompts).toBe(1);
    expect(lookups).not.toHaveBeenCalled();
    expect(store().session).toBeNull();
    expect(currentFolderName()).toBeNull();
    expect(status()).toEqual({
      kind: 'error',
      message:
        'Permission to open folder "MySession" was not granted, so the session was not reopened. ' +
        'Press Reopen last to be asked again, or Open folder to choose it.',
    });
    // The folder is still remembered, so the user can try again.
    expect(await recallFolder()).toBe(dir.handle);
  });

  it('autosaves into the reopened folder afterwards', async () => {
    const dir = await folderWithSession();
    remembered.dir = dir.handle;
    await reopenLastSession();
    edit('After reload');
    const stop = startAutosave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    stop();
    expect(await dir.text('session.json')).toContain('After reload');
  });

  it('reports a failure to read the remembered folder', async () => {
    remembered.dir = new MockDir('Gone').handle;
    expect(await reopenLastSession()).toBe(false);
    expect(status()).toEqual({
      kind: 'error',
      message: 'Could not reopen the last session: This folder does not contain a session.json',
    });
  });
});

describe('.scs bundle', () => {
  const fixtureBundle = (blobs = new Map([[A, new Blob(['photo bytes'])]])) =>
    buildBundle({ session: makeSession(), brand: makeBrand(), blobs });

  it('download builds the bundle, hands it to the browser, and clears dirty', async () => {
    newSession('Q4: site visit');
    store().addAssets([{ asset: makeAsset(), blob: new Blob(['photo bytes']) }]);
    expect(await downloadBundle()).toBe(true);
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [bundle, fileName] = vi.mocked(downloadBlob).mock.calls[0] ?? [];
    expect(fileName).toBe('Q4_ site visit.scs');
    expect(store().dirty).toBe(false);
    expect(status()).toEqual({ kind: 'info', message: 'Downloaded Q4_ site visit.scs.' });

    // What was downloaded loads back as the same session.
    const saved = open();
    expect(await loadBundle(bundle ?? new Blob(), 'Q4_ site visit.scs')).toBe(true);
    expect(open()).toEqual(saved);
    expect(await getAssetBlob(A)?.text()).toBe('photo bytes');
  });

  it('download says so when there is no session', async () => {
    expect(await downloadBundle()).toBe(false);
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(status()).toEqual({ kind: 'info', message: 'There is no session to download.' });
  });

  it('downloading a copy of a folder session does not mark the folder as saved', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit();
    expect(await downloadBundle()).toBe(true);
    expect(store().dirty).toBe(true);
    expect(dir.log).toEqual([]);
  });

  it('status line says when the session is too large to bundle in memory', async () => {
    newSession('Huge');
    const huge = new Blob(['x']);
    huge.arrayBuffer = () => Promise.reject(new RangeError('Array buffer allocation failed'));
    store().addAssets([{ asset: makeAsset(), blob: huge }]);
    expect(await downloadBundle()).toBe(false);
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(store().dirty).toBe(true);
    expect(status()).toEqual({
      kind: 'error',
      message:
        'This session is too large to bundle in browser memory. Save it to a folder in Chrome or Edge instead.',
    });
  });

  it('status line says when a bundle is too large to open in memory', async () => {
    newSession('Keep me');
    const huge = new Blob(['x']);
    huge.arrayBuffer = () => Promise.reject(new RangeError('Array buffer allocation failed'));
    expect(await loadBundle(huge, 'huge.scs')).toBe(false);
    expect(open().name).toBe('Keep me');
    expect(status()).toEqual({
      kind: 'error',
      message:
        'This .scs bundle is too large to open in browser memory. Unzip it and open the folder in Chrome or Edge instead.',
    });
  });

  it('load reports a file that is not a bundle', async () => {
    expect(await loadBundle(new Blob(['nope']))).toBe(false);
    expect(status()).toEqual({ kind: 'error', message: 'This file is not a valid .scs bundle.' });
  });

  it('load brings in the session and its assets, and names any missing files', async () => {
    expect(await loadBundle(await fixtureBundle(), 'topping-out.scs')).toBe(true);
    expect(open()).toEqual(makeSession());
    expect([...assetBlobs().keys()]).toEqual([A]);
    expect(store().missingAssetIds).toEqual([B]);
    expect(store().dirty).toBe(false);
    expect(status()).toEqual({
      kind: 'warning',
      message: 'Opened "Topping out" from bundle "topping-out.scs". Missing asset file: clip.mp4.',
    });
  });

  it('a loaded bundle has no folder, even if one was open before', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    await loadBundle(await fixtureBundle());
    expect(currentFolderName()).toBeNull();
    edit();
    const stop = startAutosave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    stop();
    expect(dir.log).toEqual([]);
  });
});

describe('clear session', () => {
  it('does nothing unless confirmed', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit();
    const before = status();
    expect(await requestClearSession(() => false)).toBe(false);
    expect(open().cards).toHaveLength(3);
    expect(store().dirty).toBe(true);
    expect(currentFolderName()).toBe('MySession');
    expect(forgetFolder).not.toHaveBeenCalled();
    expect(status()).toEqual(before);
  });

  it('empties the store, the asset contents and the undo history when confirmed', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit();
    expect(store().undoStack).toHaveLength(1);
    expect(await requestClearSession(() => true)).toBe(true);
    expect(store().session).toBeNull();
    expect(assetBlobs().size).toBe(0);
    expect(store().undoStack).toEqual([]);
    expect(store().undo()).toBe(false);
    expect(store().dirty).toBe(false);
    expect(status()).toEqual({
      kind: 'info',
      message: 'Session cleared. Nothing on disk was deleted.',
    });
  });

  it('releases and forgets the folder', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    await requestClearSession(() => true);
    expect(currentFolderName()).toBeNull();
    expect(forgetFolder).toHaveBeenCalledTimes(1);
    expect(await recallFolder()).toBeNull();
    expect(await reopenLastSession()).toBe(false);
  });

  it('makes zero file-system calls and leaves every file on disk', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit();
    const sessionBefore = await dir.text('session.json');
    const watched = [...watchFileSystem(dir), ...watchFileSystem(dir.seedDir('assets'))];
    expect(await requestClearSession(() => true)).toBe(true);
    for (const spy of watched) expect(spy).not.toHaveBeenCalled();
    expect(dir.log).toEqual([]);
    expect(await dir.text('session.json')).toBe(sessionBefore);
    expect([...dir.files.keys()].sort()).toEqual(['brand.json', 'session.json']);
    expect([...(dir.dirs.get('assets')?.files.keys() ?? [])].sort()).toEqual([A, B]);
  });

  it('still clears when the remembered folder cannot be forgotten', async () => {
    vi.mocked(forgetFolder).mockRejectedValueOnce(new Error('IndexedDB is unavailable'));
    newSession('S');
    expect(await requestClearSession(() => true)).toBe(true);
    expect(store().session).toBeNull();
  });

  it('a save that was running when the session was cleared does not mark anything saved', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    edit();
    let release: (state: PermissionState) => void = () => undefined;
    vi.spyOn(dir, 'queryPermission').mockImplementationOnce(
      () => new Promise<PermissionState>((resolve) => (release = resolve)),
    );
    const running = saveSession();
    await requestClearSession(() => true);
    release('granted');
    await running;
    expect(store().session).toBeNull();
    expect(store().lastSavedAt).toBeNull();
    expect(status()?.message).toBe('Session cleared. Nothing on disk was deleted.');
  });
});

describe("when the browser's database is slow to remember or forget the folder", () => {
  const CLEARED = 'Session cleared. Nothing on disk was deleted.';
  const bundle = () =>
    buildBundle({
      session: makeSession({ id: 'from-bundle', name: 'From a bundle' }),
      brand: makeBrand(),
      blobs: new Map([
        [A, new Blob(['photo bytes'])],
        [B, new Blob(['video bytes!'])],
      ]),
    });

  /**
   * Makes the next call of a folder-memory function finish only when the test says so. The
   * change itself still happens at once, as in the browser: a database carries out its writes
   * in the order they were asked for, and only the answer comes back late.
   */
  function slow(fn: typeof forgetFolder | typeof rememberFolder, change: () => void) {
    let finish: () => void = () => undefined;
    vi.mocked(fn as typeof forgetFolder).mockImplementationOnce(() => {
      change();
      return new Promise<void>((resolve) => (finish = resolve));
    });
    return () => finish();
  }
  const slowForget = () => slow(forgetFolder, () => (remembered.dir = null));

  it('Clear says so at once, without waiting for the folder to be forgotten', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const finish = slowForget();
    const clearing = requestClearSession(() => true);
    // Still forgetting the folder, and already cleared and saying so.
    expect(store().session).toBeNull();
    expect(currentFolderName()).toBeNull();
    expect(status()).toEqual({ kind: 'info', message: CLEARED });
    finish();
    expect(await clearing).toBe(true);
    expect(status()).toEqual({ kind: 'info', message: CLEARED });
  });

  it('Clear, then Load .scs before the folder is forgotten: the status is the loaded session', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const file = await bundle();
    const finish = slowForget();
    const clearing = requestClearSession(() => true);
    expect(await loadBundle(file, 'later.scs')).toBe(true);
    // The clear finishes last. It must not touch the session that was opened after it.
    finish();
    expect(await clearing).toBe(true);
    expect(open().id).toBe('from-bundle');
    expect(store().dirty).toBe(false);
    expect(currentFolderName()).toBeNull();
    expect(status()).toEqual({
      kind: 'info',
      message: 'Opened "From a bundle" from bundle "later.scs".',
    });
  });

  it('Clear, then Open folder before the folder is forgotten: the new folder is kept and remembered', async () => {
    const first = await folderWithSession('First');
    await openFolder(first);
    const second = await folderWithSession('Second');
    const finish = slowForget();
    const clearing = requestClearSession(() => true);
    pickerReturns(second);
    expect(await openSessionFolder()).toBe(true);
    finish();
    expect(await clearing).toBe(true);
    // The folder the session saves to and the folder Reopen last will offer are the new one:
    // the database forgets the old folder before it remembers the new one, however late it
    // answers.
    expect(currentFolderName()).toBe('Second');
    expect(await recallFolder()).toBe(second.handle);
    // And the status is the new session's.
    expect(status()).toEqual({
      kind: 'info',
      message: 'Opened "Topping out" from folder "Second".',
    });
    // The session still saves to its folder, and only to it.
    edit();
    expect(await autosave()).toBe(true);
    expect(writes(second).length).toBeGreaterThan(0);
    expect(writes(first)).toEqual([]);
    expect(store().dirty).toBe(false);
  });

  it('Clear, then New session before the folder is forgotten: the status is the new session', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const finish = slowForget();
    const clearing = requestClearSession(() => true);
    newSession('Next');
    finish();
    expect(await clearing).toBe(true);
    expect(open().name).toBe('Next');
    expect(store().dirty).toBe(true);
    expect(currentFolderName()).toBeNull();
    expect(status()).toEqual({ kind: 'info', message: 'Started "Next". It is not saved yet.' });
  });

  it('Open folder, then Load .scs before the folder is remembered: the status is the bundle', async () => {
    const dir = await folderWithSession();
    const file = await bundle();
    const finish = slow(rememberFolder, () => (remembered.dir = dir.handle));
    pickerReturns(dir);
    const opening = openSessionFolder();
    // Wait until the folder's session is in the store and only remembering is left.
    await vi.waitFor(() => expect(rememberFolder).toHaveBeenCalledTimes(1));
    expect(await loadBundle(file, 'later.scs')).toBe(true);
    finish();
    expect(await opening).toBe(true);
    // The bundle was opened last, so it is the open session, with no folder, and says so.
    expect(open().id).toBe('from-bundle');
    expect(currentFolderName()).toBeNull();
    expect(status()).toEqual({
      kind: 'info',
      message: 'Opened "From a bundle" from bundle "later.scs".',
    });
  });
});

describe('the previously opened folder is never written by a later session', () => {
  it('after Clear session and then New session, autosave writes nothing to it', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const sessionBefore = await dir.text('session.json');
    const watched = watchFileSystem(dir);
    const stop = startAutosave();

    await requestClearSession(() => true);
    newSession('Second');
    store().addAssets([{ asset: makeAsset(), blob: new Blob(['x']) }]);
    store().addCard(makeCard());
    expect(store().dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 5);
    stop();
    for (const spy of watched) expect(spy).not.toHaveBeenCalled();
    expect(dir.log).toEqual([]);
    expect(await dir.text('session.json')).toBe(sessionBefore);
    expect(store().dirty).toBe(true);
  });

  it('after New session alone, autosave writes nothing to it', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const sessionBefore = await dir.text('session.json');
    const watched = watchFileSystem(dir);
    const stop = startAutosave();

    newSession('Second');
    store().addCard(makeCard());
    expect(currentFolderName()).toBeNull();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 5);
    stop();
    for (const spy of watched) expect(spy).not.toHaveBeenCalled();
    expect(dir.log).toEqual([]);
    expect(await dir.text('session.json')).toBe(sessionBefore);
  });

  it('a manual save of the new session asks for a folder instead of reusing the old one', async () => {
    const old = await folderWithSession('Old');
    await openFolder(old);
    newSession('Second');
    const fresh = new MockDir('New');
    const picker = pickerReturns(fresh);
    expect(await saveSession()).toBe(true);
    expect(picker).toHaveBeenCalledTimes(1);
    expect(old.log).toEqual([]);
    expect(fresh.files.has('session.json')).toBe(true);
  });

  it('even a session created directly in the store cannot reach the old folder', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    store().createSession('Bypassed persistence');
    store().addCard(makeCard());
    const stop = startAutosave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    stop();
    expect(dir.log).toEqual([]);
    expect(currentFolderName()).toBeNull();
  });

  it('New session keeps the old folder remembered, so Reopen last can go back to it', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    newSession('Second');
    expect(status()).toEqual({ kind: 'info', message: 'Started "Second". It is not saved yet.' });
    expect(await reopenLastSession()).toBe(true);
    expect(open()).toEqual(makeSession());
  });
});

describe('the folder for an export', () => {
  it('is null with no open session, and nothing is asked', async () => {
    expect(await exportFolderFor('session-1')).toBeNull();
  });

  it('is null for a session that has no folder yet', async () => {
    newSession('Unsaved');
    expect(await exportFolderFor(open().id)).toBeNull();
  });

  it('is null for any session but the open one, and nothing is asked', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const spies = watchFileSystem(dir);
    expect(await exportFolderFor('another-session')).toBeNull();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(dir.prompts).toBe(0);
  });

  it("is the open session's folder when permission is already granted, with no prompt", async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    expect(await exportFolderFor(open().id)).toBe(dir.handle);
    expect(dir.prompts).toBe(0);
    expect(dir.log).toEqual([]);
  });

  it('asks for permission once when it is needed, and gives the folder if it is granted', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    dir.permission = 'prompt';
    dir.permissionAfterPrompt = 'granted';
    expect(await exportFolderFor(open().id)).toBe(dir.handle);
    expect(dir.prompts).toBe(1);
  });

  it('is null when permission is refused', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    dir.permission = 'prompt';
    dir.permissionAfterPrompt = 'denied';
    expect(await exportFolderFor(open().id)).toBeNull();
    expect(dir.prompts).toBe(1);
  });

  it('is never the folder of an earlier session', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    const earlier = open().id;
    newSession('Second');
    expect(await exportFolderFor(open().id)).toBeNull();
    expect(await exportFolderFor(earlier)).toBeNull();
    await requestClearSession(() => true);
    expect(await exportFolderFor(earlier)).toBeNull();
    expect(dir.prompts).toBe(0);
  });

  it('writes nothing to the folder', async () => {
    const dir = await folderWithSession();
    await openFolder(dir);
    dir.permission = 'prompt';
    await exportFolderFor(open().id);
    expect(dir.log).toEqual([]);
  });
});
