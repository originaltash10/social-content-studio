/**
 * The file type and JPG quality of one card, in the card details: a JPG or PNG choice and, for
 * JPG, a quality slider (src/board/fileSettings.ts has the range and why).
 *
 * What it writes, and when. Every write is one `updateCard`, one undo step, recorded in the card
 * dialog's undo, and marks the card changed, so the board renders and checks it again.
 * - Choosing a file type writes the format only. The stored quality is never touched, so
 *   switching to PNG and back to JPG gives the same quality as before. Choosing the type the card
 *   already has writes nothing.
 * - The slider shows its value as it moves but writes once, when the change is finished:
 *   - a drag (mouse, touch or pen) when the pointer is released. A cancelled pointer (the browser
 *     took the gesture over, for example to scroll) puts the value back and writes nothing, as a
 *     cancelled crop drag does in the editor;
 *   - a key (arrows, Page Up and Page Down, Home and End) when it is released, so holding a key
 *     down is one step;
 *   - a change made another way (assistive technology) on the input's own `change` event;
 *   - and anything still pending when the slider loses focus, goes away, or Ctrl/Cmd-Z is
 *     pressed in the dialog.
 *   A finished change that ends on the value already shown writes nothing.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

import { isImageEdit } from '../lib/board/renderValidation';
import type { OutputFormat } from '../lib/render/plan';
import { useSessionStore } from '../store/sessionStore';
import type { ImageEdit } from '../types';
import { focusClass } from '../app/styles';
import type { DialogUndo } from './dialogUndo';
import {
  FILE_TYPE_LEGEND,
  FORMAT_CHOICES,
  PNG_NOTE,
  QUALITY_MAX,
  QUALITY_MIN,
  QUALITY_NAME,
  QUALITY_STEP,
  fromPercent,
  keyPercent,
  qualityText,
  qualityValueText,
  shownFormat,
  shownPercent,
} from './fileSettings';

export type FileTypeControlsProps = {
  cardId: string;
  edit: Partial<Pick<ImageEdit, 'format' | 'quality'>>;
  /** Runs each change; the card dialog passes its undo's `record`. */
  record: (change: () => void) => void;
  /** The card dialog's undo, so Ctrl/Cmd-Z first writes a pending slider value. */
  undo?: DialogUndo;
};

/** Writes one change to the card's image edit: one store change, one undo step. */
function writeEdit(cardId: string, change: (edit: ImageEdit) => void) {
  useSessionStore.getState().updateCard(cardId, (draft) => {
    if (isImageEdit(draft.edit)) change(draft.edit);
  });
}

/** The card's edit as it is in the store now. */
function storedEdit(cardId: string) {
  const edit = useSessionStore.getState().session?.cards.find((c) => c.id === cardId)?.edit;
  return edit && isImageEdit(edit) ? edit : undefined;
}

export function FileTypeControls({ cardId, edit, record, undo }: FileTypeControlsProps) {
  const groupName = useId();
  const sliderId = useId();
  const format = shownFormat(edit);

  /** The slider's value while a change is under way; null when it shows the stored value. */
  const [draft, setDraft] = useState<number | null>(null);
  const draftRef = useRef<number | null>(null);
  /** The pointer dragging the slider, if any. */
  const pointer = useRef<number | null>(null);

  function show(percent: number | null) {
    draftRef.current = percent;
    setDraft(percent);
  }

  /** Writes the pending value, if any, as one step; nothing when it equals the stored value. */
  function commit() {
    const percent = draftRef.current;
    if (percent === null) return;
    show(null);
    const current = storedEdit(cardId);
    if (!current || percent === shownPercent(current)) return;
    record(() => {
      writeEdit(cardId, (target) => {
        target.quality = fromPercent(percent);
      });
    });
  }
  // The latest commit, for the flush and the unmount below, which are set up once.
  const commitRef = useRef(commit);
  useLayoutEffect(() => {
    commitRef.current = commit;
  });

  useEffect(() => undo?.beforeUndo(() => commitRef.current()), [undo]);
  useEffect(() => () => commitRef.current(), []);

  // A change made without a key or a pointer (assistive technology) ends with `change`.
  const slider = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = slider.current;
    if (!element) return;
    const onChange = () => {
      if (pointer.current === null) commitRef.current();
    };
    element.addEventListener('change', onChange);
    return () => element.removeEventListener('change', onChange);
  }, [format]);

  function choose(next: OutputFormat) {
    if (next === format) return;
    record(() => {
      writeEdit(cardId, (target) => {
        target.format = next;
      });
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const next = keyPercent(event.key, draftRef.current ?? shownPercent(edit));
    if (next === null) return;
    // The slider's own key handling is replaced, so every key moves it the same way everywhere.
    event.preventDefault();
    show(next);
  }

  function onPointerDown(event: PointerEvent<HTMLInputElement>) {
    if (!event.isPrimary || pointer.current !== null) return;
    pointer.current = event.pointerId;
    // So the release is heard even when the pointer leaves the slider.
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function endDrag(event: PointerEvent<HTMLInputElement>, keep: boolean) {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    if (keep) commit();
    else show(null);
  }

  const percent = draft ?? shownPercent(edit);

  return (
    <div className="flex flex-col gap-2">
      <fieldset className="flex flex-col gap-1">
        <legend className="font-heading font-semibold">{FILE_TYPE_LEGEND}</legend>
        <div className="flex flex-wrap gap-x-6">
          {FORMAT_CHOICES.map((choice) => (
            <label key={choice.value} className="flex min-h-11 min-w-11 items-center gap-2">
              <input
                type="radio"
                name={groupName}
                value={choice.value}
                className={`h-5 w-5 accent-accent ${focusClass}`}
                checked={format === choice.value}
                onChange={() => choose(choice.value)}
              />
              {choice.label}
            </label>
          ))}
        </div>
      </fieldset>

      {format === 'jpg' ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={sliderId} className="text-label text-muted-text">
            {qualityText(percent)}
          </label>
          <input
            ref={slider}
            id={sliderId}
            type="range"
            aria-label={QUALITY_NAME}
            aria-valuetext={qualityValueText(percent)}
            min={QUALITY_MIN}
            max={QUALITY_MAX}
            step={QUALITY_STEP}
            value={percent}
            className={`h-11 w-full accent-accent ${focusClass}`}
            onChange={(event) => show(Number(event.target.value))}
            onKeyDown={onKeyDown}
            onKeyUp={commit}
            onBlur={commit}
            onPointerDown={onPointerDown}
            onPointerUp={(event) => endDrag(event, true)}
            onPointerCancel={(event) => endDrag(event, false)}
            onLostPointerCapture={(event) => endDrag(event, false)}
          />
        </div>
      ) : (
        <p className="text-ink-secondary">{PNG_NOTE}</p>
      )}
    </div>
  );
}
