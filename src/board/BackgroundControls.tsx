/**
 * The background colour of one card, in the card details: the browser's colour picker and a
 * text box with the hex code. The colour fills any space where the card's crop goes past the
 * photo's edges (SPEC.md, "Fit whole photo and background colour").
 *
 * What it writes, and when. Every write is one `updateCard`, one undo step, recorded in the card
 * dialog's undo, and marks the card changed, so the board renders and checks it again.
 * - The picker shows each colour as it is tried, through `onPreview`, so the editor can draw it,
 *   and writes once, on the picker's own `change` event, which the browser sends when the
 *   picker is closed on a new colour. A picker closed with no change writes nothing, and the
 *   preview is taken back: on the picker's `cancel` event, when the picker loses focus, and
 *   when this control goes away.
 * - The text box writes on Enter and when it loses focus, if what was typed is a colour and it
 *   differs from the card's. Anything else is not written: Enter leaves the text in place with
 *   a message, and losing focus puts the card's colour back in the box.
 *
 * Ctrl/Cmd-Z. The picker holds no text, so Ctrl/Cmd-Z there undoes the last change in the
 * dialog (see src/app/keys.ts). In the text box it undoes typing, as in any text field.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { backgroundOf } from '../lib/render/background';
import { useSessionStore } from '../store/sessionStore';
import { focusClass } from '../app/styles';
import {
  BACKGROUND_LEGEND,
  BACKGROUND_NOTE,
  HEX_LABEL,
  PICKER_NAME,
  invalidHexMessage,
  parseHexInput,
} from './backgroundColour';

export type BackgroundControlsProps = {
  cardId: string;
  /** The card's colour as it is drawn: "#rrggbb", white for a card with none. */
  background: string;
  /** Runs each change; the card dialog passes its undo's `record`. */
  record: (change: () => void) => void;
  /** The colour being tried in the picker, or null when the card's own colour shows again. */
  onPreview?: (colour: string | null) => void;
};

/** The card's colour as it is in the store now. */
function storedBackground(cardId: string): string | undefined {
  const card = useSessionStore.getState().session?.cards.find((c) => c.id === cardId);
  return card ? backgroundOf(card) : undefined;
}

export function BackgroundControls({
  cardId,
  background,
  record,
  onPreview,
}: BackgroundControlsProps) {
  const hexId = useId();
  const messageId = useId();
  /** The colour being tried in the picker; null when it shows the card's colour. */
  const [trying, setTrying] = useState<string | null>(null);
  /** What is typed in the hex box; null when it shows the card's colour. */
  const [typed, setTyped] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const picker = useRef<HTMLInputElement>(null);

  function preview(colour: string | null) {
    setTrying(colour);
    onPreview?.(colour);
  }

  /** Writes a colour to the card as one step; nothing when it is the colour it has. */
  function write(colour: string) {
    if (colour === storedBackground(cardId)) return;
    record(() => {
      useSessionStore.getState().updateCard(cardId, (draft) => {
        draft.background = colour;
      });
    });
  }

  // The latest of each, for the listeners below, which are set up once.
  const latest = useRef({ write, preview });
  useLayoutEffect(() => {
    latest.current = { write, preview };
  });

  // React's onChange on a colour input is the `input` event, which the browser sends for every
  // colour tried. The picker being closed is the element's own `change` (a new colour) or
  // `cancel` (no change) event, so those are listened for directly.
  useEffect(() => {
    const element = picker.current as HTMLInputElement;
    const onChange = () => {
      const colour = element.value;
      latest.current.preview(null);
      latest.current.write(colour);
    };
    const onCancel = () => latest.current.preview(null);
    element.addEventListener('change', onChange);
    element.addEventListener('cancel', onCancel);
    return () => {
      element.removeEventListener('change', onChange);
      element.removeEventListener('cancel', onCancel);
      latest.current.preview(null);
    };
  }, []);

  /** Applies what is typed in the hex box. `leaving` is true when the box is losing focus. */
  function apply(leaving: boolean) {
    if (typed === null) return;
    const colour = parseHexInput(typed);
    if (colour === null) {
      setMessage(invalidHexMessage(background));
      // Left in place after Enter, to be corrected; put back when the box is left.
      if (leaving) setTyped(null);
      return;
    }
    setMessage('');
    setTyped(null);
    write(colour);
  }

  function onHexKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    // Enter applies the colour; it must not also press anything else in the dialog.
    event.preventDefault();
    apply(false);
  }

  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="font-heading font-semibold">{BACKGROUND_LEGEND}</legend>
      <p className="text-ink-secondary">{BACKGROUND_NOTE}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <input
          ref={picker}
          type="color"
          aria-label={PICKER_NAME}
          value={trying ?? background}
          className={`h-11 w-11 cursor-pointer rounded-control border border-muted bg-surface p-1 ${focusClass}`}
          onChange={(event) => preview(event.target.value)}
          onBlur={() => preview(null)}
        />
        <label htmlFor={hexId} className="flex items-center gap-2">
          <span className="text-label text-muted-text">{HEX_LABEL}</span>
          <input
            id={hexId}
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={16}
            value={typed ?? background}
            aria-invalid={message !== ''}
            aria-describedby={messageId}
            className={`h-11 w-28 rounded-control border border-muted bg-surface px-2 font-mono text-ink ${focusClass}`}
            onChange={(event) => {
              setTyped(event.target.value);
              setMessage('');
            }}
            onKeyDown={onHexKeyDown}
            onBlur={() => apply(true)}
          />
        </label>
      </div>
      {/* Always there, two lines high, so a message appearing moves nothing in the dialog. */}
      <p id={messageId} aria-live="polite" className="min-h-8 text-label text-red-700">
        {message}
      </p>
    </fieldset>
  );
}
