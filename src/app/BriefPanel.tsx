/**
 * The campaign brief panel (SPEC.md, "Campaign brief panel"): topic, audience, call to action,
 * link and tone for the open session. It is shown only while a session is open.
 *
 * What it writes, and when. Every write is one `setBrief`: it marks the session as changed, so
 * it is saved like any other change, and it is never an undo step.
 * - Typing changes only the box. The text is written when the person leaves the box: one store
 *   change per visit, and none if the text did not change. A box still being typed in is also
 *   written when the page is hidden (another tab, or the tab or window closing).
 * - The tone is written as soon as it is chosen.
 * - Text is stored exactly as typed. The store leaves out a link that is empty or only spaces.
 *
 * Text is never written to any session but the one it was typed for. The boxes belong to one
 * opening of a session, which the store counts (`opening`: it goes up on New session, on opening
 * a folder or loading a .scs, and on Clear, and on nothing else). The session's id is not enough
 * for this: clearing a session and opening it again gives the same id. When a new opening starts
 * the boxes are made again from the new session's brief, so typing not yet written is dropped,
 * and every write first checks that its opening is still the current one. Unlike the caption
 * boxes, nothing is written when the boxes go away, because here they only go away when their
 * session does.
 *
 * Ctrl/Cmd-Z inside a box is the browser's own typing undo, and on a tone radio button it is the
 * app's undo of the last card change: see src/app/keys.ts. Neither changes the stored brief.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { useSessionStore } from '../store/sessionStore';
import type { Brief } from '../types';
import {
  BRIEF_BOXES,
  BRIEF_HEADING,
  BRIEF_HINT,
  TONE_CHOICES,
  TONE_LEGEND,
  briefBoxText,
} from './briefText';
import type { BriefTextField } from './briefText';
import { focusClass, textFieldClass } from './styles';

type Drafts = Record<BriefTextField, string>;

function draftsOf(brief: Brief): Drafts {
  return {
    topic: briefBoxText(brief, 'topic'),
    audience: briefBoxText(brief, 'audience'),
    cta: briefBoxText(brief, 'cta'),
    link: briefBoxText(brief, 'link'),
  };
}

export function BriefPanel() {
  const brief = useSessionStore((state) => state.session?.brief);
  const opening = useSessionStore((state) => state.opening);
  if (!brief) return null;
  // The key makes the boxes again for each opening, from that session's brief.
  return <BriefFields key={opening} brief={brief} opening={opening} />;
}

type BriefFieldsProps = {
  /** The open session's brief, as stored. */
  brief: Brief;
  /** The opening of the session these boxes were made for. */
  opening: number;
};

function BriefFields({ brief, opening }: BriefFieldsProps) {
  const baseId = useId();
  const [drafts, setDrafts] = useState(() => draftsOf(brief));
  const [focused, setFocused] = useState<BriefTextField | null>(null);

  // When the stored brief changes (a write from another box, or the tone), every box shows it
  // again, except a box being typed in, which keeps its draft.
  const [shownBrief, setShownBrief] = useState(brief);
  if (shownBrief !== brief) {
    setShownBrief(brief);
    const stored = draftsOf(brief);
    setDrafts((current) => (focused ? { ...stored, [focused]: current[focused] } : stored));
  }

  // The latest drafts and focus, for the write made when the page is hidden.
  const draftsRef = useRef(drafts);
  const focusedRef = useRef(focused);
  useLayoutEffect(() => {
    draftsRef.current = drafts;
    focusedRef.current = focused;
  });

  /** The stored brief, if the session these boxes were made for is still the open one. */
  function ownBrief(): Brief | null {
    const state = useSessionStore.getState();
    return state.opening === opening ? (state.session?.brief ?? null) : null;
  }

  /** Writes one box's text, if it changed and its session is still the open one. */
  function write(field: BriefTextField, text: string) {
    const stored = ownBrief();
    if (!stored || text === briefBoxText(stored, field)) return;
    useSessionStore.getState().setBrief({ ...stored, [field]: text });
  }
  const writeRef = useRef(write);
  useLayoutEffect(() => {
    writeRef.current = write;
  });

  useEffect(() => {
    const onVisibility = () => {
      const field = focusedRef.current;
      if (document.visibilityState === 'hidden' && field) {
        writeRef.current(field, draftsRef.current[field]);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  function change(field: BriefTextField, text: string) {
    draftsRef.current = { ...draftsRef.current, [field]: text };
    setDrafts(draftsRef.current);
  }

  function leave(field: BriefTextField, text: string) {
    focusedRef.current = null;
    setFocused(null);
    write(field, text);
    // The box then shows what is stored: the same text, or nothing for a link of only spaces.
    const stored = ownBrief();
    if (stored) change(field, briefBoxText(stored, field));
  }

  function chooseTone(tone: Brief['tone']) {
    const stored = ownBrief();
    if (!stored || stored.tone === tone) return;
    useSessionStore.getState().setBrief({ ...stored, tone });
  }

  const headingId = `${baseId}-heading`;
  const hintId = `${baseId}-hint`;

  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={hintId}
      className="flex flex-col gap-4 rounded-card bg-surface p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="font-heading text-lg font-semibold">
          {BRIEF_HEADING}
        </h2>
        <p id={hintId} className="text-ink-secondary">
          {BRIEF_HINT}
        </p>
      </div>

      {BRIEF_BOXES.map(({ field, label, multiline }) => {
        const id = `${baseId}-${field}`;
        const box = {
          id,
          value: drafts[field],
          onFocus: () => {
            focusedRef.current = field;
            setFocused(field);
          },
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) =>
            change(field, event.target.value),
          onBlur: (event: React.FocusEvent<HTMLTextAreaElement | HTMLInputElement>) =>
            leave(field, event.target.value),
        };
        return (
          <div key={field} className="flex flex-col gap-1">
            <label htmlFor={id} className="font-medium">
              {label}
            </label>
            {multiline ? (
              <textarea rows={2} className={`${textFieldClass} w-full resize-y`} {...box} />
            ) : (
              <input
                type="text"
                className={`${textFieldClass} w-full`}
                // The link is not checked or corrected: it is kept exactly as typed.
                spellCheck={field === 'link' ? false : undefined}
                {...box}
              />
            )}
          </div>
        );
      })}

      <fieldset className="flex flex-col gap-1">
        <legend className="font-medium">{TONE_LEGEND}</legend>
        <div className="flex flex-wrap gap-x-6">
          {TONE_CHOICES.map((choice) => (
            <label key={choice.value} className="flex min-h-11 min-w-11 items-center gap-2">
              <input
                type="radio"
                name={`${baseId}-tone`}
                value={choice.value}
                className={`h-5 w-5 accent-accent ${focusClass}`}
                checked={brief.tone === choice.value}
                onChange={() => chooseTone(choice.value)}
              />
              {choice.label}
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
