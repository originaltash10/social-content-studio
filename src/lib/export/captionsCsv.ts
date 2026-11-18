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

import type { Card, ValidationLevel } from '../../types';

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
  card: Pick<Card, 'platform' | 'placement' | 'copy' | 'overrideFail'>;
  /** The result of checking the exported file. */
  result: ValidationLevel;
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

/** The result in words. A failing file is only exported when the card is overridden. */
export function resultCell(result: ValidationLevel, overrideFail: boolean): string {
  if (result === 'pass') return 'Pass';
  if (result === 'warn') return 'Warning';
  return overrideFail ? 'Fail, exported with override' : 'Fail';
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
          resultCell(result, card.overrideFail),
        ]),
      )
      .join('')
  );
}
