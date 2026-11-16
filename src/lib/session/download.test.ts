import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from './download';

describe('downloadBlob', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('clicks a temporary download link and cleans up after itself', () => {
    const create = vi.fn(() => 'blob:mock-url');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    const clicked: { href: string; download: string; attached: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download, attached: this.isConnected });
    });

    const blob = new Blob(['zip bytes']);
    downloadBlob(blob, 'Topping out.scs');

    expect(create).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([
      { href: 'blob:mock-url', download: 'Topping out.scs', attached: true },
    ]);
    expect(document.querySelector('a')).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:mock-url');
  });
});
