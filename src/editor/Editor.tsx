/**
 * The editor for one card, shown in the board's card dialog: the original photo with the card's
 * crop over it, which can be moved and resized.
 *
 * What it writes, and when. Opening the editor writes nothing: a stored crop that is smaller
 * than the editor allows is enlarged for display only. The card is changed with one
 * `updateCard` when a drag is released with a different crop, when an arrow key moves the
 * crop or plus or minus resizes it, and when Reset crop is pressed.
 *
 * The focal point. A card uses its photo's focal point, shared with the photo's other cards,
 * unless it has its own (a duplicate does). Everything here goes by the point the card uses:
 * where the marker is, whether the crop counts as automatic, Reset crop, and the readout.
 * Moving the marker, on release or per arrow key, is one change:
 * - on a card that shares the photo's point, one `setAssetFocal`: it moves the photo's point
 *   and re-centres every card sharing it that is still on its automatic crop, together;
 * - on a card with its own point, one `updateCard` of that card alone: its point, and its crop
 *   if it is on its automatic crop. The photo and every other card are left as they are.
 *
 * Each of those is one undo step and marks the session as changed, so autosave picks it up. The
 * board then renders and checks the card again.
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
  movePoint,
  resizeDelta,
  scaleCrop,
} from '../lib/editor/geometry';
import type { Point } from '../lib/editor/geometry';
import { ownFocalMove, recentredCrops } from '../lib/editor/focal';
import { getPlacement } from '../lib/platforms';
import { effectiveFocal } from '../lib/render/focal';
import { UNDO_LIMIT, useSessionStore } from '../store/sessionStore';
import type { Asset, Card, ImageEdit, Rect, Size } from '../types';
import { buttonClass } from '../app/styles';
import { CropStage } from './CropStage';
import { cropReadout, focalKindText, focalLabel, focalReadout, stageLabel } from './text';
import type { FocalKind } from './text';
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
  'arrow keys move it, and plus and minus resize it; hold Shift for bigger steps. The round ' +
  'marker is the focal point, which automatic crops are centred on: drag it, or select it and ' +
  'use the arrow keys.';

/** A card's output size, from src/data/platforms.json; undefined for an unknown placement. */
const targetOf = (card: Card) => getPlacement(card.platform, card.placement)?.sizes[0];

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
  const focalReadoutId = useId();
  /** How many of the newest undo steps were made here since the editor opened. */
  const steps = useRef(0);

  const source = { width: asset.width, height: asset.height };
  const limits = cropLimits(source, target);
  // For display only: never written back unless the user changes the crop.
  const shown = constrainCrop(card.edit.crop, source, target);
  // The point this card uses: its own if it has one, or else the photo's.
  const own = card.focal;
  const focal = effectiveFocal(card, asset);
  const kind: FocalKind = own ? 'own' : 'shared';
  const automatic = isAutomaticCrop(card.edit.crop, source, target, focal);

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

  /** Moves the focal point: one store change and one undo step, or nothing if it is the same. */
  function writeFocal(next: Point) {
    const store = useSessionStore.getState();
    const before = store.revision;
    if (own) {
      // The card's own point: this card only, never the photo or its other cards.
      const move = ownFocalMove({ focal: own, edit: card.edit }, source, target, next);
      if (!move) return;
      store.updateCard(card.id, (draft) => {
        draft.focal = move.focal;
        if (move.crop && isImageEdit(draft.edit)) draft.edit.crop = move.crop;
      });
    } else {
      const crops = recentredCrops(store.session?.cards ?? [], asset, next, targetOf);
      store.setAssetFocal(asset.id, next, crops);
    }
    if (useSessionStore.getState().revision !== before) {
      steps.current = Math.min(steps.current + 1, UNDO_LIMIT);
    }
  }

  function onFocalKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    // The marker's keys are its own: they must not also move or resize the crop.
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const move = arrowDelta(event.key, event.shiftKey);
    if (!move) return;
    event.preventDefault();
    writeFocal(movePoint(focal, move.dx, move.dy));
  }

  function onStageKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const move = arrowDelta(event.key, event.shiftKey);
    const resize = resizeDelta(event.key, event.shiftKey);
    if (!move && resize === null) return;
    event.preventDefault();
    const next = move
      ? moveCrop(shown, move.dx, move.dy)
      : scaleCrop(shown, resize as number, limits);
    // At the edge of the photo or at a size limit nothing changes, so nothing is written.
    if (next.x !== shown.x || next.y !== shown.y || next.width !== shown.width) write(next);
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
        focal={focal}
        cropFor={(point) => (automatic ? automaticCrop(source, target, point) : shown)}
        onFocalCommit={writeFocal}
        focalLabel={focalLabel(asset.fileName, kind)}
        focalDescribedBy={focalReadoutId}
        onFocalKeyDown={onFocalKeyDown}
      />
      <p id={readoutId} aria-live="polite" className="text-label text-ink-secondary">
        {cropReadout(shown)}
      </p>
      <p id={focalReadoutId} aria-live="polite" className="text-label text-ink-secondary">
        {focalReadout(focal)}
      </p>
      <p data-testid="focal-kind" className="text-label text-ink-secondary">
        {focalKindText(kind)}
      </p>
      <p className="text-label text-muted-text">{HELP_TEXT}</p>
      <div>
        <button
          type="button"
          className={buttonClass}
          disabled={automatic}
          onClick={() => write(automaticCrop(source, target, focal))}
        >
          Reset crop
        </button>
      </div>
    </div>
  );
}
