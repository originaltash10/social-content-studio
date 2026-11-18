/**
 * One card in the board's dialog: the editor for its crop (or, for a card that cannot be edited,
 * its preview), with the file, the version and every check in full. The editor sits beside the
 * details on a wide screen and above them on a narrow one.
 *
 * A card whose latest result is Fail also shows the export override (SPEC.md: "Fail blocks
 * export unless overridden"). It stays visible while the override is ticked, so it can always be
 * unticked, even after the card stops failing.
 */

import type { ReactNode } from 'react';

import type { CardRender } from '../lib/board/controller';
import { progressLabel, progressPercent } from '../lib/board/controller';
import type { VersionInfo } from '../lib/board/versions';
import { versionDescription } from '../lib/board/versions';
import {
  RESULT_LABEL,
  isPending,
  previewAlt,
  renderedFileLabel,
  resultOf,
  upscaledNote,
} from '../lib/board/view';
import { useSessionStore } from '../store/sessionStore';
import type { Card } from '../types';
import { focusClass, resultTextClass } from '../app/styles';
import { ResultBadge } from './ResultBadge';

export type CardDetailsProps = {
  card: Card;
  name: string;
  fileName: string;
  render: CardRender | undefined;
  version: VersionInfo;
  headingId: string;
  /** The editor for this card. Without one, the rendered preview is shown instead. */
  editor?: ReactNode;
};

export const OVERRIDE_LABEL = 'Export this card even though it fails its checks';
export const OVERRIDE_NOT_NEEDED =
  "This card no longer fails its checks, so the override isn't needed.";

export const NOT_RENDERED_NOTE =
  'The file has not been made yet, so these checks use the planned size, and the file size is not checked.';

export function CardDetails({
  card,
  name,
  fileName,
  render,
  version,
  headingId,
  editor,
}: CardDetailsProps) {
  const done = render?.kind === 'done' ? render : null;
  const issues = card.validation.issues;
  return (
    <div className="flex flex-col gap-4">
      <h2 id={headingId} className="font-heading text-lg font-semibold">
        {name}
      </h2>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <div className="min-w-0">
          {editor ??
            (done ? (
              <img
                src={done.url}
                alt={previewAlt(card, fileName, name)}
                className="max-h-[60vh] w-full rounded-control bg-page object-contain"
              />
            ) : (
              <p className="rounded-control bg-page p-4 text-ink-secondary">No preview yet.</p>
            ))}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <dl className="grid grid-cols-[max-content_1fr] items-baseline gap-x-4 gap-y-1">
            <dt className="text-label text-muted-text">Photo</dt>
            <dd>{fileName}</dd>
            <dt className="text-label text-muted-text">File</dt>
            <dd>{done ? renderedFileLabel(done) : 'Not made yet'}</dd>
            <dt className="text-label text-muted-text">Version</dt>
            <dd>{versionDescription(version)}</dd>
            <dt className="text-label text-muted-text">Result</dt>
            <dd>
              <ResultBadge result={resultOf(card, render)} />
            </dd>
          </dl>

          {done?.upscaled && (
            <p className="text-ink-secondary">{upscaledNote(done.width, done.height)}</p>
          )}
          {render?.kind === 'failed' && <p className="text-red-700">{render.message}</p>}

          <section aria-label="Checks" className="flex flex-col gap-2">
            <h3 className="font-heading font-semibold">Checks</h3>
            {!done && <p className="text-ink-secondary">{NOT_RENDERED_NOTE}</p>}
            {issues.length === 0 ? (
              <p className="text-success-text">No problems found.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {issues.map((issue, index) => (
                  <li key={index} className={resultTextClass[issue.level]}>
                    <span className="font-medium">{RESULT_LABEL[issue.level]}:</span>{' '}
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {(card.validation.level === 'fail' || card.overrideFail) && (
            <section aria-label="Export override" className="flex flex-col gap-1">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className={`mt-1 accent-accent ${focusClass}`}
                  checked={card.overrideFail}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    // One change, so one undo step.
                    useSessionStore.getState().updateCard(card.id, (draft) => {
                      draft.overrideFail = checked;
                    });
                  }}
                />
                {OVERRIDE_LABEL}
              </label>
              {card.validation.level !== 'fail' && (
                <p className="text-ink-secondary">{OVERRIDE_NOT_NEEDED}</p>
              )}
            </section>
          )}

          {editor !== undefined && (
            <section aria-label="Rendered file" className="flex flex-col gap-2">
              <h3 className="font-heading font-semibold">Rendered file</h3>
              {done ? (
                <img
                  src={done.url}
                  alt={previewAlt(card, fileName, name)}
                  className="max-h-48 self-start rounded-control bg-page object-contain"
                />
              ) : isPending(render) ? (
                <div className="flex flex-col gap-1">
                  <div
                    role="progressbar"
                    aria-label={`Rendering ${name}`}
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
              ) : (
                <p className="text-ink-secondary">
                  {render?.kind === 'cancelled'
                    ? 'Cancelled before the file was made.'
                    : 'No preview yet.'}
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
