/**
 * Every message Settings shows. All of them are written here, by the app: a provider's own error
 * text, a response body or a raw error's message is never shown (CLAUDE.md).
 */

import type { ConnectionResult } from '../ai/connection';

export const SETTINGS_TEXT = {
  heading: 'Settings',
  intro:
    'Your key is kept in this browser on this computer only. It is never saved in a session or an export, and it is sent only to the provider you choose.',
  providerLegend: 'AI provider',
  keyLabelNoProvider: 'API key',
  keyHint: "Paste the key from your provider's account. Once saved, it is not shown again.",
  saveKey: 'Save key',
  testConnection: 'Test connection',
  removeKey: 'Remove key',
  close: 'Close',
  messagesLabel: 'Settings messages',
} as const;

/** The key box's label once a provider is chosen. */
export const keyLabel = (providerName: string) => `${providerName} API key`;

/** The note beside Test connection: what it sends, and where. */
export const testNote = (host: string) =>
  `Sends your key to ${host} to check it. No photos or text are sent.`;

/** The line that always says whether a key is saved. */
export const KEY_STATE = {
  noProvider: 'No provider chosen yet.',
  noKey: 'No key saved yet.',
  saved: 'Key saved on this computer.',
} as const;

/** What each button says back. */
export const ACTION_MESSAGES = {
  chooseFirst: 'Choose a provider first.',
  pasteFirst: 'Paste a key first.',
  saved: 'Key saved.',
  replaced: 'Key saved. It replaces the key saved before.',
  saveFailed:
    "This browser couldn't save the key. Check that this site may store data, then try again.",
  checking: 'Checking the connection…',
  removed: 'Key removed from this browser.',
  nothingToRemove: 'No key saved, so there was nothing to remove.',
  removeFailed: "This browser couldn't remove the key. Try again.",
  readFailed: "This browser couldn't read its saved settings.",
} as const;

/** Provider chosen with its radio button. */
export const chosenMessage = (providerName: string) => `${providerName} chosen.`;

const CONNECTION_MESSAGES: Record<Exclude<ConnectionResult, 'cancelled'>, string> = {
  ok: 'Connected. Claude accepted your key.',
  'no-key': 'No key saved yet. Paste a key and press Save key first.',
  storage: ACTION_MESSAGES.readFailed,
  'wrong-key':
    "Claude didn't accept this key. Check that you copied all of it, or create a new key in your provider account.",
  'org-blocked':
    "Your organization's settings don't allow Claude to be used from a web page, so this app can't use this key. Your key itself may be fine.",
  workspace:
    "This key isn't tied to a workspace. Create a new key inside a workspace in your provider account, then save that key here.",
  rejected:
    'Claude turned down the request. If you set a spending limit, it may have been reached.',
  billing:
    'Claude reports a billing problem on this account. Check the billing details in your provider account.',
  forbidden:
    "This key isn't allowed to do this. Check its permissions and workspace in your provider account.",
  'rate-limited': 'Too many requests to Claude right now. Wait a minute and try again.',
  'provider-problem':
    'Claude is having a problem or is busy right now. Try again in a few minutes.',
  timeout: "Claude didn't answer in time. Try again.",
  unreachable:
    "Couldn't reach Claude. Check your internet connection and try again. If this keeps happening, your organization's network or settings may block calls from a web page.",
};

/**
 * The message for a Test connection result, or null for 'cancelled': a test cancelled by
 * closing Settings shows nothing.
 */
export function connectionMessage(result: ConnectionResult): string | null {
  return result === 'cancelled' ? null : CONNECTION_MESSAGES[result];
}
