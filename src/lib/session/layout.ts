/**
 * The session folder layout from SPEC.md ("Data model and session file format"), shared by the
 * folder reader/writer (fsAccess.ts) and the .scs bundle (zip.ts):
 *
 *   MySession/
 *     session.json
 *     brand.json
 *     assets/     original uploads, named by content hash
 *     renders/    cached outputs per card, regenerated if missing
 *     exports/    final deliverables by platform
 */

import type { BrandKit, Session } from '../../types';

export const ASSETS_DIR = 'assets';
export const RENDERS_DIR = 'renders';
export const EXPORTS_DIR = 'exports';

/** What gets written: the two JSON documents plus the asset files held in memory. */
export type SessionFiles = {
  session: Session;
  brand: BrandKit;
  /** File contents by asset id. Only ids listed in `session.assets` are written. */
  blobs: ReadonlyMap<string, Blob>;
};

/** What a folder or .scs load returns. */
export type LoadedSession = SessionFiles & {
  /** Ids of assets listed in session.json whose file was not found. */
  missingAssetIds: string[];
  /** True when there was no brand.json and an empty brand kit was loaded in its place. */
  brandMissing: boolean;
};

export function emptyBrand(): BrandKit {
  return { logos: [], fonts: [], colors: [], voice: '', overlayPresets: [] };
}
