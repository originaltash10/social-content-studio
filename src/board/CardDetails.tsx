/**
 * One card in the board's dialog: the editor for its crop (or, for a card that cannot be edited,
 * its preview), with the file, the version and every check in full. The editor sits beside the
 * details on a wide screen and above them on a narrow one.
 *
 * A card whose latest result is Fail also shows the export override (SPEC.md: "Fail blocks
 * export unless overridden"). It stays visible while the override is ticked, so it can always be
 * unticked, even after the card stops failing.
 *
 * A card the editor can open also shows its file type (JPG or PNG) and JPG quality. A card
 * without the editor (its photo is not in the session, or it is not a single-photo card) cannot
 * be made into a file, so it has no file settings to change either.
 */

import type { ReactNode } from 'react';

import type { CardRender } from '../lib/board/controller';
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
import { isImageEdit } from '../lib/board/renderValidation';
import { useSessionStore } from '../store/sessionStore';
import type { Card } from '../types';
import { focusClass, resultTextClass } from '../app/styles';
import type { DialogUndo } from './dialogUndo';
import { FileTypeControls } from './FileTypeControls';
import { UPDATING_TEXT, useLastDone } from './lastDone';
import { RenderedFile } from './RenderedFile';
import { ResultBadge } from './ResultBadge';

export type CardDetailsProps = {
  card: Card;
  name: string;
  fileName: string;
  render: CardRender | undefined;
  /** The placement's size, to shape the rendered file's box before the first file. */
  size?: { width: number; height: number } | null;
  version: VersionInfo;
  headingId: string;
  /** The editor for this card. Without one, the rendered preview is shown instead. */
  editor?: ReactNode;
  /** The dialog's undo; each change made here is recorded as one of the dialog's steps. */
  undo?: DialogUndo;
};

/** Without a dialog undo, a change is simply made. */
const runChange = (change: () => void) => change();

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
  size = null,
  version,
  headingId,
  editor,
  undo,
}: CardDetailsProps) {
  const record = undo?.record ?? runChange;
  const done = render?.kind === 'done' ? render : null;
  // The last finished file, kept while the card is rendered again so nothing changes size.
  const shown = useLastDone(card.id, render);
  const updating = shown !== null && done === null;
  const hasFileArea = editor !== undefined;
  const issues = card.validation.issues;
  return (
    <div className="flex flex-col gap-4">
      {/* The card dialog puts focus here when it opens, so Tab then starts at the editor. */}
      <h2 id={headingId} tabIndex={-1} className="font-heading text-lg font-semibold">
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
            <dd>{done ? renderedFileLabel(done) : updating ? UPDATING_TEXT : 'Not made yet'}</dd>
            <dt className="text-label text-muted-text">Version</dt>
            <dd>{versionDescription(version)}</dd>
            <dt className="text-label text-muted-text">Result</dt>
            <dd>
              <ResultBadge result={resultOf(card, render)} />
            </dd>
          </dl>

          {/* During a re-render, the last file's note stays until the new result arrives. */}
          {shown?.upscaled && (
            <p className="text-ink-secondary">{upscaledNote(shown.width, shown.height)}</p>
          )}
          {/* With a Rendered file area, a failure is said there instead, in the file's place. */}
          {render?.kind === 'failed' && !hasFileArea && (
            <p className="text-red-700">{render.message}</p>
          )}

          <section aria-label="Checks" className="flex flex-col gap-2">
            <h3 className="font-heading font-semibold">Checks</h3>
            {!shown && <p className="text-ink-secondary">{NOT_RENDERED_NOTE}</p>}
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

          {editor !== undefined && isImageEdit(card.edit) && (
            <FileTypeControls cardId={card.id} edit={card.edit} record={record} undo={undo} />
          )}

          {(card.validation.level === 'fail' || card.overrideFail) && (
            <section aria-label="Export override" className="flex flex-col gap-1">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className={`mt-1 accent-accent ${focusClass}`}
                  checked={card.overrideFail}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    // One change, so one undo step, which the dialog's Ctrl/Cmd-Z can reverse.
                    record(() => {
                      useSessionStore.getState().updateCard(card.id, (draft) => {
                        draft.overrideFail = checked;
                      });
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

          {hasFileArea && (
            // Busy while a file is being made. There is no live region here, so the renders
            // made while the crop moves are not announced; the board's progress line still is.
            <section
              aria-label="Rendered file"
              aria-busy={isPending(render)}
              className="flex flex-col gap-2"
            >
              <h3 className="font-heading font-semibold">Rendered file</h3>
              <RenderedFile
                render={render}
                shown={shown}
                alt={previewAlt(card, fileName, name)}
                progressName={`Rendering ${name}`}
                size={size}
              />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
