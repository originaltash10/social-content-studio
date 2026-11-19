/** The card dialog's undo, against the real session store. */
import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { UNDO_LIMIT, useSessionStore } from '../store/sessionStore';
import { hash, makeAsset, makeCard } from '../test/fixtures';
import { createDialogUndo } from './dialogUndo';

const PHOTO = makeAsset({ id: hash('a'), fileName: 'site.jpg' });
const store = () => useSessionStore.getState();
const card = () => store().session?.cards[0];
const steps = () => store().undoStack.length;

let cardId: string;

/** One change to the card: the override flipped. */
const flip = () => {
  store().updateCard(cardId, (draft) => {
    draft.overrideFail = !draft.overrideFail;
  });
};

beforeEach(() => {
  act(() => {
    store().clearSession(() => true);
    store().createSession('Dialog undo test');
    store().addAssets([{ asset: PHOTO, blob: new Blob(['photo']) }]);
    const { id, version, parentId, ...draft } = makeCard({ assetIds: [PHOTO.id] });
    void [id, version, parentId]; // the store gives these
    cardId = store().addCard(draft);
  });
});

describe('createDialogUndo', () => {
  it('starts with nothing to undo, and leaves earlier changes alone', () => {
    const undo = createDialogUndo();
    expect(undo.count()).toBe(0);
    expect(undo.undo()).toBe(false);
    // The card was added before the dialog opened: still there, still undoable elsewhere.
    expect(steps()).toBe(1);
    expect(card()).toBeDefined();
  });

  it('counts a change it records, and undoes it', () => {
    const undo = createDialogUndo();
    undo.record(flip);
    undo.record(flip);
    expect(undo.count()).toBe(2);
    expect(steps()).toBe(3);
    expect(undo.undo()).toBe(true);
    expect(card()?.overrideFail).toBe(true);
    expect(undo.count()).toBe(1);
    expect(undo.undo()).toBe(true);
    expect(card()?.overrideFail).toBe(false);
    expect(undo.count()).toBe(0);
    expect(undo.undo()).toBe(false);
    expect(steps()).toBe(1);
  });

  it('counts nothing for a change that added no undo step', () => {
    const undo = createDialogUndo();
    undo.record(() => undefined);
    // A real change that the store does not record as an undo step.
    undo.record(() => {
      store().setValidation(cardId, { level: 'fail', issues: [] });
    });
    expect(undo.count()).toBe(0);
    expect(undo.undo()).toBe(false);
  });

  it('never undoes a newer step that is not its own', () => {
    const undo = createDialogUndo();
    undo.record(flip);
    flip(); // made outside the dialog
    expect(undo.count()).toBe(1);
    expect(undo.undo()).toBe(false);
    expect(steps()).toBe(3);
    expect(card()?.overrideFail).toBe(false);
  });

  it(`never counts more than the ${UNDO_LIMIT} steps the shared list keeps`, () => {
    const undo = createDialogUndo();
    for (let index = 0; index < UNDO_LIMIT + 10; index += 1) undo.record(flip);
    expect(steps()).toBe(UNDO_LIMIT);
    expect(undo.count()).toBe(UNDO_LIMIT);
    for (let index = 0; index < UNDO_LIMIT; index += 1) expect(undo.undo()).toBe(true);
    expect(undo.count()).toBe(0);
    expect(undo.undo()).toBe(false);
    expect(steps()).toBe(0);
    // Ten changes fell off the end of the list, so the card is left as of the tenth.
    expect(card()?.overrideFail).toBe(false);
  });

  it('stops at its own steps when the list also holds earlier ones', () => {
    for (let index = 0; index < 10; index += 1) flip();
    const undo = createDialogUndo();
    for (let index = 0; index < 45; index += 1) undo.record(flip);
    // 1 + 10 + 45 changes, of which the list keeps the newest 50.
    expect(steps()).toBe(UNDO_LIMIT);
    expect(undo.count()).toBe(45);
    for (let index = 0; index < 45; index += 1) expect(undo.undo()).toBe(true);
    expect(undo.undo()).toBe(false);
    expect(steps()).toBe(5);
  });
});
