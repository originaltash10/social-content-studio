/** The wording and the controls of the campaign brief panel (SPEC.md, "Campaign brief panel"). */

import type { Brief } from '../types';

export const BRIEF_HEADING = 'Campaign brief';
export const BRIEF_HINT = 'Optional. Saved with the session; not exported.';
export const TONE_LEGEND = 'Tone';

/** The brief's four pieces of text. */
export type BriefTextField = 'topic' | 'audience' | 'cta' | 'link';

/** The four text boxes, in Tab order. `multiline` boxes take line breaks. */
export const BRIEF_BOXES: readonly { field: BriefTextField; label: string; multiline: boolean }[] =
  [
    { field: 'topic', label: 'Topic', multiline: true },
    { field: 'audience', label: 'Audience', multiline: true },
    { field: 'cta', label: 'Call to action', multiline: false },
    { field: 'link', label: 'Link', multiline: false },
  ];

/** The three tones, in the order shown. */
export const TONE_CHOICES: readonly { value: Brief['tone']; label: string }[] = [
  { value: 'formal', label: 'Formal' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'casual', label: 'Casual' },
];

/** What a box shows for a brief: the text as stored, and nothing for a brief with no link. */
export function briefBoxText(brief: Brief, field: BriefTextField): string {
  return field === 'link' ? (brief.link ?? '') : brief[field];
}
