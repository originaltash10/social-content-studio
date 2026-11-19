/**
 * A card's file preview that keeps its size while the card is rendered again, so the board's
 * tiles and the card dialog do not jump on every change.
 *
 * During a re-render the last finished picture stays, dimmed, with the progress bar over its
 * bottom edge. It must be the same `<img>` element: the render controller revokes the old file's
 * address when a new render starts, so a picture already on the page keeps showing it, but a new
 * element given that address would fail to load.
 */

import type { CardRender } from '../lib/board/controller';
import { progressLabel, progressPercent } from '../lib/board/controller';
import { isPending } from '../lib/board/view';
import type { DoneRender } from './lastDone';
import { CANCELLED_TEXT, captionText } from './lastDone';

export type FilePreviewProps = {
  render: CardRender | undefined;
  /** The finished file to show, from `useLastDone` in `lastDone.ts`. */
  shown: DoneRender | null;
  alt: string;
  /** The progress bar's name, for example "Rendering Instagram Feed vertical". */
  progressName: string;
  /** Classes for the box that holds the picture; it must give the box a stable size. */
  boxClassName: string;
  /** The box's shape, from the last file or the placement's size. */
  shape: { width: number; height: number } | null;
  /** What the box says when there is no picture and no file is being made. */
  emptyText: string;
  /** What the box says before the first file while one is being made. */
  pendingText?: string;
};

/** The picture box: the file, or a placeholder of the same size, with any progress over it. */
export function FilePreview(props: FilePreviewProps) {
  const { render, shown, alt, progressName, boxClassName, shape, emptyText, pendingText } = props;
  const pending = isPending(render);
  const updating = pending && shown !== null && render?.kind !== 'done';
  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden rounded-control bg-page ${boxClassName}`}
      style={shape ? { aspectRatio: `${shape.width} / ${shape.height}` } : undefined}
    >
      {shown ? (
        <img
          src={shown.url}
          alt={alt}
          data-updating={updating || undefined}
          className={`h-full w-full object-contain transition-opacity ${updating ? 'opacity-50' : ''}`}
        />
      ) : (
        <span className="p-2 text-center text-label text-muted-text">
          {pending && pendingText !== undefined ? pendingText : emptyText}
        </span>
      )}
      {pending && (
        <div
          role="progressbar"
          aria-label={progressName}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent(render)}
          aria-valuetext={progressLabel(render)}
          className="absolute inset-x-0 bottom-0 h-2 overflow-hidden bg-page/80"
        >
          <div
            className="h-full bg-accent transition-[width]"
            style={{ width: `${progressPercent(render)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export type RenderedFileProps = {
  render: CardRender | undefined;
  shown: DoneRender | null;
  alt: string;
  progressName: string;
  /** The placement's size, to shape the box before the first file. */
  size: { width: number; height: number } | null;
};

/**
 * The card dialog's "Rendered file": a box of fixed height and a caption line of fixed height,
 * whatever the render is doing. A failure or a cancel is said inside the box.
 */
export function RenderedFile({ render, shown, alt, progressName, size }: RenderedFileProps) {
  const emptyText =
    render?.kind === 'failed'
      ? render.message
      : render?.kind === 'cancelled'
        ? CANCELLED_TEXT
        : 'No preview yet.';
  return (
    // The file's type and size under it, so a change of file type or quality shows.
    <figure className="flex min-w-0 flex-col gap-1">
      <FilePreview
        render={render}
        shown={shown}
        alt={alt}
        progressName={progressName}
        boxClassName="h-48 max-w-full self-start"
        shape={shown ?? size}
        emptyText={emptyText}
        pendingText=""
      />
      <figcaption className="h-4 truncate text-label text-muted-text">
        {captionText(render, shown)}
      </figcaption>
    </figure>
  );
}
