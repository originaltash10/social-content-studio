/**
 * The editing area: the photo with the card's crop drawn over it. Drag the crop to move it, or
 * a corner to resize it; the shape stays locked to the placement.
 *
 * Plain elements and pointer events, so a mouse, a pen and a finger all work the same way. Each
 * drag captures its pointer, so it carries on when the pointer leaves the handle. While a drag
 * is under way the new crop is held here only; `onCommit` is called once, on release, and only
 * if the crop actually changed. A cancelled drag changes nothing.
 *
 * The round marker is the focal point the card uses (the photo's, or the card's own), which its
 * automatic crop is centred on. It is dragged the same way, with one `onFocalCommit` on release. While it is dragged, `cropFor`
 * says what the crop would become, so the crop is seen to follow.
 *
 * Everything is placed in percentages of the photo's frame, so the area can change size with
 * the dialog or the window without the crop changing: a crop is always fractions of the photo.
 */

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { moveCrop, resizeCrop, toPhoto } from '../lib/editor/geometry';
import type { Corner, CropLimits, Point } from '../lib/editor/geometry';
import type { DisplayPhoto } from '../lib/editor/sourcePhoto';
import type { Rect } from '../types';
import { focusClass } from '../app/styles';

export type CropStageProps = {
  photo: DisplayPhoto;
  /** The crop to show, in fractions of the photo. */
  crop: Rect;
  limits: CropLimits;
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
  /** `offsetX/Y`: where the handle was grabbed, measured from the corner itself. */
  | { kind: 'resize'; pointerId: number; corner: Corner; offsetX: number; offsetY: number }
  | { kind: 'focal'; pointerId: number; offsetX: number; offsetY: number };

const percent = (fraction: number) => `${fraction * 100}%`;
const sameRect = (a: Rect, b: Rect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export function CropStage(props: CropStageProps) {
  const { photo, crop, limits, onCommit } = props;
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
    // preventDefault stops the press from focusing the marker, so focus it here.
    event.currentTarget.focus();
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
        ),
      );
      return;
    }
    const pointer = toPhoto(
      { x: event.clientX - current.offsetX, y: event.clientY - current.offsetY },
      photo.source,
      { scale: box.width / photo.source.width, x: box.left, y: box.top },
    );
    if (current.kind === 'focal') {
      setFocalDraft(pointer);
      return;
    }
    setDraft((before) => resizeCrop(before ?? crop, current.corner, pointer, limits));
  }

  function end(event: PointerEvent<HTMLElement>, commit: boolean) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDraft(null);
    setFocalDraft(null);
    if (!commit) return;
    if (draft && !sameRect(draft, crop)) onCommit(draft);
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
  return (
    <div
      role="application"
      tabIndex={0}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      onKeyDown={props.onKeyDown}
      // The padding leaves room for the corner targets when the crop reaches the photo's edge.
      className={`flex justify-center rounded-control bg-page p-6 ${focusClass}`}
    >
      <div
        ref={frame}
        data-testid="crop-frame"
        className="relative select-none"
        style={{
          aspectRatio: `${width} / ${height}`,
          // As wide as there is room for, but never taller than 60% of the window.
          width: `min(100%, calc(60vh * ${width} / ${height}))`,
        }}
      >
        <canvas ref={canvas} aria-hidden="true" className="block h-full w-full" />
        {/* Darkens everything outside the crop. Clipped to the photo; the handles are not. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div
            className="absolute"
            style={{
              left: percent(shown.x),
              top: percent(shown.y),
              width: percent(shown.width),
              height: percent(shown.height),
              boxShadow:
                '0 0 0 100vmax color-mix(in srgb, var(--color-ink) 55%, transparent), ' +
                'inset 0 0 0 1px var(--color-ink)',
            }}
          />
        </div>
        <div
          data-testid="crop-rect"
          className="absolute cursor-move touch-none outline-2 outline-white"
          style={{
            left: percent(shown.x),
            top: percent(shown.y),
            width: percent(shown.width),
            height: percent(shown.height),
          }}
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
  );
}
