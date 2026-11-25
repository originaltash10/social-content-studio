import 'fake-indexeddb/auto';
import { clear, createStore, set } from 'idb-keyval';
import { beforeEach, describe, expect, it } from 'vitest';
import { rememberFolder, recallFolder } from '../lib/session/handleStore';
import { SECRET } from '../test/fixtures';
import {
  SETTINGS_DATABASE,
  SETTINGS_STORE,
  chooseProvider,
  chosenProvider,
  hasKey,
  readKey,
  removeKey,
  saveKey,
  trimKey,
} from './keyStore';
import { PROVIDERS, findProvider, type ProviderId } from './providers';

/** Every value in every object store of every database on this origin, by "database/store". */
async function everything(): Promise<Map<string, unknown[]>> {
  const found = new Map<string, unknown[]>();
  for (const { name } of await indexedDB.databases()) {
    if (!name) continue;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const storeName of db.objectStoreNames) {
      const values = await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction(storeName).objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      found.set(`${name}/${storeName}`, values);
    }
    db.close();
  }
  return found;
}

const holdsSecret = (values: unknown[] | undefined) =>
  (values ?? []).some((value) => typeof value === 'string' && value.includes(SECRET));

describe('keyStore', () => {
  beforeEach(async () => {
    // A test's own reset: the app has no way to empty the store, and needs none.
    await clear(createStore(SETTINGS_DATABASE, SETTINGS_STORE));
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('keys', () => {
    it('has no key at first', async () => {
      expect(await hasKey('anthropic')).toBe(false);
      expect(await readKey('anthropic')).toBeNull();
    });

    it('saves a key and reads it back, as a reload would', async () => {
      expect(await saveKey('anthropic', SECRET)).toBe('saved');
      expect(await hasKey('anthropic')).toBe(true);
      expect(await readKey('anthropic')).toBe(SECRET);
    });

    it('trims spaces and line breaks at the ends, and nothing else', async () => {
      await saveKey('anthropic', ` \r\n  ${SECRET} \n\r `);
      expect(await readKey('anthropic')).toBe(SECRET);
    });

    it('keeps spaces and line breaks inside the key', async () => {
      await saveKey('anthropic', ` a b\nc `);
      expect(await readKey('anthropic')).toBe('a b\nc');
    });

    it('keeps a tab, a no-break space and other characters at the ends: only spaces and line breaks are trimmed', () => {
      expect(trimKey(`\t${SECRET}`)).toBe(`\t${SECRET}`);
      expect(trimKey(`\u{A0}${SECRET}\u{A0}`)).toBe(`\u{A0}${SECRET}\u{A0}`);
      expect(trimKey(`\u{FEFF}${SECRET}`)).toBe(`\u{FEFF}${SECRET}`);
      expect(trimKey(` \u{2028}${SECRET}`)).toBe(`\u{2028}${SECRET}`);
    });

    it('does not check the key for any format', async () => {
      expect(await saveKey('anthropic', 'x')).toBe('saved');
      expect(await readKey('anthropic')).toBe('x');
    });

    it.each(['', ' ', '\n', '\r\n', '  \n \r  '])(
      'refuses a key that is empty after trimming (%j) and saves nothing',
      async (raw) => {
        expect(await saveKey('anthropic', raw)).toBe('empty');
        expect(await hasKey('anthropic')).toBe(false);
        expect((await everything()).get(`${SETTINGS_DATABASE}/${SETTINGS_STORE}`)).toEqual([]);
      },
    );

    it('an empty key does not remove the key saved before', async () => {
      await saveKey('anthropic', SECRET);
      expect(await saveKey('anthropic', '   ')).toBe('empty');
      expect(await readKey('anthropic')).toBe(SECRET);
    });

    it('a new key replaces the one saved before, and says so', async () => {
      await saveKey('anthropic', 'first-fake-value');
      expect(await saveKey('anthropic', SECRET)).toBe('replaced');
      expect(await readKey('anthropic')).toBe(SECRET);
    });

    it('keeps one key per provider', async () => {
      await saveKey('anthropic', SECRET);
      await saveKey('openai', 'other-fake-value');
      expect(await readKey('anthropic')).toBe(SECRET);
      expect(await readKey('openai')).toBe('other-fake-value');
      expect(await readKey('google')).toBeNull();
      await removeKey('openai');
      expect(await readKey('anthropic')).toBe(SECRET);
    });

    it('removes the key, and says there was one', async () => {
      await saveKey('anthropic', SECRET);
      expect(await removeKey('anthropic')).toBe(true);
      expect(await hasKey('anthropic')).toBe(false);
      expect(holdsSecret([...(await everything()).values()].flat())).toBe(false);
    });

    it('removing when no key is saved is harmless, and says there was none', async () => {
      expect(await removeKey('anthropic')).toBe(false);
      expect(await removeKey('anthropic')).toBe(false);
      expect(await hasKey('anthropic')).toBe(false);
    });

    it('reads a stored value that is not a key, or an empty one, as no key', async () => {
      const raw = createStore(SETTINGS_DATABASE, SETTINGS_STORE);
      await set('key:anthropic', 42, raw);
      expect(await readKey('anthropic')).toBeNull();
      await set('key:anthropic', '', raw);
      expect(await hasKey('anthropic')).toBe(false);
    });
  });

  describe('the chosen provider', () => {
    it('is none at first: there is no default provider', async () => {
      expect(await chosenProvider()).toBeNull();
    });

    it('is remembered, as a reload would', async () => {
      await chooseProvider('anthropic');
      expect(await chosenProvider()).toBe('anthropic');
    });

    it('reads a provider Settings does not offer, or any other value, as none', async () => {
      await chooseProvider('google');
      expect(await chosenProvider()).toBeNull();
      await set(
        'chosen-provider',
        { id: 'anthropic' },
        createStore(SETTINGS_DATABASE, SETTINGS_STORE),
      );
      expect(await chosenProvider()).toBeNull();
    });

    it('removing the key leaves the choice alone', async () => {
      await chooseProvider('anthropic');
      await saveKey('anthropic', SECRET);
      await removeKey('anthropic');
      expect(await chosenProvider()).toBe('anthropic');
    });
  });

  describe('where the key is kept', () => {
    it('only in its own database, not with the session folder handle', async () => {
      await rememberFolder({ kind: 'directory', name: 'MySession' } as FileSystemDirectoryHandle);
      await saveKey('anthropic', SECRET);
      const stores = await everything();
      expect(holdsSecret(stores.get(`${SETTINGS_DATABASE}/${SETTINGS_STORE}`))).toBe(true);
      const elsewhere = [...stores].filter(
        ([name]) => name !== `${SETTINGS_DATABASE}/${SETTINGS_STORE}`,
      );
      expect(elsewhere.map(([name]) => name)).toContain('social-content-studio-session/handles');
      for (const [, values] of elsewhere) expect(holdsSecret(values)).toBe(false);
      // The folder handle is untouched by keys, and keys by the folder handle.
      expect((await recallFolder())?.name).toBe('MySession');
      await removeKey('anthropic');
      expect((await recallFolder())?.name).toBe('MySession');
    });

    it('never in localStorage or sessionStorage', async () => {
      await chooseProvider('anthropic');
      await saveKey('anthropic', SECRET);
      await readKey('anthropic');
      await removeKey('anthropic');
      await saveKey('anthropic', SECRET);
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });
  });
});

describe('providers', () => {
  it('offers Claude (Anthropic), sending keys only to its API address', () => {
    expect(PROVIDERS).toEqual([
      { id: 'anthropic', name: 'Claude (Anthropic)', host: 'api.anthropic.com' },
    ]);
  });

  it.each<[unknown, ProviderId | undefined]>([
    ['anthropic', 'anthropic'],
    ['google', undefined],
    ['openai', undefined],
    ['', undefined],
    [null, undefined],
    [undefined, undefined],
    [{ id: 'anthropic' }, undefined],
  ])('findProvider(%j) is %j', (id, want) => {
    expect(findProvider(id)?.id).toBe(want);
  });
});
