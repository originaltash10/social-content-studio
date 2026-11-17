/**
 * The read-only details of one card, shown in the board's dialog: a larger preview, the file,
 * the version, and every check in full. The editor replaces this in a later step.
 */

import type { CardRender } from '../lib/board/controller';
import type { VersionInfo } from '../lib/board/versions';
import { versionDescription } from '../lib/board/versions';
import {
  RESULT_LABEL,
  previewAlt,
  renderedFileLabel,
  resultOf,
  upscaledNote,
} from '../lib/board/view';
import type { Card } from '../types';
import { resultTextClass } from '../app/styles';
import { ResultBadge } from './ResultBadge';

export type CardDetailsProps = {
  card: Card;
  name: string;
  fileName: string;
  render: CardRender | undefined;
  version: VersionInfo;
  headingId: string;
};

export const NOT_RENDERED_NOTE =
  'The file has not been made yet, so these checks use the planned size, and the file size is not checked.';

export function CardDetails({
  card,
  name,
  fileName,
  render,
  version,
  headingId,
}: CardDetailsProps) {
  const done = render?.kind === 'done' ? render : null;
  const issues = card.validation.issues;
  return (
    <div className="flex flex-col gap-4">
      <h2 id={headingId} className="font-heading text-lg font-semibold">
        {name}
      </h2>

      {done ? (
        <img
          src={done.url}
          alt={previewAlt(card, fileName, name)}
          className="max-h-[60vh] w-full rounded-control bg-page object-contain"
        />
      ) : (
        <p className="rounded-control bg-page p-4 text-ink-secondary">No preview yet.</p>
      )}

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
        <p className="text-highlight-text">{upscaledNote(done.width, done.height)}</p>
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
                <span className="font-medium">{RESULT_LABEL[issue.level]}:</span> {issue.message}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
