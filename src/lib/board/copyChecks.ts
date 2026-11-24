/**
 * The counts and messages under a card's caption, hashtags and first comment boxes, and the
 * change leaving one of those boxes makes to the card (SPEC.md, "Caption boxes", "Who wrote each
 * piece of text" and "Undo").
 *
 * Nothing here counts on its own: the numbers come from the helpers `validate()` itself uses,
 * and the messages are `validate()`'s own rule 4, 5 and 9 issues for the same text, so a box
 * always says exactly what the card's checks will say once the text is written. Every limit comes
 * from the placement in src/data/platforms.json.
 */

import { charCount, collectHashtags, postedCaption, validate } from '../validate';
import type { ValidationInput } from '../validate';
import type { Card, Issue, PlacementSpec } from '../../types';

export type CopyField = 'caption' | 'hashtags' | 'firstComment';

/** The text of the three boxes, with the hashtags as the list the card stores. */
export type CopyText = { caption: string; hashtags: string[]; firstComment: string };

/**
 * The tags in the hashtags box: split on spaces, commas and line breaks, with empty entries
 * dropped. Order and duplicates are kept, and each tag is kept as typed, with or without "#":
 * the validator, the session file and captions.csv all accept both.
 */
export function parseHashtags(text: string): string[] {
  return text.split(/[\s,]+/u).filter((tag) => tag !== '');
}

/** The text a box shows for the card's stored copy. Hashtags are shown separated by spaces. */
export function boxText(copy: Card['copy'], field: CopyField): string {
  return field === 'hashtags' ? copy.hashtags.join(' ') : copy[field];
}

/** True when two tag lists hold the same tags in the same order. */
export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

export type CopyStatus = {
  /** `count` is what rule 4 measures; `includesHashtags` when that is caption plus hashtags. */
  caption: { count: number; cap: number | null; includesHashtags: boolean; issues: Issue[] };
  /** `count` is what rule 5 counts: the hashtag field and any #tags in the caption. */
  hashtags: { count: number; cap: number | null; issues: Issue[] };
  /** No placement sets a first comment limit, so there is only a count. */
  firstComment: { count: number };
};

/**
 * What each box shows for this text on this placement. The caption box gets the rule 4 issues
 * (over the cap, or past a "…more" cut-off) and rule 9 (a link that is not clickable); the
 * hashtags box gets rule 5. Only the text is passed to the validator, and only those rules are
 * kept, so the other rules (which need the rendered file) play no part.
 */
export function copyStatus(text: CopyText, spec: PlacementSpec): CopyStatus {
  const input: ValidationInput = {
    kind: 'image',
    frames: [],
    caption: text.caption,
    hashtags: text.hashtags,
  };
  const { issues } = validate(input, spec);
  const byRule = (...rules: Issue['rule'][]) => issues.filter((i) => rules.includes(i.rule));
  return {
    caption: {
      count: charCount(postedCaption(input, spec)),
      cap: spec.captionCap,
      includesHashtags: spec.hashtagsInCaption,
      issues: byRule(4, 9),
    },
    hashtags: {
      count: collectHashtags(text.caption, text.hashtags).length,
      cap: spec.hashtagCap,
      issues: byRule(5),
    },
    firstComment: { count: charCount(text.firstComment) },
  };
}

/**
 * The change that leaving a box with this text makes to the card's copy, or null when there is
 * nothing to write. Text that matches what the box shows for the stored copy is no change. For
 * hashtags, the parsed list is compared with the stored list, so reformatting alone (commas
 * becoming spaces) is no change either. A change also removes `authoredBy`, since a person has
 * now edited the text.
 */
export function copyEdit(
  copy: Card['copy'],
  field: CopyField,
  text: string,
): ((draft: Card['copy']) => void) | null {
  if (text === boxText(copy, field)) return null;
  if (field === 'hashtags') {
    const tags = parseHashtags(text);
    if (sameTags(tags, copy.hashtags)) return null;
    return (draft) => {
      draft.hashtags = tags;
      delete draft.authoredBy;
    };
  }
  return (draft) => {
    draft[field] = text;
    delete draft.authoredBy;
  };
}
