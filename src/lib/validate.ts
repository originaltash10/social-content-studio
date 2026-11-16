/**
 * Card validator: the nine rules from SPEC.md ("Platform specs and validation rules").
 *
 * Pure function of (measured output, placement spec). Every limit comes from the PlacementSpec
 * (src/data/platforms.json); nothing platform-specific is hard-coded here. A rule whose limit is
 * null in the spec, or whose measurement is not available yet (e.g. file size before render),
 * is skipped rather than guessed.
 */
import { parseRatio } from './platforms';
import type {
  Issue,
  MediaType,
  PlacementSpec,
  Rect,
  SafeZone,
  Size,
  ValidationResult,
} from '../types';

/** Pixel tolerance for listed sizes (rule 1: "within 1 px rounding"). */
export const SIZE_TOLERANCE_PX = 1;
/** Relative tolerance for ratio checks where a ratio has no listed pixel size, and for "same ratio". */
export const RATIO_TOLERANCE = 0.01;

/** What the validator needs to know about a card's output. Built from the card and its render. */
export type ValidationInput = {
  kind: MediaType;
  /** Output frame sizes: one for an image or video, one per slide/page for image-set or pdf. */
  frames: Size[];
  /** Encoded output size; omit if not rendered yet (rule 2 is skipped). */
  fileBytes?: number;
  /** Trimmed video length; omit for stills. */
  durationMs?: number;
  fps?: number;
  caption: string;
  hashtags: string[];
  altText?: string;
  /** Overlay and logo boxes, as fractions (0..1) of the output frame. */
  overlays?: Rect[];
  logo?: Rect;
  /** Focal point as fractions (0..1) of the output frame. */
  focal?: { x: number; y: number };
};

/** Character count as Unicode code points, so an emoji counts once rather than twice. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/**
 * Hashtags from the hashtag field plus any #tags in the caption, lower-cased and de-duplicated.
 * A caption tag counts only at the start or after whitespace, so URL fragments (page#top) don't.
 */
export function collectHashtags(caption: string, hashtags: string[]): string[] {
  const tags = new Set<string>();
  for (const h of hashtags) {
    const t = h.trim().replace(/^#+/, '').toLowerCase();
    if (t) tags.add(t);
  }
  for (const m of caption.matchAll(/(?:^|\s)#([\p{L}\p{N}_]+)/gu)) {
    tags.add((m[1] as string).toLowerCase());
  }
  return [...tags];
}

const URL_RE =
  /\bhttps?:\/\/\S+|\bwww\.[^\s.]+\.\S+|\b[a-z0-9][a-z0-9-]*\.(?:com|org|net|io|co|ly|gl|me|app|dev|info|biz|us)\b(?:\/\S*)?/i;

/** True if the text contains something a reader would take for a link. */
export function containsUrl(text: string): boolean {
  return URL_RE.test(text);
}

export function validate(input: ValidationInput, spec: PlacementSpec): ValidationResult {
  const issues: Issue[] = [
    ...checkDimensions(input, spec),
    ...checkFileSize(input, spec),
    ...checkVideo(input, spec),
    ...checkCaption(input, spec),
    ...checkHashtags(input, spec),
    ...checkSlides(input, spec),
    ...checkSafeZone(input, spec),
    ...checkAltText(input),
    ...checkCaptionLinks(input, spec),
  ];
  const level = issues.some((i) => i.level === 'fail')
    ? 'fail'
    : issues.some((i) => i.level === 'warn')
      ? 'warn'
      : 'pass';
  return { level, issues };
}

// Rule 1 -------------------------------------------------------------------------------------

/** Ratios in the spec that no listed pixel size covers; any frame close to one of these passes. */
function uncoveredRatios(spec: PlacementSpec): number[] {
  return spec.ratios
    .map((r) => parseRatio(r))
    .filter((r): r is number => r !== null)
    .filter((r) => !spec.sizes.some((s) => ratioClose(s.width / s.height, r)));
}

const ratioClose = (a: number, b: number) => Math.abs(a - b) / b <= RATIO_TOLERANCE;

const fmtSize = (s: Size) => `${s.width} x ${s.height}`;

function checkDimensions(input: ValidationInput, spec: PlacementSpec): Issue[] {
  if (input.frames.length === 0) {
    return [{ rule: 1, level: 'fail', message: 'No output dimensions to check.' }];
  }
  const freeRatios = uncoveredRatios(spec);
  const options = [
    ...spec.sizes.map(fmtSize),
    ...(freeRatios.length ? [`any ${ratioLabels(spec, freeRatios)} size`] : []),
  ].join(' or ');
  const issues: Issue[] = [];
  input.frames.forEach((f, i) => {
    const sizeOk = spec.sizes.some(
      (s) =>
        Math.abs(f.width - s.width) <= SIZE_TOLERANCE_PX &&
        Math.abs(f.height - s.height) <= SIZE_TOLERANCE_PX,
    );
    const ratioOk = freeRatios.some((r) => ratioClose(f.width / f.height, r));
    if (!sizeOk && !ratioOk) {
      const where = input.frames.length > 1 ? `Slide ${i + 1} is` : 'Output is';
      issues.push({
        rule: 1,
        level: 'fail',
        message: `${where} ${fmtSize(f)}; ${spec.label} needs ${options}.`,
      });
    }
  });
  return issues;
}

function ratioLabels(spec: PlacementSpec, ratios: number[]): string {
  return spec.ratios.filter((r) => ratios.includes(parseRatio(r) as number)).join(' or ');
}

// Rule 2 -------------------------------------------------------------------------------------

const fmtBytes = (n: number) =>
  n >= 1e9
    ? `${+(n / 1e9).toFixed(2)} GB`
    : n >= 1e6
      ? `${+(n / 1e6).toFixed(2)} MB`
      : `${+(n / 1e3).toFixed(1)} KB`;

function checkFileSize(input: ValidationInput, spec: PlacementSpec): Issue[] {
  if (spec.maxFileBytes === null || input.fileBytes === undefined) return [];
  if (input.fileBytes <= spec.maxFileBytes) return [];
  return [
    {
      rule: 2,
      level: 'fail',
      message: `File is ${fmtBytes(input.fileBytes)}; ${spec.label} allows up to ${fmtBytes(spec.maxFileBytes)}.`,
    },
  ];
}

// Rule 3 -------------------------------------------------------------------------------------

function checkVideo(input: ValidationInput, spec: PlacementSpec): Issue[] {
  if (input.kind !== 'video') return [];
  const issues: Issue[] = [];
  const range = spec.durationSec;
  if (range && input.durationMs !== undefined) {
    const sec = input.durationMs / 1000;
    if (range.min !== null && sec < range.min) {
      issues.push({
        rule: 3,
        level: 'fail',
        message: `Video is ${+sec.toFixed(1)} s; ${spec.label} needs at least ${range.min} s.`,
      });
    }
    if (range.max !== null && sec > range.max) {
      issues.push({
        rule: 3,
        level: 'fail',
        message: `Video is ${+sec.toFixed(1)} s; ${spec.label} allows up to ${range.max} s.`,
      });
    }
  }
  // 29.97 counts as 30: compare rounded rates.
  if (
    spec.recommendedFps !== null &&
    input.fps !== undefined &&
    Math.round(input.fps) !== spec.recommendedFps
  ) {
    issues.push({
      rule: 3,
      level: 'warn',
      message: `Video is ${+input.fps.toFixed(2)} fps; ${spec.recommendedFps} fps is recommended.`,
    });
  }
  return issues;
}

// Rule 4 -------------------------------------------------------------------------------------

const TRUNCATION_PREVIEW_CHARS = 40;

/**
 * The text that gets posted as the caption. Where the placement posts hashtags in the caption,
 * the hashtag field is appended, each tag with a leading #, all joined with spaces.
 */
export function postedCaption(input: ValidationInput, spec: PlacementSpec): string {
  if (!spec.hashtagsInCaption) return input.caption;
  const tags = input.hashtags
    .map((h) => h.trim())
    .filter((h) => h.replace(/^#+/, ''))
    .map((h) => (h.startsWith('#') ? h : `#${h}`));
  return [input.caption, ...tags].filter(Boolean).join(' ');
}

function checkCaption(input: ValidationInput, spec: PlacementSpec): Issue[] {
  if (spec.captionCap === null) return [];
  const chars = Array.from(postedCaption(input, spec));
  const len = chars.length;
  const what =
    spec.hashtagsInCaption && input.hashtags.length ? 'Caption with hashtags' : 'Caption';
  if (len > spec.captionCap) {
    return [
      {
        rule: 4,
        level: 'fail',
        message: `${what} is ${len} characters; ${spec.label} allows up to ${spec.captionCap}.`,
      },
    ];
  }
  return spec.truncation
    .filter((t) => len > t.chars)
    .map((t) => {
      const shown = chars.slice(Math.max(0, t.chars - TRUNCATION_PREVIEW_CHARS), t.chars).join('');
      const lead = t.chars > TRUNCATION_PREVIEW_CHARS ? '…' : '';
      return {
        rule: 4,
        level: 'warn',
        message: `${what} is ${len} characters; ${t.context} cuts it off after ${t.chars}: "${lead}${shown}" …more`,
      };
    });
}

// Rule 5 -------------------------------------------------------------------------------------

function checkHashtags(input: ValidationInput, spec: PlacementSpec): Issue[] {
  if (spec.hashtagCap === null) return [];
  const count = collectHashtags(input.caption, input.hashtags).length;
  if (count <= spec.hashtagCap) return [];
  return [
    {
      rule: 5,
      level: 'fail',
      message: `${count} hashtags; ${spec.label} allows up to ${spec.hashtagCap}.`,
    },
  ];
}

// Rule 6 -------------------------------------------------------------------------------------

function checkSlides(input: ValidationInput, spec: PlacementSpec): Issue[] {
  const slides = spec.slides;
  if (!slides) return [];
  const issues: Issue[] = [];
  const n = input.frames.length;
  if ((slides.min !== null && n < slides.min) || (slides.max !== null && n > slides.max)) {
    const range =
      slides.min !== null && slides.max !== null
        ? `${slides.min} to ${slides.max}`
        : slides.min !== null
          ? `at least ${slides.min}`
          : `up to ${slides.max}`;
    issues.push({
      rule: 6,
      level: 'fail',
      message: `${n} slides; ${spec.label} needs ${range}.`,
    });
  }
  const first = input.frames[0];
  if (slides.sameRatio && first) {
    const base = first.width / first.height;
    const odd = input.frames
      .map((f, i) => ({ i, r: f.width / f.height }))
      .filter(({ r }) => !ratioClose(r, base))
      .map(({ i }) => i + 1);
    if (odd.length) {
      issues.push({
        rule: 6,
        level: 'fail',
        message: `All slides must share one ratio; slide ${odd.join(', ')} differ${odd.length === 1 ? 's' : ''} from slide 1.`,
      });
    }
  }
  return issues;
}

// Rule 7 -------------------------------------------------------------------------------------

const EPS = 1e-9;

/** The safe area as fractions of the given frame. */
export function safeRect(zone: SafeZone, frame: Size): Rect {
  if (zone.kind === 'insets') {
    return {
      x: zone.left,
      y: zone.top,
      width: 1 - zone.left - zone.right,
      height: 1 - zone.top - zone.bottom,
    };
  }
  const width = Math.min(1, zone.width / frame.width);
  const height = Math.min(1, zone.height / frame.height);
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

const rectInside = (r: Rect, safe: Rect) =>
  r.x >= safe.x - EPS &&
  r.y >= safe.y - EPS &&
  r.x + r.width <= safe.x + safe.width + EPS &&
  r.y + r.height <= safe.y + safe.height + EPS;

const pointInside = (p: { x: number; y: number }, safe: Rect) =>
  rectInside({ x: p.x, y: p.y, width: 0, height: 0 }, safe);

function checkSafeZone(input: ValidationInput, spec: PlacementSpec): Issue[] {
  const frame = input.frames[0];
  if (!spec.safeZone || !frame) return [];
  const safe = safeRect(spec.safeZone, frame);
  const outside: string[] = [];
  (input.overlays ?? []).forEach((o, i) => {
    if (!rectInside(o, safe)) outside.push(`text overlay ${i + 1}`);
  });
  if (input.logo && !rectInside(input.logo, safe)) outside.push('logo');
  if (input.focal && !pointInside(input.focal, safe)) outside.push('focal point');
  if (!outside.length) return [];
  return [
    {
      rule: 7,
      level: 'warn',
      message: `In the ${spec.label} unsafe zone, where app UI may cover it: ${outside.join(', ')}.`,
    },
  ];
}

// Rule 8 -------------------------------------------------------------------------------------

function checkAltText(input: ValidationInput): Issue[] {
  if (input.kind !== 'image' && input.kind !== 'image-set') return [];
  if (input.altText?.trim()) return [];
  return [{ rule: 8, level: 'warn', message: 'Alt text is missing.' }];
}

// Rule 9 -------------------------------------------------------------------------------------

function checkCaptionLinks(input: ValidationInput, spec: PlacementSpec): Issue[] {
  if (spec.captionLinksClickable || !containsUrl(input.caption)) return [];
  return [
    {
      rule: 9,
      level: 'warn',
      message: `Caption contains a link, but links are not clickable in ${spec.platform} captions. Consider "link in bio".`,
    },
  ];
}
