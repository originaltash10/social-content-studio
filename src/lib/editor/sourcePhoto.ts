/**
 * Opens a card's original photo for the editor to show. Memory only: nothing here is saved, and
 * the original file is only read.
 *
 * The photo is decoded the same way the renderer decodes it (src/lib/render/renderImage.ts):
 * JPG and PNG with `imageOrientation: 'from-image'`, HEIC through the HEIC decoder, which
 * applies the file's rotation itself. The decoded size is then checked against the size
 * recorded at import, exactly as the renderer checks it. So what the editor shows and what the
 * renderer draws from are the same picture, the same way up, and a crop set on one lines up on
 * the other.
 *
 * The editor only needs a picture to look at, so a large photo is drawn once at a reduced size
 * (longest side MAX_DISPLAY_SIDE) and the full-size bitmap is closed straight away. The
 * display copy is a bitmap, not a file, so no object URL is made. Whoever asks for a photo must
 * call `close()` on it when done.
 *
 * The browser functions are passed in, so tests can replace them.
 */

import { damagedMessage, heicMessage } from '../image/decode';
import { sniffBlob } from '../image/fileType';
import type { FileType } from '../image/fileType';
import { decodeHeic } from '../image/heic';
import type { HeicDecoder } from '../image/heic';
import type { Size } from '../../types';

/**
 * The longest side of the display copy, in pixels. At four bytes a pixel, a 4:3 photo's copy is
 * 2048 x 1536 and takes about 13 MB, whatever the size of the original.
 */
export const MAX_DISPLAY_SIDE = 2048;

/** The parts of an OffscreenCanvas this code uses. */
export type DisplayCanvas = Pick<OffscreenCanvas, 'transferToImageBitmap'> & {
  getContext(contextId: '2d'): OffscreenCanvasRenderingContext2D | null;
};

export type SourcePhotoDeps = {
  sniff: (blob: Blob, fileName: string) => Promise<FileType>;
  createImageBitmap: typeof createImageBitmap;
  heicDecoder: HeicDecoder;
  createCanvas: (width: number, height: number) => DisplayCanvas;
};

/** The real browser functions. The HEIC decoder is only loaded when a HEIC photo is opened. */
export function browserDeps(): SourcePhotoDeps {
  return {
    sniff: sniffBlob,
    createImageBitmap: createImageBitmap.bind(globalThis),
    heicDecoder: decodeHeic,
    createCanvas: (width, height) => new OffscreenCanvas(width, height),
  };
}

/** A photo ready to show in the editor. */
export type DisplayPhoto = {
  /** The picture to draw, the right way up, at most MAX_DISPLAY_SIDE on its longest side. */
  bitmap: ImageBitmap;
  /** The size of `bitmap`. */
  width: number;
  height: number;
  /** The size of the original photo, which crops and focal points are fractions of. */
  source: Size;
  /** Releases the picture. Safe to call more than once. */
  close: () => void;
};

/** Thrown when a photo cannot be opened for editing. The message is written for the user. */
export class SourcePhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcePhotoError';
  }
}

/** The display size for a photo: same shape, longest side MAX_DISPLAY_SIDE, never enlarged. */
export function displaySize(source: Size): Size {
  const scale = Math.min(1, MAX_DISPLAY_SIDE / Math.max(source.width, source.height));
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

function sizeChangedMessage(fileName: string, opened: Size, expected: Size): string {
  return (
    `"${fileName}" opens as ${opened.width} x ${opened.height} pixels in this browser, but it ` +
    `was ${expected.width} x ${expected.height} when it was imported, so its crop cannot be ` +
    'edited here. Try the browser you imported it with, or open it in a photo app, save a new ' +
    'copy as JPG, and import that copy.'
  );
}

function memoryMessage(fileName: string): string {
  return (
    `"${fileName}" could not be shown for editing. The browser may be short of memory. ` +
    'Close other tabs or programs and try again.'
  );
}

export type SourcePhotoInput = {
  /** The original file. */
  blob: Blob;
  fileName: string;
  /** The photo's size as recorded at import: `Asset.width` by `Asset.height`. */
  expected: Size;
};

/**
 * Opens a photo for the editor. Rejects only with a SourcePhotoError. The full-size bitmap is
 * closed before this returns unless it is small enough to be the display copy itself.
 */
export async function loadSourcePhoto(
  { blob, fileName, expected }: SourcePhotoInput,
  deps: SourcePhotoDeps = browserDeps(),
): Promise<DisplayPhoto> {
  let type: FileType;
  try {
    type = await deps.sniff(blob, fileName);
  } catch {
    throw new SourcePhotoError(memoryMessage(fileName));
  }
  if (type.kind === 'rejected') throw new SourcePhotoError(type.message);

  let full: ImageBitmap;
  try {
    full =
      type.format === 'heic'
        ? await deps.heicDecoder(blob)
        : await deps.createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new SourcePhotoError(
      type.format === 'heic' ? heicMessage(fileName) : damagedMessage(fileName, type.format),
    );
  }
  if (full.width !== expected.width || full.height !== expected.height) {
    const error = new SourcePhotoError(sizeChangedMessage(fileName, full, expected));
    full.close();
    throw error;
  }

  const source = { width: expected.width, height: expected.height };
  const size = displaySize(source);
  let bitmap = full;
  if (size.width !== full.width || size.height !== full.height) {
    try {
      const canvas = deps.createCanvas(size.width, size.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(full, 0, 0, size.width, size.height);
      bitmap = canvas.transferToImageBitmap();
    } catch {
      throw new SourcePhotoError(memoryMessage(fileName));
    } finally {
      full.close();
    }
  }

  let closed = false;
  return {
    bitmap,
    ...size,
    source,
    close: () => {
      if (closed) return;
      closed = true;
      bitmap.close();
    },
  };
}
