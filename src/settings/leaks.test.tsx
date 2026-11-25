/**
 * Leak tests: with a key saved through Settings, a whole session is built, edited, undone,
 * saved, autosaved, downloaded as .scs and exported as a zip and to its folder. Then the key is
 * looked for everywhere it must never be, and found where it must be (the settings key store),
 * so each search is known to be looking at the right value.
 *
 * Real: the Settings dialog, the key store and the folder-handle store (on fake-indexeddb), the
 * session store, persistence, the .scs writer, the export panel, runExport, the sinks and the
 * metadata stripping. Stand-ins: the folder picker and the folder (an in-memory MockDir), the
 * browser download, and the image worker.
 */
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionPanel } from '../app/SessionPanel';
import { downloadBlob } from '../lib/session/download';
import { ExportPanel } from '../export/ExportPanel';
import type { RenderJob } from '../lib/render/protocol';
import { autosave } from '../store/persistence';
import { useSessionStore } from '../store/sessionStore';
import type { NewCard } from '../store/sessionStore';
import { resultFor } from '../test/fakeRenderClient';
import { SECRET, hash, makeAsset, makeCard } from '../test/fixtures';
import { DHT, DQT, EOI, SCAN, SOF0, SOI, jfif, join } from '../test/imageBytes';
import { MockDir } from '../test/mockFs';
import type { ValidationResult } from '../types';
import { SETTINGS_DATABASE, SETTINGS_STORE } from './keyStore';
import { Settings } from './SettingsDialog';

// The folder handle is remembered in the real IndexedDB store. fake-indexeddb can only keep
// plain data, so the in-memory folder is remembered as a plain record of what it is.
vi.mock('../lib/session/handleStore', async (original) => {
  const actual = await original<typeof import('../lib/session/handleStore')>();
  return {
    ...actual,
    rememberFolder: (dir: FileSystemDirectoryHandle) =>
      actual.rememberFolder({ kind: dir.kind, name: dir.name } as FileSystemDirectoryHandle),
  };
});
vi.mock('../lib/session/download', () => ({ downloadBlob: vi.fn() }));

// jsdom has no <dialog> behaviour (see src/board/Board.test.tsx).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

// ---------------------------------------------------------------------------
// Looking for the key
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
/** The key as it could appear in bytes: UTF-8, UTF-16 (either byte order) and base64. */
const NEEDLES: Uint8Array[] = [
  encoder.encode(SECRET),
  new Uint8Array([...SECRET].flatMap((c) => [c.charCodeAt(0), 0])),
  new Uint8Array([...SECRET].flatMap((c) => [0, c.charCodeAt(0)])),
  encoder.encode(btoa(SECRET)),
];

function holds(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** True when the key is anywhere in these bytes, in any of the forms above. */
const bytesHoldKey = (bytes: Uint8Array) => NEEDLES.some((needle) => holds(bytes, needle));
const textHoldsKey = (text: string) => text.includes(SECRET) || text.includes(btoa(SECRET));

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Every file in a zip, by path, unpacked. */
async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(bytes);
  const files = new Map<string, Uint8Array>();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir) files.set(path, await entry.async('uint8array'));
  }
  return files;
}

/** Every file in a MockDir, at any depth, by path. */
async function filesIn(dir: MockDir, prefix = ''): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const [name, blob] of dir.files) files.set(`${prefix}${name}`, await bytesOf(blob));
  for (const [name, child] of dir.dirs) {
    for (const [path, bytes] of await filesIn(child, `${prefix}${name}/`)) files.set(path, bytes);
  }
  return files;
}

/** Every value in every object store of every IndexedDB database, by "database/store". */
async function indexedDbContents(): Promise<Map<string, unknown[]>> {
  const found = new Map<string, unknown[]>();
  for (const { name } of await indexedDB.databases()) {
    if (!name) continue;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const storeName of db.objectStoreNames) {
      const values = await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction(storeName).objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      found.set(`${name}/${storeName}`, values);
    }
    db.close();
  }
  return found;
}

/** Every text and every input value on the page now, closed dialogs included. */
const pageNow = () =>
  [
    document.documentElement.outerHTML,
    document.body.textContent ?? '',
    ...[...document.querySelectorAll('input, textarea, select')].map(
      (element) => (element as HTMLInputElement).value,
    ),
  ].join('\n');

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

const PASS: ValidationResult = { level: 'pass', issues: [] };
const PHOTO = makeAsset({ id: hash('a'), fileName: 'site.jpg' });
const ENCODED = join(SOI, jfif(), DQT, SOF0, DHT, SCAN, EOI);

function newCard(placement: string, platform: 'instagram' | 'linkedin'): NewCard {
  const { id, version, parentId, ...card } = makeCard({
    assetIds: [PHOTO.id],
    platform,
    placement,
    validation: PASS,
    copy: { caption: 'Topping out.', firstComment: 'More soon.', hashtags: ['#site'], altText: '' },
  });
  void [id, version, parentId]; // the store gives these
  return card;
}

/** A worker client that answers every job at once with a clean JPEG. */
const client = {
  render: vi.fn(async (job: RenderJob) =>
    resultFor(job, { blob: new Blob([ENCODED], { type: 'image/jpeg' }) }),
  ),
  cancel: vi.fn(() => false),
  dispose: vi.fn(),
};

async function settle() {
  for (let i = 0; i < 30; i++) await act(() => Promise.resolve());
}

// ---------------------------------------------------------------------------

describe('the saved key never leaves the settings key store', () => {
  const folder = new MockDir('LeakCheck');
  const consoleCalls: unknown[][] = [];
  const shown = new Set<string>();
  const statuses: string[] = [];
  let observer: MutationObserver;
  let scsBytes: Uint8Array;
  let zipBytes: Uint8Array;
  let folderFiles: Map<string, Uint8Array>;
  let undoJson = '';
  /** The page as it was at the end of the run (Testing Library empties it after each test). */
  let pageAtEnd = '';
  /** The page just after the key was saved, with Settings still open. */
  let pageAfterSave = '';

  beforeAll(async () => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      });
    }
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: vi.fn(async () => folder.handle),
      configurable: true,
    });
    const zipDownload = vi.fn();

    // Every piece of text the page shows, however briefly.
    observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        shown.add(target.textContent ?? '');
        for (const node of record.addedNodes) shown.add(node.textContent ?? '');
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    useSessionStore.subscribe((state) => {
      if (state.status) statuses.push(state.status.message);
    });

    render(
      <>
        <Settings />
        <SessionPanel />
        <ExportPanel
          busy={false}
          createClient={() => client}
          download={zipDownload}
          sniff={async () => ({ kind: 'image', format: 'jpeg' })}
        />
      </>,
    );
    const page = within(document.body);

    // 1. The key, saved through Settings as a person would.
    fireEvent.click(page.getByRole('button', { name: 'Settings' }));
    const settings = await screen.findByRole('dialog', { name: 'Settings' });
    await within(settings).findByText('No provider chosen yet.');
    fireEvent.click(within(settings).getByRole('radio', { name: 'Claude (Anthropic)' }));
    await within(settings).findByText('Claude (Anthropic) chosen.');
    const keyBox = within(settings).getByLabelText('Claude (Anthropic) API key');
    fireEvent.change(keyBox, { target: { value: SECRET } });
    fireEvent.keyDown(keyBox, { key: 'Enter' });
    // Waits by the message's start only, so a message with more in it still lets the run go on
    // to the checks below, which are what must catch it.
    const settingsStatus = within(settings).getByRole('status', { name: 'Settings messages' });
    await waitFor(() => expect(settingsStatus.textContent).toMatch(/^Key saved\./));
    // The page while Settings is still open, just after saving: the box must already be empty.
    pageAfterSave = pageNow();
    fireEvent.click(within(settings).getByRole('button', { name: 'Close' }));

    // 2. A session with a photo, two cards, captions, alt text and a brief.
    fireEvent.click(page.getByRole('button', { name: 'New session' }));
    act(() => {
      const store = useSessionStore.getState();
      store.addAssets([{ asset: PHOTO, blob: new Blob([ENCODED], { type: 'image/jpeg' }) }]);
      store.addCard(newCard('feed-vertical', 'instagram'));
      store.addCard(newCard('image-square', 'linkedin'));
      store.setBrief({
        topic: 'Topping out',
        audience: 'Clients',
        cta: 'See the project.',
        link: 'https://example.com',
        tone: 'casual',
      });
    });
    const cardIds = () => useSessionStore.getState().session?.cards.map((card) => card.id) ?? [];
    expect(cardIds()).toHaveLength(2);

    // 3. Edits, an undo with Ctrl-Z on the page, and the same edit made again.
    const writeAltText = () =>
      act(() => {
        for (const id of cardIds()) {
          useSessionStore.getState().updateCard(id, (card) => {
            card.copy.altText = 'A crane lifting the last beam.';
          });
        }
      });
    writeAltText();
    fireEvent.keyDown(page.getByRole('button', { name: 'Settings' }), { key: 'z', ctrlKey: true });
    writeAltText();
    undoJson = JSON.stringify(useSessionStore.getState().undoStack);

    // 4. Save to the folder, then a change and an autosave.
    fireEvent.click(page.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(folder.files.has('session.json')).toBe(true));
    act(() => {
      useSessionStore.getState().updateCard(cardIds()[0] as string, (card) => {
        card.copy.caption = 'Topping out this week.';
      });
    });
    await act(async () => {
      expect(await autosave()).toBe(true);
    });

    // 5. Download .scs.
    fireEvent.click(page.getByRole('button', { name: 'Download .scs' }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    scsBytes = await bytesOf(vi.mocked(downloadBlob).mock.calls.at(-1)?.[0] as Blob);

    // 6. Export as a zip and to the session folder.
    fireEvent.click(page.getByRole('button', { name: 'Download as .zip' }));
    await waitFor(() => expect(zipDownload).toHaveBeenCalled());
    zipBytes = await bytesOf(zipDownload.mock.calls[0]?.[0] as Blob);
    fireEvent.click(page.getByRole('button', { name: 'Export to session folder' }));
    await waitFor(() => expect(folder.dirs.get('exports')?.dirs.size ?? 0).toBeGreaterThan(0));
    await settle();
    folderFiles = await filesIn(folder);
    pageAtEnd = pageNow();
  });

  afterAll(() => {
    observer.disconnect();
    vi.restoreAllMocks();
  });

  it('IS in the settings key store, so every search below is looking for the right value', async () => {
    const stores = await indexedDbContents();
    expect(stores.get(`${SETTINGS_DATABASE}/${SETTINGS_STORE}`)).toContain(SECRET);
  });

  it('the run really made every file it is checked against', () => {
    expect([...folderFiles.keys()]).toEqual(
      expect.arrayContaining([
        'session.json',
        'brand.json',
        `assets/${PHOTO.id}`,
        expect.stringMatching(/^exports\/instagram\/.+\.jpg$/),
        expect.stringMatching(/^exports\/linkedin\/.+\.jpg$/),
        'exports/captions.csv',
      ]),
    );
    expect(scsBytes.length).toBeGreaterThan(0);
    expect(zipBytes.length).toBeGreaterThan(0);
    expect(undoJson).toContain('A crane lifting the last beam.');
    expect(statuses.some((message) => message.startsWith('Saved'))).toBe(true);
  });

  it('is not in session.json or any other file in the session folder, exports included', () => {
    const sessionJson = new TextDecoder().decode(folderFiles.get('session.json'));
    expect(sessionJson).toContain('Topping out this week.');
    expect(textHoldsKey(sessionJson)).toBe(false);
    for (const [path, bytes] of folderFiles) expect(bytesHoldKey(bytes), path).toBe(false);
  });

  it('is not in the folder export files or its captions.csv', () => {
    const exported = [...folderFiles].filter(([path]) => path.startsWith('exports/'));
    expect(exported.length).toBeGreaterThanOrEqual(3);
    for (const [path, bytes] of exported) expect(bytesHoldKey(bytes), path).toBe(false);
    const [, csv] = exported.find(([path]) => path.endsWith('captions.csv')) ?? [];
    const csvText = new TextDecoder().decode(csv);
    expect(csvText).toContain('A crane lifting the last beam.');
    expect(textHoldsKey(csvText)).toBe(false);
  });

  it('is not in the .scs bundle, as bytes or in any file inside it', async () => {
    expect(bytesHoldKey(scsBytes)).toBe(false);
    const inside = await unzip(scsBytes);
    expect([...inside.keys()]).toContain('session.json');
    for (const [path, bytes] of inside) expect(bytesHoldKey(bytes), path).toBe(false);
  });

  it('is not in the export zip, as bytes or in any file inside it, captions.csv included', async () => {
    expect(bytesHoldKey(zipBytes)).toBe(false);
    const inside = await unzip(zipBytes);
    expect([...inside.keys()].some((path) => path.endsWith('captions.csv'))).toBe(true);
    for (const [path, bytes] of inside) expect(bytesHoldKey(bytes), path).toBe(false);
  });

  it('is not in the session store or its undo history', () => {
    const state = useSessionStore.getState();
    expect(state.undoStack.length).toBeGreaterThan(0);
    expect(textHoldsKey(JSON.stringify(state))).toBe(false);
    expect(textHoldsKey(JSON.stringify(state.undoStack))).toBe(false);
    expect(textHoldsKey(undoJson)).toBe(false);
  });

  it('is not in localStorage or sessionStorage', () => {
    const all = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, i) => {
        const name = storage.key(i) ?? '';
        return `${name}=${storage.getItem(name) ?? ''}`;
      }).join('\n');
    expect(textHoldsKey(all(localStorage))).toBe(false);
    expect(textHoldsKey(all(sessionStorage))).toBe(false);
  });

  it('is not in the folder-handle IndexedDB store, or any store but its own', async () => {
    const stores = await indexedDbContents();
    expect(stores.get('social-content-studio-session/handles')).toEqual([
      { kind: 'directory', name: 'LeakCheck' },
    ]);
    for (const [name, values] of stores) {
      if (name === `${SETTINGS_DATABASE}/${SETTINGS_STORE}`) continue;
      expect(textHoldsKey(JSON.stringify(values)), name).toBe(false);
    }
  });

  it('is not on the page, just after saving or at the end: no text, no attribute and no input value', () => {
    expect(pageAfterSave).toContain('Claude (Anthropic) API key');
    expect(textHoldsKey(pageAfterSave)).toBe(false);
    expect(pageAtEnd).toContain('Untitled session');
    expect(pageAtEnd).toContain('Settings');
    expect(textHoldsKey(pageAtEnd)).toBe(false);
  });

  it('was never in any message the page showed, or in the status line', () => {
    expect([...shown].some((text) => text.includes('Key saved.'))).toBe(true);
    expect(statuses.length).toBeGreaterThan(2);
    for (const text of shown) expect(textHoldsKey(text)).toBe(false);
    for (const message of statuses) expect(textHoldsKey(message)).toBe(false);
  });

  it('was never written to the console', () => {
    expect(textHoldsKey(consoleCalls.map((args) => args.map(String).join(' ')).join('\n'))).toBe(
      false,
    );
  });
});
