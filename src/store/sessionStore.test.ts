import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNDO_LIMIT, assetBlobs, emptyBrand, getAssetBlob, useSessionStore } from './sessionStore';
import type { NewCard } from './sessionStore';
import { hash, makeAsset, makeBrand, makeCard, makeSession } from '../test/fixtures';
import type { Card, Session } from '../types';

const store = () => useSessionStore.getState();

/** The open session; fails the test if there is none. */
function open(): Session {
  const { session } = store();
  if (!session) throw new Error('expected an open session');
  return session;
}

function cardById(id: string): Card {
  const card = open().cards.find((c) => c.id === id);
  if (!card) throw new Error(`expected card ${id}`);
  return card;
}

function newCard(overrides: Partial<NewCard> = {}): NewCard {
  const card = makeCard();
  return {
    assetIds: card.assetIds,
    platform: card.platform,
    placement: card.placement,
    status: card.status,
    edit: card.edit,
    copy: card.copy,
    validation: card.validation,
    overrideFail: card.overrideFail,
    comments: card.comments,
    plannedDate: card.plannedDate,
    ...overrides,
  };
}

const blob = (text: string) => new Blob([text]);

/** Pretends a save succeeded for the current state. */
const save = () => store().markSaved(store().revision);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
  store().clearSession(() => true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSession', () => {
  it('starts an empty version-1 session with the given name', () => {
    store().createSession('Topping out');
    expect(open()).toMatchObject({
      version: 1,
      name: 'Topping out',
      createdAt: '2026-11-16T12:00:00.000Z',
      updatedAt: '2026-11-16T12:00:00.000Z',
      brief: { topic: '', audience: '', cta: '', tone: 'neutral' },
      assets: [],
      cards: [],
      groups: [],
    });
    expect(open().id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store().brand).toEqual(emptyBrand());
  });

  it('takes a brief and does not keep a reference to it', () => {
    const brief = { topic: 'T', audience: 'A', cta: 'C', tone: 'formal' as const };
    store().createSession('S', brief);
    expect(open().brief).toEqual(brief);
    expect(open().brief).not.toBe(brief);
  });

  it('is an unsaved change', () => {
    store().createSession('S');
    expect(store().dirty).toBe(true);
  });

  it('replaces the previous session, its blobs, its missing list, and its status', () => {
    store().loadSession({
      session: makeSession(),
      brand: makeBrand(),
      blobs: new Map([[hash('a'), blob('a')]]),
      missingAssetIds: [hash('b')],
      brandMissing: false,
    });
    store().setStatus({ kind: 'info', message: 'Loaded' });
    store().createSession('Fresh');
    expect(open().name).toBe('Fresh');
    expect(open().assets).toEqual([]);
    expect(getAssetBlob(hash('a'))).toBeUndefined();
    expect(store().missingAssetIds).toEqual([]);
    expect(store().status).toBeNull();
    expect(store().brand).toEqual(emptyBrand());
  });
});

describe('actions without an open session', () => {
  it('addAssets and addCard throw a clear error', () => {
    expect(() => store().addAssets([{ asset: makeAsset() }])).toThrow('No session is open');
    expect(() => store().addCard(newCard())).toThrow('No session is open');
  });

  it('updateCard, duplicateCard and undo do nothing', () => {
    expect(store().updateCard('nope', () => undefined)).toBe(false);
    expect(store().duplicateCard('nope')).toBeNull();
    expect(store().undo()).toBe(false);
    expect(store().dirty).toBe(false);
  });
});

describe('addAssets', () => {
  beforeEach(() => store().createSession('S'));

  it('adds assets and keeps their file contents beside the store', () => {
    const a = blob('aaa');
    store().addAssets([
      { asset: makeAsset(), blob: a },
      { asset: makeAsset({ id: hash('b'), fileName: 'two.jpg' }) },
    ]);
    expect(open().assets.map((x) => x.id)).toEqual([hash('a'), hash('b')]);
    expect(getAssetBlob(hash('a'))).toBe(a);
    expect(getAssetBlob(hash('b'))).toBeUndefined();
    expect([...assetBlobs().keys()]).toEqual([hash('a')]);
  });

  it('sets dirty and bumps updatedAt', () => {
    save();
    expect(store().dirty).toBe(false);
    vi.setSystemTime(new Date('2026-11-16T12:05:00.000Z'));
    store().addAssets([{ asset: makeAsset() }]);
    expect(store().dirty).toBe(true);
    expect(open().updatedAt).toBe('2026-11-16T12:05:00.000Z');
  });

  it('keeps the existing asset when the same hash is imported again', () => {
    store().addAssets([{ asset: makeAsset({ fileName: 'first.jpg' }) }]);
    store().addAssets([{ asset: makeAsset({ fileName: 'second.jpg', width: 1 }) }]);
    expect(open().assets).toHaveLength(1);
    expect(open().assets[0]).toMatchObject({ fileName: 'first.jpg', width: 4000 });
  });

  it('does not freeze or keep the object the caller passed in', () => {
    const asset = makeAsset();
    store().addAssets([{ asset }]);
    expect(open().assets[0]).not.toBe(asset);
    expect(Object.isFrozen(asset)).toBe(false);
  });

  it('assets in the store cannot be modified in place', () => {
    store().addAssets([{ asset: makeAsset() }]);
    const [stored] = open().assets;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.focal)).toBe(true);
  });

  it('supplying the file for a missing asset clears it from the missing list', () => {
    store().loadSession({
      session: makeSession(),
      brand: makeBrand(),
      blobs: new Map(),
      missingAssetIds: [hash('a'), hash('b')],
      brandMissing: false,
    });
    const found = blob('found');
    store().addAssets([{ asset: makeAsset(), blob: found }]);
    expect(store().missingAssetIds).toEqual([hash('b')]);
    expect(getAssetBlob(hash('a'))).toBe(found);
    expect(open().assets).toHaveLength(2);
  });
});

describe('addCard', () => {
  beforeEach(() => store().createSession('S'));

  it('adds a card with a new id at version 1 and no parent', () => {
    const id = store().addCard(newCard());
    expect(open().cards).toHaveLength(1);
    expect(cardById(id)).toMatchObject({ id, version: 1, placement: 'feed-vertical' });
    expect(cardById(id).parentId).toBeUndefined();
  });

  it('gives every card a different id', () => {
    const a = store().addCard(newCard());
    const b = store().addCard(newCard());
    expect(a).not.toBe(b);
  });

  it('sets dirty', () => {
    save();
    store().addCard(newCard());
    expect(store().dirty).toBe(true);
  });

  it('does not freeze or keep the object the caller passed in', () => {
    const card = newCard();
    const id = store().addCard(card);
    expect(cardById(id).copy).not.toBe(card.copy);
    expect(Object.isFrozen(card.copy)).toBe(false);
  });
});

describe('updateCard', () => {
  let id: string;
  beforeEach(() => {
    store().createSession('S');
    id = store().addCard(newCard());
  });

  it('applies the change to that card only', () => {
    const other = store().addCard(newCard());
    store().updateCard(id, (card) => {
      card.copy.caption = 'New caption';
      card.status = 'review';
    });
    expect(cardById(id)).toMatchObject({ status: 'review', copy: { caption: 'New caption' } });
    expect(cardById(other).copy.caption).toBe('Topping out this week.');
  });

  it('sets dirty and bumps updatedAt', () => {
    save();
    vi.setSystemTime(new Date('2026-11-16T13:00:00.000Z'));
    store().updateCard(id, (card) => {
      card.overrideFail = true;
    });
    expect(store().dirty).toBe(true);
    expect(open().updatedAt).toBe('2026-11-16T13:00:00.000Z');
  });

  it('returns false and changes nothing for an unknown id', () => {
    save();
    const before = open();
    expect(store().updateCard('nope', () => undefined)).toBe(false);
    expect(open()).toBe(before);
    expect(store().dirty).toBe(false);
  });

  it('cannot change the card id', () => {
    store().updateCard(id, (card) => {
      card.id = 'hijacked';
    });
    expect(open().cards.map((c) => c.id)).toEqual([id]);
  });
});

describe('duplicateCard', () => {
  let id: string;
  beforeEach(() => {
    store().createSession('S');
    id = store().addCard(newCard({ status: 'approved', overrideFail: true }));
  });

  it('copies edit and copy, sets parentId, and increments version', () => {
    const copyId = store().duplicateCard(id);
    if (!copyId) throw new Error('expected a new card id');
    const source = cardById(id);
    const copy = cardById(copyId);
    expect(copy.id).not.toBe(source.id);
    expect(copy.parentId).toBe(source.id);
    expect(copy.version).toBe(source.version + 1);
    expect(copy.edit).toEqual(source.edit);
    expect(copy.copy).toEqual(source.copy);
    expect(copy.assetIds).toEqual(source.assetIds);
    expect(copy.platform).toBe(source.platform);
    expect(copy.placement).toBe(source.placement);
    expect(copy.validation).toEqual(source.validation);
  });

  it('makes deep copies, so editing the variant leaves the original alone', () => {
    const copyId = store().duplicateCard(id);
    if (!copyId) throw new Error('expected a new card id');
    expect(cardById(copyId).edit).not.toBe(cardById(id).edit);
    expect(cardById(copyId).copy).not.toBe(cardById(id).copy);
    store().updateCard(copyId, (card) => {
      card.copy.caption = 'Variant';
      card.copy.hashtags.push('#variant');
    });
    expect(cardById(id).copy.caption).toBe('Topping out this week.');
    expect(cardById(id).copy.hashtags).toEqual(['#construction', '#toppingout']);
  });

  it('starts the variant as a draft with no comments, override, or planned date', () => {
    const copyId = store().duplicateCard(id);
    if (!copyId) throw new Error('expected a new card id');
    const copy = cardById(copyId);
    expect(copy.status).toBe('draft');
    expect(copy.comments).toEqual([]);
    expect(copy.overrideFail).toBe(false);
    expect(copy.plannedDate).toBeUndefined();
  });

  it('places the variant right after its source', () => {
    const last = store().addCard(newCard());
    const copyId = store().duplicateCard(id);
    expect(open().cards.map((c) => c.id)).toEqual([id, copyId, last]);
  });

  it('a variant of a variant keeps the lineage going', () => {
    const second = store().duplicateCard(id);
    if (!second) throw new Error('expected a new card id');
    const third = store().duplicateCard(second);
    if (!third) throw new Error('expected a new card id');
    expect(cardById(third)).toMatchObject({ parentId: second, version: 3 });
  });

  it('sets dirty', () => {
    save();
    store().duplicateCard(id);
    expect(store().dirty).toBe(true);
  });

  it('returns null and changes nothing for an unknown id', () => {
    save();
    expect(store().duplicateCard('nope')).toBeNull();
    expect(open().cards).toHaveLength(1);
    expect(store().dirty).toBe(false);
  });
});

describe('undo', () => {
  let id: string;
  beforeEach(() => {
    store().createSession('S');
    id = store().addCard(newCard());
  });

  it('reverts an update to the snapshot of that card', () => {
    const before = cardById(id);
    store().updateCard(id, (card) => {
      card.copy.caption = 'Changed';
    });
    expect(store().undo()).toBe(true);
    expect(cardById(id)).toEqual(before);
  });

  it('reverts updates one at a time, newest first', () => {
    for (const caption of ['one', 'two', 'three']) {
      store().updateCard(id, (card) => {
        card.copy.caption = caption;
      });
    }
    store().undo();
    expect(cardById(id).copy.caption).toBe('two');
    store().undo();
    expect(cardById(id).copy.caption).toBe('one');
  });

  it('only touches the affected card', () => {
    const other = store().addCard(newCard());
    store().updateCard(id, (card) => {
      card.copy.caption = 'A';
    });
    store().updateCard(other, (card) => {
      card.copy.caption = 'B';
    });
    store().updateCard(id, (card) => {
      card.copy.caption = 'A2';
    });
    store().undo();
    expect(cardById(id).copy.caption).toBe('A');
    expect(cardById(other).copy.caption).toBe('B');
  });

  it('removes a card when the change being undone added it', () => {
    store().undo();
    expect(open().cards).toEqual([]);
  });

  it('removes a duplicate when the change being undone created it', () => {
    store().duplicateCard(id);
    store().undo();
    expect(open().cards.map((c) => c.id)).toEqual([id]);
  });

  it('sets dirty', () => {
    store().updateCard(id, (card) => {
      card.copy.caption = 'Changed';
    });
    save();
    store().undo();
    expect(store().dirty).toBe(true);
  });

  it('returns false and leaves the store clean when there is nothing to undo', () => {
    store().undo();
    save();
    expect(store().undo()).toBe(false);
    expect(store().dirty).toBe(false);
  });

  it('does not record asset imports', () => {
    const depth = store().undoStack.length;
    store().addAssets([{ asset: makeAsset() }]);
    expect(store().undoStack).toHaveLength(depth);
  });

  it(`keeps ${UNDO_LIMIT} levels and drops the oldest beyond that`, () => {
    expect(UNDO_LIMIT).toBe(50);
    // One entry exists already (the add). Sixty updates push the add and nine updates out.
    for (let i = 1; i <= 60; i++) {
      store().updateCard(id, (card) => {
        card.copy.caption = `v${i}`;
      });
    }
    expect(store().undoStack).toHaveLength(UNDO_LIMIT);
    let undone = 0;
    while (store().undo()) undone++;
    expect(undone).toBe(UNDO_LIMIT);
    // The oldest reachable state is the one before update 11, which is "v10".
    expect(cardById(id).copy.caption).toBe('v10');
  });
});

describe('undo history is cleared', () => {
  beforeEach(() => {
    store().createSession('S');
    const id = store().addCard(newCard());
    store().updateCard(id, (card) => {
      card.copy.caption = 'Changed';
    });
    expect(store().undoStack).toHaveLength(2);
  });

  it('on createSession', () => {
    store().createSession('Another');
    expect(store().undoStack).toEqual([]);
    expect(store().undo()).toBe(false);
    expect(open().cards).toEqual([]);
  });

  it('on load', () => {
    const session = makeSession();
    store().loadSession({
      session,
      brand: makeBrand(),
      blobs: new Map(),
      missingAssetIds: [],
      brandMissing: false,
    });
    expect(store().undoStack).toEqual([]);
    expect(store().undo()).toBe(false);
    expect(open().cards).toEqual(session.cards);
  });

  it('on clearSession', () => {
    store().clearSession(() => true);
    expect(store().undoStack).toEqual([]);
    expect(store().undo()).toBe(false);
  });
});

describe('clearSession', () => {
  beforeEach(() => {
    store().createSession('S');
    store().addAssets([{ asset: makeAsset(), blob: blob('a') }]);
    store().addCard(newCard());
  });

  it('does nothing when the confirmation is declined', () => {
    const before = store();
    expect(store().clearSession(() => false)).toBe(false);
    expect(store()).toBe(before);
    expect(open().cards).toHaveLength(1);
    expect(getAssetBlob(hash('a'))).toBeDefined();
    expect(store().dirty).toBe(true);
  });

  it('asks exactly once', () => {
    const confirm = vi.fn(() => false);
    store().clearSession(confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('empties the store and the blob map when confirmed', () => {
    store().setStatus({ kind: 'error', message: 'Old error' });
    expect(store().clearSession(() => true)).toBe(true);
    expect(store().session).toBeNull();
    expect(store().brand).toEqual(emptyBrand());
    expect(store().dirty).toBe(false);
    expect(store().lastSavedAt).toBeNull();
    expect(store().missingAssetIds).toEqual([]);
    expect(store().status).toBeNull();
    expect(getAssetBlob(hash('a'))).toBeUndefined();
  });
});

describe('loadSession', () => {
  it('replaces the store with the loaded session, brand, blobs and missing list', () => {
    store().createSession('Old');
    store().addAssets([{ asset: makeAsset({ id: hash('c') }), blob: blob('old') }]);
    const a = blob('a');
    store().loadSession({
      session: makeSession(),
      brand: makeBrand(),
      blobs: new Map([[hash('a'), a]]),
      missingAssetIds: [hash('b')],
      brandMissing: false,
    });
    expect(open()).toEqual(makeSession());
    expect(store().brand).toEqual(makeBrand());
    expect(getAssetBlob(hash('a'))).toBe(a);
    expect(getAssetBlob(hash('c'))).toBeUndefined();
    expect(store().missingAssetIds).toEqual([hash('b')]);
  });

  it('is not an unsaved change and keeps the file timestamps', () => {
    store().loadSession({
      session: makeSession(),
      brand: makeBrand(),
      blobs: new Map(),
      missingAssetIds: [],
      brandMissing: false,
    });
    expect(store().dirty).toBe(false);
    expect(open().updatedAt).toBe('2026-11-16T12:00:00.000Z');
  });

  it('does not keep references to what it was given', () => {
    const session = makeSession();
    const missing = [hash('b')];
    store().loadSession({
      session,
      brand: makeBrand(),
      blobs: new Map(),
      missingAssetIds: missing,
      brandMissing: false,
    });
    expect(open()).not.toBe(session);
    expect(Object.isFrozen(session)).toBe(false);
    expect(Object.isFrozen(missing)).toBe(false);
  });
});

describe('markSaved', () => {
  beforeEach(() => store().createSession('S'));

  it('clears dirty and records the time when nothing changed during the save', () => {
    vi.setSystemTime(new Date('2026-11-16T12:30:00.000Z'));
    save();
    expect(store().dirty).toBe(false);
    expect(store().lastSavedAt).toBe('2026-11-16T12:30:00.000Z');
  });

  it('leaves dirty set when a change landed while the save was running', () => {
    const revisionAtSaveStart = store().revision;
    store().addCard(newCard());
    store().markSaved(revisionAtSaveStart);
    expect(store().dirty).toBe(true);
    expect(store().lastSavedAt).not.toBeNull();
  });

  it('a save of an earlier session cannot mark a newer one as saved', () => {
    const oldRevision = store().revision;
    store().clearSession(() => true);
    store().createSession('Newer');
    store().markSaved(oldRevision);
    expect(store().dirty).toBe(true);
  });
});

describe('setStatus', () => {
  it('sets and clears the status line', () => {
    store().setStatus({ kind: 'error', message: 'Could not save' });
    expect(store().status).toEqual({ kind: 'error', message: 'Could not save' });
    store().setStatus(null);
    expect(store().status).toBeNull();
  });
});
