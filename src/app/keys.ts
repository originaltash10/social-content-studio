/** Keyboard helpers shared by the app-wide undo and the card dialog's undo. */

/** Inputs that hold no text, so Ctrl/Cmd-Z there has no typing to undo. */
const NOT_TEXT_INPUTS: ReadonlySet<string> = new Set(['checkbox', 'radio', 'range']);

/**
 * True when the key event came from a field where Ctrl/Cmd-Z should undo typing instead: a text
 * input, a text area, or editable content. A checkbox, a radio button or a slider holds no text,
 * so Ctrl/Cmd-Z there undoes the last change instead.
 */
export function isTyping(target: EventTarget | null): boolean {
  return (
    (target instanceof HTMLInputElement && !NOT_TEXT_INPUTS.has(target.type)) ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable === true)
  );
}

/** True for Ctrl/Cmd-Z without Shift (Shift turns it into redo). */
export function isUndoKey(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'key'>) {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
}
