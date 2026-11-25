/**
 * The Settings button and its dialog: the AI provider choice and its key (SPEC.md, "AI").
 *
 * - The button is the page's first control, with or without a session. Settings is not part of
 *   a session: nothing here reads or writes the session store, and New session and Clear never
 *   touch it.
 * - The dialog follows the card dialog: it opens with focus on its heading, the page behind it
 *   does not scroll (src/board/scrollLock.ts), Escape and Close close it, and focus goes back to
 *   the Settings button.
 * - The key box is not tied to React state: its text is read only when Save key is pressed, and
 *   the box is emptied as soon as the key is saved. A saved key is never shown again. Text typed
 *   and not saved goes when the dialog closes, because the box is only there while it is open.
 * - Buttons are never disabled; each answers with a message (src/settings/messages.ts). Every
 *   message is the app's own: the provider's text never reaches this file.
 * - Opening Settings reads only this browser's own storage. Test connection is the only thing
 *   that contacts the provider. Closing Settings cancels a test that is still running, and its
 *   result is dropped.
 * - Escape and Ctrl/Cmd-Z pressed inside Settings stop here, so no other key handler on the page
 *   sees them: Escape closes Settings only, and Ctrl/Cmd-Z never undoes a change to the session.
 *   In the key box, Ctrl/Cmd-Z is still the browser's typing undo.
 * - There is no <form>: Enter in the key box runs Save key.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { testAnthropicConnection } from '../ai/anthropic';
import { buttonClass, focusClass, primaryButtonClass, textFieldClass } from '../app/styles';
import { lockPageScroll } from '../board/scrollLock';
import { chooseProvider, chosenProvider, hasKey, removeKey, saveKey, trimKey } from './keyStore';
import {
  ACTION_MESSAGES,
  KEY_STATE,
  SETTINGS_TEXT,
  chosenMessage,
  connectionMessage,
  keyLabel,
  testNote,
} from './messages';
import { PROVIDERS, findProvider, type ProviderId } from './providers';

/** Ctrl/Cmd-Z, with or without Shift: the app's undo and redo keys. */
const isUndoKey = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z';

export function Settings() {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<ProviderId | null>(null);
  /** Whether the chosen provider has a key saved; null until it has been read. */
  const [keySaved, setKeySaved] = useState<boolean | null>(null);
  const [status, setStatus] = useState('');

  const button = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const keyBox = useRef<HTMLInputElement>(null);
  const unlockScroll = useRef<(() => void) | null>(null);
  /** Counts each opening and closing: work started for an earlier opening is dropped. */
  const opening = useRef(0);
  /** The Test connection running now, so that closing, Save key or Remove key can cancel it. */
  const test = useRef<AbortController | null>(null);

  const ids = useId();
  const headingId = `${ids}-heading`;
  const keyBoxId = `${ids}-key`;
  const hintId = `${ids}-hint`;
  const noteId = `${ids}-note`;
  const provider = findProvider(chosen);

  // Show the dialog once it is to be open. Under StrictMode this runs twice; the second time the
  // dialog is already open and nothing happens.
  useEffect(() => {
    const element = dialog.current;
    if (!open || !element || element.open) return;
    element.showModal();
    unlockScroll.current = lockPageScroll();
    // Start at the heading, so Tab goes through the dialog from the top.
    heading.current?.focus({ preventScroll: true });
    element.scrollTop = 0;
  }, [open]);

  // Escape and Ctrl/Cmd-Z stop at the dialog, on the way to the window. Escape still closes the
  // dialog (its default action is left alone), and in the key box Ctrl/Cmd-Z still undoes typing.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' || isUndoKey(event)) event.stopPropagation();
    }
    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, []);

  // If Settings goes away while open, nothing it started may carry on.
  useEffect(
    () => () => {
      opening.current++;
      test.current?.abort();
      unlockScroll.current?.();
    },
    [],
  );

  /** Cancels a running Test connection; its result is dropped. */
  function cancelTest() {
    test.current?.abort();
    test.current = null;
  }

  async function onOpen() {
    const current = ++opening.current;
    setStatus('');
    setChosen(null);
    setKeySaved(null);
    setOpen(true);
    try {
      const id = await chosenProvider();
      const saved = id === null ? false : await hasKey(id);
      if (current !== opening.current) return;
      setChosen(id);
      setKeySaved(saved);
    } catch {
      if (current === opening.current) setStatus(ACTION_MESSAGES.readFailed);
    }
  }

  // Every way of closing ends here: Escape and Close.
  function onClose() {
    opening.current++;
    cancelTest();
    setOpen(false);
    setStatus('');
    unlockScroll.current?.();
    unlockScroll.current = null;
    // Without scrolling: the page is already where it was.
    button.current?.focus({ preventScroll: true });
  }

  async function onChoose(id: ProviderId) {
    const current = opening.current;
    const before = chosen;
    cancelTest();
    setChosen(id);
    setKeySaved(null);
    try {
      await chooseProvider(id);
      const saved = await hasKey(id);
      if (current !== opening.current) return;
      setKeySaved(saved);
      setStatus(chosenMessage(findProvider(id)?.name ?? id));
    } catch {
      if (current !== opening.current) return;
      setChosen(before);
      setStatus(ACTION_MESSAGES.chooseFailed);
    }
  }

  async function onSave() {
    const box = keyBox.current;
    if (!box) return;
    if (chosen === null) return setStatus(ACTION_MESSAGES.chooseFirst);
    if (trimKey(box.value) === '') return setStatus(ACTION_MESSAGES.pasteFirst);
    const current = opening.current;
    cancelTest();
    try {
      const outcome = await saveKey(chosen, box.value);
      if (current !== opening.current) return;
      box.value = '';
      setKeySaved(true);
      setStatus(outcome === 'replaced' ? ACTION_MESSAGES.replaced : ACTION_MESSAGES.saved);
    } catch {
      if (current === opening.current) setStatus(ACTION_MESSAGES.saveFailed);
    }
  }

  function onKeyBoxKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void onSave();
  }

  async function onTest() {
    if (chosen === null) return setStatus(ACTION_MESSAGES.chooseFirst);
    cancelTest();
    const controller = new AbortController();
    test.current = controller;
    setStatus(ACTION_MESSAGES.checking);
    // Only Claude (Anthropic) is offered so far (src/settings/providers.ts).
    const result = await testAnthropicConnection(controller.signal);
    if (controller.signal.aborted || test.current !== controller) return;
    test.current = null;
    const message = connectionMessage(result);
    if (message !== null) setStatus(message);
  }

  async function onRemove() {
    if (keyBox.current) keyBox.current.value = '';
    if (chosen === null) return setStatus(ACTION_MESSAGES.chooseFirst);
    const current = opening.current;
    cancelTest();
    try {
      const removed = await removeKey(chosen);
      if (current !== opening.current) return;
      setKeySaved(false);
      setStatus(removed ? ACTION_MESSAGES.removed : ACTION_MESSAGES.nothingToRemove);
    } catch {
      if (current === opening.current) setStatus(ACTION_MESSAGES.removeFailed);
    }
  }

  const keyState =
    chosen === null
      ? keySaved === null
        ? ''
        : KEY_STATE.noProvider
      : keySaved === null
        ? ''
        : keySaved
          ? KEY_STATE.saved
          : KEY_STATE.noKey;

  return (
    <>
      <button ref={button} type="button" className={buttonClass} onClick={() => void onOpen()}>
        {SETTINGS_TEXT.heading}
      </button>

      <dialog
        ref={dialog}
        aria-labelledby={headingId}
        className="m-auto w-[min(40rem,calc(100vw-2rem))] overscroll-contain rounded-card bg-surface p-6 text-ink backdrop:bg-ink/40"
        onClose={onClose}
      >
        {open && (
          <div className="flex flex-col gap-4">
            <h2
              ref={heading}
              id={headingId}
              tabIndex={-1}
              className="font-heading text-lg font-semibold"
            >
              {SETTINGS_TEXT.heading}
            </h2>
            <p className="text-ink-secondary">{SETTINGS_TEXT.intro}</p>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 font-medium">{SETTINGS_TEXT.providerLegend}</legend>
              {PROVIDERS.map((option) => (
                <label key={option.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${ids}-provider`}
                    value={option.id}
                    checked={chosen === option.id}
                    onChange={() => void onChoose(option.id)}
                    className={focusClass}
                  />
                  {option.name}
                </label>
              ))}
            </fieldset>

            <div className="flex flex-col gap-1">
              <label htmlFor={keyBoxId} className="font-medium">
                {provider ? keyLabel(provider.name) : SETTINGS_TEXT.keyLabelNoProvider}
              </label>
              <input
                ref={keyBox}
                id={keyBoxId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-describedby={hintId}
                onKeyDown={onKeyBoxKeyDown}
                className={textFieldClass}
              />
              <p id={hintId} className="text-label text-ink-secondary">
                {SETTINGS_TEXT.keyHint}
              </p>
              <p className="text-label">{keyState}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={primaryButtonClass} onClick={() => void onSave()}>
                {SETTINGS_TEXT.saveKey}
              </button>
              <button
                type="button"
                className={buttonClass}
                aria-describedby={noteId}
                onClick={() => void onTest()}
              >
                {SETTINGS_TEXT.testConnection}
              </button>
              <button type="button" className={buttonClass} onClick={() => void onRemove()}>
                {SETTINGS_TEXT.removeKey}
              </button>
            </div>
            <p id={noteId} className="text-label text-ink-secondary">
              {testNote(provider?.host ?? PROVIDERS[0]?.host ?? '')}
            </p>

            <p
              role="status"
              aria-label={SETTINGS_TEXT.messagesLabel}
              className="min-h-6 text-ink-secondary"
            >
              {status}
            </p>

            <div>
              <button type="button" className={buttonClass} onClick={() => dialog.current?.close()}>
                {SETTINGS_TEXT.close}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
