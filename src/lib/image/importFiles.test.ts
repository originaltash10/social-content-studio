import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '../../types';
import { ImageDecodeError, damagedMessage, heicMessage, inspectImage } from './decode';
import { sha256Hex } from './hash';
import { importFile, importFiles } from './importFiles';
import type { FileProgress, ImportOutcome, KnownAssets } from './importFiles';

// Decoding needs a real browser; everything else (type detection, hashing) runs for real.
vi.mock('./decode', async (original) => ({
  ...(await original<typeof import('./decode')>()),
  inspectImage: vi.fn(),
}));

const text = (value: string) => [...value].map((char) => char.charCodeAt(0));
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEIC = [0, 0, 0, 24, ...text('ftypheic'), 0, 0, 0, 0, ...text('mif1heic')];
const MP4 = [0, 0, 0, 24, ...text('ftypisom'), 0, 0, 0, 0, ...text('isommp42')];

/** A file with a recognisable start and `body` after it, so different bodies hash differently. */
function file(name: string, start: number[], body = name, type = ''): File {
  return new File([new Uint8Array([...start, ...text(body)])], name, { type });
}

const idOf = async (f: File) => sha256Hex(await f.arrayBuffer());
const bytesOf = async (blob: Blob) => [...new Uint8Array(await blob.arrayBuffer())];

const THUMBNAIL = new Blob(['thumb'], { type: 'image/webp' });
const NOTHING: KnownAssets = { assets: [], missingAssetIds: [] };

function asset(id: string, fileName: string): Asset {
  return { id, kind: 'image', fileName, width: 10, height: 20, focal: { x: 0.2, y: 0.8 } };
}

beforeEach(() => {
  vi.mocked(inspectImage).mockResolvedValue({ width: 4032, height: 3024, thumbnail: THUMBNAIL });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('importFile: a new photo', () => {
  it('becomes an Asset as SPEC.md defines it', async () => {
    const photo = file('site.jpg', JPEG);

    const outcome = await importFile(photo, NOTHING);

    expect(outcome).toEqual({
      status: 'imported',
      asset: {
        id: await idOf(photo),
        kind: 'image',
        fileName: 'site.jpg',
        width: 4032,
        height: 3024,
        focal: { x: 0.5, y: 0.5 },
      },
      blob: expect.any(Blob) as Blob,
      thumbnail: THUMBNAIL,
      message: 'Imported, 4032 x 3024 pixels.',
    });
    expect(outcome).not.toHaveProperty('note');
  });

  it('uses the sha256 of the original bytes as the id', async () => {
    const outcome = await importFile(new File([new Uint8Array(JPEG)], 'tiny.jpg'), NOTHING);
    // sha256 of the four bytes FF D8 FF E0, worked out independently with Node's crypto module.
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(new Uint8Array(JPEG)).digest('hex');
    expect(outcome).toMatchObject({ status: 'imported', asset: { id: expected } });
  });

  it('keeps the original bytes and type unchanged, HEIC included', async () => {
    const photo = file('IMG_0001.HEIC', HEIC, 'pretend hevc data', 'image/heic');

    const outcome = await importFile(photo, NOTHING);

    if (outcome.status !== 'imported') throw new Error('expected an import');
    expect(await bytesOf(outcome.blob)).toEqual(await bytesOf(photo));
    expect(outcome.blob.type).toBe('image/heic');
    expect(await sha256Hex(await outcome.blob.arrayBuffer())).toBe(outcome.asset.id);
  });

  it('reports the displayed size, so a portrait photo is portrait', async () => {
    vi.mocked(inspectImage).mockResolvedValue({ width: 3024, height: 4032, thumbnail: null });
    const outcome = await importFile(file('portrait.jpg', JPEG), NOTHING);
    expect(outcome).toMatchObject({
      status: 'imported',
      asset: { width: 3024, height: 4032 },
      thumbnail: null,
      message: 'Imported, 3024 x 4032 pixels.',
    });
  });

  it('decodes as what the contents are and passes on the note when the name disagrees', async () => {
    const decoder = vi.fn();
    const photo = file('IMG_2.jpg', HEIC);

    const outcome = await importFile(photo, NOTHING, decoder);

    expect(inspectImage).toHaveBeenCalledWith(expect.any(Blob), 'heic', 'IMG_2.jpg', decoder);
    expect(outcome).toMatchObject({
      status: 'imported',
      asset: { fileName: 'IMG_2.jpg' },
      note:
        '"IMG_2.jpg" is named .jpg but is really a HEIC photo. ' +
        'It is imported as HEIC; the file name is left as it is.',
    });
  });
});

describe('importFile: duplicates and missing files', () => {
  it('skips a file the session already has, without decoding it', async () => {
    const photo = file('copy of site.jpg', JPEG, 'same bytes');
    const existing = asset(await idOf(photo), 'site.jpg');

    const outcome = await importFile(photo, { assets: [existing], missingAssetIds: [] });

    expect(outcome).toEqual({
      status: 'duplicate',
      asset: existing,
      message: 'Already imported as "site.jpg".',
    });
    expect(inspectImage).not.toHaveBeenCalled();
  });

  it('imports a file with the same name but different contents', async () => {
    const photo = file('site.jpg', JPEG, 'new version');
    const other = asset('f'.repeat(64), 'site.jpg');
    const outcome = await importFile(photo, { assets: [other], missingAssetIds: [] });
    expect(outcome.status).toBe('imported');
  });

  it('restores the file of an asset the session lists as missing, keeping the existing asset', async () => {
    const photo = file('renamed.jpg', JPEG, 'same bytes');
    const id = await idOf(photo);
    const existing = asset(id, 'site.jpg');

    const outcome = await importFile(photo, { assets: [existing], missingAssetIds: [id] });

    expect(outcome).toEqual({
      status: 'restored',
      asset: existing,
      blob: expect.any(Blob) as Blob,
      thumbnail: THUMBNAIL,
      message: 'This is the missing file for "site.jpg". It has been restored.',
    });
    if (outcome.status !== 'restored') throw new Error('expected a restore');
    expect(await bytesOf(outcome.blob)).toEqual(await bytesOf(photo));
  });

  it('ignores a missing id that belongs to no asset', async () => {
    const photo = file('site.jpg', JPEG);
    const outcome = await importFile(photo, { assets: [], missingAssetIds: [await idOf(photo)] });
    expect(outcome.status).toBe('imported');
  });
});

describe('importFile: files that are not imported', () => {
  it('rejects a video with the later-phase message, without reading the whole file', async () => {
    const clip = file('clip.mp4', MP4);
    const read = vi.spyOn(clip, 'arrayBuffer');

    const outcome = await importFile(clip, NOTHING);

    expect(outcome).toEqual({
      status: 'failed',
      reason: 'video',
      message:
        '"clip.mp4" is a video, so it was not imported. Video support arrives in a later ' +
        'phase; for now only JPG, PNG and HEIC photos can be imported.',
    });
    expect(read).not.toHaveBeenCalled();
    expect(inspectImage).not.toHaveBeenCalled();
  });

  it.each([
    ['notes.txt', text('hello'), 'unsupported', 'Convert it to JPG or PNG first.'],
    ['empty.jpg', [], 'empty', 'is empty (0 bytes)'],
    ['broken.png', text('not a png'), 'damaged', 'named like a PNG photo'],
  ])('rejects %s as %s', async (name, bytes, reason, wording) => {
    const outcome = await importFile(new File([new Uint8Array(bytes)], name), NOTHING);
    expect(outcome).toMatchObject({ status: 'failed', reason });
    expect(outcome.message).toContain(wording);
  });

  it('passes on the damaged-file message when a JPG cannot be decoded', async () => {
    const message = damagedMessage('cut-off.jpg', 'jpeg');
    vi.mocked(inspectImage).mockRejectedValue(new ImageDecodeError('damaged', message));
    await expect(importFile(file('cut-off.jpg', JPEG), NOTHING)).resolves.toEqual({
      status: 'failed',
      reason: 'damaged',
      message,
    });
  });

  it('passes on the convert-first message when a HEIC cannot be decoded', async () => {
    const message = heicMessage('IMG_9.heic');
    vi.mocked(inspectImage).mockRejectedValue(new ImageDecodeError('heic', message));
    await expect(importFile(file('IMG_9.heic', HEIC), NOTHING)).resolves.toEqual({
      status: 'failed',
      reason: 'heic',
      message:
        '"IMG_9.heic" is a HEIC photo that could not be opened in this browser. ' +
        'Convert it to JPG or PNG first, then import that copy.',
    });
  });

  it('does not restore a missing asset from a file that cannot be decoded', async () => {
    const photo = file('site.jpg', JPEG);
    const id = await idOf(photo);
    vi.mocked(inspectImage).mockRejectedValue(
      new ImageDecodeError('damaged', damagedMessage('site.jpg', 'jpeg')),
    );
    const outcome = await importFile(photo, {
      assets: [asset(id, 'site.jpg')],
      missingAssetIds: [id],
    });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'damaged' });
  });

  const UNREADABLE =
    '"gone.jpg" could not be read. It may have been moved, renamed or deleted, or it is on a ' +
    'drive that is no longer connected. Find the file again and try once more.';

  it('explains when the file cannot be read at all', async () => {
    const gone = file('gone.jpg', JPEG);
    vi.spyOn(gone, 'slice').mockImplementation(() => {
      throw new DOMException('The requested file could not be found.', 'NotFoundError');
    });
    await expect(importFile(gone, NOTHING)).resolves.toEqual({
      status: 'failed',
      reason: 'unreadable',
      message: UNREADABLE,
    });
  });

  it('explains when the file disappears after its first bytes were read', async () => {
    const gone = file('gone.jpg', JPEG);
    vi.spyOn(gone, 'arrayBuffer').mockRejectedValue(new DOMException('gone', 'NotReadableError'));
    await expect(importFile(gone, NOTHING)).resolves.toEqual({
      status: 'failed',
      reason: 'unreadable',
      message: UNREADABLE,
    });
  });

  it('turns any other error into a plain message instead of failing', async () => {
    vi.mocked(inspectImage).mockRejectedValue(new RangeError('Array buffer allocation failed'));
    await expect(importFile(file('huge.png', PNG), NOTHING)).resolves.toEqual({
      status: 'failed',
      reason: 'unexpected',
      message:
        '"huge.png" could not be imported because something unexpected went wrong. Try again; ' +
        'if it keeps happening, convert the file to JPG or PNG first.',
    });
  });
});

describe('importFiles: a batch', () => {
  /** A caller that adds each result to its session as it arrives, as the panel does. */
  function session(initial: KnownAssets = NOTHING) {
    const assets = [...initial.assets];
    let missingAssetIds = [...initial.missingAssetIds];
    const log: [number, FileProgress][] = [];
    return {
      assets,
      log,
      known: () => ({ assets, missingAssetIds }),
      onProgress: (index: number, progress: FileProgress) => {
        log.push([index, progress]);
        if (progress.state !== 'done') return;
        if (progress.outcome.status === 'imported') assets.push(progress.outcome.asset);
        if (progress.outcome.status === 'restored') {
          const { id } = progress.outcome.asset;
          missingAssetIds = missingAssetIds.filter((missing) => missing !== id);
        }
      },
    };
  }

  const statuses = (outcomes: ImportOutcome[]) => outcomes.map((outcome) => outcome.status);

  it('handles files one at a time, in order, reporting each as waiting, working, then done', async () => {
    const running: string[] = [];
    let overlap = false;
    vi.mocked(inspectImage).mockImplementation(async (_blob, _format, fileName) => {
      overlap ||= running.length > 0;
      running.push(fileName);
      await Promise.resolve();
      running.pop();
      return { width: 100, height: 50, thumbnail: null };
    });
    const target = session();

    const outcomes = await importFiles([file('a.jpg', JPEG), file('b.png', PNG)], target);

    expect(overlap).toBe(false);
    expect(statuses(outcomes)).toEqual(['imported', 'imported']);
    expect(
      target.log.map(([index, progress]) => `${index} ${progress.fileName} ${progress.state}`),
    ).toEqual([
      '0 a.jpg waiting',
      '1 b.png waiting',
      '0 a.jpg working',
      '0 a.jpg done',
      '1 b.png working',
      '1 b.png done',
    ]);
    expect(target.log.at(-1)?.[1]).toMatchObject({ state: 'done', outcome: outcomes[1] });
  });

  it('carries on after a file fails, and reports every file', async () => {
    const target = session();
    vi.mocked(inspectImage).mockImplementation((_blob, format, fileName) =>
      fileName === 'cut-off.jpg'
        ? Promise.reject(new ImageDecodeError('damaged', damagedMessage(fileName, format)))
        : Promise.resolve({ width: 800, height: 600, thumbnail: THUMBNAIL }),
    );

    const outcomes = await importFiles(
      [
        file('first.jpg', JPEG),
        file('clip.mp4', MP4),
        file('cut-off.jpg', JPEG),
        file('notes.txt', text('hi')),
        file('last.png', PNG),
      ],
      target,
    );

    expect(statuses(outcomes)).toEqual(['imported', 'failed', 'failed', 'failed', 'imported']);
    expect(outcomes.map((o) => (o.status === 'failed' ? o.reason : '-'))).toEqual([
      '-',
      'video',
      'damaged',
      'unsupported',
      '-',
    ]);
    expect(target.assets.map((a) => a.fileName)).toEqual(['first.jpg', 'last.png']);
  });

  it('adds a file dropped twice in one batch only once', async () => {
    const target = session();
    const outcomes = await importFiles(
      [file('site.jpg', JPEG, 'same'), file('site copy.jpg', JPEG, 'same')],
      target,
    );
    expect(statuses(outcomes)).toEqual(['imported', 'duplicate']);
    expect(outcomes[1]?.message).toBe('Already imported as "site.jpg".');
    expect(target.assets).toHaveLength(1);
  });

  it('catches a repeat within the batch even if the caller has not added the first one', async () => {
    const outcomes = await importFiles(
      [file('site.jpg', JPEG, 'same'), file('again.jpg', JPEG, 'same')],
      { known: () => NOTHING },
    );
    expect(statuses(outcomes)).toEqual(['imported', 'duplicate']);
    expect(outcomes[1]?.message).toBe('Already imported as "site.jpg".');
  });

  it('skips files already in the session and restores a missing one', async () => {
    const have = file('have.jpg', JPEG, 'have');
    const lost = file('lost.png', PNG, 'lost');
    const lostId = await idOf(lost);
    const target = session({
      assets: [asset(await idOf(have), 'have.jpg'), asset(lostId, 'lost.png')],
      missingAssetIds: [lostId],
    });

    const outcomes = await importFiles([have, lost, lost, file('new.jpg', JPEG)], target);

    // The second drop of the restored file is an ordinary duplicate.
    expect(statuses(outcomes)).toEqual(['duplicate', 'restored', 'duplicate', 'imported']);
    expect(target.assets.map((a) => a.fileName)).toEqual(['have.jpg', 'lost.png', 'new.jpg']);
  });

  it('passes the HEIC decoder through and works without a progress callback', async () => {
    const heicDecoder = vi.fn();
    const outcomes = await importFiles([file('IMG_1.heic', HEIC)], {
      known: () => NOTHING,
      heicDecoder,
    });
    expect(statuses(outcomes)).toEqual(['imported']);
    expect(inspectImage).toHaveBeenCalledWith(expect.any(Blob), 'heic', 'IMG_1.heic', heicDecoder);
  });

  it('does nothing for an empty batch', async () => {
    const onProgress = vi.fn();
    await expect(importFiles([], { known: () => NOTHING, onProgress })).resolves.toEqual([]);
    expect(onProgress).not.toHaveBeenCalled();
  });
});
