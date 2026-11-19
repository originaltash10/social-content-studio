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
 */

import { useSessionStore } from '../store/sessionStore';

type UndoEntry = ReturnType<typeof useSessionStore.getState>['undoStack'][number];

export type DialogUndo = {
  /** Runs a store change made in the dialog; an undo step it adds becomes the dialog's. */
  record: (change: () => void) => void;
  /** How many of the dialog's steps are still in the shared undo list. */
  count: () => number;
  /** Undoes the newest step if it is the dialog's. Returns whether a step was undone. */
  undo: () => boolean;
};

export function createDialogUndo(): DialogUndo {
  const own = new Set<UndoEntry>();
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
      const top = stack().at(-1);
      if (top === undefined || !own.has(top)) return false;
      own.delete(top);
      useSessionStore.getState().undo();
      return true;
    },
  };
}
