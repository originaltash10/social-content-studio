/**
 * What a provider's Test connection found, as one fixed value. The adapter turns the provider's
 * answer into one of these, and Settings turns each into a message written by the app
 * (src/settings/messages.ts). The provider's own text never travels further than the adapter.
 */
export type ConnectionResult =
  /** The provider accepted the key. */
  | 'ok'
  /** No key is saved for the provider, so nothing was sent. */
  | 'no-key'
  /** The saved key could not be read from this browser, so nothing was sent. */
  | 'storage'
  /** 401: the provider did not accept the key. */
  | 'wrong-key'
  /** 401: the key's organization may not call the provider from a web page. */
  | 'org-blocked'
  /** 400: the key is not tied to a workspace. */
  | 'workspace'
  /** Any other 400, such as a spending limit that has been reached. */
  | 'rejected'
  /** 402: a billing problem on the provider account. */
  | 'billing'
  /** 403: the key may not do this. */
  | 'forbidden'
  /** 429: too many requests. */
  | 'rate-limited'
  /** 5xx, overloaded, or any status not listed above. */
  | 'provider-problem'
  /** No answer within the adapter's time limit. */
  | 'timeout'
  /** The request could not be made or was blocked, for example with no internet connection. */
  | 'unreachable'
  /** The caller cancelled the test (Settings closed). Never shown to the person. */
  | 'cancelled';
