import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorMessage, hasName } from './errors';
import { emptyBrand } from './layout';
import type { SessionFiles } from './layout';
import { SessionFormatError, serializeBrand, serializeSession } from './serialize';
import { BundleError, buildBundle, bundleFileName, readBundle } from './zip';
import {
  CARD_COLOUR,
  KEY_FIELDS,
  PADDED_CROP,
  SECRET,
  hash,
  makeBrand,
  makeColouredCard,
  makeSession,
  withInjectedKeys,
} from '../../test/fixtures';
import type { ImageEdit, Session } from '../../types';

const A = hash('a');
const B = hash('b');

function files(overrides: Partial<SessionFiles> = {}): SessionFiles {
  return {
    session: makeSession(),
    brand: makeBrand(),
    blobs: new Map([
      [A, new Blob(['photo bytes'])],
      [B, new Blob([new Uint8Array([0, 255, 1, 254, 2, 253])])],
    ]),
    ...overrides,
  };
}

/** Opens a bundle with JSZip directly, to look at exactly what is inside it. */
async function open(bundle: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await bundle.arrayBuffer());
}

/** Makes a zip by hand from a list of entries, for bundles this app would not produce. */
async function zipOf(entries: Record<string, string>): Promise<Blob> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: 'blob' });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildBundle', () => {
  it('contains the session folder layout and nothing else', async () => {
    const zip = await open(await buildBundle(files()));
    expect(Object.keys(zip.files).sort()).toEqual(
      [
        'assets/',
        `assets/${A}`,
        `assets/${B}`,
        'brand.json',
        'exports/',
        'renders/',
        'session.json',
      ].sort(),
    );
  });

  it('holds the serializer output for both JSON files', async () => {
    const input = files();
    const zip = await open(await buildBundle(input));
    expect(await zip.file('session.json')?.async('string')).toBe(serializeSession(input.session));
    expect(await zip.file('brand.json')?.async('string')).toBe(serializeBrand(input.brand));
  });

  it('leaves out assets it has no file contents for, and contents the session does not list', async () => {
    const stray = hash('f');
    const zip = await open(
      await buildBundle(
        files({
          blobs: new Map([
            [A, new Blob(['photo bytes'])],
            [stray, new Blob(['stray'])],
          ]),
        }),
      ),
    );
    expect(zip.file(`assets/${A}`)).not.toBeNull();
    expect(zip.file(`assets/${B}`)).toBeNull();
    expect(zip.file(`assets/${stray}`)).toBeNull();
  });

  it('refuses to bundle a session that fails validation', async () => {
    const broken = { ...makeSession(), name: 42 } as unknown as Session;
    await expect(buildBundle(files({ session: broken }))).rejects.toThrow(SessionFormatError);
  });
});

describe('round trip', () => {
  it('reads back the session, the brand kit, and every asset byte for byte', async () => {
    const input = files();
    const loaded = await readBundle(await buildBundle(input));
    expect(loaded.session).toEqual(input.session);
    expect(loaded.brand).toEqual(input.brand);
    expect(loaded.missingAssetIds).toEqual([]);
    expect(loaded.brandMissing).toBe(false);
    expect([...loaded.blobs.keys()].sort()).toEqual([A, B]);
    expect(await loaded.blobs.get(A)?.text()).toBe('photo bytes');
    const bytes = await loaded.blobs.get(B)?.arrayBuffer();
    expect([...new Uint8Array(bytes ?? new ArrayBuffer(0))]).toEqual([0, 255, 1, 254, 2, 253]);
  });

  it('writes no background colour for cards that have none, and reads them back with none', async () => {
    // The fixture session is like one the app has just made: no card has a colour.
    const bundle = await buildBundle(files());
    const text = await (await open(bundle)).file('session.json')?.async('string');
    expect(text).not.toContain('background');
    const loaded = await readBundle(bundle);
    expect(loaded.session).toEqual(makeSession());
    for (const card of loaded.session.cards) expect(Object.hasOwn(card, 'background')).toBe(false);
  });

  it('reads back a background colour and a crop with padding as they were bundled', async () => {
    const session = makeSession({ cards: [makeColouredCard(), ...makeSession().cards.slice(1)] });
    const bundle = await buildBundle(files({ session }));
    const text = await (await open(bundle)).file('session.json')?.async('string');
    expect(text).toContain(`"background": "${CARD_COLOUR}"`);
    const loaded = await readBundle(bundle);
    expect(loaded.session).toEqual(session);
    expect(loaded.session.cards[0]?.background).toBe(CARD_COLOUR);
    expect((loaded.session.cards[0]?.edit as ImageEdit).crop).toEqual(PADDED_CROP);
    // The cards beside it still have no colour.
    expect(Object.hasOwn(loaded.session.cards[1] as object, 'background')).toBe(false);
  });

  it('round-trips a second time without change', async () => {
    const once = await readBundle(await buildBundle(files()));
    const twice = await readBundle(await buildBundle(once));
    expect(twice.session).toEqual(once.session);
    expect(twice.brand).toEqual(once.brand);
    expect([...twice.blobs.keys()].sort()).toEqual([A, B]);
  });

  it('round-trips an empty session', async () => {
    const input = files({
      session: makeSession({ assets: [], cards: [], groups: [] }),
      blobs: new Map(),
    });
    const loaded = await readBundle(await buildBundle(input));
    expect(loaded.session).toEqual(input.session);
    expect(loaded.blobs.size).toBe(0);
  });
});

describe('readBundle', () => {
  it('still loads when an asset file is missing, and reports which one', async () => {
    const bundle = await buildBundle(files({ blobs: new Map([[A, new Blob(['photo bytes'])]]) }));
    const loaded = await readBundle(bundle);
    expect(loaded.session).toEqual(makeSession());
    expect(loaded.missingAssetIds).toEqual([B]);
    expect([...loaded.blobs.keys()]).toEqual([A]);
  });

  it('loads an empty brand kit and says so when brand.json is absent', async () => {
    const loaded = await readBundle(
      await zipOf({ 'session.json': serializeSession(makeSession()) }),
    );
    expect(loaded.brand).toEqual(emptyBrand());
    expect(loaded.brandMissing).toBe(true);
    expect(loaded.missingAssetIds).toEqual([A, B]);
  });

  it('reads a session folder that was zipped by hand, with its wrapping folder', async () => {
    const loaded = await readBundle(
      await zipOf({
        'MySession/session.json': serializeSession(makeSession()),
        'MySession/brand.json': serializeBrand(makeBrand()),
        [`MySession/assets/${A}`]: 'photo bytes',
      }),
    );
    expect(loaded.session).toEqual(makeSession());
    expect(loaded.brand).toEqual(makeBrand());
    expect(await loaded.blobs.get(A)?.text()).toBe('photo bytes');
    expect(loaded.missingAssetIds).toEqual([B]);
  });

  it("reads a zip made with Finder's Compress, ignoring __MACOSX and .DS_Store entries", async () => {
    const loaded = await readBundle(
      await zipOf({
        '.DS_Store': 'finder data',
        'MySession/.DS_Store': 'finder data',
        'MySession/session.json': serializeSession(makeSession()),
        'MySession/brand.json': serializeBrand(makeBrand()),
        'MySession/assets/.DS_Store': 'finder data',
        [`MySession/assets/${A}`]: 'photo bytes',
        '__MACOSX/session.json': 'resource fork',
        '__MACOSX/._MySession': 'resource fork',
        '__MACOSX/MySession/._session.json': 'resource fork',
        '__MACOSX/MySession/._brand.json': 'resource fork',
        '__MACOSX/MySession/._.DS_Store': 'resource fork',
        [`__MACOSX/MySession/assets/._${A}`]: 'resource fork',
      }),
    );
    expect(loaded.session).toEqual(makeSession());
    expect(loaded.brand).toEqual(makeBrand());
    expect(loaded.brandMissing).toBe(false);
    expect(await loaded.blobs.get(A)?.text()).toBe('photo bytes');
    expect(loaded.missingAssetIds).toEqual([B]);
  });

  it('ignores entries that are not part of the layout', async () => {
    const loaded = await readBundle(
      await zipOf({
        'session.json': serializeSession(makeSession()),
        'brand.json': serializeBrand(makeBrand()),
        'keys.json': JSON.stringify({ anthropic: SECRET }),
        'assets/not-a-hash.txt': SECRET,
      }),
    );
    expect(JSON.stringify(loaded.session)).not.toContain(SECRET);
    expect(loaded.blobs.size).toBe(0);
  });

  it('rejects a file that is not a zip', async () => {
    const notZip = new Blob(['this is not a zip file']);
    await expect(readBundle(notZip)).rejects.toThrow(BundleError);
    await expect(readBundle(notZip)).rejects.toThrow('This file is not a valid .scs bundle.');
  });

  it('rejects a zip with no session.json', async () => {
    const bundle = await zipOf({ 'readme.txt': 'hello' });
    await expect(readBundle(bundle)).rejects.toThrow('This bundle does not contain a session.json');
  });

  it('rejects a zip with more than one wrapped session, rather than guess', async () => {
    const text = serializeSession(makeSession());
    const bundle = await zipOf({ 'One/session.json': text, 'Two/session.json': text });
    await expect(readBundle(bundle)).rejects.toThrow('This bundle does not contain a session.json');
  });

  it('rejects a session.json that does not match the data model', async () => {
    const bundle = await zipOf({ 'session.json': '{"version":3}' });
    await expect(readBundle(bundle)).rejects.toThrow(SessionFormatError);
    await expect(readBundle(bundle)).rejects.toThrow('this app reads version 1');
  });
});

describe('failures are reported, never silent', () => {
  it('building: running out of memory gives a specific message', async () => {
    vi.spyOn(JSZip.prototype, 'generateAsync').mockRejectedValue(
      new RangeError('Array buffer allocation failed'),
    );
    await expect(buildBundle(files())).rejects.toThrow(BundleError);
    await expect(buildBundle(files())).rejects.toThrow(
      'This session is too large to bundle in browser memory. Save it to a folder in Chrome or Edge instead.',
    );
  });

  it('building: a memory failure while reading an asset is reported the same way', async () => {
    const huge = new Blob(['x']);
    huge.arrayBuffer = () => Promise.reject(new Error('Out of memory'));
    await expect(buildBundle(files({ blobs: new Map([[A, huge]]) }))).rejects.toThrow(
      'too large to bundle in browser memory',
    );
  });

  it('building: any other failure is reported with its cause', async () => {
    vi.spyOn(JSZip.prototype, 'generateAsync').mockRejectedValue(new Error('disk on fire'));
    await expect(buildBundle(files())).rejects.toThrow(
      'Could not build the .scs bundle: disk on fire',
    );
  });

  it('reading: running out of memory gives a specific message', async () => {
    vi.spyOn(JSZip, 'loadAsync').mockRejectedValue(new RangeError('Invalid array length'));
    const bundle = new Blob(['whatever']);
    await expect(readBundle(bundle)).rejects.toThrow(BundleError);
    await expect(readBundle(bundle)).rejects.toThrow(
      'This .scs bundle is too large to open in browser memory. Unzip it and open the folder in Chrome or Edge instead.',
    );
  });

  it('reading: a file the browser cannot read into memory is reported as too large', async () => {
    const bundle = new Blob(['x']);
    const unreadable = new Error('The file could not be read');
    unreadable.name = 'NotReadableError';
    bundle.arrayBuffer = () => Promise.reject(unreadable);
    await expect(readBundle(bundle)).rejects.toThrow('too large to open in browser memory');
  });

  it('reading: running out of memory while unpacking an asset is reported', async () => {
    const bundle = await buildBundle(files());
    const zip = await open(bundle);
    const entry = zip.file(`assets/${A}`);
    if (!entry) throw new Error('expected the asset entry');
    const proto = Object.getPrototypeOf(entry) as JSZip.JSZipObject;
    const real = proto.async as (this: JSZip.JSZipObject, type: string) => Promise<unknown>;
    vi.spyOn(proto, 'async').mockImplementation(function (this: JSZip.JSZipObject, type: string) {
      if (type === 'arraybuffer') return Promise.reject(new RangeError('Invalid array length'));
      return real.call(this, type);
    } as typeof proto.async);
    await expect(readBundle(bundle)).rejects.toThrow('too large to open in browser memory');
  });

  it('reading: any other failure while unpacking is reported with its cause', async () => {
    const bundle = await buildBundle(files());
    const zip = await open(bundle);
    const entry = zip.file('session.json');
    if (!entry) throw new Error('expected the session entry');
    vi.spyOn(Object.getPrototypeOf(entry) as JSZip.JSZipObject, 'async').mockRejectedValue(
      'corrupted data',
    );
    await expect(readBundle(bundle)).rejects.toThrow(
      'Could not read the .scs bundle: corrupted data',
    );
  });
});

describe('API keys never reach a bundle', () => {
  it('no entry name is outside the allowlist and no entry contains a key', async () => {
    const clean = files();
    const leaky: SessionFiles = {
      session: withInjectedKeys(clean.session),
      brand: withInjectedKeys(clean.brand),
      blobs: clean.blobs,
    };
    // A bug that hangs keys on the object handed to the bundler must not matter either.
    Object.assign(leaky, { apiKey: SECRET, apiKeys: { anthropic: SECRET } });

    const bundle = await buildBundle(leaky);
    const zip = await open(bundle);

    const allowed =
      /^(session\.json|brand\.json|assets\/|renders\/|exports\/|assets\/[0-9a-f]{64})$/;
    for (const name of Object.keys(zip.files)) expect(name).toMatch(allowed);

    for (const entry of Object.values(zip.files)) {
      const text = await entry.async('string');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('not-a-real-credential');
      for (const field of KEY_FIELDS) expect(text).not.toContain(`"${field}"`);
    }

    // Entries are stored uncompressed, so a key anywhere in the file would be visible as text.
    const raw = new TextDecoder('latin1').decode(await bundle.arrayBuffer());
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('"caption"');

    // And the JSON is exactly what a clean session produces.
    expect(await zip.file('session.json')?.async('string')).toBe(serializeSession(clean.session));
    expect(await zip.file('brand.json')?.async('string')).toBe(serializeBrand(clean.brand));
  });
});

describe('bundleFileName', () => {
  it.each([
    ['Topping out', 'Topping out.scs'],
    ['Q4: site/visit?', 'Q4_ site_visit_.scs'],
    ['   ', 'session.scs'],
    ['', 'session.scs'],
    ['../../etc', '_etc.scs'],
  ])('%j becomes %j', (name, expected) => {
    expect(bundleFileName(name)).toBe(expected);
  });
});

describe('error helpers', () => {
  it('hasName matches on the name of anything thrown', () => {
    expect(hasName(new RangeError('x'), 'RangeError')).toBe(true);
    expect(hasName({ name: 'AbortError' }, 'AbortError')).toBe(true);
    expect(hasName(new Error('x'), 'AbortError')).toBe(false);
    expect(hasName(null, 'AbortError')).toBe(false);
    expect(hasName('AbortError', 'AbortError')).toBe(false);
  });

  it('errorMessage reads the message of an Error and stringifies anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});
