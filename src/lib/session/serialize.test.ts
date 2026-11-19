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
  CARD_COLOUR,
  PADDED_CROP,
  makeCard,
  makeColouredCard,
  makeImageEdit,
  makeSession,
  withInjectedKeys,
} from '../../test/fixtures';
import type { BrandKit, Card, ImageEdit, Session } from '../../types';

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
    expect(text).not.toContain('background');
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

  it("round-trips a card's own focal point", () => {
    const session = makeSession({ cards: [makeCard({ focal: { x: 0.25, y: 0.75 } })] });
    const text = serializeSession(session);
    expect(item((JSON.parse(text) as Session).cards, 0).focal).toEqual({ x: 0.25, y: 0.75 });
    expect(parseSession(text)).toEqual(session);
  });

  it("writes no focal point for a card that shares its photo's", () => {
    const session = makeSession({
      cards: [makeCard(), makeCard({ id: 'card-2', focal: undefined })],
    });
    const raw = JSON.parse(serializeSession(session)) as Session;
    expect(Object.hasOwn(item(raw.cards, 0), 'focal')).toBe(false);
    expect(Object.hasOwn(item(raw.cards, 1), 'focal')).toBe(false);
    expect(Object.hasOwn(item(parseSession(serializeSession(session)).cards, 1), 'focal')).toBe(
      false,
    );
  });

  it('loads an older file, whose cards have no focal point, exactly as before', () => {
    const session = makeSession();
    // The text of a file written before cards could have their own focal point.
    const older = JSON.stringify(session);
    for (const card of (JSON.parse(older) as Session).cards) {
      expect(Object.hasOwn(card, 'focal')).toBe(false);
    }
    const loaded = parseSession(older);
    expect(loaded).toEqual(session);
    for (const card of loaded.cards) expect(Object.hasOwn(card, 'focal')).toBe(false);
    // Saving it again writes the same file the serializer always wrote for it.
    expect(serializeSession(loaded)).toBe(serializeSession(session));
  });

  it("moves a card's own focal point outside the photo to its edge, on load and on save", () => {
    const outside = tamper(serializeSession(makeSession()), (r) => {
      item(r.cards, 0).focal = { x: 3, y: -0.5 };
    });
    expect(parseSession(outside).cards[0]?.focal).toEqual({ x: 1, y: 0 });
    const saved = serializeSession(
      makeSession({ cards: [makeCard({ focal: { x: -2, y: 1.5 } })] }),
    );
    expect((JSON.parse(saved) as Session).cards[0]?.focal).toEqual({ x: 0, y: 1 });
  });

  it.each<[string, unknown, string]>([
    ['a coordinate that is not a number', { x: 'left', y: 0.5 }, 'focal.x must be a finite number'],
    ['a missing coordinate', { x: 0.5 }, 'focal.y must be a finite number'],
    ['a value that is not an object', 'centre', 'focal must be an object'],
    ['null', null, 'focal must be an object'],
  ])("rejects a card's own focal point with %s", (_name, focal, message) => {
    const text = tamper(serializeSession(makeSession()), (r) => {
      item(r.cards, 0).focal = focal;
    });
    expect(() => parseSession(text)).toThrow(SessionFormatError);
    expect(() => parseSession(text)).toThrow(`session.cards[0].${message}`);
  });

  it("keeps only x and y of a card's own focal point", () => {
    const text = tamper(serializeSession(makeSession()), (r) => {
      item(r.cards, 0).focal = { x: 0.3, y: 0.6, apiKey: SECRET, z: 1 };
    });
    expect(parseSession(text).cards[0]?.focal).toEqual({ x: 0.3, y: 0.6 });
    const leaky = makeSession({
      cards: [makeCard({ focal: { x: 0.3, y: 0.6, apiKey: SECRET } as Card['focal'] })],
    });
    expect(serializeSession(leaky)).not.toContain(SECRET);
  });

  it("round-trips a card's background colour", () => {
    const session = makeSession({ cards: [makeCard({ background: '#0a7f5c' })] });
    const text = serializeSession(session);
    expect(item((JSON.parse(text) as Session).cards, 0).background).toBe('#0a7f5c');
    expect(parseSession(text)).toEqual(session);
    expect(serializeSession(parseSession(text))).toBe(text);
  });

  it('makes a background colour lowercase, on load and on save', () => {
    const upper = tamper(serializeSession(makeSession()), (r) => {
      item(r.cards, 0).background = '#0A7F5C';
    });
    expect(parseSession(upper).cards[0]?.background).toBe('#0a7f5c');
    const session = makeSession({ cards: [makeCard({ background: '#0A7F5C' })] });
    expect(item((JSON.parse(serializeSession(session)) as Session).cards, 0).background).toBe(
      '#0a7f5c',
    );
  });

  it.each([
    ['no "#"', '0a7f5c'],
    ['three digits', '#0af'],
    ['eight digits', '#0a7f5cff'],
    ['a colour name', 'white'],
    ['another colour name', 'transparent'],
    ['a letter that is not a hex digit', '#0a7f5z'],
    ['an empty text', ''],
    ['a number', 688988],
    ['true', true],
    ['null', null],
    ['a list', ['#0a7f5c']],
    ['an object', { r: 10, g: 127, b: 92 }],
  ])('drops a background colour that is %s, so the card is white', (_name, value) => {
    // On load: the rest of the file still loads, and the card simply has no colour.
    const text = tamper(serializeSession(makeSession()), (r) => {
      item(r.cards, 0).background = value;
    });
    const loaded = parseSession(text);
    expect(Object.hasOwn(item(loaded.cards, 0), 'background')).toBe(false);
    expect(loaded).toEqual(makeSession());
    // On save: a bad value on the card in memory never reaches the file.
    const session = makeSession({
      cards: [makeCard({ background: value as unknown as string })],
    });
    const raw = JSON.parse(serializeSession(session)) as Session;
    expect(Object.hasOwn(item(raw.cards, 0), 'background')).toBe(false);
  });

  it('writes no background colour for a card that has none', () => {
    // The fixture session is like one the app has just made: no card has a colour.
    const session = makeSession();
    const text = serializeSession(session);
    expect(text).not.toContain('background');
    const loaded = parseSession(text);
    expect(loaded).toEqual(session);
    for (const card of loaded.cards) expect(Object.hasOwn(card, 'background')).toBe(false);
    // Nor for a card whose colour is set to undefined rather than left out.
    const explicit = makeSession({ cards: [makeCard({ background: undefined })] });
    expect(serializeSession(explicit)).not.toContain('background');
  });

  it('round-trips a card with a colour and a crop with padding beside cards with neither', () => {
    const session = makeSession({ cards: [makeColouredCard(), ...makeSession().cards.slice(1)] });
    const text = serializeSession(session);
    const raw = JSON.parse(text) as Session;
    expect(item(raw.cards, 0).background).toBe(CARD_COLOUR);
    expect(Object.hasOwn(item(raw.cards, 1), 'background')).toBe(false);
    expect(parseSession(text)).toEqual(session);
    expect((parseSession(text).cards[0]?.edit as ImageEdit).crop).toEqual(PADDED_CROP);
  });

  it('loads an older file, whose cards have no background colour, exactly as before', () => {
    const session = makeSession();
    // The text of a file written before cards could have a background colour.
    const older = JSON.stringify(session);
    expect(older).not.toContain('background');
    const loaded = parseSession(older);
    expect(loaded).toEqual(session);
    for (const card of loaded.cards) expect(Object.hasOwn(card, 'background')).toBe(false);
    // Saving it again writes the same file the serializer always wrote for it, at version 1.
    const saved = serializeSession(loaded);
    expect(saved).toBe(serializeSession(session));
    expect(saved).not.toContain('background');
    expect(loaded.version).toBe(1);
  });

  it('keeps a crop with padding exactly, number for number, through save and load', () => {
    // The fit frame of a 4000 x 3000 photo for a square, and one for a tall placement.
    const crops = [
      { x: 0, y: -1 / 6, width: 1, height: 4 / 3 },
      { x: 0.05, y: -0.1, width: 0.9, height: 1.2 },
      { x: -0.3888888888888889, y: 0, width: 1.7777777777777777, height: 1 },
    ];
    for (const crop of crops) {
      const session = makeSession({ cards: [makeCard({ edit: makeImageEdit({ crop }) })] });
      const loaded = parseSession(serializeSession(session));
      expect((loaded.cards[0]?.edit as ImageEdit).crop).toEqual(crop);
      expect(serializeSession(loaded)).toBe(serializeSession(session));
    }
  });

  it('does not check a crop against the crop limits: that happens where it is used', () => {
    // Far larger than any fit size, and off to one side. It is kept as four numbers.
    const crop = { x: -3, y: 2.5, width: 9, height: 0.001 };
    const session = makeSession({ cards: [makeCard({ edit: makeImageEdit({ crop }) })] });
    expect((parseSession(serializeSession(session)).cards[0]?.edit as ImageEdit).crop).toEqual(
      crop,
    );
  });

  it('still rejects a crop that is not four finite numbers', () => {
    const text = tamper(serializeSession(makeSession()), (r) => {
      (item(r.cards, 0).edit as { crop: unknown }).crop = { x: 0, y: 0, width: '1', height: 1 };
    });
    expect(() => parseSession(text)).toThrow(
      'session.cards[0].edit.crop.width must be a finite number',
    );
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
