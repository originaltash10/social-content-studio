/**
 * captions.csv: one row per exported file, written beside the platform folders (SPEC.md:
 * "per-platform folders with named files, captions.csv, alt text, hashtags").
 *
 * Format: UTF-8 with a byte order mark (so spreadsheet apps read accents and emoji correctly),
 * a header row, every field in double quotes, quotes inside a field doubled, rows ending in
 * CRLF (RFC 4180). Text is written exactly as it is on the card: commas, quotes, line breaks,
 * emoji and leading "=", "+", "-" or "@" are kept, nothing is added or escaped beyond the CSV
 * quoting itself.
 *
 * Every column comes from a field the card already has (empty while it is not filled in yet),
 * apart from the file path, which is the exported file's own, and the result, which is the
 * check made on that file at export time.
 */

import type { Card } from '../../types';
import type { ExportedResult } from './eligibility';

/** The column names, in order. */
export const CAPTION_COLUMNS = [
  'file',
  'platform',
  'placement',
  'caption',
  'hashtags',
  'first_comment',
  'alt_text',
  'result',
] as const;

export const CSV_MIME = 'text/csv;charset=utf-8';

const BOM = '﻿';
const CRLF = '\r\n';

export type CaptionRow = {
  /** The exported file, relative to exports/ or the top of the zip, e.g. "instagram/x.jpg". */
  path: string;
  card: Pick<Card, 'platform' | 'placement' | 'copy'>;
  /**
   * The result of checking the exported file. A file that fails without an override is never
   * exported, so there is no row, and no wording, for it.
   */
  result: ExportedResult;
};

/**
 * The hashtag field as one cell: the tags in order, separated by spaces, each with a leading
 * "#". This is how validate.ts builds the posted caption: a tag is trimmed, gets a "#" only if
 * it does not already start with one, and a tag with nothing but "#" or spaces is left out.
 */
export function hashtagCell(hashtags: readonly string[]): string {
  return hashtags
    .map((tag) => tag.trim())
    .filter((tag) => tag.replace(/^#+/, ''))
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`))
    .join(' ');
}

const RESULT_TEXT: Record<ExportedResult, string> = {
  pass: 'Pass',
  warn: 'Warning',
  override: 'Fail, exported with override',
};

/** The result in words. */
export function resultCell(result: ExportedResult): string {
  return RESULT_TEXT[result];
}

/** One field in double quotes, with any double quote inside it doubled. */
export function quote(field: string): string {
  return `"${field.replaceAll('"', '""')}"`;
}

function line(fields: readonly string[]): string {
  return fields.map(quote).join(',') + CRLF;
}

/** The whole file as text, starting with the byte order mark. Encode it as UTF-8. */
export function captionsCsv(rows: readonly CaptionRow[]): string {
  return (
    BOM +
    line(CAPTION_COLUMNS) +
    rows
      .map(({ path, card, result }) =>
        line([
          path,
          card.platform,
          card.placement,
          card.copy.caption,
          hashtagCell(card.copy.hashtags),
          card.copy.firstComment,
          card.copy.altText,
          resultCell(result),
        ]),
      )
      .join('')
  );
}
