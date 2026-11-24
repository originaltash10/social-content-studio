/**
 * The words around the caption, hashtags, first comment and alt text boxes in the card dialog,
 * and the text each Copy button puts on the clipboard. The numbers come from
 * src/lib/board/copyChecks.ts; this file only says them.
 *
 * Numbers are always written the en-US way ("2,200"), whatever the browser's language, so the
 * text and its tests do not change from one computer to the next.
 */

import { parseHashtags } from '../lib/board/copyChecks';
import type { CopyField } from '../lib/board/copyChecks';
import { hashtagCell } from '../lib/export/captionsCsv';

const NUMBER = new Intl.NumberFormat('en-US');

/** A number as the boxes show it, e.g. 2,200. */
export function formatCount(n: number): string {
  return NUMBER.format(n);
}

/** "1 character" or "120 characters", and the same for other words. */
function amount(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** "120 of 2,200", or just "120" where there is no limit. */
function ofCap(n: number, cap: number | null, one: string, many: string): string {
  return cap === null ? amount(n, one, many) : `${formatCount(n)} of ${amount(cap, one, many)}`;
}

/** The caption count, e.g. "120 of 2,200 characters" or "250 of 3,000 characters, including hashtags". */
export function captionCountText(status: {
  count: number;
  cap: number | null;
  includesHashtags: boolean;
}): string {
  const base = ofCap(status.count, status.cap, 'character', 'characters');
  return status.includesHashtags ? `${base}, including hashtags` : base;
}

/** The hashtag count, e.g. "4 of 30 hashtags", or "4 hashtags" where there is no limit. */
export function hashtagCountText(status: { count: number; cap: number | null }): string {
  return ofCap(status.count, status.cap, 'hashtag', 'hashtags');
}

/** The first comment count. No placement sets a limit for it. */
export function firstCommentCountText(status: { count: number }): string {
  return amount(status.count, 'character', 'characters');
}

/** The alt text count. No placement sets a limit for it. */
export function altTextCountText(status: { count: number }): string {
  return amount(status.count, 'character', 'characters');
}

/** Under the alt text box. */
export const ALT_TEXT_HINT = 'Describe the picture for people who use screen readers.';

/** Under the hashtags box. */
export const HASHTAG_HINT =
  'Separate tags with spaces, commas or line breaks. Hashtags in the caption count too.';

/** Under the boxes on a placement that can be a Story (SPEC.md, "Caption boxes"). */
export const STORY_NOTE =
  "Reels show this caption. Stories don't show captions, hashtags or a first comment.";

/** In place of the counts, for a card whose placement is not in platforms.json. */
export const NO_LIMITS_NOTE =
  "This card's placement is not in the platform list, so its text limits are not known.";

// Copy buttons (SPEC.md, "Copy buttons") -----------------------------------------------------

/** Each Copy button's accessible name. Its visible text is just "Copy". */
export const COPY_BUTTON_NAME: Record<CopyField, string> = {
  caption: 'Copy caption',
  hashtags: 'Copy hashtags',
  firstComment: 'Copy first comment',
  altText: 'Copy alt text',
};

export const COPIED = 'Copied.';
export const COPY_FAILED = "Couldn't copy. Select the text and press Ctrl+C.";
export const NOTHING_TO_COPY = 'Nothing to copy yet.';

/** How long "Copied." stays next to the button. */
export const COPIED_MS = 2000;

/**
 * What a Copy button puts on the clipboard for the text in its box, or "" when there is nothing
 * to copy. The caption, first comment and alt text are copied exactly as typed, unless they hold
 * only spaces and line breaks. Hashtags are copied as captions.csv writes them, by the export's
 * own function: each tag with "#" added where missing, separated by single spaces. A box of only
 * spaces, or only bare "#" marks, leaves no tag, so nothing to copy.
 */
export function clipboardText(field: CopyField, text: string): string {
  if (field === 'hashtags') return hashtagCell(parseHashtags(text));
  return text.trim() === '' ? '' : text;
}
