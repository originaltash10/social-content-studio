import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensurePermission,
  existingSession,
  loadFromFolder,
  pickFolder,
  saveToFolder,
  supportsFolders,
} from './fsAccess';
import { emptyBrand } from './layout';
import type { SessionFiles } from './layout';
import { SessionFormatError, serializeBrand, serializeSession } from './serialize';
import {
  CARD_COLOUR,
  PADDED_CROP,
  hash,
  makeAsset,
  makeBrand,
  makeColouredCard,
  makeSession,
} from '../../test/fixtures';
import { MockDir, domError } from '../../test/mockFs';
import type { ImageEdit, Session } from '../../types';

const A = hash('a');
const B = hash('b');

function files(overrides: Partial<SessionFiles> = {}): SessionFiles {
  return {
    session: makeSession(),
    brand: makeBrand(),
    blobs: new Map([
      [A, new Blob(['photo bytes'])],
      [B, new Blob(['video bytes!'])],
    ]),
    ...overrides,
  };
}

/** A folder that already holds a saved session. */
async function savedFolder(input = files()): Promise<MockDir> {
  const dir = new MockDir();
  await saveToFolder(dir.handle, input);
  dir.log.length = 0;
  return dir;
}

function subfolder(dir: MockDir, name: string): MockDir {
  const sub = dir.dirs.get(name);
  if (!sub) throw new Error(`expected a ${name} folder`);
  return sub;
}

describe('saveToFolder', () => {
  it('writes the SPEC.md folder layout', async () => {
    const dir = new MockDir();
    await saveToFolder(dir.handle, files());
    expect([...dir.files.keys()].sort()).toEqual(['brand.json', 'session.json']);
    expect([...dir.dirs.keys()].sort()).toEqual(['assets', 'exports', 'renders']);
    expect([...subfolder(dir, 'assets').files.keys()].sort()).toEqual([A, B]);
    expect(subfolder(dir, 'renders').files.size).toBe(0);
    expect(subfolder(dir, 'exports').files.size).toBe(0);
  });

  it('writes the serializer output and the asset bytes unchanged', async () => {
    const input = files();
    const dir = new MockDir();
    await saveToFolder(dir.handle, input);
    expect(await dir.text('session.json')).toBe(serializeSession(input.session));
    expect(await dir.text('brand.json')).toBe(serializeBrand(input.brand));
    expect(await subfolder(dir, 'assets').text(A)).toBe('photo bytes');
    expect(await subfolder(dir, 'assets').text(B)).toBe('video bytes!');
  });

  it('writes assets before session.json, and session.json last', async () => {
    const dir = new MockDir();
    await saveToFolder(dir.handle, files());
    const writes = dir.log.filter((entry) => entry.startsWith('write '));
    expect(writes).toEqual([
      `write assets/${A}`,
      `write assets/${B}`,
      'write brand.json',
      'write session.json',
    ]);
  });

  it('a second save does not rewrite an asset file that already exists', async () => {
    const dir = await savedFolder();
    await saveToFolder(dir.handle, files());
    expect(dir.log).toEqual(['write brand.json', 'write session.json']);
  });

  it('writes only the new asset when one is added to a saved session', async () => {
    const dir = await savedFolder();
    const C = hash('c');
    const input = files();
    const session = {
      ...input.session,
      assets: [...input.session.assets, makeAsset({ id: C })],
    };
    const blobs = new Map([...input.blobs, [C, new Blob(['new'])]]);
    await saveToFolder(dir.handle, { ...input, session, blobs });
    expect(dir.log.filter((entry) => entry.includes('assets/'))).toEqual([`write assets/${C}`]);
  });

  it('rewrites an asset file whose size does not match (an interrupted earlier write)', async () => {
    const dir = await savedFolder();
    subfolder(dir, 'assets').seed(A, '');
    await saveToFolder(dir.handle, files());
    expect(dir.log).toContain(`write assets/${A}`);
    expect(dir.log).not.toContain(`write assets/${B}`);
    expect(await subfolder(dir, 'assets').text(A)).toBe('photo bytes');
  });

  it('skips assets it has no file contents for', async () => {
    const dir = new MockDir();
    await saveToFolder(dir.handle, files({ blobs: new Map([[A, new Blob(['photo bytes'])]]) }));
    expect([...subfolder(dir, 'assets').files.keys()]).toEqual([A]);
  });

  it('does not write file contents for ids the session does not list', async () => {
    const dir = new MockDir();
    const stray = hash('f');
    const input = files();
    await saveToFolder(dir.handle, {
      ...input,
      blobs: new Map([...input.blobs, [stray, new Blob(['stray'])]]),
    });
    expect(subfolder(dir, 'assets').files.has(stray)).toBe(false);
  });

  it('writes nothing at all when the session fails validation', async () => {
    const dir = await savedFolder();
    const before = await dir.text('session.json');
    const broken = { ...makeSession(), name: 42 } as unknown as Session;
    await expect(saveToFolder(dir.handle, files({ session: broken }))).rejects.toThrow(
      SessionFormatError,
    );
    expect(dir.log).toEqual([]);
    expect(await dir.text('session.json')).toBe(before);
  });

  it('writes nothing at all when the brand kit fails validation', async () => {
    const dir = new MockDir();
    const brand = { ...makeBrand(), voice: null } as unknown as SessionFiles['brand'];
    await expect(saveToFolder(dir.handle, files({ brand }))).rejects.toThrow(
      'brand.voice must be a string',
    );
    expect(dir.log).toEqual([]);
  });

  it('a write that fails part-way is aborted and leaves the previous session.json intact', async () => {
    const dir = await savedFolder();
    const before = await dir.text('session.json');
    dir.shared.beforeClose = (path) => {
      if (path === 'session.json') throw domError('QuotaExceededError', 'Disk is full');
    };
    const renamed = { ...makeSession(), name: 'Renamed' };
    await expect(saveToFolder(dir.handle, files({ session: renamed }))).rejects.toThrow(
      'Disk is full',
    );
    expect(dir.log).toContain('abort session.json');
    expect(dir.log).not.toContain('write session.json');
    expect(await dir.text('session.json')).toBe(before);
  });

  it('reports the original error even if aborting the write also fails', async () => {
    const dir = new MockDir();
    dir.shared.beforeClose = () => {
      throw domError('QuotaExceededError', 'Disk is full');
    };
    const realPush = dir.log.push.bind(dir.log);
    dir.log.push = (...entries: string[]) => {
      if (entries.some((entry) => entry.startsWith('abort '))) throw new Error('abort failed');
      return realPush(...entries);
    };
    await expect(saveToFolder(dir.handle, files())).rejects.toThrow('Disk is full');
  });

  it('passes on an unexpected error while checking for an existing asset', async () => {
    const dir = new MockDir();
    dir.shared.beforeLookup = (path) => {
      if (path === `assets/${A}`) throw domError('NotReadableError', 'Drive unplugged');
    };
    await expect(saveToFolder(dir.handle, files())).rejects.toThrow('Drive unplugged');
    expect(dir.files.has('session.json')).toBe(false);
  });

  it('never removes anything', async () => {
    const dir = await savedFolder();
    dir.seed('notes.txt', 'mine');
    subfolder(dir, 'exports').seed('old.jpg', 'export');
    await saveToFolder(dir.handle, files({ session: makeSession({ assets: [], cards: [] }) }));
    expect(dir.log.some((entry) => entry.startsWith('remove '))).toBe(false);
    expect(dir.files.has('notes.txt')).toBe(true);
    expect(subfolder(dir, 'exports').files.has('old.jpg')).toBe(true);
    expect(subfolder(dir, 'assets').files.size).toBe(2);
  });
});

describe('loadFromFolder', () => {
  it('reads back the session, the brand kit, and every asset file', async () => {
    const input = files();
    const dir = await savedFolder(input);
    const loaded = await loadFromFolder(dir.handle);
    expect(loaded.session).toEqual(input.session);
    expect(loaded.brand).toEqual(input.brand);
    expect(loaded.missingAssetIds).toEqual([]);
    expect([...loaded.blobs.keys()].sort()).toEqual([A, B]);
    expect(await loaded.blobs.get(A)?.text()).toBe('photo bytes');
    expect(await loaded.blobs.get(B)?.text()).toBe('video bytes!');
  });

  it('writes no background colour for cards that have none, and reads them back with none', async () => {
    // The fixture session is like one the app has just made: no card has a colour.
    const dir = await savedFolder();
    expect(await dir.text('session.json')).not.toContain('background');
    const loaded = await loadFromFolder(dir.handle);
    expect(loaded.session).toEqual(makeSession());
    for (const card of loaded.session.cards) expect(Object.hasOwn(card, 'background')).toBe(false);
  });

  it('reads back a background colour and a crop with padding as they were saved', async () => {
    const session = makeSession({ cards: [makeColouredCard(), ...makeSession().cards.slice(1)] });
    const dir = await savedFolder(files({ session }));
    expect(await dir.text('session.json')).toContain(`"background": "${CARD_COLOUR}"`);
    const loaded = await loadFromFolder(dir.handle);
    expect(loaded.session).toEqual(session);
    expect(loaded.session.cards[0]?.background).toBe(CARD_COLOUR);
    expect((loaded.session.cards[0]?.edit as ImageEdit).crop).toEqual(PADDED_CROP);
    // The cards beside it still have no colour.
    expect(Object.hasOwn(loaded.session.cards[1] as object, 'background')).toBe(false);
  });

  it('still loads when an asset file is missing, and reports which one', async () => {
    const dir = await savedFolder();
    subfolder(dir, 'assets').files.delete(B);
    const loaded = await loadFromFolder(dir.handle);
    expect(loaded.session).toEqual(makeSession());
    expect(loaded.missingAssetIds).toEqual([B]);
    expect([...loaded.blobs.keys()]).toEqual([A]);
  });

  it('reports every asset as missing when there is no assets folder', async () => {
    const dir = await savedFolder();
    dir.dirs.delete('assets');
    const loaded = await loadFromFolder(dir.handle);
    expect(loaded.missingAssetIds).toEqual([A, B]);
    expect(loaded.blobs.size).toBe(0);
  });

  it('writes nothing', async () => {
    const dir = await savedFolder();
    dir.dirs.delete('assets');
    await loadFromFolder(dir.handle);
    expect(dir.log).toEqual([]);
    expect(dir.dirs.has('assets')).toBe(false);
  });

  it('gives a clear error for a folder with no session.json', async () => {
    const dir = new MockDir();
    await expect(loadFromFolder(dir.handle)).rejects.toThrow(SessionFormatError);
    await expect(loadFromFolder(dir.handle)).rejects.toThrow(
      'This folder does not contain a session.json',
    );
  });

  it('loads an empty brand kit and says so when brand.json is absent', async () => {
    const dir = await savedFolder();
    dir.files.delete('brand.json');
    const loaded = await loadFromFolder(dir.handle);
    expect(loaded.brand).toEqual(emptyBrand());
    expect(loaded.brandMissing).toBe(true);
  });

  it('does not flag the brand kit as missing when brand.json is there', async () => {
    const dir = await savedFolder();
    expect((await loadFromFolder(dir.handle)).brandMissing).toBe(false);
  });

  it('rejects a session.json that does not match the data model', async () => {
    const dir = await savedFolder();
    dir.seed('session.json', '{"version":1}');
    await expect(loadFromFolder(dir.handle)).rejects.toThrow('session.id must be a string');
  });

  it('rejects a malformed brand.json', async () => {
    const dir = await savedFolder();
    dir.seed('brand.json', 'not json');
    await expect(loadFromFolder(dir.handle)).rejects.toThrow('brand.json is not valid JSON');
  });

  it('passes on an unexpected error reading a file', async () => {
    const dir = await savedFolder();
    dir.shared.beforeLookup = (path) => {
      if (path === 'session.json') throw domError('NotReadableError', 'Drive unplugged');
    };
    await expect(loadFromFolder(dir.handle)).rejects.toThrow('Drive unplugged');
  });

  it('passes on an unexpected error opening the assets folder', async () => {
    const dir = await savedFolder();
    dir.shared.beforeLookup = (path) => {
      if (path === 'assets') throw domError('SecurityError', 'Not allowed');
    };
    await expect(loadFromFolder(dir.handle)).rejects.toThrow('Not allowed');
  });
});

describe('pickFolder', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'showDirectoryPicker');
  });

  function stubPicker(picker: () => Promise<unknown>) {
    const spy = vi.fn(picker);
    Object.defineProperty(window, 'showDirectoryPicker', { value: spy, configurable: true });
    return spy;
  }

  it('reports whether the browser can open folders', () => {
    expect(supportsFolders()).toBe(false);
    stubPicker(() => Promise.resolve(null));
    expect(supportsFolders()).toBe(true);
  });

  it('asks for read and write access and returns the chosen folder', async () => {
    const dir = new MockDir();
    const picker = stubPicker(() => Promise.resolve(dir.handle));
    expect(await pickFolder()).toBe(dir.handle);
    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' });
  });

  it('returns null when the user cancels the picker', async () => {
    stubPicker(() => Promise.reject(domError('AbortError')));
    expect(await pickFolder()).toBeNull();
  });

  it('passes on any other error', async () => {
    stubPicker(() => Promise.reject(domError('SecurityError', 'Blocked')));
    await expect(pickFolder()).rejects.toThrow('Blocked');
    stubPicker(() => Promise.reject('just a string'));
    await expect(pickFolder()).rejects.toBe('just a string');
  });
});

describe('ensurePermission', () => {
  it('is true without prompting when access is already granted', async () => {
    const dir = new MockDir();
    expect(await ensurePermission(dir.handle, true)).toBe(true);
    expect(dir.prompts).toBe(0);
  });

  it('does not prompt unless asked to', async () => {
    const dir = new MockDir();
    dir.permission = 'prompt';
    expect(await ensurePermission(dir.handle, false)).toBe(false);
    expect(dir.prompts).toBe(0);
  });

  it('prompts after a reload and is true when the user allows it', async () => {
    const dir = new MockDir();
    dir.permission = 'prompt';
    expect(await ensurePermission(dir.handle, true)).toBe(true);
    expect(dir.prompts).toBe(1);
  });

  it('is false when the user refuses', async () => {
    const dir = new MockDir();
    dir.permission = 'prompt';
    dir.permissionAfterPrompt = 'denied';
    expect(await ensurePermission(dir.handle, true)).toBe(false);
  });
});

describe('existingSession', () => {
  it('finds nothing in an empty folder', async () => {
    expect(await existingSession(new MockDir().handle)).toEqual({ found: false });
  });

  it('reports the id of the session a folder holds', async () => {
    const dir = await savedFolder();
    expect(await existingSession(dir.handle)).toEqual({ found: true, id: 'session-1' });
  });

  it('reports a session.json it cannot read, without an id', async () => {
    const dir = new MockDir().seed('session.json', 'garbage');
    expect(await existingSession(dir.handle)).toEqual({ found: true, id: null });
  });

  it('writes nothing', async () => {
    const dir = await savedFolder();
    await existingSession(dir.handle);
    expect(dir.log).toEqual([]);
  });
});
