/**
 * The export override in the card details. The store is real; the card is read from it on every
 * render, as the board does, so ticking, unticking and undo show up as they would in the app.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../store/sessionStore';
import { hash, makeAsset, makeCard } from '../test/fixtures';
import type { CardRender } from '../lib/board/controller';
import type { Card, ValidationResult } from '../types';
import { CardDetails, NOT_RENDERED_NOTE, OVERRIDE_LABEL, OVERRIDE_NOT_NEEDED } from './CardDetails';

const PHOTO = makeAsset({ id: hash('a'), fileName: 'site.jpg' });
const FAIL: ValidationResult = {
  level: 'fail',
  issues: [{ rule: 1, level: 'fail', message: 'The image is 1070 x 1350 pixels.' }],
};
const WARN: ValidationResult = {
  level: 'warn',
  issues: [{ rule: 8, level: 'warn', message: 'Alt text is missing.' }],
};
const PASS: ValidationResult = { level: 'pass', issues: [] };

const store = () => useSessionStore.getState();
const card = () => store().session?.cards[0];
const checkbox = () => screen.getByRole('checkbox', { name: OVERRIDE_LABEL });
const queryCheckbox = () => screen.queryByRole('checkbox', { name: OVERRIDE_LABEL });

/** The details for the session's one card, as it is in the store now. */
function Live() {
  const current = useSessionStore((state) => state.session?.cards[0]);
  if (!current) return null;
  return (
    <CardDetails
      card={current}
      name="Instagram Feed vertical"
      fileName="site.jpg"
      render={undefined}
      version={{ version: 1, copyIndex: 1, copyCount: 1, isCopy: false, parentVersion: null }}
      headingId="details"
    />
  );
}

/** Opens a session with one card that has the given result. */
function openWith(validation: ValidationResult, overrideFail = false) {
  act(() => {
    store().clearSession(() => true);
    store().createSession('Override test');
    store().addAssets([{ asset: PHOTO, blob: new Blob(['photo']) }]);
    const { id, version, parentId, ...draft } = makeCard({
      assetIds: [PHOTO.id],
      validation,
      overrideFail,
    });
    void [id, version, parentId]; // the store gives these
    store().addCard(draft);
  });
  render(<Live />);
}

beforeEach(() => {
  act(() => {
    store().clearSession(() => true);
  });
});

describe('the export override', () => {
  it('is offered, unticked, when the card fails its checks', () => {
    openWith(FAIL);
    expect(checkbox()).not.toBeChecked();
    expect(screen.queryByText(OVERRIDE_NOT_NEEDED)).toBeNull();
  });

  it.each([
    ['passes', PASS],
    ['only has warnings', WARN],
  ])('is not offered when the card %s and is not overridden', (_, validation) => {
    openWith(validation);
    expect(queryCheckbox()).toBeNull();
    expect(screen.queryByText(OVERRIDE_NOT_NEEDED)).toBeNull();
  });

  it('can be ticked, which sets the card to export despite failing', () => {
    openWith(FAIL);
    fireEvent.click(checkbox());
    expect(card()?.overrideFail).toBe(true);
    expect(checkbox()).toBeChecked();
    expect(store().dirty).toBe(true);
  });

  it('can be unticked again', () => {
    openWith(FAIL, true);
    expect(checkbox()).toBeChecked();
    fireEvent.click(checkbox());
    expect(card()?.overrideFail).toBe(false);
    expect(checkbox()).not.toBeChecked();
  });

  it('stays visible while ticked after the card stops failing, with a note, so it can be unticked', () => {
    openWith(WARN, true);
    expect(checkbox()).toBeChecked();
    expect(screen.getByText(OVERRIDE_NOT_NEEDED)).toBeInTheDocument();
    fireEvent.click(checkbox());
    expect(card()?.overrideFail).toBe(false);
    // Unticked on a card that no longer fails: nothing left to offer.
    expect(queryCheckbox()).toBeNull();
  });

  it('is one undo step each time it is ticked or unticked', () => {
    openWith(FAIL);
    fireEvent.click(checkbox());
    fireEvent.click(checkbox());
    expect(card()?.overrideFail).toBe(false);
    act(() => {
      expect(store().undo()).toBe(true);
    });
    expect(card()?.overrideFail).toBe(true);
    expect(checkbox()).toBeChecked();
    act(() => {
      expect(store().undo()).toBe(true);
    });
    expect(card()?.overrideFail).toBe(false);
    expect(checkbox()).not.toBeChecked();
    // Nothing else was changed along the way.
    expect(card()?.validation).toEqual(FAIL);
  });
});

describe('the file type and quality', () => {
  function Details({ editor }: { editor?: boolean }) {
    const current = useSessionStore((state) => state.session?.cards[0]);
    if (!current) return null;
    return (
      <CardDetails
        card={current}
        name="Instagram Feed vertical"
        fileName="site.jpg"
        render={undefined}
        version={{ version: 1, copyIndex: 1, copyCount: 1, isCopy: false, parentVersion: null }}
        headingId="details"
        editor={editor ? <div>The editor</div> : undefined}
      />
    );
  }

  function open(editor: boolean, edit?: Card['edit']) {
    act(() => {
      store().createSession('File type test');
      const { id, version, parentId, ...draft } = makeCard({
        assetIds: [PHOTO.id],
        ...(edit ? { edit } : {}),
      });
      void [id, version, parentId]; // the store gives these
      store().addCard(draft);
    });
    render(<Details editor={editor} />);
  }

  it('are shown for a card the editor can open', () => {
    open(true);
    expect(screen.getByRole('group', { name: 'File type' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Quality' })).toBeInTheDocument();
  });

  it('change the card as one undo step, without a dialog undo too', () => {
    open(true);
    const steps = store().undoStack.length;
    fireEvent.click(screen.getByRole('radio', { name: 'PNG' }));
    expect(card()?.edit).toMatchObject({ format: 'png' });
    expect(store().undoStack).toHaveLength(steps + 1);
  });

  it('are not shown for a card without the editor, which cannot be made into a file', () => {
    open(false);
    expect(screen.queryByRole('group', { name: 'File type' })).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Background colour' })).toBeNull();
  });

  it('are not shown for a card that is not a single image', () => {
    open(true, { slides: [], coverIndex: 0 });
    expect(screen.queryByRole('group', { name: 'File type' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Background colour' })).toBeNull();
  });

  it('come after the background colour, which every card the editor can open has', () => {
    open(true);
    const colour = screen.getByRole('group', { name: 'Background colour' });
    const fileType = screen.getByRole('group', { name: 'File type' });
    expect(
      colour.compareDocumentPosition(fileType) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(colour).toHaveTextContent("Fills any space where the crop goes past the photo's edges.");
  });
});

describe('the rendered file while the card is rendered again', () => {
  const VERSION = { version: 1, copyIndex: 1, copyCount: 1, isCopy: false, parentVersion: null };
  const SIZE = { width: 1080, height: 1350 };
  const DONE: CardRender = {
    kind: 'done',
    url: 'blob:first',
    width: 1080,
    height: 1350,
    bytes: 400_000,
    format: 'jpg',
    upscaled: false,
  };
  const ENLARGED: CardRender = { ...DONE, upscaled: true };
  const NEXT: CardRender = { ...DONE, url: 'blob:second', bytes: 1_200_000 };
  const WAITING: CardRender = { kind: 'waiting' };
  const WORKING: CardRender = { kind: 'working', stage: 'drawing' };
  const ENLARGED_NOTE = /^Note: enlarged to fit\./;

  function details(render: CardRender | undefined, cardId = 'one') {
    return (
      <CardDetails
        card={makeCard({ id: cardId, assetIds: [PHOTO.id], validation: WARN })}
        name="Instagram Feed vertical"
        fileName="site.jpg"
        render={render}
        size={SIZE}
        version={VERSION}
        headingId="details"
        editor={<div>The editor</div>}
      />
    );
  }

  const area = () => screen.getByRole('region', { name: 'Rendered file' });
  const box = () => within(area()).getByRole('figure').firstElementChild as HTMLElement;
  const caption = () => area().querySelector('figcaption') as HTMLElement;
  const fileRow = () => screen.getByText('File').nextElementSibling as HTMLElement;

  it('keeps the same picture, marked as updating, with "Updating…" under it and in the File row', () => {
    const view = render(details(DONE));
    const picture = within(area()).getByRole('img');
    expect(picture).toHaveAttribute('src', 'blob:first');
    expect(picture).not.toHaveAttribute('data-updating');
    expect(caption()).toHaveTextContent('1080 × 1350 JPG · 400 KB');
    expect(fileRow()).toHaveTextContent('1080 × 1350 JPG · 400 KB');

    for (const pending of [WAITING, WORKING]) {
      view.rerender(details(pending));
      // The very same element: a new one could not load the old file's revoked address.
      expect(within(area()).getByRole('img')).toBe(picture);
      expect(picture).toHaveAttribute('src', 'blob:first');
      expect(picture).toHaveAttribute('data-updating', 'true');
      expect(picture).toHaveClass('opacity-50');
      expect(caption()).toHaveTextContent(/^Updating…$/);
      expect(fileRow()).toHaveTextContent(/^Updating…$/);
      expect(
        within(area()).getByRole('progressbar', { name: 'Rendering Instagram Feed vertical' }),
      ).toBeInTheDocument();
    }

    view.rerender(details(NEXT));
    expect(within(area()).getByRole('img')).toBe(picture);
    expect(picture).toHaveAttribute('src', 'blob:second');
    expect(picture).not.toHaveAttribute('data-updating');
    expect(caption()).toHaveTextContent('1080 × 1350 JPG · 1.2 MB');
    expect(within(area()).queryByRole('progressbar')).toBeNull();
  });

  it('keeps the box and caption line the same size in every state', () => {
    const view = render(details(undefined));
    const states: (CardRender | undefined)[] = [
      WAITING,
      DONE,
      WORKING,
      { kind: 'cancelled' },
      { kind: 'failed', message: 'Could not be saved as JPG.' },
    ];
    for (const state of [undefined, ...states]) {
      view.rerender(details(state));
      expect(box()).toHaveClass('h-48');
      expect(box().style.aspectRatio).toBe('1080 / 1350');
      expect(caption()).toHaveClass('h-4', 'truncate');
    }
  });

  it('shows a placeholder with the progress before the first file, and the progress in words', () => {
    render(details(WORKING));
    expect(within(area()).queryByRole('img')).toBeNull();
    expect(within(area()).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
    expect(caption()).toHaveTextContent(/^Cropping and resizing$/);
    expect(fileRow()).toHaveTextContent('Not made yet');
  });

  it('says why in the box when the render failed or was cancelled, with the caption line kept', () => {
    const view = render(details(DONE));
    view.rerender(details({ kind: 'cancelled' }));
    expect(within(area()).queryByRole('img')).toBeNull();
    expect(box()).toHaveTextContent('Cancelled before the file was made.');
    expect(caption()).toBeEmptyDOMElement();
    expect(fileRow()).toHaveTextContent('Not made yet');

    view.rerender(details({ kind: 'failed', message: 'Could not be saved as JPG.' }));
    expect(box()).toHaveTextContent('Could not be saved as JPG.');
    expect(caption()).toBeEmptyDOMElement();
    // Said once, in the file's place, not also at the top of the column.
    expect(screen.getAllByText('Could not be saved as JPG.')).toHaveLength(1);

    // A later render starts from the placeholder: the old file's address is gone.
    view.rerender(details(WAITING));
    expect(within(area()).queryByRole('img')).toBeNull();
    expect(caption()).toHaveTextContent('Waiting to render');
  });

  it('keeps the failure at the top of the column for a card without a rendered file area', () => {
    render(
      <CardDetails
        card={makeCard({ assetIds: [PHOTO.id] })}
        name="Instagram Feed vertical"
        fileName="site.jpg"
        render={{ kind: 'failed', message: 'Could not be saved as JPG.' }}
        version={VERSION}
        headingId="details"
      />,
    );
    expect(screen.queryByRole('region', { name: 'Rendered file' })).toBeNull();
    expect(screen.getByText('Could not be saved as JPG.')).toHaveClass('text-danger-text');
  });

  it('is busy only while a file is being made', () => {
    const view = render(details(undefined));
    expect(area()).toHaveAttribute('aria-busy', 'false');
    view.rerender(details(WAITING));
    expect(area()).toHaveAttribute('aria-busy', 'true');
    view.rerender(details(DONE));
    expect(area()).toHaveAttribute('aria-busy', 'false');
    view.rerender(details(WORKING));
    expect(area()).toHaveAttribute('aria-busy', 'true');
    // No live region, so each render made while the crop moves is not announced.
    expect(area().closest('[aria-live]')).toBeNull();
    expect(within(area()).queryByRole('status')).toBeNull();
  });

  it('keeps the enlarged-to-fit note during a re-render, until the new result arrives', () => {
    const view = render(details(ENLARGED));
    expect(screen.getByText(ENLARGED_NOTE)).toBeInTheDocument();
    view.rerender(details(WORKING));
    expect(screen.getByText(ENLARGED_NOTE)).toBeInTheDocument();
    view.rerender(details(NEXT));
    expect(screen.queryByText(ENLARGED_NOTE)).toBeNull();
  });

  it('shows the "not made yet" note in the checks only when there is no finished file at all', () => {
    const view = render(details(WAITING));
    expect(screen.getByText(NOT_RENDERED_NOTE)).toBeInTheDocument();
    view.rerender(details(DONE));
    expect(screen.queryByText(NOT_RENDERED_NOTE)).toBeNull();
    view.rerender(details(WORKING));
    expect(screen.queryByText(NOT_RENDERED_NOTE)).toBeNull();
    view.rerender(details({ kind: 'cancelled' }));
    expect(screen.getByText(NOT_RENDERED_NOTE)).toBeInTheDocument();
  });

  it('keeps the result badge, checks and help text as they are during a re-render', () => {
    const view = render(details(DONE));
    const checks = () => screen.getByRole('region', { name: 'Checks' }).textContent;
    const before = checks();
    expect(screen.getAllByText('Warning').length).toBeGreaterThan(0);
    view.rerender(details(WORKING));
    expect(checks()).toBe(before);
    // The badge says the new file is not checked yet, as before.
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
  });

  it("does not show another card's file when the dialog moves to a different card", () => {
    const view = render(details(DONE, 'one'));
    view.rerender(details(WAITING, 'two'));
    expect(within(area()).queryByRole('img')).toBeNull();
    expect(fileRow()).toHaveTextContent('Not made yet');
  });
});
