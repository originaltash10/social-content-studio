/**
 * Turns "this photo, for this placement" into a render plan of plain numbers for the image
 * worker. Runs on the main thread. Every output size comes from the placement's entry in
 * src/data/platforms.json; nothing platform-specific is written here.
 */

import type { Asset, ImageEdit, MediaType, PlacementSpec, Rect, Size } from '../../types';
import { DEFAULT_BACKGROUND, parseBackground } from './background';
import { cropToPixels, fitCropToRatio, focalCrop } from './crop';
import type { PixelRect } from './crop';

/**
 * The most source pixels a render will attempt. A decoded photo needs four bytes per pixel, so
 * this is roughly 480 MB at the limit. It protects the tab from running out of memory; it is an
 * app limit, not a platform rule.
 */
export const MAX_SOURCE_PIXELS = 120_000_000;

/** Used when a card's quality is not a usable number. */
export const DEFAULT_QUALITY = 0.9;

/** A quality kept inside 0..1; anything that is not a number becomes the default. */
export function clampQuality(quality: number | undefined): number {
  return quality !== undefined && Number.isFinite(quality)
    ? Math.min(1, Math.max(0, quality))
    : DEFAULT_QUALITY;
}

/** Placement types that are made of still images: a post, a carousel slide, a document page. */
const IMAGE_MEDIA: readonly MediaType[] = ['image', 'image-set', 'pdf'];

export type OutputFormat = ImageEdit['format'];

export type RenderPlan = {
  /** The photo's displayed size, as recorded on the asset. */
  sourceSize: Size;
  /**
   * The part of the photo to use, in source pixels. A crop with padding reaches past the photo
   * on the padded axis.
   */
  crop: PixelRect;
  /** The same crop in fractions of the photo, after fitting to the target ratio. */
  cropRect: Rect;
  /** The exact output size, from platforms.json. */
  target: Size;
  format: OutputFormat;
  /** 0..1. Only JPG uses it. */
  quality: number;
  /**
   * "#rrggbb". Fills the part of the crop outside the photo and, in a JPG, the transparent
   * parts of the photo. White unless the card has a colour of its own.
   */
  background: string;
  /**
   * True when the crop has fewer pixels than the output, so the picture is enlarged. The
   * crop's whole size counts, padding included.
   */
  upscaled: boolean;
};

export type PlanFailure = 'not-image-asset' | 'not-image-placement' | 'no-such-size' | 'too-large';

/** Thrown when a render cannot be planned. The message is written for the user. */
export class RenderPlanError extends Error {
  readonly reason: PlanFailure;

  constructor(reason: PlanFailure, message: string) {
    super(message);
    this.name = 'RenderPlanError';
    this.reason = reason;
  }
}

/** True when the placement takes still images. */
export function isImagePlacement(spec: PlacementSpec): boolean {
  return spec.mediaTypes.some((type) => IMAGE_MEDIA.includes(type));
}

/** One of the placement's listed sizes. Throws when the placement has no size at that index. */
export function targetSize(spec: PlacementSpec, sizeIndex = 0): Size {
  const size = spec.sizes[sizeIndex];
  if (!size) {
    throw new RenderPlanError(
      'no-such-size',
      `${spec.label} has no size number ${sizeIndex + 1} to render.`,
    );
  }
  return { width: size.width, height: size.height };
}

/** The default crop of an asset for a placement: see `focalCrop`. */
export function defaultCrop(asset: Asset, spec: PlacementSpec, sizeIndex = 0): Rect {
  const target = targetSize(spec, sizeIndex);
  return focalCrop(asset, target.width / target.height, asset.focal);
}

export type PlanInput = {
  asset: Asset;
  spec: PlacementSpec;
  /** The card's edit. Without a crop, the default crop from the asset's focal point is used. */
  edit?: Partial<Pick<ImageEdit, 'crop' | 'format' | 'quality'>>;
  /** The card's background colour. Without a usable one, white is used. */
  background?: string | undefined;
  /** Which of the placement's listed sizes to render; the first unless told otherwise. */
  sizeIndex?: number;
};

function megapixels(pixels: number): string {
  return `${Math.round(pixels / 1_000_000)} megapixels`;
}

/** Plans one render. Throws a RenderPlanError when the render cannot be done. */
export function planRender({
  asset,
  spec,
  edit = {},
  background,
  sizeIndex = 0,
}: PlanInput): RenderPlan {
  if (asset.kind !== 'image') {
    throw new RenderPlanError(
      'not-image-asset',
      `"${asset.fileName}" is a video, so it cannot be made into an image.`,
    );
  }
  if (!isImagePlacement(spec)) {
    throw new RenderPlanError(
      'not-image-placement',
      `${spec.label} takes video only, so "${asset.fileName}" cannot be made into an image for it.`,
    );
  }
  const target = targetSize(spec, sizeIndex);
  const pixels = asset.width * asset.height;
  if (pixels > MAX_SOURCE_PIXELS) {
    throw new RenderPlanError(
      'too-large',
      `"${asset.fileName}" is ${megapixels(pixels)}, which is too large to process in the ` +
        `browser (the limit is ${megapixels(MAX_SOURCE_PIXELS)}). Save a smaller copy and ` +
        'import that instead.',
    );
  }

  const sourceSize = { width: asset.width, height: asset.height };
  const ratio = target.width / target.height;
  const cropRect = edit.crop
    ? fitCropToRatio(edit.crop, sourceSize, ratio)
    : focalCrop(sourceSize, ratio, asset.focal);
  const crop = cropToPixels(cropRect, sourceSize);
  return {
    sourceSize,
    crop,
    cropRect,
    target,
    format: edit.format ?? 'jpg',
    quality: clampQuality(edit.quality),
    background: parseBackground(background) ?? DEFAULT_BACKGROUND,
    upscaled: target.width > crop.width || target.height > crop.height,
  };
}
