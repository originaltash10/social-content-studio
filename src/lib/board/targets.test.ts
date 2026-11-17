import { describe, expect, it } from 'vitest';
import { platforms } from '../platforms';
import type { PlacementSpec } from '../../types';
import {
  BOARD_PLATFORMS,
  PLATFORM_LABEL,
  boardPlacements,
  isSingleImagePlacement,
  placementName,
  sizeLabel,
} from './targets';

const all = platforms.placements;

describe('boardPlacements', () => {
  const groups = boardPlacements(platforms);

  it('offers Instagram then LinkedIn, and no other platform', () => {
    expect(BOARD_PLATFORMS).toEqual(['instagram', 'linkedin']);
    expect(groups.map((group) => group.platform)).toEqual(['instagram', 'linkedin']);
    expect(groups.map((group) => group.label)).toEqual(['Instagram', 'LinkedIn']);
  });

  it('offers every single-image placement of those platforms from platforms.json, in file order', () => {
    for (const group of groups) {
      const expected = all.filter(
        (spec) => spec.platform === group.platform && spec.mediaTypes.includes('image'),
      );
      expect(group.placements).toEqual(expected);
      expect(group.placements.length).toBeGreaterThan(0);
    }
  });

  it('leaves out carousels, document carousels and video-only placements', () => {
    const offered = groups.flatMap((group) => group.placements);
    for (const spec of offered) expect(spec.mediaTypes).toContain('image');
    const leftOut = all.filter(
      (spec) => BOARD_PLATFORMS.includes(spec.platform) && !offered.includes(spec),
    );
    expect(leftOut.length).toBeGreaterThan(0);
    for (const spec of leftOut) expect(spec.mediaTypes).not.toContain('image');
  });

  it('drops a platform that has no single-image placement', () => {
    const videoOnly = all
      .filter((spec) => spec.platform === 'linkedin')
      .map((spec) => ({ ...spec, mediaTypes: ['video' as const] }));
    const data = {
      ...platforms,
      placements: [...all.filter((s) => s.platform === 'instagram'), ...videoOnly],
    };
    expect(boardPlacements(data).map((group) => group.platform)).toEqual(['instagram']);
  });
});

describe('isSingleImagePlacement', () => {
  const base = all[0] as PlacementSpec;
  it('needs the image media type', () => {
    expect(isSingleImagePlacement({ ...base, mediaTypes: ['image'] })).toBe(true);
    expect(isSingleImagePlacement({ ...base, mediaTypes: ['image', 'video'] })).toBe(true);
    expect(isSingleImagePlacement({ ...base, mediaTypes: ['image-set'] })).toBe(false);
    expect(isSingleImagePlacement({ ...base, mediaTypes: ['pdf'] })).toBe(false);
    expect(isSingleImagePlacement({ ...base, mediaTypes: ['video'] })).toBe(false);
  });
});

describe('labels', () => {
  const base = all[0] as PlacementSpec;

  it('names every platform', () => {
    expect(PLATFORM_LABEL).toEqual({
      instagram: 'Instagram',
      linkedin: 'LinkedIn',
      facebook: 'Facebook',
      x: 'X',
    });
  });

  it('names a placement by platform and label', () => {
    expect(placementName({ platform: 'linkedin', label: 'Image post square' })).toBe(
      'LinkedIn Image post square',
    );
  });

  it('shows the first listed size from the data', () => {
    const size = base.sizes[0] as { width: number; height: number };
    expect(sizeLabel(base)).toBe(`${size.width} × ${size.height}`);
    expect(sizeLabel({ ...base, sizes: [] })).toBe('No size listed');
  });
});
