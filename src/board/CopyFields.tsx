/**
 * The caption, hashtags, first comment and alt text boxes in the card dialog (SPEC.md, "Caption
 * boxes"), each followed by its Copy button (SPEC.md, "Copy buttons"; CopyButton.tsx).
 *
 * Each box shows a live count and, once a limit or a "…more" cut-off is passed (or, for alt text,
 * while it is missing), the validator's own message for it, all from
 * src/lib/board/copyChecks.ts, so the boxes say exactly what the card's checks will say once the
 * text is written.
 *
 * A Copy button copies its box's current draft, so typing not yet written is copied too. Copying
 * never writes to the store. Pressing it after typing moves focus out of the box first, so the
 * box is written as usual when it is left.
 *
 * Typing changes only this component's draft. The text is written to the card when the person
 * leaves the box: one store change, so one undo step per visit, and none if the text did not
 * change (SPEC.md, "Undo"). It is also written, as that visit's step, when the dialog closes
 * with a box focused, and when the page is hidden (another tab, or the tab or window closing),
 * so typed text is not lost; the visit then carries on from the written text. Ctrl/Cmd-Z inside a
 * box is the browser's own typing undo: the app's undo listeners skip text boxes (src/app/keys.ts).
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { resultTextClass, textFieldClass } from '../app/styles';
import { boxText, copyEdit, copyStatus, parseHashtags } from '../lib/board/copyChecks';
import type { CopyField, CopyStatus } from '../lib/board/copyChecks';
import { RESULT_LABEL } from '../lib/board/view';
import { useSessionStore } from '../store/sessionStore';
import type { Card, Issue, PlacementSpec } from '../types';
import { CopyButton } from './CopyButton';
import {
  ALT_TEXT_HINT,
  COPY_BUTTON_NAME,
  HASHTAG_HINT,
  NO_LIMITS_NOTE,
  STORY_NOTE,
  altTextCountText,
  captionCountText,
  clipboardText,
  firstCommentCountText,
  hashtagCountText,
} from './copyText';

export type CopyFieldsProps = {
  card: Card;
  /** The card's placement; undefined when it is not in platforms.json. */
  spec: PlacementSpec | undefined;
  /** Runs a store change as one of the dialog's undo steps. */
  record: (change: () => void) => void;
};

type Drafts = Record<CopyField, string>;

const BOXES: { field: CopyField; label: string; rows: number; hint?: string }[] = [
  { field: 'caption', label: 'Caption', rows: 6 },
  { field: 'hashtags', label: 'Hashtags', rows: 2, hint: HASHTAG_HINT },
  { field: 'firstComment', label: 'First comment', rows: 3 },
  { field: 'altText', label: 'Alt text', rows: 3, hint: ALT_TEXT_HINT },
];

function draftsOf(copy: Card['copy']): Drafts {
  return {
    caption: boxText(copy, 'caption'),
    hashtags: boxText(copy, 'hashtags'),
    firstComment: boxText(copy, 'firstComment'),
    altText: boxText(copy, 'altText'),
  };
}

/** The count line and the messages for one box. */
function boxStatus(
  field: CopyField,
  status: CopyStatus | null,
): { count: string | null; issues: Issue[] } {
  if (!status) return { count: null, issues: [] };
  if (field === 'caption')
    return { count: captionCountText(status.caption), issues: status.caption.issues };
  if (field === 'hashtags')
    return { count: hashtagCountText(status.hashtags), issues: status.hashtags.issues };
  if (field === 'altText')
    return { count: altTextCountText(status.altText), issues: status.altText.issues };
  return { count: firstCommentCountText(status.firstComment), issues: [] };
}

export function CopyFields({ card, spec, record }: CopyFieldsProps) {
  const baseId = useId();
  const [drafts, setDrafts] = useState(() => draftsOf(card.copy));
  const [focused, setFocused] = useState<CopyField | null>(null);

  // When the card's text changes from outside the boxes (undo, or a write from another box),
  // every box shows it again, except a box being typed in, which keeps its draft.
  const [shownCopy, setShownCopy] = useState(card.copy);
  if (shownCopy !== card.copy) {
    setShownCopy(card.copy);
    const stored = draftsOf(card.copy);
    setDrafts((current) => (focused ? { ...stored, [focused]: current[focused] } : stored));
  }

  // The latest drafts and focus, for the writes made from listeners and the unmount below.
  const draftsRef = useRef(drafts);
  const focusedRef = useRef(focused);
  useLayoutEffect(() => {
    draftsRef.current = drafts;
    focusedRef.current = focused;
  });

  /**
   * Writes one box's text to the card as one undo step, if it changed. The card is read from the
   * store at that moment: if it is gone (the dialog closed because it was removed), nothing is
   * written.
   */
  function write(field: CopyField, text: string) {
    const stored = useSessionStore.getState().session?.cards.find((c) => c.id === card.id);
    if (!stored) return;
    const edit = copyEdit(stored.copy, field, text);
    if (!edit) return;
    record(() => {
      useSessionStore.getState().updateCard(card.id, (draft) => edit(draft.copy));
    });
  }
  const writeRef = useRef(write);
  useLayoutEffect(() => {
    writeRef.current = write;
  });

  /** Writes the box being typed in, if any: when the dialog closes or the page is hidden. */
  function writeFocused() {
    const field = focusedRef.current;
    if (field) writeRef.current(field, draftsRef.current[field]);
  }
  const writeFocusedRef = useRef(writeFocused);
  useLayoutEffect(() => {
    writeFocusedRef.current = writeFocused;
  });

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') writeFocusedRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  // Every way of closing the dialog unmounts this, so a box still focused is written here.
  useEffect(() => () => writeFocusedRef.current(), []);

  function change(field: CopyField, text: string) {
    draftsRef.current = { ...draftsRef.current, [field]: text };
    setDrafts(draftsRef.current);
  }

  function leave(field: CopyField, text: string) {
    focusedRef.current = null;
    setFocused(null);
    write(field, text);
  }

  const status = spec
    ? copyStatus(
        {
          caption: drafts.caption,
          hashtags: parseHashtags(drafts.hashtags),
          firstComment: drafts.firstComment,
          altText: drafts.altText,
        },
        spec,
      )
    : null;

  return (
    <section aria-label="Post text" className="flex flex-col gap-3">
      <h3 className="font-heading font-semibold">Post text</h3>
      {!spec && <p className="text-ink-secondary">{NO_LIMITS_NOTE}</p>}
      {BOXES.map(({ field, label, rows, hint }) => {
        const id = `${baseId}-${field}`;
        const { count, issues } = boxStatus(field, status);
        const countId = `${id}-count`;
        const hintId = `${id}-hint`;
        const messagesId = `${id}-messages`;
        const describedBy = [
          count !== null ? countId : null,
          hint !== undefined ? hintId : null,
          issues.length > 0 ? messagesId : null,
        ].filter((part) => part !== null);
        return (
          <div key={field} className="flex flex-col gap-1">
            <label htmlFor={id} className="font-medium">
              {label}
            </label>
            <textarea
              id={id}
              rows={rows}
              className={`${textFieldClass} w-full resize-y`}
              value={drafts[field]}
              aria-describedby={describedBy.length > 0 ? describedBy.join(' ') : undefined}
              aria-invalid={issues.some((issue) => issue.level === 'fail') || undefined}
              onFocus={() => {
                focusedRef.current = field;
                setFocused(field);
              }}
              onChange={(event) => change(field, event.target.value)}
              onBlur={(event) => leave(field, event.target.value)}
            />
            <div className="flex flex-wrap items-start justify-between gap-2">
              {count !== null ? (
                <p id={countId} className="text-label text-ink-secondary">
                  {count}
                </p>
              ) : (
                <span />
              )}
              <CopyButton
                name={COPY_BUTTON_NAME[field]}
                text={clipboardText(field, drafts[field])}
              />
            </div>
            {hint !== undefined && (
              <p id={hintId} className="text-label text-ink-secondary">
                {hint}
              </p>
            )}
            {issues.length > 0 && (
              <ul id={messagesId} className="flex flex-col gap-1">
                {issues.map((issue, index) => (
                  <li key={index} className={resultTextClass[issue.level]}>
                    <span className="font-medium">{RESULT_LABEL[issue.level]}:</span>{' '}
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {spec?.canBeStory && <p className="text-ink-secondary">{STORY_NOTE}</p>}
    </section>
  );
}
