/**
 * Where AI provider keys and the chosen provider are kept: IndexedDB, in a store of their own.
 *
 * Rules from SPEC.md ("AI provider layer", "AI") and CLAUDE.md that this file follows:
 * - Keys are kept in this browser on this computer only. This is a separate database from the
 *   session folder handle (src/lib/session/handleStore.ts), so nothing that remembers or forgets
 *   the folder can touch a key, and nothing here touches the folder.
 * - Keys are never in the session store, undo, a session file, an export, localStorage,
 *   sessionStorage or the URL. Only an adapter in src/ai reads a key, at call time (`readKey`).
 * - A key is not checked for any format. Saving trims spaces and line breaks at its ends, and
 *   nothing else; a key that is empty after that is refused.
 * - There is no default provider. `chosenProvider` is null until one is chosen, and a stored
 *   value Settings does not offer reads as none.
 *
 * Nothing here logs, and no key is ever part of a return value other than `readKey`'s.
 */

import { createStore, del, get, set } from 'idb-keyval';
import { findProvider, type ProviderId } from './providers';

export const SETTINGS_DATABASE = 'social-content-studio-settings';
export const SETTINGS_STORE = 'keys';

const CHOSEN = 'chosen-provider';
const keyEntry = (id: ProviderId) => `key:${id}`;

/** Opened on first use, so importing this module does not touch IndexedDB. */
let db: ReturnType<typeof createStore> | undefined;
const store = () => (db ??= createStore(SETTINGS_DATABASE, SETTINGS_STORE));

/** Spaces (U+0020) and line breaks (U+000A, U+000D) at either end; nothing else is trimmed. */
const ENDS = /^[ \n\r]+|[ \n\r]+$/g;

/** The key as it would be saved: `raw` without spaces and line breaks at its ends. */
export function trimKey(raw: string): string {
  return raw.replace(ENDS, '');
}

export type SaveOutcome = 'saved' | 'replaced' | 'empty';

/**
 * Saves the key for a provider. Returns 'empty' (and saves nothing) when the key is empty after
 * trimming, 'replaced' when it took the place of a key saved before, and 'saved' otherwise.
 */
export async function saveKey(id: ProviderId, raw: string): Promise<SaveOutcome> {
  const key = trimKey(raw);
  if (key === '') return 'empty';
  const had = await hasKey(id);
  await set(keyEntry(id), key, store());
  return had ? 'replaced' : 'saved';
}

/** True when a key is saved for the provider. */
export async function hasKey(id: ProviderId): Promise<boolean> {
  return (await readKey(id)) !== null;
}

/** The saved key, for the provider's adapter to put in a request header. Null when none. */
export async function readKey(id: ProviderId): Promise<string | null> {
  const value = await get<unknown>(keyEntry(id), store());
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Deletes the provider's key. Returns true when there was one to delete. */
export async function removeKey(id: ProviderId): Promise<boolean> {
  const had = await hasKey(id);
  await del(keyEntry(id), store());
  return had;
}

/** Remembers the chosen provider. */
export async function chooseProvider(id: ProviderId): Promise<void> {
  await set(CHOSEN, id, store());
}

/** The chosen provider, or null when none is chosen or the stored one is not offered. */
export async function chosenProvider(): Promise<ProviderId | null> {
  return findProvider(await get<unknown>(CHOSEN, store()))?.id ?? null;
}
