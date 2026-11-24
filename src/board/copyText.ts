/**
 * The words under the caption, hashtags and first comment boxes in the card dialog. The numbers
 * come from src/lib/board/copyChecks.ts; this file only says them.
 *
 * Numbers are always written the en-US way ("2,200"), whatever the browser's language, so the
 * text and its tests do not change from one computer to the next.
 */

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

/** Under the hashtags box. */
export const HASHTAG_HINT =
  'Separate tags with spaces, commas or line breaks. Hashtags in the caption count too.';

/** Under the boxes on a placement that can be a Story (SPEC.md, "Caption boxes"). */
export const STORY_NOTE =
  "Reels show this caption. Stories don't show captions, hashtags or a first comment.";

/** In place of the counts, for a card whose placement is not in platforms.json. */
export const NO_LIMITS_NOTE =
  "This card's placement is not in the platform list, so its text limits are not known.";
