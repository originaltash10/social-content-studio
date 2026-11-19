/**
 * Names for exported files. SPEC.md (Phase 1, step 8) sets the scheme:
 *
 *   {session}_{platform}_{placement}_{cardId}.{ext}
 *
 * Each file goes in a folder named after its platform, inside the session's exports/ folder or
 * at the top of the export zip, beside captions.csv:
 *
 *   instagram/Topping-out_instagram_feed-vertical_<card id>.jpg
 *   linkedin/Topping-out_linkedin_image-square_<card id>.jpg
 *   captions.csv
 *
 * Every part of a name is reduced to letters, digits and "-", so "_" only ever separates the
 * parts, and a name is safe on Windows, macOS and Linux. No platform number is written here.
 */

import type { Platform } from '../../types';
import type { OutputFormat } from '../render/plan';

/** The captions file written beside the platform folders. */
export const CAPTIONS_FILE = 'captions.csv';

/** The longest the session part of a file name can be, in characters. */
export const MAX_SESSION_PART = 40;

/** Used when a session name has no letters or digits that can be kept. */
export const FALLBACK_SESSION_PART = 'session';

/** Two exported files would have the same name. The message is written for the user. */
export class ExportNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportNameError';
  }
}

/**
 * Reduces text to letters, digits and "-": accents are dropped ("é" becomes "e"), and every run
 * of anything else (spaces, "_", "/", ":", emoji, ...) becomes a single "-". No "-" is left at
 * either end.
 */
export function safePart(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The session part of a file name: `safePart`, cut to MAX_SESSION_PART, never empty. */
export function sessionPart(sessionName: string): string {
  const safe = safePart(sessionName).slice(0, MAX_SESSION_PART).replace(/-+$/, '');
  return safe || FALLBACK_SESSION_PART;
}

export type FileNameParts = {
  sessionName: string;
  platform: Platform;
  /** The placement's key in platforms.json, e.g. "feed-vertical". */
  placement: string;
  cardId: string;
  /** The format of the file that was actually made. */
  format: OutputFormat;
};

/** A file's name, e.g. "Topping-out_instagram_feed-vertical_<card id>.jpg". */
export function exportFileName(parts: FileNameParts): string {
  return [
    sessionPart(parts.sessionName),
    parts.platform,
    safePart(parts.placement),
    safePart(parts.cardId),
  ]
    .join('_')
    .concat('.', parts.format);
}

/** Where a file goes, relative to exports/ or the top of the zip: "{platform}/{file name}". */
export function exportPath(parts: FileNameParts): string {
  return `${parts.platform}/${exportFileName(parts)}`;
}

/** The download name of an export zip, e.g. "Topping-out_export.zip". */
export function zipFileName(sessionName: string): string {
  return `${sessionPart(sessionName)}_export.zip`;
}

/**
 * Throws an ExportNameError if two paths are the same, ignoring case: Windows and macOS treat
 * "A.jpg" and "a.jpg" as one file, so the second would replace the first. Card ids are unique,
 * so this should never happen; it is checked so that a file can never be silently overwritten.
 */
export function assertUniquePaths(paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    if (seen.has(key)) {
      throw new ExportNameError(
        `Two cards would both be saved as "${path}", so nothing was exported.`,
      );
    }
    seen.add(key);
  }
}
