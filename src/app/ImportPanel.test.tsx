import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageDecodeError, damagedMessage, inspectImage } from '../lib/image/decode';
import { sha256Hex } from '../lib/image/hash';
import { getAssetBlob, useSessionStore } from '../store/sessionStore';
import { makeAsset, makeBrand, makeSession } from '../test/fixtures';
import { ImportPanel } from './ImportPanel';

// Decoding needs a real browser. Type detection, hashing, the pipeline and the store are real.
vi.mock('../lib/image/decode', async (original) => ({
  ...(await original<typeof import('../lib/image/decode')>()),
  inspectImage: vi.fn(),
}));

const text = (value: string) => [...value].map((char) => char.charCodeAt(0));
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEIC = [0, 0, 0, 24, ...text('ftypheic'), 0, 0, 0, 0, ...text('mif1heic')];
const MP4 = [0, 0, 0, 24, ...text('ftypisom'), 0, 0, 0, 0, ...text('isommp42')];

function file(name: string, start: number[], body = name): File {
  return new File([new Uint8Array([...start, ...text(body)])], name);
}
const idOf = async (blob: Blob) => sha256Hex(await blob.arrayBuffer());

const store = () => useSessionStore.getState();
const zone = () => screen.getByRole('group', { name: 'Drop zone for photos' });
const chooseButton = () => screen.getByRole('button', { name: 'Choose files' });
const picker = () => screen.getByLabelText<HTMLInputElement>('Photos to import');
const results = () => screen.getByRole('list', { name: 'Import results' });
const grid = () => screen.getByRole('list', { name: 'Imported photos' });
const liveRegion = () => screen.getByRole('status');

function drop(...files: File[]) {
  fireEvent.drop(zone(), { dataTransfer: { files } });
}

/** Waits until the batch has finished. */
async function finished(summary: string) {
  await waitFor(() => expect(liveRegion()).toHaveTextContent(summary));
}

function newSession() {
  act(() => store().createSession('Test session'));
}

let made: Blob[];
let revoked: string[];
const urlOf = (thumbnail: Blob) => `blob:thumb-${made.indexOf(thumbnail) + 1}`;
const thumb = (name: string, type = 'image/webp') => new Blob([name], { type });

beforeEach(() => {
  act(() => {
    store().clearSession(() => true);
  });
  made = [];
  revoked = [];
  // jsdom has neither function.
  URL.createObjectURL = vi.fn((blob: Blob) => {
    made.push(blob);
    return `blob:thumb-${made.length}`;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  vi.mocked(inspectImage).mockImplementation((_blob, _format, fileName) =>
    Promise.resolve({ width: 4032, height: 3024, thumbnail: thumb(fileName) }),
  );
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('before a session is open', () => {
  it('disables the drop zone and the button, and says why', () => {
    render(<ImportPanel />);
    expect(
      screen.getByText('Start or open a session first. Photos are added to the open session.'),
    ).toBeInTheDocument();
    expect(zone()).toHaveAttribute('aria-disabled', 'true');
    expect(chooseButton()).toBeDisabled();
  });

  it('ignores a drop', async () => {
    render(<ImportPanel />);
    fireEvent.dragOver(zone());
    expect(zone()).toHaveAttribute('data-dragging', 'false');
    drop(file('site.jpg', JPEG));
    await act(() => Promise.resolve());
    expect(screen.queryByRole('list', { name: 'Import results' })).not.toBeInTheDocument();
    expect(inspectImage).not.toHaveBeenCalled();
    expect(liveRegion()).toBeEmptyDOMElement();
  });
});

describe('with a session open', () => {
  beforeEach(newSession);

  it('enables the drop zone and offers a secondary Choose files button', () => {
    render(<ImportPanel />);
    expect(screen.getByText(/Drop JPG, PNG or HEIC photos here/)).toBeInTheDocument();
    expect(zone()).toHaveAttribute('aria-disabled', 'false');
    expect(chooseButton()).toBeEnabled();
    // Secondary style: surface background, not the primary fill.
    expect(chooseButton().className).toContain('bg-surface');
    expect(chooseButton().className).not.toContain('bg-primary');
    expect(chooseButton().className).toContain('focus-visible:outline-accent');
    expect(zone().className).toContain('focus-within:border-accent');
  });

  it('imports a dropped photo: result line, thumbnail with name and size, asset in the store', async () => {
    render(<ImportPanel />);
    const photo = file('site.jpg', JPEG);

    drop(photo);
    await finished('Import finished: 1 added.');

    const row = within(results()).getByRole('listitem');
    expect(row).toHaveTextContent('site.jpg');
    expect(within(row).getByText('Imported, 4032 x 3024 pixels.').className).toContain(
      'text-success-text',
    );

    const tile = within(grid()).getByRole('listitem');
    expect(tile).toHaveTextContent('site.jpg');
    expect(tile).toHaveTextContent('4032 x 3024');
    expect(tile.querySelector('img')).toHaveAttribute('src', 'blob:thumb-1');

    const id = await idOf(photo);
    expect(store().session?.assets).toEqual([
      {
        id,
        kind: 'image',
        fileName: 'site.jpg',
        width: 4032,
        height: 3024,
        focal: { x: 0.5, y: 0.5 },
      },
    ]);
    expect(await idOf(getAssetBlob(id) as Blob)).toBe(id);
  });

  it('marks the session as changed and leaves undo alone', async () => {
    act(() => store().markSaved(store().revision));
    expect(store().dirty).toBe(false);
    render(<ImportPanel />);

    drop(file('site.jpg', JPEG));
    await finished('Import finished: 1 added.');

    expect(store().dirty).toBe(true);
    expect(store().undoStack).toEqual([]);
  });

  it('shows a portrait photo with portrait dimensions', async () => {
    vi.mocked(inspectImage).mockResolvedValue({ width: 3024, height: 4032, thumbnail: null });
    render(<ImportPanel />);
    drop(file('IMG_0042.jpg', JPEG));
    await finished('Import finished: 1 added.');
    expect(within(grid()).getByRole('listitem')).toHaveTextContent('3024 x 4032');
  });

  it('opens the file picker from the button and imports what was chosen', async () => {
    render(<ImportPanel />);
    expect(picker()).toHaveAttribute('accept', '.jpg,.jpeg,.png,.heic,.heif');
    expect(picker()).toHaveAttribute('multiple');
    const click = vi.spyOn(picker(), 'click');

    fireEvent.click(chooseButton());
    expect(click).toHaveBeenCalledOnce();

    fireEvent.change(picker(), { target: { files: [file('a.jpg', JPEG), file('b.png', PNG)] } });
    await finished('Import finished: 2 added.');
    expect(within(grid()).getAllByRole('listitem')).toHaveLength(2);
  });

  it('does nothing when the picker is closed without choosing a file', async () => {
    render(<ImportPanel />);
    fireEvent.change(picker(), { target: { files: [] } });
    await act(() => Promise.resolve());
    expect(liveRegion()).toBeEmptyDOMElement();
  });

  it('checks the contents of every file, whatever the picker filter or the name says', async () => {
    render(<ImportPanel />);
    // Named like a photo, but really a video.
    fireEvent.change(picker(), { target: { files: [file('clip.jpg', MP4)] } });
    await finished('Import finished: 1 not imported.');
    expect(results()).toHaveTextContent('"clip.jpg" is a video, so it was not imported.');
    expect(inspectImage).not.toHaveBeenCalled();
  });

  it('tells the user a file is already imported and does not add a second copy', async () => {
    render(<ImportPanel />);
    drop(file('site.jpg', JPEG, 'same bytes'));
    await finished('Import finished: 1 added.');

    drop(file('site copy.jpg', JPEG, 'same bytes'));
    await finished('Import finished: 1 already imported.');

    const message = within(results()).getByText('Already imported as "site.jpg".');
    expect(message.className).toContain('text-ink-secondary');
    expect(store().session?.assets).toHaveLength(1);
    expect(within(grid()).getAllByRole('listitem')).toHaveLength(1);
    expect(made).toHaveLength(1);
  });

  it('shows each error in plain words and still imports the rest of the batch', async () => {
    vi.mocked(inspectImage).mockImplementation((_blob, format, fileName) =>
      fileName === 'cut-off.jpg'
        ? Promise.reject(new ImageDecodeError('damaged', damagedMessage(fileName, format)))
        : Promise.resolve({ width: 800, height: 600, thumbnail: thumb(fileName) }),
    );
    render(<ImportPanel />);

    drop(
      file('clip.mp4', MP4),
      file('notes.txt', text('hello')),
      file('cut-off.jpg', JPEG),
      file('good.png', PNG),
    );
    await finished('Import finished: 1 added, 3 not imported.');

    const rows = within(results()).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('Video support arrives in a later phase');
    expect(rows[1]).toHaveTextContent('Convert it to JPG or PNG first.');
    expect(rows[2]).toHaveTextContent('the file is damaged or incomplete');
    expect(rows[3]).toHaveTextContent('Imported, 800 x 600 pixels.');
    expect(within(rows[0] as HTMLElement).getByText(/is a video/).className).toContain(
      'text-highlight-text',
    );
    expect(store().session?.assets.map((a) => a.fileName)).toEqual(['good.png']);
  });

  it('shows a note when a file name and its contents disagree', async () => {
    render(<ImportPanel />);
    drop(file('IMG_2.jpg', HEIC));
    await finished('Import finished: 1 added.');
    expect(inspectImage).toHaveBeenCalledWith(expect.any(Blob), 'heic', 'IMG_2.jpg', undefined);
    expect(results()).toHaveTextContent(
      '"IMG_2.jpg" is named .jpg but is really a HEIC photo. It is imported as HEIC',
    );
  });

  it('shows per-file progress and blocks a second batch while one is running', async () => {
    const release: (() => void)[] = [];
    vi.mocked(inspectImage).mockImplementation(
      (_blob, _format, fileName) =>
        new Promise((resolve) => {
          release.push(() => resolve({ width: 10, height: 10, thumbnail: thumb(fileName) }));
        }),
    );
    render(<ImportPanel />);

    drop(file('a.jpg', JPEG), file('b.jpg', JPEG));
    await waitFor(() => expect(release).toHaveLength(1));

    const rows = within(results()).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Working…');
    expect(rows[1]).toHaveTextContent('Waiting…');
    expect(liveRegion()).toHaveTextContent('Importing 1 of 2: a.jpg…');
    expect(results()).toHaveAttribute('aria-busy', 'true');
    expect(chooseButton()).toBeDisabled();
    expect(screen.getByText(/You can add more when this batch has finished/)).toBeInTheDocument();

    // A drop during the batch is ignored.
    fireEvent.dragOver(zone());
    expect(zone()).toHaveAttribute('data-dragging', 'false');
    drop(file('c.jpg', JPEG));
    await act(() => Promise.resolve());
    expect(within(results()).getAllByRole('listitem')).toHaveLength(2);

    act(() => release[0]?.());
    await waitFor(() => expect(liveRegion()).toHaveTextContent('Importing 2 of 2: b.jpg…'));
    await waitFor(() => expect(release).toHaveLength(2));
    act(() => release[1]?.());
    await finished('Import finished: 2 added.');
    expect(chooseButton()).toBeEnabled();
    expect(results()).toHaveAttribute('aria-busy', 'false');
    expect(store().session?.assets.map((a) => a.fileName)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('does not add a file to a different session that was opened during the import', async () => {
    let release: () => void = () => undefined;
    vi.mocked(inspectImage).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ width: 10, height: 10, thumbnail: thumb('late') });
        }),
    );
    render(<ImportPanel />);
    drop(file('late.jpg', JPEG), file('later.jpg', JPEG, 'other'));
    await waitFor(() => expect(results()).toHaveTextContent('Working…'));

    act(() => store().createSession('Another session'));
    act(() => release());
    await waitFor(() => expect(results()).toHaveTextContent('Not added, because the session was'));
    act(() => release());
    await finished('Import finished: 2 not imported.');

    expect(store().session?.name).toBe('Another session');
    expect(store().session?.assets).toEqual([]);
    expect(made).toEqual([]);
  });

  it('highlights the drop zone while files are dragged over it', () => {
    render(<ImportPanel />);
    fireEvent.dragOver(zone());
    expect(zone()).toHaveAttribute('data-dragging', 'true');
    expect(zone().className).toContain('border-accent');
    fireEvent.dragLeave(zone());
    expect(zone()).toHaveAttribute('data-dragging', 'false');
    fireEvent.dragOver(zone());
    drop();
    expect(zone()).toHaveAttribute('data-dragging', 'false');
  });

  it('stops a file dropped beside the drop zone from replacing the app, while it is on screen', () => {
    const stray = () => {
      const event = new Event('drop', { cancelable: true });
      window.dispatchEvent(event);
      const over = new Event('dragover', { cancelable: true });
      window.dispatchEvent(over);
      return event.defaultPrevented && over.defaultPrevented;
    };
    const { unmount } = render(<ImportPanel />);
    expect(stray()).toBe(true);
    unmount();
    expect(stray()).toBe(false);
  });
});

describe('thumbnails', () => {
  beforeEach(newSession);

  it('uses whatever image type the browser produced, such as PNG', async () => {
    const png = thumb('png preview', 'image/png');
    vi.mocked(inspectImage).mockResolvedValue({ width: 10, height: 10, thumbnail: png });
    render(<ImportPanel />);
    drop(file('a.jpg', JPEG));
    await finished('Import finished: 1 added.');
    expect(made).toEqual([png]);
    expect(grid().querySelector('img')).toHaveAttribute('src', urlOf(png));
  });

  it('shows a plain placeholder when there is no preview', async () => {
    vi.mocked(inspectImage).mockResolvedValue({ width: 10, height: 10, thumbnail: null });
    render(<ImportPanel />);
    drop(file('a.jpg', JPEG));
    await finished('Import finished: 1 added.');
    expect(within(grid()).getByText('No preview')).toBeInTheDocument();
    expect(grid().querySelector('img')).toBeNull();
    expect(made).toEqual([]);
  });

  it('revokes every object URL when the panel unmounts', async () => {
    const { unmount } = render(<ImportPanel />);
    drop(file('a.jpg', JPEG), file('b.png', PNG));
    await finished('Import finished: 2 added.');
    expect(revoked).toEqual([]);

    unmount();

    expect(revoked.sort()).toEqual(['blob:thumb-1', 'blob:thumb-2']);
  });

  it('revokes the object URLs when the session is cleared', async () => {
    render(<ImportPanel />);
    drop(file('a.jpg', JPEG));
    await finished('Import finished: 1 added.');

    act(() => {
      store().clearSession(() => true);
    });

    expect(revoked).toEqual(['blob:thumb-1']);
    expect(screen.queryByRole('list', { name: 'Imported photos' })).not.toBeInTheDocument();
  });

  it('keeps thumbnails out of the session data and the saved blobs', async () => {
    render(<ImportPanel />);
    const photo = file('a.jpg', JPEG);
    drop(photo);
    await finished('Import finished: 1 added.');

    expect(JSON.stringify(store().session)).not.toMatch(/thumb|blob:/i);
    const stored = getAssetBlob(await idOf(photo)) as Blob;
    expect(made).not.toContain(stored);
  });
});

describe('opening a session', () => {
  const jpegFile = new Blob([new Uint8Array([...JPEG, 1])]);
  const heicFile = new Blob([new Uint8Array(HEIC)]);
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const C = 'c'.repeat(64);

  function open(name: string, blobs: Map<string, Blob>, missingAssetIds: string[] = []) {
    act(() => {
      store().loadSession({
        session: makeSession({
          id: name,
          name,
          cards: [],
          groups: [],
          assets: [
            makeAsset({ id: A, fileName: 'site.jpg' }),
            makeAsset({ id: B, fileName: 'IMG_1.HEIC', width: 3024, height: 4032 }),
            makeAsset({ id: C, fileName: 'lost.png' }),
          ],
        }),
        brand: makeBrand(),
        blobs,
        missingAssetIds,
        brandMissing: false,
      });
    });
  }

  const stored = () =>
    new Map([
      [A, jpegFile],
      [B, heicFile],
    ]);

  it('rebuilds the thumbnails from the stored asset files, HEIC included', async () => {
    render(<ImportPanel />);
    open('saved', stored(), [C]);

    const tiles = within(grid()).getAllByRole('listitem');
    expect(tiles).toHaveLength(3);
    await waitFor(() => expect(grid().querySelectorAll('img')).toHaveLength(2));

    expect(inspectImage).toHaveBeenCalledTimes(2);
    expect(inspectImage).toHaveBeenCalledWith(jpegFile, 'jpeg', 'site.jpg', undefined);
    // The stored HEIC is decoded here, which is the point at which the decoder is loaded.
    expect(inspectImage).toHaveBeenCalledWith(heicFile, 'heic', 'IMG_1.HEIC', undefined);
    expect(tiles[0]?.querySelector('img')).toHaveAttribute('src', 'blob:thumb-1');
    expect(tiles[1]?.querySelector('img')).toHaveAttribute('src', 'blob:thumb-2');
    expect(tiles[1]).toHaveTextContent('3024 x 4032');
    expect(tiles[2]).toHaveTextContent('File missing');
    // Opening a session changes nothing in it.
    expect(store().dirty).toBe(false);
  });

  it('rebuilds them for a session that was already open when the panel appeared (page reload)', async () => {
    open('saved', stored(), [C]);
    render(<ImportPanel />);
    expect(within(grid()).getAllByText('Loading preview…')).toHaveLength(2);
    await waitFor(() => expect(grid().querySelectorAll('img')).toHaveLength(2));
  });

  it('shows a placeholder for a stored file that can no longer be decoded', async () => {
    vi.mocked(inspectImage).mockRejectedValue(new Error('damaged'));
    render(<ImportPanel />);
    open('saved', stored(), [C]);
    await waitFor(() => expect(within(grid()).getAllByText('No preview')).toHaveLength(2));
    expect(made).toEqual([]);
  });

  it('releases the old thumbnails and makes new ones when another session is opened', async () => {
    render(<ImportPanel />);
    open('first', stored(), [C]);
    await waitFor(() => expect(grid().querySelectorAll('img')).toHaveLength(2));

    open('second', stored(), [C]);

    expect(revoked.sort()).toEqual(['blob:thumb-1', 'blob:thumb-2']);
    await waitFor(() => expect(made).toHaveLength(4));
    expect([...grid().querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([
      'blob:thumb-3',
      'blob:thumb-4',
    ]);
  });

  it('drops a preview that finishes after its session was replaced', async () => {
    let release: () => void = () => undefined;
    vi.mocked(inspectImage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ width: 1, height: 1, thumbnail: thumb('stale') });
        }),
    );
    render(<ImportPanel />);
    open('first', new Map([[A, jpegFile]]), [B, C]);
    await waitFor(() => expect(inspectImage).toHaveBeenCalledTimes(1));

    act(() => {
      store().clearSession(() => true);
    });
    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(made).toEqual([]);
  });

  it('restores a missing file when it is dropped, and shows its thumbnail', async () => {
    const lost = file('found-it.png', PNG, 'lost bytes');
    const lostId = await idOf(lost);
    render(<ImportPanel />);
    act(() => {
      store().loadSession({
        session: makeSession({
          cards: [],
          groups: [],
          assets: [makeAsset({ id: lostId, fileName: 'lost.png' })],
        }),
        brand: makeBrand(),
        blobs: new Map(),
        missingAssetIds: [lostId],
        brandMissing: false,
      });
    });
    expect(grid()).toHaveTextContent('File missing');

    drop(lost);
    await finished('Import finished: 1 restored.');

    expect(results()).toHaveTextContent(
      'This is the missing file for "lost.png". It has been restored.',
    );
    expect(store().missingAssetIds).toEqual([]);
    expect(store().session?.assets).toHaveLength(1);
    expect(getAssetBlob(lostId)).toBeDefined();
    expect(grid().querySelector('img')).toHaveAttribute('src', 'blob:thumb-1');
    expect(inspectImage).toHaveBeenCalledTimes(1);
  });
});
