/**
 * Board tests. The image worker is replaced by the shared fake client; the store, the render
 * controller and the validator are real. Nothing waits on a timer: a test waits for jobs to
 * reach the fake client (`sent`) or for the controller to finish its work (`idle`).
 */
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderController } from '../lib/board/controller';
import { getPlacement } from '../lib/platforms';
import { RenderError } from '../lib/render/protocol';
import { useSessionStore } from '../store/sessionStore';
import { fakeRenderClient, resultFor } from '../test/fakeRenderClient';
import type { FakeRenderClient } from '../test/fakeRenderClient';
import { hash, makeAsset } from '../test/fixtures';
import type { Card, ImageEdit, PlacementSpec, Rect, Session } from '../types';
import { draftCard } from '../lib/board/cards';
import { fitWholeCrop } from '../lib/editor/geometry';
import { cropToPixels } from '../lib/render/crop';
import { emptyBrand } from '../lib/session/layout';
import { LOADING_TEXT } from '../editor/Editor';
import { SourcePhotoError } from '../lib/editor/sourcePhoto';
import type { DisplayPhoto, SourcePhotoInput } from '../lib/editor/sourcePhoto';
import { SessionPanel } from '../app/SessionPanel';
import { Board, NO_CARDS_TEXT, NO_MATCH_TEXT, NO_PHOTOS_TEXT, NO_SESSION_TEXT } from './Board';

// ---------------------------------------------------------------------------
// jsdom has no <dialog> behaviour. This stand-in follows the browser: showModal opens it, close
// closes it and fires "close", and Esc fires a cancelable "cancel" and then closes it. The real
// dialog is checked in Chromium.
// ---------------------------------------------------------------------------

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

function pressEscape(dialog: HTMLDialogElement) {
  act(() => {
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    if (!cancel.defaultPrevented) dialog.close();
  });
}

// ---------------------------------------------------------------------------

const spec = (platform: 'instagram' | 'linkedin', placement: string) =>
  getPlacement(platform, placement) as PlacementSpec;
const FEED = spec('instagram', 'feed-vertical');
const sizeOf = (s: PlacementSpec) => s.sizes[0] as { width: number; height: number };

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PHOTO = makeAsset({ id: hash('a'), fileName: 'site.jpg', width: 4032, height: 3024 });
const SECOND = makeAsset({ id: hash('c'), fileName: 'crew.jpg', width: 4032, height: 3024 });

const store = () => useSessionStore.getState();

let client: FakeRenderClient;
let clients: FakeRenderClient[];
let controller: RenderController | null;
const createClient = () => {
  client = fakeRenderClient();
  clients.push(client);
  return client;
};
const onController = (made: RenderController | null) => {
  controller = made;
};

/** Each time the editor asks for a photo; the test answers, or leaves it opening. */
let photoLoads: {
  input: SourcePhotoInput;
  resolve: (photo: DisplayPhoto) => void;
  reject: (error: unknown) => void;
}[];
const loadPhoto = (input: SourcePhotoInput) =>
  new Promise<DisplayPhoto>((resolve, reject) => {
    photoLoads.push({ input, resolve, reject });
  });
function photoOf(input: SourcePhotoInput) {
  return {
    bitmap: {} as ImageBitmap,
    width: 2048,
    height: 1536,
    source: input.expected,
    close: vi.fn<() => void>(),
  };
}
/** Answers the editor's latest request with a photo. */
async function showPhoto() {
  const load = photoLoads.at(-1);
  if (!load) throw new Error('the editor has not asked for a photo');
  const photo = photoOf(load.input);
  load.resolve(photo);
  await act(() => Promise.resolve());
  return photo;
}

function renderBoard() {
  return render(
    <Board createClient={createClient} onController={onController} loadPhoto={loadPhoto} />,
  );
}

/** Waits, inside act, until `count` jobs have reached the fake worker. */
async function sent(count: number) {
  await act(() => client.sent(count));
}
/** Waits, inside act, until every render the controller started has finished. */
async function idle() {
  await act(() => (controller as RenderController).idle());
}
/** Answers job `index` with a file at its planned size. Await `idle()` once all are answered. */
function answer(index: number, overrides: Parameters<typeof resultFor>[1] = {}) {
  const job = client.calls[index];
  if (!job) throw new Error(`no job ${index}`);
  act(() => job.resolve(resultFor(job.job, overrides)));
}

function openSession(...assets: (typeof PHOTO)[]) {
  act(() => {
    store().createSession('Board test');
    store().addAssets(assets.map((asset) => ({ asset, blob: new Blob([JPEG]) })));
  });
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const status = (name: string) => screen.getByRole('status', { name });
const cardList = (fileName = 'site.jpg') =>
  screen.getByRole('list', { name: `Cards for ${fileName}` });
const article = (label: string | RegExp) => screen.getByRole('article', { name: label });

/** Opens the form, ticks the given placements, and creates the cards. */
function createCards(...placements: string[]) {
  fireEvent.click(button('Create cards'));
  const form = screen.getByRole('form', { name: 'Create cards' });
  for (const placement of placements) {
    fireEvent.click(within(form).getByRole('checkbox', { name: new RegExp(`^${placement}`) }));
  }
  fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
}

beforeEach(() => {
  clients = [];
  controller = null;
  photoLoads = [];
  // jsdom has no canvas drawing.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as never);
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:render-${++next}`);
  URL.revokeObjectURL = vi.fn();
  act(() => {
    store().clearSession(() => true);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('empty states', () => {
  it('asks for a session first', () => {
    renderBoard();
    expect(screen.getByText(NO_SESSION_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create cards' })).toBeNull();
  });

  it('asks for a photo when the session has none', () => {
    act(() => store().createSession('Empty'));
    renderBoard();
    expect(screen.getByText(NO_PHOTOS_TEXT)).toBeInTheDocument();
    expect(button('Create cards')).toBeDisabled();
    expect(button('Cancel all')).toBeDisabled();
  });

  it('points to Create cards when there are photos but no cards', () => {
    openSession(PHOTO);
    renderBoard();
    expect(screen.getByText(NO_CARDS_TEXT)).toBeInTheDocument();
    expect(button('Create cards')).toBeEnabled();
    expect(status('Render progress')).toBeEmptyDOMElement();
  });
});

describe('creating cards', () => {
  it('offers the photos and the Instagram and LinkedIn single-image placements', () => {
    openSession(PHOTO, SECOND);
    act(() => store().addAssets([{ asset: makeAsset({ id: hash('b'), kind: 'video' }) }]));
    renderBoard();
    fireEvent.click(button('Create cards'));
    expect(button('Create cards')).toHaveAttribute('aria-expanded', 'true');
    const form = screen.getByRole('form', { name: 'Create cards' });
    const photos = within(form).getByRole('group', { name: 'Photos' });
    expect(
      within(photos)
        .getAllByRole('checkbox')
        .map((box) => box.closest('label')?.textContent),
    ).toEqual(['site.jpg', 'crew.jpg']);
    for (const box of within(photos).getAllByRole('checkbox')) expect(box).toBeChecked();
    expect(within(form).getByRole('group', { name: 'Instagram' })).toBeInTheDocument();
    expect(within(form).getByRole('group', { name: 'LinkedIn' })).toBeInTheDocument();
    expect(within(form).queryByRole('group', { name: 'Facebook' })).toBeNull();
    expect(within(form).queryByRole('group', { name: 'X' })).toBeNull();
    // No carousel or video-only placement. A whole label is matched, since "Reel / Story" is a
    // photo placement that is offered.
    expect(within(form).queryByRole('checkbox', { name: /^(Carousel|Reel|Video) \(/ })).toBeNull();
    const size = sizeOf(FEED);
    expect(
      within(form).getByRole('checkbox', {
        name: `Feed vertical (${size.width} × ${size.height})`,
      }),
    ).toBeInTheDocument();
  });

  it('needs a photo and a placement before Create works', () => {
    openSession(PHOTO);
    renderBoard();
    fireEvent.click(button('Create cards'));
    const form = screen.getByRole('form', { name: 'Create cards' });
    const create = within(form).getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();
    expect(form).toHaveTextContent('Choose at least one photo and one placement.');
    fireEvent.click(within(form).getByRole('checkbox', { name: /^Feed vertical/ }));
    expect(create).toBeEnabled();
    fireEvent.click(within(form).getByRole('checkbox', { name: 'site.jpg' }));
    expect(create).toBeDisabled();
    fireEvent.submit(form);
    expect(store().session?.cards).toEqual([]);
  });

  it('cannot use a photo whose file is missing', () => {
    openSession(PHOTO, SECOND);
    act(() => useSessionStore.setState({ missingAssetIds: [SECOND.id] }));
    renderBoard();
    fireEvent.click(button('Create cards'));
    const box = screen.getByRole('checkbox', { name: /crew\.jpg/ });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(box.closest('label')).toHaveTextContent('file missing');
  });

  it('makes one card per photo and placement, then renders and checks each one', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical', 'Image post square');
    expect(store().session?.cards.map((c) => c.placement)).toEqual([
      'feed-vertical',
      'image-square',
    ]);
    expect(status('Board messages')).toHaveTextContent('Created 2 cards.');
    expect(screen.queryByRole('form', { name: 'Create cards' })).toBeNull();
    expect(button('Create cards')).toHaveFocus();

    const cards = within(cardList()).getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText('Not checked yet')).toBeInTheDocument();
    expect(status('Render progress')).toHaveTextContent('Rendering 1 of 2…');

    await sent(2);
    act(() => client.calls[0]?.onProgress('drawing'));
    const bar = screen.getByRole('progressbar', {
      name: 'Rendering Instagram Feed vertical for site.jpg, v1',
    });
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(bar).toHaveAttribute('aria-valuetext', 'Cropping and resizing');

    answer(0);
    answer(1);
    await idle();
    const feed = article('Instagram Feed vertical for site.jpg, v1');
    const preview = within(feed).getByRole('img');
    expect(preview).toHaveAttribute('src', 'blob:render-1');
    expect(preview).toHaveAttribute('alt', 'Preview of site.jpg for Instagram Feed vertical');
    const size = sizeOf(FEED);
    expect(feed).toHaveTextContent(`${size.width} × ${size.height} JPG · 400 KB`);
    // No alt text yet, so rule 8 warns.
    expect(within(feed).getByText('Warning')).toBeInTheDocument();
    expect(within(feed).getByText('Alt text is missing')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(status('Render progress')).toHaveTextContent(
      'Rendered 2 cards: 0 pass, 2 with warnings.',
    );
    // The results were recorded on the cards without adding undo steps.
    expect(store().session?.cards.every((c) => c.validation.level === 'warn')).toBe(true);
    expect(store().undoStack).toHaveLength(2);
  });

  it('does not make the same card twice', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    createCards('Feed vertical');
    expect(store().session?.cards).toHaveLength(1);
    expect(status('Board messages')).toHaveTextContent(
      'No new cards were created. Instagram Feed vertical already has a card for "site.jpg".',
    );
    await sent(1);
  });

  it('the form can be closed without creating anything', () => {
    openSession(PHOTO);
    renderBoard();
    fireEvent.click(button('Create cards'));
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Create cards' })).getByRole('button', {
        name: 'Close',
      }),
    );
    expect(screen.queryByRole('form', { name: 'Create cards' })).toBeNull();
    expect(button('Create cards')).toHaveFocus();
    expect(button('Create cards')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('the Instagram placement labelled Reel / Story', () => {
  it('shows its label from platforms.json everywhere, and keeps the key "story"', async () => {
    const spec = getPlacement('instagram', 'story') as PlacementSpec;
    expect(spec.label).toBe('Reel / Story');
    const size = sizeOf(spec);
    openSession(PHOTO);
    renderBoard();
    fireEvent.click(button('Create cards'));
    const form = screen.getByRole('form', { name: 'Create cards' });
    // In the placement picker, with its size.
    expect(
      within(form).getByRole('checkbox', {
        name: `Reel / Story (${size.width} × ${size.height})`,
      }),
    ).toBeInTheDocument();
    fireEvent.click(button('Create cards'));
    createCards('Reel / Story');
    // The key is what is stored, so saved sessions and export names are unchanged.
    expect(store().session?.cards.map((c) => c.placement)).toEqual(['story']);
    await sent(1);
    answer(0);
    await idle();
    // On the card tile, its preview, and the card dialog.
    const tile = article('Instagram Reel / Story for site.jpg, v1');
    expect(within(tile).getByRole('img')).toHaveAttribute(
      'alt',
      'Preview of site.jpg for Instagram Reel / Story',
    );
    fireEvent.click(button('Open Instagram Reel / Story for site.jpg, v1'));
    expect(screen.getByRole('dialog', { name: 'Instagram Reel / Story' })).toBeInTheDocument();
  });
});

describe('filters', () => {
  async function twoFinished() {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical', 'Image post square');
    await sent(2);
    answer(0, { width: 10, height: 10 }); // the wrong size, so this card fails
    answer(1);
    await idle();
  }

  it('show counts and filter by platform', async () => {
    await twoFinished();
    expect(screen.getByRole('radio', { name: 'All (2)' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'LinkedIn (1)' }));
    expect(
      within(cardList())
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-label')),
    ).toEqual(['LinkedIn Image post square for site.jpg, v1']);
    fireEvent.click(screen.getByRole('radio', { name: 'Instagram (1)' }));
    expect(within(cardList()).getAllByRole('article')).toHaveLength(1);
  });

  it('filter by result, and Show all clears the filters', async () => {
    await twoFinished();
    const result = screen.getByRole('combobox', { name: 'Result' });
    fireEvent.change(result, { target: { value: 'fail' } });
    expect(
      within(cardList())
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-label')),
    ).toEqual(['Instagram Feed vertical for site.jpg, v1']);
    fireEvent.change(result, { target: { value: 'pass' } });
    expect(screen.getByText(NO_MATCH_TEXT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'LinkedIn (1)' }));
    fireEvent.click(button('Show all'));
    expect(result).toHaveValue('all');
    expect(screen.getByRole('radio', { name: 'All (2)' })).toBeChecked();
    expect(within(cardList()).getAllByRole('article')).toHaveLength(2);
  });
});

describe('progress, cancel and failures', () => {
  it('Cancel stops one card; Render again starts it again', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    await sent(1);
    fireEvent.click(button('Cancel Instagram Feed vertical for site.jpg, v1'));
    await idle();
    const card = article('Instagram Feed vertical for site.jpg, v1');
    expect(card).toHaveTextContent('Cancelled before the file was made.');
    expect(client.cancelled).toHaveLength(1);
    expect(status('Render progress')).toHaveTextContent('Rendered 0 cards: 0 pass, 1 cancelled.');
    fireEvent.click(button('Render again Instagram Feed vertical for site.jpg, v1'));
    await sent(2);
    answer(1);
    await idle();
    expect(within(card).getByRole('img')).toBeInTheDocument();
  });

  it('Cancel all stops every pending card', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical', 'Image post square');
    await sent(2);
    expect(button('Cancel all')).toBeEnabled();
    fireEvent.click(button('Cancel all'));
    await idle();
    expect(screen.getAllByText('Cancelled before the file was made.')).toHaveLength(2);
    expect(button('Cancel all')).toBeDisabled();
  });

  it("shows the worker's plain-language message when a render fails", async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    await sent(1);
    act(() =>
      client.calls[0]?.reject(
        new RenderError('canvas', '"site.jpg" could not be resized. Close other tabs.'),
      ),
    );
    await idle();
    const card = article('Instagram Feed vertical for site.jpg, v1');
    expect(card).toHaveTextContent('"site.jpg" could not be resized. Close other tabs.');
    expect(card).toHaveTextContent('No preview');
    expect(button('Render again Instagram Feed vertical for site.jpg, v1')).toBeInTheDocument();
    expect(status('Render progress')).toHaveTextContent('1 could not be rendered');
  });

  it('notes when a picture had to be enlarged', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    await sent(1);
    answer(0, { upscaled: true });
    await idle();
    const size = sizeOf(FEED);
    const note = within(article(/Feed vertical/)).getByText(
      `Note: enlarged to fit. The cropped area is smaller than ${size.width} × ${size.height} pixels, so it may look soft.`,
    );
    // Neutral text, so it does not read as the reason for the Warning badge.
    expect(note).toHaveClass('text-ink-secondary');
    expect(note).not.toHaveClass('text-highlight-text');
  });

  it('keeps a tile the same height while its card is rendered again', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    await sent(1);
    answer(0, { upscaled: true });
    await idle();
    const label = 'Instagram Feed vertical for site.jpg, v1';
    const tile = () => article(label);
    // jsdom has no layout, so the height is stood for by the tile's rows: the same elements in
    // the same places, each with text. The browser check measures the real height.
    const rows = () =>
      [...tile().children].map((row) => `${row.tagName}${row.className}:${row.textContent !== ''}`);
    const before = rows();
    const picture = within(tile()).getByRole('img');
    const { width, height } = sizeOf(FEED);
    expect(tile()).toHaveTextContent(`${width} × ${height} JPG · 400 KB`);

    // Cancel and Render again take turns in one place, each as wide as the wider of the two,
    // so the row of buttons wraps the same way whichever is shown.
    const twin = (name: string) => within(button(`${name} ${label}`)).getByTestId('same-width');
    expect(twin('Render again')).toHaveTextContent('Cancel');
    expect(twin('Render again')).toHaveAttribute('aria-hidden', 'true');
    expect(twin('Render again')).toHaveClass('invisible');
    fireEvent.click(button(`Render again ${label}`));
    await sent(2);
    expect(twin('Cancel')).toHaveTextContent('Render again');
    expect(twin('Cancel')).toHaveClass('invisible');
    act(() => client.calls[1]?.onProgress('encoding'));
    // The same picture, dimmed, with the progress over it; "Updating…" in the file's line.
    expect(within(tile()).getByRole('img')).toBe(picture);
    expect(picture).toHaveAttribute('src', 'blob:render-1');
    expect(picture).toHaveAttribute('data-updating', 'true');
    const bar = within(tile()).getByRole('progressbar', { name: `Rendering ${label}` });
    expect(bar.parentElement).toBe(picture.parentElement);
    expect(within(tile()).getByText('Updating…')).toHaveClass('text-label');
    // The enlarged note and the reason stay until the new result arrives.
    expect(tile()).toHaveTextContent('Note: enlarged to fit.');
    expect(within(tile()).getByText('Alt text is missing')).toBeInTheDocument();
    expect(within(tile()).getByText('Not checked yet')).toBeInTheDocument();
    expect(rows()).toEqual(before);

    answer(1, { upscaled: true, bytes: 1_234_567 });
    await idle();
    expect(within(tile()).getByRole('img')).toBe(picture);
    expect(picture).toHaveAttribute('src', 'blob:render-2');
    expect(picture).not.toHaveAttribute('data-updating');
    expect(tile()).toHaveTextContent(`${width} × ${height} JPG · 1.2 MB`);
    expect(within(tile()).queryByRole('progressbar')).toBeNull();
    expect(rows()).toEqual(before);
  });

  it("shows a placeholder with the progress over it before a tile's first file", async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    await sent(1);
    act(() => client.calls[0]?.onProgress('decoding'));
    const tile = article(/Feed vertical/);
    expect(within(tile).queryByRole('img')).toBeNull();
    const bar = within(tile).getByRole('progressbar');
    expect(bar.parentElement).toHaveTextContent('Preview coming');
    expect(bar.parentElement?.style.aspectRatio).toBe(
      `${sizeOf(FEED).width} / ${sizeOf(FEED).height}`,
    );
    expect(within(tile).getByText('Opening the photo')).toBeInTheDocument();
  });

  it('starts from the placeholder again after a cancel, as the old file is gone', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    await sent(1);
    answer(0);
    await idle();
    const label = 'Instagram Feed vertical for site.jpg, v1';
    fireEvent.click(button(`Render again ${label}`));
    await sent(2);
    fireEvent.click(button(`Cancel ${label}`));
    const tile = article(label);
    expect(within(tile).queryByRole('img')).toBeNull();
    expect(tile).toHaveTextContent('Cancelled before the file was made.');
    expect(within(tile).queryByText('Alt text is missing')).toBeNull();
    fireEvent.click(button(`Render again ${label}`));
    await sent(3);
    expect(within(tile).queryByRole('img')).toBeNull();
    expect(tile).toHaveTextContent('Preview coming');
    expect(tile).toHaveTextContent('Waiting to render');
  });

  it('shows the first reason for a result on the card, and how many more there are', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    // Nothing is shown until the file has been checked.
    expect(article(/Feed vertical/)).not.toHaveTextContent('Alt text is missing');
    await sent(1);
    answer(0);
    await idle();
    const reason = within(article(/Feed vertical/)).getByText('Alt text is missing');
    expect(reason).toHaveClass('text-highlight-text');
    expect(reason).not.toHaveTextContent('more');

    // A link in an Instagram caption adds a second warning.
    const id = store().session?.cards[0]?.id as string;
    act(() => {
      store().updateCard(id, (card) => {
        card.copy.caption = 'See https://example.com';
      });
    });
    await idle();
    const card = article(/Feed vertical/);
    expect(card.querySelectorAll('p.text-highlight-text')).toHaveLength(1);
    expect(card).toHaveTextContent(/\+1 more/);
  });

  it('says so for a card whose placement or photo is not available', () => {
    openSession(PHOTO);
    renderBoard();
    const base = {
      status: 'draft' as const,
      edit: {
        crop: { x: 0, y: 0, width: 1, height: 1 },
        overlays: [],
        format: 'jpg' as const,
        quality: 0.9,
      },
      copy: { caption: '', firstComment: '', hashtags: [], altText: '' },
      validation: { level: 'pass' as const, issues: [] },
      overrideFail: false,
      comments: [],
    };
    act(() => {
      store().addCard({ ...base, assetIds: [PHOTO.id], platform: 'instagram', placement: 'gone' });
      store().addCard({
        ...base,
        assetIds: [hash('e')],
        platform: 'linkedin',
        placement: 'image-square',
      });
    });
    expect(article('Instagram gone for site.jpg, v1')).toHaveTextContent(
      'is no longer listed in the app',
    );
    const orphan = screen.getByRole('list', {
      name: 'Cards for A photo that is not in this session',
    });
    expect(within(orphan).getByRole('article')).toHaveTextContent(
      "This card's photo is not in the session",
    );
  });
});

describe('duplicate and versions', () => {
  it('copies a card and tells copies that share a version apart', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    fireEvent.click(button('Duplicate Instagram Feed vertical for site.jpg, v1'));
    expect(status('Board messages')).toHaveTextContent('Made a copy of Instagram Feed vertical.');
    fireEvent.click(button('Duplicate Instagram Feed vertical for site.jpg, v1'));
    const labels = within(cardList())
      .getAllByRole('article')
      .map((a) => a.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Instagram Feed vertical for site.jpg, v1',
      'Instagram Feed vertical for site.jpg, v2 · 1 of 2',
      'Instagram Feed vertical for site.jpg, v2 · 2 of 2',
    ]);
    expect(article(/v2 · 1 of 2/)).toHaveTextContent('Copy of v1');
    // Each copy gets its own render; the original's is left alone.
    await sent(3);
    expect(client.cancelled).toEqual([]);
  });

  it('copies the file type and quality, and starts the copy with the override off', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    const id = store().session?.cards[0]?.id as string;
    act(() => {
      store().updateCard(id, (card) => {
        if ('format' in card.edit) {
          card.edit.format = 'png';
          card.edit.quality = 0.55;
        }
        card.overrideFail = true;
      });
    });
    fireEvent.click(button('Duplicate Instagram Feed vertical for site.jpg, v1'));
    const copy = store().session?.cards[1];
    expect(copy?.edit).toMatchObject({ format: 'png', quality: 0.55 });
    expect(copy?.overrideFail).toBe(false);
    // The copy is made as PNG too.
    await sent(2);
    expect(client.calls.map((call) => call.job.plan.format)).toEqual(['png', 'png']);
  });
});

describe('the details dialog', () => {
  async function openDetails() {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    await sent(1);
    answer(0);
    await idle();
    const opener = button('Open Instagram Feed vertical for site.jpg, v1');
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Instagram Feed vertical' });
    return { opener, dialog: dialog as HTMLDialogElement };
  }

  it('updates the badge and the tile reason once caption text is written on leaving its box', async () => {
    const { dialog } = await openDetails();
    const label = 'Instagram Feed vertical for site.jpg, v1';
    const cap = FEED.captionCap as number;
    const box = within(dialog).getByLabelText('Caption');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'a'.repeat(cap + 1) } });
    // While typing, the box says so, but nothing is written and the card's result is unchanged.
    expect(within(dialog).getByText(/^Caption is \d/)).toBeInTheDocument();
    expect(store().session?.cards[0]?.copy.caption).toBe('');
    expect(within(article(label)).queryByText(/^Caption is/)).toBeNull();
    expect(within(article(label)).getByText('Warning')).toBeInTheDocument();

    fireEvent.blur(box);
    await idle();
    expect(store().session?.cards[0]?.copy.caption).toBe('a'.repeat(cap + 1));
    expect(within(article(label)).getByText('Fail')).toBeInTheDocument();
    expect(within(article(label)).getByText(/^Caption is \d/)).toHaveClass('text-danger-text');
    const checks = within(dialog).getByRole('region', { name: 'Checks' });
    expect(within(checks).getAllByRole('listitem')[0]).toHaveTextContent(/^Fail: Caption is /);
  });

  it('opens as a modal with the file, the version and every check', async () => {
    const { dialog } = await openDetails();
    expect(dialog.open).toBe(true);
    expect(dialog).toHaveTextContent('site.jpg');
    const size = sizeOf(FEED);
    expect(dialog).toHaveTextContent(`${size.width} × ${size.height} JPG · 400 KB`);
    expect(dialog).toHaveTextContent('Version 1.');
    const checks = within(dialog).getByRole('region', { name: 'Checks' });
    expect(within(checks).getAllByRole('listitem')[0]).toHaveTextContent(/^Warning:/);
  });

  it('opens at its top, even when the browser has scrolled it down to its first control', async () => {
    // What a browser does in a short window: showModal puts focus on the first control, and
    // scrolls the dialog down to it when it is below the fold.
    const showModal = vi
      .spyOn(HTMLDialogElement.prototype, 'showModal')
      .mockImplementation(function scrolled(this: HTMLDialogElement) {
        this.setAttribute('open', '');
        this.scrollTop = 24;
      });
    const { dialog } = await openDetails();
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog.scrollTop).toBe(0);
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveFocus();
  });

  it('puts focus on its heading when it opens, so Tab starts at the top of the dialog', async () => {
    const { dialog } = await openDetails();
    const heading = within(dialog).getByRole('heading', { level: 2 });
    expect(heading).toHaveFocus();
    expect(heading.tabIndex).toBe(-1);
    // Focus stays there when the photo opens and the editor appears.
    await showPhoto();
    expect(heading).toHaveFocus();
    // The crop area and the marker come next in the document, before every other control.
    const controls = [
      ...dialog.querySelectorAll<HTMLElement>('[tabindex="0"], button, input'),
    ].filter((element) => !(element as HTMLButtonElement).disabled);
    expect(controls[0]).toBe(within(dialog).getByRole('application'));
    expect(controls[1]).toBe(within(dialog).getByTestId('focal-marker'));
    expect(controls.at(-1)).toBe(within(dialog).getByRole('button', { name: 'Close' }));
  });

  it('closes with Esc and returns focus to the Open button', async () => {
    const { opener, dialog } = await openDetails();
    pressEscape(dialog);
    expect(dialog.open).toBe(false);
    expect(opener).toHaveFocus();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes with its Close button and returns focus to the Open button', async () => {
    const { opener, dialog } = await openDetails();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(dialog.open).toBe(false);
    expect(opener).toHaveFocus();
  });

  it('says when the file has not been made yet', () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    fireEvent.click(button('Open Instagram Feed vertical for site.jpg, v1'));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Not made yet');
    expect(dialog).toHaveTextContent('The file has not been made yet');
  });

  it('says the photo is opening, then shows the crop area beside the details', async () => {
    const { dialog } = await openDetails();
    expect(within(dialog).getByRole('status')).toHaveTextContent(LOADING_TEXT);
    expect(photoLoads[0]?.input).toMatchObject({
      fileName: 'site.jpg',
      expected: { width: PHOTO.width, height: PHOTO.height },
    });
    await showPhoto();
    expect(within(dialog).getByRole('application')).toHaveAccessibleName(/^Crop of site\.jpg/);
    expect(within(dialog).getByRole('button', { name: 'Reset crop' })).toBeInTheDocument();
    // The details and checks are still there, with a small preview of the rendered file.
    const size = sizeOf(FEED);
    expect(dialog).toHaveTextContent(`${size.width} × ${size.height} JPG · 400 KB`);
    expect(within(dialog).getByRole('region', { name: 'Checks' })).toHaveTextContent(
      'Alt text is missing.',
    );
  });

  it('keeps a preview of the rendered file, which follows each new render', async () => {
    const { dialog } = await openDetails();
    await showPhoto();
    const file = () => within(dialog).getByRole('region', { name: 'Rendered file' });
    const first = within(file()).getByRole('img');
    expect(first).toHaveAttribute('src', 'blob:render-1');
    expect(first).toHaveAttribute('alt', 'Preview of site.jpg for Instagram Feed vertical');
    // Under it, the file's size, type and file size, as in the File row.
    expect(within(file()).getByRole('figure')).toHaveTextContent(
      `${sizeOf(FEED).width} × ${sizeOf(FEED).height} JPG · 400 KB`,
    );

    // A change in the editor starts a new render. The same picture stays, marked as updating,
    // with the progress over it, until the new file is ready.
    fireEvent.keyDown(within(dialog).getByRole('application'), { key: 'ArrowRight' });
    await sent(2);
    expect(within(file()).getByRole('img')).toBe(first);
    expect(first).toHaveAttribute('src', 'blob:render-1');
    expect(first).toHaveAttribute('data-updating', 'true');
    expect(within(file()).getByRole('figure')).toHaveTextContent('Updating…');
    expect(file()).toHaveAttribute('aria-busy', 'true');
    act(() => client.calls[1]?.onProgress('drawing'));
    const bar = within(file()).getByRole('progressbar', {
      name: 'Rendering Instagram Feed vertical',
    });
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(bar).toHaveAttribute('aria-valuetext', 'Cropping and resizing');
    answer(1, { bytes: 1_234_567 });
    await idle();
    expect(within(file()).getByRole('img')).toBe(first);
    expect(first).toHaveAttribute('src', 'blob:render-2');
    expect(first).not.toHaveAttribute('data-updating');
    expect(file()).toHaveAttribute('aria-busy', 'false');
    expect(within(file()).getByRole('figure')).toHaveTextContent(
      `${sizeOf(FEED).width} × ${sizeOf(FEED).height} JPG · 1.2 MB`,
    );
    expect(within(file()).queryByRole('progressbar')).toBeNull();

    // Cancelled, then failed: no picture, and it says why.
    fireEvent.keyDown(within(dialog).getByRole('application'), { key: 'ArrowRight' });
    await sent(3);
    act(() => {
      controller?.cancelAll();
    });
    expect(file()).toHaveTextContent('Cancelled before the file was made.');
    act(() => controller?.renderAgain(store().session?.cards[0]?.id as string));
    await sent(4);
    act(() => client.calls[3]?.reject(new RenderError('encode', 'Could not be saved as JPG.')));
    await idle();
    // The failure is said in the file's place, once.
    expect(file()).toHaveTextContent('Could not be saved as JPG.');
    expect(within(dialog).getAllByText('Could not be saved as JPG.')).toHaveLength(1);
  });

  it('shows why a photo cannot be edited in place of the crop area, and keeps the details', async () => {
    const { dialog } = await openDetails();
    const message =
      '"site.jpg" opens as 3024 x 4032 pixels in this browser, but it was 4032 x 3024 when it ' +
      'was imported, so its crop cannot be edited here.';
    photoLoads[0]?.reject(new SourcePhotoError(message));
    await act(() => Promise.resolve());
    expect(within(dialog).getByRole('alert')).toHaveTextContent(message);
    expect(within(dialog).queryByRole('application')).toBeNull();
    expect(dialog).toHaveTextContent('Version 1.');
    expect(within(dialog).getByRole('region', { name: 'Checks' })).toHaveTextContent(
      'Alt text is missing.',
    );
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('closes the photo when the dialog closes, and opens it again next time', async () => {
    const { dialog, opener } = await openDetails();
    const photo = await showPhoto();
    pressEscape(dialog);
    expect(dialog.open).toBe(false);
    expect(photo.close).toHaveBeenCalledTimes(1);
    fireEvent.click(opener);
    expect(photoLoads).toHaveLength(2);
  });

  it('says the original is missing for a card whose file is not in memory', () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    act(() => useSessionStore.setState({ missingAssetIds: [PHOTO.id] }));
    fireEvent.click(button('Open Instagram Feed vertical for site.jpg, v1'));
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(
      'The original file for "site.jpg" is missing.',
    );
    expect(photoLoads).toHaveLength(0);
  });

  it('shows the preview, not the editor, for a card that cannot be edited', () => {
    openSession(PHOTO);
    renderBoard();
    const base = {
      status: 'draft' as const,
      copy: { caption: '', firstComment: '', hashtags: [], altText: '' },
      validation: { level: 'pass' as const, issues: [] },
      overrideFail: false,
      comments: [],
    };
    const edit = {
      crop: { x: 0, y: 0, width: 1, height: 1 },
      overlays: [],
      format: 'jpg' as const,
      quality: 0.9,
    };
    act(() => {
      // A placement that is no longer in the platform data.
      store().addCard({
        ...base,
        edit,
        assetIds: [PHOTO.id],
        platform: 'instagram',
        placement: 'gone',
      });
      // A photo that is not in the session.
      store().addCard({
        ...base,
        edit,
        assetIds: [hash('e')],
        platform: 'linkedin',
        placement: 'image-square',
      });
      // Two photos, and a carousel.
      store().addCard({
        ...base,
        edit,
        assetIds: [PHOTO.id, PHOTO.id],
        platform: 'instagram',
        placement: 'feed-vertical',
      });
      store().addCard({
        ...base,
        edit: { slides: [], coverIndex: 0 },
        assetIds: [PHOTO.id],
        platform: 'instagram',
        placement: 'feed-square',
      });
    });
    for (const open of screen.getAllByRole('button', { name: /^Open / })) {
      fireEvent.click(open);
      const dialog = screen.getByRole('dialog') as HTMLDialogElement;
      expect(dialog).toHaveTextContent('No preview yet.');
      expect(within(dialog).queryByRole('status')).toBeNull();
      // No file can be made for it, so it has no file type or quality to change.
      expect(within(dialog).queryByRole('group', { name: 'File type' })).toBeNull();
      expect(within(dialog).queryByRole('slider')).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    }
    expect(photoLoads).toHaveLength(0);
  });

  it('shows "No problems found" and a failure message when they apply', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    await sent(1);
    act(() => client.calls[0]?.reject(new RenderError('encode', 'Could not be saved as JPG.')));
    await idle();
    act(() =>
      store().setValidation(store().session?.cards[0]?.id as string, { level: 'pass', issues: [] }),
    );
    fireEvent.click(button('Open Instagram Feed vertical for site.jpg, v1'));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('No problems found.');
    expect(dialog).toHaveTextContent('Could not be saved as JPG.');
  });

  it('shows the enlarged-picture note', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    await sent(1);
    answer(0, { upscaled: true });
    await idle();
    fireEvent.click(button('Open Instagram Feed vertical for site.jpg, v1'));
    const note = within(screen.getByRole('dialog')).getByText(/^Note: enlarged to fit\./);
    expect(note).toHaveClass('text-ink-secondary');
  });

  it('leaves the card alone when it is opened and closed without a change', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    await sent(1);
    answer(0);
    await idle();
    // A crop far below the smallest the editor allows: opening must not correct it.
    const id = store().session?.cards[0]?.id as string;
    act(() => {
      store().updateCard(id, (card) => {
        if ('crop' in card.edit) card.edit.crop = { x: 0.4, y: 0.4, width: 0.003, height: 0.005 };
      });
    });
    await sent(2);
    answer(1);
    await idle();
    act(() => store().markSaved(store().revision));
    const before = {
      card: store().session?.cards[0],
      session: store().session,
      undoSteps: store().undoStack.length,
      revision: store().revision,
    };
    expect(store().dirty).toBe(false);

    fireEvent.click(button('Open Instagram Feed vertical for site.jpg, v1'));
    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    // The editor is fully open, showing the crop enlarged to the smallest size it allows.
    await showPhoto();
    expect(within(dialog).getByRole('application')).toBeInTheDocument();
    expect(within(dialog).getByTestId('crop-rect').style.width).not.toBe('0.3%');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await idle();
    expect(dialog.open).toBe(false);

    // The very same objects: nothing was written, not even an equal value.
    expect(store().session).toBe(before.session);
    expect(store().session?.cards[0]).toBe(before.card);
    expect(store().undoStack).toHaveLength(before.undoSteps);
    expect(store().revision).toBe(before.revision);
    expect(store().dirty).toBe(false);
  });

  it('shows and renders a saved crop that breaks the crop limits corrected, without writing it back', async () => {
    const source = { width: PHOTO.width, height: PHOTO.height };
    const square = spec('linkedin', 'image-square');
    // Two saved crops no editor would make. The first is far larger than the fit size and off
    // to one side. The second is taller than the photo but placed so the photo sticks out of it.
    const tooLarge: Rect = { x: -3, y: 2.5, width: 9, height: 9 };
    const notHolding: Rect = { x: 0.05, y: 0.3, width: 0.78, height: 1.04 };
    const saved = (placement: PlacementSpec, id: string, crop: Rect) => {
      const draft = draftCard(PHOTO, placement);
      return { ...draft, id, version: 1, edit: { ...(draft.edit as ImageEdit), crop } };
    };
    const session: Session = {
      version: 1,
      id: 'saved-session',
      name: 'Saved',
      createdAt: '2026-11-16T09:00:00.000Z',
      updatedAt: '2026-11-16T09:00:00.000Z',
      brief: { topic: '', audience: '', cta: '', tone: 'neutral' },
      assets: [PHOTO],
      cards: [saved(FEED, 'feed', tooLarge), saved(square, 'square', notHolding)],
      groups: [],
    };
    act(() => {
      store().loadSession({
        session,
        brand: emptyBrand(),
        blobs: new Map([[PHOTO.id, new Blob([JPEG])]]),
        missingAssetIds: [],
        brandMissing: false,
      });
    });
    expect(store().dirty).toBe(false);
    renderBoard();
    await sent(2);

    // Rendered: the first as the fit frame, the second slid down until it holds the photo.
    const frame = fitWholeCrop(source, sizeOf(FEED));
    const feedPlan = client.calls[0]?.job.plan;
    expect(feedPlan?.crop).toEqual(cropToPixels(frame, source));
    expect(feedPlan?.cropRect.width).toBeCloseTo(frame.width, 10);
    expect(feedPlan?.cropRect.y).toBeCloseTo(frame.y, 10);
    const squarePlan = client.calls[1]?.job.plan;
    expect(squarePlan?.cropRect.y).toBe(0);
    expect(squarePlan?.cropRect.x).toBeCloseTo(0.05, 10);
    expect(squarePlan?.cropRect.height).toBeCloseTo(1.04, 10);
    answer(0);
    answer(1);
    await idle();

    const before = {
      session: store().session,
      feed: store().session?.cards[0],
      square: store().session?.cards[1],
      revision: store().revision,
    };
    // Rendering wrote nothing: the crops are the saved numbers, and nothing needs saving.
    expect((before.feed?.edit as ImageEdit).crop).toEqual(tooLarge);
    expect((before.square?.edit as ImageEdit).crop).toEqual(notHolding);
    expect(store().dirty).toBe(false);
    expect(store().undoStack).toEqual([]);

    // Displayed: the editor shows the corrected crop, in fractions of the photo.
    fireEvent.click(button('Open Instagram Feed vertical for site.jpg, v1'));
    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    await showPhoto();
    const shown = within(dialog).getByTestId('crop-rect').style;
    expect(Number.parseFloat(shown.left)).toBeCloseTo(frame.x * 100, 3);
    expect(Number.parseFloat(shown.top)).toBeCloseTo(frame.y * 100, 3);
    expect(Number.parseFloat(shown.width)).toBeCloseTo(frame.width * 100, 3);
    expect(Number.parseFloat(shown.height)).toBeCloseTo(frame.height * 100, 3);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(button('Open LinkedIn Image post square for site.jpg, v1'));
    await showPhoto();
    const second = within(screen.getByRole('dialog')).getByTestId('crop-rect').style;
    expect(Number.parseFloat(second.top)).toBeCloseTo(0, 3);
    expect(Number.parseFloat(second.height)).toBeCloseTo(104, 3);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await idle();

    // The very same objects: opening wrote nothing, not even an equal value.
    expect(store().session).toBe(before.session);
    expect(store().session?.cards[0]).toBe(before.feed);
    expect(store().session?.cards[1]).toBe(before.square);
    expect(store().undoStack).toEqual([]);
    expect(store().revision).toBe(before.revision);
    expect(store().dirty).toBe(false);
    // No further render was asked for either.
    expect(client.calls).toHaveLength(2);
  });

  it('renders the card again as PNG when PNG is chosen, and as JPG at the new quality', async () => {
    const { dialog } = await openDetails();
    await showPhoto();
    const fileRow = () => within(dialog).getByText(/^\d+ × \d+ (JPG|PNG) · /, { selector: 'dd' });
    const caption = () =>
      within(within(dialog).getByRole('region', { name: 'Rendered file' })).getByRole('figure');
    const { width, height } = sizeOf(FEED);
    expect(fileRow()).toHaveTextContent(`${width} × ${height} JPG · 400 KB`);
    expect(caption()).toHaveTextContent(`${width} × ${height} JPG · 400 KB`);
    expect(store().dirty).toBe(true);
    act(() => store().markSaved(store().revision));

    fireEvent.click(within(dialog).getByRole('radio', { name: 'PNG' }));
    // The card is changed (so autosave picks it up) and a new file is asked for, as PNG.
    expect(store().dirty).toBe(true);
    await sent(2);
    expect(client.calls[1]?.job.plan).toMatchObject({ format: 'png', target: { width, height } });
    expect(article(/v1/)).toHaveTextContent('Not checked yet');
    answer(1, {
      blob: new Blob(['png'], { type: 'image/png' }),
      mimeType: 'image/png',
      format: 'png',
      bytes: 1_200_000,
    });
    await idle();
    expect(fileRow()).toHaveTextContent(`${width} × ${height} PNG · 1.2 MB`);
    // The caption under the preview follows the new file.
    expect(caption()).toHaveTextContent(`${width} × ${height} PNG · 1.2 MB`);
    expect(within(caption()).getByRole('img')).toHaveAttribute('src', 'blob:render-2');
    expect(article(/v1/)).toHaveTextContent('Warning');

    // Back to JPG, then the quality: each is a new file at the placement's size.
    fireEvent.click(within(dialog).getByRole('radio', { name: 'JPG' }));
    await sent(3);
    expect(client.calls[2]?.job.plan).toMatchObject({ format: 'jpg', quality: 0.9 });
    answer(2);
    await idle();
    const slider = within(dialog).getByRole('slider', { name: 'Quality' });
    fireEvent.keyDown(slider, { key: 'PageDown' });
    fireEvent.keyUp(slider, { key: 'PageDown' });
    await sent(4);
    expect(client.calls[3]?.job.plan).toMatchObject({
      format: 'jpg',
      quality: 0.8,
      target: { width, height },
    });
  });

  it('undoes exactly a file type change with one Ctrl/Cmd-Z while its radio has focus', async () => {
    const { dialog } = await openDetails();
    await showPhoto();
    const png = within(dialog).getByRole('radio', { name: 'PNG' });
    fireEvent.click(png);
    png.focus();
    const steps = store().undoStack.length;
    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      png.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(store().undoStack).toHaveLength(steps - 1);
    expect(store().session?.cards[0]?.edit).toMatchObject({ format: 'jpg', quality: 0.9 });
    expect(within(dialog).getByRole('radio', { name: 'JPG' })).toBeChecked();
  });

  it('closes when undo removes its card, and moves focus to the board heading', async () => {
    const { dialog } = await openDetails();
    act(() => {
      store().undo();
    });
    expect(dialog.open).toBe(false);
    expect(screen.getByRole('heading', { name: 'Board' })).toHaveFocus();
  });
});

describe('the page behind the dialog', () => {
  const root = document.documentElement;
  let scrollTo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollTo = vi.fn();
    vi.spyOn(window, 'scrollTo').mockImplementation(scrollTo as () => void);
    // The board is scrolled 640 pixels down when the dialog opens.
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(640);
  });
  afterEach(() => {
    root.removeAttribute('style');
  });

  async function openDetails() {
    openSession(PHOTO);
    const view = renderBoard();
    createCards('Feed vertical');
    await sent(1);
    answer(0);
    await idle();
    const opener = button('Open Instagram Feed vertical for site.jpg, v1');
    const focus = vi.spyOn(opener, 'focus');
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Instagram Feed vertical' });
    return { ...view, opener, focus, dialog: dialog as HTMLDialogElement };
  }

  /** The page scrolls again and is back where it was when the dialog opened. */
  function expectReleased() {
    expect(root.style.overflow).toBe('');
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 640);
  }

  it('can scroll until the dialog opens, and not while it is open', async () => {
    expect(root.style.overflow).toBe('');
    await openDetails();
    expect(root.style.overflow).toBe('hidden');
    expect(scrollTo).not.toHaveBeenCalled();
    // It stays locked while the dialog changes: the photo opens, the crop moves.
    await showPhoto();
    fireEvent.keyDown(screen.getByRole('application'), { key: 'ArrowRight' });
    expect(root.style.overflow).toBe('hidden');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('is put back by Esc, with focus on the Open button and no scrolling to it', async () => {
    const { opener, focus, dialog } = await openDetails();
    pressEscape(dialog);
    expectReleased();
    expect(opener).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('is put back by the Close button, with focus on the Open button', async () => {
    const { opener, focus, dialog } = await openDetails();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expectReleased();
    expect(opener).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('is put back when undo removes the open card, with focus on the board heading', async () => {
    const { dialog } = await openDetails();
    const heading = screen.getByRole('heading', { name: 'Board' });
    const focus = vi.spyOn(heading, 'focus');
    act(() => {
      store().undo();
    });
    expect(dialog.open).toBe(false);
    expectReleased();
    expect(heading).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('is put back when the session is cleared with the dialog open', async () => {
    const { dialog } = await openDetails();
    act(() => {
      store().clearSession(() => true);
    });
    expect(dialog.open).toBe(false);
    expectReleased();
  });

  it('is put back when the board goes away with the dialog open', async () => {
    const { unmount } = await openDetails();
    unmount();
    expectReleased();
  });

  it('locks again each time the dialog opens, from where the page is then', async () => {
    const { opener, dialog } = await openDetails();
    pressEscape(dialog);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(200);
    fireEvent.click(opener);
    expect(root.style.overflow).toBe('hidden');
    pressEscape(dialog);
    expect(root.style.overflow).toBe('');
    expect(scrollTo).toHaveBeenLastCalledWith(0, 200);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});

describe('undo in the dialog', () => {
  const OVERRIDE = /^Export this card even though it fails its checks/;

  /** Sends Ctrl/Cmd-Z to `target` and returns the event. */
  function undoKey(target: Element) {
    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  /** Opens the dialog of a card that fails its checks, with the app-wide undo also listening. */
  async function openFailing() {
    openSession(PHOTO);
    render(
      <>
        <SessionPanel />
        <Board createClient={createClient} onController={onController} loadPhoto={loadPhoto} />
      </>,
    );
    createCards('Feed vertical');
    await sent(1);
    // Ten pixels narrow, so rule 1 fails and the override is offered.
    answer(0, { width: sizeOf(FEED).width - 10 });
    await idle();
    fireEvent.click(button('Open Instagram Feed vertical for site.jpg, v1'));
    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    await showPhoto();
    // Stands for any other undo listener: it hears only the Ctrl/Cmd-Z presses that get past.
    const outside = vi.fn();
    const hear = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') outside();
    };
    window.addEventListener('keydown', hear);
    return { dialog, outside, stop: () => window.removeEventListener('keydown', hear) };
  }

  it('has its controls in the order the spec gives, from the crop area to Close', async () => {
    const { dialog, stop } = await openFailing();
    /** What Tab reaches, in order: everything focusable that is not disabled. */
    const order = () =>
      [...dialog.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')]
        .filter((element) => !(element as HTMLButtonElement).disabled)
        .map(
          (element) =>
            element.getAttribute('data-testid') ??
            element.getAttribute('aria-label')?.split('.')[0] ??
            (element.closest('label')?.textContent || element.textContent),
        );
    const rest = [
      'Fit whole photo',
      'Background colour picker',
      'Hex code',
      'JPG',
      'PNG',
      'Quality',
      'Export this card even though it fails its checks',
      'Close',
    ];
    // Reset crop is disabled on the automatic crop, so Tab passes over it.
    expect(order()).toEqual(['Crop of site', 'focal-marker', ...rest]);
    fireEvent.keyDown(within(dialog).getByRole('application'), { key: 'ArrowRight' });
    expect(order()).toEqual(['Crop of site', 'focal-marker', 'Reset crop', ...rest]);
    stop();
  });

  it('draws a colour being tried in the picker in the editor, and writes it when the picker closes', async () => {
    const { dialog, stop } = await openFailing();
    const picker = within(dialog).getByLabelText('Background colour picker') as HTMLInputElement;
    const padding = () => within(dialog).getByTestId('crop-padding');
    expect(padding().style.backgroundColor).toBe('rgb(255, 255, 255)');
    const before = { session: store().session, steps: store().undoStack.length };
    fireEvent.input(picker, { target: { value: '#0a7f5c' } });
    // Live in the editor, and not written yet: no undo step, no new render.
    expect(padding().style.backgroundColor).toBe('rgb(10, 127, 92)');
    expect(store().session).toBe(before.session);
    expect(client.calls).toHaveLength(1);
    fireEvent.input(picker, { target: { value: '#112233' } });
    expect(padding().style.backgroundColor).toBe('rgb(17, 34, 51)');
    // Escape: Chrome puts the card's colour back in the picker, so closing it changes nothing.
    fireEvent.input(picker, { target: { value: '#ffffff' } });
    fireEvent(picker, new Event('cancel', { bubbles: true }));
    expect(padding().style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(store().undoStack).toHaveLength(before.steps);
    // Closed on a new colour by focus leaving it, with no change event: one step, and the card
    // is rendered again in that colour.
    fireEvent.input(picker, { target: { value: '#0a7f5c' } });
    fireEvent.blur(picker);
    expect(store().session?.cards[0]?.background).toBe('#0a7f5c');
    expect(store().undoStack).toHaveLength(before.steps + 1);
    expect(padding().style.backgroundColor).toBe('rgb(10, 127, 92)');
    await sent(2);
    expect(client.calls[1]?.job.plan.background).toBe('#0a7f5c');
    answer(1);
    await idle();
    stop();
  });

  it('steps back through a colour change and Fit whole photo, one press each', async () => {
    const { dialog, outside, stop } = await openFailing();
    const card = () => store().session?.cards[0] as Card & { edit: ImageEdit };
    const automatic = card().edit.crop;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fit whole photo' }));
    const fitted = card().edit.crop;
    expect(fitted.height).toBeGreaterThan(1);
    const hex = within(dialog).getByRole('textbox', { name: 'Hex code' });
    fireEvent.change(hex, { target: { value: '0A7F5C' } });
    fireEvent.keyDown(hex, { key: 'Enter' });
    expect(card().background).toBe('#0a7f5c');
    // The card is rendered again for what it is now: fitted, in the new colour.
    await sent(2);
    expect(client.calls.at(-1)?.job.plan.background).toBe('#0a7f5c');

    // In the hex box Ctrl/Cmd-Z is for typing: it is let through, and nothing is undone.
    expect(undoKey(hex).defaultPrevented).toBe(false);
    expect(card().background).toBe('#0a7f5c');
    // On the colour picker, which holds no text, each press undoes one change in the dialog.
    const picker = within(dialog).getByLabelText('Background colour picker');
    expect(undoKey(picker).defaultPrevented).toBe(true);
    expect(Object.hasOwn(card(), 'background')).toBe(false);
    expect(card().edit.crop).toEqual(fitted);
    expect(undoKey(picker).defaultPrevented).toBe(true);
    expect(card().edit.crop).toEqual(automatic);
    // Nothing left of the dialog's own: a further press does nothing, and the card stays.
    undoKey(picker);
    expect(store().session?.cards).toHaveLength(1);
    expect(card().edit.crop).toEqual(automatic);
    expect(outside).toHaveBeenCalledTimes(1);
    stop();
  });

  it('with focus on the override checkbox, one press undoes exactly one dialog change', async () => {
    const { dialog, outside, stop } = await openFailing();
    const cardOf = () => store().session?.cards[0];
    const cropBefore = cardOf()?.edit;
    fireEvent.keyDown(within(dialog).getByRole('application'), { key: 'ArrowRight' });
    const checkbox = within(dialog).getByRole('checkbox', { name: OVERRIDE });
    fireEvent.click(checkbox);
    checkbox.focus();
    const steps = store().undoStack.length;
    expect(cardOf()?.overrideFail).toBe(true);

    // The tick is undone, and only the tick.
    const first = undoKey(checkbox);
    expect(first.defaultPrevented).toBe(true);
    expect(store().undoStack).toHaveLength(steps - 1);
    expect(cardOf()?.overrideFail).toBe(false);
    expect(cardOf()?.edit).not.toEqual(cropBefore);

    // Then the crop move.
    undoKey(checkbox);
    expect(store().undoStack).toHaveLength(steps - 2);
    expect(cardOf()?.edit).toEqual(cropBefore);

    // Nothing left that the dialog did: the press is stopped and changes nothing, so the card
    // made before the dialog opened is still there.
    const spare = undoKey(checkbox);
    expect(spare.defaultPrevented).toBe(true);
    expect(store().undoStack).toHaveLength(steps - 2);
    expect(store().session?.cards).toHaveLength(1);
    expect(outside).not.toHaveBeenCalled();
    stop();
  });

  it('with no change made in the dialog, a press does nothing, wherever the focus is', async () => {
    const { dialog, outside, stop } = await openFailing();
    const steps = store().undoStack.length;
    const before = store().session;
    for (const target of [
      within(dialog).getByRole('checkbox', { name: OVERRIDE }),
      within(dialog).getByRole('application'),
      document.body,
    ]) {
      expect(undoKey(target).defaultPrevented).toBe(true);
    }
    expect(store().undoStack).toHaveLength(steps);
    expect(store().session).toBe(before);
    expect(outside).not.toHaveBeenCalled();
    stop();
  });

  it('starts again from nothing each time the dialog opens', async () => {
    const { dialog, outside, stop } = await openFailing();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: OVERRIDE }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(button('Open Instagram Feed vertical for site.jpg, v1'));
    await showPhoto();
    const reopened = screen.getByRole('dialog');
    const steps = store().undoStack.length;
    undoKey(within(reopened).getByRole('checkbox', { name: OVERRIDE }));
    // The tick was made the last time the dialog was open, so it stays.
    expect(store().undoStack).toHaveLength(steps);
    expect(store().session?.cards[0]?.overrideFail).toBe(true);
    expect(outside).not.toHaveBeenCalled();
    stop();
  });
});

describe('the session and the controller', () => {
  it('undo of a card that is rendering removes it and cancels its job', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical', 'Image post square');
    await sent(2);
    act(() => {
      store().undo();
    });
    // Cancelling is immediate: the job is settled as cancelled before undo returns.
    expect(client.calls[1]?.settled).toBe(true);
    expect(within(cardList()).getAllByRole('article')).toHaveLength(1);
    expect(client.cancelled).toEqual([client.calls[1]?.job.id]);
  });

  it('opening another session closes the form and clears the board', async () => {
    openSession(PHOTO);
    renderBoard();
    createCards('Feed vertical');
    await sent(1);
    fireEvent.click(button('Create cards'));
    act(() => store().createSession('Another'));
    expect(screen.queryByRole('form', { name: 'Create cards' })).toBeNull();
    expect(status('Board messages')).toBeEmptyDOMElement();
    expect(screen.getByText(NO_PHOTOS_TEXT)).toBeInTheDocument();
    expect(client.calls[0]?.settled).toBe(true);
  });

  it('under StrictMode, the first controller is disposed and only the second renders', async () => {
    openSession(PHOTO);
    render(
      <StrictMode>
        <Board createClient={createClient} onController={onController} />
      </StrictMode>,
    );
    expect(clients).toHaveLength(2);
    expect(clients[0]?.disposed).toBe(true);
    expect(clients[1]?.disposed).toBe(false);
    createCards('Feed vertical');
    await sent(1);
    answer(0);
    await idle();
    expect(clients[0]?.calls).toEqual([]);
    expect(within(cardList()).getByRole('img')).toBeInTheDocument();
  });

  it('unmounting disposes of the controller and the worker client', async () => {
    openSession(PHOTO);
    const { unmount } = renderBoard();
    createCards('Feed vertical');
    await sent(1);
    unmount();
    expect(controller).toBeNull();
    expect(client.disposed).toBe(true);
    expect(client.calls[0]?.settled).toBe(true);
  });
});

describe('telling the export panel when the board is busy', () => {
  it('reports busy while previews are waiting or being made, and not busy once they are done', async () => {
    const onBusyChange = vi.fn();
    openSession(PHOTO);
    render(
      <Board
        createClient={createClient}
        onController={onController}
        loadPhoto={loadPhoto}
        onBusyChange={onBusyChange}
      />,
    );
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    createCards('Feed vertical', 'Image post square');
    await sent(2);
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    answer(0);
    await act(() => Promise.resolve());
    // One card is still being made.
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    answer(1);
    await idle();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('counts a cancelled preview as finished', async () => {
    const onBusyChange = vi.fn();
    openSession(PHOTO);
    render(
      <Board createClient={createClient} onController={onController} onBusyChange={onBusyChange} />,
    );
    createCards('Feed vertical');
    await sent(1);
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(button('Cancel all'));
    await idle();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });
});

describe('undo of the post text boxes in the dialog', () => {
  /** Sends Ctrl/Cmd-Z to `target` and returns the event. */
  function undoKey(target: Element) {
    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  const steps = () => store().undoStack.length;
  const stored = () => store().session?.cards[0];

  /** Opens a card's dialog with its editor, with the app-wide undo also listening. */
  async function open() {
    openSession(PHOTO);
    render(
      <>
        <SessionPanel />
        <Board createClient={createClient} onController={onController} loadPhoto={loadPhoto} />
      </>,
    );
    createCards('Feed vertical');
    await sent(1);
    answer(0);
    await idle();
    const opener = button('Open Instagram Feed vertical for site.jpg, v1');
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    await showPhoto();
    const heading = within(dialog).getByRole('heading', { level: 2 });
    const box = (label: string) => within(dialog).getByLabelText(label) as HTMLTextAreaElement;
    /** One visit to a box: focus it, type the whole text, and leave for the heading. */
    function visit(label: string, text: string) {
      act(() => box(label).focus());
      fireEvent.change(box(label), { target: { value: text } });
      act(() => heading.focus());
    }
    return { dialog, opener, heading, box, visit };
  }

  it('leaves Ctrl/Cmd-Z inside a box to the browser: no app or dialog undo', async () => {
    const { box, visit } = await open();
    visit('Caption', 'One');
    const before = steps();
    act(() => box('Caption').focus());
    fireEvent.change(box('Caption'), { target: { value: 'One two' } });
    const event = undoKey(box('Caption'));
    // Not prevented, so the browser undoes the typing; the card and the undo list are untouched.
    expect(event.defaultPrevented).toBe(false);
    expect(steps()).toBe(before);
    expect(stored()?.copy.caption).toBe('One');
    expect(box('Caption').value).toBe('One two');
  });

  it('restores the whole previous text in one step with Ctrl/Cmd-Z after leaving the box', async () => {
    const { heading, box } = await open();
    const before = steps();
    act(() => box('Caption').focus());
    for (const text of ['H', 'He', 'Hello', 'Hello world']) {
      fireEvent.change(box('Caption'), { target: { value: text } });
    }
    act(() => heading.focus());
    expect(steps()).toBe(before + 1);
    expect(undoKey(heading).defaultPrevented).toBe(true);
    expect(steps()).toBe(before);
    expect(stored()?.copy.caption).toBe('');
    expect(box('Caption').value).toBe('');
  });

  it('makes two visits to the caption two steps, each undone by its own Ctrl/Cmd-Z', async () => {
    const { heading, box, visit } = await open();
    const before = steps();
    visit('Caption', 'First visit');
    visit('Caption', 'First visit, then the second');
    expect(steps()).toBe(before + 2);
    undoKey(heading);
    expect(stored()?.copy.caption).toBe('First visit');
    expect(box('Caption').value).toBe('First visit');
    undoKey(heading);
    expect(stored()?.copy.caption).toBe('');
    expect(steps()).toBe(before);
  });

  it('makes a caption visit and a hashtags visit two steps, undone one at a time', async () => {
    const { heading, box, visit } = await open();
    const before = steps();
    visit('Caption', 'Topping out');
    visit('Hashtags', '#build #site');
    expect(steps()).toBe(before + 2);
    undoKey(heading);
    expect(stored()?.copy).toMatchObject({ caption: 'Topping out', hashtags: [] });
    expect(box('Hashtags').value).toBe('');
    undoKey(heading);
    expect(stored()?.copy).toMatchObject({ caption: '', hashtags: [] });
  });

  it.each(['quality first', 'caption first'] as const)(
    'keeps a quality change and a caption visit as separate steps (%s)',
    async (order) => {
      const { dialog, heading, visit } = await open();
      const before = steps();
      const slider = within(dialog).getByRole('slider', { name: 'Quality' });
      const quality = () => {
        fireEvent.keyDown(slider, { key: 'PageDown' });
        fireEvent.keyUp(slider, { key: 'PageDown' });
      };
      const edit = () => stored()?.edit as ImageEdit;
      if (order === 'quality first') {
        quality();
        visit('Caption', 'After the quality');
      } else {
        visit('Caption', 'Before the quality');
        quality();
      }
      expect(steps()).toBe(before + 2);
      expect(edit().quality).toBe(0.8);
      // Each Ctrl/Cmd-Z undoes exactly one of them, newest first.
      undoKey(heading);
      if (order === 'quality first') {
        expect(stored()?.copy.caption).toBe('');
        expect(edit().quality).toBe(0.8);
      } else {
        expect(stored()?.copy.caption).toBe('Before the quality');
        expect(edit().quality).toBe(0.9);
      }
      undoKey(heading);
      expect(stored()?.copy.caption).toBe('');
      expect(edit().quality).toBe(0.9);
      expect(steps()).toBe(before);
    },
  );

  it('writes a focused box once when Esc closes the dialog, and keeps the text', async () => {
    const { dialog, box } = await open();
    const before = steps();
    act(() => box('First comment').focus());
    fireEvent.change(box('First comment'), { target: { value: 'Typed, then Esc' } });
    pressEscape(dialog);
    expect(dialog.open).toBe(false);
    expect(steps()).toBe(before + 1);
    expect(stored()?.copy.firstComment).toBe('Typed, then Esc');
    fireEvent.click(button('Open Instagram Feed vertical for site.jpg, v1'));
    expect(within(screen.getByRole('dialog')).getByLabelText('First comment')).toHaveValue(
      'Typed, then Esc',
    );
    expect(steps()).toBe(before + 1);
  });

  it('stays closed when a box writes its text between Esc and the close event, as in Chrome', async () => {
    const { dialog, opener, box } = await open();
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    try {
      act(() => box('Caption').focus());
      fireEvent.change(box('Caption'), { target: { value: 'Typed, then Esc' } });
      // Chrome's order: close() ends the open state and moves focus back to the Open button
      // (so the box writes its text) before the close event is fired.
      act(() => {
        dialog.removeAttribute('open');
        opener.focus();
      });
      expect(stored()?.copy.caption).toBe('Typed, then Esc');
      act(() => {
        dialog.dispatchEvent(new Event('close'));
      });
      expect(showModal).not.toHaveBeenCalled();
      expect(dialog.open).toBe(false);
      expect(opener).toHaveFocus();
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      showModal.mockRestore();
    }
  });

  it('writes a focused box once when the Close button closes the dialog', async () => {
    const { dialog, box } = await open();
    const before = steps();
    act(() => box('Hashtags').focus());
    fireEvent.change(box('Hashtags'), { target: { value: '#one, #two' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(dialog.open).toBe(false);
    expect(steps()).toBe(before + 1);
    expect(stored()?.copy.hashtags).toEqual(['#one', '#two']);
  });
});
