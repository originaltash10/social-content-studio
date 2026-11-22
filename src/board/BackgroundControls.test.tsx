/**
 * The background colour controls. The store is real and the card is read from it on every
 * render, as the board does. jsdom has no colour picker, so the picker is driven with the
 * events a browser sends: `input` for each colour tried, then `change` when the picker is
 * closed on a new colour, or `cancel` when it is closed with no change. The real picker and
 * real typing are checked in Chromium.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTyping } from '../app/keys';
import { backgroundOf } from '../lib/render/background';
import { useSessionStore } from '../store/sessionStore';
import { hash, makeAsset, makeCard } from '../test/fixtures';
import type { Card } from '../types';
import { BackgroundControls } from './BackgroundControls';
import {
  BACKGROUND_LEGEND,
  BACKGROUND_NOTE,
  HEX_LABEL,
  PICKER_NAME,
  invalidHexMessage,
} from './backgroundColour';
import { createDialogUndo } from './dialogUndo';
import type { DialogUndo } from './dialogUndo';

const PHOTO = makeAsset({ id: hash('a'), fileName: 'site.jpg' });
const store = () => useSessionStore.getState();
const card = () => store().session?.cards[0] as Card;
const steps = () => store().undoStack.length;

const picker = () => screen.getByLabelText(PICKER_NAME) as HTMLInputElement;
const hex = () => screen.getByRole('textbox', { name: HEX_LABEL }) as HTMLInputElement;
const message = () => document.getElementById(hex().getAttribute('aria-describedby') ?? '');

let undo: DialogUndo;
let onPreview: ReturnType<typeof vi.fn<(colour: string | null) => void>>;

/** The controls for the session's one card, as it is in the store now. */
function Live() {
  const current = useSessionStore((state) => state.session?.cards[0]);
  if (!current) return null;
  return (
    <BackgroundControls
      cardId={current.id}
      background={backgroundOf(current)}
      record={undo.record}
      onPreview={onPreview}
    />
  );
}

/** Opens a session with one card, with the given colour or none, and shows the controls. */
function openWith(background?: string) {
  act(() => {
    store().clearSession(() => true);
    store().createSession('Background test');
    store().addAssets([{ asset: PHOTO, blob: new Blob(['photo']) }]);
    const { id, version, parentId, ...draft } = makeCard({ assetIds: [PHOTO.id] });
    void [id, version, parentId]; // the store gives these
    store().addCard(background === undefined ? draft : { ...draft, background });
  });
  undo = createDialogUndo();
  onPreview = vi.fn<(colour: string | null) => void>();
  const view = render(<Live />);
  return { ...view, before: snapshot() };
}

function snapshot() {
  return { session: store().session, steps: steps(), revision: store().revision };
}
function expectUntouched(before: ReturnType<typeof snapshot>) {
  expect(store().session).toBe(before.session);
  expect(steps()).toBe(before.steps);
  expect(store().revision).toBe(before.revision);
}

/** A colour tried in the open picker: the browser's `input` event. */
const tryColour = (colour: string) => fireEvent.input(picker(), { target: { value: colour } });
/** The picker closed on the colour it shows: the browser's `change` event. */
const closePicker = () => fireEvent(picker(), new Event('change', { bubbles: true }));
/** The picker closed with no change: the browser's `cancel` event. */
const cancelPicker = () => fireEvent(picker(), new Event('cancel', { bubbles: true }));

function type(text: string) {
  fireEvent.change(hex(), { target: { value: text } });
}
const pressEnter = () => fireEvent.keyDown(hex(), { key: 'Enter' });

beforeEach(() => {
  act(() => {
    store().clearSession(() => true);
  });
});

describe('what is shown', () => {
  it('is a named group with a note, a colour picker and a labelled hex box', () => {
    openWith();
    expect(screen.getByRole('group', { name: BACKGROUND_LEGEND })).toBeInTheDocument();
    expect(BACKGROUND_LEGEND).toBe('Background colour');
    expect(screen.getByText(BACKGROUND_NOTE)).toBeInTheDocument();
    expect(BACKGROUND_NOTE).toContain("where the crop goes past the photo's edges");
    expect(picker().type).toBe('color');
    expect(hex().type).toBe('text');
    expect(HEX_LABEL).toBe('Hex code');
  });

  it('shows white for a card with no colour, and writes nothing by being shown', () => {
    const { before } = openWith();
    expect(Object.hasOwn(card(), 'background')).toBe(false);
    expect(picker().value).toBe('#ffffff');
    expect(hex().value).toBe('#ffffff');
    expectUntouched(before);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("shows the card's colour, and follows it when it changes", () => {
    openWith('#0a7f5c');
    expect(picker().value).toBe('#0a7f5c');
    expect(hex().value).toBe('#0a7f5c');
    act(() => {
      store().updateCard(card().id, (draft) => {
        draft.background = '#112233';
      });
    });
    expect(picker().value).toBe('#112233');
    expect(hex().value).toBe('#112233');
  });

  it('comes before nothing else here: the picker is first in the Tab order, then the hex box', () => {
    openWith();
    expect(picker().compareDocumentPosition(hex()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(picker().tabIndex).toBe(0);
    expect(hex().tabIndex).toBe(0);
  });

  it('keeps room for a message, so one appearing moves nothing', () => {
    openWith();
    expect(message()).toBeInTheDocument();
    expect(message()?.textContent).toBe('');
    expect(message()?.className).toContain('min-h-8');
  });
});

describe('the colour picker', () => {
  it('shows each colour as it is tried, and writes nothing until it is closed', () => {
    const { before } = openWith();
    tryColour('#ff0000');
    expect(onPreview).toHaveBeenLastCalledWith('#ff0000');
    expect(picker().value).toBe('#ff0000');
    tryColour('#00ff00');
    tryColour('#0a7f5c');
    expect(onPreview).toHaveBeenLastCalledWith('#0a7f5c');
    expectUntouched(before);
  });

  it('writes once, as one undo step, when it is closed on a new colour', () => {
    const { before } = openWith();
    tryColour('#ff0000');
    tryColour('#0a7f5c');
    closePicker();
    expect(card().background).toBe('#0a7f5c');
    expect(steps()).toBe(before.steps + 1);
    expect(undo.count()).toBe(1);
    // The preview is over: the card's own colour is what shows now.
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(picker().value).toBe('#0a7f5c');
    expect(hex().value).toBe('#0a7f5c');
  });

  it('is undone by one step of the dialog undo, back to no colour', () => {
    openWith();
    tryColour('#0a7f5c');
    closePicker();
    act(() => {
      expect(undo.undo()).toBe(true);
    });
    expect(Object.hasOwn(card(), 'background')).toBe(false);
    expect(picker().value).toBe('#ffffff');
    expect(hex().value).toBe('#ffffff');
    expect(undo.undo()).toBe(false);
  });

  it('writes nothing and takes the preview back when it is closed with no change', () => {
    const { before } = openWith('#0a7f5c');
    tryColour('#ff0000');
    expect(onPreview).toHaveBeenLastCalledWith('#ff0000');
    cancelPicker();
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(picker().value).toBe('#0a7f5c');
    expectUntouched(before);
  });

  it('writes nothing when it is closed on the colour the card already has', () => {
    const { before, unmount } = openWith('#0a7f5c');
    tryColour('#ff0000');
    tryColour('#0a7f5c');
    closePicker();
    expectUntouched(before);
    expect(onPreview).toHaveBeenLastCalledWith(null);
    unmount();
    // White on a card with no colour is no change either.
    const plain = openWith();
    tryColour('#ffffff');
    closePicker();
    expectUntouched(plain.before);
  });

  it('takes the preview back when it loses focus or goes away without a change', () => {
    const { before, unmount } = openWith();
    tryColour('#ff0000');
    fireEvent.blur(picker());
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(picker().value).toBe('#ffffff');
    tryColour('#00ff00');
    unmount();
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expectUntouched(before);
  });

  it('holds no text, so Ctrl/Cmd-Z on it undoes the last change in the dialog', () => {
    openWith();
    expect(isTyping(picker())).toBe(false);
  });
});

describe('the hex box', () => {
  it.each([
    ['with "#"', '#0a7f5c'],
    ['without "#"', '0a7f5c'],
    ['in capitals', '0A7F5C'],
    ['with spaces around it', ' #0A7f5C '],
  ])('applies a colour typed %s on Enter, as one undo step', (_name, text) => {
    const { before } = openWith();
    type(text);
    // Nothing is written while typing.
    expectUntouched(before);
    pressEnter();
    expect(card().background).toBe('#0a7f5c');
    expect(steps()).toBe(before.steps + 1);
    expect(undo.count()).toBe(1);
    // The box shows the colour as it is stored.
    expect(hex().value).toBe('#0a7f5c');
    expect(picker().value).toBe('#0a7f5c');
    expect(message()?.textContent).toBe('');
    expect(hex()).toHaveAttribute('aria-invalid', 'false');
  });

  it('applies a typed colour when the box loses focus, as one undo step', () => {
    const { before } = openWith();
    type('112233');
    fireEvent.blur(hex());
    expect(card().background).toBe('#112233');
    expect(steps()).toBe(before.steps + 1);
    expect(hex().value).toBe('#112233');
  });

  it('writes once for Enter followed by leaving the box', () => {
    const { before } = openWith();
    type('112233');
    pressEnter();
    fireEvent.blur(hex());
    expect(steps()).toBe(before.steps + 1);
  });

  it('writes nothing for the colour the card already has, however it is typed', () => {
    const { before } = openWith('#0a7f5c');
    type('0A7F5C');
    pressEnter();
    expect(hex().value).toBe('#0a7f5c');
    type('#0a7f5c');
    fireEvent.blur(hex());
    // Focus passing through the box without typing writes nothing either.
    fireEvent.focus(hex());
    fireEvent.blur(hex());
    pressEnter();
    expectUntouched(before);
  });

  it.each(['0a7f5', '#0af', '0a7f5cff', 'green', '0a7f5z', ''])(
    'does not apply "%s": Enter says why in plain words and leaves the text to be corrected',
    (text) => {
      const { before } = openWith('#0a7f5c');
      type(text);
      pressEnter();
      expectUntouched(before);
      expect(message()?.textContent).toBe(invalidHexMessage('#0a7f5c'));
      expect(hex()).toHaveAttribute('aria-invalid', 'true');
      expect(hex()).toHaveAccessibleDescription(invalidHexMessage('#0a7f5c'));
      expect(hex().value).toBe(text);
      // Typing again clears the message.
      type(`${text}1`);
      expect(message()?.textContent).toBe('');
    },
  );

  it("puts the card's colour back in the box when it is left with something that is not a colour", () => {
    const { before } = openWith('#0a7f5c');
    type('not a colour');
    fireEvent.blur(hex());
    expect(hex().value).toBe('#0a7f5c');
    expect(message()?.textContent).toBe(invalidHexMessage('#0a7f5c'));
    expectUntouched(before);
    // The same after Enter and then leaving.
    type('12');
    pressEnter();
    expect(hex().value).toBe('12');
    fireEvent.blur(hex());
    expect(hex().value).toBe('#0a7f5c');
    expectUntouched(before);
  });

  it('can be corrected after a mistake', () => {
    const { before } = openWith();
    type('0a7f5');
    pressEnter();
    type('0a7f5c');
    pressEnter();
    expect(card().background).toBe('#0a7f5c');
    expect(steps()).toBe(before.steps + 1);
    expect(message()?.textContent).toBe('');
  });

  it('keeps Enter to itself and leaves every other key alone', () => {
    openWith();
    type('112233');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => {
      hex().dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(true);
    for (const key of ['ArrowLeft', 'ArrowUp', 'Escape', 'Tab', 'a', 'z']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => {
        hex().dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('holds text, so Ctrl/Cmd-Z in it undoes typing, not the last change in the dialog', () => {
    openWith();
    expect(isTyping(hex())).toBe(true);
  });

  it('is undone by one step of the dialog undo, back to the colour before', () => {
    openWith('#0a7f5c');
    type('112233');
    pressEnter();
    act(() => {
      expect(undo.undo()).toBe(true);
    });
    expect(card().background).toBe('#0a7f5c');
    expect(hex().value).toBe('#0a7f5c');
  });
});

describe('without a listener for the preview', () => {
  it('still works', () => {
    act(() => {
      store().createSession('No preview');
      const { id, version, parentId, ...draft } = makeCard();
      void [id, version, parentId];
      store().addCard(draft);
    });
    const change = vi.fn((run: () => void) => run());
    const { unmount } = render(
      <BackgroundControls cardId={card().id} background="#ffffff" record={change} />,
    );
    tryColour('#0a7f5c');
    closePicker();
    expect(card().background).toBe('#0a7f5c');
    expect(change).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('writes nothing for a card that is no longer in the session', () => {
    act(() => {
      store().createSession('Gone');
    });
    const change = vi.fn((run: () => void) => run());
    render(<BackgroundControls cardId="gone" background="#ffffff" record={change} />);
    tryColour('#0a7f5c');
    closePicker();
    expect(store().undoStack).toEqual([]);
  });
});
