/**
 * One card on the board: its preview, what it is, its result, and its actions.
 *
 * While the card is rendered again the tile keeps its height: the last finished picture stays,
 * dimmed, with the progress over it, and the file line says "Updating…" until the new file.
 */

import type { CardRender } from '../lib/board/controller';
import type { VersionInfo } from '../lib/board/versions';
import { lineageLabel, versionLabel } from '../lib/board/versions';
import { isPending, previewAlt, resultOf, upscaledNote } from '../lib/board/view';
import type { Card } from '../types';
import { badgeClass, buttonClass, resultTextClass } from '../app/styles';
import { CANCELLED_TEXT, captionText, useLastDone } from './lastDone';
import { FilePreview } from './RenderedFile';
import { ResultBadge } from './ResultBadge';
import { firstReason } from './reason';

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

/**
 * A button's word, as wide as the wider of its two words: the other one is laid in the same
 * place, invisible and hidden from screen readers. Cancel and Render again take turns in one
 * place, so without this the row of buttons could wrap differently, and the tile change height,
 * each time a render starts or ends.
 */
function SameWidth({ shown, other }: { shown: string; other: string }) {
  return (
    <span className="inline-grid justify-items-center">
      <span className="col-start-1 row-start-1">{shown}</span>
      <span
        aria-hidden="true"
        data-testid="same-width"
        className="invisible col-start-1 row-start-1"
      >
        {other}
      </span>
    </span>
  );
}

export function CardTile(props: CardTileProps) {
  const { card, name, label, size, fileName, render, version } = props;
  const pending = isPending(render);
  const lineage = lineageLabel(version);
  // The last finished file, kept while the card is rendered again.
  const shown = useLastDone(card.id, render);
  // Reasons are shown once a file is checked. During a re-render the last file's reason stays,
  // as the card's checks only change when the new result arrives.
  const reason = shown ? firstReason(card.validation) : null;
  const fileLine = captionText(render, shown);

  return (
    <article
      aria-label={label}
      className="flex h-full flex-col gap-2 rounded-card border border-page bg-surface p-3"
    >
      <FilePreview
        render={render}
        shown={shown}
        alt={previewAlt(card, fileName, name)}
        progressName={`Rendering ${label}`}
        boxClassName="w-full"
        shape={shown ?? size}
        emptyText={
          render?.kind === 'failed'
            ? 'No preview'
            : render?.kind === 'cancelled'
              ? 'Cancelled'
              : 'Preview coming'
        }
      />

      <h4 className="font-heading font-semibold">{name}</h4>

      <div className="flex flex-wrap items-center gap-2">
        <ResultBadge result={resultOf(card, render)} />
        <span className={`${badgeClass} text-ink-secondary`}>{versionLabel(version)}</span>
      </div>
      {reason && (
        <p className={`text-label ${resultTextClass[reason.level]}`}>
          {reason.message}
          {reason.more > 0 && <span className="text-ink-secondary"> +{reason.more} more</span>}
        </p>
      )}
      {lineage && <p className="text-label text-muted-text">{lineage}</p>}

      {fileLine && <p className="text-label text-ink-secondary">{fileLine}</p>}
      {shown?.upscaled && (
        <p className="text-label text-ink-secondary">{upscaledNote(shown.width, shown.height)}</p>
      )}
      {render?.kind === 'failed' && <p className="text-label text-red-700">{render.message}</p>}
      {render?.kind === 'cancelled' && (
        <p className="text-label text-ink-secondary">{CANCELLED_TEXT}</p>
      )}

      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        {pending ? (
          <button
            type="button"
            className={buttonClass}
            aria-label={`Cancel ${label}`}
            onClick={props.onCancel}
          >
            <SameWidth shown="Cancel" other="Render again" />
          </button>
        ) : (
          <button
            type="button"
            className={buttonClass}
            aria-label={`Render again ${label}`}
            onClick={props.onRenderAgain}
          >
            <SameWidth shown="Render again" other="Cancel" />
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
