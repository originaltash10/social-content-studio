import { afterEach, describe, expect, it, vi } from 'vitest';
import { damagedMessage, heicMessage } from '../image/decode';
import type { FileType } from '../image/fileType';
import {
  MAX_DISPLAY_SIDE,
  SourcePhotoError,
  browserDeps,
  displaySize,
  loadSourcePhoto,
} from './sourcePhoto';
import type { SourcePhotoDeps } from './sourcePhoto';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BLOB = new Blob(['photo']);
const JPEG: FileType = { kind: 'image', format: 'jpeg' };
const HEIC: FileType = { kind: 'image', format: 'heic' };

function bitmapOf(width: number, height: number) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & {
    close: ReturnType<typeof vi.fn>;
  };
}

type Options = {
  type?: FileType;
  decoded?: ImageBitmap;
  context?: boolean;
  draw?: () => void;
};

function fakeDeps(options: Options = {}) {
  const decoded = options.decoded ?? bitmapOf(4000, 3000);
  const context = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    drawImage: vi.fn(options.draw),
  };
  const canvases: { width: number; height: number; copy: ReturnType<typeof bitmapOf> }[] = [];
  const deps = {
    sniff: vi.fn(() => Promise.resolve(options.type ?? JPEG)),
    createImageBitmap: vi.fn(() => Promise.resolve(decoded)),
    heicDecoder: vi.fn(() => Promise.resolve(decoded)),
    createCanvas: vi.fn((width: number, height: number) => {
      const copy = bitmapOf(width, height);
      canvases.push({ width, height, copy });
      return {
        getContext: () => (options.context === false ? null : context),
        transferToImageBitmap: () => copy,
      };
    }),
  };
  return { deps: deps as unknown as SourcePhotoDeps, spies: deps, decoded, context, canvases };
}

const input = (width = 4000, height = 3000) => ({
  blob: BLOB,
  fileName: 'site.jpg',
  expected: { width, height },
});

async function failure(promise: Promise<unknown>): Promise<SourcePhotoError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SourcePhotoError);
    return error as SourcePhotoError;
  }
  throw new Error('expected the photo not to open');
}

describe('displaySize', () => {
  it('scales the longest side down to the limit and keeps the shape', () => {
    expect(MAX_DISPLAY_SIDE).toBe(2048);
    expect(displaySize({ width: 4000, height: 3000 })).toEqual({ width: 2048, height: 1536 });
    expect(displaySize({ width: 3000, height: 4000 })).toEqual({ width: 1536, height: 2048 });
  });

  it('never enlarges a small photo', () => {
    expect(displaySize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
    expect(displaySize({ width: 2048, height: 100 })).toEqual({ width: 2048, height: 100 });
  });

  it('keeps at least one pixel on the short side of a very long photo', () => {
    expect(displaySize({ width: 100_000, height: 10 })).toEqual({ width: 2048, height: 1 });
  });
});

describe('loadSourcePhoto', () => {
  it('decodes a JPG the way the renderer does, with its stored rotation applied', async () => {
    const { deps, spies } = fakeDeps();
    await loadSourcePhoto(input(), deps);
    expect(spies.sniff).toHaveBeenCalledWith(BLOB, 'site.jpg');
    expect(spies.createImageBitmap).toHaveBeenCalledWith(BLOB, { imageOrientation: 'from-image' });
    expect(spies.heicDecoder).not.toHaveBeenCalled();
  });

  it('uses the HEIC decoder for a HEIC photo, and only then', async () => {
    const { deps, spies } = fakeDeps({ type: HEIC });
    await loadSourcePhoto(input(), deps);
    expect(spies.heicDecoder).toHaveBeenCalledWith(BLOB);
    expect(spies.createImageBitmap).not.toHaveBeenCalled();
  });

  it('makes a reduced copy of a large photo and closes the full-size bitmap', async () => {
    const { deps, decoded, context, canvases } = fakeDeps();
    const photo = await loadSourcePhoto(input(), deps);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ width: 2048, height: 1536 });
    expect(context.drawImage).toHaveBeenCalledWith(decoded, 0, 0, 2048, 1536);
    expect(context.imageSmoothingEnabled).toBe(true);
    expect(context.imageSmoothingQuality).toBe('high');
    expect(decoded.close).toHaveBeenCalledTimes(1);
    expect(photo.bitmap).toBe(canvases[0]?.copy);
    expect(photo).toMatchObject({ width: 2048, height: 1536 });
    // Crops stay fractions of the original, not of the copy.
    expect(photo.source).toEqual({ width: 4000, height: 3000 });
  });

  it('keeps the shape of a portrait photo, so width and height are not swapped', async () => {
    const { deps } = fakeDeps({ decoded: bitmapOf(3000, 4000) });
    const photo = await loadSourcePhoto(input(3000, 4000), deps);
    expect(photo).toMatchObject({ width: 1536, height: 2048 });
    expect(photo.source).toEqual({ width: 3000, height: 4000 });
  });

  it('shows a small photo as it is, without a copy', async () => {
    const decoded = bitmapOf(800, 600);
    const { deps, spies } = fakeDeps({ decoded });
    const photo = await loadSourcePhoto(input(800, 600), deps);
    expect(spies.createCanvas).not.toHaveBeenCalled();
    expect(photo.bitmap).toBe(decoded);
    expect(decoded.close).not.toHaveBeenCalled();
    expect(photo).toMatchObject({ width: 800, height: 600 });
  });

  it('releases the picture on close, once', async () => {
    const { deps, canvases } = fakeDeps();
    const photo = await loadSourcePhoto(input(), deps);
    const copy = canvases[0]?.copy;
    expect(copy?.close).not.toHaveBeenCalled();
    photo.close();
    photo.close();
    expect(copy?.close).toHaveBeenCalledTimes(1);
  });

  it('refuses a file that is not a supported photo, with the reason', async () => {
    const { deps, spies } = fakeDeps({
      type: { kind: 'rejected', reason: 'damaged', message: 'Not a photo.' },
    });
    const error = await failure(loadSourcePhoto(input(), deps));
    expect(error.message).toBe('Not a photo.');
    expect(error.name).toBe('SourcePhotoError');
    expect(spies.createImageBitmap).not.toHaveBeenCalled();
  });

  it('explains when the file cannot be read at all', async () => {
    const { deps, spies } = fakeDeps();
    spies.sniff.mockRejectedValueOnce(new Error('gone'));
    const error = await failure(loadSourcePhoto(input(), deps));
    expect(error.message).toContain('"site.jpg" could not be shown for editing');
  });

  it('explains a photo that cannot be decoded', async () => {
    const jpg = fakeDeps();
    jpg.spies.createImageBitmap.mockRejectedValueOnce(new Error('bad'));
    expect((await failure(loadSourcePhoto(input(), jpg.deps))).message).toBe(
      damagedMessage('site.jpg', 'jpeg'),
    );
    const heic = fakeDeps({ type: HEIC });
    heic.spies.heicDecoder.mockRejectedValueOnce(new Error('bad'));
    expect((await failure(loadSourcePhoto(input(), heic.deps))).message).toBe(
      heicMessage('site.jpg'),
    );
  });

  it('refuses a photo that opens at a different size from its import, and closes it', async () => {
    // For example a browser that does not apply the stored rotation: 3000 x 4000, not 4000 x 3000.
    for (const decoded of [bitmapOf(3000, 4000), bitmapOf(4000, 2999)]) {
      const { deps, spies } = fakeDeps({ decoded });
      const error = await failure(loadSourcePhoto(input(), deps));
      expect(error.message).toContain(`opens as ${decoded.width} x ${decoded.height} pixels`);
      expect(error.message).toContain('it was 4000 x 3000 when it was imported');
      expect(decoded.close).toHaveBeenCalledTimes(1);
      expect(spies.createCanvas).not.toHaveBeenCalled();
    }
  });

  it('closes the full-size bitmap when the copy cannot be made', async () => {
    const noContext = fakeDeps({ context: false });
    const first = await failure(loadSourcePhoto(input(), noContext.deps));
    expect(first.message).toContain('The browser may be short of memory');
    expect(noContext.decoded.close).toHaveBeenCalledTimes(1);

    const throws = fakeDeps({
      draw: () => {
        throw new Error('out of memory');
      },
    });
    await failure(loadSourcePhoto(input(), throws.deps));
    expect(throws.decoded.close).toHaveBeenCalledTimes(1);
  });
});

describe('browserDeps', () => {
  it('uses the browser to decode and to make the copy', async () => {
    const decoded = bitmapOf(4000, 3000);
    const createImageBitmap = vi.fn(() => Promise.resolve(decoded));
    const copy = bitmapOf(2048, 1536);
    const made: number[][] = [];
    class FakeCanvas {
      constructor(width: number, height: number) {
        made.push([width, height]);
      }
      getContext() {
        return { drawImage: vi.fn() };
      }
      transferToImageBitmap() {
        return copy;
      }
    }
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    // A real JPG signature, so the real file-type check accepts it.
    const jpg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])]);
    const photo = await loadSourcePhoto({
      blob: jpg,
      fileName: 'site.jpg',
      expected: { width: 4000, height: 3000 },
    });
    expect(createImageBitmap).toHaveBeenCalledWith(jpg, { imageOrientation: 'from-image' });
    expect(made).toEqual([[2048, 1536]]);
    expect(photo.bitmap).toBe(copy);
    expect(typeof browserDeps().heicDecoder).toBe('function');
  });
});
