/**
 * Holds the object URLs that show thumbnails, by asset id, and releases each one when it is no
 * longer needed. An object URL keeps its image in memory until it is revoked, so every URL made
 * here is revoked here: when it is replaced, when its asset goes away, and on `clear`.
 *
 * Memory only. Nothing here is saved, and the URLs are useless after the page is closed.
 *
 * `subscribe` and `snapshot` fit React's useSyncExternalStore.
 */

/** A URL for the thumbnail, or null when the asset has no preview. */
export type ThumbnailMap = ReadonlyMap<string, string | null>;

export class ThumbnailUrls {
  private urls: ThumbnailMap = new Map();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The current thumbnails. A new map object is made on every change. */
  readonly snapshot = (): ThumbnailMap => this.urls;

  /** True once a thumbnail, or the lack of one, has been recorded for `id`. */
  has(id: string): boolean {
    return this.urls.has(id);
  }

  /** Records the thumbnail for `id`; null means "no preview". Releases any URL it replaces. */
  set(id: string, thumbnail: Blob | null): void {
    const next = new Map(this.urls);
    release(next.get(id));
    next.set(id, thumbnail ? URL.createObjectURL(thumbnail) : null);
    this.replace(next);
  }

  /** Drops and releases every thumbnail whose id is not in `ids`. */
  keepOnly(ids: Iterable<string>): void {
    const keep = new Set(ids);
    const next = new Map<string, string | null>();
    for (const [id, url] of this.urls) {
      if (keep.has(id)) next.set(id, url);
      else release(url);
    }
    if (next.size !== this.urls.size) this.replace(next);
  }

  /** Drops and releases every thumbnail. */
  clear(): void {
    this.keepOnly([]);
  }

  private replace(next: ThumbnailMap): void {
    this.urls = next;
    for (const listener of this.listeners) listener();
  }
}

function release(url: string | null | undefined): void {
  if (url) URL.revokeObjectURL(url);
}
