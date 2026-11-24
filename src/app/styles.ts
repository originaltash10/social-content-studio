/** Class names shared by the panels, built from the theme tokens in index.css. */

/** Keyboard focus ring shared by every control: 2px accent outline, clear on both backgrounds. */
export const focusClass =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

/** Shared text box: the session name, and the card's caption, hashtags and first comment. */
export const textFieldClass = `rounded-control border border-muted bg-surface px-2 py-1 text-ink ${focusClass}`;

/** Shared button shape. Disabled buttons fade to half opacity and lose their hover change. */
const buttonBase = `rounded-button border px-3 py-1 font-medium disabled:cursor-not-allowed disabled:opacity-50 ${focusClass}`;

export const primaryButtonClass = `${buttonBase} border-primary bg-primary text-white enabled:hover:bg-accent enabled:hover:border-accent`;

export const buttonClass = `${buttonBase} border-muted bg-surface text-ink enabled:hover:bg-page`;

/**
 * Text colour for each card result. Each meets 4.5:1 contrast on the surface colour, and the
 * badge always shows a symbol and a word as well, so colour is never the only signal.
 */
export const resultTextClass = {
  pass: 'text-success-text',
  warn: 'text-highlight-text',
  fail: 'text-danger-text',
  unchecked: 'text-muted-text',
} as const;

/** Shared shape for the result and version badges. */
export const badgeClass =
  'inline-flex items-center gap-1 rounded-control border border-current px-2 py-0.5 text-label font-medium';
