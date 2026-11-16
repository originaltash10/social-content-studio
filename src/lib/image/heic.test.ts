import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeHeic } from './heic';

// jsdom cannot run the real decoder, so the library is replaced here.
const heicTo = vi.hoisted(() => vi.fn());
vi.mock('heic-to', () => ({ heicTo }));

beforeEach(() => {
  heicTo.mockReset();
});

describe('decodeHeic', () => {
  it('asks the decoder library for a bitmap of the file', async () => {
    const bitmap = { width: 3024, height: 4032 };
    heicTo.mockResolvedValue(bitmap);
    const blob = new Blob(['heic bytes']);

    await expect(decodeHeic(blob)).resolves.toBe(bitmap);
    expect(heicTo).toHaveBeenCalledWith({ blob, type: 'bitmap' });
  });

  it('rejects when the library cannot decode the file', async () => {
    heicTo.mockRejectedValue('HEIF image not found');
    await expect(decodeHeic(new Blob(['nope']))).rejects.toBe('HEIF image not found');
  });
});
