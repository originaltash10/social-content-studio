/**
 * Remembering a card's last finished file while it is rendered again, and the caption line for
 * its preview. Used by the board's tiles and the card dialog (see RenderedFile.tsx).
 */

import { useState } from 'react';

import type { CardRender } from '../lib/board/controller';
import { progressLabel } from '../lib/board/controller';
import { isPending, renderedFileLabel } from '../lib/board/view';

export type DoneRender = Extract<CardRender, { kind: 'done' }>;

/** What the caption line and the File row say while a finished file is being replaced. */
export const UPDATING_TEXT = 'Updating…';
export const CANCELLED_TEXT = 'Cancelled before the file was made.';

/**
 * The card's finished file to show: the current one, or, while the card is being rendered
 * again, the last one finished since this component was mounted for this card. Null otherwise.
 * After a failure or a cancel the old file is forgotten, as its address is no longer usable.
 */
export function useLastDone(cardId: string, render: CardRender | undefined): DoneRender | null {
  const [last, setLast] = useState<{ cardId: string; done: DoneRender | null }>({
    cardId,
    done: null,
  });
  const keep = last.cardId === cardId && isPending(render) ? last.done : null;
  const next = render?.kind === 'done' ? render : keep;
  // Derived state, updated during render so the kept picture shows in the same commit.
  if (last.cardId !== cardId || last.done !== next) setLast({ cardId, done: next });
  return next;
}

/** The one-line caption under a preview: the file, "Updating…", or the progress in words. */
export function captionText(render: CardRender | undefined, shown: DoneRender | null): string {
  if (render?.kind === 'done') return renderedFileLabel(render);
  if (isPending(render)) return shown ? UPDATING_TEXT : progressLabel(render);
  return '';
}
