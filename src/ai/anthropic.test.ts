import 'fake-indexeddb/auto';
import { clear, createStore } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_DATABASE, SETTINGS_STORE, removeKey, saveKey } from '../settings/keyStore';
import { connectionMessage } from '../settings/messages';
import { SECRET } from '../test/fixtures';
import {
  ANTHROPIC_VERSION,
  MODELS_URL,
  TIMEOUT_MS,
  anthropicHeaders,
  classify,
  testAnthropicConnection,
} from './anthropic';
import type { ConnectionResult } from './connection';

/** The browser's fetch, as a type (a local `fetch` below would hide the global one). */
type Fetch = typeof globalThis.fetch;

/** Planted in every fake answer: it must never reach a result or a message. */
const PROVIDER_TEXT = 'PROVIDER-TEXT-MARKER';

const errorBody = (message: string) =>
  JSON.stringify({
    type: 'error',
    error: { type: 'some_error', message },
    request_id: `req_${PROVIDER_TEXT}`,
  });

/** A fetch that records each call and answers with `status` and `body`. */
function fakeFetch(status: number, body = errorBody(PROVIDER_TEXT)) {
  return vi.fn<Fetch>(async () => new Response(body, { status }));
}

const keyFrom = (value: string | null) => async () => value;

/** Every string in a value, at any depth, including a Headers object's entries. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value instanceof Headers) return [...value].flat();
  if (value instanceof AbortSignal) return [];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([name, child]) => [name, ...strings(child)]);
  }
  return [];
}

describe('classify', () => {
  const cases: [number, string, ConnectionResult][] = [
    [200, '{}', 'ok'],
    [204, '', 'ok'],
    [299, '', 'ok'],
    [401, errorBody('invalid x-api-key'), 'wrong-key'],
    [
      401,
      errorBody('CORS requests are not allowed for this Organization because of its settings.'),
      'org-blocked',
    ],
    [
      401,
      errorBody(
        'CORS requests are not allowed for this Organization because of custom retention settings.',
      ),
      'org-blocked',
    ],
    [
      400,
      errorBody(
        'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header.',
      ),
      'workspace',
    ],
    [400, errorBody('You have reached your specified workspace API usage limits.'), 'rejected'],
    [402, errorBody(PROVIDER_TEXT), 'billing'],
    [403, errorBody(PROVIDER_TEXT), 'forbidden'],
    [429, errorBody(PROVIDER_TEXT), 'rate-limited'],
    [500, errorBody(PROVIDER_TEXT), 'provider-problem'],
    [503, '', 'provider-problem'],
    [504, errorBody(PROVIDER_TEXT), 'provider-problem'],
    [529, errorBody('Overloaded'), 'provider-problem'],
    [404, errorBody(PROVIDER_TEXT), 'provider-problem'],
    [413, '', 'provider-problem'],
    [301, '', 'provider-problem'],
    [100, '', 'provider-problem'],
  ];

  it.each(cases)('%i gives %j', (status, body, want) => {
    expect(classify(status, body)).toBe(want);
  });

  it('only a message that starts with the documented words counts', () => {
    const inside = 'Note: CORS requests are not allowed for this Organization';
    expect(classify(401, errorBody(inside))).toBe('wrong-key');
    expect(classify(400, errorBody(`x ${'This API key is not scoped to a workspace'}`))).toBe(
      'rejected',
    );
  });

  it.each([
    ['not JSON', 'CORS requests are not allowed for this Organization'],
    ['empty', ''],
    ['null', 'null'],
    ['a number', '42'],
    ['no error', '{"type":"error"}'],
    ['error is null', '{"error":null}'],
    ['error is text', '{"error":"CORS requests are not allowed for this Organization"}'],
    ['no message', '{"error":{"type":"authentication_error"}}'],
    [
      'message not text',
      '{"error":{"message":["CORS requests are not allowed for this Organization"]}}',
    ],
  ])('reads a body that is %s as no message', (_, body) => {
    expect(classify(401, body)).toBe('wrong-key');
    expect(classify(400, body)).toBe('rejected');
  });
});

describe('anthropicHeaders', () => {
  it('puts the key only in x-api-key, with the version and the browser opt-in', () => {
    expect(anthropicHeaders(SECRET)).toEqual({
      'x-api-key': SECRET,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    expect(ANTHROPIC_VERSION).toBe('2026-10-21');
  });
});

describe('testAnthropicConnection', () => {
  it('asks for the model list: GET, the fixed address, the three headers and no body', async () => {
    const fetch = fakeFetch(200, '{"data":[]}');
    expect(await testAnthropicConnection(undefined, { fetch, readKey: keyFrom(SECRET) })).toBe(
      'ok',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(MODELS_URL).toBe(url);
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({
      'x-api-key': SECRET,
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    expect(Object.keys(init ?? {}).sort()).toEqual(
      ['cache', 'credentials', 'headers', 'method', 'redirect', 'referrerPolicy', 'signal'].sort(),
    );
  });

  it('puts the key in the x-api-key header and nowhere else: not the URL, another header, an option or the result', async () => {
    const fetch = fakeFetch(200, '{}');
    const result = await testAnthropicConnection(undefined, { fetch, readKey: keyFrom(SECRET) });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).not.toContain(SECRET);
    const { headers, ...options } = init ?? {};
    const { 'x-api-key': key, ...otherHeaders } = headers as Record<string, string>;
    expect(key).toBe(SECRET);
    expect(strings(otherHeaders).join('\n')).not.toContain(SECRET);
    expect(strings(options).join('\n')).not.toContain(SECRET);
    expect(result).not.toContain(SECRET);
  });

  it.each<[number, string, ConnectionResult]>([
    [200, '{}', 'ok'],
    [401, errorBody(PROVIDER_TEXT), 'wrong-key'],
    [
      401,
      errorBody(`CORS requests are not allowed for this Organization ${PROVIDER_TEXT}`),
      'org-blocked',
    ],
    [400, errorBody(`This API key is not scoped to a workspace ${PROVIDER_TEXT}`), 'workspace'],
    [400, errorBody(PROVIDER_TEXT), 'rejected'],
    [402, errorBody(PROVIDER_TEXT), 'billing'],
    [403, errorBody(PROVIDER_TEXT), 'forbidden'],
    [429, errorBody(PROVIDER_TEXT), 'rate-limited'],
    [500, errorBody(PROVIDER_TEXT), 'provider-problem'],
    [529, errorBody(PROVIDER_TEXT), 'provider-problem'],
  ])(
    'a %i answer gives %j, and no provider text reaches the result or its message',
    async (status, body, want) => {
      const result = await testAnthropicConnection(undefined, {
        fetch: fakeFetch(status, body),
        readKey: keyFrom(SECRET),
      });
      expect(result).toBe(want);
      const message = connectionMessage(result) ?? '';
      expect(message).not.toBe('');
      for (const text of [result, message]) {
        expect(text).not.toContain(PROVIDER_TEXT);
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('CORS requests');
        expect(text).not.toContain('not scoped');
      }
    },
  );

  it('reads the body only for a 400 or a 401', async () => {
    for (const status of [200, 402, 403, 429, 500]) {
      const response = new Response('{}', { status });
      const text = vi.spyOn(response, 'text');
      await testAnthropicConnection(undefined, {
        fetch: vi.fn<Fetch>(async () => response),
        readKey: keyFrom(SECRET),
      });
      expect(text).not.toHaveBeenCalled();
    }
  });

  it('with no key saved, sends nothing and says so', async () => {
    const fetch = fakeFetch(200);
    expect(await testAnthropicConnection(undefined, { fetch, readKey: keyFrom(null) })).toBe(
      'no-key',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('when the key cannot be read, sends nothing and says so', async () => {
    const fetch = fakeFetch(200);
    const readKey = async () => {
      throw new Error(`storage failure ${PROVIDER_TEXT}`);
    };
    const result = await testAnthropicConnection(undefined, { fetch, readKey });
    expect(result).toBe('storage');
    expect(connectionMessage(result)).not.toContain(PROVIDER_TEXT);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a network failure gives "unreachable", without the error text', async () => {
    const fetch = vi.fn<Fetch>(async () => {
      throw new TypeError(`Failed to fetch ${PROVIDER_TEXT} ${SECRET}`);
    });
    const result = await testAnthropicConnection(undefined, { fetch, readKey: keyFrom(SECRET) });
    expect(result).toBe('unreachable');
    expect(connectionMessage(result)).not.toContain(PROVIDER_TEXT);
    expect(connectionMessage(result)).not.toContain(SECRET);
  });

  it('a body that cannot be read gives "unreachable"', async () => {
    const response = new Response('{}', { status: 401 });
    vi.spyOn(response, 'text').mockRejectedValue(new TypeError(PROVIDER_TEXT));
    expect(
      await testAnthropicConnection(undefined, {
        fetch: vi.fn<Fetch>(async () => response),
        readKey: keyFrom(SECRET),
      }),
    ).toBe('unreachable');
  });

  describe('time limit and cancelling', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /** A fetch that never answers, and rejects as a browser does when its signal aborts. */
    function hangingFetch() {
      return vi.fn<Fetch>(
        (_, init) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      );
    }

    it('gives "timeout" after 20 seconds without an answer, and aborts the request', async () => {
      expect(TIMEOUT_MS).toBe(20_000);
      const fetch = hangingFetch();
      const pending = testAnthropicConnection(undefined, { fetch, readKey: keyFrom(SECRET) });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe('timeout');
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    });

    it('uses a time limit given by the caller', async () => {
      const pending = testAnthropicConnection(undefined, {
        fetch: hangingFetch(),
        readKey: keyFrom(SECRET),
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toBe('timeout');
    });

    it('a time limit reached while the body is read gives "timeout"', async () => {
      const response = new Response('{}', { status: 401 });
      const fetch = vi.fn<Fetch>(async (_, init) => {
        vi.spyOn(response, 'text').mockImplementation(
          () =>
            new Promise<string>((_, reject) =>
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('', 'AbortError')),
              ),
            ),
        );
        return response;
      });
      const pending = testAnthropicConnection(undefined, { fetch, readKey: keyFrom(SECRET) });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(await pending).toBe('timeout');
    });

    it('a cancel by the caller aborts the request and gives "cancelled", which has no message', async () => {
      const fetch = hangingFetch();
      const caller = new AbortController();
      const pending = testAnthropicConnection(caller.signal, { fetch, readKey: keyFrom(SECRET) });
      await vi.advanceTimersByTimeAsync(10);
      caller.abort();
      expect(await pending).toBe('cancelled');
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(connectionMessage('cancelled')).toBeNull();
    });

    it('a cancel after the time limit has started still gives "cancelled", not "timeout"', async () => {
      const fetch = hangingFetch();
      const caller = new AbortController();
      const pending = testAnthropicConnection(caller.signal, {
        fetch,
        readKey: keyFrom(SECRET),
        timeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(99);
      caller.abort();
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toBe('cancelled');
    });

    it('stops the timer and its listener once done, so a later cancel changes nothing', async () => {
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, 'removeEventListener');
      const result = await testAnthropicConnection(caller.signal, {
        fetch: fakeFetch(200, '{}'),
        readKey: keyFrom(SECRET),
      });
      expect(result).toBe('ok');
      expect(vi.getTimerCount()).toBe(0);
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });
  });

  it('cancelled before it starts: no key is read and no request is made', async () => {
    const fetch = fakeFetch(200);
    const readKey = vi.fn(keyFrom(SECRET));
    const caller = new AbortController();
    caller.abort();
    expect(await testAnthropicConnection(caller.signal, { fetch, readKey })).toBe('cancelled');
    expect(readKey).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancelled while the key is being read: no request is made', async () => {
    const fetch = fakeFetch(200);
    const caller = new AbortController();
    const readKey = async () => {
      caller.abort();
      return SECRET;
    };
    expect(await testAnthropicConnection(caller.signal, { fetch, readKey })).toBe('cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancelled while the key read fails: "cancelled", not a storage message', async () => {
    const caller = new AbortController();
    const readKey = async () => {
      caller.abort();
      throw new Error('storage');
    };
    expect(await testAnthropicConnection(caller.signal, { fetch: fakeFetch(200), readKey })).toBe(
      'cancelled',
    );
  });

  it('cancelled after the provider answered: the answer is dropped', async () => {
    const caller = new AbortController();
    const fetch = vi.fn<Fetch>(async () => {
      caller.abort();
      return new Response('{}', { status: 200 });
    });
    expect(await testAnthropicConnection(caller.signal, { fetch, readKey: keyFrom(SECRET) })).toBe(
      'cancelled',
    );
  });

  describe('with the real key store and the browser fetch', () => {
    beforeEach(async () => {
      await clear(createStore(SETTINGS_DATABASE, SETTINGS_STORE));
    });
    afterEach(() => vi.unstubAllGlobals());

    it('reads the saved key at call time, and calls the global fetch as itself', async () => {
      const fetch = vi.fn(function (this: unknown) {
        // A fetch called with the wrong `this` fails in a browser ("Illegal invocation").
        expect(this === undefined || this === globalThis).toBe(true);
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      vi.stubGlobal('fetch', fetch);

      expect(await testAnthropicConnection()).toBe('no-key');
      expect(fetch).not.toHaveBeenCalled();

      await saveKey('anthropic', ` ${SECRET}\n`);
      expect(await testAnthropicConnection()).toBe('ok');
      const init = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect((init[1].headers as Record<string, string>)['x-api-key']).toBe(SECRET);

      await removeKey('anthropic');
      expect(await testAnthropicConnection()).toBe('no-key');
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});
