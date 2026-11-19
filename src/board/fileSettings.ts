/**
 * The file type and JPG quality shown in a card's details. SPEC.md gives each image card a
 * `format` ('jpg' | 'png') and a `quality` (0..1); the renderer (src/lib/render/plan.ts) reads a
 * missing format as JPG and a missing or unusable quality as DEFAULT_QUALITY (0.9), kept inside
 * 0..1. These helpers read the card the same way, so a card shows what it will be rendered as.
 *
 * The slider runs from 10% to 100% in steps of 1%. Below about 10% a browser's JPG turns to
 * blocks for little saving, so the slider does not go there; a stored value below it (from a
 * hand-edited session) is shown as it is and left alone until the slider is moved.
 */

import { clampQuality } from '../lib/render/plan';
import type { OutputFormat } from '../lib/render/plan';
import type { ImageEdit } from '../types';

export const QUALITY_MIN = 10;
export const QUALITY_MAX = 100;
/** Arrow keys move the slider by this many percent. */
export const QUALITY_STEP = 1;
/** Page Up and Page Down move it by this many percent. */
export const QUALITY_PAGE = 10;

export const FILE_TYPE_LEGEND = 'File type';
export const QUALITY_NAME = 'Quality';
export const PNG_NOTE = 'PNG files are lossless, so there is no quality setting.';

export const FORMAT_CHOICES: readonly { value: OutputFormat; label: string }[] = [
  { value: 'jpg', label: 'JPG' },
  { value: 'png', label: 'PNG' },
];

type FileFields = Partial<Pick<ImageEdit, 'format' | 'quality'>>;

/** The file type a card is rendered as: PNG only when it says so. */
export function shownFormat(edit: FileFields): OutputFormat {
  return edit.format === 'png' ? 'png' : 'jpg';
}

/** The quality a card is rendered at, in whole percent. */
export function shownPercent(edit: FileFields): number {
  return toPercent(clampQuality(edit.quality));
}

/** A quality (0..1) in whole percent. */
export function toPercent(quality: number): number {
  return Math.round(quality * 100);
}

/** Whole percent back to a quality (0..1) with at most two decimals, so 90% is exactly 0.9. */
export function fromPercent(percent: number): number {
  return Math.round(percent) / 100;
}

/** The slider's visible line, for example "Quality: 90%". */
export function qualityText(percent: number): string {
  return `${QUALITY_NAME}: ${percent}%`;
}

/** The slider's aria-valuetext, for example "90%". */
export function qualityValueText(percent: number): string {
  return `${percent}%`;
}

/**
 * Where a key moves the slider from `current`, or null for a key the slider does not handle.
 * A value below the slider's range (from a hand-edited session) is never lowered further and
 * never raised by a key that means "lower".
 */
export function keyPercent(key: string, current: number): number | null {
  const clamp = (value: number) => Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, value));
  const lower = (by: number) => Math.min(current, clamp(current - by));
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(current + QUALITY_STEP);
    case 'ArrowLeft':
    case 'ArrowDown':
      return lower(QUALITY_STEP);
    case 'PageUp':
      return clamp(current + QUALITY_PAGE);
    case 'PageDown':
      return lower(QUALITY_PAGE);
    case 'Home':
      return Math.min(current, QUALITY_MIN);
    case 'End':
      return QUALITY_MAX;
    default:
      return null;
  }
}
