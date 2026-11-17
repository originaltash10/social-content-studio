/**
 * The editor for one card, shown in the board's card dialog: the original photo with the card's
 * crop over it, which can be moved and resized.
 *
 * What it writes, and when. Opening the editor writes nothing: a stored crop that is smaller
 * than the editor allows is enlarged for display only. The card is changed with one
 * `updateCard` when a drag is released with a different crop, when an arrow key moves the
 * crop, and when Reset crop is pressed. Each of those is one undo step and marks the session as
 * changed, so autosave picks it up. The board then renders and checks the card again.
 *
 * Undo. While the editor is open, Ctrl/Cmd-Z belongs to it: it undoes only the changes made
 * here since it opened, one per press, and does nothing once those are used up. The key press
 * is always stopped here, so the app-wide undo in SessionPanel never also runs.
 */

import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { isImageEdit } from '../lib/board/renderValidation';
import {
  arrowDelta,
  automaticCrop,
  constrainCrop,
  cropLimits,
  isAutomaticCrop,
  moveCrop,
} from '../lib/editor/geometry';
import { UNDO_LIMIT, useSessionStore } from '../store/sessionStore';
import type { Asset, Card, ImageEdit, Rect, Size } from '../types';
import { buttonClass } from '../app/styles';
import { CropStage } from './CropStage';
import { cropReadout, stageLabel } from './text';
import { useSourcePhoto } from './useSourcePhoto';
import type { PhotoLoader } from './useSourcePhoto';

export type EditorProps = {
  /** A card for a single photo. */
  card: Card & { edit: ImageEdit };
  asset: Asset;
  /** The placement's output size, from src/data/platforms.json. */
  target: Size;
  /** The original file; undefined when it is not in memory. */
  blob: Blob | undefined;
  /** Opens the photo. Tests pass a fake. */
  loadPhoto?: PhotoLoader;
};

export const LOADING_TEXT = 'Opening the photo so you can adjust the crop…';
export const HELP_TEXT =
  'Drag the crop to move it, or drag a corner to resize it. With the crop area selected, the ' +
  'arrow keys move it; hold Shift for bigger steps.';

/** True when the key event came from a field where Ctrl/Cmd-Z should undo typing instead. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function Editor({ card, asset, target, blob, loadPhoto }: EditorProps) {
  const state = useSourcePhoto(
    {
      assetId: asset.id,
      blob,
      fileName: asset.fileName,
      width: asset.width,
      height: asset.height,
    },
    loadPhoto,
  );
  const readoutId = useId();
  /** How many of the newest undo steps were made here since the editor opened. */
  const steps = useRef(0);

  const source = { width: asset.width, height: asset.height };
  const limits = cropLimits(source, target);
  // For display only: never written back unless the user changes the crop.
  const shown = constrainCrop(card.edit.crop, source, target);
  const automatic = isAutomaticCrop(card.edit.crop, source, target, asset.focal);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      const isUndo =
        (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
      if (!isUndo || isTyping(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (steps.current === 0) return;
      steps.current -= 1;
      useSessionStore.getState().undo();
    }
    // Capture phase on the window: it runs before any other Ctrl/Cmd-Z listener can.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  /** Writes a new crop to the card: one store change, one undo step. */
  function write(crop: Rect) {
    const changed = useSessionStore.getState().updateCard(card.id, (draft) => {
      if (isImageEdit(draft.edit)) draft.edit.crop = crop;
    });
    if (changed) steps.current = Math.min(steps.current + 1, UNDO_LIMIT);
  }

  function onStageKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const delta = arrowDelta(event.key, event.shiftKey);
    if (!delta) return;
    event.preventDefault();
    const next = moveCrop(shown, delta.dx, delta.dy);
    // At the edge of the photo there is nowhere to go, so there is nothing to write.
    if (next.x !== shown.x || next.y !== shown.y) write(next);
  }

  if (state.kind === 'loading') {
    return (
      <p role="status" className="rounded-control bg-page p-4 text-ink-secondary">
        {LOADING_TEXT}
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <p role="alert" className="rounded-control bg-page p-4 text-red-700">
        {state.message}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <CropStage
        photo={state.photo}
        crop={shown}
        limits={limits}
        onCommit={write}
        label={stageLabel(asset.fileName)}
        describedBy={readoutId}
        onKeyDown={onStageKeyDown}
      />
      <p id={readoutId} aria-live="polite" className="text-label text-ink-secondary">
        {cropReadout(shown)}
      </p>
      <p className="text-label text-muted-text">{HELP_TEXT}</p>
      <div>
        <button
          type="button"
          className={buttonClass}
          disabled={automatic}
          onClick={() => write(automaticCrop(source, target, asset.focal))}
        >
          Reset crop
        </button>
      </div>
    </div>
  );
}
