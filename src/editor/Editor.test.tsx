/**
 * Editor tests. The store and the geometry are real; the photo loader is a fake whose answer
 * the test gives, and the frame's place on screen is set by the test, because jsdom lays
 * nothing out. Real pointers, layout and touch are checked in Chromium.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPanel } from '../app/SessionPanel';
import { draftCard } from '../lib/board/cards';
import { automaticCrop, cropLimits } from '../lib/editor/geometry';
import { SourcePhotoError } from '../lib/editor/sourcePhoto';
import type { DisplayPhoto, SourcePhotoInput } from '../lib/editor/sourcePhoto';
import { getPlacement } from '../lib/platforms';
import { useSessionStore } from '../store/sessionStore';
import { hash, makeAsset } from '../test/fixtures';
import type { Card, ImageEdit, PlacementSpec, Rect, Size } from '../types';
import { HANDLE_TARGET } from './CropStage';
import { Editor, HELP_TEXT, LOADING_TEXT } from './Editor';
import { cropReadout, stageLabel } from './text';

// Sizes come from the platform data, never from this file.
const FEED = getPlacement('instagram', 'feed-vertical') as PlacementSpec;
const TARGET = FEED.sizes[0] as Size;
/** Landscape and not square, so a swap of width and height would show. */
const PHOTO = makeAsset({
  id: hash('a'),
  fileName: 'site.jpg',
  width: 4000,
  height: 3000,
  focal: { x: 0.5, y: 0.5 },
});
const SOURCE: Size = { width: PHOTO.width, height: PHOTO.height };
const AUTO = automaticCrop(SOURCE, TARGET, PHOTO.focal);
const LIMITS = cropLimits(SOURCE, TARGET);
const BLOB = new Blob(['photo']);

/** Where the test puts the photo's frame on screen: a tenth of the photo's size. */
const FRAME = { left: 100, top: 50, width: 400, height: 300 };
/** The screen position of a point on the photo given in fractions. */
const at = (x: number, y: number) => ({
  clientX: FRAME.left + x * FRAME.width,
  clientY: FRAME.top + y * FRAME.height,
});

const store = () => useSessionStore.getState();
const card = () => store().session?.cards[0] as Card & { edit: ImageEdit };
const crop = () => card().edit.crop;

type Load = {
  input: SourcePhotoInput;
  resolve: (photo: DisplayPhoto) => void;
  reject: (error: unknown) => void;
};
let loads: Load[];
const loadPhoto = (input: SourcePhotoInput) =>
  new Promise<DisplayPhoto>((resolve, reject) => {
    loads.push({ input, resolve, reject });
  });

function photoOf() {
  return {
    bitmap: { tag: 'bitmap' } as unknown as ImageBitmap,
    width: 2048,
    height: 1536,
    source: SOURCE,
    close: vi.fn<() => void>(),
  };
}

let drawImage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  loads = [];
  drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
  act(() => {
    store().clearSession(() => true);
    store().createSession('Editor test');
    store().addAssets([{ asset: PHOTO, blob: BLOB }]);
    store().addCard(draftCard(PHOTO, FEED));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Shows the editor for the first card, following the store as the board does. */
function Host({ missing = false }) {
  const blob = missing ? undefined : BLOB;
  const first = useSessionStore((state) => state.session?.cards[0]);
  if (!first) return null;
  return (
    <Editor
      card={first as Card & { edit: ImageEdit }}
      asset={PHOTO}
      target={TARGET}
      blob={blob}
      loadPhoto={loadPhoto}
    />
  );
}

/** Renders the editor and gives it its photo, with the frame placed on screen. */
async function openEditor(ui = <Host />) {
  const view = render(ui);
  const photo = photoOf();
  loads[0]?.resolve(photo);
  await act(() => Promise.resolve());
  const frame = screen.getByTestId('crop-frame');
  frame.getBoundingClientRect = () => ({ ...FRAME, x: FRAME.left, y: FRAME.top }) as DOMRect;
  return { ...view, photo, frame };
}

const stage = () => screen.getByRole('application');
const rect = () => screen.getByTestId('crop-rect');
const handle = (corner: string) => screen.getByTestId(`crop-handle-${corner}`);
const pointer = (extra: object = {}) => ({ pointerId: 1, isPrimary: true, button: 0, ...extra });

function expectCrop(actual: Rect, expected: Rect) {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
  expect(actual.width).toBeCloseTo(expected.width, 10);
  expect(actual.height).toBeCloseTo(expected.height, 10);
}

/** What must not change when nothing is written. */
function snapshot() {
  return { session: store().session, undo: store().undoStack.length, revision: store().revision };
}
function expectUntouched(before: ReturnType<typeof snapshot>) {
  expect(store().session).toBe(before.session);
  expect(store().undoStack).toHaveLength(before.undo);
  expect(store().revision).toBe(before.revision);
}

describe('opening the photo', () => {
  it('says the photo is opening, then shows the crop area', async () => {
    render(<Host />);
    expect(screen.getByRole('status')).toHaveTextContent(LOADING_TEXT);
    expect(screen.queryByRole('application')).toBeNull();
    expect(loads[0]?.input).toEqual({ blob: BLOB, fileName: 'site.jpg', expected: SOURCE });
    loads[0]?.resolve(photoOf());
    await act(() => Promise.resolve());
    expect(screen.queryByRole('status')).toBeNull();
    expect(stage()).toBeInTheDocument();
    expect(screen.getByText(HELP_TEXT)).toBeInTheDocument();
  });

  it('draws the photo at its display size', async () => {
    const { photo } = await openEditor();
    const canvas = stage().querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(2048);
    expect(canvas.height).toBe(1536);
    expect(drawImage).toHaveBeenCalledWith(photo.bitmap, 0, 0);
  });

  it('shows the reason in place of the crop area when the photo cannot be opened', async () => {
    render(<Host />);
    const message =
      '"site.jpg" opens as 3000 x 4000 pixels in this browser, but it was 4000 x 3000 when it ' +
      'was imported, so its crop cannot be edited here.';
    loads[0]?.reject(new SourcePhotoError(message));
    await act(() => Promise.resolve());
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByRole('application')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset crop' })).toBeNull();
  });

  it('says so when the original file is missing', async () => {
    render(<Host missing />);
    await act(() => Promise.resolve());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The original file for "site.jpg" is missing.',
    );
    expect(loads).toHaveLength(0);
  });

  it('closes the photo when the editor goes away', async () => {
    const { photo, unmount } = await openEditor();
    unmount();
    expect(photo.close).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when it opens, even for a crop below the smallest size', async () => {
    const tiny = { x: 0.4, y: 0.4, width: 0.003, height: 0.005 };
    act(() => {
      store().updateCard(card().id, (draft) => {
        (draft.edit as ImageEdit).crop = tiny;
      });
    });
    const before = snapshot();
    const { unmount } = await openEditor();
    // Shown at the smallest size, about its centre.
    expect(parseFloat(rect().style.width)).toBeCloseTo(LIMITS.min.width * 100, 8);
    expect(parseFloat(rect().style.height)).toBeCloseTo(LIMITS.min.height * 100, 8);
    // A press and release without moving is not a change either.
    fireEvent.pointerDown(rect(), pointer(at(0.4, 0.4)));
    fireEvent.pointerUp(rect(), pointer(at(0.4, 0.4)));
    unmount();
    expectUntouched(before);
    expect(crop()).toEqual(tiny);
  });
});

describe('the crop area', () => {
  it('can be reached with Tab, shows the focus ring, and says what the arrow keys do', async () => {
    await openEditor();
    expect(stage()).toHaveAttribute('tabindex', '0');
    expect(stage()).toHaveAccessibleName(stageLabel('site.jpg'));
    expect(stageLabel('site.jpg')).toBe(
      'Crop of site.jpg. Arrow keys move the crop. Plus and minus resize it. Hold Shift for bigger steps.',
    );
    expect(stage().className).toContain('focus-visible:outline-accent');
    expect(stage()).toHaveAccessibleDescription(cropReadout(AUTO));
  });

  it('places the crop in percentages of the photo, so resizing the area cannot change it', async () => {
    await openEditor();
    // The automatic 4:5 crop of a 4:3 photo: 60% of the width, all of the height.
    expect(rect().style.left).toBe('20%');
    expect(rect().style.top).toBe('0%');
    expect(rect().style.width).toBe('60%');
    expect(rect().style.height).toBe('100%');
    expect(screen.getByTestId('crop-frame').style.aspectRatio).toBe('4000 / 3000');
  });

  it('gives every corner a touch target of at least 44 pixels', async () => {
    await openEditor();
    expect(HANDLE_TARGET).toBeGreaterThanOrEqual(44);
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      expect(handle(corner).style.width).toBe(`${HANDLE_TARGET}px`);
      expect(handle(corner).style.height).toBe(`${HANDLE_TARGET}px`);
      expect(handle(corner).className).toContain('touch-none');
    }
    expect(handle('se').style.left).toBe('calc(80% - 22px)');
    expect(handle('se').style.top).toBe('calc(100% - 22px)');
    expect(handle('nw').style.left).toBe('calc(20% - 22px)');
    expect(handle('nw').style.top).toBe('calc(0% - 22px)');
    expect(rect().className).toContain('touch-none');
  });
});

describe('dragging the crop', () => {
  it('writes nothing during the drag, and one change on release', async () => {
    await openEditor();
    const before = snapshot();
    fireEvent.pointerDown(rect(), pointer(at(0.5, 0.5)));
    fireEvent.pointerMove(rect(), pointer(at(0.55, 0.5)));
    fireEvent.pointerMove(rect(), pointer(at(0.6, 0.5)));
    // The crop follows on screen, but the store has not been touched.
    expect(parseFloat(rect().style.left)).toBeCloseTo(30, 8);
    expectUntouched(before);

    fireEvent.pointerUp(rect(), pointer(at(0.6, 0.5)));
    expectCrop(crop(), { ...AUTO, x: 0.3 });
    expect(store().undoStack).toHaveLength(before.undo + 1);
    expect(store().revision).toBe(before.revision + 1);
    expect(store().dirty).toBe(true);
  });

  it('captures the pointer, so the drag carries on outside the crop', async () => {
    await openEditor();
    const capture = vi.fn();
    (rect() as HTMLElement & { setPointerCapture: unknown }).setPointerCapture = capture;
    fireEvent.pointerDown(rect(), pointer(at(0.5, 0.5)));
    expect(capture).toHaveBeenCalledWith(1);
  });

  it('stops at the edge of the photo', async () => {
    await openEditor();
    fireEvent.pointerDown(rect(), pointer(at(0.5, 0.5)));
    fireEvent.pointerMove(rect(), pointer(at(3, 2)));
    fireEvent.pointerUp(rect(), pointer(at(3, 2)));
    expectCrop(crop(), { ...AUTO, x: 0.4 });
  });

  it('changes nothing when the drag is cancelled or the pointer is lost', async () => {
    await openEditor();
    const before = snapshot();
    fireEvent.pointerDown(rect(), pointer(at(0.5, 0.5)));
    fireEvent.pointerMove(rect(), pointer(at(0.6, 0.5)));
    fireEvent.pointerCancel(rect(), pointer());
    expect(rect().style.left).toBe('20%');
    fireEvent.pointerDown(rect(), pointer(at(0.5, 0.5)));
    fireEvent.pointerMove(rect(), pointer(at(0.6, 0.5)));
    fireEvent.lostPointerCapture(rect(), pointer());
    expect(rect().style.left).toBe('20%');
    // A release after that has no drag to end.
    fireEvent.pointerUp(rect(), pointer(at(0.6, 0.5)));
    expectUntouched(before);
  });

  it('ignores a second finger, another mouse button, and another pointer', async () => {
    await openEditor();
    const before = snapshot();
    fireEvent.pointerDown(rect(), pointer({ ...at(0.5, 0.5), isPrimary: false }));
    fireEvent.pointerMove(rect(), pointer(at(0.6, 0.5)));
    fireEvent.pointerUp(rect(), pointer(at(0.6, 0.5)));
    fireEvent.pointerDown(rect(), pointer({ ...at(0.5, 0.5), button: 2 }));
    fireEvent.pointerUp(rect(), pointer(at(0.6, 0.5)));
    expectUntouched(before);

    // A drag under way is not disturbed by another pointer, and cannot be started twice.
    fireEvent.pointerDown(rect(), pointer(at(0.5, 0.5)));
    fireEvent.pointerDown(rect(), pointer(at(0.2, 0.5)));
    fireEvent.pointerMove(rect(), pointer({ ...at(0.9, 0.5), pointerId: 2 }));
    fireEvent.pointerUp(rect(), pointer({ ...at(0.9, 0.5), pointerId: 2 }));
    expect(rect().style.left).toBe('20%');
    fireEvent.pointerMove(rect(), pointer(at(0.6, 0.5)));
    fireEvent.pointerUp(rect(), pointer(at(0.6, 0.5)));
    expectCrop(crop(), { ...AUTO, x: 0.3 });
    expect(store().undoStack).toHaveLength(before.undo + 1);
  });

  it('does nothing before the area has a size on screen', async () => {
    const { frame } = await openEditor();
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect;
    const before = snapshot();
    fireEvent.pointerDown(rect(), pointer(at(0.5, 0.5)));
    fireEvent.pointerMove(rect(), pointer(at(0.6, 0.5)));
    fireEvent.pointerUp(rect(), pointer(at(0.6, 0.5)));
    fireEvent.pointerDown(handle('se'), pointer(at(0.8, 1)));
    fireEvent.pointerUp(handle('se'), pointer(at(0.8, 1)));
    expectUntouched(before);
  });
});

describe('resizing from a corner', () => {
  it('keeps the opposite corner and the shape, with one change on release', async () => {
    await openEditor();
    const before = snapshot();
    const se = handle('se');
    // Grabbed 5 pixels off the corner itself; the crop must not jump by that much.
    const grab = { clientX: at(0.8, 1).clientX + 5, clientY: at(0.8, 1).clientY + 5 };
    fireEvent.pointerDown(se, pointer(grab));
    fireEvent.pointerMove(se, pointer(grab));
    expect(rect().style.width).toBe('60%');
    // To 70% across and half way down: the horizontal reach (0.5) is the larger.
    const to = { clientX: at(0.7, 0.5).clientX + 5, clientY: at(0.7, 0.5).clientY + 5 };
    fireEvent.pointerMove(se, pointer(to));
    expectUntouched(before);
    fireEvent.pointerUp(se, pointer(to));
    expectCrop(crop(), { x: 0.2, y: 0, width: 0.5, height: 0.5 * LIMITS.shape });
    expect(store().undoStack).toHaveLength(before.undo + 1);
    // Still the placement's shape, in photo pixels.
    const ratio = (crop().width * SOURCE.width) / (crop().height * SOURCE.height);
    expect(ratio).toBeCloseTo(TARGET.width / TARGET.height, 10);
  });

  it('works from the north-west corner, keeping the south-east one', async () => {
    await openEditor();
    const nw = handle('nw');
    fireEvent.pointerDown(nw, pointer(at(0.2, 0)));
    fireEvent.pointerMove(nw, pointer(at(0.5, 0.2)));
    fireEvent.pointerUp(nw, pointer(at(0.5, 0.2)));
    // The vertical reach (0.8 of the height) is the larger: 0.48 of the width.
    expectCrop(crop(), { x: 0.32, y: 0.2, width: 0.48, height: 0.8 });
  });

  it('stops at the smallest size, half the output size', async () => {
    await openEditor();
    const se = handle('se');
    fireEvent.pointerDown(se, pointer(at(0.8, 1)));
    fireEvent.pointerMove(se, pointer(at(0, 0)));
    fireEvent.pointerUp(se, pointer(at(0, 0)));
    expectCrop(crop(), { x: 0.2, y: 0, ...LIMITS.min });
    expect(Math.round(crop().width * SOURCE.width)).toBe(TARGET.width / 2);
    expect(Math.round(crop().height * SOURCE.height)).toBe(TARGET.height / 2);
  });

  it('writes nothing when a corner is pressed and released in place', async () => {
    await openEditor();
    const before = snapshot();
    fireEvent.pointerDown(handle('ne'), pointer(at(0.8, 0)));
    fireEvent.pointerMove(handle('ne'), pointer(at(0.8, 0)));
    fireEvent.pointerUp(handle('ne'), pointer(at(0.8, 0)));
    fireEvent.pointerDown(handle('sw'), pointer({ ...at(0.2, 1), button: 1 }));
    expectUntouched(before);
  });
});

describe('arrow keys', () => {
  it('move the crop one step for each press, and each press is one change', async () => {
    await openEditor();
    const before = snapshot();
    fireEvent.keyDown(stage(), { key: 'ArrowRight' });
    expectCrop(crop(), { ...AUTO, x: 0.21 });
    expect(store().undoStack).toHaveLength(before.undo + 1);
    fireEvent.keyDown(stage(), { key: 'ArrowLeft', shiftKey: true });
    expectCrop(crop(), { ...AUTO, x: 0.11 });
    expect(store().undoStack).toHaveLength(before.undo + 2);
    expect(screen.getByText(cropReadout(crop()))).toBeInTheDocument();
  });

  it('write nothing when the crop has nowhere to go, or for other keys', async () => {
    await openEditor();
    const before = snapshot();
    // The crop already fills the photo's height.
    fireEvent.keyDown(stage(), { key: 'ArrowUp' });
    fireEvent.keyDown(stage(), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(stage(), { key: 'Enter' });
    fireEvent.keyDown(stage(), { key: 'ArrowRight', ctrlKey: true });
    fireEvent.keyDown(stage(), { key: 'ArrowRight', metaKey: true });
    fireEvent.keyDown(stage(), { key: 'ArrowRight', altKey: true });
    expectUntouched(before);
  });

  it('leaves Escape alone, so it still closes the dialog', async () => {
    await openEditor();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    stage().dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
  });
});

describe('plus and minus', () => {
  it('resize the crop about its centre, one change for each press', async () => {
    await openEditor();
    const before = snapshot();
    fireEvent.keyDown(stage(), { key: '-' });
    // 1% of the photo's width narrower, the same centre, the same shape.
    expectCrop(crop(), {
      x: 0.205,
      y: (1 - 0.59 * LIMITS.shape) / 2,
      width: 0.59,
      height: 0.59 * LIMITS.shape,
    });
    expect(store().undoStack).toHaveLength(before.undo + 1);
    fireEvent.keyDown(stage(), { key: '_', shiftKey: true });
    expectCrop(crop(), {
      x: 0.255,
      y: (1 - 0.49 * LIMITS.shape) / 2,
      width: 0.49,
      height: 0.49 * LIMITS.shape,
    });
    expect(store().undoStack).toHaveLength(before.undo + 2);
    fireEvent.keyDown(stage(), { key: '=' });
    expect(crop().width).toBeCloseTo(0.5, 10);
    fireEvent.keyDown(stage(), { key: 'Add' });
    expect(crop().width).toBeCloseTo(0.51, 10);
    fireEvent.keyDown(stage(), { key: '+', shiftKey: true });
    // Back at the largest crop, which is the automatic one.
    expectCrop(crop(), AUTO);
    expect(store().undoStack).toHaveLength(before.undo + 5);
    const ratio = (crop().width * SOURCE.width) / (crop().height * SOURCE.height);
    expect(ratio).toBeCloseTo(TARGET.width / TARGET.height, 10);
  });

  it('write nothing at the largest or the smallest size', async () => {
    await openEditor();
    const before = snapshot();
    fireEvent.keyDown(stage(), { key: '+' });
    fireEvent.keyDown(stage(), { key: '=', shiftKey: true });
    expectUntouched(before);
    for (let press = 0; press < 6; press++) {
      fireEvent.keyDown(stage(), { key: 'Subtract', shiftKey: true });
    }
    expect(crop().width).toBeCloseTo(LIMITS.min.width, 10);
    const atSmallest = snapshot();
    fireEvent.keyDown(stage(), { key: '-' });
    expectUntouched(atSmallest);
  });

  it('undo one press at a time', async () => {
    await openEditor();
    fireEvent.keyDown(stage(), { key: '-' });
    fireEvent.keyDown(stage(), { key: '-' });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(crop().width).toBeCloseTo(0.59, 10);
  });
});

describe('Reset crop', () => {
  it('is a button that returns a moved crop to the automatic one, as one change', async () => {
    await openEditor();
    const reset = screen.getByRole('button', { name: 'Reset crop' });
    // Nothing to reset yet.
    expect(reset).toBeDisabled();
    fireEvent.keyDown(stage(), { key: 'ArrowRight', shiftKey: true });
    expect(reset).toBeEnabled();
    const before = snapshot();
    fireEvent.click(reset);
    expectCrop(crop(), AUTO);
    expect(store().undoStack).toHaveLength(before.undo + 1);
    expect(reset).toBeDisabled();
  });
});

describe('undo in the editor', () => {
  const undoKey = (target: Element | Window = window, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };

  it('undoes one editor change for each press, and never reaches the app-wide undo', async () => {
    // A change made before the editor opened: it must survive every press in the editor.
    act(() => {
      store().duplicateCard(card().id);
    });
    // Stands for any other undo listener: it hears only the Ctrl/Cmd-Z presses that get past.
    const outside = vi.fn();
    const hear = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') outside();
    };
    window.addEventListener('keydown', hear);
    const { unmount } = await openEditor(
      <>
        <SessionPanel />
        <Host />
      </>,
    );
    fireEvent.keyDown(stage(), { key: 'ArrowRight' });
    fireEvent.keyDown(stage(), { key: 'ArrowRight' });
    expectCrop(crop(), { ...AUTO, x: 0.22 });
    const steps = store().undoStack.length;

    // One press, exactly one step. With both listeners running it would be two.
    const first = undoKey(stage());
    expectCrop(crop(), { ...AUTO, x: 0.21 });
    expect(store().undoStack).toHaveLength(steps - 1);
    expect(first.defaultPrevented).toBe(true);

    undoKey(stage(), { ctrlKey: false, metaKey: true });
    expectCrop(crop(), AUTO);
    expect(store().undoStack).toHaveLength(steps - 2);

    // Nothing left that the editor did: further presses do nothing, wherever the focus is.
    const spare = undoKey(document.body);
    undoKey(stage(), { key: 'Z' });
    expect(store().undoStack).toHaveLength(steps - 2);
    expect(store().session?.cards).toHaveLength(2);
    expect(spare.defaultPrevented).toBe(true);
    expect(outside).not.toHaveBeenCalled();

    // Once the editor has gone, the app-wide undo works again.
    unmount();
    render(<SessionPanel />);
    undoKey(document.body);
    expect(store().session?.cards).toHaveLength(1);
    expect(outside).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', hear);
  });

  it('leaves other key presses, redo, and undo while typing alone', async () => {
    await openEditor(
      <>
        <input aria-label="A text field" />
        <Host />
      </>,
    );
    fireEvent.keyDown(stage(), { key: 'ArrowRight' });
    const steps = store().undoStack.length;
    expect(undoKey(stage(), { shiftKey: true }).defaultPrevented).toBe(false);
    expect(undoKey(stage(), { ctrlKey: false }).defaultPrevented).toBe(false);
    expect(undoKey(stage(), { key: 'y' }).defaultPrevented).toBe(false);
    expect(undoKey(screen.getByLabelText('A text field')).defaultPrevented).toBe(false);
    expect(store().undoStack).toHaveLength(steps);
  });

  it('counts a drag and a reset as one step each', async () => {
    await openEditor();
    fireEvent.pointerDown(rect(), pointer(at(0.5, 0.5)));
    fireEvent.pointerMove(rect(), pointer(at(0.6, 0.5)));
    fireEvent.pointerUp(rect(), pointer(at(0.6, 0.5)));
    fireEvent.click(screen.getByRole('button', { name: 'Reset crop' }));
    expectCrop(crop(), AUTO);
    undoKey();
    expectCrop(crop(), { ...AUTO, x: 0.3 });
    undoKey();
    expectCrop(crop(), AUTO);
    const steps = store().undoStack.length;
    undoKey();
    expect(store().undoStack).toHaveLength(steps);
  });
});
