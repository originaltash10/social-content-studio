/** Remembering the last finished file while a card is rendered again, and the caption line. */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CardRender } from '../lib/board/controller';
import { CANCELLED_TEXT, UPDATING_TEXT, captionText, useLastDone } from './lastDone';
import type { DoneRender } from './lastDone';

const DONE: DoneRender = {
  kind: 'done',
  url: 'blob:first',
  width: 720,
  height: 900,
  bytes: 820,
  format: 'png',
  upscaled: false,
};
const NEXT: DoneRender = { ...DONE, url: 'blob:second' };
const WAITING: CardRender = { kind: 'waiting' };
const WORKING: CardRender = { kind: 'working', stage: 'encoding' };

function track(first: CardRender | undefined, cardId = 'one') {
  return renderHook(({ id, render }) => useLastDone(id, render), {
    initialProps: { id: cardId, render: first },
  });
}

describe('useLastDone', () => {
  it('is null before any file is finished, even while one is being made', () => {
    const hook = track(undefined);
    expect(hook.result.current).toBeNull();
    hook.rerender({ id: 'one', render: WAITING });
    expect(hook.result.current).toBeNull();
  });

  it('keeps the last finished file while the card is rendered again, then takes the new one', () => {
    const hook = track(DONE);
    expect(hook.result.current).toBe(DONE);
    hook.rerender({ id: 'one', render: WAITING });
    expect(hook.result.current).toBe(DONE);
    hook.rerender({ id: 'one', render: WORKING });
    expect(hook.result.current).toBe(DONE);
    hook.rerender({ id: 'one', render: NEXT });
    expect(hook.result.current).toBe(NEXT);
  });

  it.each<[string, CardRender | undefined]>([
    ['fails', { kind: 'failed', message: 'No.' }],
    ['is cancelled', { kind: 'cancelled' }],
    ['is no longer tracked', undefined],
  ])('forgets the file when the render %s, so a later render starts from nothing', (_, end) => {
    const hook = track(DONE);
    hook.rerender({ id: 'one', render: end });
    expect(hook.result.current).toBeNull();
    hook.rerender({ id: 'one', render: WAITING });
    expect(hook.result.current).toBeNull();
  });

  it("never keeps one card's file for another card", () => {
    const hook = track(DONE, 'one');
    hook.rerender({ id: 'two', render: WAITING });
    expect(hook.result.current).toBeNull();
    hook.rerender({ id: 'two', render: NEXT });
    expect(hook.result.current).toBe(NEXT);
  });
});

describe('captionText', () => {
  it('describes a finished file', () => {
    expect(captionText(DONE, DONE)).toBe('720 × 900 PNG · 820 bytes');
  });

  it('says "Updating…" while a finished file is being replaced', () => {
    expect(captionText(WORKING, DONE)).toBe(UPDATING_TEXT);
    expect(captionText(WAITING, DONE)).toBe(UPDATING_TEXT);
  });

  it('gives the progress in words before the first file', () => {
    expect(captionText(WAITING, null)).toBe('Waiting to render');
    expect(captionText(WORKING, null)).toBe('Saving the file');
  });

  it('is empty otherwise, so the line keeps its place', () => {
    expect(captionText(undefined, null)).toBe('');
    expect(captionText({ kind: 'cancelled' }, null)).toBe('');
    expect(CANCELLED_TEXT).toBe('Cancelled before the file was made.');
  });
});
