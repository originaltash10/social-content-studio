import { describe, expect, it } from 'vitest';
import { makeAsset, makeCard } from '../../test/fixtures';
import { effectiveFocal } from './focal';

describe('effectiveFocal', () => {
  const asset = makeAsset({ focal: { x: 0.5, y: 0.4 } });

  it("is the photo's focal point for a card without its own", () => {
    expect(effectiveFocal(makeCard(), asset)).toEqual({ x: 0.5, y: 0.4 });
  });

  it("is the card's own focal point when it has one", () => {
    const card = makeCard({ focal: { x: 0.2, y: 0.9 } });
    expect(effectiveFocal(card, asset)).toEqual({ x: 0.2, y: 0.9 });
  });

  it("uses the card's own point even where it equals the corner of the photo", () => {
    expect(effectiveFocal({ focal: { x: 0, y: 0 } }, asset)).toEqual({ x: 0, y: 0 });
  });
});
