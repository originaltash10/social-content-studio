import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageDecodeError, damagedMessage, heicMessage, inspectImage } from './decode';
import { sniffFile } from './fileType';
import type { ImageFormat } from './fileType';
import * as heic from './heic';
import { renderThumbnail } from './thumbnail';

vi.mock('./thumbnail', () => ({ renderThumbnail: vi.fn() }));
vi.mock('./heic', () => ({ decodeHeic: vi.fn() }));

const THUMBNAIL = new Blob(['thumb'], { type: 'image/webp' });

/** A decoded image as the browser returns it: already turned to its displayed orientation. */
function fakeBitmap(width: number, height: number) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & {
    close: ReturnType<typeof vi.fn>;
  };
}

/** What Chrome does with a file it cannot decode (checked in Chromium with cut-off files). */
const undecodable = () =>
  Promise.reject(new DOMException('The source image could not be decoded.', 'InvalidStateError'));

const createImageBitmap = vi.fn();

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  vi.mocked(renderThumbnail).mockResolvedValue(THUMBNAIL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('inspectImage: JPG and PNG', () => {
  it('reports the size of the decoded bitmap and returns its thumbnail', async () => {
    const bitmap = fakeBitmap(4032, 3024);
    createImageBitmap.mockResolvedValue(bitmap);
    const blob = new Blob(['jpeg bytes']);

    await expect(inspectImage(blob, 'jpeg', 'site.jpg')).resolves.toEqual({
      width: 4032,
      height: 3024,
      thumbnail: THUMBNAIL,
    });
    expect(renderThumbnail).toHaveBeenCalledWith(bitmap);
  });

  it('asks the browser to apply the EXIF rotation, so a portrait photo comes out portrait', async () => {
    // An iPhone held upright stores 4032 x 3024 pixels plus a "turn 90 degrees" tag. With
    // imageOrientation 'from-image' the browser hands back the turned bitmap: 3024 x 4032.
    createImageBitmap.mockImplementation((_blob: Blob, options?: ImageBitmapOptions) =>
      Promise.resolve(
        options?.imageOrientation === 'from-image'
          ? fakeBitmap(3024, 4032)
          : fakeBitmap(4032, 3024),
      ),
    );
    const blob = new Blob(['portrait jpeg']);

    const result = await inspectImage(blob, 'jpeg', 'IMG_0042.jpg');

    expect(createImageBitmap).toHaveBeenCalledWith(blob, { imageOrientation: 'from-image' });
    expect(result).toMatchObject({ width: 3024, height: 4032 });
    expect(result.height).toBeGreaterThan(result.width);
  });

  it('decodes PNG the same way and never loads the HEIC decoder', async () => {
    createImageBitmap.mockResolvedValue(fakeBitmap(800, 600));
    const blob = new Blob(['png bytes']);

    await inspectImage(blob, 'png', 'logo.png');

    expect(createImageBitmap).toHaveBeenCalledWith(blob, { imageOrientation: 'from-image' });
    expect(heic.decodeHeic).not.toHaveBeenCalled();
  });

  it('releases the full-size bitmap once the thumbnail is made', async () => {
    const bitmap = fakeBitmap(4032, 3024);
    createImageBitmap.mockResolvedValue(bitmap);
    await inspectImage(new Blob(['x']), 'jpeg', 'site.jpg');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('still imports when no thumbnail could be made', async () => {
    createImageBitmap.mockResolvedValue(fakeBitmap(640, 480));
    vi.mocked(renderThumbnail).mockResolvedValue(null);
    await expect(inspectImage(new Blob(['x']), 'png', 'a.png')).resolves.toEqual({
      width: 640,
      height: 480,
      thumbnail: null,
    });
  });
});

describe('inspectImage: damaged files', () => {
  /** A real file header followed by too little data, as left by an interrupted copy. */
  const JPEG_START = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
  const PNG_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48];

  it.each([
    ['cut-off.jpg', JPEG_START, 'jpeg', 'JPG'],
    ['cut-off.png', PNG_START, 'png', 'PNG'],
  ] as const)(
    '%s has a valid signature, passes the file-type check, and gets the damaged-file message at decode',
    async (fileName, start, format, label) => {
      const file = new File([new Uint8Array(start)], fileName);
      // The first bytes are right, so detection lets it through as a photo...
      expect(await sniffFile(file)).toEqual({ kind: 'image', format });
      // ...and the browser then fails to decode the incomplete data.
      createImageBitmap.mockImplementation(undecodable);

      const error = await inspectImage(file, format, fileName).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ImageDecodeError);
      expect(error).toMatchObject({
        name: 'ImageDecodeError',
        reason: 'damaged',
        message:
          `"${fileName}" could not be opened. It starts like a ${label} photo, but the file is ` +
          'damaged or incomplete; it may not have finished copying or downloading. Try again ' +
          'with the original file, or open it in a photo app and save a new copy as JPG or PNG.',
      });
      expect(renderThumbnail).not.toHaveBeenCalled();
    },
  );

  it.each([
    [0, 600],
    [800, 0],
  ])(
    'treats a decoded size of %i x %i as damaged and releases the bitmap',
    async (width, height) => {
      const bitmap = fakeBitmap(width, height);
      createImageBitmap.mockResolvedValue(bitmap);

      await expect(inspectImage(new Blob(['x']), 'png', 'zero.png')).rejects.toMatchObject({
        reason: 'damaged',
        message: damagedMessage('zero.png', 'png'),
      });
      expect(bitmap.close).toHaveBeenCalledOnce();
    },
  );

  it('releases the bitmap even if making the thumbnail throws', async () => {
    const bitmap = fakeBitmap(800, 600);
    createImageBitmap.mockResolvedValue(bitmap);
    vi.mocked(renderThumbnail).mockRejectedValue(new Error('unexpected'));

    await expect(inspectImage(new Blob(['x']), 'jpeg', 'a.jpg')).rejects.toThrow('unexpected');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});

describe('inspectImage: HEIC', () => {
  it('uses the HEIC decoder, not the browser, and reports the decoded (already turned) size', async () => {
    const decoder = vi.fn().mockResolvedValue(fakeBitmap(3024, 4032));
    const blob = new Blob(['heic bytes']);

    await expect(inspectImage(blob, 'heic', 'IMG_0001.HEIC', decoder)).resolves.toEqual({
      width: 3024,
      height: 4032,
      thumbnail: THUMBNAIL,
    });
    expect(decoder).toHaveBeenCalledWith(blob);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('uses the lazily loaded decoder by default', async () => {
    vi.mocked(heic.decodeHeic).mockResolvedValue(fakeBitmap(100, 200));
    const blob = new Blob(['heic bytes']);

    await expect(inspectImage(blob, 'heic', 'a.heic')).resolves.toMatchObject({ height: 200 });
    expect(heic.decodeHeic).toHaveBeenCalledWith(blob);
  });

  it.each([
    ['the file cannot be decoded', () => Promise.reject(new Error('HEIF image not found'))],
    ['the decoder rejects with plain text', () => Promise.reject('HEIF processing error')],
    ['the decoder could not be loaded', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows the convert-first message when %s', async (_case, decoder) => {
    const error = await inspectImage(new Blob(['x']), 'heic', 'IMG_9.heic', decoder).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ImageDecodeError);
    expect(error).toMatchObject({
      reason: 'heic',
      message:
        '"IMG_9.heic" is a HEIC photo that could not be opened in this browser. ' +
        'Convert it to JPG or PNG first, then import that copy.',
    });
  });

  it('shows the convert-first message for an empty decode result', async () => {
    const bitmap = fakeBitmap(0, 0);
    const decoder = vi.fn().mockResolvedValue(bitmap);
    await expect(inspectImage(new Blob(['x']), 'heic', 'a.heic', decoder)).rejects.toMatchObject({
      reason: 'heic',
      message: heicMessage('a.heic'),
    });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});

describe('messages', () => {
  it('name the file and the format in plain words', () => {
    for (const [format, label] of [
      ['jpeg', 'JPG'],
      ['png', 'PNG'],
      ['heic', 'HEIC'],
    ] as [ImageFormat, string][]) {
      expect(damagedMessage('x', format)).toContain(`starts like a ${label} photo`);
    }
  });
});
