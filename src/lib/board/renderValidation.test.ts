import { describe, expect, it } from 'vitest';
import { getPlacement } from '../platforms';
import { focalInFrame } from '../render/crop';
import { defaultCrop, planRender } from '../render/plan';
import { validate } from '../validate';
import type { Card, PlacementSpec, ValidationResult } from '../../types';
import { makeAsset, makeImageEdit } from '../../test/fixtures';
import { isImageEdit, plannedValidation, renderedValidation, sameResult } from './renderValidation';

const FEED = getPlacement('instagram', 'feed-vertical') as PlacementSpec;
const ASSET = makeAsset({ width: 4032, height: 3024 });
const size = FEED.sizes[0] as { width: number; height: number };
const copy = (overrides: Partial<Card['copy']> = {}): Card['copy'] => ({
  caption: 'Hello',
  firstComment: '',
  hashtags: ['#site'],
  altText: 'A crane.',
  ...overrides,
});

describe('isImageEdit', () => {
  it('tells a single-image edit from video and carousel edits', () => {
    expect(isImageEdit(makeImageEdit())).toBe(true);
    expect(isImageEdit({ slides: [], coverIndex: 0 })).toBe(false);
    expect(
      isImageEdit({
        inMs: 0,
        outMs: 1,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        overlays: [],
        coverMs: 0,
        audio: 'keep',
      }),
    ).toBe(false);
  });
});

describe('plannedValidation', () => {
  it('checks the planned frame and the card text, with no file size yet', () => {
    const edit = makeImageEdit({ crop: defaultCrop(ASSET, FEED) });
    const card = { edit, copy: copy({ altText: '' }) };
    expect(plannedValidation(card, ASSET, FEED)).toEqual(
      validate(
        {
          kind: 'image',
          frames: [size],
          focal: focalInFrame(ASSET.focal, edit.crop),
          caption: 'Hello',
          hashtags: ['#site'],
          altText: '',
          overlays: edit.overlays.map((overlay) => overlay.rect),
          logo: edit.logo?.rect,
        },
        FEED,
      ),
    );
    expect(plannedValidation(card, ASSET, FEED).issues.map((issue) => issue.rule)).toEqual([8]);
  });

  it('uses the default crop for a card that is not a single image', () => {
    const card = { edit: { slides: [], coverIndex: 0 }, copy: copy() };
    expect(plannedValidation(card, ASSET, FEED)).toEqual(
      validate(
        {
          kind: 'image',
          frames: [size],
          focal: focalInFrame(ASSET.focal, defaultCrop(ASSET, FEED)),
          caption: 'Hello',
          hashtags: ['#site'],
          altText: 'A crane.',
        },
        FEED,
      ),
    );
  });

  it('checks only the text when the placement lists no size', () => {
    const noSize = { ...FEED, sizes: [] };
    for (const edit of [
      makeImageEdit({ logo: undefined, overlays: [] }),
      { slides: [], coverIndex: 0 },
    ]) {
      expect(plannedValidation({ edit, copy: copy() }, ASSET, noSize)).toEqual(
        validate(
          {
            kind: 'image',
            frames: [],
            caption: 'Hello',
            hashtags: ['#site'],
            altText: 'A crane.',
            overlays: [],
          },
          noSize,
        ),
      );
    }
  });
});

describe('renderedValidation', () => {
  const edit = makeImageEdit({ logo: undefined, overlays: [] });
  const plan = planRender({ asset: ASSET, spec: FEED, edit });

  it('passes a file of the right size', () => {
    const result = renderedValidation({ edit, copy: copy() }, ASSET, FEED, plan, {
      ...size,
      bytes: 300_000,
    });
    expect(result).toEqual({ level: 'pass', issues: [] });
  });

  it('fails a file of the wrong size', () => {
    const result = renderedValidation({ edit, copy: copy() }, ASSET, FEED, plan, {
      width: size.width - 10,
      height: size.height,
      bytes: 300_000,
    });
    expect(result.level).toBe('fail');
    expect(result.issues.map((issue) => issue.rule)).toEqual([1]);
  });
});

describe('sameResult', () => {
  const a: ValidationResult = {
    level: 'warn',
    issues: [
      { rule: 8, level: 'warn', message: 'x' },
      { rule: 9, level: 'warn', message: 'y' },
    ],
  };

  it('compares level and each issue in order', () => {
    expect(sameResult(a, structuredClone(a))).toBe(true);
    expect(sameResult(a, { ...a, level: 'fail' })).toBe(false);
    expect(sameResult(a, { ...a, issues: [...a.issues].reverse() })).toBe(false);
    expect(sameResult(a, { ...a, issues: a.issues.slice(0, 1) })).toBe(false);
    expect(sameResult({ level: 'pass', issues: [] }, { level: 'pass', issues: [] })).toBe(true);
  });

  it('notices a change in any field of an issue', () => {
    const one = (issue: Partial<ValidationResult['issues'][number]>): ValidationResult => ({
      level: 'warn',
      issues: [{ rule: 8, level: 'warn', message: 'x', ...issue }],
    });
    expect(sameResult(one({}), one({ rule: 9 }))).toBe(false);
    expect(sameResult(one({}), one({ level: 'fail' }))).toBe(false);
    expect(sameResult(one({}), one({ message: 'z' }))).toBe(false);
  });

  it('copes with a sparse issue list', () => {
    const sparse = { level: 'warn' as const, issues: new Array(1) as ValidationResult['issues'] };
    expect(sameResult(one(), sparse)).toBe(false);
    function one(): ValidationResult {
      return { level: 'warn', issues: [{ rule: 8, level: 'warn', message: 'x' }] };
    }
  });
});
