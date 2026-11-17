/** The one reason a card shows under its badge; the dialog lists every reason in full. */

import type { Issue, ValidationResult } from '../types';

export type Reason = {
  level: Issue['level'];
  /** The reason without its closing full stop, for example "Alt text is missing". */
  message: string;
  /** How many other reasons the card has. */
  more: number;
};

/**
 * The first reason at the card's own level, so a Fail card leads with what fails it and not with
 * a lesser warning. Null when the card has no reasons.
 */
export function firstReason(validation: ValidationResult): Reason | null {
  const first =
    validation.issues.find((issue) => issue.level === validation.level) ?? validation.issues[0];
  if (!first) return null;
  return {
    level: first.level,
    message: first.message.replace(/\.$/, ''),
    more: validation.issues.length - 1,
  };
}
