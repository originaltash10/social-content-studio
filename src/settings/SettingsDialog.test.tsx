/**
 * Settings dialog tests. The key store is real (on fake-indexeddb), and so is the Claude adapter:
 * only the browser's fetch is replaced, so no request ever leaves the test.
 */
import 'fake-indexeddb/auto';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clear, createStore } from 'idb-keyval';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPanel } from '../app/SessionPanel';
import { newSession, requestClearSession } from '../store/persistence';
import { useSessionStore } from '../store/sessionStore';
import { SECRET, makeBrand, makeSession } from '../test/fixtures';
import * as keyStore from './keyStore';
import { SETTINGS_DATABASE, SETTINGS_STORE, chooseProvider, readKey, saveKey } from './keyStore';
import { ACTION_MESSAGES, KEY_STATE, connectionMessage } from './messages';
import { Settings } from './SettingsDialog';

// The real key store, with each function wrapped so a test can make one call fail.
vi.mock('./keyStore', async (original) => {
  const actual = await original<typeof import('./keyStore')>();
  return {
    ...actual,
    chooseProvider: vi.fn(actual.chooseProvider),
    chosenProvider: vi.fn(actual.chosenProvider),
    saveKey: vi.fn(actual.saveKey),
    removeKey: vi.fn(actual.removeKey),
  };
});

// jsdom has no <dialog> behaviour. As in src/board/Board.test.tsx, this stand-in follows the
// browser: showModal opens it, close closes it and fires "close", and Esc fires a cancelable
// "cancel" and then closes it. The real dialog is checked in Chromium (e2e/settings.check.mjs).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    if (this.open) throw new DOMException('already open', 'InvalidStateError');
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

/** Esc as the browser handles it: the key goes to the focused control, then the dialog closes. */
function pressEscape(from: Element) {
  act(() => {
    const dialogElement = from.closest('dialog') as HTMLDialogElement;
    fireEvent.keyDown(from, { key: 'Escape' });
    const cancel = new Event('cancel', { cancelable: true });
    dialogElement.dispatchEvent(cancel);
    if (!cancel.defaultPrevented) dialogElement.close();
  });
}

type Fetch = typeof globalThis.fetch;
const PROVIDER_TEXT = 'PROVIDER-TEXT-MARKER';

/** A fetch that answers every request with `status`, recording each one. */
function answering(status: number) {
  const body = JSON.stringify({ type: 'error', error: { type: 'x', message: PROVIDER_TEXT } });
  return vi.fn<Fetch>(async () => new Response(status === 200 ? '{}' : body, { status }));
}

/** A fetch that never answers, and fails as a browser's does when it is aborted. */
function hanging() {
  return vi.fn<Fetch>(
    (_, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      }),
  );
}

const settingsButton = () => screen.getByRole('button', { name: 'Settings' });
const dialog = () => screen.getByRole('dialog', { name: 'Settings' });
const inDialog = () => within(dialog());
const radio = () => inDialog().getByRole('radio', { name: 'Claude (Anthropic)' });
const keyBox = () => dialog().querySelector('input[type="password"]') as HTMLInputElement;
const button = (name: string) => inDialog().getByRole('button', { name });
const status = () => inDialog().getByRole('status', { name: 'Settings messages' });

/** Opens Settings and waits until it has read what is saved. */
async function openSettings() {
  fireEvent.click(settingsButton());
  await waitFor(() =>
    expect(
      [KEY_STATE.noProvider, KEY_STATE.noKey, KEY_STATE.saved].some((text) =>
        dialog().textContent?.includes(text),
      ),
    ).toBe(true),
  );
}

async function choose() {
  fireEvent.click(radio());
  await waitFor(() => expect(status()).toHaveTextContent('Claude (Anthropic) chosen.'));
}

async function typeAndSave(text: string) {
  fireEvent.change(keyBox(), { target: { value: text } });
  fireEvent.click(button('Save key'));
}

/** Every piece of text and every input value in the document. */
const pageText = () =>
  [
    document.body.innerHTML,
    document.body.textContent ?? '',
    ...[...document.querySelectorAll('input, textarea')].map(
      (element) => (element as HTMLInputElement).value,
    ),
  ].join('\n');

let fetchSpy: ReturnType<typeof answering>;

beforeEach(async () => {
  await clear(createStore(SETTINGS_DATABASE, SETTINGS_STORE));
  fetchSpy = answering(200);
  vi.stubGlobal('fetch', fetchSpy);
  document.documentElement.style.overflow = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the Settings button', () => {
  it('opens a modal dialog titled Settings, with focus on its heading', async () => {
    render(<Settings />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await openSettings();
    expect(dialog()).toHaveAttribute('open');
    const heading = inDialog().getByRole('heading', { name: 'Settings' });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('opens without a session and makes no network request', async () => {
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open');
    render(<Settings />);
    expect(useSessionStore.getState().session).toBeNull();
    await openSettings();
    await chooseProvider('anthropic');
    fireEvent.click(button('Close'));
    await openSettings();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('works under StrictMode, opening once', async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    render(
      <StrictMode>
        <Settings />
      </StrictMode>,
    );
    await openSettings();
    expect(showModal).toHaveBeenCalledTimes(1);
  });
});

describe('the dialog', () => {
  it('has its controls, labels and notes in the agreed order', async () => {
    render(<Settings />);
    await openSettings();
    expect(inDialog().getByText(/kept in this browser on this computer only/)).toBeVisible();
    expect(inDialog().getByRole('group', { name: 'AI provider' })).toContainElement(radio());
    const tabbable = [...dialog().querySelectorAll<HTMLElement>('input, button')].filter(
      (element) => element.tabIndex >= 0,
    );
    expect(tabbable.map((e) => (e instanceof HTMLInputElement ? e.type : e.textContent))).toEqual([
      'radio',
      'password',
      'Save key',
      'Test connection',
      'Remove key',
      'Close',
    ]);
    expect(tabbable[0]).toBe(radio());
    expect(radio()).not.toBeChecked();
    expect(inDialog().getByLabelText('API key')).toBe(keyBox());
    expect(keyBox()).toHaveAttribute('autocomplete', 'off');
    expect(keyBox()).toHaveAttribute('spellcheck', 'false');
    expect(keyBox()).toHaveAccessibleDescription(
      "Paste the key from your provider's account. Once saved, it is not shown again.",
    );
    expect(button('Test connection')).toHaveAccessibleDescription(
      'Sends your key to api.anthropic.com to check it. No photos or text are sent.',
    );
    expect(dialog()).toHaveTextContent(KEY_STATE.noProvider);
    expect(dialog().querySelector('form')).toBeNull();
    for (const name of ['Save key', 'Test connection', 'Remove key', 'Close']) {
      expect(button(name)).toBeEnabled();
    }
  });

  it('locks the page scroll while open and releases it on close', async () => {
    render(<Settings />);
    await openSettings();
    expect(document.documentElement.style.overflow).toBe('hidden');
    fireEvent.click(button('Close'));
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('Close and Escape close it and put focus back on the Settings button', async () => {
    render(<Settings />);
    await openSettings();
    fireEvent.click(button('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(settingsButton()).toHaveFocus();

    await openSettings();
    pressEscape(keyBox());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(settingsButton()).toHaveFocus();
  });

  it('releases the scroll lock if it goes away while open', async () => {
    const { unmount } = render(<Settings />);
    await openSettings();
    unmount();
    expect(document.documentElement.style.overflow).toBe('');
  });
});

describe('choosing a provider', () => {
  it('saves the choice at once, and labels the key box for it', async () => {
    const { unmount } = render(<Settings />);
    await openSettings();
    await choose();
    expect(radio()).toBeChecked();
    expect(inDialog().getByLabelText('Claude (Anthropic) API key')).toBe(keyBox());
    expect(dialog()).toHaveTextContent(KEY_STATE.noKey);
    expect(await keyStore.chosenProvider()).toBe('anthropic');
    unmount();
    render(<Settings />);
    await openSettings();
    expect(radio()).toBeChecked();
  });

  it('says so when the choice cannot be saved, and leaves nothing chosen', async () => {
    vi.mocked(keyStore.chooseProvider).mockRejectedValueOnce(new Error(PROVIDER_TEXT));
    render(<Settings />);
    await openSettings();
    fireEvent.click(radio());
    await waitFor(() => expect(status()).toHaveTextContent(ACTION_MESSAGES.chooseFailed));
    expect(radio()).not.toBeChecked();
    expect(pageText()).not.toContain(PROVIDER_TEXT);
  });

  it('says so when the saved settings cannot be read', async () => {
    vi.mocked(keyStore.chosenProvider).mockRejectedValueOnce(new Error(PROVIDER_TEXT));
    render(<Settings />);
    fireEvent.click(settingsButton());
    await waitFor(() => expect(status()).toHaveTextContent(ACTION_MESSAGES.readFailed));
    expect(pageText()).not.toContain(PROVIDER_TEXT);
  });
});

describe('Save key', () => {
  it('asks for a provider first, and saves nothing', async () => {
    render(<Settings />);
    await openSettings();
    await typeAndSave(SECRET);
    expect(status()).toHaveTextContent(ACTION_MESSAGES.chooseFirst);
    expect(await readKey('anthropic')).toBeNull();
  });

  it.each(['', '   ', '\n \r\n'])('asks for a key when the box is empty (%j)', async (text) => {
    render(<Settings />);
    await openSettings();
    await choose();
    await typeAndSave(text);
    expect(status()).toHaveTextContent(ACTION_MESSAGES.pasteFirst);
    expect(await readKey('anthropic')).toBeNull();
  });

  it('saves the trimmed key, empties the box, and never shows the key again', async () => {
    render(<Settings />);
    await openSettings();
    await choose();
    await typeAndSave(`  ${SECRET}\n`);
    await waitFor(() => expect(status()).toHaveTextContent(ACTION_MESSAGES.saved));
    expect(dialog()).toHaveTextContent(KEY_STATE.saved);
    expect(keyBox()).toHaveValue('');
    expect(await readKey('anthropic')).toBe(SECRET);
    expect(pageText()).not.toContain(SECRET);

    fireEvent.click(button('Close'));
    await openSettings();
    expect(dialog()).toHaveTextContent(KEY_STATE.saved);
    expect(keyBox()).toHaveValue('');
    expect(pageText()).not.toContain(SECRET);
  });

  it('says when a new key replaces the one saved before', async () => {
    await chooseProvider('anthropic');
    await saveKey('anthropic', 'older-fake-value');
    render(<Settings />);
    await openSettings();
    await typeAndSave(SECRET);
    await waitFor(() => expect(status()).toHaveTextContent(ACTION_MESSAGES.replaced));
    expect(await readKey('anthropic')).toBe(SECRET);
  });

  it('Enter in the key box saves it', async () => {
    render(<Settings />);
    await openSettings();
    await choose();
    fireEvent.change(keyBox(), { target: { value: SECRET } });
    fireEvent.keyDown(keyBox(), { key: 'Enter' });
    await waitFor(() => expect(status()).toHaveTextContent(ACTION_MESSAGES.saved));
    expect(await readKey('anthropic')).toBe(SECRET);
    expect(keyBox()).toHaveValue('');
  });

  it('other keys in the key box save nothing', async () => {
    render(<Settings />);
    await openSettings();
    await choose();
    fireEvent.change(keyBox(), { target: { value: SECRET } });
    fireEvent.keyDown(keyBox(), { key: 'a' });
    expect(await readKey('anthropic')).toBeNull();
  });

  it('says so when the key cannot be saved, without the error text', async () => {
    vi.mocked(keyStore.saveKey).mockRejectedValueOnce(new Error(PROVIDER_TEXT));
    render(<Settings />);
    await openSettings();
    await choose();
    await typeAndSave(SECRET);
    await waitFor(() => expect(status()).toHaveTextContent(ACTION_MESSAGES.saveFailed));
    expect(dialog().textContent).not.toContain(PROVIDER_TEXT);
  });

  it('text typed and not saved is gone when Settings closes, and is never stored', async () => {
    render(<Settings />);
    await openSettings();
    await choose();
    fireEvent.change(keyBox(), { target: { value: SECRET } });
    pressEscape(keyBox());
    await openSettings();
    expect(keyBox()).toHaveValue('');
    expect(await readKey('anthropic')).toBeNull();
    expect(pageText()).not.toContain(SECRET);
    fireEvent.change(keyBox(), { target: { value: SECRET } });
    fireEvent.click(button('Close'));
    expect(pageText()).not.toContain(SECRET);
    expect(await readKey('anthropic')).toBeNull();
  });

  it('a save that finishes after Settings closed shows nothing', async () => {
    let finish: (value: keyStore.SaveOutcome) => void = () => {};
    vi.mocked(keyStore.saveKey).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    render(<Settings />);
    await openSettings();
    await choose();
    await typeAndSave(SECRET);
    fireEvent.click(button('Close'));
    await act(async () => finish('saved'));
    await openSettings();
    expect(status()).toHaveTextContent('');
  });
});

describe('Remove key', () => {
  it('asks for a provider first', async () => {
    render(<Settings />);
    await openSettings();
    fireEvent.click(button('Remove key'));
    expect(status()).toHaveTextContent(ACTION_MESSAGES.chooseFirst);
  });

  it('removes the key at once, without asking, and empties the box', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    await chooseProvider('anthropic');
    await saveKey('anthropic', SECRET);
    render(<Settings />);
    await openSettings();
    expect(dialog()).toHaveTextContent(KEY_STATE.saved);
    fireEvent.change(keyBox(), { target: { value: 'typed' } });
    fireEvent.click(button('Remove key'));
    expect(keyBox()).toHaveValue('');
    await waitFor(() => expect(status()).toHaveTextContent(ACTION_MESSAGES.removed));
    expect(dialog()).toHaveTextContent(KEY_STATE.noKey);
    expect(await readKey('anthropic')).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('says when there was no key to remove', async () => {
    render(<Settings />);
    await openSettings();
    await choose();
    fireEvent.click(button('Remove key'));
    await waitFor(() => expect(status()).toHaveTextContent(ACTION_MESSAGES.nothingToRemove));
  });

  it('says so when the key cannot be removed, without the error text', async () => {
    vi.mocked(keyStore.removeKey).mockRejectedValueOnce(new Error(PROVIDER_TEXT));
    render(<Settings />);
    await openSettings();
    await choose();
    fireEvent.click(button('Remove key'));
    await waitFor(() => expect(status()).toHaveTextContent(ACTION_MESSAGES.removeFailed));
    expect(dialog().textContent).not.toContain(PROVIDER_TEXT);
  });
});

describe('Test connection', () => {
  it('asks for a provider first, and sends nothing', async () => {
    render(<Settings />);
    await openSettings();
    fireEvent.click(button('Test connection'));
    expect(status()).toHaveTextContent(ACTION_MESSAGES.chooseFirst);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with no key saved, says so and sends nothing', async () => {
    render(<Settings />);
    await openSettings();
    await choose();
    fireEvent.click(button('Test connection'));
    await waitFor(() => expect(status()).toHaveTextContent(connectionMessage('no-key') as string));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the saved key, not text typed in the box', async () => {
    await chooseProvider('anthropic');
    await saveKey('anthropic', SECRET);
    render(<Settings />);
    await openSettings();
    fireEvent.change(keyBox(), { target: { value: 'typed-not-saved' } });
    fireEvent.click(button('Test connection'));
    expect(status()).toHaveTextContent(ACTION_MESSAGES.checking);
    await waitFor(() => expect(status()).toHaveTextContent(connectionMessage('ok') as string));
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(SECRET);
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain('typed-not-saved');
  });

  it.each([
    [401, 'wrong-key'],
    [403, 'forbidden'],
    [429, 'rate-limited'],
    [500, 'provider-problem'],
  ] as const)('a %i answer shows the app message, not the provider text', async (code, result) => {
    vi.stubGlobal('fetch', answering(code));
    await chooseProvider('anthropic');
    await saveKey('anthropic', SECRET);
    render(<Settings />);
    await openSettings();
    fireEvent.click(button('Test connection'));
    await waitFor(() => expect(status()).toHaveTextContent(connectionMessage(result) as string));
    expect(pageText()).not.toContain(PROVIDER_TEXT);
    expect(pageText()).not.toContain(SECRET);
  });

  it('a network failure shows the app message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<Fetch>(async () => {
        throw new TypeError(`Failed to fetch ${PROVIDER_TEXT}`);
      }),
    );
    await chooseProvider('anthropic');
    await saveKey('anthropic', SECRET);
    render(<Settings />);
    await openSettings();
    fireEvent.click(button('Test connection'));
    await waitFor(() =>
      expect(status()).toHaveTextContent(connectionMessage('unreachable') as string),
    );
    expect(pageText()).not.toContain(PROVIDER_TEXT);
  });

  it.each(['Close', 'Escape'])(
    'closing with %s cancels a running test: the request is aborted and no message appears later',
    async (how) => {
      const fetch = hanging();
      vi.stubGlobal('fetch', fetch);
      await chooseProvider('anthropic');
      await saveKey('anthropic', SECRET);
      render(<Settings />);
      await openSettings();
      fireEvent.click(button('Test connection'));
      expect(status()).toHaveTextContent(ACTION_MESSAGES.checking);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      if (how === 'Close') fireEvent.click(button('Close'));
      else pressEscape(button('Test connection'));
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      await openSettings();
      expect(status()).toHaveTextContent('');
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(status()).toHaveTextContent('');
    },
  );

  it.each(['Save key', 'Remove key', 'Test connection'])(
    'pressing %s while a test runs cancels it, and its result never shows',
    async (name) => {
      const fetch = hanging();
      vi.stubGlobal('fetch', fetch);
      await chooseProvider('anthropic');
      await saveKey('anthropic', SECRET);
      render(<Settings />);
      await openSettings();
      fireEvent.click(button('Test connection'));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      if (name === 'Save key') fireEvent.change(keyBox(), { target: { value: SECRET } });
      fireEvent.click(button(name));
      await waitFor(() => expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(status().textContent).not.toBe(connectionMessage('unreachable'));
      expect(status().textContent).not.toBe(connectionMessage('timeout'));
    },
  );

  it('clicking the provider already chosen changes nothing, and leaves a running test alone', async () => {
    const fetch = hanging();
    vi.stubGlobal('fetch', fetch);
    await chooseProvider('anthropic');
    await saveKey('anthropic', SECRET);
    render(<Settings />);
    await openSettings();
    fireEvent.click(button('Test connection'));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    // A checked radio button fires no change when clicked, so this goes straight to the input.
    fireEvent.click(radio());
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });
});

describe('keys and the page', () => {
  beforeEach(() => {
    act(() => {
      useSessionStore.getState().loadSession({
        session: makeSession(),
        brand: makeBrand(),
        blobs: new Map(),
        missingAssetIds: [],
        brandMissing: false,
      });
      useSessionStore.getState().updateCard('card-1', (card) => {
        card.copy.caption = 'An edit to undo';
      });
    });
  });

  const caption = () => useSessionStore.getState().session?.cards[0]?.copy.caption;

  it('Escape pressed in Settings reaches no other key handler on the page', async () => {
    const onWindow = vi.fn();
    const onDocument = vi.fn();
    window.addEventListener('keydown', onWindow);
    document.addEventListener('keydown', onDocument);
    render(<Settings />);
    await openSettings();
    for (const target of [keyBox(), radio(), button('Save key'), dialog()]) {
      fireEvent.keyDown(target, { key: 'Escape' });
    }
    expect(onWindow).not.toHaveBeenCalled();
    expect(onDocument).not.toHaveBeenCalled();
    pressEscape(keyBox());
    expect(settingsButton()).toHaveFocus();
    // A key outside Settings still reaches the page.
    fireEvent.keyDown(settingsButton(), { key: 'Escape' });
    expect(onWindow).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', onWindow);
    document.removeEventListener('keydown', onDocument);
  });

  it('Ctrl/Cmd-Z in Settings never undoes a change to the session', async () => {
    render(
      <>
        <Settings />
        <SessionPanel />
      </>,
    );
    await openSettings();
    for (const target of [radio(), keyBox(), button('Remove key'), dialog()]) {
      fireEvent.keyDown(target, { key: 'z', ctrlKey: true });
      fireEvent.keyDown(target, { key: 'z', metaKey: true });
      fireEvent.keyDown(target, { key: 'Z', ctrlKey: true, shiftKey: true });
    }
    expect(caption()).toBe('An edit to undo');
    // In the key box the browser's typing undo is left alone.
    expect(fireEvent.keyDown(keyBox(), { key: 'z', ctrlKey: true })).toBe(true);
    fireEvent.click(button('Close'));
    // Outside Settings, Ctrl-Z is the app's undo as before.
    fireEvent.keyDown(settingsButton(), { key: 'z', ctrlKey: true });
    expect(caption()).not.toBe('An edit to undo');
  });

  it('New session and Clear leave the key and the choice alone, and Settings leaves the session alone', async () => {
    await chooseProvider('anthropic');
    await saveKey('anthropic', SECRET);
    render(<Settings />);
    await openSettings();
    const before = JSON.stringify(useSessionStore.getState().session);
    fireEvent.click(button('Remove key'));
    await waitFor(() => expect(status()).toHaveTextContent(ACTION_MESSAGES.removed));
    await typeAndSave(SECRET);
    await waitFor(() => expect(status()).toHaveTextContent(ACTION_MESSAGES.saved));
    expect(JSON.stringify(useSessionStore.getState().session)).toBe(before);
    expect(JSON.stringify(useSessionStore.getState())).not.toContain(SECRET);

    act(() => newSession('Another'));
    expect(await readKey('anthropic')).toBe(SECRET);
    await act(async () => {
      await requestClearSession(() => true);
    });
    expect(useSessionStore.getState().session).toBeNull();
    expect(await readKey('anthropic')).toBe(SECRET);
    expect(await keyStore.chosenProvider()).toBe('anthropic');
  });
});
