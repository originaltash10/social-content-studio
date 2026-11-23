import { describe, expect, it, vi } from 'vitest';
import {
  NOT_SINGLE_IMAGE_MESSAGE,
  NO_PHOTO_MESSAGE,
  missingFileMessage,
  unknownPlacementMessage,
} from '../board/controller';
import { getPlacement } from '../platforms';
import { unexpectedError } from '../render/protocol';
import type { Card, PlacementSpec, ValidationResult } from '../../types';
import { hash, makeAsset, makeCard } from '../../test/fixtures';
import { SOI, jfif, join } from '../../test/imageBytes';
import {
  exportTarget,
  exportedResult,
  firstFailure,
  readiness,
  sameFile,
  sourceType,
} from './eligibility';
import type { ExportSession, ExportTarget } from './eligibility';

const PHOTO = makeAsset();
const BLOB = new Blob(['photo']);

function session(overrides: Partial<ExportSession> = {}): ExportSession {
  return {
    id: 's1',
    name: 'Topping out',
    cards: [],
    assets: [PHOTO],
    missingAssetIds: [],
    ...overrides,
  };
}

const lookups = { blobOf: (id: string) => (id === PHOTO.id ? BLOB : undefined) };

function ok(target: ExportTarget): Extract<ExportTarget, { ok: true }> {
  if (!target.ok) throw new Error(target.message);
  return target;
}

describe('exportTarget', () => {
  it('plans the file for a single-photo card', () => {
    const target = ok(exportTarget(makeCard(), session(), lookups));
    expect(target.asset).toBe(PHOTO);
    expect(target.blob).toBe(BLOB);
    expect(target.spec).toBe(getPlacement('instagram', 'feed-vertical'));
    expect(target.plan.target).toEqual(getPlacement('instagram', 'feed-vertical')?.sizes[0]);
  });

  it("plans with the card's background colour, and white for a card with none", () => {
    expect(ok(exportTarget(makeCard(), session(), lookups)).plan.background).toBe('#ffffff');
    const green = makeCard({ background: '#0a7f5c' });
    expect(ok(exportTarget(green, session(), lookups)).plan.background).toBe('#0a7f5c');
  });

  it.each([
    ['more than one photo', makeCard({ assetIds: [PHOTO.id, hash('c')] })],
    [
      'a carousel edit',
      makeCard({ edit: { slides: [], coverIndex: 0 } as unknown as Card['edit'] }),
    ],
  ])('refuses %s with the board message', (_, card) => {
    expect(exportTarget(card, session(), lookups)).toEqual({
      ok: false,
      message: NOT_SINGLE_IMAGE_MESSAGE,
    });
  });

  it('refuses a card whose photo is not in the session', () => {
    expect(exportTarget(makeCard(), session({ assets: [] }), lookups)).toEqual({
      ok: false,
      message: NO_PHOTO_MESSAGE,
    });
  });

  it('refuses a placement no longer in the platform data', () => {
    expect(exportTarget(makeCard({ placement: 'gone' }), session(), lookups)).toEqual({
      ok: false,
      message: unknownPlacementMessage('instagram', 'gone'),
    });
  });

  it('refuses a photo whose file is missing or not in memory', () => {
    const missing = { ok: false, message: missingFileMessage(PHOTO.fileName) };
    expect(exportTarget(makeCard(), session({ missingAssetIds: [PHOTO.id] }), lookups)).toEqual(
      missing,
    );
    expect(exportTarget(makeCard(), session(), { blobOf: () => undefined })).toEqual(missing);
  });

  it('passes on the reason a render cannot be planned', () => {
    const video = makeAsset({ kind: 'video' });
    const target = exportTarget(makeCard(), session({ assets: [video] }), lookups);
    expect(target).toEqual({
      ok: false,
      message: `"${video.fileName}" is a video, so it cannot be made into an image.`,
    });
  });

  it('turns an unexpected planning error into a plain message', () => {
    const spec = { ...getPlacement('instagram', 'feed-vertical') } as PlacementSpec;
    Object.defineProperty(spec, 'sizes', {
      get() {
        throw new Error('boom');
      },
    });
    const target = exportTarget(makeCard(), session(), { ...lookups, specOf: () => spec });
    expect(target).toEqual({ ok: false, message: unexpectedError(PHOTO.fileName).message });
  });
});

describe('sameFile', () => {
  it('is true for the same photo and plan, false when either differs', () => {
    const a = ok(exportTarget(makeCard(), session(), lookups));
    const b = ok(exportTarget(makeCard(), session(), lookups));
    expect(sameFile(a, b)).toBe(true);
    const moved = ok(
      exportTarget(
        makeCard({
          edit: {
            ...(makeCard().edit as object),
            crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
          } as Card['edit'],
        }),
        session(),
        lookups,
      ),
    );
    expect(sameFile(a, moved)).toBe(false);
    // A different background colour is a different file.
    const coloured = ok(exportTarget(makeCard({ background: '#0a7f5c' }), session(), lookups));
    expect(sameFile(a, coloured)).toBe(false);
    expect(
      sameFile(coloured, ok(exportTarget(makeCard({ background: '#0A7F5C' }), session(), lookups))),
    ).toBe(true);
    expect(sameFile(a, { ...a, asset: { ...a.asset, id: hash('d') } })).toBe(false);
  });
});

describe('exportedResult', () => {
  it('exports Pass and Warning, with or without the override', () => {
    for (const override of [false, true]) {
      expect(exportedResult({ level: 'pass' }, override)).toBe('pass');
      expect(exportedResult({ level: 'warn' }, override)).toBe('warn');
    }
  });

  it('blocks Fail unless the card is overridden', () => {
    expect(exportedResult({ level: 'fail' }, false)).toBeNull();
    expect(exportedResult({ level: 'fail' }, true)).toBe('override');
  });
});

describe('firstFailure', () => {
  it('gives the first failing issue, skipping warnings', () => {
    const result: ValidationResult = {
      level: 'fail',
      issues: [
        { rule: 8, level: 'warn', message: 'No alt text.' },
        { rule: 1, level: 'fail', message: 'Wrong size.' },
        { rule: 2, level: 'fail', message: 'Too big.' },
      ],
    };
    expect(firstFailure(result)).toBe('Wrong size.');
  });
});

describe('readiness', () => {
  it('counts every card: those that can be exported and those that fail', () => {
    const fail: ValidationResult = { level: 'fail', issues: [] };
    expect(
      readiness([
        makeCard({ validation: { level: 'pass', issues: [] } }),
        makeCard({ validation: { level: 'warn', issues: [] } }),
        makeCard({ validation: fail, overrideFail: true }),
        makeCard({ validation: fail }),
        makeCard({ validation: fail }),
      ]),
    ).toEqual({ total: 5, ready: 3, failing: 2 });
  });

  it('is all zero for no cards', () => {
    expect(readiness([])).toEqual({ total: 0, ready: 0, failing: 0 });
  });
});

describe('sourceType', () => {
  it('reads the file type with the real detector by default', async () => {
    const jpeg = new Blob([join(SOI, jfif(), new Uint8Array(64))]);
    expect(await sourceType(jpeg, 'site.jpg', lookups)).toMatchObject({
      kind: 'image',
      format: 'jpeg',
    });
  });

  it('never rejects: a detector that throws gives a plain message', async () => {
    const sniff = vi.fn().mockRejectedValue(new Error('read failed'));
    expect(await sourceType(BLOB, 'site.jpg', { ...lookups, sniff })).toEqual({
      kind: 'rejected',
      reason: 'damaged',
      message: unexpectedError('site.jpg').message,
    });
  });
});
