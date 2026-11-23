/**
 * Export panel tests. The store, runExport, the sinks and the metadata stripping are real; the
 * image worker, the folder (an in-memory mock), the permission request and the download are
 * fakes. The folder the session saves to is set through a mock of currentFolderName.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenderError } from '../lib/render/protocol';
import type { RenderJob, RenderResult } from '../lib/render/protocol';
import { EARLIER_FILES_NOTE, FILTERS_NOTE, NO_FOLDER_HINT } from '../lib/export/messages';
import { findMetadata } from '../lib/export/metadata';
import { useSessionStore } from '../store/sessionStore';
import type { NewCard } from '../store/sessionStore';
import { fakeRenderClient, resultFor } from '../test/fakeRenderClient';
import type { FakeRenderClient } from '../test/fakeRenderClient';
import { hash, makeAsset, makeCard } from '../test/fixtures';
import { DHT, DQT, EOI, ICC, SCAN, SOF0, SOI, exif, jfif, join } from '../test/imageBytes';
import { MockDir, domError } from '../test/mockFs';
import type { Card, ValidationResult } from '../types';
import { ExportPanel, NO_SESSION_EXPORT_TEXT, UNEXPECTED_TEXT } from './ExportPanel';
import type { ExportClient, ExportPanelProps } from './ExportPanel';

const folder = vi.hoisted(() => ({ name: null as string | null }));
vi.mock('../store/persistence', () => ({
  currentFolderName: () => folder.name,
  exportFolderFor: vi.fn(),
}));

const BUSY_HINT = 'Export will be available when the board has finished making its previews.';
const PHOTO = makeAsset({ id: hash('a'), fileName: 'site.jpg' });
const ENCODED = join(SOI, jfif(), exif('II'), ICC, DQT, SOF0, DHT, SCAN, EOI);
const PASS: ValidationResult = { level: 'pass', issues: [] };

const store = () => useSessionStore.getState();
const button = (name: string) => screen.getByRole('button', { name });
const results = () => screen.getByRole('region', { name: 'Export results' });
const progressStatus = () => screen.getByRole('status', { name: 'Export progress messages' });

function newCard(overrides: Partial<Card> = {}): NewCard {
  const { id, version, parentId, ...card } = makeCard({
    assetIds: [PHOTO.id],
    validation: PASS,
    copy: { caption: '', firstComment: '', hashtags: [], altText: 'A crane.' },
    ...overrides,
  });
  void [id, version, parentId]; // the store gives these
  return card;
}

/** Opens a session with one photo and the given cards. */
function openSession(...cards: NewCard[]) {
  act(() => {
    store().createSession('Topping out');
    store().addAssets([{ asset: PHOTO, blob: new Blob(['photo']) }]);
    for (const card of cards) store().addCard(card);
  });
}

const encoded = (job: RenderJob, overrides: Partial<RenderResult> = {}) =>
  resultFor(job, { blob: new Blob([ENCODED]), ...overrides });

/** A worker client that answers every job at once. */
function autoClient(answer: (job: RenderJob) => RenderResult = (job) => encoded(job)) {
  return {
    render: vi.fn(async (job: RenderJob) => answer(job)),
    cancel: vi.fn(() => false),
    dispose: vi.fn(),
  };
}

const sniff: ExportPanelProps['sniff'] = async () => ({ kind: 'image', format: 'jpeg' });

function renderPanel(props: Partial<ExportPanelProps> = {}) {
  const client = autoClient();
  const all: ExportPanelProps = {
    busy: false,
    createClient: () => client,
    folderFor: vi.fn(async () => null),
    download: vi.fn(),
    sniff,
    ...props,
  };
  return { ...render(<ExportPanel {...all} />), props: all, client };
}

/** Lets the export's promises run, inside act. */
async function settle() {
  for (let i = 0; i < 20; i++) await act(() => Promise.resolve());
}

beforeEach(() => {
  folder.name = 'Topping out';
  act(() => {
    store().clearSession(() => true);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('before exporting', () => {
  it('asks for a session first', () => {
    renderPanel();
    expect(screen.getByText(NO_SESSION_EXPORT_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download as .zip' })).toBeNull();
  });

  it('summarises every card in the session, not just the ones the board shows', () => {
    openSession(
      newCard(),
      newCard({ placement: 'feed-square' }),
      newCard({ validation: { level: 'fail', issues: [] } }),
    );
    renderPanel();
    expect(
      screen.getByText('All 3 cards in this session: 2 can be exported, 1 fails its checks.'),
    ).toBeInTheDocument();
    expect(screen.getByText(FILTERS_NOTE)).toBeInTheDocument();
  });

  it('counts an overridden failing card as one that can be exported', () => {
    openSession(newCard({ validation: { level: 'fail', issues: [] }, overrideFail: true }));
    renderPanel();
    expect(screen.getByText('The 1 card in this session can be exported.')).toBeInTheDocument();
  });

  it('offers both ways to export when the session has a folder', () => {
    openSession(newCard());
    renderPanel();
    expect(button('Export to session folder')).toBeEnabled();
    expect(button('Download as .zip')).toBeEnabled();
    expect(screen.queryByText(NO_FOLDER_HINT)).toBeNull();
    expect(screen.queryByText(BUSY_HINT)).toBeNull();
  });

  it('offers only the zip, with a hint, when the session has no folder', () => {
    folder.name = null;
    openSession(newCard());
    renderPanel();
    expect(button('Export to session folder')).toBeDisabled();
    expect(button('Download as .zip')).toBeEnabled();
    const hint = screen.getByText(NO_FOLDER_HINT);
    expect(button('Export to session folder')).toHaveAttribute('aria-describedby', hint.id);
  });

  it('offers neither when there are no cards', () => {
    openSession();
    renderPanel();
    expect(button('Export to session folder')).toBeDisabled();
    expect(button('Download as .zip')).toBeDisabled();
  });
});

describe('while the board is making previews', () => {
  it('disables both buttons and says why', () => {
    openSession(newCard());
    renderPanel({ busy: true });
    expect(button('Export to session folder')).toBeDisabled();
    expect(button('Download as .zip')).toBeDisabled();
    const hint = screen.getByText(BUSY_HINT);
    expect(button('Export to session folder')).toHaveAttribute('aria-describedby', hint.id);
    expect(button('Download as .zip')).toHaveAttribute('aria-describedby', hint.id);
  });

  it('enables them again once the board has finished', () => {
    openSession(newCard());
    const { rerender, props } = renderPanel({ busy: true });
    rerender(<ExportPanel {...props} busy={false} />);
    expect(button('Export to session folder')).toBeEnabled();
    expect(button('Download as .zip')).toBeEnabled();
    expect(screen.queryByText(BUSY_HINT)).toBeNull();
  });

  it('shows the board hint rather than the folder hint', () => {
    folder.name = null;
    openSession(newCard());
    renderPanel({ busy: true });
    expect(screen.getByText(BUSY_HINT)).toBeInTheDocument();
    expect(screen.queryByText(NO_FOLDER_HINT)).toBeNull();
  });
});

describe('Export to session folder', () => {
  it('asks for the folder first, before any other work, while the click is handled', async () => {
    openSession(newCard());
    const order: string[] = [];
    let grant: (dir: FileSystemDirectoryHandle | null) => void = () => undefined;
    const folderFor = vi.fn(
      () =>
        new Promise<FileSystemDirectoryHandle | null>((resolve) => {
          order.push('folderFor');
          grant = resolve;
        }),
    );
    const client = autoClient();
    const createClient = vi.fn(() => {
      order.push('createClient');
      return client;
    });
    const sniffSpy = vi.fn(async () => {
      order.push('sniff');
      return { kind: 'image', format: 'jpeg' } as const;
    });
    renderPanel({ folderFor, createClient, sniff: sniffSpy });

    fireEvent.click(button('Export to session folder'));
    // Called synchronously inside the click, and nothing else has started.
    expect(folderFor).toHaveBeenCalledTimes(1);
    expect(folderFor).toHaveBeenCalledWith(store().session?.id);
    expect(order).toEqual(['folderFor']);
    expect(progressStatus()).toHaveTextContent('Starting the export');

    await settle();
    expect(order).toEqual(['folderFor']);
    grant(new MockDir().handle);
    await settle();
    expect(order).toEqual(['folderFor', 'createClient', 'sniff']);
  });

  it('writes clean files and captions.csv into exports/, and says older files may remain', async () => {
    openSession(newCard(), newCard({ platform: 'linkedin', placement: 'image-square' }));
    const dir = new MockDir('Topping out');
    const { client } = renderPanel({ folderFor: async () => dir.handle });
    fireEvent.click(button('Export to session folder'));
    await settle();

    const exportsDir = dir.dirs.get('exports') as MockDir;
    const instagram = [...(exportsDir.dirs.get('instagram')?.files.values() ?? [])];
    const linkedin = [...(exportsDir.dirs.get('linkedin')?.files.values() ?? [])];
    expect(instagram).toHaveLength(1);
    expect(linkedin).toHaveLength(1);
    for (const blob of [...instagram, ...linkedin]) {
      expect(findMetadata(new Uint8Array(await blob.arrayBuffer()))).toEqual([]);
    }
    expect(exportsDir.files.has('captions.csv')).toBe(true);

    const region = results();
    expect(
      within(region).getByText(
        'Exported 2 files and captions.csv to the exports folder in folder "Topping out".',
      ),
    ).toBeInTheDocument();
    expect(within(region).getByText(EARLIER_FILES_NOTE)).toBeInTheDocument();
    expect(within(region).getByRole('heading', { name: 'Export results' })).toHaveFocus();
    expect(client.dispose).toHaveBeenCalledTimes(1);
    expect(button('Export to session folder')).toBeEnabled();
  });

  it('exports nothing when permission is refused, and says so', async () => {
    openSession(newCard());
    const createClient = vi.fn(() => autoClient());
    renderPanel({ folderFor: async () => null, createClient });
    fireEvent.click(button('Export to session folder'));
    await settle();
    expect(
      within(results()).getByText(
        'Permission to write to folder "Topping out" was not granted. Nothing was exported.',
      ),
    ).toHaveClass('text-danger-text');
    expect(createClient).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Export results' })).toHaveFocus();
  });

  it('treats a permission request that fails as refused', async () => {
    openSession(newCard());
    renderPanel({ folderFor: () => Promise.reject(domError('SecurityError')) });
    fireEvent.click(button('Export to session folder'));
    await settle();
    expect(within(results()).getByText(/was not granted/)).toBeInTheDocument();
  });

  it('reports a write that fails, and focuses the results', async () => {
    openSession(newCard());
    const dir = new MockDir();
    dir.shared.beforeClose = () => {
      throw domError('QuotaExceededError');
    };
    renderPanel({ folderFor: async () => dir.handle });
    fireEvent.click(button('Export to session folder'));
    await settle();
    expect(within(results()).getByText(/There is not enough space on the disk\./)).toHaveClass(
      'text-danger-text',
    );
    expect(screen.getByRole('heading', { name: 'Export results' })).toHaveFocus();
  });
});

describe('Download as .zip', () => {
  it('downloads one zip and reports it, without the folder note', async () => {
    openSession(newCard());
    const download = vi.fn();
    renderPanel({ download });
    fireEvent.click(button('Download as .zip'));
    await settle();
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[1]).toBe('Topping-out_export.zip');
    expect(
      within(results()).getByText(
        'Downloaded "Topping-out_export.zip" with 1 file and captions.csv.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(EARLIER_FILES_NOTE)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Export results' })).toHaveFocus();
  });

  it('lists every card left out, by name, with the reason', async () => {
    openSession(newCard(), newCard({ placement: 'feed-square' }));
    const client = autoClient((job) =>
      job.id === 'export-1' ? encoded(job, { width: job.plan.target.width - 10 }) : encoded(job),
    );
    renderPanel({ createClient: () => client });
    fireEvent.click(button('Download as .zip'));
    await settle();
    const list = within(results()).getByRole('list', { name: 'Cards left out' });
    expect(
      within(list).getByText(/^Instagram Feed vertical for site\.jpg, v1: fails its checks\./),
    ).toBeInTheDocument();
  });

  for (const [what, change] of [
    ['file type', (edit: { format: string; quality: number }) => void (edit.format = 'png')],
    ['quality', (edit: { format: string; quality: number }) => void (edit.quality = 0.4)],
  ] as const) {
    it(`lists a card whose ${what} changed while its file was being made as changed`, async () => {
      openSession(newCard());
      const client = autoClient((job) => {
        // The change arrives while the worker is making the file.
        act(() => {
          const id = store().session?.cards[0]?.id as string;
          store().updateCard(id, (card) => {
            if ('format' in card.edit) change(card.edit);
          });
        });
        return encoded(job);
      });
      const { props } = renderPanel({ createClient: () => client });
      fireEvent.click(button('Download as .zip'));
      await settle();
      const list = within(results()).getByRole('list', { name: 'Cards left out' });
      expect(
        within(list).getByText(
          /^Instagram Feed vertical for site\.jpg, v1: This card changed while its file was being made/,
        ),
      ).toBeInTheDocument();
      expect(props.download).not.toHaveBeenCalled();
    });
  }

  it('reports something unexpected in plain words', async () => {
    openSession(newCard());
    renderPanel({
      createClient: () => {
        throw new Error('no worker');
      },
    });
    fireEvent.click(button('Download as .zip'));
    await settle();
    expect(within(results()).getByText(UNEXPECTED_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Export results' })).toHaveFocus();
  });
});

describe('progress and cancelling', () => {
  let client: FakeRenderClient;
  const fake = (): ExportClient => {
    client = fakeRenderClient();
    return client;
  };

  it('shows which card is being exported, and a Cancel button', async () => {
    openSession(newCard(), newCard({ platform: 'linkedin', placement: 'image-square' }));
    renderPanel({ createClient: fake });
    fireEvent.click(button('Download as .zip'));
    await act(() => client.sent(1));
    expect(progressStatus()).toHaveTextContent(
      'Exporting 1 of 2: Instagram Feed vertical for site.jpg, v1',
    );
    expect(screen.getByRole('progressbar', { name: 'Export progress' })).toBeInTheDocument();
    expect(button('Download as .zip')).toBeDisabled();
    expect(button('Export to session folder')).toBeDisabled();
    expect(button('Cancel export')).toBeEnabled();
  });

  it('cancels, downloads nothing, and focuses the results', async () => {
    openSession(newCard(), newCard({ placement: 'feed-square' }));
    const download = vi.fn();
    renderPanel({ createClient: fake, download });
    fireEvent.click(button('Download as .zip'));
    await act(() => client.sent(1));
    fireEvent.click(button('Cancel export'));
    await settle();
    expect(client.cancelled).toEqual(['export-1']);
    expect(
      within(results()).getByText('Export cancelled. Nothing was downloaded.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Export results' })).toHaveFocus();
    expect(download).not.toHaveBeenCalled();
    expect(client.disposed).toBe(true);
    expect(screen.queryByRole('button', { name: 'Cancel export' })).toBeNull();
    expect(progressStatus()).toHaveTextContent('');
  });

  it('cancels a folder export and keeps what was written, listed in captions.csv', async () => {
    openSession(newCard(), newCard({ placement: 'feed-square' }));
    const dir = new MockDir();
    renderPanel({ createClient: fake, folderFor: async () => dir.handle });
    fireEvent.click(button('Export to session folder'));
    await act(() => client.sent(1));
    const first = client.calls[0];
    await act(async () => first?.resolve(encoded(first.job)));
    await act(() => client.sent(2));
    fireEvent.click(button('Cancel export'));
    await settle();
    expect(
      within(results()).getByText(
        'Export cancelled. 1 file was written before it stopped, and captions.csv lists it.',
      ),
    ).toBeInTheDocument();
    expect(dir.dirs.get('exports')?.files.has('captions.csv')).toBe(true);
  });

  it('stops when the session is closed part-way, and clears the old results', async () => {
    openSession(newCard());
    renderPanel({ createClient: fake });
    fireEvent.click(button('Download as .zip'));
    await act(() => client.sent(1));
    act(() => {
      store().clearSession(() => true);
    });
    const first = client.calls[0];
    await act(async () => first?.reject(new RenderError('cancelled', 'cancelled')));
    await settle();
    // The panel shows the "no session" state; the old session's results are gone.
    expect(screen.getByText(NO_SESSION_EXPORT_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Export results' })).toBeNull();
  });

  it('cancels when the panel goes away', async () => {
    openSession(newCard());
    const { unmount } = renderPanel({ createClient: fake });
    fireEvent.click(button('Download as .zip'));
    await act(() => client.sent(1));
    unmount();
    expect(client.cancelled).toEqual(['export-1']);
    await settle();
  });
});
