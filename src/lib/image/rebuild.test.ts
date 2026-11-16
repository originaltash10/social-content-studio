import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectImage } from './decode';
import { rebuildThumbnail } from './rebuild';

vi.mock('./decode', () => ({ inspectImage: vi.fn() }));

const text = (value: string) => [...value].map((char) => char.charCodeAt(0));
const blobOf = (bytes: number[]) => new Blob([new Uint8Array(bytes)]);
const JPEG = blobOf([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const HEIC = blobOf([0, 0, 0, 24, ...text('ftypheic'), 0, 0, 0, 0, ...text('mif1heic')]);
const MP4 = blobOf([0, 0, 0, 24, ...text('ftypisom'), 0, 0, 0, 0, ...text('isommp42')]);
const THUMBNAIL = new Blob(['thumb'], { type: 'image/png' });

afterEach(() => {
  vi.resetAllMocks();
});

describe('rebuildThumbnail', () => {
  it('makes the thumbnail from the stored file, going by its contents', async () => {
    vi.mocked(inspectImage).mockResolvedValue({ width: 4, height: 3, thumbnail: THUMBNAIL });

    await expect(rebuildThumbnail(JPEG, 'site.jpg')).resolves.toBe(THUMBNAIL);
    expect(inspectImage).toHaveBeenCalledWith(JPEG, 'jpeg', 'site.jpg', undefined);
  });

  it('decodes a stored HEIC with the HEIC decoder, which is when that decoder gets loaded', async () => {
    vi.mocked(inspectImage).mockResolvedValue({ width: 3, height: 4, thumbnail: THUMBNAIL });
    const decoder = vi.fn();

    // Named .jpg on purpose: stored assets have no extension to go by, only their bytes.
    await expect(rebuildThumbnail(HEIC, 'IMG_2.jpg', decoder)).resolves.toBe(THUMBNAIL);
    expect(inspectImage).toHaveBeenCalledWith(HEIC, 'heic', 'IMG_2.jpg', decoder);
  });

  it('gives no thumbnail, without decoding, for a file that is not a supported image', async () => {
    await expect(rebuildThumbnail(MP4, 'clip.mp4')).resolves.toBeNull();
    await expect(rebuildThumbnail(new Blob([]), 'empty.jpg')).resolves.toBeNull();
    expect(inspectImage).not.toHaveBeenCalled();
  });

  it('gives no thumbnail when the stored file can no longer be decoded', async () => {
    vi.mocked(inspectImage).mockRejectedValue(new Error('damaged'));
    await expect(rebuildThumbnail(JPEG, 'site.jpg')).resolves.toBeNull();
  });

  it('gives no thumbnail when the stored file cannot be read', async () => {
    const gone = new Blob(['x']);
    vi.spyOn(gone, 'slice').mockImplementation(() => {
      throw new DOMException('gone', 'NotFoundError');
    });
    await expect(rebuildThumbnail(gone, 'site.jpg')).resolves.toBeNull();
  });
});
