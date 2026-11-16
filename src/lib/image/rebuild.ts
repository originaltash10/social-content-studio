/**
 * Makes a thumbnail again from a stored asset file. Thumbnails are never saved, so this runs for
 * every asset when a session is opened or the page is reloaded. A HEIC asset loads the HEIC
 * decoder at that point, and not before.
 */

import { inspectImage } from './decode';
import { sniffBlob } from './fileType';
import type { HeicDecoder } from './heic';

/**
 * The thumbnail for a stored asset file, or null when none can be made (the file is not an
 * image this app can decode, or it is damaged). Never rejects.
 */
export async function rebuildThumbnail(
  blob: Blob,
  fileName: string,
  heicDecoder?: HeicDecoder,
): Promise<Blob | null> {
  try {
    const type = await sniffBlob(blob, fileName);
    if (type.kind !== 'image') return null;
    return (await inspectImage(blob, type.format, fileName, heicDecoder)).thumbnail;
  } catch {
    return null;
  }
}
