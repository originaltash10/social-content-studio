/**
 * Thumbnails: small previews for the import grid. They exist in memory only. They are not part
 * of the Session type, so they cannot reach session.json, and nothing here writes to disk; they
 * are made again from the asset files whenever a session is opened.
 */

/** The longest side of a thumbnail, in pixels. */
export const THUMBNAIL_SIZE = 256;

const THUMBNAIL_TYPE = 'image/webp';
const THUMBNAIL_QUALITY = 0.8;

/** The thumbnail size for an image: same shape, longest side THUMBNAIL_SIZE, never enlarged. */
export function thumbnailSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, THUMBNAIL_SIZE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Draws a decoded image at thumbnail size. Returns null when the browser cannot make the
 * preview; the asset itself is unaffected, it just has no picture in the grid.
 */
export async function renderThumbnail(bitmap: ImageBitmap): Promise<Blob | null> {
  try {
    const { width, height } = thumbnailSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return await canvas.convertToBlob({ type: THUMBNAIL_TYPE, quality: THUMBNAIL_QUALITY });
  } catch {
    return null;
  }
}
