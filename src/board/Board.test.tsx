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
import type { PlacementSpec } from '../types';
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

function renderBoard() {
  return render(<Board createClient={createClient} onController={onController} />);
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
    expect(within(form).queryByRole('checkbox', { name: /Carousel|Reel|Video/ })).toBeNull();
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
    expect(dialog).toHaveTextContent('No preview yet.');
    expect(dialog).toHaveTextContent('Not made yet');
    expect(dialog).toHaveTextContent('The file has not been made yet');
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

  it('closes when undo removes its card, and moves focus to the board heading', async () => {
    const { dialog } = await openDetails();
    act(() => {
      store().undo();
    });
    expect(dialog.open).toBe(false);
    expect(screen.getByRole('heading', { name: 'Board' })).toHaveFocus();
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
