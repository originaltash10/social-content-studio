/** One card on the board: its preview, what it is, its result, and its actions. */

import type { CardRender } from '../lib/board/controller';
import { progressLabel, progressPercent } from '../lib/board/controller';
import type { VersionInfo } from '../lib/board/versions';
import { lineageLabel, versionLabel } from '../lib/board/versions';
import {
  isPending,
  previewAlt,
  renderedFileLabel,
  resultOf,
  upscaledNote,
} from '../lib/board/view';
import type { Card } from '../types';
import { badgeClass, buttonClass } from '../app/styles';
import { ResultBadge } from './ResultBadge';

export type CardTileProps = {
  card: Card;
  /** The card's placement in words, for example "Instagram Feed vertical". */
  name: string;
  /**
   * Which card this is, for screen readers, for example "Instagram Feed vertical for site.jpg,
   * v1". Every button's name starts with its visible word and ends with this.
   */
  label: string;
  /** The planned output size, used to shape the preview before the file exists. */
  size: { width: number; height: number } | null;
  fileName: string;
  render: CardRender | undefined;
  version: VersionInfo;
  onCancel: () => void;
  onRenderAgain: () => void;
  onOpen: (button: HTMLButtonElement) => void;
  onDuplicate: () => void;
};

export function CardTile(props: CardTileProps) {
  const { card, name, label, size, fileName, render, version } = props;
  const pending = isPending(render);
  const lineage = lineageLabel(version);
  const shape = render?.kind === 'done' ? render : size;

  return (
    <article
      aria-label={label}
      className="flex h-full flex-col gap-2 rounded-card border border-page bg-surface p-3"
    >
      <div
        className="flex items-center justify-center overflow-hidden rounded-control bg-page"
        style={shape ? { aspectRatio: `${shape.width} / ${shape.height}` } : undefined}
      >
        {render?.kind === 'done' ? (
          <img
            src={render.url}
            alt={previewAlt(card, fileName, name)}
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="p-2 text-center text-label text-muted-text">
            {render?.kind === 'failed'
              ? 'No preview'
              : render?.kind === 'cancelled'
                ? 'Cancelled'
                : 'Preview coming'}
          </span>
        )}
      </div>

      <h4 className="font-heading font-semibold">{name}</h4>

      <div className="flex flex-wrap items-center gap-2">
        <ResultBadge result={resultOf(card, render)} />
        <span className={`${badgeClass} text-ink-secondary`}>{versionLabel(version)}</span>
      </div>
      {lineage && <p className="text-label text-muted-text">{lineage}</p>}

      {render?.kind === 'done' && (
        <p className="text-label text-ink-secondary">{renderedFileLabel(render)}</p>
      )}
      {render?.kind === 'done' && render.upscaled && (
        <p className="text-label text-highlight-text">
          {upscaledNote(render.width, render.height)}
        </p>
      )}
      {render?.kind === 'failed' && <p className="text-label text-red-700">{render.message}</p>}
      {render?.kind === 'cancelled' && (
        <p className="text-label text-ink-secondary">Cancelled before the file was made.</p>
      )}

      {pending && (
        <div className="flex flex-col gap-1">
          <div
            role="progressbar"
            aria-label={`Rendering ${label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent(render)}
            aria-valuetext={progressLabel(render)}
            className="h-2 overflow-hidden rounded-control bg-page"
          >
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: `${progressPercent(render)}%` }}
            />
          </div>
          <p className="text-label text-muted-text">{progressLabel(render)}</p>
        </div>
      )}

      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        {pending ? (
          <button
            type="button"
            className={buttonClass}
            aria-label={`Cancel ${label}`}
            onClick={props.onCancel}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className={buttonClass}
            aria-label={`Render again ${label}`}
            onClick={props.onRenderAgain}
          >
            Render again
          </button>
        )}
        <button
          type="button"
          className={buttonClass}
          aria-label={`Open ${label}`}
          onClick={(event) => props.onOpen(event.currentTarget)}
        >
          Open
        </button>
        <button
          type="button"
          className={buttonClass}
          aria-label={`Duplicate ${label}`}
          onClick={props.onDuplicate}
        >
          Duplicate
        </button>
      </div>
    </article>
  );
}
