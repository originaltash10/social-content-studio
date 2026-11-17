import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SourcePhotoError } from '../lib/editor/sourcePhoto';
import type { DisplayPhoto, SourcePhotoInput } from '../lib/editor/sourcePhoto';
import { missingPhotoMessage, unexpectedPhotoMessage, useSourcePhoto } from './useSourcePhoto';
import type { SourcePhotoRequest } from './useSourcePhoto';

const BLOB = new Blob(['photo']);
const request = (assetId = 'a', overrides: Partial<SourcePhotoRequest> = {}) => ({
  assetId,
  blob: BLOB,
  fileName: `${assetId}.jpg`,
  width: 4000,
  height: 3000,
  ...overrides,
});

function photoOf() {
  return {
    bitmap: {} as ImageBitmap,
    width: 2048,
    height: 1536,
    source: { width: 4000, height: 3000 },
    close: vi.fn<() => void>(),
  };
}

/** A loader whose answers are given by the test, one call at a time. */
function manualLoader() {
  const calls: {
    input: SourcePhotoInput;
    resolve: (photo: DisplayPhoto) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const load = vi.fn(
    (input: SourcePhotoInput) =>
      new Promise<DisplayPhoto>((resolve, reject) => {
        calls.push({ input, resolve, reject });
      }),
  );
  return { load, calls };
}

const flush = () => act(() => Promise.resolve());

describe('useSourcePhoto', () => {
  it('loads nothing when there is no request', () => {
    const { load } = manualLoader();
    const { result } = renderHook(() => useSourcePhoto(null, load));
    expect(result.current).toEqual({ kind: 'loading' });
    expect(load).not.toHaveBeenCalled();
  });

  it('is loading, then ready with the photo', async () => {
    const { load, calls } = manualLoader();
    const { result } = renderHook(() => useSourcePhoto(request(), load));
    expect(result.current).toEqual({ kind: 'loading' });
    expect(calls[0]?.input).toEqual({
      blob: BLOB,
      fileName: 'a.jpg',
      expected: { width: 4000, height: 3000 },
    });
    const photo = photoOf();
    calls[0]?.resolve(photo);
    await flush();
    expect(result.current).toEqual({ kind: 'ready', photo });
    expect(photo.close).not.toHaveBeenCalled();
  });

  it('closes the photo when the editor goes away', async () => {
    const { load, calls } = manualLoader();
    const { unmount } = renderHook(() => useSourcePhoto(request(), load));
    const photo = photoOf();
    calls[0]?.resolve(photo);
    await flush();
    unmount();
    expect(photo.close).toHaveBeenCalledTimes(1);
  });

  it('closes a photo that arrives after the editor has gone, without showing it', async () => {
    const { load, calls } = manualLoader();
    const { unmount } = renderHook(() => useSourcePhoto(request(), load));
    unmount();
    const photo = photoOf();
    calls[0]?.resolve(photo);
    await flush();
    expect(photo.close).toHaveBeenCalledTimes(1);
  });

  it('ignores a failure that arrives after the editor has gone', async () => {
    const { load, calls } = manualLoader();
    const { result, unmount } = renderHook(() => useSourcePhoto(request(), load));
    unmount();
    calls[0]?.reject(new SourcePhotoError('Too late.'));
    await flush();
    expect(result.current).toEqual({ kind: 'loading' });
  });

  it('closes the old photo and loads the new one when the photo changes', async () => {
    const { load, calls } = manualLoader();
    const { result, rerender } = renderHook(({ id }) => useSourcePhoto(request(id), load), {
      initialProps: { id: 'a' },
    });
    const first = photoOf();
    calls[0]?.resolve(first);
    await flush();
    rerender({ id: 'b' });
    expect(result.current).toEqual({ kind: 'loading' });
    expect(first.close).toHaveBeenCalledTimes(1);
    const second = photoOf();
    calls[1]?.resolve(second);
    await flush();
    expect(result.current).toEqual({ kind: 'ready', photo: second });
    expect(second.close).not.toHaveBeenCalled();
  });

  it('does not load again while the same photo stays open', async () => {
    const { load, calls } = manualLoader();
    const { rerender } = renderHook(() => useSourcePhoto(request(), load));
    calls[0]?.resolve(photoOf());
    await flush();
    rerender();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('gives the reason a photo could not be opened', async () => {
    const { load, calls } = manualLoader();
    const { result } = renderHook(() => useSourcePhoto(request(), load));
    calls[0]?.reject(new SourcePhotoError('"a.jpg" could not be opened.'));
    await flush();
    expect(result.current).toEqual({ kind: 'failed', message: '"a.jpg" could not be opened.' });
  });

  it('gives a plain message for a failure it does not recognise', async () => {
    const { load, calls } = manualLoader();
    const { result } = renderHook(() => useSourcePhoto(request(), load));
    calls[0]?.reject(new Error('internal detail'));
    await flush();
    expect(result.current).toEqual({ kind: 'failed', message: unexpectedPhotoMessage('a.jpg') });
  });

  it('says so when the original file is missing, and does not try to load it', async () => {
    const { load } = manualLoader();
    const { result } = renderHook(() => useSourcePhoto(request('a', { blob: undefined }), load));
    await flush();
    expect(result.current).toEqual({ kind: 'failed', message: missingPhotoMessage('a.jpg') });
    expect(load).not.toHaveBeenCalled();
  });

  it('stops showing a photo when the request is taken away', async () => {
    const { load, calls } = manualLoader();
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useSourcePhoto(on ? request() : null, load),
      { initialProps: { on: true } },
    );
    const photo = photoOf();
    calls[0]?.resolve(photo);
    await flush();
    rerender({ on: false });
    expect(result.current).toEqual({ kind: 'loading' });
    expect(photo.close).toHaveBeenCalledTimes(1);
  });
});
