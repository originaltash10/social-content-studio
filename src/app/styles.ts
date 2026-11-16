/** Class names shared by the panels, built from the theme tokens in index.css. */

/** Keyboard focus ring shared by every control: 2px accent outline, clear on both backgrounds. */
export const focusClass =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

/** Shared button shape. Disabled buttons fade to half opacity and lose their hover change. */
const buttonBase = `rounded-button border px-3 py-1 font-medium disabled:cursor-not-allowed disabled:opacity-50 ${focusClass}`;

export const primaryButtonClass = `${buttonBase} border-primary bg-primary text-white enabled:hover:bg-accent enabled:hover:border-accent`;

export const buttonClass = `${buttonBase} border-muted bg-surface text-ink enabled:hover:bg-page`;
