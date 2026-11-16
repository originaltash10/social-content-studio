/** Shared test data for the session serializer, the store, and the persistence tests. */

import type { Asset, BrandKit, Card, ImageEdit, Session } from '../types';

/** A syntactically valid sha256 asset id made from one repeated hex character. */
export const hash = (char: string): string => char.repeat(64);

export function makeImageEdit(overrides: Partial<ImageEdit> = {}): ImageEdit {
  return {
    crop: { x: 0, y: 0.1, width: 1, height: 0.8 },
    overlays: [
      { id: 'ov1', kind: 'text', rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 }, text: 'Hi' },
    ],
    logo: { logoId: 'logo1', rect: { x: 0.8, y: 0.8, width: 0.1, height: 0.1 }, opacity: 0.9 },
    format: 'jpg',
    quality: 0.85,
    ...overrides,
  };
}

export function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: hash('a'),
    kind: 'image',
    fileName: 'site.jpg',
    width: 4000,
    height: 3000,
    focal: { x: 0.5, y: 0.4 },
    description: 'A crane over a concrete frame.',
    ...overrides,
  };
}

export function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-1',
    assetIds: [hash('a')],
    platform: 'instagram',
    placement: 'feed-vertical',
    version: 1,
    status: 'draft',
    edit: makeImageEdit(),
    copy: {
      caption: 'Topping out this week.',
      firstComment: 'More on our site.',
      hashtags: ['#construction', '#toppingout'],
      altText: 'A crane lifts the final beam.',
      authoredBy: { provider: 'anthropic', model: 'some-model', at: '2026-11-16T10:00:00.000Z' },
    },
    validation: {
      level: 'warn',
      issues: [{ rule: 8, level: 'warn', message: 'Alt text is short.' }],
    },
    overrideFail: false,
    comments: [{ id: 'c1', author: 'Sam', at: '2026-11-16T11:00:00.000Z', text: 'Looks good.' }],
    plannedDate: '2026-11-20',
    ...overrides,
  };
}

/** A session that uses every field of the data model, optional ones included. */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    version: 1,
    id: 'session-1',
    name: 'Topping out',
    createdAt: '2026-11-16T09:00:00.000Z',
    updatedAt: '2026-11-16T12:00:00.000Z',
    brief: {
      topic: 'Topping out',
      audience: 'Clients and recruits',
      cta: 'See the project page.',
      link: 'https://example.com/project',
      tone: 'formal',
    },
    assets: [
      makeAsset(),
      makeAsset({ id: hash('b'), kind: 'video', fileName: 'clip.mp4', durationMs: 42000 }),
    ],
    cards: [
      makeCard(),
      makeCard({
        id: 'card-2',
        assetIds: [hash('b')],
        placement: 'reel',
        parentId: 'card-1',
        version: 2,
        edit: {
          inMs: 0,
          outMs: 30000,
          crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
          overlays: [],
          coverMs: 1500,
          captions: [{ startMs: 0, endMs: 900, text: 'Here we go.' }],
          audio: 'keep',
        },
      }),
      makeCard({
        id: 'card-3',
        assetIds: [hash('a'), hash('a')],
        platform: 'linkedin',
        placement: 'document-carousel',
        edit: {
          slides: [
            { assetId: hash('a'), edit: makeImageEdit() },
            { assetId: hash('a'), edit: makeImageEdit({ format: 'png' }) },
          ],
          coverIndex: 0,
        },
      }),
    ],
    groups: [{ id: 'g1', name: 'Topping out', cardIds: ['card-1', 'card-2', 'card-3'] }],
    ...overrides,
  };
}

export function makeBrand(overrides: Partial<BrandKit> = {}): BrandKit {
  return {
    logos: ['logos/primary.png'],
    fonts: [
      { source: 'file', path: 'fonts/Brand-Bold.woff2' },
      { source: 'google', name: 'Inter' },
    ],
    colors: ['#0a2540', '#ffffff'],
    voice: 'Plain, confident, specific.',
    overlayPresets: [
      {
        id: 'p1',
        name: 'Headline',
        font: 'Inter',
        color: '#ffffff',
        align: 'left',
        shadow: true,
      },
    ],
    ...overrides,
  };
}

/** An obviously fake key in no provider's format; tests assert it never reaches a file. */
export const SECRET = 'FAKE-TEST-KEY-not-a-real-credential-0123456789';

/** Field names a stray API key might plausibly arrive under. */
export const KEY_FIELDS = ['apiKey', 'apiKeys', 'anthropicApiKey', 'openaiKey', 'token'] as const;

/**
 * Returns a deep copy of `value` with key-like fields added to every object in it, at every
 * nesting level, including inside arrays. Models a bug that leaks keys onto the in-memory state.
 */
export function withInjectedKeys<T>(value: T): T {
  const inject = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(inject);
    if (typeof node !== 'object' || node === null) return node;
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) copy[key] = inject(child);
    copy.apiKey = SECRET;
    copy.apiKeys = { anthropic: SECRET, google: SECRET, openai: SECRET };
    copy.anthropicApiKey = SECRET;
    copy.openaiKey = SECRET;
    copy.token = SECRET;
    return copy;
  };
  return inject(value) as T;
}
