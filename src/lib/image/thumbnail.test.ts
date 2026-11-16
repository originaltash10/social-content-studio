import { afterEach, describe, expect, it, vi } from 'vitest';
import { THUMBNAIL_SIZE, renderThumbnail, thumbnailSize } from './thumbnail';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('thumbnailSize', () => {
  it('is about 256 px on the long side', () => {
    expect(THUMBNAIL_SIZE).toBe(256);
  });

  it('scales the long side to the thumbnail size and keeps the shape', () => {
    expect(thumbnailSize(4032, 3024)).toEqual({ width: 256, height: 192 });
    expect(thumbnailSize(3024, 4032)).toEqual({ width: 192, height: 256 });
    expect(thumbnailSize(1000, 1000)).toEqual({ width: 256, height: 256 });
  });

  it('never enlarges a small image', () => {
    expect(thumbnailSize(120, 80)).toEqual({ width: 120, height: 80 });
    expect(thumbnailSize(256, 100)).toEqual({ width: 256, height: 100 });
  });

  it('keeps at least one pixel on the short side of a very long image', () => {
    expect(thumbnailSize(10_000, 10)).toEqual({ width: 256, height: 1 });
  });
});

/** Stands in for OffscreenCanvas, which jsdom does not have. */
function stubCanvas(options: { context?: boolean; convert?: () => Promise<Blob> } = {}) {
  const drawImage = vi.fn();
  const made: { width: number; height: number }[] = [];
  const convertToBlob = vi.fn(
    options.convert ?? (() => Promise.resolve(new Blob(['thumb'], { type: 'image/webp' }))),
  );
  class FakeCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {
      made.push({ width, height });
    }
    getContext() {
      return options.context === false ? null : { drawImage };
    }
    convertToBlob = convertToBlob;
  }
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  return { drawImage, convertToBlob, made };
}

const bitmap = (width: number, height: number) => ({ width, height }) as ImageBitmap;

describe('renderThumbnail', () => {
  it('draws the whole image onto a thumbnail-sized canvas and returns it as a blob', async () => {
    const canvas = stubCanvas();
    const source = bitmap(3024, 4032);

    const thumbnail = await renderThumbnail(source);

    expect(canvas.made).toEqual([{ width: 192, height: 256 }]);
    expect(canvas.drawImage).toHaveBeenCalledWith(source, 0, 0, 192, 256);
    expect(canvas.convertToBlob).toHaveBeenCalledWith({ type: 'image/webp', quality: 0.8 });
    expect(thumbnail).toBeInstanceOf(Blob);
    expect(thumbnail?.type).toBe('image/webp');
  });

  it('returns whatever type the browser produced, such as PNG where WebP cannot be encoded', async () => {
    const png = new Blob(['png thumb'], { type: 'image/png' });
    stubCanvas({ convert: () => Promise.resolve(png) });

    const thumbnail = await renderThumbnail(bitmap(800, 600));

    expect(thumbnail).toBe(png);
    expect(thumbnail?.type).toBe('image/png');
  });

  it('returns null when the browser gives no drawing context', async () => {
    const canvas = stubCanvas({ context: false });
    await expect(renderThumbnail(bitmap(800, 600))).resolves.toBeNull();
    expect(canvas.convertToBlob).not.toHaveBeenCalled();
  });

  it('returns null rather than failing when the preview cannot be encoded', async () => {
    stubCanvas({ convert: () => Promise.reject(new Error('out of memory')) });
    await expect(renderThumbnail(bitmap(800, 600))).resolves.toBeNull();
  });

  it('returns null when there is no OffscreenCanvas at all', async () => {
    await expect(renderThumbnail(bitmap(800, 600))).resolves.toBeNull();
  });
});
