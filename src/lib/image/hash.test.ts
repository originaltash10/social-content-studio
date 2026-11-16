import { describe, expect, it } from 'vitest';
import { sha256Hex } from './hash';

const bytesOf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('sha256Hex', () => {
  it('matches the published SHA-256 test vectors', async () => {
    expect(await sha256Hex(new ArrayBuffer(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex(bytesOf('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('gives 64 lowercase hex characters, the shape session.json requires of an asset id', async () => {
    // A leading zero byte in the digest must keep its two characters.
    for (const text of ['a', 'b', 'c', 'site photo', '39']) {
      expect(await sha256Hex(bytesOf(text))).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('gives the same id for the same bytes and a different id when one byte changes', async () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const copy = new Uint8Array([1, 2, 3, 4]);
    const changed = new Uint8Array([1, 2, 3, 5]);
    expect(await sha256Hex(copy.buffer)).toBe(await sha256Hex(original.buffer));
    expect(await sha256Hex(changed.buffer)).not.toBe(await sha256Hex(original.buffer));
  });
});
