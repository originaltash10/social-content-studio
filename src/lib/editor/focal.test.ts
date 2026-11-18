import { describe, expect, it } from 'vitest';
import { getPlacement } from '../platforms';
import { hash, makeAsset, makeCard, makeImageEdit } from '../../test/fixtures';
import type { Card, Size } from '../../types';
import { recentredCrops } from './focal';
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
