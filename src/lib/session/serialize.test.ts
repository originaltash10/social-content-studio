import { describe, expect, it } from 'vitest';
import {
  parseBrand,
  parseSession,
  serializeBrand,
  serializeSession,
  SessionFormatError,
} from './serialize';
import {
  KEY_FIELDS,
  SECRET,
  hash,
  makeAsset,
  makeBrand,
  makeCard,
  makeSession,
  withInjectedKeys,
} from '../../test/fixtures';
import type { BrandKit, Session } from '../../types';

/** The i-th entry of a raw JSON list, as an object. */
function item(list: unknown, i: number): Record<string, unknown> {
  const entry = (list as unknown[])[i];
  if (typeof entry !== 'object' || entry === null) throw new Error(`no object at index ${i}`);
  return entry as Record<string, unknown>;
}

/** Parses a serialized file, applies a change to the raw JSON, and returns the new text. */
function tamper(text: string, change: (raw: Record<string, unknown>) => void): string {
  const raw = JSON.parse(text) as Record<string, unknown>;
  change(raw);
  return JSON.stringify(raw);
}

describe('session.json', () => {
  it('round-trips a session that uses every field', () => {
    const session = makeSession();
    expect(parseSession(serializeSession(session))).toEqual(session);
  });

  it('round-trips a session with the optional fields left out', () => {
    const session = makeSession({
      brief: { topic: '', audience: '', cta: '', tone: 'neutral' },
      assets: [
        {
          id: hash('c'),
          kind: 'image',
          fileName: 'a.png',
          width: 10,
          height: 10,
          focal: { x: 0.5, y: 0.5 },
        },
      ],
      cards: [
        makeCard({
          parentId: undefined,
          plannedDate: undefined,
          edit: {
            crop: { x: 0, y: 0, width: 1, height: 1 },
            overlays: [],
            format: 'png',
            quality: 1,
          },
          copy: { caption: '', firstComment: '', hashtags: [], altText: '' },
          validation: { level: 'pass', issues: [] },
          comments: [],
        }),
      ],
      groups: [],
    });
    const text = serializeSession(session);
    expect(parseSession(text)).toEqual(JSON.parse(text));
    expect(text).not.toContain('parentId');
    expect(text).not.toContain('plannedDate');
  });

  it('writes pretty-printed JSON ending in a newline', () => {
    const text = serializeSession(makeSession());
    expect(text.startsWith('{\n  "version": 1,')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('returns a copy, not the object it was given', () => {
    const session = makeSession();
    const parsed = parseSession(serializeSession(session));
    expect(parsed).not.toBe(session);
    expect(parsed.cards[0]).not.toBe(session.cards[0]);
  });

  it('ignores unknown fields when reading', () => {
    const text = tamper(serializeSession(makeSession()), (raw) => {
      raw.somethingNew = { nested: true };
    });
    expect(parseSession(text)).toEqual(makeSession());
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseSession('{not json')).toThrow(SessionFormatError);
    expect(() => parseSession('{not json')).toThrow('session.json is not valid JSON');
  });

  it('rejects an unsupported version with a clear message', () => {
    const text = tamper(serializeSession(makeSession()), (raw) => {
      raw.version = 2;
    });
    expect(() => parseSession(text)).toThrow(
      'session.json has version 2; this app reads version 1',
    );
  });

  it('rejects a missing version', () => {
    const text = tamper(serializeSession(makeSession()), (raw) => {
      delete raw.version;
    });
    expect(() => parseSession(text)).toThrow('this app reads version 1');
  });

  it.each([
    ['null', 'session must be an object'],
    ['[]', 'session must be an object'],
    ['"text"', 'session must be an object'],
  ])('rejects a top-level %s', (text, message) => {
    expect(() => parseSession(text)).toThrow(message);
  });

  it.each<[string, (raw: Record<string, unknown>) => void, string]>([
    ['a non-string name', (r) => (r.name = 7), 'session.name must be a string'],
    ['a missing id', (r) => delete r.id, 'session.id must be a string'],
    ['cards that are not a list', (r) => (r.cards = {}), 'session.cards must be an array'],
    ['a brief that is not an object', (r) => (r.brief = 'x'), 'session.brief must be an object'],
    [
      'an unknown tone',
      (r) => ((r.brief as Record<string, unknown>).tone = 'shouty'),
      'session.brief.tone must be one of "formal", "neutral", "casual"',
    ],
    [
      'a non-numeric width',
      (r) => (item(r.assets, 0).width = '4000'),
      'session.assets[0].width must be a finite number',
    ],
    [
      'an asset id that is not a hash',
      (r) => (item(r.assets, 1).id = '../../etc/passwd'),
      'session.assets[1].id must be a sha256 hash',
    ],
    [
      'an asset id that is not a string',
      (r) => (item(r.assets, 0).id = 5),
      'session.assets[0].id must be a sha256 hash',
    ],
    [
      'a non-boolean overrideFail',
      (r) => (item(r.cards, 0).overrideFail = 'no'),
      'session.cards[0].overrideFail must be true or false',
    ],
    [
      'an edit that is not an object',
      (r) => (item(r.cards, 0).edit = null),
      'session.cards[0].edit must be an object',
    ],
    [
      'a validation rule out of range',
      (r) => {
        const validation = item(r.cards, 0).validation as { issues: unknown };
        item(validation.issues, 0).rule = 10;
      },
      'session.cards[0].validation.issues[0].rule must be one of 1, 2, 3',
    ],
  ])('rejects %s', (_name, change, message) => {
    const text = tamper(serializeSession(makeSession()), change);
    expect(() => parseSession(text)).toThrow(SessionFormatError);
    expect(() => parseSession(text)).toThrow(message);
  });

  it('moves a focal point outside the photo to its edge, on load and on save', () => {
    const outside = tamper(serializeSession(makeSession()), (r) => {
      item(r.assets, 0).focal = { x: 3, y: -0.5 };
      item(r.assets, 1).focal = { x: 1, y: 0 };
    });
    const loaded = parseSession(outside);
    expect(loaded.assets[0]?.focal).toEqual({ x: 1, y: 0 });
    // A point on the edge is inside the range and is left as it is.
    expect(loaded.assets[1]?.focal).toEqual({ x: 1, y: 0 });
    const saved = serializeSession(
      makeSession({ assets: [makeAsset({ focal: { x: -2, y: 1.5 } })] }),
    );
    expect((JSON.parse(saved) as Session).assets[0]?.focal).toEqual({ x: 0, y: 1 });
  });

  it('still rejects a focal point that is not a number', () => {
    const text = tamper(serializeSession(makeSession()), (r) => {
      item(r.assets, 0).focal = { x: 'left', y: 0.5 };
    });
    expect(() => parseSession(text)).toThrow('session.assets[0].focal.x must be a finite number');
  });

  it('refuses to write a session whose shape is wrong', () => {
    const broken = { ...makeSession(), version: 2 } as unknown as Session;
    expect(() => serializeSession(broken)).toThrow('session.version must be one of 1');
    const nan = { ...makeSession(), assets: [makeAsset({ width: Number.NaN })] };
    expect(() => serializeSession(nan)).toThrow('session.assets[0].width must be a finite number');
  });
});

describe('brand.json', () => {
  it('round-trips a brand kit', () => {
    const brand = makeBrand();
    expect(parseBrand(serializeBrand(brand))).toEqual(brand);
  });

  it('contains only the five fields the spec describes', () => {
    const raw = JSON.parse(serializeBrand(makeBrand())) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(['logos', 'fonts', 'colors', 'voice', 'overlayPresets']);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseBrand('nope')).toThrow('brand.json is not valid JSON');
  });

  it.each<[string, (raw: Record<string, unknown>) => void, string]>([
    ['a non-string voice', (r) => (r.voice = 1), 'brand.voice must be a string'],
    ['logos that are not a list', (r) => (r.logos = 'a.png'), 'brand.logos must be an array'],
    [
      'a font with an unknown source',
      (r) => (item(r.fonts, 0).source = 'adobe'),
      'brand.fonts[0].source must be one of "file"',
    ],
    [
      'a Google font without a name',
      (r) => delete item(r.fonts, 1).name,
      'brand.fonts[1].name must be a string',
    ],
    ['a font that is not an object', (r) => (r.fonts = ['Inter']), 'brand.fonts[0] must be'],
    [
      'an unknown alignment',
      (r) => (item(r.overlayPresets, 0).align = 'justify'),
      'brand.overlayPresets[0].align must be one of "left", "center", "right"',
    ],
  ])('rejects %s', (_name, change, message) => {
    const text = tamper(serializeBrand(makeBrand()), change);
    expect(() => parseBrand(text)).toThrow(SessionFormatError);
    expect(() => parseBrand(text)).toThrow(message);
  });
});

describe('API keys never reach a file', () => {
  function expectNoKeys(text: string) {
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('not-a-real-credential');
    for (const field of KEY_FIELDS) expect(text).not.toContain(`"${field}"`);
  }

  it('the injection helper really does put keys at every level (guards the tests below)', () => {
    const leaky = withInjectedKeys(makeSession());
    const text = JSON.stringify(leaky);
    // One set on the session, the brief, each asset, each card, and their nested objects.
    expect(text.split(SECRET).length - 1).toBeGreaterThan(100);
    expect(item(leaky.cards, 0).copy).toMatchObject({ apiKey: SECRET });
    expect(item(leaky.assets, 0).focal).toMatchObject({ apiKey: SECRET });
  });

  it('session.json drops key-like fields injected at every nesting level', () => {
    const clean = makeSession();
    const text = serializeSession(withInjectedKeys(clean));
    expectNoKeys(text);
    // Nothing else was lost or changed on the way.
    expect(text).toBe(serializeSession(clean));
  });

  it('brand.json drops key-like fields injected at every nesting level', () => {
    const clean = makeBrand();
    const text = serializeBrand(withInjectedKeys(clean));
    expectNoKeys(text);
    expect(text).toBe(serializeBrand(clean));
  });

  it('reading a file that contains keys does not bring them into memory', () => {
    const session = parseSession(JSON.stringify(withInjectedKeys(makeSession())));
    const brand: BrandKit = parseBrand(JSON.stringify(withInjectedKeys(makeBrand())));
    expectNoKeys(JSON.stringify(session));
    expectNoKeys(JSON.stringify(brand));
  });
});
