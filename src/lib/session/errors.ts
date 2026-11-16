/** Small helpers for inspecting errors thrown by browser APIs and libraries. */

/** True when `error` is an object whose `name` is `name` (DOMException, RangeError, ...). */
export function hasName(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name;
}

/** The message of an Error, or the value as text for anything else that was thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
