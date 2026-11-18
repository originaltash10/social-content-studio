/**
 * The export override in the card details. The store is real; the card is read from it on every
 * render, as the board does, so ticking, unticking and undo show up as they would in the app.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../store/sessionStore';
import { hash, makeAsset, makeCard } from '../test/fixtures';
import type { ValidationResult } from '../types';
import { CardDetails, OVERRIDE_LABEL, OVERRIDE_NOT_NEEDED } from './CardDetails';

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
