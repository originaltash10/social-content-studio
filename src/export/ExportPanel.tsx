/**
 * The export panel: a summary of what an export would include, two ways to export ("Export to
 * session folder" and "Download as .zip"), progress with a Cancel button, and the results.
 *
 * The work is done by runExport (src/lib/export), on its own image worker that is started for
 * the export and stopped when it ends. The panel only gathers what it needs and shows the
 * outcome.
 *
 * - "Export to session folder" asks for the folder before anything else, so the browser's
 *   permission prompt, if needed, appears while the click is still being handled.
 * - Both buttons wait while the board is still making its previews, so the board and an export
 *   never decode full-size photos at the same time.
 * - When an export ends, however it ends, keyboard focus moves to the results heading.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { createImageWorkerClient } from '../lib/render/client';
import type { ImageWorkerClient } from '../lib/render/client';
import { readiness } from '../lib/export/eligibility';
import type { ExportSession, Lookups } from '../lib/export/eligibility';
import {
  BOARD_BUSY_HINT,
  FILTERS_NOTE,
  NO_FOLDER_HINT,
  exportResults,
  exportSummary,
  permissionRefusedText,
  progressText,
} from '../lib/export/messages';
import type { ExportMode, ExportResults } from '../lib/export/messages';
import { zipFileName } from '../lib/export/names';
import { runExport } from '../lib/export/runExport';
import type { ExportProgress, ExportSink } from '../lib/export/runExport';
import { folderSink, zipSink } from '../lib/export/sinks';
import { downloadBlob } from '../lib/session/download';
import { getPlacement } from '../lib/platforms';
import { PLATFORM_LABEL, placementName } from '../lib/board/targets';
import { versionInfo, versionLabel } from '../lib/board/versions';
import type { VersionInfo } from '../lib/board/versions';
import { currentFolderName, exportFolderFor } from '../store/persistence';
import { getAssetBlob, useSessionStore } from '../store/sessionStore';
import { buttonClass } from '../app/styles';

/** The parts of the image worker client an export uses. */
export type ExportClient = Pick<ImageWorkerClient, 'render' | 'cancel' | 'dispose'>;

export type ExportPanelProps = {
  /** True while the board has previews waiting or being made. */
  busy: boolean;
  /** Starts the export's own image worker. Tests pass a fake. */
  createClient?: () => ExportClient;
  /** The open session's folder, after asking for permission. Tests pass a fake. */
  folderFor?: (sessionId: string) => Promise<FileSystemDirectoryHandle | null>;
  /** Hands the zip to the browser. Tests pass a fake. */
  download?: (blob: Blob, fileName: string) => void;
  /** Reads an original's file type. Tests pass a fake; the real one is used by default. */
  sniff?: Lookups['sniff'];
};

export const NO_SESSION_EXPORT_TEXT = 'Start or open a session to export its cards.';
export const UNEXPECTED_TEXT =
  'The export stopped because something unexpected went wrong. Try again; if it keeps ' +
  'happening, reload the page.';

type Running = { mode: ExportMode } & ExportProgress;
type Finished = ExportResults & { failed: boolean };

/** The open session as an export reads it, straight from the store. */
function liveSession(): ExportSession | null {
  const { session, missingAssetIds } = useSessionStore.getState();
  if (!session) return null;
  const { id, name, cards, assets } = session;
  return { id, name, cards, assets, missingAssetIds };
}

/** A card's name as the board shows it, e.g. "Instagram Feed vertical for site.jpg, v1". */
function cardNamer(): (cardId: string) => string {
  const session = useSessionStore.getState().session;
  const cards = session?.cards ?? [];
  const versions = versionInfo(cards);
  return (cardId) => {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return 'A card that is no longer in the session';
    const spec = getPlacement(card.platform, card.placement);
    const name = spec ? placementName(spec) : `${PLATFORM_LABEL[card.platform]} ${card.placement}`;
    const asset = session?.assets.find((a) => a.id === card.assetIds[0]);
    const fileName = asset?.fileName ?? 'a photo that is not in this session';
    return `${name} for ${fileName}, ${versionLabel(versions.get(card.id) as VersionInfo)}`;
  };
}

export function ExportPanel({
  busy,
  createClient = createImageWorkerClient,
  folderFor = exportFolderFor,
  download = downloadBlob,
  sniff,
}: ExportPanelProps) {
  const session = useSessionStore((state) => state.session);
  // The folder a session saves to changes with a save, an open or a clear, each of which sets
  // the status line; reading it makes the panel re-render then.
  useSessionStore((state) => state.status);
  useSessionStore((state) => state.lastSavedAt);
  const folderName = currentFolderName();

  const [running, setRunning] = useState<Running | null>(null);
  const [finished, setFinished] = useState<Finished | null>(null);
  const abort = useRef<AbortController | null>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const hintId = useId();
  const progressId = useId();

  // Results belong to the session they were made for.
  const sessionId = session?.id ?? null;
  const [shownSession, setShownSession] = useState(sessionId);
  if (shownSession !== sessionId) {
    setShownSession(sessionId);
    setFinished(null);
  }

  // When an export ends, however it ends, move keyboard focus to its results.
  useEffect(() => {
    if (finished) resultsHeading.current?.focus();
  }, [finished]);

  // Leaving the page part-way cancels the export.
  useEffect(() => () => abort.current?.abort(), []);

  const cards = session?.cards ?? [];
  const idle = running === null;
  const canZip = session !== null && cards.length > 0 && !busy && idle;
  const canFolder = canZip && folderName !== null;
  const hint =
    !session || cards.length === 0 || !idle
      ? null
      : busy
        ? BOARD_BUSY_HINT
        : folderName === null
          ? NO_FOLDER_HINT
          : null;

  async function run(mode: ExportMode, sink: ExportSink, sessionName: string, folder: string) {
    const controller = new AbortController();
    abort.current = controller;
    let client: ExportClient | null = null;
    let results: Finished;
    try {
      client = createClient();
      const report = await runExport({
        client,
        current: liveSession,
        blobOf: getAssetBlob,
        sink,
        signal: controller.signal,
        onProgress: (progress) => setRunning({ mode, ...progress }),
        ...(sniff ? { sniff } : {}),
      });
      results = {
        ...exportResults({
          report,
          mode,
          folderName: folder,
          zipName: zipFileName(sessionName),
          nameOf: cardNamer(),
        }),
        failed: report.outcome === 'write-error' || report.outcome === 'failed',
      };
    } catch {
      results = { headline: UNEXPECTED_TEXT, notes: [], skipped: [], failed: true };
    } finally {
      client?.dispose();
      abort.current = null;
    }
    setRunning(null);
    setFinished(results);
  }

  function begin(mode: ExportMode, total: number) {
    setFinished(null);
    setRunning({ mode, done: 0, total, cardId: null });
  }

  function exportToFolder() {
    const current = useSessionStore.getState().session;
    if (!current || !idle) return;
    // First, before any other work: this may show the browser's permission prompt, which only
    // appears while the click is being handled.
    const asked = folderFor(current.id);
    const folder = folderName ?? '';
    begin('folder', current.cards.length);
    void (async () => {
      const dir = await asked.catch(() => null);
      if (!dir) {
        setRunning(null);
        setFinished({
          headline: permissionRefusedText(folder),
          notes: [],
          skipped: [],
          failed: true,
        });
        return;
      }
      await run('folder', folderSink(dir), current.name, folder);
    })();
  }

  function exportToZip() {
    const current = useSessionStore.getState().session;
    if (!current || !idle) return;
    begin('zip', current.cards.length);
    void run('zip', zipSink(current.name, download), current.name, '');
  }

  const progressName = running && running.cardId !== null ? cardNamer()(running.cardId) : null;

  return (
    <section aria-label="Export" className="flex flex-col gap-4 rounded-card bg-surface p-6">
      <h2 className="font-heading text-lg font-semibold">Export</h2>

      {!session ? (
        <p className="text-ink-secondary">{NO_SESSION_EXPORT_TEXT}</p>
      ) : (
        <>
          <p>{exportSummary(readiness(cards))}</p>
          <p className="text-ink-secondary">{FILTERS_NOTE}</p>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={buttonClass}
              disabled={!canFolder}
              aria-describedby={hint ? hintId : undefined}
              onClick={exportToFolder}
            >
              Export to session folder
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={!canZip}
              aria-describedby={hint ? hintId : undefined}
              onClick={exportToZip}
            >
              Download as .zip
            </button>
            {running && (
              <button type="button" className={buttonClass} onClick={() => abort.current?.abort()}>
                Cancel export
              </button>
            )}
          </div>
          {hint && (
            <p id={hintId} className="text-ink-secondary">
              {hint}
            </p>
          )}

          {running && (
            <div className="flex flex-col gap-1">
              <label htmlFor={progressId} className="text-label text-muted-text">
                Export progress
              </label>
              <progress
                id={progressId}
                max={Math.max(running.total, 1)}
                value={running.done}
                className="h-2 w-full accent-accent"
              />
            </div>
          )}

          {finished && (
            <section aria-label="Export results" className="flex flex-col gap-2">
              <h3 ref={resultsHeading} tabIndex={-1} className="font-heading font-semibold">
                Export results
              </h3>
              <p className={finished.failed ? 'text-red-700' : undefined}>{finished.headline}</p>
              {finished.notes.map((note) => (
                <p key={note} className="text-ink-secondary">
                  {note}
                </p>
              ))}
              {finished.skipped.length > 0 && (
                <>
                  <p>Left out of this export:</p>
                  <ul aria-label="Cards left out" className="list-disc pl-5">
                    {finished.skipped.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </>
      )}

      <p role="status" aria-label="Export progress messages" className="text-ink-secondary">
        {running ? progressText(running.done, running.total, progressName) : ''}
      </p>
    </section>
  );
}
