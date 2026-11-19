/**
 * The file type and quality controls. The store is real and the card is read from it on every
 * render, as the board does. jsdom does no native slider dragging, so a drag is the pointer
 * events with `input` events between them, as Chromium sends them; the real slider is checked in
 * Chromium.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../store/sessionStore';
import { hash, makeAsset, makeCard, makeImageEdit } from '../test/fixtures';
import type { Card, ImageEdit } from '../types';
import { createDialogUndo } from './dialogUndo';
import type { DialogUndo } from './dialogUndo';
import { FileTypeControls } from './FileTypeControls';
import { PNG_NOTE } from './fileSettings';

const PHOTO = makeAsset({ id: hash('a'), fileName: 'site.jpg' });
const store = () => useSessionStore.getState();
const card = () => store().session?.cards[0] as Card & { edit: ImageEdit };
const steps = () => store().undoStack.length;

const radio = (name: 'JPG' | 'PNG') => screen.getByRole('radio', { name });
const slider = () => screen.getByRole('slider', { name: 'Quality' });
const querySlider = () => screen.queryByRole('slider', { name: 'Quality' });

let undo: DialogUndo;

/** The controls for the session's one card, as it is in the store now. */
function Live() {
  const current = useSessionStore((state) => state.session?.cards[0]);
  if (!current || !('format' in current.edit)) return null;
  return (
    <FileTypeControls cardId={current.id} edit={current.edit} record={undo.record} undo={undo} />
  );
}

/** Opens a session with one card whose edit has the given fields, and shows the controls. */
function openWith(fields: Partial<ImageEdit> | 'none') {
  const edit: Partial<ImageEdit> = { ...makeImageEdit(), ...(fields === 'none' ? {} : fields) };
  // A card with no quality. (A card with no format is not an image card anywhere in the app:
  // isImageEdit goes by the format, and a session file without one does not load.)
  if (fields === 'none') delete edit.quality;
  act(() => {
    store().clearSession(() => true);
    store().createSession('File type test');
    store().addAssets([{ asset: PHOTO, blob: new Blob(['photo']) }]);
    const { id, version, parentId, ...draft } = makeCard({
      assetIds: [PHOTO.id],
      edit: edit as ImageEdit,
    });
    void [id, version, parentId]; // the store gives these
    store().addCard(draft);
  });
  undo = createDialogUndo();
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
/** One more undo step than `before`, and the session marked as changed. */
function expectOneStep(before: ReturnType<typeof snapshot>) {
  expect(steps()).toBe(before.steps + 1);
  expect(store().revision).toBe(before.revision + 1);
  expect(store().dirty).toBe(true);
}

function expectShows(percent: number) {
  expect(screen.getByText(`Quality: ${percent}%`)).toBeInTheDocument();
  expect(slider()).toHaveAttribute('aria-valuetext', `${percent}%`);
}

beforeEach(() => {
  act(() => {
    store().clearSession(() => true);
  });
});

describe('what it shows', () => {
  it('a "File type" group with JPG and PNG, and the quality slider for JPG', () => {
    openWith({ format: 'jpg', quality: 0.75 });
    expect(screen.getByRole('group', { name: 'File type' })).toBeInTheDocument();
    expect(radio('JPG')).toBeChecked();
    expect(radio('PNG')).not.toBeChecked();
    expectShows(75);
    expect(slider()).toHaveAttribute('min', '10');
    expect(slider()).toHaveAttribute('max', '100');
    expect(slider()).toHaveAttribute('step', '1');
    expect(screen.queryByText(PNG_NOTE)).toBeNull();
  });

  it('a card without a quality as JPG at 90%, and writes nothing', () => {
    const { before } = openWith('none');
    expect(radio('JPG')).toBeChecked();
    expectShows(90);
    expectUntouched(before);
  });

  it('an edit with neither field as JPG at 90%, as the renderer reads it', () => {
    undo = createDialogUndo();
    render(<FileTypeControls cardId="none" edit={{}} record={undo.record} />);
    expect(radio('JPG')).toBeChecked();
    expectShows(90);
  });

  it('for PNG, no slider but a short note', () => {
    openWith({ format: 'png', quality: 0.75 });
    expect(radio('PNG')).toBeChecked();
    expect(querySlider()).toBeNull();
    expect(screen.getByText(PNG_NOTE)).toBeInTheDocument();
  });

  it('a stored quality below the range as it is, and writes nothing until the slider is moved', () => {
    const { before } = openWith({ quality: 0.05 });
    expectShows(5);
    // Keys that mean "lower" cannot raise it, so nothing is written.
    for (const key of ['ArrowLeft', 'PageDown', 'Home']) {
      fireEvent.keyDown(slider(), { key });
      fireEvent.keyUp(slider(), { key });
    }
    fireEvent.blur(slider());
    expectShows(5);
    expectUntouched(before);
    // A drag that is cancelled writes nothing either.
    fireEvent.pointerDown(slider(), { pointerId: 1, isPrimary: true });
    fireEvent.input(slider(), { target: { value: '40' } });
    fireEvent.pointerCancel(slider(), { pointerId: 1 });
    expectShows(5);
    expectUntouched(before);
    // Moved: written.
    fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    fireEvent.keyUp(slider(), { key: 'ArrowRight' });
    expect(card().edit.quality).toBe(0.1);
    expectOneStep(before);
  });

  it('follows the card when it changes elsewhere (undo)', () => {
    openWith({ quality: 0.5 });
    fireEvent.click(radio('PNG'));
    act(() => {
      undo.undo();
    });
    expect(radio('JPG')).toBeChecked();
    expectShows(50);
  });
});

describe('choosing a file type', () => {
  it('is one undo step that marks the card changed, and keeps the stored quality', () => {
    const { before } = openWith({ format: 'jpg', quality: 0.6 });
    fireEvent.click(radio('PNG'));
    expect(card().edit.format).toBe('png');
    expect(card().edit.quality).toBe(0.6);
    expectOneStep(before);
    expect(querySlider()).toBeNull();
    expect(screen.getByText(PNG_NOTE)).toBeInTheDocument();

    fireEvent.click(radio('JPG'));
    expect(card().edit.format).toBe('jpg');
    expect(card().edit.quality).toBe(0.6);
    expect(steps()).toBe(before.steps + 2);
    expectShows(60);
  });

  it('never writes a quality to a card that has none', () => {
    openWith('none');
    fireEvent.click(radio('PNG'));
    fireEvent.click(radio('JPG'));
    expect(card().edit.format).toBe('jpg');
    expect('quality' in card().edit).toBe(false);
    expectShows(90);
  });

  it('writes nothing when the type the card already has is chosen', () => {
    const { before } = openWith({ format: 'png' });
    fireEvent.click(radio('PNG'));
    expectUntouched(before);
  });

  it('is undone as one step', () => {
    const { before } = openWith({ format: 'jpg', quality: 0.6 });
    fireEvent.click(radio('PNG'));
    act(() => {
      expect(undo.undo()).toBe(true);
    });
    expect(card().edit.format).toBe('jpg');
    expect(steps()).toBe(before.steps);
  });
});

describe('dragging the slider', () => {
  for (const pointerType of ['mouse', 'touch', 'pen']) {
    it(`with a ${pointerType}, shows the value as it moves and writes it once, on release`, () => {
      const { before } = openWith({ quality: 0.9 });
      fireEvent.pointerDown(slider(), { pointerId: 7, isPrimary: true, pointerType });
      for (const value of ['70', '55', '40']) {
        fireEvent.input(slider(), { target: { value } });
        expectShows(Number(value));
        expectUntouched(before);
      }
      // The slider's own change event at the end of a drag does not write it early.
      fireEvent.change(slider(), { target: { value: '40' } });
      expectUntouched(before);
      fireEvent.pointerUp(slider(), { pointerId: 7, pointerType });
      expect(card().edit.quality).toBe(0.4);
      expectOneStep(before);
      expectShows(40);
      // The capture ending after the release changes nothing more.
      fireEvent(slider(), new Event('lostpointercapture', { bubbles: true }));
      expect(steps()).toBe(before.steps + 1);
      // One undo puts the whole drag back.
      act(() => {
        undo.undo();
      });
      expect(card().edit.quality).toBe(0.9);
      expectShows(90);
    });
  }

  it('puts the value back and writes nothing when the pointer is cancelled', () => {
    const { before } = openWith({ quality: 0.9 });
    fireEvent.pointerDown(slider(), { pointerId: 1, isPrimary: true });
    fireEvent.input(slider(), { target: { value: '30' } });
    fireEvent.pointerCancel(slider(), { pointerId: 1 });
    expectShows(90);
    expectUntouched(before);
    // A release after the cancel writes nothing either.
    fireEvent.pointerUp(slider(), { pointerId: 1 });
    expectUntouched(before);
  });

  it('puts the value back and writes nothing when the pointer capture is lost mid-drag', () => {
    const { before } = openWith({ quality: 0.9 });
    fireEvent.pointerDown(slider(), { pointerId: 1, isPrimary: true });
    fireEvent.input(slider(), { target: { value: '30' } });
    const lost = new Event('lostpointercapture', { bubbles: true });
    Object.assign(lost, { pointerId: 1 });
    fireEvent(slider(), lost);
    expectShows(90);
    expectUntouched(before);
  });

  it('writes nothing for a drag that ends where it started', () => {
    const { before } = openWith({ quality: 0.9 });
    fireEvent.pointerDown(slider(), { pointerId: 1, isPrimary: true });
    fireEvent.input(slider(), { target: { value: '50' } });
    fireEvent.input(slider(), { target: { value: '90' } });
    fireEvent.pointerUp(slider(), { pointerId: 1 });
    expectUntouched(before);
  });

  it('ignores a second pointer and a release from another pointer', () => {
    const { before } = openWith({ quality: 0.9 });
    fireEvent.pointerDown(slider(), { pointerId: 1, isPrimary: true });
    fireEvent.pointerDown(slider(), { pointerId: 2, isPrimary: false });
    fireEvent.pointerDown(slider(), { pointerId: 3, isPrimary: true });
    fireEvent.input(slider(), { target: { value: '50' } });
    fireEvent.pointerUp(slider(), { pointerId: 2 });
    fireEvent.pointerUp(slider(), { pointerId: 3 });
    expectUntouched(before);
    fireEvent.pointerUp(slider(), { pointerId: 1 });
    expect(card().edit.quality).toBe(0.5);
    expectOneStep(before);
  });
});

describe('the slider and the keyboard', () => {
  const press = (key: string, repeats = 1) => {
    for (let index = 0; index < repeats; index += 1) fireEvent.keyDown(slider(), { key });
    fireEvent.keyUp(slider(), { key });
  };

  it('writes one step per key release, however long the key is held', () => {
    const { before } = openWith({ quality: 0.9 });
    // Held down: the key repeats three times, then is released once.
    fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    expectShows(93);
    expectUntouched(before);
    fireEvent.keyUp(slider(), { key: 'ArrowRight' });
    expect(card().edit.quality).toBe(0.93);
    expectOneStep(before);

    press('PageDown');
    expect(card().edit.quality).toBe(0.83);
    press('ArrowDown', 2);
    expect(card().edit.quality).toBe(0.81);
    press('ArrowUp');
    expect(card().edit.quality).toBe(0.82);
    press('ArrowLeft');
    expect(card().edit.quality).toBe(0.81);
    press('PageUp');
    expect(card().edit.quality).toBe(0.91);
    press('Home');
    expect(card().edit.quality).toBe(0.1);
    press('End');
    expect(card().edit.quality).toBe(1);
    expect(steps()).toBe(before.steps + 8);
  });

  it('writes nothing for a key that changes nothing, a modified key or another key', () => {
    const { before } = openWith({ quality: 1 });
    press('End');
    press('ArrowUp');
    fireEvent.keyDown(slider(), { key: 'ArrowLeft', ctrlKey: true });
    fireEvent.keyDown(slider(), { key: 'ArrowLeft', metaKey: true });
    fireEvent.keyDown(slider(), { key: 'ArrowLeft', altKey: true });
    press('Tab');
    fireEvent.keyUp(slider(), { key: 'ArrowLeft' });
    expectShows(100);
    expectUntouched(before);
  });

  it('a key press stops the browser moving the slider itself', () => {
    openWith({ quality: 0.5 });
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      slider().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it('writes a pending value when the slider loses focus', () => {
    const { before } = openWith({ quality: 0.9 });
    fireEvent.keyDown(slider(), { key: 'ArrowLeft' });
    fireEvent.blur(slider());
    expect(card().edit.quality).toBe(0.89);
    expectOneStep(before);
  });

  it('writes a pending value when it goes away', () => {
    const { before, unmount } = openWith({ quality: 0.9 });
    fireEvent.keyDown(slider(), { key: 'ArrowLeft' });
    unmount();
    expect(card().edit.quality).toBe(0.89);
    expectOneStep(before);
  });

  it('on Ctrl/Cmd-Z in the dialog, writes a pending value and then undoes it', () => {
    const { before } = openWith({ quality: 0.9 });
    press('ArrowLeft');
    fireEvent.keyDown(slider(), { key: 'ArrowLeft' });
    expectShows(88);
    act(() => {
      expect(undo.undo()).toBe(true);
    });
    // The held change was written as its own step and undone; the earlier press stays.
    expect(card().edit.quality).toBe(0.89);
    expect(steps()).toBe(before.steps + 1);
    expectShows(89);
    // Its key release afterwards writes nothing more.
    fireEvent.keyUp(slider(), { key: 'ArrowLeft' });
    expect(steps()).toBe(before.steps + 1);
  });

  it('stops writing pending values on Ctrl/Cmd-Z once it is gone', () => {
    const { unmount } = openWith({ quality: 0.9 });
    unmount();
    const before = snapshot();
    act(() => {
      undo.undo();
    });
    expectUntouched(before);
  });
});

describe('a change made another way (assistive technology)', () => {
  it('is written once, on the slider’s own change event', () => {
    const { before } = openWith({ quality: 0.9 });
    fireEvent.input(slider(), { target: { value: '70' } });
    expectUntouched(before);
    fireEvent.change(slider(), { target: { value: '70' } });
    expect(card().edit.quality).toBe(0.7);
    expectOneStep(before);
  });
});

describe('a card whose edit is not an image edit', () => {
  it('is never written', () => {
    openWith({ quality: 0.9 });
    // The card turns into a carousel while the controls are open (only a test can do this).
    act(() => {
      store().updateCard(card().id, (draft) => {
        draft.edit = { slides: [], coverIndex: 0 };
      });
    });
    // The controls are gone with the image edit, so they are rendered for the old edit directly.
    render(
      <FileTypeControls
        cardId={card().id}
        edit={{ format: 'jpg', quality: 0.9 }}
        record={undo.record}
      />,
    );
    const sliders = screen.getAllByRole('slider', { name: 'Quality' });
    const last = sliders.at(-1) as HTMLElement;
    fireEvent.keyDown(last, { key: 'ArrowLeft' });
    fireEvent.keyUp(last, { key: 'ArrowLeft' });
    fireEvent.click(screen.getAllByRole('radio', { name: 'PNG' }).at(-1) as HTMLElement);
    expect(card().edit).toEqual({ slides: [], coverIndex: 0 });
    expect(store().session?.cards).toHaveLength(1);
  });
});
