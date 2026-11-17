import { describe, expect, it } from 'vitest';
import { getPlacement } from '../platforms';
import { DEFAULT_QUALITY, defaultCrop } from '../render/plan';
import type { PlacementSpec } from '../../types';
import { hash, makeAsset, makeCard } from '../../test/fixtures';
import { creationSummary, draftCard, planCreation } from './cards';
import { plannedValidation } from './renderValidation';

const FEED = getPlacement('instagram', 'feed-vertical') as PlacementSpec;
const SQUARE = getPlacement('linkedin', 'image-square') as PlacementSpec;
const PHOTO = makeAsset({ id: hash('a'), fileName: 'site.jpg' });
const OTHER = makeAsset({ id: hash('c'), fileName: 'crew.png' });
const CLIP = makeAsset({ id: hash('b'), kind: 'video', fileName: 'clip.mp4' });

describe('draftCard', () => {
  it('makes a draft for one photo and placement with the focal-point crop', () => {
    const draft = draftCard(PHOTO, FEED);
    expect(draft).toEqual({
      assetIds: [PHOTO.id],
      platform: 'instagram',
      placement: 'feed-vertical',
      status: 'draft',
      edit: {
        crop: defaultCrop(PHOTO, FEED),
        overlays: [],
        format: 'jpg',
        quality: DEFAULT_QUALITY,
      },
      copy: { caption: '', firstComment: '', hashtags: [], altText: '' },
      validation: plannedValidation(draft, PHOTO, FEED),
      overrideFail: false,
      comments: [],
    });
  });

  it('starts with the alt-text warning until alt text is written', () => {
    expect(draftCard(PHOTO, SQUARE).validation).toEqual({
      level: 'warn',
      issues: [expect.objectContaining({ rule: 8, level: 'warn' })],
    });
  });
});

describe('planCreation', () => {
  it('makes one card per photo and placement, photo by photo', () => {
    const plan = planCreation([PHOTO, OTHER], [FEED, SQUARE], []);
    expect(plan.drafts.map((d) => [d.assetIds[0], d.placement])).toEqual([
      [PHOTO.id, 'feed-vertical'],
      [PHOTO.id, 'image-square'],
      [OTHER.id, 'feed-vertical'],
      [OTHER.id, 'image-square'],
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('skips videos', () => {
    expect(planCreation([CLIP], [FEED], []).drafts).toEqual([]);
  });

  it('skips a photo and placement that already have an original card, and says so', () => {
    const existing = [
      makeCard({
        id: 'x',
        assetIds: [PHOTO.id],
        platform: 'instagram',
        placement: 'feed-vertical',
      }),
    ];
    const plan = planCreation([PHOTO], [FEED, SQUARE], existing);
    expect(plan.drafts.map((d) => d.placement)).toEqual(['image-square']);
    expect(plan.skipped).toEqual([
      {
        asset: PHOTO,
        spec: FEED,
        message: 'Instagram Feed vertical already has a card for "site.jpg".',
      },
    ]);
  });

  it('does not count duplicates, other photos, other placements or multi-photo cards', () => {
    const existing = [
      makeCard({ id: 'd', parentId: 'gone', assetIds: [PHOTO.id], placement: 'feed-vertical' }),
      makeCard({ id: 'o', assetIds: [OTHER.id], placement: 'feed-vertical' }),
      makeCard({ id: 'p', assetIds: [PHOTO.id], placement: 'feed-square' }),
      makeCard({ id: 'l', assetIds: [PHOTO.id], platform: 'linkedin', placement: 'feed-vertical' }),
      makeCard({ id: 'm', assetIds: [PHOTO.id, OTHER.id], placement: 'feed-vertical' }),
    ];
    expect(planCreation([PHOTO], [FEED], existing).drafts).toHaveLength(1);
  });
});

describe('creationSummary', () => {
  it('counts the cards made and lists what was skipped', () => {
    expect(creationSummary(planCreation([PHOTO], [FEED], []))).toBe('Created 1 card.');
    expect(creationSummary(planCreation([PHOTO, OTHER], [FEED], []))).toBe('Created 2 cards.');
    const existing = [makeCard({ assetIds: [PHOTO.id] })];
    expect(creationSummary(planCreation([PHOTO], [FEED], existing))).toBe(
      'No new cards were created. Instagram Feed vertical already has a card for "site.jpg".',
    );
  });
});
