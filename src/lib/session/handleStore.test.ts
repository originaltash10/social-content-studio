import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { forgetFolder, recallFolder, rememberFolder } from './handleStore';

/**
 * A real directory handle can be stored in IndexedDB as it is. The test double is a plain
 * object, because fake-indexeddb can only clone plain data.
 */
const folder = (name: string) => ({ kind: 'directory', name }) as FileSystemDirectoryHandle;

describe('handleStore', () => {
  it('has nothing to recall at first', async () => {
    expect(await recallFolder()).toBeNull();
  });

  it('recalls the remembered folder, as a reload would', async () => {
    await rememberFolder(folder('MySession'));
    expect(await recallFolder()).toEqual({ kind: 'directory', name: 'MySession' });
  });

  it('keeps only the most recent folder', async () => {
    await rememberFolder(folder('First'));
    await rememberFolder(folder('Second'));
    expect((await recallFolder())?.name).toBe('Second');
  });

  it('forgets the folder', async () => {
    await rememberFolder(folder('MySession'));
    await forgetFolder();
    expect(await recallFolder()).toBeNull();
  });

  it('forgetting when nothing is remembered is harmless', async () => {
    await forgetFolder();
    await forgetFolder();
    expect(await recallFolder()).toBeNull();
  });
});
