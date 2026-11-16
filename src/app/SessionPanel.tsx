/**
 * Plain controls for creating, saving, loading and clearing a session, so the session store can
 * be tested by hand. Deliberately unstyled beyond basic readability; the real UI and its visual
 * theme come later.
 */

import { useEffect, useRef, useState } from 'react';
import { supportsFolders } from '../lib/session/fsAccess';
import { platforms } from '../lib/platforms';
import {
  currentFolderName,
  downloadBundle,
  loadBundle,
  newSession,
  openSessionFolder,
  reopenLastSession,
  requestClearSession,
  saveSession,
  startAutosave,
} from '../store/persistence';
import { useSessionStore } from '../store/sessionStore';
import type { NewCard } from '../store/sessionStore';

const DISCARD_PROMPT = 'The open session has unsaved changes. Discard them and continue?';
const CLEAR_PROMPT =
  'Clear this session? It will be removed from the app. Nothing on disk will be deleted.';

/**
 * A placeholder card so save, autosave and undo can be exercised before the import panel and
 * the board exist. The placement comes from platforms.json; nothing about it is validated.
 */
function sampleCard(): NewCard | null {
  const spec = platforms.placements[0];
  if (!spec) return null;
  return {
    assetIds: [],
    platform: spec.platform,
    placement: spec.placement,
    status: 'draft',
    edit: {
      crop: { x: 0, y: 0, width: 1, height: 1 },
      overlays: [],
      format: 'jpg',
      quality: 0.9,
    },
    copy: { caption: 'Sample caption', firstComment: '', hashtags: [], altText: '' },
    validation: { level: 'pass', issues: [] },
    overrideFail: false,
    comments: [],
  };
}

/** True when the key event came from a field where Ctrl/Cmd-Z should undo typing instead. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

const buttonClass =
  'rounded border border-slate-400 px-3 py-1 disabled:cursor-not-allowed disabled:opacity-50';

export function SessionPanel() {
  const session = useSessionStore((state) => state.session);
  const dirty = useSessionStore((state) => state.dirty);
  const lastSavedAt = useSessionStore((state) => state.lastSavedAt);
  const status = useSessionStore((state) => state.status);
  const missingAssetIds = useSessionStore((state) => state.missingAssetIds);
  const undoDepth = useSessionStore((state) => state.undoStack.length);
  const [name, setName] = useState('Untitled session');
  const fileInput = useRef<HTMLInputElement>(null);

  const canUseFolders = supportsFolders();
  const folderName = currentFolderName();

  useEffect(() => startAutosave(), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'z';
      if (!isUndo || isTyping(event.target)) return;
      event.preventDefault();
      useSessionStore.getState().undo();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** Replacing the open session loses unsaved changes, so ask first when there are any. */
  function okToReplace(): boolean {
    return !useSessionStore.getState().dirty || window.confirm(DISCARD_PROMPT);
  }

  function onNew() {
    if (okToReplace()) newSession(name.trim() || 'Untitled session');
  }

  function onOpenFolder() {
    if (okToReplace()) void openSessionFolder();
  }

  function onReopen() {
    if (okToReplace()) void reopenLastSession();
  }

  function onPickBundle() {
    if (okToReplace()) fileInput.current?.click();
  }

  function onBundleChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void loadBundle(file, file.name);
  }

  function onAddSampleCard() {
    const card = sampleCard();
    if (card) useSessionStore.getState().addCard(card);
  }

  const missingNames = session
    ? session.assets.filter((asset) => missingAssetIds.includes(asset.id)).map((a) => a.fileName)
    : [];

  const statusColor =
    status?.kind === 'error'
      ? 'text-red-700'
      : status?.kind === 'warning'
        ? 'text-amber-700'
        : 'text-slate-700';

  return (
    <section aria-label="Session" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          Name
          <input
            className="rounded border border-slate-400 px-2 py-1"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button type="button" className={buttonClass} onClick={onNew}>
          New session
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
          onClick={onOpenFolder}
          disabled={!canUseFolders}
        >
          Open folder
        </button>
        <button type="button" className={buttonClass} onClick={onReopen} disabled={!canUseFolders}>
          Reopen last
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => void saveSession()}
          disabled={!session || !canUseFolders}
        >
          Save
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => void downloadBundle()}
          disabled={!session}
        >
          Download .scs
        </button>
        <button type="button" className={buttonClass} onClick={onPickBundle}>
          Load .scs
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".scs,.zip"
          aria-label="Session bundle file"
          className="hidden"
          onChange={onBundleChosen}
        />
        <button
          type="button"
          className={buttonClass}
          onClick={() => void requestClearSession(() => window.confirm(CLEAR_PROMPT))}
          disabled={!session}
        >
          Clear session
        </button>
      </div>

      {!canUseFolders && (
        <p>
          This browser cannot open or save folders. Use Download .scs and Load .scs, or switch to
          Chrome or Edge.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} onClick={onAddSampleCard} disabled={!session}>
          Add sample card (for testing)
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => useSessionStore.getState().undo()}
          disabled={undoDepth === 0}
        >
          Undo ({undoDepth})
        </button>
      </div>

      {session ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt>Session</dt>
          <dd>{session.name}</dd>
          <dt>Folder</dt>
          <dd>{folderName ?? 'None yet'}</dd>
          <dt>Changes</dt>
          <dd>{dirty ? 'Unsaved changes' : 'All changes saved'}</dd>
          <dt>Last saved</dt>
          <dd>{lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString() : 'Not yet'}</dd>
          <dt>Contents</dt>
          <dd>
            {session.assets.length} assets, {session.cards.length} cards
          </dd>
        </dl>
      ) : (
        <p>No session is open.</p>
      )}

      <p role="status" className={statusColor}>
        {status?.message ?? ''}
      </p>

      {missingNames.length > 0 && (
        <p role="alert" className="text-amber-700">
          Missing asset files: {missingNames.join(', ')}
        </p>
      )}
    </section>
  );
}
