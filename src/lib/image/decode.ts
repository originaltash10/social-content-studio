/**
 * Opens an image file to find its size and make its thumbnail.
 *
 * Orientation: width and height are the displayed orientation. iPhone photos are often stored
 * sideways with an EXIF tag that says how to turn them. JPG and PNG are decoded with
 * `imageOrientation: 'from-image'`, which makes the browser apply that tag, and the size is read
 * from the decoded bitmap, so a portrait photo reports portrait dimensions. HEIC rotation is
 * applied by the HEIC decoder. Later steps decode the same way, so crops line up with these
 * numbers.
 *
 * The file itself is only read here, never changed.
 */

import type { ImageFormat } from './fileType';
import { FORMAT_LABEL } from './fileType';
import { decodeHeic } from './heic';
import type { HeicDecoder } from './heic';
import { renderThumbnail } from './thumbnail';

export type DecodeFailure = 'damaged' | 'heic';

/** Thrown when a file could not be opened. The message is written for the user. */
export class ImageDecodeError extends Error {
  readonly reason: DecodeFailure;

  constructor(reason: DecodeFailure, message: string) {
    super(message);
    this.name = 'ImageDecodeError';
    this.reason = reason;
  }
}

export type InspectedImage = {
  /** Displayed width and height in pixels, after any stored rotation is applied. */
  width: number;
  height: number;
  /** A small preview, or null if the browser could not make one. Memory only. */
  thumbnail: Blob | null;
};

export function damagedMessage(fileName: string, format: ImageFormat): string {
  return (
    `"${fileName}" could not be opened. It starts like a ${FORMAT_LABEL[format]} photo, but the ` +
    'file is damaged or incomplete; it may not have finished copying or downloading. ' +
    'Try again with the original file, or open it in a photo app and save a new copy as JPG or PNG.'
  );
}

export function heicMessage(fileName: string): string {
  return (
    `"${fileName}" is a HEIC photo that could not be opened in this browser. ` +
    'Convert it to JPG or PNG first, then import that copy.'
  );
}

function failure(format: ImageFormat, fileName: string): ImageDecodeError {
  return format === 'heic'
    ? new ImageDecodeError('heic', heicMessage(fileName))
    : new ImageDecodeError('damaged', damagedMessage(fileName, format));
}

/** Decodes to a bitmap in displayed orientation, or throws an ImageDecodeError. */
async function decode(
  blob: Blob,
  format: ImageFormat,
  fileName: string,
  heicDecoder: HeicDecoder,
): Promise<ImageBitmap> {
  let bitmap: ImageBitmap;
  try {
    bitmap =
      format === 'heic'
        ? await heicDecoder(blob)
        : await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Covers a damaged file, a HEIC variant the decoder cannot read, and the decoder itself
    // failing to load.
    throw failure(format, fileName);
  }
  if (bitmap.width > 0 && bitmap.height > 0) return bitmap;
  bitmap.close();
  throw failure(format, fileName);
}

/**
 * Opens `blob` as `format` (from the file-type check), and returns its displayed size and a
 * thumbnail. Throws an ImageDecodeError with a plain-language message when it cannot be opened.
 * The full-size bitmap is released before this returns.
 */
export async function inspectImage(
  blob: Blob,
  format: ImageFormat,
  fileName: string,
  heicDecoder: HeicDecoder = decodeHeic,
): Promise<InspectedImage> {
  const bitmap = await decode(blob, format, fileName, heicDecoder);
  try {
    return {
      width: bitmap.width,
      height: bitmap.height,
      thumbnail: await renderThumbnail(bitmap),
    };
  } finally {
    bitmap.close();
  }
}
