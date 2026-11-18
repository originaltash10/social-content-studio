import { describe, expect, it } from 'vitest';
import { getPlacement } from '../platforms';
import { hash, makeAsset, makeCard, makeImageEdit } from '../../test/fixtures';
import type { Card, Size } from '../../types';
import { ownFocalMove, recentredCrops } from './focal';
import { automaticCrop, moveCrop } from './geometry';

// Output sizes come from the platform data, never from this file.
const targetOf = (card: Card): Size | undefined =>
  getPlacement(card.platform, card.placement)?.sizes[0];
const VERTICAL = getPlacement('instagram', 'feed-vertical')?.sizes[0] as Size;
const SQUARE = getPlacement('linkedin', 'image-square')?.sizes[0] as Size;

const PHOTO = makeAsset({ id: hash('a'), width: 4000, height: 3000, focal: { x: 0.5, y: 0.5 } });
const SOURCE = { width: PHOTO.width, height: PHOTO.height };
const OLD = PHOTO.focal;
const NEW = { x: 0.2, y: 0.5 };

const vertical = (overrides: Partial<Card> = {}) =>
  makeCard({
    id: 'vertical',
    assetIds: [PHOTO.id],
    platform: 'instagram',
    placement: 'feed-vertical',
    edit: makeImageEdit({ crop: automaticCrop(SOURCE, VERTICAL, OLD) }),
    ...overrides,
  });
const square = (overrides: Partial<Card> = {}) =>
  makeCard({
    id: 'square',
    assetIds: [PHOTO.id],
    platform: 'linkedin',
    placement: 'image-square',
    edit: makeImageEdit({ crop: automaticCrop(SOURCE, SQUARE, OLD) }),
    ...overrides,
  });

describe('recentredCrops', () => {
  it('re-centres every card still on its automatic crop, each for its own placement', () => {
    expect(recentredCrops([vertical(), square()], PHOTO, NEW, targetOf)).toEqual([
      { cardId: 'vertical', crop: automaticCrop(SOURCE, VERTICAL, NEW) },
      { cardId: 'square', crop: automaticCrop(SOURCE, SQUARE, NEW) },
    ]);
  });

  it('leaves a card whose crop was adjusted by hand', () => {
    const adjusted = vertical({
      id: 'adjusted',
      edit: makeImageEdit({ crop: moveCrop(automaticCrop(SOURCE, VERTICAL, OLD), 0.05, 0) }),
    });
    expect(recentredCrops([adjusted, square()], PHOTO, NEW, targetOf)).toEqual([
      { cardId: 'square', crop: automaticCrop(SOURCE, SQUARE, NEW) },
    ]);
  });

  it('counts a crop as automatic after a save and load, and after rounding', () => {
    const auto = automaticCrop(SOURCE, VERTICAL, OLD);
    const reloaded = vertical({
      edit: makeImageEdit({ crop: JSON.parse(JSON.stringify(auto)) as typeof auto }),
    });
    const rounded = vertical({ edit: makeImageEdit({ crop: { ...auto, x: auto.x + 1e-12 } }) });
    expect(recentredCrops([reloaded], PHOTO, NEW, targetOf)).toHaveLength(1);
    expect(recentredCrops([rounded], PHOTO, NEW, targetOf)).toHaveLength(1);
  });

  it('leaves out a card whose automatic crop the move does not change', () => {
    // A vertical crop uses the whole height, so moving the point up or down changes nothing.
    expect(recentredCrops([vertical()], PHOTO, { x: 0.5, y: 0.9 }, targetOf)).toEqual([]);
    expect(recentredCrops([vertical(), square()], PHOTO, OLD, targetOf)).toEqual([]);
  });

  it("leaves another photo's cards, carousels, and cards with more than one photo", () => {
    const cards = [
      vertical({ id: 'other', assetIds: [hash('b')] }),
      vertical({ id: 'pair', assetIds: [PHOTO.id, hash('b')] }),
      vertical({ id: 'carousel', edit: { slides: [], coverIndex: 0 } }),
    ];
    expect(recentredCrops(cards, PHOTO, NEW, targetOf)).toEqual([]);
  });

  it('leaves a card whose placement is not known', () => {
    const gone = vertical({ id: 'gone', placement: 'gone' });
    expect(targetOf(gone)).toBeUndefined();
    expect(recentredCrops([gone], PHOTO, NEW, targetOf)).toEqual([]);
  });
});

describe('recentredCrops and cards with their own focal point', () => {
  it('never lists a card with its own point, even when its crop is the automatic one', () => {
    // A duplicate made a moment ago: the same crop as its source, and its own copy of the point.
    const duplicate = vertical({ id: 'duplicate', parentId: 'vertical', focal: { ...OLD } });
    expect(recentredCrops([vertical(), duplicate, square()], PHOTO, NEW, targetOf)).toEqual([
      { cardId: 'vertical', crop: automaticCrop(SOURCE, VERTICAL, NEW) },
      { cardId: 'square', crop: automaticCrop(SOURCE, SQUARE, NEW) },
    ]);
  });

  it('never lists a card with its own point, wherever that point is', () => {
    const elsewhere = { x: 0.8, y: 0.5 };
    const cards = [
      vertical({ id: 'a', focal: elsewhere }),
      vertical({
        id: 'b',
        focal: elsewhere,
        edit: makeImageEdit({ crop: automaticCrop(SOURCE, VERTICAL, elsewhere) }),
      }),
    ];
    expect(recentredCrops(cards, PHOTO, NEW, targetOf)).toEqual([]);
  });
});

describe('ownFocalMove', () => {
  const own = (focal: { x: number; y: number }, crop = automaticCrop(SOURCE, VERTICAL, focal)) => ({
    focal,
    edit: makeImageEdit({ crop }),
  });

  it('moves the point and re-centres a card on its automatic crop, judged by its own point', () => {
    // The card's own point is not the photo's: the photo's point plays no part.
    const card = own({ x: 0.8, y: 0.5 });
    expect(ownFocalMove(card, SOURCE, VERTICAL, NEW)).toEqual({
      focal: NEW,
      crop: automaticCrop(SOURCE, VERTICAL, NEW),
    });
  });

  it('moves the point only, for a crop adjusted by hand', () => {
    const adjusted = own(OLD, moveCrop(automaticCrop(SOURCE, VERTICAL, OLD), 0.05, 0));
    const move = ownFocalMove(adjusted, SOURCE, VERTICAL, NEW);
    expect(move).toEqual({ focal: NEW });
    expect(move && Object.hasOwn(move, 'crop')).toBe(false);
  });

  it("does not count a crop that is automatic for the photo's point but not for its own", () => {
    // The crop the photo's point gives; the card's own point is elsewhere, so it is hand-set.
    const card = own({ x: 0.8, y: 0.5 }, automaticCrop(SOURCE, VERTICAL, OLD));
    expect(ownFocalMove(card, SOURCE, VERTICAL, NEW)).toEqual({ focal: NEW });
  });

  it('moves the point only when the move does not change the automatic crop', () => {
    // A vertical crop uses the whole height, so moving the point up or down changes no crop.
    expect(ownFocalMove(own(OLD), SOURCE, VERTICAL, { x: 0.5, y: 0.9 })).toEqual({
      focal: { x: 0.5, y: 0.9 },
    });
  });

  it('is null when the point would not move', () => {
    expect(ownFocalMove(own(OLD), SOURCE, VERTICAL, { ...OLD })).toBeNull();
    // Pushed past the edge it is already on: clamped back to where it is.
    expect(ownFocalMove(own({ x: 1, y: 0 }), SOURCE, VERTICAL, { x: 1.01, y: -0.01 })).toBeNull();
    expect(ownFocalMove(own(OLD), SOURCE, VERTICAL, { x: 0.5, y: 0.51 })).not.toBeNull();
    expect(ownFocalMove(own(OLD), SOURCE, VERTICAL, { x: 0.51, y: 0.5 })).not.toBeNull();
  });

  it.each<[string, { x: number; y: number }, { x: number; y: number }]>([
    ['beyond the right and bottom edges', { x: 3, y: 1.5 }, { x: 1, y: 1 }],
    ['beyond the left and top edges', { x: -2, y: -0.001 }, { x: 0, y: 0 }],
    ['on the edges', { x: 1, y: 0 }, { x: 1, y: 0 }],
    ['inside the photo', { x: 0.25, y: 0.75 }, { x: 0.25, y: 0.75 }],
    ['infinitely far away', { x: Infinity, y: -Infinity }, { x: 0.5, y: 0.5 }],
    ['not a number', { x: Number.NaN, y: 0.3 }, { x: 0.5, y: 0.3 }],
  ])('always returns a point inside 0..1: %s', (_name, wanted, expected) => {
    // Both a card on its automatic crop and one adjusted by hand; the start point differs from
    // every expected point, so there is always a move.
    const start = { x: 0.4, y: 0.6 };
    const adjusted = own(start, moveCrop(automaticCrop(SOURCE, SQUARE, start), 0.03, 0));
    for (const card of [own(start, automaticCrop(SOURCE, SQUARE, start)), adjusted]) {
      const move = ownFocalMove(card, SOURCE, SQUARE, wanted);
      expect(move?.focal).toEqual(expected);
      expect(move?.focal.x).toBeGreaterThanOrEqual(0);
      expect(move?.focal.x).toBeLessThanOrEqual(1);
      expect(move?.focal.y).toBeGreaterThanOrEqual(0);
      expect(move?.focal.y).toBeLessThanOrEqual(1);
    }
    // The crop that goes with it is the one for the clamped point, and stays inside the photo.
    const auto = ownFocalMove(
      own(start, automaticCrop(SOURCE, SQUARE, start)),
      SOURCE,
      SQUARE,
      wanted,
    );
    if (auto?.crop) {
      expect(auto.crop).toEqual(automaticCrop(SOURCE, SQUARE, expected));
      expect(auto.crop.x).toBeGreaterThanOrEqual(0);
      expect(auto.crop.x + auto.crop.width).toBeLessThanOrEqual(1);
    }
  });

  it('does not change the card it was given', () => {
    const card = own(OLD);
    const before = structuredClone(card);
    ownFocalMove(card, SOURCE, VERTICAL, NEW);
    expect(card).toEqual(before);
  });
});
