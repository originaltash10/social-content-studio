import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supportsFolders } from '../lib/session/fsAccess';
import { platforms } from '../lib/platforms';
import * as persistence from '../store/persistence';
import { useSessionStore } from '../store/sessionStore';
import { hash, makeBrand, makeSession } from '../test/fixtures';
import { SessionPanel } from './SessionPanel';

const stopAutosave = vi.hoisted(() => vi.fn());
vi.mock('../store/persistence', () => ({
  currentFolderName: vi.fn(() => null),
  downloadBundle: vi.fn(() => Promise.resolve(true)),
  loadBundle: vi.fn(() => Promise.resolve(true)),
  newSession: vi.fn(),
  openSessionFolder: vi.fn(() => Promise.resolve(true)),
  reopenLastSession: vi.fn(() => Promise.resolve(true)),
  requestClearSession: vi.fn((confirm: () => boolean) => Promise.resolve(confirm())),
  saveSession: vi.fn(() => Promise.resolve(true)),
  startAutosave: vi.fn(() => stopAutosave),
}));
vi.mock('../lib/session/fsAccess', () => ({ supportsFolders: vi.fn(() => true) }));

const store = () => useSessionStore.getState();
const button = (name: string | RegExp) => screen.getByRole('button', { name });

/** Opens a saved (not dirty) session in the store. */
function openSavedSession(missingAssetIds: string[] = []) {
  act(() => {
    store().loadSession({
      session: makeSession(),
      brand: makeBrand(),
      blobs: new Map(),
      missingAssetIds,
      brandMissing: false,
    });
  });
}

/** Makes an edit so the open session has unsaved changes. */
function makeDirty() {
  act(() => {
    store().updateCard('card-1', (card) => {
      card.copy.caption = 'Edited';
    });
  });
}

/** Stands in for window.confirm; each test decides what the user answers. */
const confirm = vi.fn((message?: string) => message !== undefined);

beforeEach(() => {
  act(() => {
    store().clearSession(() => true);
  });
  vi.clearAllMocks();
  vi.mocked(supportsFolders).mockReturnValue(true);
  vi.mocked(persistence.currentFolderName).mockReturnValue(null);
  confirm.mockReturnValue(true);
  vi.spyOn(window, 'confirm').mockImplementation((message) => confirm(message));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('with no session open', () => {
  it('says so and disables the actions that need a session', () => {
    render(<SessionPanel />);
    expect(screen.getByText('No session is open.')).toBeInTheDocument();
    expect(button('Save')).toBeDisabled();
    expect(button('Download .scs')).toBeDisabled();
    expect(button('Clear session')).toBeDisabled();
    expect(button(/Add sample card/)).toBeDisabled();
    expect(button(/Undo/)).toBeDisabled();
    expect(button('New session')).toBeEnabled();
    expect(button('Open folder')).toBeEnabled();
    expect(button('Reopen last')).toBeEnabled();
    expect(button('Load .scs')).toBeEnabled();
  });

  it('New session uses the name in the field, without asking', () => {
    render(<SessionPanel />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Topping out  ' } });
    fireEvent.click(button('New session'));
    expect(confirm).not.toHaveBeenCalled();
    expect(persistence.newSession).toHaveBeenCalledWith('Topping out');
  });

  it('New session falls back to a default name when the field is blank', () => {
    render(<SessionPanel />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    fireEvent.click(button('New session'));
    expect(persistence.newSession).toHaveBeenCalledWith('Untitled session');
  });

  it('Open folder and Reopen last call through', () => {
    render(<SessionPanel />);
    fireEvent.click(button('Open folder'));
    fireEvent.click(button('Reopen last'));
    expect(persistence.openSessionFolder).toHaveBeenCalledTimes(1);
    expect(persistence.reopenLastSession).toHaveBeenCalledTimes(1);
  });
});

describe('with a session open', () => {
  it('shows the session, its folder, and that it is saved', () => {
    vi.mocked(persistence.currentFolderName).mockReturnValue('MySession');
    openSavedSession();
    render(<SessionPanel />);
    expect(screen.getByText('Topping out')).toBeInTheDocument();
    expect(screen.getByText('MySession')).toBeInTheDocument();
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
    expect(screen.getByText('2 assets, 3 cards')).toBeInTheDocument();
    expect(screen.getByText('Not yet')).toBeInTheDocument();
  });

  it('shows unsaved changes and no folder for a session that has neither', () => {
    openSavedSession();
    makeDirty();
    render(<SessionPanel />);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByText('None yet')).toBeInTheDocument();
  });

  it('shows when it was last saved', () => {
    openSavedSession();
    act(() => store().markSaved(store().revision));
    render(<SessionPanel />);
    expect(screen.queryByText('Not yet')).not.toBeInTheDocument();
  });

  it('Save and Download .scs call through', () => {
    openSavedSession();
    render(<SessionPanel />);
    fireEvent.click(button('Save'));
    fireEvent.click(button('Download .scs'));
    expect(persistence.saveSession).toHaveBeenCalledTimes(1);
    expect(persistence.downloadBundle).toHaveBeenCalledTimes(1);
  });

  it('Add sample card adds a card with a placement from platforms.json', () => {
    openSavedSession();
    render(<SessionPanel />);
    fireEvent.click(button(/Add sample card/));
    const added = store().session?.cards.at(-1);
    expect(store().session?.cards).toHaveLength(4);
    expect(platforms.placements.map((p) => p.placement)).toContain(added?.placement);
    expect(screen.getByText('2 assets, 4 cards')).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('the Undo button shows the depth and undoes the last card change', () => {
    openSavedSession();
    render(<SessionPanel />);
    fireEvent.click(button(/Add sample card/));
    fireEvent.click(button('Undo (1)'));
    expect(store().session?.cards).toHaveLength(3);
    expect(button('Undo (0)')).toBeDisabled();
  });
});

describe('confirmation before unsaved changes are lost', () => {
  beforeEach(() => {
    openSavedSession();
    makeDirty();
  });

  it.each([
    ['New session', () => persistence.newSession],
    ['Open folder', () => persistence.openSessionFolder],
    ['Reopen last', () => persistence.reopenLastSession],
  ])('%s asks first and does nothing when declined', (name, action) => {
    confirm.mockReturnValue(false);
    render(<SessionPanel />);
    fireEvent.click(button(name));
    expect(confirm).toHaveBeenCalledWith(
      'The open session has unsaved changes. Discard them and continue?',
    );
    expect(action()).not.toHaveBeenCalled();
  });

  it.each([
    ['New session', () => persistence.newSession],
    ['Open folder', () => persistence.openSessionFolder],
    ['Reopen last', () => persistence.reopenLastSession],
  ])('%s goes ahead when confirmed', (name, action) => {
    render(<SessionPanel />);
    fireEvent.click(button(name));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(action()).toHaveBeenCalledTimes(1);
  });

  it('Load .scs does not open the file chooser when declined', () => {
    confirm.mockReturnValue(false);
    render(<SessionPanel />);
    const input = screen.getByLabelText('Session bundle file');
    const click = vi.spyOn(input, 'click');
    fireEvent.click(button('Load .scs'));
    expect(click).not.toHaveBeenCalled();
  });

  it('does not ask when there are no unsaved changes', () => {
    act(() => store().markSaved(store().revision));
    render(<SessionPanel />);
    fireEvent.click(button('Open folder'));
    expect(confirm).not.toHaveBeenCalled();
    expect(persistence.openSessionFolder).toHaveBeenCalledTimes(1);
  });
});

describe('Load .scs', () => {
  it('opens the file chooser and passes the chosen file on', () => {
    render(<SessionPanel />);
    const input = screen.getByLabelText<HTMLInputElement>('Session bundle file');
    const click = vi.spyOn(input, 'click');
    fireEvent.click(button('Load .scs'));
    expect(click).toHaveBeenCalledTimes(1);

    const file = new File(['zip'], 'topping-out.scs');
    fireEvent.change(input, { target: { files: [file] } });
    expect(persistence.loadBundle).toHaveBeenCalledWith(file, 'topping-out.scs');
  });

  it('does nothing when the file chooser is closed without a file', () => {
    render(<SessionPanel />);
    fireEvent.change(screen.getByLabelText('Session bundle file'), { target: { files: [] } });
    expect(persistence.loadBundle).not.toHaveBeenCalled();
  });
});

describe('Clear session', () => {
  it('asks for confirmation and says nothing on disk is deleted', () => {
    openSavedSession();
    render(<SessionPanel />);
    fireEvent.click(button('Clear session'));
    expect(persistence.requestClearSession).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      'Clear this session? It will be removed from the app. Nothing on disk will be deleted.',
    );
  });

  it('passes a declined confirmation through', async () => {
    confirm.mockReturnValue(false);
    openSavedSession();
    render(<SessionPanel />);
    fireEvent.click(button('Clear session'));
    const result = vi.mocked(persistence.requestClearSession).mock.results[0]?.value as
      Promise<boolean> | undefined;
    expect(await result).toBe(false);
  });
});

describe('status line', () => {
  it('is empty when there is nothing to report', () => {
    render(<SessionPanel />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it.each(['info', 'warning', 'error'] as const)('shows a %s message', (kind) => {
    render(<SessionPanel />);
    act(() => store().setStatus({ kind, message: `A ${kind} message` }));
    expect(screen.getByRole('status')).toHaveTextContent(`A ${kind} message`);
  });

  it('keeps listing missing asset files by name, whatever the status line says', () => {
    openSavedSession([hash('b')]);
    render(<SessionPanel />);
    act(() => store().setStatus({ kind: 'info', message: 'Saved to folder "MySession".' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Missing asset files: clip.mp4');
    expect(screen.getByRole('status')).toHaveTextContent('Saved to folder "MySession".');
  });

  it('shows no missing-files line when every asset was found', () => {
    openSavedSession();
    render(<SessionPanel />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('browsers without folder access', () => {
  it('disables the folder actions and points to the .scs buttons', () => {
    vi.mocked(supportsFolders).mockReturnValue(false);
    openSavedSession();
    render(<SessionPanel />);
    expect(button('Open folder')).toBeDisabled();
    expect(button('Reopen last')).toBeDisabled();
    expect(button('Save')).toBeDisabled();
    expect(button('Download .scs')).toBeEnabled();
    expect(button('Load .scs')).toBeEnabled();
    expect(screen.getByText(/This browser cannot open or save folders/)).toBeInTheDocument();
  });

  it('shows no such note in Chrome or Edge', () => {
    render(<SessionPanel />);
    expect(screen.queryByText(/This browser cannot open or save folders/)).not.toBeInTheDocument();
  });
});

describe('autosave timer', () => {
  it('starts when the panel mounts and stops when it unmounts', () => {
    const { unmount } = render(<SessionPanel />);
    expect(persistence.startAutosave).toHaveBeenCalledTimes(1);
    expect(stopAutosave).not.toHaveBeenCalled();
    unmount();
    expect(stopAutosave).toHaveBeenCalledTimes(1);
  });
});

describe('Ctrl/Cmd-Z', () => {
  beforeEach(() => {
    openSavedSession();
    makeDirty();
  });

  const caption = () => store().session?.cards[0]?.copy.caption;

  it('Ctrl-Z undoes the last card change', () => {
    render(<SessionPanel />);
    expect(caption()).toBe('Edited');
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(caption()).toBe('Topping out this week.');
  });

  it('Cmd-Z does the same on a Mac', () => {
    render(<SessionPanel />);
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(caption()).toBe('Topping out this week.');
  });

  it.each([
    ['plain z', { key: 'z' }],
    ['Ctrl-Shift-Z', { key: 'z', ctrlKey: true, shiftKey: true }],
    ['Ctrl-Y', { key: 'y', ctrlKey: true }],
  ])('%s does not undo', (_name, init) => {
    render(<SessionPanel />);
    fireEvent.keyDown(window, init);
    expect(caption()).toBe('Edited');
  });

  it('leaves Ctrl-Z alone while typing in a field', () => {
    render(<SessionPanel />);
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'z', ctrlKey: true });
    expect(caption()).toBe('Edited');
  });

  it('stops listening when the panel unmounts', () => {
    const { unmount } = render(<SessionPanel />);
    unmount();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(caption()).toBe('Edited');
  });
});
