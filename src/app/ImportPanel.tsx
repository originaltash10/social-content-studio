/**
 * The import panel: a drop zone and a "Choose files" button that turn photos into assets, a
 * per-file result list, and a grid of thumbnails for the assets in the open session.
 *
 * The work is done by src/lib/image; this file connects it to the session store. Assets are
 * added with the store's existing addAssets action, so saving, autosave and undo are unchanged.
 * Thumbnails are held here as object URLs, in memory only, and are made again from the stored
 * asset files whenever a session is opened.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { importFiles } from '../lib/image/importFiles';
import type { FileProgress, ImportOutcome } from '../lib/image/importFiles';
import { rebuildThumbnail } from '../lib/image/rebuild';
import { ThumbnailUrls } from '../lib/image/thumbnailUrls';
import { getAssetBlob, useSessionStore } from '../store/sessionStore';
import { buttonClass } from './styles';

/** What the file picker offers. Dropped files are not limited by this; contents decide. */
const ACCEPT = '.jpg,.jpeg,.png,.heic,.heif';

const SESSION_CHANGED =
  'Not added, because the session was closed or changed while this file was being imported. ' +
  'Add it again in the session you want it in.';

const store = () => useSessionStore.getState();

/** One line for screen readers and the summary under the drop zone. */
function summarize(rows: readonly FileProgress[], busy: boolean): string {
  if (rows.length === 0) return '';
  const done = rows.filter((row) => row.state === 'done');
  if (busy) {
    const current = rows.find((row) => row.state === 'working');
    const position = Math.min(done.length + 1, rows.length);
    return `Importing ${position} of ${rows.length}${current ? `: ${current.fileName}` : ''}…`;
  }
  const count = (status: ImportOutcome['status']) =>
    done.filter((row) => row.outcome.status === status).length;
  const parts = [
    [count('imported'), 'added'],
    [count('restored'), 'restored'],
    [count('duplicate'), 'already imported'],
    [count('failed'), 'not imported'],
  ] as const;
  const text = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return `Import finished: ${text.join(', ')}.`;
}

function rowText(row: FileProgress): { message: string; note?: string; color: string } {
  if (row.state === 'waiting') return { message: 'Waiting…', color: 'text-muted-text' };
  if (row.state === 'working') return { message: 'Working…', color: 'text-muted-text' };
  const { outcome } = row;
  const color =
    outcome.status === 'failed'
      ? 'text-highlight-text'
      : outcome.status === 'duplicate'
        ? 'text-ink-secondary'
        : 'text-success-text';
  const note = outcome.status === 'imported' ? outcome.note : undefined;
  return { message: outcome.message, color, ...(note === undefined ? {} : { note }) };
}

export function ImportPanel() {
  const session = useSessionStore((state) => state.session);
  const missingAssetIds = useSessionStore((state) => state.missingAssetIds);
  const sessionId = session?.id ?? null;
  const assets = session?.assets;

  const [urls] = useState(() => new ThumbnailUrls());
  const thumbnails = useSyncExternalStore(urls.subscribe, urls.snapshot);
  const [rows, setRows] = useState<FileProgress[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const mounted = useRef(false);

  // A file dropped beside the drop zone would otherwise make the browser leave the app to show
  // that file, losing unsaved work. While this panel is on screen, a stray drop does nothing.
  useEffect(() => {
    const ignore = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', ignore);
    window.addEventListener('drop', ignore);
    return () => {
      window.removeEventListener('dragover', ignore);
      window.removeEventListener('drop', ignore);
    };
  }, []);

  // Release every thumbnail when the session is closed or replaced, and when the panel goes away.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      urls.clear();
    };
  }, [urls, sessionId]);

  // Make thumbnails for assets that have none yet: all of them after a session is opened or the
  // page is reloaded. One at a time, so only one full-size image is decoded at once.
  useEffect(() => {
    let cancelled = false;
    const list = assets ?? [];
    urls.keepOnly(list.map((asset) => asset.id));
    void (async () => {
      for (const asset of list) {
        if (urls.has(asset.id)) continue;
        const blob = getAssetBlob(asset.id);
        if (!blob) continue;
        const thumbnail = await rebuildThumbnail(blob, asset.fileName);
        if (cancelled) return;
        if (!urls.has(asset.id)) urls.set(asset.id, thumbnail);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [urls, sessionId, assets, missingAssetIds]);

  /** Adds a finished file to the session it was dropped into, and keeps its thumbnail. */
  function commit(outcome: ImportOutcome, startedIn: string): ImportOutcome {
    if (outcome.status !== 'imported' && outcome.status !== 'restored') return outcome;
    if (store().session?.id !== startedIn) {
      return { status: 'failed', reason: 'unexpected', message: SESSION_CHANGED };
    }
    if (mounted.current) urls.set(outcome.asset.id, outcome.thumbnail);
    store().addAssets([{ asset: outcome.asset, blob: outcome.blob }]);
    return outcome;
  }

  async function startImport(files: File[]) {
    const startedIn = store().session?.id;
    if (!startedIn || running.current || files.length === 0) return;
    running.current = true;
    setBusy(true);
    setRows([]);
    await importFiles(files, {
      known: () => {
        const { session: open, missingAssetIds: missing } = store();
        return open?.id === startedIn
          ? { assets: open.assets, missingAssetIds: missing }
          : { assets: [], missingAssetIds: [] };
      },
      onProgress: (index, progress) => {
        const shown: FileProgress =
          progress.state === 'done'
            ? { ...progress, outcome: commit(progress.outcome, startedIn) }
            : progress;
        setRows((previous) => {
          const next = [...previous];
          next[index] = shown;
          return next;
        });
      },
    });
    running.current = false;
    setBusy(false);
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    void startImport([...event.dataTransfer.files]);
  }

  function onDragOver(event: React.DragEvent) {
    event.preventDefault();
    if (session && !busy) setDragging(true);
  }

  function onFilesChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    void startImport(files);
  }

  const ready = session !== null && !busy;
  const hint = !session
    ? 'Start or open a session first. Photos are added to the open session.'
    : busy
      ? 'Importing. You can add more when this batch has finished.'
      : 'Drop JPG, PNG or HEIC photos here, or use Choose files.';

  return (
    <section aria-label="Import" className="flex flex-col gap-4 rounded-card bg-surface p-6">
      <h2 className="font-heading text-lg font-semibold">Import photos</h2>

      <div
        role="group"
        aria-label="Drop zone for photos"
        aria-disabled={!ready}
        data-dragging={dragging}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center gap-3 rounded-card border-2 border-dashed p-6 text-center focus-within:border-accent ${
          dragging ? 'border-accent bg-page' : 'border-muted bg-surface'
        }`}
      >
        <p className={ready ? 'text-ink' : 'text-ink-secondary'}>{hint}</p>
        <button
          type="button"
          className={buttonClass}
          onClick={() => fileInput.current?.click()}
          disabled={!ready}
        >
          Choose files
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          aria-label="Photos to import"
          className="hidden"
          onChange={onFilesChosen}
        />
      </div>

      <p role="status" aria-live="polite" className="text-ink-secondary">
        {summarize(rows, busy)}
      </p>

      {rows.length > 0 && (
        <ul aria-label="Import results" aria-busy={busy} className="flex flex-col gap-2">
          {rows.map((row, index) => {
            const { message, note, color } = rowText(row);
            return (
              <li key={index} className="flex flex-col">
                <span className="font-medium break-all text-ink">{row.fileName}</span>
                <span className={color}>{message}</span>
                {note && <span className="text-ink-secondary">{note}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {session && session.assets.length > 0 && (
        <ul
          aria-label="Imported photos"
          className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4"
        >
          {session.assets.map((asset) => {
            const url = thumbnails.get(asset.id);
            const placeholder = missingAssetIds.includes(asset.id)
              ? 'File missing'
              : thumbnails.has(asset.id)
                ? 'No preview'
                : 'Loading preview…';
            return (
              <li key={asset.id} className="flex flex-col gap-1">
                <div className="flex aspect-square items-center justify-center overflow-hidden rounded-control bg-page">
                  {url ? (
                    <img src={url} alt="" className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className="text-label text-muted-text">{placeholder}</span>
                  )}
                </div>
                <span className="truncate text-ink" title={asset.fileName}>
                  {asset.fileName}
                </span>
                <span className="text-label text-muted-text">
                  {asset.width} x {asset.height}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-label text-muted-text">
        Photos stay on this computer. Video is not supported yet.
      </p>
    </section>
  );
}
