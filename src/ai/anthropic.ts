/**
 * The Claude (Anthropic) adapter. So far it does one thing: Test connection.
 *
 * Calling the API straight from a web page, with the person's own key, was confirmed against
 * Anthropic's documentation on November 24, 2026 (see SPEC.md, "AI provider layer"). The rules
 * this file follows (SPEC.md and CLAUDE.md):
 * - The key is read from the key store here, at call time, and is put only in the request's
 *   `x-api-key` header: never in the URL, the body, the result or any message.
 * - Test connection asks only for the list of models (GET, no body), so it sends no photos or
 *   text and uses no tokens.
 * - The provider's answer is turned into a fixed `ConnectionResult`. Its error text and body are
 *   read only to tell two documented cases apart, and never go further than `classify`.
 * - Nothing here logs, and no error is passed on: every failure becomes a result.
 */

import { readKey as readStoredKey } from '../settings/keyStore';
import type { ConnectionResult } from './connection';

export const ANTHROPIC_API = 'https://api.anthropic.com';
/** The API version this adapter is written for (Anthropic's "API versions" page). */
export const ANTHROPIC_VERSION = '2026-10-21';
/** One model is enough to know the key works, and keeps the answer small. */
export const MODELS_URL = `${ANTHROPIC_API}/v1/models?limit=1`;
export const TIMEOUT_MS = 20_000;

/** The documented start of the 401 sent when an organization may not call from a web page. */
const ORG_BLOCKED = 'CORS requests are not allowed for this Organization';
/** The documented start of the 400 sent for a key that is not tied to a workspace. */
const NO_WORKSPACE = 'This API key is not scoped to a workspace';

/**
 * The request headers for a key. Anthropic documents `Authorization: Bearer` and, as the older
 * form it still accepts, `x-api-key`. The app uses `x-api-key`: it is the long-established form
 * for calls from a web page with the browser opt-in header, so it is the less likely of the two
 * to be refused by the browser's cross-site rules on the live site.
 */
export function anthropicHeaders(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    // Anthropic accepts a call from a web page only with this opt-in.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

/** The `error.message` of an Anthropic error body, or '' when there is none. */
function providerMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) return '';
    const error = parsed.error;
    if (typeof error !== 'object' || error === null || !('message' in error)) return '';
    return typeof error.message === 'string' ? error.message : '';
  } catch {
    return '';
  }
}

/**
 * Turns the provider's answer into a fixed result. `body` is read only for a 400 or a 401, and
 * only to recognise the two documented cases; it is never part of the result.
 */
export function classify(status: number, body: string): ConnectionResult {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401) {
    return providerMessage(body).startsWith(ORG_BLOCKED) ? 'org-blocked' : 'wrong-key';
  }
  if (status === 400) {
    return providerMessage(body).startsWith(NO_WORKSPACE) ? 'workspace' : 'rejected';
  }
  if (status === 402) return 'billing';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate-limited';
  return 'provider-problem';
}

export type TestDeps = {
  /** The fetch to use; the browser's own by default. */
  fetch?: typeof fetch;
  /** Where the key comes from; the key store by default. */
  readKey?: () => Promise<string | null>;
  /** How long to wait for the provider; 20 seconds by default. */
  timeoutMs?: number;
};

/**
 * Test connection: asks Claude for its list of models with the saved key.
 *
 * `signal` lets the caller cancel (Settings closing). A cancelled test gives 'cancelled', even
 * when the provider has already answered, and if it is cancelled before the request is made,
 * no request is made. The adapter's own time limit gives 'timeout'.
 */
export async function testAnthropicConnection(
  signal?: AbortSignal,
  deps: TestDeps = {},
): Promise<ConnectionResult> {
  // Looked up at call time, and called as the browser's own fetch: a fetch taken off `window`
  // and called on its own fails with "Illegal invocation".
  const send = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const read = deps.readKey ?? (() => readStoredKey('anthropic'));
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;

  if (signal?.aborted) return 'cancelled';
  let key: string | null;
  try {
    key = await read();
  } catch {
    return signal?.aborted ? 'cancelled' : 'storage';
  }
  if (signal?.aborted) return 'cancelled';
  if (key === null) return 'no-key';

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCancel = () => controller.abort();
  signal?.addEventListener('abort', onCancel);

  try {
    const response = await send(MODELS_URL, {
      method: 'GET',
      headers: anthropicHeaders(key),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      // A redirect is never followed, so the key is never sent to another address.
      redirect: 'error',
      signal: controller.signal,
    });
    const needsBody = response.status === 400 || response.status === 401;
    const body = needsBody ? await response.text() : '';
    const result = classify(response.status, body);
    return signal?.aborted ? 'cancelled' : result;
  } catch {
    if (signal?.aborted) return 'cancelled';
    return timedOut ? 'timeout' : 'unreachable';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCancel);
  }
}
