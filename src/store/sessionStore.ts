/**
 * The single session store (Zustand + Immer). Holds the open Session, its brand kit, the
 * unsaved-changes flag, and the undo history. It does no I/O: saving and loading live in
 * src/store/persistence.ts and src/lib/session/.
 *
 * Rules from SPEC.md that this file enforces:
 * - Assets are immutable once imported: the file and what was read from it never change, and
 *   importing an id that is already present leaves the existing asset untouched. The one thing
 *   that can be set afterwards is the focal point (`setAssetFocal`).
 * - "Duplicating a card copies edit and copy, sets parentId, and increments version." The copy
 *   also gets its own focal point, so moving it later changes that card only.
 * - "every store mutation pushes a snapshot of the affected card ... Fifty levels is enough."
 * - Clearing needs confirmation and touches nothing on disk (the store never touches disk).
 * - A card's validation result is the validator's output, not an edit, so recording it is not
 *   an undo step, and recording the same result again is not a change.
 *
 * API keys are not part of this store. They live in IndexedDB only (Settings, Phase 2).
 */

import { produce } from 'immer';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { emptyBrand } from '../lib/session/layout';
import type { LoadedSession } from '../lib/session/layout';
import type { Asset, BrandKit, Brief, Card, Rect, Session, ValidationResult } from '../types';

export { emptyBrand };
export type { LoadedSession };

export const UNDO_LIMIT = 50;

/** An asset to import, with its file contents when they are at hand. */
export type AssetInput = { asset: Asset; blob?: Blob };

/** A card to add. The store assigns the id and starts the version at 1. */
export type NewCard = Omit<Card, 'id' | 'version' | 'parentId'>;

export type Status = { kind: 'info' | 'warning' | 'error'; message: string };

/** A new crop for one card, applied together with a focal point move. */
export type CardCrop = { cardId: string; crop: Rect };

type UndoEntry =
  /** `before` is the card as it was, or null when the card did not exist (undo removes it). */
  | { cardId: string; before: Card | null }
  /** A focal point move: the point as it was, and every card it re-cropped as it was. */
  | { assetId: string; focalBefore: Asset['focal']; cardsBefore: Card[] };

type SessionData = {
  session: Session | null;
  brand: BrandKit;
  /** True when there are changes that have not been saved. */
  dirty: boolean;
  /** Goes up by one on every change; lets a save tell whether anything changed while it ran. */
  revision: number;
  lastSavedAt: string | null;
  /** Assets whose file could not be found on load. Memory only; never written to a file. */
  missingAssetIds: string[];
  status: Status | null;
  undoStack: UndoEntry[];
};

type SessionActions = {
  /** Starts a new, empty session, replacing whatever was open. */
  createSession: (name: string, brief?: Brief) => void;
  /** Imports assets. An id that is already present is kept as it is. */
  addAssets: (inputs: AssetInput[]) => void;
  /** Adds a card and returns its id. */
  addCard: (card: NewCard) => string;
  /** Changes a card through an Immer recipe. Returns false if there is no such card. */
  updateCard: (id: string, change: (card: Card) => void) => boolean;
  /**
   * Records the validator's result for a card. It is not an undo step, and a result equal in
   * value to the one the card already has changes nothing, so it does not mark the session as
   * changed. Returns false if there is no such card.
   */
  setValidation: (id: string, result: ValidationResult) => boolean;
  /**
   * Moves a photo's focal point and gives the listed cards their new crops, as one change and
   * one undo step. The point is kept inside 0..1. A crop is applied only to a single-photo
   * card of this photo that shares the photo's focal point: a card with its own focal point is
   * never re-cropped here. Returns false if there is no such asset; a call that would change
   * nothing is not a change and adds no undo step.
   */
  setAssetFocal: (assetId: string, focal: Asset['focal'], crops?: CardCrop[]) => boolean;
  /**
   * Duplicates a card as a linked variant and returns the new id, or null if not found. The
   * copy gets its own focal point: the source card's own, or else its photo's. The source is
   * not changed. Only a source with no own point and no single photo in the session gives a
   * copy without one.
   */
  duplicateCard: (id: string) => string | null;
  /** Reverts the most recent card change. Returns false when there is nothing to undo. */
  undo: () => boolean;
  /**
   * Empties the store, but only if `confirm` returns true. Returns whether it cleared.
   * Nothing on disk is touched; releasing the folder is done by persistence.ts.
   */
  clearSession: (confirm: () => boolean) => boolean;
  /** Replaces the store contents with a session read from a folder or a .scs bundle. */
  loadSession: (loaded: LoadedSession) => void;
  /** Records a successful save of the state as it was at `revision`. */
  markSaved: (revision: number) => void;
  setStatus: (status: Status | null) => void;
};

export type SessionState = SessionData & SessionActions;

/**
 * Asset file contents, by asset id. Kept beside the store rather than in it: blobs are large,
 * are never part of session.json, and must not be copied into undo snapshots.
 */
const blobs = new Map<string, Blob>();

export function getAssetBlob(id: string): Blob | undefined {
  return blobs.get(id);
}

/** All asset file contents held in memory, for saving. */
export function assetBlobs(): ReadonlyMap<string, Blob> {
  return blobs;
}

export function emptyBrief(): Brief {
  return { topic: '', audience: '', cta: '', tone: 'neutral' };
}

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

/** Everything a new, loaded, or cleared store starts from. `revision` is left alone on purpose. */
function blank(): Omit<SessionData, 'revision'> {
  return {
    session: null,
    brand: emptyBrand(),
    dirty: false,
    lastSavedAt: null,
    missingAssetIds: [],
    status: null,
    undoStack: [],
  };
}

/**
 * True when two plain data values are equal: same primitives, same array items in the same
 * order, and objects with the same keys and equal values. Key order does not matter.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** A fraction kept inside 0..1; anything that is not a number becomes the middle. */
const unit = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5);

function pushUndo(state: SessionData, entry: UndoEntry) {
  state.undoStack.push(entry);
  if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
}

export const useSessionStore = create<SessionState>()(
  immer((set, get) => {
    /** Runs a change on the open session and marks the store as having unsaved changes. */
    function mutate(change: (session: Session, state: SessionData) => void) {
      set((state) => {
        if (!state.session) throw new Error('No session is open');
        change(state.session, state);
        state.session.updatedAt = now();
        state.dirty = true;
        state.revision += 1;
      });
    }

    return {
      ...blank(),
      revision: 0,

      createSession: (name, brief = emptyBrief()) => {
        blobs.clear();
        set((state) => {
          const at = now();
          Object.assign(state, blank());
          state.session = {
            version: 1,
            id: newId(),
            name,
            createdAt: at,
            updatedAt: at,
            brief: structuredClone(brief),
            assets: [],
            cards: [],
            groups: [],
          };
          state.dirty = true;
          state.revision += 1;
        });
      },

      addAssets: (inputs) => {
        mutate((session, state) => {
          for (const { asset, blob } of inputs) {
            if (!session.assets.some((a) => a.id === asset.id)) {
              session.assets.push(structuredClone(asset));
            }
            if (blob) {
              blobs.set(asset.id, blob);
              state.missingAssetIds = state.missingAssetIds.filter((id) => id !== asset.id);
            }
          }
        });
      },

      addCard: (card) => {
        const id = newId();
        mutate((session, state) => {
          session.cards.push({ ...structuredClone(card), id, version: 1 });
          pushUndo(state, { cardId: id, before: null });
        });
        return id;
      },

      updateCard: (id, change) => {
        const before = get().session?.cards.find((c) => c.id === id);
        if (!before) return false;
        const after = produce(before, (draft) => {
          change(draft);
          draft.id = id;
        });
        mutate((session, state) => {
          session.cards = session.cards.map((c) => (c.id === id ? after : c));
          pushUndo(state, { cardId: id, before });
        });
        return true;
      },

      setValidation: (id, result) => {
        const card = get().session?.cards.find((c) => c.id === id);
        if (!card) return false;
        if (sameValue(card.validation, result)) return true;
        const validation = structuredClone(result);
        mutate((session) => {
          session.cards = session.cards.map((c) => (c.id === id ? { ...c, validation } : c));
        });
        return true;
      },

      setAssetFocal: (assetId, focal, crops = []) => {
        const session = get().session;
        const asset = session?.assets.find((a) => a.id === assetId);
        if (!session || !asset) return false;
        const next = { x: unit(focal.x), y: unit(focal.y) };
        const wanted = new Map(crops.map(({ cardId, crop }) => [cardId, crop]));
        const cardsBefore = session.cards.filter(
          (c) =>
            wanted.has(c.id) &&
            c.focal === undefined &&
            c.assetIds.length === 1 &&
            c.assetIds[0] === assetId &&
            'format' in c.edit,
        );
        if (sameValue(asset.focal, next) && cardsBefore.length === 0) return true;
        // Compared by id: inside the change the cards are drafts, not these objects.
        const recropped = new Set(cardsBefore.map((c) => c.id));
        mutate((open, state) => {
          open.assets = open.assets.map((a) => (a.id === assetId ? { ...a, focal: next } : a));
          open.cards = open.cards.map((c) =>
            recropped.has(c.id)
              ? { ...c, edit: { ...c.edit, crop: structuredClone(wanted.get(c.id) as Rect) } }
              : c,
          );
          pushUndo(state, { assetId, focalBefore: asset.focal, cardsBefore });
        });
        return true;
      },

      duplicateCard: (id) => {
        const session = get().session;
        const source = session?.cards.find((c) => c.id === id);
        if (!session || !source) return null;
        // The copy's own focal point: the source's own, or else its photo's.
        const asset =
          source.assetIds.length === 1
            ? session.assets.find((a) => a.id === source.assetIds[0])
            : undefined;
        const focal = source.focal ?? asset?.focal;
        const copy: Card = {
          id: newId(),
          assetIds: [...source.assetIds],
          platform: source.platform,
          placement: source.placement,
          parentId: source.id,
          version: source.version + 1,
          status: 'draft',
          edit: structuredClone(source.edit),
          copy: structuredClone(source.copy),
          validation: structuredClone(source.validation),
          overrideFail: false,
          comments: [],
        };
        if (focal) copy.focal = { x: focal.x, y: focal.y };
        mutate((open, state) => {
          const at = open.cards.findIndex((c) => c.id === id);
          open.cards.splice(at + 1, 0, copy);
          pushUndo(state, { cardId: copy.id, before: null });
        });
        return copy.id;
      },

      undo: () => {
        const entry = get().undoStack.at(-1);
        if (!entry) return false;
        mutate((session, state) => {
          state.undoStack.pop();
          if ('assetId' in entry) {
            const before = new Map(entry.cardsBefore.map((c) => [c.id, c]));
            session.assets = session.assets.map((a) =>
              a.id === entry.assetId ? { ...a, focal: entry.focalBefore } : a,
            );
            session.cards = session.cards.map((c) => before.get(c.id) ?? c);
          } else {
            const { cardId, before } = entry;
            session.cards =
              before === null
                ? session.cards.filter((c) => c.id !== cardId)
                : session.cards.map((c) => (c.id === cardId ? before : c));
          }
        });
        return true;
      },

      clearSession: (confirm) => {
        if (!confirm()) return false;
        blobs.clear();
        set((state) => {
          Object.assign(state, blank());
          state.revision += 1;
        });
        return true;
      },

      loadSession: (loaded) => {
        blobs.clear();
        for (const [id, blob] of loaded.blobs) blobs.set(id, blob);
        set((state) => {
          Object.assign(state, blank());
          state.session = structuredClone(loaded.session);
          state.brand = structuredClone(loaded.brand);
          state.missingAssetIds = [...loaded.missingAssetIds];
          state.revision += 1;
        });
      },

      markSaved: (revision) => {
        set((state) => {
          state.lastSavedAt = now();
          if (state.revision === revision) state.dirty = false;
        });
      },

      setStatus: (status) => {
        set((state) => {
          state.status = status;
        });
      },
    };
  }),
);
