/**
 * Serializers for the two JSON files in a session folder: session.json and brand.json.
 *
 * Both directions go through the same "readers". A reader checks a value's shape and returns a
 * fresh copy that contains ONLY the fields listed here, at every nesting level. Anything else on
 * the input object is dropped, so a field that is not part of the data model (an API key, for
 * example) cannot reach a file even if it ends up on the in-memory object by mistake.
 *
 * Adding a field to Session or BrandKit in src/types.ts therefore means adding it here too;
 * until then it is not saved. The round-trip tests catch a forgotten field.
 *
 * Pure: no DOM, no store access.
 */

import type { BrandKit, Card, Session } from '../../types';

export const SESSION_FILE = 'session.json';
export const BRAND_FILE = 'brand.json';

/** Thrown when a session or brand file is not valid JSON or does not match the data model. */
export class SessionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionFormatError';
  }
}

// ---------------------------------------------------------------------------
// Reader building blocks
// ---------------------------------------------------------------------------

type Reader<T> = (value: unknown, path: string) => T;

function fail(path: string, expected: string): never {
  throw new SessionFormatError(`${path} must be ${expected}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const string: Reader<string> = (value, path) =>
  typeof value === 'string' ? value : fail(path, 'a string');

const number: Reader<number> = (value, path) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fail(path, 'a finite number');

/** A fraction of a photo, kept inside 0..1: a point outside the photo is moved to its edge. */
const unit: Reader<number> = (value, path) => Math.min(1, Math.max(0, number(value, path)));

const boolean: Reader<boolean> = (value, path) =>
  typeof value === 'boolean' ? value : fail(path, 'true or false');

function oneOf<const T extends readonly (string | number)[]>(...allowed: T): Reader<T[number]> {
  return (value, path) =>
    allowed.includes(value as T[number])
      ? (value as T[number])
      : fail(path, `one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`);
}

function optional<T>(reader: Reader<T>): Reader<T | undefined> {
  return (value, path) => (value === undefined ? undefined : reader(value, path));
}

function array<T>(reader: Reader<T>): Reader<T[]> {
  return (value, path) =>
    Array.isArray(value)
      ? value.map((item, i) => reader(item, `${path}[${i}]`))
      : fail(path, 'an array');
}

/** The allowlist: the result holds the keys of `shape` and nothing else. */
function object<S extends Record<string, Reader<unknown>>>(
  shape: S,
): Reader<{ [K in keyof S]: ReturnType<S[K]> }> {
  return (value, path) => {
    if (!isRecord(value)) return fail(path, 'an object');
    const out: Record<string, unknown> = {};
    for (const [key, reader] of Object.entries(shape)) {
      const field = reader(value[key], `${path}.${key}`);
      if (field !== undefined) out[key] = field;
    }
    return out as { [K in keyof S]: ReturnType<S[K]> };
  };
}

// ---------------------------------------------------------------------------
// session.json
// ---------------------------------------------------------------------------

/** Asset ids are sha256 hashes (SPEC.md) and double as file names under assets/. */
const ASSET_ID = /^[0-9a-f]{64}$/;

const assetId: Reader<string> = (value, path) =>
  typeof value === 'string' && ASSET_ID.test(value)
    ? value
    : fail(path, 'a sha256 hash (64 lowercase hex characters)');

const rect = object({ x: number, y: number, width: number, height: number });

const overlay = object({ id: string, kind: oneOf('text'), rect, text: string });

const imageEdit = object({
  crop: rect,
  overlays: array(overlay),
  logo: optional(object({ logoId: string, rect, opacity: number })),
  format: oneOf('jpg', 'png'),
  quality: number,
});

const videoEdit = object({
  inMs: number,
  outMs: number,
  crop: rect,
  overlays: array(overlay),
  coverMs: number,
  captions: optional(array(object({ startMs: number, endMs: number, text: string }))),
  audio: oneOf('keep', 'mute', 'replace'),
});

const carouselEdit = object({
  slides: array(object({ assetId, edit: imageEdit })),
  coverIndex: number,
});

/** The three edit types carry no tag; tell them apart by a field only one of them has. */
const edit: Reader<Card['edit']> = (value, path) => {
  if (isRecord(value) && 'slides' in value) return carouselEdit(value, path);
  if (isRecord(value) && 'inMs' in value) return videoEdit(value, path);
  return imageEdit(value, path);
};

const card = object({
  id: string,
  assetIds: array(assetId),
  platform: oneOf('instagram', 'linkedin', 'facebook', 'x'),
  placement: string,
  parentId: optional(string),
  version: number,
  status: oneOf('draft', 'review', 'approved'),
  edit,
  copy: object({
    caption: string,
    firstComment: string,
    hashtags: array(string),
    altText: string,
    authoredBy: optional(object({ provider: string, model: string, at: string })),
  }),
  validation: object({
    level: oneOf('pass', 'warn', 'fail'),
    issues: array(
      object({
        rule: oneOf(1, 2, 3, 4, 5, 6, 7, 8, 9),
        level: oneOf('warn', 'fail'),
        message: string,
      }),
    ),
  }),
  overrideFail: boolean,
  comments: array(object({ id: string, author: string, at: string, text: string })),
  plannedDate: optional(string),
});

const session: Reader<Session> = object({
  version: oneOf(1),
  id: string,
  name: string,
  createdAt: string,
  updatedAt: string,
  brief: object({
    topic: string,
    audience: string,
    cta: string,
    link: optional(string),
    tone: oneOf('formal', 'neutral', 'casual'),
  }),
  assets: array(
    object({
      id: assetId,
      kind: oneOf('image', 'video'),
      fileName: string,
      width: number,
      height: number,
      durationMs: optional(number),
      focal: object({ x: unit, y: unit }),
      description: optional(string),
    }),
  ),
  cards: array(card),
  groups: array(object({ id: string, name: string, cardIds: array(string) })),
});

// ---------------------------------------------------------------------------
// brand.json
// ---------------------------------------------------------------------------

const brandFont: Reader<BrandKit['fonts'][number]> = (value, path) =>
  isRecord(value) && value.source === 'google'
    ? object({ source: oneOf('google'), name: string })(value, path)
    : object({ source: oneOf('file'), path: string })(value, path);

const brand: Reader<BrandKit> = object({
  logos: array(string),
  fonts: array(brandFont),
  colors: array(string),
  voice: string,
  overlayPresets: array(
    object({
      id: string,
      name: string,
      font: string,
      color: string,
      align: oneOf('left', 'center', 'right'),
      shadow: boolean,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fromJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SessionFormatError(`${file} is not valid JSON`);
  }
}

/** The text of session.json. Throws SessionFormatError rather than write a malformed file. */
export function serializeSession(value: Session): string {
  return toJson(session(value, 'session'));
}

/** Reads the text of session.json. Unknown fields are ignored; a bad shape throws. */
export function parseSession(text: string): Session {
  const raw = fromJson(text, SESSION_FILE);
  if (isRecord(raw) && raw.version !== 1) {
    throw new SessionFormatError(
      `${SESSION_FILE} has version ${JSON.stringify(raw.version)}; this app reads version 1`,
    );
  }
  return session(raw, 'session');
}

/** The text of brand.json. */
export function serializeBrand(value: BrandKit): string {
  return toJson(brand(value, 'brand'));
}

/** Reads the text of brand.json. Unknown fields are ignored; a bad shape throws. */
export function parseBrand(text: string): BrandKit {
  return brand(fromJson(text, BRAND_FILE), 'brand');
}
