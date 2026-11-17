/**
 * Which placements the board can create cards for. Phase 1 covers Instagram and LinkedIn, and
 * single-image posts only: carousels, document carousels and video come with later features.
 * Every size and label is read from src/data/platforms.json; this file holds no platform numbers.
 */

import { isImagePlacement } from '../render/plan';
import type { PlacementSpec, Platform, PlatformsFile } from '../../types';

/** The platforms the board offers in Phase 1, in the order SPEC.md lists them. */
export const BOARD_PLATFORMS: readonly Platform[] = ['instagram', 'linkedin'];

/** What users call each platform. */
export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  x: 'X',
};

/** True when a card for one photo can be made for this placement. */
export function isSingleImagePlacement(spec: PlacementSpec): boolean {
  return spec.mediaTypes.includes('image') && isImagePlacement(spec);
}

export type PlatformPlacements = { platform: Platform; label: string; placements: PlacementSpec[] };

/** The placements the board offers, grouped by platform, in the order of BOARD_PLATFORMS. */
export function boardPlacements(data: PlatformsFile): PlatformPlacements[] {
  return BOARD_PLATFORMS.map((platform) => ({
    platform,
    label: PLATFORM_LABEL[platform],
    placements: data.placements.filter(
      (spec) => spec.platform === platform && isSingleImagePlacement(spec),
    ),
  })).filter((group) => group.placements.length > 0);
}

/** A placement's name as shown on a card, for example "Instagram Feed vertical". */
export function placementName(spec: Pick<PlacementSpec, 'platform' | 'label'>): string {
  return `${PLATFORM_LABEL[spec.platform]} ${spec.label}`;
}

/** The size a placement renders at, for example "1080 × 1350". */
export function sizeLabel(spec: PlacementSpec): string {
  const size = spec.sizes[0];
  return size ? `${size.width} × ${size.height}` : 'No size listed';
}
