/**
 * HEIC/HEIF decoding. Chrome and Edge cannot decode HEIC themselves, so a decoder library does
 * it. The library is large, so it is loaded only when a HEIC file actually needs decoding: the
 * dynamic import below is the only reference to it, which makes the bundler put it in a
 * separate file that is not fetched at startup.
 *
 * The decoder applies the rotation stored in the file, so the bitmap is in displayed orientation.
 */

/** Decodes a HEIC/HEIF file to a bitmap. Rejects when the file cannot be decoded. */
export type HeicDecoder = (blob: Blob) => Promise<ImageBitmap>;

export const decodeHeic: HeicDecoder = async (blob) => {
  const { heicTo } = await import('heic-to');
  return heicTo({ blob, type: 'bitmap' });
};
