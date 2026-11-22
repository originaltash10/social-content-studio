/**
 * The editing area: the photo with the card's crop drawn over it. Drag the crop to move it, or
 * a corner to resize it; the shape stays locked to the placement.
 *
 * What is shown. A crop may be larger than the photo, and the space outside the photo is then
 * padding. So the area shows more than the photo: it shows the fit frame (`area`), which is
 * every place the crop can reach, with the photo in the middle of it. The area's size comes
 * from the photo and the placement alone, so it is the same before, during and after a drag,
 * whether or not the card has padding. Inside the crop, the space outside the photo is drawn
 * in the card's background colour. When the photo has the placement's shape, the area is the
 * photo.
 *
 * Plain elements and pointer events, so a mouse, a pen and a finger all work the same way. Each
 * drag captures its pointer, so it carries on when the pointer leaves the handle. While a drag
 * is under way the new crop is held here only; `onCommit` is called once, on release, and only
 * if the crop actually changed. A cancelled drag changes nothing.
 *
 * The round marker is the focal point the card uses (the photo's, or the card's own), which its
 * automatic crop is centred on. It is dragged the same way, with one `onFocalCommit` on
 * release. While it is dragged, `cropFor` says what the crop would become, so the crop is seen
 * to follow.
 *
 * Focus. A press that starts a drag also gives keyboard focus to what was pressed: the crop area
 * for the crop and its corners, the marker for the marker. The arrow keys then work straight
 * after a mouse action. The press's own default is stopped (it would select text or start a
 * native drag), and that default is also what would have moved focus, so focus is moved here,
 * without scrolling anything.
 *
 * Everything is placed in percentages of the photo's frame, so the area can change size with
 * the dialog or the window without the crop changing: a crop is always fractions of the photo.
 * A crop with padding simply has a place below 0% or past 100% of the photo, and the photo's
 * frame does not clip what is placed outside it.
 */

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { moveCrop, resizeCrop, sameCrop, toPhoto, toPhotoPlane } from '../lib/editor/geometry';
import type { Corner, CropLimits, Point } from '../lib/editor/geometry';
import type { DisplayPhoto } from '../lib/editor/sourcePhoto';
import type { Rect } from '../types';
import { focusClass } from '../app/styles';

export type CropStageProps = {
  photo: DisplayPhoto;
  /** The crop to show, in fractions of the photo. */
  crop: Rect;
  limits: CropLimits;
  /**
   * The area to show, in fractions of the photo: the fit frame, which holds the photo and every
   * place the crop can reach. Without it, the photo alone.
   */
  area?: Rect;
  /** "#rrggbb": the colour drawn inside the crop where it is outside the photo. */
  background?: string;
  /** Called once when a drag ends with a different crop. */
  onCommit: (crop: Rect) => void;
  /** Says what the area is and what the arrow keys do, for screen readers. */
  label: string;
  /** The id of the text that describes where the crop is. */
  describedBy?: string;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** The focal point the card uses, in fractions of the photo. */
  focal: Point;
  /** The crop to show while the focal point is being dragged to `focal`. */
  cropFor: (focal: Point) => Rect;
  /** Called once when a drag of the focal point ends somewhere new. */
  onFocalCommit: (focal: Point) => void;
  /** Says what the marker is and what the arrow keys do, for screen readers. */
  focalLabel: string;
  focalDescribedBy?: string;
  onFocalKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

/** The size of each corner's touch target, in CSS pixels. The square drawn inside is smaller. */
export const HANDLE_TARGET = 44;

const CORNERS: readonly Corner[] = ['nw', 'ne', 'sw', 'se'];

type Drag =
  | { kind: 'move'; pointerId: number; startX: number; startY: number; from: Rect }
  /**
   * `offsetX/Y`: where the handle was grabbed, measured from the corner itself. `from` is the
   * crop when the drag began: each move resizes that crop, so where the drag ends depends only
   * on where the pointer is, not on the way it got there.
   */
  | {
      kind: 'resize';
      pointerId: number;
      corner: Corner;
      offsetX: number;
      offsetY: number;
      from: Rect;
    }
  | { kind: 'focal'; pointerId: number; offsetX: number; offsetY: number };

const percent = (fraction: number) => `${fraction * 100}%`;
const PHOTO_ALONE: Rect = { x: 0, y: 0, width: 1, height: 1 };
const WHITE = '#ffffff';

export function CropStage(props: CropStageProps) {
  const { photo, crop, limits, onCommit, area = PHOTO_ALONE, background = WHITE } = props;
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [focalDraft, setFocalDraft] = useState<Point | null>(null);
  const focal = focalDraft ?? props.focal;
  const shown = focalDraft ? props.cropFor(focalDraft) : (draft ?? crop);

  // Draw the photo once; the browser scales the canvas to the frame.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    element.width = photo.width;
    element.height = photo.height;
    element.getContext('2d')?.drawImage(photo.bitmap, 0, 0);
  }, [photo]);

  /** Where the frame is on screen, or null before it has a size. */
  function frameBox(): DOMRect | null {
    const box = frame.current?.getBoundingClientRect();
    return box && box.width > 0 && box.height > 0 ? box : null;
  }

  function begin(event: PointerEvent<HTMLElement>, next: Drag) {
    event.preventDefault();
    // preventDefault also stops the press from moving focus, so move it here.
    const target = next.kind === 'focal' ? event.currentTarget : stage.current;
    target?.focus({ preventScroll: true });
    // Not every browser-like environment has pointer capture; the drag still works without it
    // for as long as the pointer stays over the element.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = next;
    if (next.kind === 'focal') setFocalDraft(props.focal);
    else setDraft(crop);
  }

  function onFocalStart(event: PointerEvent<HTMLButtonElement>) {
    const box = frameBox();
    if (!event.isPrimary || event.button !== 0 || drag.current || !box) return;
    begin(event, {
      kind: 'focal',
      pointerId: event.pointerId,
      offsetX: event.clientX - (box.left + props.focal.x * box.width),
      offsetY: event.clientY - (box.top + props.focal.y * box.height),
    });
  }

  function onMoveStart(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    begin(event, {
      kind: 'move',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: crop,
    });
  }

  function onResizeStart(event: PointerEvent<HTMLDivElement>, corner: Corner) {
    const box = frameBox();
    if (!event.isPrimary || event.button !== 0 || drag.current || !box) return;
    const cornerX = box.left + (corner.endsWith('w') ? crop.x : crop.x + crop.width) * box.width;
    const cornerY = box.top + (corner.startsWith('n') ? crop.y : crop.y + crop.height) * box.height;
    begin(event, {
      kind: 'resize',
      pointerId: event.pointerId,
      corner,
      offsetX: event.clientX - cornerX,
      offsetY: event.clientY - cornerY,
      from: crop,
    });
  }

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    const box = frameBox();
    if (!current || current.pointerId !== event.pointerId || !box) return;
    if (current.kind === 'move') {
      setDraft(
        moveCrop(
          current.from,
          (event.clientX - current.startX) / box.width,
          (event.clientY - current.startY) / box.height,
          limits,
        ),
      );
      return;
    }
    const screen = { x: event.clientX - current.offsetX, y: event.clientY - current.offsetY };
    const view = { scale: box.width / photo.source.width, x: box.left, y: box.top };
    if (current.kind === 'focal') {
      // The focal point is always on the photo, however far the marker is dragged.
      setFocalDraft(toPhoto(screen, photo.source, view));
      return;
    }
    // A corner may be dragged past the photo's edge: that is how a crop gets padding.
    const pointer = toPhotoPlane(screen, photo.source, view);
    setDraft(resizeCrop(current.from, current.corner, pointer, limits));
  }

  function end(event: PointerEvent<HTMLElement>, commit: boolean) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDraft(null);
    setFocalDraft(null);
    if (!commit) return;
    // Compared with a tolerance: a crop held in place by the crop limits can come back
    // different in its last decimal places, and that is not a change.
    if (draft && !sameCrop(draft, crop)) onCommit(draft);
    if (focalDraft && (focalDraft.x !== props.focal.x || focalDraft.y !== props.focal.y)) {
      props.onFocalCommit(focalDraft);
    }
  }

  const dragHandlers = {
    onPointerMove,
    onPointerUp: (event: PointerEvent<HTMLElement>) => end(event, true),
    onPointerCancel: (event: PointerEvent<HTMLElement>) => end(event, false),
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => end(event, false),
  };

  const { width, height } = photo.source;
  /** A place on the photo, in fractions of it, as a place in the area shown, in percent. */
  const inArea = (rect: Rect) => ({
    left: percent((rect.x - area.x) / area.width),
    top: percent((rect.y - area.y) / area.height),
    width: percent(rect.width / area.width),
    height: percent(rect.height / area.height),
  });
  const cropPlace = {
    left: percent(shown.x),
    top: percent(shown.y),
    width: percent(shown.width),
    height: percent(shown.height),
  };
  return (
    <div
      ref={stage}
      role="application"
      tabIndex={0}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      onKeyDown={props.onKeyDown}
      // The padding leaves room for the corner targets when the crop reaches the area's edge.
      className={`flex justify-center rounded-control bg-page p-6 ${focusClass}`}
    >
      {/* The area shown: the fit frame. Its size never depends on where the crop is. */}
      <div
        data-testid="crop-area"
        className="relative select-none"
        style={{
          aspectRatio: `${area.width * width} / ${area.height * height}`,
          // As wide as there is room for, but never taller than 60% of the window.
          width: `min(100%, calc(60vh * ${area.width * width} / ${area.height * height}))`,
          // The space outside the photo, where nothing has been put yet.
          backgroundColor: 'color-mix(in srgb, var(--color-muted) 25%, var(--color-surface))',
        }}
      >
        {/* The photo's frame. Everything in it is placed in percentages of the photo. */}
        <div ref={frame} data-testid="crop-frame" className="absolute" style={inArea(PHOTO_ALONE)}>
          {/* The padding: the crop filled with the card's colour, under the photo. */}
          <div
            aria-hidden="true"
            data-testid="crop-padding"
            className="pointer-events-none absolute"
            style={{ ...cropPlace, backgroundColor: background }}
          />
          <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 h-full w-full" />
          {/* Darkens everything outside the crop. Clipped to the area; the handles are not. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute overflow-hidden"
            style={{
              left: percent(area.x),
              top: percent(area.y),
              width: percent(area.width),
              height: percent(area.height),
            }}
          >
            <div
              className="absolute"
              style={{
                ...inArea(shown),
                boxShadow:
                  '0 0 0 100vmax color-mix(in srgb, var(--color-ink) 55%, transparent), ' +
                  'inset 0 0 0 1px var(--color-ink)',
              }}
            />
          </div>
          <div
            data-testid="crop-rect"
            className="absolute cursor-move touch-none outline-2 outline-white"
            style={cropPlace}
            onPointerDown={onMoveStart}
            {...dragHandlers}
          />
          {CORNERS.map((corner) => (
            <div
              key={corner}
              data-testid={`crop-handle-${corner}`}
              className={`absolute flex touch-none items-center justify-center ${
                corner === 'nw' || corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'
              }`}
              style={{
                width: HANDLE_TARGET,
                height: HANDLE_TARGET,
                left: `calc(${percent(corner.endsWith('w') ? shown.x : shown.x + shown.width)} - ${HANDLE_TARGET / 2}px)`,
                top: `calc(${percent(corner.startsWith('n') ? shown.y : shown.y + shown.height)} - ${HANDLE_TARGET / 2}px)`,
              }}
              onPointerDown={(event) => onResizeStart(event, corner)}
              {...dragHandlers}
            >
              <span aria-hidden="true" className="h-3.5 w-3.5 border-2 border-ink bg-white" />
            </div>
          ))}
          <button
            type="button"
            data-testid="focal-marker"
            aria-label={props.focalLabel}
            aria-describedby={props.focalDescribedBy}
            className={`absolute flex cursor-grab touch-none items-center justify-center rounded-full ${focusClass}`}
            style={{
              width: HANDLE_TARGET,
              height: HANDLE_TARGET,
              left: `calc(${percent(focal.x)} - ${HANDLE_TARGET / 2}px)`,
              top: `calc(${percent(focal.y)} - ${HANDLE_TARGET / 2}px)`,
            }}
            onKeyDown={props.onFocalKeyDown}
            onPointerDown={onFocalStart}
            {...dragHandlers}
          >
            <span
              aria-hidden="true"
              className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-ink/40 outline-1 outline-ink"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-white" />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
