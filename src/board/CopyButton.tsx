/**
 * A Copy button beside one of the card dialog's text boxes (SPEC.md, "Copy buttons").
 *
 * It puts `text` on the clipboard: the box's current contents as clipboardText() gives them, so
 * text not yet written to the card is copied too. Copying never touches the store, so it never
 * changes the card and never adds an undo step. The button is never disabled.
 *
 * A status message beside it says how it went: "Copied." for about two seconds; the failure
 * message until the next attempt; and, when `text` is empty, "Nothing to copy yet." with the
 * clipboard left as it was. The status element is always in the page, so screen readers hear
 * each new message; it is emptied at the start of each attempt, so a second "Copied." in a row
 * is announced again.
 */

import { useEffect, useRef, useState } from 'react';

import { buttonClass, resultTextClass } from '../app/styles';
import { COPIED, COPIED_MS, COPY_FAILED, NOTHING_TO_COPY } from './copyText';

export type CopyButtonProps = {
  /** The accessible name, e.g. "Copy caption". */
  name: string;
  /** What to put on the clipboard; "" means there is nothing to copy. */
  text: string;
};

type Message = typeof COPIED | typeof COPY_FAILED | typeof NOTHING_TO_COPY | '';

export function CopyButton({ name, text }: CopyButtonProps) {
  const [message, setMessage] = useState<Message>('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Counts attempts, so a slow clipboard answer from an earlier press cannot overwrite a newer
  // one. Going away counts as a new attempt too, so a late answer then starts no timer.
  const attempt = useRef(0);

  useEffect(
    () => () => {
      attempt.current += 1;
      clearTimeout(timer.current);
    },
    [],
  );

  function copy() {
    const current = ++attempt.current;
    clearTimeout(timer.current);
    if (text === '') {
      setMessage(NOTHING_TO_COPY);
      return;
    }
    setMessage('');
    // Wrapped so that a missing clipboard (navigator.clipboard undefined) is a failure too.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => {
          if (current !== attempt.current) return;
          setMessage(COPIED);
          timer.current = setTimeout(() => setMessage(''), COPIED_MS);
        },
        () => {
          if (current !== attempt.current) return;
          setMessage(COPY_FAILED);
        },
      );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span
        role="status"
        className={`text-label ${message === COPY_FAILED ? resultTextClass.fail : 'text-ink-secondary'}`}
      >
        {message}
      </span>
      <button type="button" className={buttonClass} aria-label={name} onClick={copy}>
        Copy
      </button>
    </div>
  );
}
