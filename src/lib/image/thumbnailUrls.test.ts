import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThumbnailUrls } from './thumbnailUrls';

const blob = (name: string) => new Blob([name]);

let made: string[];
let revoked: string[];

beforeEach(() => {
  made = [];
  revoked = [];
  // jsdom has neither function.
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => {
        const url = `blob:thumb-${made.length + 1}`;
        made.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => {
        revoked.push(url);
      }),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ThumbnailUrls', () => {
  it('starts empty', () => {
    const urls = new ThumbnailUrls();
    expect(urls.snapshot().size).toBe(0);
    expect(urls.has('a')).toBe(false);
  });

  it('makes an object URL for a thumbnail', () => {
    const urls = new ThumbnailUrls();
    const thumbnail = blob('a');
    urls.set('a', thumbnail);
    expect(URL.createObjectURL).toHaveBeenCalledWith(thumbnail);
    expect(urls.snapshot().get('a')).toBe('blob:thumb-1');
    expect(urls.has('a')).toBe(true);
  });

  it('records "no preview" without making a URL', () => {
    const urls = new ThumbnailUrls();
    urls.set('a', null);
    expect(urls.has('a')).toBe(true);
    expect(urls.snapshot().get('a')).toBeNull();
    expect(made).toEqual([]);
  });

  it('revokes the old URL when a thumbnail is replaced', () => {
    const urls = new ThumbnailUrls();
    urls.set('a', blob('first'));
    urls.set('a', blob('second'));
    expect(revoked).toEqual(['blob:thumb-1']);
    expect(urls.snapshot().get('a')).toBe('blob:thumb-2');

    urls.set('a', null);
    expect(revoked).toEqual(['blob:thumb-1', 'blob:thumb-2']);
  });

  it('revokes the URLs of thumbnails that are removed, and only those', () => {
    const urls = new ThumbnailUrls();
    urls.set('a', blob('a'));
    urls.set('b', blob('b'));
    urls.set('c', null);

    urls.keepOnly(['b', 'not there']);

    expect(revoked).toEqual(['blob:thumb-1']);
    expect([...urls.snapshot().keys()]).toEqual(['b']);
  });

  it('revokes every URL on clear', () => {
    const urls = new ThumbnailUrls();
    urls.set('a', blob('a'));
    urls.set('b', blob('b'));
    urls.clear();
    expect(revoked).toEqual(['blob:thumb-1', 'blob:thumb-2']);
    expect(urls.snapshot().size).toBe(0);
  });

  it('gives a new snapshot object on every change, and the same one when nothing changed', () => {
    const urls = new ThumbnailUrls();
    const empty = urls.snapshot();
    urls.set('a', blob('a'));
    const one = urls.snapshot();
    expect(one).not.toBe(empty);

    urls.keepOnly(['a']);
    expect(urls.snapshot()).toBe(one);
    urls.clear();
    expect(urls.snapshot()).not.toBe(one);
  });

  it('tells subscribers about changes until they unsubscribe', () => {
    const urls = new ThumbnailUrls();
    const listener = vi.fn();
    const unsubscribe = urls.subscribe(listener);

    urls.set('a', blob('a'));
    urls.keepOnly(['a']); // no change, no call
    urls.clear();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    urls.set('b', blob('b'));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
