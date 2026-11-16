/**
 * Loads and checks src/data/platforms.json. The JSON is edited by hand (marketing updates it
 * without a rebuild), so it is checked at runtime and every problem is reported with its path.
 */
import rawPlatforms from '../data/platforms.json';
import type {
  MediaType,
  PlacementSpec,
  Platform,
  PlatformsFile,
  Range,
  SafeZone,
  Size,
  SourceInfo,
  TruncationPoint,
} from '../types';

const PLATFORMS: readonly Platform[] = ['instagram', 'linkedin', 'facebook', 'x'];
const MEDIA_TYPES: readonly MediaType[] = ['image', 'video', 'image-set', 'pdf'];
const RATIO_RE = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class PlatformsError extends Error {
  constructor(public readonly problems: string[]) {
    super(`platforms.json is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'PlatformsError';
  }
}

/** Parses a "w:h" ratio string ("4:5", "1.91:1") to width / height. Returns null if malformed. */
export function parseRatio(ratio: string): number | null {
  const m = RATIO_RE.exec(ratio);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isNonNegNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Validates unknown JSON against the PlatformsFile shape. Throws PlatformsError listing every problem. */
export function parsePlatforms(input: unknown): PlatformsFile {
  const problems: string[] = [];
  const err = (path: string, msg: string) => problems.push(`${path}: ${msg}`);

  if (!isObj(input)) throw new PlatformsError(['root: must be an object']);
  if (input.version !== 1) err('version', 'must be 1');

  const sources: Record<string, SourceInfo> = {};
  if (!isObj(input.sources)) {
    err('sources', 'must be an object');
  } else {
    for (const [key, s] of Object.entries(input.sources)) {
      const p = `sources.${key}`;
      if (!isObj(s)) {
        err(p, 'must be an object');
        continue;
      }
      if (typeof s.title !== 'string' || !s.title) err(`${p}.title`, 'must be a non-empty string');
      if (s.url !== null && typeof s.url !== 'string') err(`${p}.url`, 'must be a string or null');
      if (typeof s.note !== 'string') err(`${p}.note`, 'must be a string');
      sources[key] = s as SourceInfo;
    }
  }

  const placements: PlacementSpec[] = [];
  if (!Array.isArray(input.placements)) {
    err('placements', 'must be an array');
  } else {
    const seen = new Set<string>();
    input.placements.forEach((raw, i) => {
      const before = problems.length;
      const p = `placements[${i}]`;
      if (!isObj(raw)) {
        err(p, 'must be an object');
        return;
      }
      checkPlacement(raw, p, sources, err);
      const key = `${String(raw.platform)}.${String(raw.placement)}`;
      if (seen.has(key)) err(p, `duplicate placement "${key}"`);
      seen.add(key);
      if (problems.length === before) placements.push(raw as PlacementSpec);
    });
  }

  if (problems.length) throw new PlatformsError(problems);
  return { version: 1, sources, placements };
}

function checkPlacement(
  e: Obj,
  p: string,
  sources: Record<string, SourceInfo>,
  err: (path: string, msg: string) => void,
): void {
  if (!PLATFORMS.includes(e.platform as Platform))
    err(`${p}.platform`, `must be one of ${PLATFORMS.join(', ')}`);
  if (typeof e.placement !== 'string' || !/^[a-z0-9-]+$/.test(e.placement))
    err(`${p}.placement`, 'must be a lowercase kebab-case string');
  if (typeof e.label !== 'string' || !e.label) err(`${p}.label`, 'must be a non-empty string');

  if (
    !Array.isArray(e.mediaTypes) ||
    e.mediaTypes.length === 0 ||
    !e.mediaTypes.every((t) => MEDIA_TYPES.includes(t as MediaType))
  )
    err(`${p}.mediaTypes`, `must be a non-empty array of ${MEDIA_TYPES.join(', ')}`);

  if (!Array.isArray(e.sizes) || e.sizes.length === 0) {
    err(`${p}.sizes`, 'must be a non-empty array');
  } else {
    e.sizes.forEach((s: unknown, j) => {
      if (!isObj(s) || !isPosInt(s.width) || !isPosInt(s.height))
        err(`${p}.sizes[${j}]`, 'must have positive integer width and height');
    });
  }

  if (!Array.isArray(e.ratios) || e.ratios.length === 0) {
    err(`${p}.ratios`, 'must be a non-empty array');
  } else {
    e.ratios.forEach((r: unknown, j) => {
      if (typeof r !== 'string' || parseRatio(r) === null)
        err(`${p}.ratios[${j}]`, 'must be a "w:h" string such as "4:5" or "1.91:1"');
    });
  }

  if (e.captionCap !== null && !isPosInt(e.captionCap))
    err(`${p}.captionCap`, 'must be a positive integer or null');
  if (
    !Array.isArray(e.truncation) ||
    !e.truncation.every(
      (t: unknown) =>
        isObj(t) && typeof (t as TruncationPoint).context === 'string' && isPosInt(t.chars),
    )
  )
    err(`${p}.truncation`, 'must be an array of { context: string, chars: positive integer }');
  if (e.hashtagCap !== null && !isPosInt(e.hashtagCap))
    err(`${p}.hashtagCap`, 'must be a positive integer or null');

  if (e.slides !== null) {
    if (!isObj(e.slides) || typeof e.slides.sameRatio !== 'boolean')
      err(`${p}.slides`, 'must be null or { min, max, sameRatio: boolean }');
    else checkRange(e.slides, `${p}.slides`, isPosInt, err);
  }
  if (e.durationSec !== null) {
    if (!isObj(e.durationSec)) err(`${p}.durationSec`, 'must be null or { min, max }');
    else checkRange(e.durationSec, `${p}.durationSec`, isNonNegNum, err);
  }
  if (e.recommendedFps !== null && !isPosInt(e.recommendedFps))
    err(`${p}.recommendedFps`, 'must be a positive integer or null');
  if (e.maxFileBytes !== null && !isPosInt(e.maxFileBytes))
    err(`${p}.maxFileBytes`, 'must be a positive integer or null');
  if (e.maxImages !== null && !isPosInt(e.maxImages))
    err(`${p}.maxImages`, 'must be a positive integer or null');

  for (const k of ['captionLinksClickable', 'hashtagsInCaption'] as const) {
    if (typeof e[k] !== 'boolean') err(`${p}.${k}`, 'must be true or false');
  }

  if (e.safeZone !== null) checkSafeZone(e.safeZone, e.sizes, `${p}.safeZone`, err);

  for (const k of ['sizes', 'limits'] as const) {
    const v = isObj(e.verified) ? e.verified[k] : undefined;
    if (typeof v !== 'string' || !ISO_DATE_RE.test(v) || Number.isNaN(Date.parse(v)))
      err(`${p}.verified.${k}`, 'must be an ISO date (YYYY-MM-DD)');
    const s = isObj(e.sources) ? e.sources[k] : undefined;
    if (typeof s !== 'string' || !(s in sources))
      err(`${p}.sources.${k}`, 'must name a key in the top-level sources');
  }

  for (const k of ['assumptions', 'notes'] as const) {
    const v = e[k];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
      err(`${p}.${k}`, 'must be an array of strings');
  }
}

function checkRange(
  r: Obj,
  p: string,
  isValid: (v: unknown) => boolean,
  err: (path: string, msg: string) => void,
): void {
  const { min, max } = r as Range;
  if (min !== null && !isValid(min)) err(`${p}.min`, 'is not a valid value');
  if (max !== null && !isValid(max)) err(`${p}.max`, 'is not a valid value');
  if (min === null && max === null) err(p, 'must set min, max, or both');
  if (typeof min === 'number' && typeof max === 'number' && min > max)
    err(p, 'min must not exceed max');
}

function checkSafeZone(
  z: unknown,
  sizes: unknown,
  p: string,
  err: (path: string, msg: string) => void,
): void {
  if (!isObj(z)) return err(p, 'must be null or an object');
  const zone = z as SafeZone;
  if (zone.kind === 'centered-area') {
    if (!isPosInt(zone.width) || !isPosInt(zone.height))
      return err(p, 'centered-area needs positive integer width and height');
    if (Array.isArray(sizes))
      (sizes as Size[]).forEach((s, j) => {
        if (isObj(s) && (zone.width > s.width || zone.height > s.height))
          err(p, `safe area is larger than sizes[${j}]`);
      });
  } else if (zone.kind === 'insets') {
    const { top, bottom, left, right } = zone;
    if (![top, bottom, left, right].every((v) => isNonNegNum(v) && v < 1))
      return err(p, 'insets must be fractions in [0, 1)');
    if (top + bottom >= 1 || left + right >= 1) err(p, 'insets leave no safe area');
  } else {
    err(`${p}.kind`, 'must be "centered-area" or "insets"');
  }
}

/** The checked platform data. Throws at import time if platforms.json is invalid. */
export const platforms: PlatformsFile = parsePlatforms(rawPlatforms);

/** Looks up a placement by platform and placement key; undefined if not found. */
export function getPlacement(
  platform: Platform,
  placement: string,
  data: PlatformsFile = platforms,
): PlacementSpec | undefined {
  return data.placements.find((s) => s.platform === platform && s.placement === placement);
}
