import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderJob } from '../render/protocol';
import type { Card } from '../../types';
import { makeAsset, makeCard } from '../../test/fixtures';
import { resultFor } from '../../test/fakeRenderClient';
import { DHT, DQT, EOI, ICC, SCAN, SOF0, SOI, exif, jfif, join } from '../../test/imageBytes';
import { MockDir, domError } from '../../test/mockFs';
import { captionsCsv } from './captionsCsv';
import type { ExportSession } from './eligibility';
import { findMetadata } from './metadata';
import { exportPath } from './names';
import { runExport } from './runExport';
import type { ExportDeps } from './runExport';
import { ZIP_TOO_LARGE, folderSink, splitPath, writeFailure, zipSink } from './sinks';

const BYTES = new Uint8Array([1, 2, 3, 4]);
const BOM_BYTES = [0xef, 0xbb, 0xbf];
const utf8 = (text: string): number[] => Array.from(new TextEncoder().encode(text));

/** A file in a zip, read as bytes; fails the test if it is not there. */
async function entry(zip: JSZip, path: string): Promise<Uint8Array> {
  const file = zip.file(path);
  if (!file) throw new Error(`no ${path} in the zip`);
  return file.async('uint8array');
}

/** captions.csv in a folder's exports/, as bytes (Blob.text() would drop the byte order mark). */
async function csvIn(dir: MockDir): Promise<number[]> {
  return bytesOf(dir.dirs.get('exports')?.files.get('captions.csv') as Blob);
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('splitPath', () => {
  it('splits "{platform}/{file name}"', () => {
    expect(splitPath('instagram/Topping-out_instagram_feed-vertical_a1.jpg')).toEqual({
      folder: 'instagram',
      name: 'Topping-out_instagram_feed-vertical_a1.jpg',
    });
  });

  it.each([
    'x.jpg',
    'a/b/c.jpg',
    '../x.jpg',
    'instagram/..',
    'instagram/.',
    './x.jpg',
    '/x.jpg',
    'instagram/',
    'instagram/a b.jpg',
    'instagram/a\\b.jpg',
    'instagram/a:b.jpg',
  ])('refuses %j, which could write somewhere else', (path) => {
    expect(() => splitPath(path)).toThrow(`"${path}" is not a place an export can write to.`);
  });
});

describe('writeFailure', () => {
  it.each([
    ['QuotaExceededError', 'There is not enough space on the disk.'],
    ['NotAllowedError', 'Permission to write to the session folder was withdrawn.'],
    ['SecurityError', 'Permission to write to the session folder was withdrawn.'],
    ['NotFoundError', 'The session folder was moved or deleted.'],
    ['NoModificationAllowedError', 'The file is open in another program. Close it and try again.'],
    ['InvalidModificationError', 'The file is open in another program. Close it and try again.'],
  ])('puts %s in plain words', (name, message) => {
    expect(writeFailure(domError(name, 'technical text'))).toBe(message);
  });

  it('passes any other reason on as it is', () => {
    expect(writeFailure(new Error('Something else.'))).toBe('Something else.');
    expect(writeFailure('a string')).toBe('a string');
  });
});

describe('folderSink', () => {
  let dir: MockDir;
  beforeEach(() => {
    dir = new MockDir('Topping out');
  });

  it('writes each file into exports/{platform}/ and captions.csv into exports/', async () => {
    const sink = folderSink(dir.handle);
    expect(sink.keepsPartial).toBe(true);
    await sink.write('instagram/a.jpg', BYTES);
    await sink.write('linkedin/b.png', BYTES);
    await sink.finish('﻿"file"\r\n');
    const exportsDir = dir.dirs.get('exports') as MockDir;
    expect(await bytesOf(exportsDir.dirs.get('instagram')?.files.get('a.jpg') as Blob)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(exportsDir.dirs.get('linkedin')?.files.has('b.png')).toBe(true);
    const csv = exportsDir.files.get('captions.csv') as Blob;
    expect((await bytesOf(csv)).slice(0, 3)).toEqual(BOM_BYTES);
    expect(csv.type).toBe('text/csv;charset=utf-8');
    expect(dir.log).toEqual([
      'mkdir exports',
      'mkdir exports/instagram',
      'write exports/instagram/a.jpg',
      'mkdir exports/linkedin',
      'write exports/linkedin/b.png',
      'write exports/captions.csv',
    ]);
  });

  it('never deletes anything: earlier files stay, and a file of the same name is replaced', async () => {
    const exportsDir = dir.seedDir('exports');
    exportsDir.seedDir('instagram').seed('old.jpg', 'earlier export').seed('a.jpg', 'old a');
    exportsDir.seed('captions.csv', 'old csv');
    dir.seed('session.json', '{}');
    const sink = folderSink(dir.handle);
    await sink.write('instagram/a.jpg', BYTES);
    await sink.finish('new csv');
    sink.abandon();
    const instagram = exportsDir.dirs.get('instagram') as MockDir;
    expect(await instagram.text('old.jpg')).toBe('earlier export');
    expect(await bytesOf(instagram.files.get('a.jpg') as Blob)).toEqual([1, 2, 3, 4]);
    expect(await exportsDir.text('captions.csv')).toBe('new csv');
    expect(await dir.text('session.json')).toBe('{}');
    expect(dir.log.some((entry) => entry.startsWith('remove'))).toBe(false);
  });

  it('touches nothing for a path outside exports/', async () => {
    const sink = folderSink(dir.handle);
    await expect(sink.write('../session.json', BYTES)).rejects.toThrow('is not a place');
    expect(dir.log).toEqual([]);
  });

  it('gives a failed write a plain reason and drops the half-written file', async () => {
    dir.shared.beforeClose = () => {
      throw domError('QuotaExceededError');
    };
    const sink = folderSink(dir.handle);
    await expect(sink.write('instagram/a.jpg', BYTES)).rejects.toThrow(
      'There is not enough space on the disk.',
    );
    expect(dir.log).toContain('abort exports/instagram/a.jpg');
    expect(dir.dirs.get('exports')?.dirs.get('instagram')?.files.has('a.jpg')).toBe(false);
  });

  it('reports a folder that cannot be opened', async () => {
    dir.shared.beforeLookup = () => {
      throw domError('NotFoundError');
    };
    await expect(folderSink(dir.handle).write('instagram/a.jpg', BYTES)).rejects.toThrow(
      'The session folder was moved or deleted.',
    );
  });

  it('keeps the first reason when the half-written file cannot be dropped either', async () => {
    const writable = {
      write: vi.fn().mockRejectedValue(domError('NotAllowedError')),
      close: vi.fn(),
      abort: vi.fn().mockRejectedValue(new Error('abort failed')),
    };
    const folder = {
      getDirectoryHandle: vi.fn(async () => folder),
      getFileHandle: vi.fn(async () => ({ createWritable: async () => writable })),
    };
    const sink = folderSink(folder as unknown as FileSystemDirectoryHandle);
    await expect(sink.write('instagram/a.jpg', BYTES)).rejects.toThrow(
      'Permission to write to the session folder was withdrawn.',
    );
    expect(writable.abort).toHaveBeenCalled();
    expect(writable.close).not.toHaveBeenCalled();
  });

  it('names captions.csv when it cannot be written', async () => {
    dir.shared.beforeWrite = () => {
      throw domError('NoModificationAllowedError');
    };
    await expect(folderSink(dir.handle).finish('csv')).rejects.toThrow(
      'Could not write captions.csv: The file is open in another program. Close it and try again.',
    );
  });
});

describe('zipSink', () => {
  it('downloads one zip at the end, laid out like exports/, files stored as they are', async () => {
    const download = vi.fn();
    const sink = zipSink('Topping out: phase 2', download);
    expect(sink.keepsPartial).toBe(false);
    await sink.write('instagram/a.jpg', BYTES);
    await sink.write('linkedin/b.png', new Uint8Array([9, 8]));
    expect(download).not.toHaveBeenCalled();
    await sink.finish('﻿"file"\r\n');

    expect(download).toHaveBeenCalledTimes(1);
    const [blob, name] = download.mock.calls[0] as [Blob, string];
    expect(name).toBe('Topping-out-phase-2_export.zip');
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual([
      'captions.csv',
      'instagram/',
      'instagram/a.jpg',
      'linkedin/',
      'linkedin/b.png',
    ]);
    expect(Array.from(await entry(zip, 'instagram/a.jpg'))).toEqual([1, 2, 3, 4]);
    const csv = await entry(zip, 'captions.csv');
    expect(Array.from(csv.subarray(0, 3))).toEqual(BOM_BYTES);
    // Stored, not compressed: JPG and PNG are already compressed.
    expect(blob.size).toBeGreaterThan(BYTES.length);
  });

  it('says plainly when a file cannot be added for lack of memory', async () => {
    vi.spyOn(JSZip.prototype, 'file').mockImplementation(() => {
      throw new RangeError('Array buffer allocation failed');
    });
    await expect(zipSink('s', vi.fn()).write('instagram/a.jpg', BYTES)).rejects.toThrow(
      ZIP_TOO_LARGE,
    );
  });

  it('refuses a path outside the zip layout', async () => {
    await expect(zipSink('s', vi.fn()).write('../x.jpg', BYTES)).rejects.toThrow('is not a place');
  });

  it('lets the files go and downloads nothing when abandoned', async () => {
    const download = vi.fn();
    const sink = zipSink('s', download);
    await sink.write('instagram/a.jpg', BYTES);
    sink.abandon();
    await expect(sink.write('instagram/b.jpg', BYTES)).rejects.toThrow('already ended');
    await expect(sink.finish('csv')).rejects.toThrow('already ended');
    expect(download).not.toHaveBeenCalled();
  });

  it('can only be finished once', async () => {
    const download = vi.fn();
    const sink = zipSink('s', download);
    await sink.finish('csv');
    await expect(sink.finish('csv')).rejects.toThrow('already ended');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('says plainly when the zip is too large for browser memory', async () => {
    vi.spyOn(JSZip.prototype, 'generateAsync').mockRejectedValue(
      new RangeError('Array buffer allocation failed'),
    );
    const download = vi.fn();
    await expect(zipSink('s', download).finish('csv')).rejects.toThrow(ZIP_TOO_LARGE);
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    ['NotReadableError', domError('NotReadableError')],
    ['an out-of-memory message', new Error('Out of memory')],
    ['an invalid length message', new Error('Invalid string length')],
  ])('recognises %s as running out of memory', async (_, error) => {
    vi.spyOn(JSZip.prototype, 'generateAsync').mockRejectedValue(error);
    await expect(zipSink('s', vi.fn()).finish('csv')).rejects.toThrow(ZIP_TOO_LARGE);
  });

  it('passes on any other reason the zip could not be built', async () => {
    vi.spyOn(JSZip.prototype, 'generateAsync').mockRejectedValue(new Error('Bad data.'));
    await expect(zipSink('s', vi.fn()).finish('csv')).rejects.toThrow(
      'Could not build the zip: Bad data.',
    );
  });

  it('uses the browser download by default', () => {
    expect(zipSink('s').keepsPartial).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A whole export through the real sinks
// ---------------------------------------------------------------------------

describe('an export through the real sinks', () => {
  const PHOTO = makeAsset();
  const FEED = makeCard({ id: 'feed' });
  const SQUARE = makeCard({ id: 'square', platform: 'linkedin', placement: 'image-square' });
  const ENCODED = join(SOI, jfif(), exif('II'), ICC, DQT, SOF0, DHT, SCAN, EOI);
  let state: ExportSession | null;

  const pathOf = (card: Card) =>
    exportPath({
      sessionName: 'Topping out',
      platform: card.platform,
      placement: card.placement,
      cardId: card.id,
      format: 'jpg',
    });

  function deps(
    sink: ExportDeps['sink'],
    extra: Partial<ExportDeps> & { onRender?: (job: RenderJob) => void } = {},
  ): ExportDeps {
    return {
      client: {
        render: async (job) => {
          extra.onRender?.(job);
          return resultFor(job, { blob: new Blob([ENCODED]) });
        },
        cancel: () => false,
      },
      current: () => state,
      blobOf: () => new Blob(['photo']),
      sniff: async () => ({ kind: 'image', format: 'jpeg' }),
      sink,
      ...extra,
    };
  }

  beforeEach(() => {
    state = {
      id: 's1',
      name: 'Topping out',
      cards: [FEED, SQUARE],
      assets: [PHOTO],
      missingAssetIds: [],
    };
  });

  async function filesIn(dir: MockDir): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    const exportsDir = dir.dirs.get('exports');
    for (const [platform, sub] of exportsDir?.dirs ?? []) {
      for (const [name, blob] of sub.files) out.set(`${platform}/${name}`, await bytesOf(blob));
    }
    return out;
  }

  it('fills the folder with clean files and a matching captions.csv', async () => {
    const dir = new MockDir();
    const report = await runExport(deps(folderSink(dir.handle)));
    expect(report.outcome).toBe('complete');
    const files = await filesIn(dir);
    expect([...files.keys()]).toEqual([pathOf(FEED), pathOf(SQUARE)]);
    for (const bytes of files.values()) expect(findMetadata(new Uint8Array(bytes))).toEqual([]);
    expect(await csvIn(dir)).toEqual(
      utf8(
        captionsCsv([
          { path: pathOf(FEED), card: FEED, result: 'pass' },
          { path: pathOf(SQUARE), card: SQUARE, result: 'pass' },
        ]),
      ),
    );
  });

  it('on cancel leaves a folder whose captions.csv lists exactly the files in it', async () => {
    const dir = new MockDir();
    const controller = new AbortController();
    const report = await runExport(
      deps(folderSink(dir.handle), {
        signal: controller.signal,
        onRender: (job) => {
          if (job.id === 'export-2') controller.abort();
        },
      }),
    );
    expect(report.outcome).toBe('cancelled');
    expect([...(await filesIn(dir)).keys()]).toEqual([pathOf(FEED)]);
    expect(await csvIn(dir)).toEqual(
      utf8(captionsCsv([{ path: pathOf(FEED), card: FEED, result: 'pass' }])),
    );
  });

  it('on a write error leaves a folder whose captions.csv lists exactly the files in it', async () => {
    const dir = new MockDir();
    dir.shared.beforeClose = (path) => {
      if (path.startsWith('exports/linkedin/')) throw domError('QuotaExceededError');
    };
    const report = await runExport(deps(folderSink(dir.handle)));
    expect(report.outcome).toBe('write-error');
    expect(report.error).toBe(
      `Could not write "${pathOf(SQUARE)}": There is not enough space on the disk.`,
    );
    expect([...(await filesIn(dir)).keys()]).toEqual([pathOf(FEED)]);
    expect(await csvIn(dir)).toEqual(
      utf8(captionsCsv([{ path: pathOf(FEED), card: FEED, result: 'pass' }])),
    );
  });

  it('when the session closes writes nothing more to the folder, not even captions.csv', async () => {
    const dir = new MockDir();
    const report = await runExport(
      deps(folderSink(dir.handle), {
        onRender: (job) => {
          if (job.id === 'export-2') state = null;
        },
      }),
    );
    expect(report.outcome).toBe('session-closed');
    expect([...(await filesIn(dir)).keys()]).toEqual([pathOf(FEED)]);
    expect(dir.dirs.get('exports')?.files.has('captions.csv')).toBe(false);
  });

  it('downloads a zip with clean files and a matching captions.csv', async () => {
    const download = vi.fn();
    const report = await runExport(deps(zipSink('Topping out', download)));
    expect(report).toMatchObject({ outcome: 'complete', finished: true });
    const [blob] = download.mock.calls[0] as [Blob];
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    for (const path of [pathOf(FEED), pathOf(SQUARE)]) {
      expect(findMetadata(await entry(zip, path))).toEqual([]);
    }
    expect(Array.from(await entry(zip, 'captions.csv'))).toEqual(
      utf8(
        captionsCsv([
          { path: pathOf(FEED), card: FEED, result: 'pass' },
          { path: pathOf(SQUARE), card: SQUARE, result: 'pass' },
        ]),
      ),
    );
  });

  it('downloads nothing when a zip export is cancelled', async () => {
    const download = vi.fn();
    const controller = new AbortController();
    const report = await runExport(
      deps(zipSink('Topping out', download), {
        signal: controller.signal,
        onRender: (job) => {
          if (job.id === 'export-2') controller.abort();
        },
      }),
    );
    expect(report.outcome).toBe('cancelled');
    expect(download).not.toHaveBeenCalled();
  });
});
