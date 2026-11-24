import { describe, expect, it } from 'vitest';
import type { ConnectionResult } from '../ai/connection';
import { SECRET } from '../test/fixtures';
import {
  ACTION_MESSAGES,
  KEY_STATE,
  SETTINGS_TEXT,
  chosenMessage,
  connectionMessage,
  keyLabel,
  testNote,
} from './messages';

const RESULTS: Exclude<ConnectionResult, 'cancelled'>[] = [
  'ok',
  'no-key',
  'storage',
  'wrong-key',
  'org-blocked',
  'workspace',
  'rejected',
  'billing',
  'forbidden',
  'rate-limited',
  'provider-problem',
  'timeout',
  'unreachable',
];

describe('connectionMessage', () => {
  it.each(RESULTS)('%s has its own fixed message', (result) => {
    const message = connectionMessage(result);
    expect(message).toMatch(/^[A-Z].*\.$/);
    expect(message).not.toContain(SECRET);
  });

  it('gives each result a different message', () => {
    const messages = RESULTS.map(connectionMessage);
    expect(new Set(messages).size).toBe(RESULTS.length);
  });

  it('shows nothing for a test cancelled by closing Settings', () => {
    expect(connectionMessage('cancelled')).toBeNull();
  });

  it('has the agreed wording for each case', () => {
    expect(connectionMessage('ok')).toBe('Connected. Claude accepted your key.');
    expect(connectionMessage('no-key')).toBe(
      'No key saved yet. Paste a key and press Save key first.',
    );
    expect(connectionMessage('storage')).toBe("This browser couldn't read its saved settings.");
    expect(connectionMessage('wrong-key')).toBe(
      "Claude didn't accept this key. Check that you copied all of it, or create a new key in your provider account.",
    );
    expect(connectionMessage('org-blocked')).toBe(
      "Your organization's settings don't allow Claude to be used from a web page, so this app can't use this key. Your key itself may be fine.",
    );
    expect(connectionMessage('workspace')).toBe(
      "This key isn't tied to a workspace. Create a new key inside a workspace in your provider account, then save that key here.",
    );
    expect(connectionMessage('rejected')).toBe(
      'Claude turned down the request. If you set a spending limit, it may have been reached.',
    );
    expect(connectionMessage('billing')).toBe(
      'Claude reports a billing problem on this account. Check the billing details in your provider account.',
    );
    expect(connectionMessage('forbidden')).toBe(
      "This key isn't allowed to do this. Check its permissions and workspace in your provider account.",
    );
    expect(connectionMessage('rate-limited')).toBe(
      'Too many requests to Claude right now. Wait a minute and try again.',
    );
    expect(connectionMessage('provider-problem')).toBe(
      'Claude is having a problem or is busy right now. Try again in a few minutes.',
    );
    expect(connectionMessage('timeout')).toBe("Claude didn't answer in time. Try again.");
    expect(connectionMessage('unreachable')).toBe(
      "Couldn't reach Claude. Check your internet connection and try again. If this keeps happening, your organization's network or settings may block calls from a web page.",
    );
  });
});

describe('Settings text', () => {
  it('labels the key box for the chosen provider', () => {
    expect(keyLabel('Claude (Anthropic)')).toBe('Claude (Anthropic) API key');
    expect(SETTINGS_TEXT.keyLabelNoProvider).toBe('API key');
  });

  it('says what Test connection sends, and where', () => {
    expect(testNote('api.anthropic.com')).toBe(
      'Sends your key to api.anthropic.com to check it. No photos or text are sent.',
    );
  });

  it('says which provider was chosen', () => {
    expect(chosenMessage('Claude (Anthropic)')).toBe('Claude (Anthropic) chosen.');
  });

  it('has the agreed key state and action wording', () => {
    expect(KEY_STATE).toEqual({
      noProvider: 'No provider chosen yet.',
      noKey: 'No key saved yet.',
      saved: 'Key saved on this computer.',
    });
    expect(ACTION_MESSAGES.chooseFirst).toBe('Choose a provider first.');
    expect(ACTION_MESSAGES.pasteFirst).toBe('Paste a key first.');
    expect(ACTION_MESSAGES.removed).toBe('Key removed from this browser.');
    expect(ACTION_MESSAGES.nothingToRemove).toBe('No key saved, so there was nothing to remove.');
  });
});
