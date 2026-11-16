/**
 * Asset ids. SPEC.md: an asset's id is the sha256 of its file, and the file is stored under
 * assets/<id>. The hash is taken over the original bytes exactly as they were dropped.
 */

/** The SHA-256 of `bytes` as 64 lowercase hex characters. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
