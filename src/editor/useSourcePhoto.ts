/**
 * Loads a card's original photo for the editor to show, and releases it when the editor goes
 * away or the photo changes. A photo that finishes loading after it stopped being wanted is
 * closed at once and never shown.
 *
 * It only reads: the original file is not changed and nothing is written to the store.
 */

import { useEffect, useState } from 'react';
import { SourcePhotoError, loadSourcePhoto } from '../lib/editor/sourcePhoto';
import type { DisplayPhoto, SourcePhotoInput } from '../lib/editor/sourcePhoto';

export type SourcePhotoState =
  | { kind: 'loading' }
  | { kind: 'ready'; photo: DisplayPhoto }
  | { kind: 'failed'; message: string };

export type PhotoLoader = (input: SourcePhotoInput) => Promise<DisplayPhoto>;

/** What the photo to load is. `blob` is undefined when the original file is not in memory. */
export type SourcePhotoRequest = {
  assetId: string;
  blob: Blob | undefined;
  fileName: string;
  width: number;
  height: number;
};

export function missingPhotoMessage(fileName: string): string {
  return `The original file for "${fileName}" is missing. Open the session folder that has it to edit this card.`;
}

export function unexpectedPhotoMessage(fileName: string): string {
  return `"${fileName}" could not be shown for editing. Close the card and open it again.`;
}

const LOADING: SourcePhotoState = { kind: 'loading' };

/** The photo for `request`, or why there is none. Null shows nothing and loads nothing. */
export function useSourcePhoto(
  request: SourcePhotoRequest | null,
  load: PhotoLoader = loadSourcePhoto,
): SourcePhotoState {
  const [loaded, setLoaded] = useState<{ assetId: string; state: SourcePhotoState } | null>(null);
  const assetId = request?.assetId ?? null;
  const blob = request?.blob;
  const fileName = request?.fileName ?? '';
  const width = request?.width ?? 0;
  const height = request?.height ?? 0;

  useEffect(() => {
    if (assetId === null) return;
    let wanted = true;
    let held: DisplayPhoto | null = null;
    const settle = (state: SourcePhotoState) => {
      if (wanted) setLoaded({ assetId, state });
    };
    if (!blob) {
      settle({ kind: 'failed', message: missingPhotoMessage(fileName) });
    } else {
      load({ blob, fileName, expected: { width, height } }).then(
        (photo) => {
          if (!wanted) {
            photo.close();
            return;
          }
          held = photo;
          settle({ kind: 'ready', photo });
        },
        (error: unknown) => {
          settle({
            kind: 'failed',
            message:
              error instanceof SourcePhotoError ? error.message : unexpectedPhotoMessage(fileName),
          });
        },
      );
    }
    return () => {
      wanted = false;
      held?.close();
      setLoaded(null);
    };
  }, [assetId, blob, fileName, width, height, load]);

  // A result for another photo is never shown, even for the one render before it is cleared.
  return loaded && loaded.assetId === assetId ? loaded.state : LOADING;
}
