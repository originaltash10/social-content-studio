/**
 * Undo inside the card dialog. While the dialog is open, Ctrl/Cmd-Z undoes only the changes made
 * in it since it opened: the crop and focal point (editor), the export override, and the file
 * type and quality. Every one of those changes goes through `record`, so the dialog knows which
 * entries of the shared undo list are its own.
 *
 * The dialog never claims more steps than the shared list still holds. It remembers the list's
 * own entries rather than a number, so an entry that falls off the end of the 50-step list (see
 * UNDO_LIMIT in the session store) stops being counted, and an undo only ever reverts the
 * newest entry when that entry is the dialog's.
 *
 * A control that holds a value not yet written (the quality slider, while a key is held) registers
 * a flush with `beforeUndo`, so Ctrl/Cmd-Z first writes that value as one step and then undoes it.
 */

import { useSessionStore } from '../store/sessionStore';

type UndoEntry = ReturnType<typeof useSessionStore.getState>['undoStack'][number];

export type DialogUndo = {
  /** Runs a store change made in the dialog; an undo step it adds becomes the dialog's. */
  record: (change: () => void) => void;
  /** How many of the dialog's steps are still in the shared undo list. */
  count: () => number;
  /**
   * Runs every registered flush first (the quality slider commits a value still being changed,
   * as its own step), then undoes the newest step if it is the dialog's. Returns whether a step
   * was undone.
   */
  undo: () => boolean;
  /** Registers a flush to run before each undo. Returns a function that removes it. */
  beforeUndo: (flush: () => void) => () => void;
};

export function createDialogUndo(): DialogUndo {
  const own = new Set<UndoEntry>();
  const flushes = new Set<() => void>();
  const stack = () => useSessionStore.getState().undoStack;

  /** Forgets entries that are no longer in the shared list. */
  function prune() {
    const present = new Set(stack());
    for (const entry of own) if (!present.has(entry)) own.delete(entry);
  }

  return {
    record: (change) => {
      const before = stack().at(-1);
      change();
      const after = stack().at(-1);
      if (after !== undefined && after !== before) own.add(after);
      prune();
    },
    count: () => {
      prune();
      return own.size;
    },
    undo: () => {
      for (const flush of [...flushes]) flush();
      const top = stack().at(-1);
      if (top === undefined || !own.has(top)) return false;
      own.delete(top);
      useSessionStore.getState().undo();
      return true;
    },
    beforeUndo: (flush) => {
      flushes.add(flush);
      return () => {
        flushes.delete(flush);
      };
    },
  };
}
