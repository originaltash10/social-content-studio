import { describe, expect, it, vi } from 'vitest';
import { ObjectUrls, browserUrls } from './objectUrls';

function api() {
  let next = 0;
  return {
    create: vi.fn(() => `blob:${++next}`),
    revoke: vi.fn(),
  };
}

describe('ObjectUrls', () => {
  it('makes a URL per id and hands it back', () => {
    const fake = api();
    const urls = new ObjectUrls(fake);
    const blob = new Blob(['x']);
    expect(urls.set('a', blob)).toBe('blob:1');
    expect(fake.create).toHaveBeenCalledWith(blob);
    expect(urls.get('a')).toBe('blob:1');
    expect(urls.get('b')).toBeUndefined();
    expect(urls.size).toBe(1);
  });

  it('revokes the URL it replaces', () => {
    const fake = api();
    const urls = new ObjectUrls(fake);
    urls.set('a', new Blob(['1']));
    urls.set('a', new Blob(['2']));
    expect(fake.revoke).toHaveBeenCalledWith('blob:1');
    expect(urls.get('a')).toBe('blob:2');
    expect(urls.size).toBe(1);
  });

  it('drop revokes and forgets one URL, and ignores an unknown id', () => {
    const fake = api();
    const urls = new ObjectUrls(fake);
    urls.set('a', new Blob(['1']));
    urls.drop('b');
    expect(fake.revoke).not.toHaveBeenCalled();
    urls.drop('a');
    expect(fake.revoke).toHaveBeenCalledWith('blob:1');
    expect(urls.size).toBe(0);
  });

  it('clear revokes every URL, leaving none behind', () => {
    const fake = api();
    const urls = new ObjectUrls(fake);
    urls.set('a', new Blob(['1']));
    urls.set('b', new Blob(['2']));
    urls.clear();
    expect(fake.revoke.mock.calls.map(([url]) => url as string).sort()).toEqual([
      'blob:1',
      'blob:2',
    ]);
    expect(urls.size).toBe(0);
  });

  it("uses the browser's functions by default", () => {
    URL.createObjectURL = vi.fn(() => 'blob:browser');
    URL.revokeObjectURL = vi.fn();
    const urls = new ObjectUrls();
    expect(urls.set('a', new Blob(['1']))).toBe('blob:browser');
    urls.clear();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:browser');
    expect(browserUrls.create(new Blob())).toBe('blob:browser');
  });
});
