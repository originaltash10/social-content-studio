/**
 * Keeps the page from scrolling while the card dialog is open.
 *
 * A modal dialog makes the page behind it inert, but the browser still scrolls that page: with
 * the arrow keys, Page Up and Page Down, Space, the mouse wheel or a trackpad, whenever the
 * dialog has nothing of its own to scroll. So the board moved behind the dialog.
 *
 * While locked, the page's root element has `overflow: hidden`, which stops every kind of
 * scrolling by the user. If the page had a scrollbar that takes up room, that room is kept
 * (`scrollbar-gutter: stable`), so nothing behind the dialog moves sideways. The dialog itself
 * still scrolls when it is taller than the window.
 *
 * Releasing puts both styles back as they were and returns the page to where it was when it
 * was locked.
 */

/** Locks the page's scrolling. Returns the release; calling it more than once is harmless. */
export function lockPageScroll(): () => void {
  const root = document.documentElement;
  const before = {
    x: window.scrollX,
    y: window.scrollY,
    overflow: root.style.overflow,
    scrollbarGutter: root.style.scrollbarGutter,
  };
  // Wider than the root element only when a scrollbar takes up room beside the page.
  const hasScrollbar = window.innerWidth > root.clientWidth;
  root.style.overflow = 'hidden';
  if (hasScrollbar) root.style.scrollbarGutter = 'stable';

  let released = false;
  return () => {
    if (released) return;
    released = true;
    root.style.overflow = before.overflow;
    root.style.scrollbarGutter = before.scrollbarGutter;
    window.scrollTo(before.x, before.y);
  };
}
