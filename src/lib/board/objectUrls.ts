/**
 * Object URLs for rendered files, by card id. An object URL keeps its file in memory until it
 * is revoked, so every URL made here is revoked here: when it is replaced, when its card goes
 * away, and on `clear`. Memory only; nothing here is saved.
 */

export type UrlApi = { create: (blob: Blob) => string; revoke: (url: string) => void };

/** The browser's functions, looked up when called so tests can replace them. */
export const browserUrls: UrlApi = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
};

export class ObjectUrls {
  private readonly urls = new Map<string, string>();

  constructor(private readonly api: UrlApi = browserUrls) {}

  /** Makes a URL for `blob` under `id`, revoking any URL it replaces. */
  set(id: string, blob: Blob): string {
    this.drop(id);
    const url = this.api.create(blob);
    this.urls.set(id, url);
    return url;
  }

  get(id: string): string | undefined {
    return this.urls.get(id);
  }

  /** Revokes and forgets the URL for `id`, if there is one. */
  drop(id: string): void {
    const url = this.urls.get(id);
    if (url === undefined) return;
    this.urls.delete(id);
    this.api.revoke(url);
  }

  /** Revokes every URL. */
  clear(): void {
    for (const id of [...this.urls.keys()]) this.drop(id);
  }

  /** How many URLs are held; for checks that nothing is left behind. */
  get size(): number {
    return this.urls.size;
  }
}
