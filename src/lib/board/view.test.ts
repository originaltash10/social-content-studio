import { describe, expect, it } from 'vitest';
import type { Card } from '../../types';
import { hash, makeAsset, makeCard } from '../../test/fixtures';
import type { CardRender } from './controller';
import {
  PLATFORM_FILTERS,
  RESULT_FILTERS,
  RESULT_LABEL,
  groupCards,
  isPending,
  matches,
  platformCounts,
  renderSummary,
  resultOf,
} from './view';

const A = makeAsset({ id: hash('a'), fileName: 'a.jpg' });
const B = makeAsset({ id: hash('c'), fileName: 'b.jpg' });
const done: CardRender = {
  kind: 'done',
  url: 'blob:x',
  width: 1,
  height: 1,
  bytes: 1,
  format: 'jpg',
  upscaled: false,
};
const level = (l: Card['validation']['level']) => ({ level: l, issues: [] });

function card(id: string, overrides: Partial<Card> = {}): Card {
  return makeCard({ id, assetIds: [A.id], validation: level('pass'), ...overrides });
}

const all = { platform: 'all', result: 'all' } as const;

describe('resultOf and matches', () => {
  it('is "unchecked" until the file is done, then the validation level', () => {
    const c = card('1', { validation: level('warn') });
    expect(resultOf(c, undefined)).toBe('unchecked');
    expect(resultOf(c, { kind: 'waiting' })).toBe('unchecked');
    expect(resultOf(c, { kind: 'failed', message: 'x' })).toBe('unchecked');
    expect(resultOf(c, done)).toBe('warn');
  });

  it('filters by platform and by result', () => {
    const c = card('1', { platform: 'linkedin', validation: level('fail') });
    expect(matches(c, done, all)).toBe(true);
    expect(matches(c, done, { platform: 'linkedin', result: 'fail' })).toBe(true);
    expect(matches(c, done, { platform: 'instagram', result: 'all' })).toBe(false);
    expect(matches(c, done, { platform: 'all', result: 'pass' })).toBe(false);
    expect(matches(c, undefined, { platform: 'all', result: 'unchecked' })).toBe(true);
  });

  it('labels every result and lists the filter choices', () => {
    expect(RESULT_LABEL).toEqual({
      pass: 'Pass',
      warn: 'Warning',
      fail: 'Fail',
      unchecked: 'Not checked yet',
    });
    expect(PLATFORM_FILTERS).toEqual(['all', 'instagram', 'linkedin']);
    expect(RESULT_FILTERS).toEqual(['all', 'pass', 'warn', 'fail', 'unchecked']);
  });
});

describe('groupCards', () => {
  it('groups by source photo in import order, leaving out photos with no cards', () => {
    const cards = [card('1', { assetIds: [B.id] }), card('2'), card('3', { assetIds: [B.id] })];
    const groups = groupCards([A, B, makeAsset({ id: hash('d') })], cards, new Map(), all);
    expect(groups.map((g) => [g.asset?.fileName, g.cards.map((c) => c.id)])).toEqual([
      ['a.jpg', ['2']],
      ['b.jpg', ['1', '3']],
    ]);
  });

  it('puts cards whose photo is not in the session last', () => {
    const cards = [card('1', { assetIds: [hash('e')] }), card('2'), card('3', { assetIds: [] })];
    const groups = groupCards([A], cards, new Map(), all);
    expect(groups.map((g) => [g.assetId, g.asset, g.cards.map((c) => c.id)])).toEqual([
      [A.id, A, ['2']],
      [hash('e'), null, ['1']],
      ['', null, ['3']],
    ]);
  });

  it('applies the filters', () => {
    const cards = [
      card('1', { platform: 'linkedin' }),
      card('2'),
      card('3', { validation: level('fail') }),
    ];
    const renders = new Map([
      ['1', done],
      ['3', done],
    ]);
    const groups = groupCards([A], cards, renders, { platform: 'all', result: 'fail' });
    expect(groups.flatMap((g) => g.cards.map((c) => c.id))).toEqual(['3']);
    expect(groupCards([A], cards, renders, { platform: 'instagram', result: 'pass' })).toEqual([]);
  });
});

describe('platformCounts', () => {
  it('counts the cards on each platform', () => {
    const cards = [card('1'), card('2', { platform: 'linkedin' }), card('3')];
    expect(platformCounts(cards)).toEqual({ all: 3, instagram: 2, linkedin: 1, facebook: 0, x: 0 });
  });
});

describe('isPending', () => {
  it('is true while waiting or working', () => {
    expect(isPending({ kind: 'waiting' })).toBe(true);
    expect(isPending({ kind: 'working', stage: 'drawing' })).toBe(true);
    expect(isPending(done)).toBe(false);
    expect(isPending({ kind: 'cancelled' })).toBe(false);
    expect(isPending(undefined)).toBe(false);
  });
});

describe('renderSummary', () => {
  it('is empty with no cards', () => {
    expect(renderSummary([], new Map())).toBe('');
  });

  it('counts progress while files are being made', () => {
    const cards = [card('1'), card('2'), card('3')];
    const renders = new Map<string, CardRender>([
      ['1', done],
      ['2', { kind: 'working', stage: 'drawing' }],
      ['3', { kind: 'waiting' }],
    ]);
    expect(renderSummary(cards, renders)).toBe('Rendering 2 of 3…');
  });

  it('counts results when everything has finished', () => {
    const cards = [
      card('1'),
      card('2', { validation: level('warn') }),
      card('3', { validation: level('fail') }),
      card('4'),
      card('5'),
      card('6'),
    ];
    const renders = new Map<string, CardRender>([
      ['1', done],
      ['2', done],
      ['3', done],
      ['4', { kind: 'failed', message: 'x' }],
      ['5', { kind: 'cancelled' }],
    ]);
    expect(renderSummary(cards, renders)).toBe(
      'Rendered 3 cards: 1 pass, 1 with warnings, 1 fail, 1 could not be rendered, 1 cancelled.',
    );
    expect(renderSummary([card('1')], new Map([['1', done]]))).toBe('Rendered 1 card: 1 pass.');
  });
});
