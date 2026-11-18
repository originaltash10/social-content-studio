import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlacement } from '../platforms';
import { RenderError, unexpectedError } from '../render/protocol';
import type { RenderJob, RenderResult } from '../render/protocol';
import type { FileType } from '../image/fileType';
import type { Card, ImageEdit } from '../../types';
import { makeAsset, makeCard, makeImageEdit } from '../../test/fixtures';
import { fakeRenderClient, resultFor } from '../../test/fakeRenderClient';
import {
  DHT,
  DQT,
  EOI,
  ICC,
  SCAN,
  SOF0,
  SOI,
  cleanPngParts,
  exif,
  jfif,
  join,
} from '../../test/imageBytes';
import { captionsCsv } from './captionsCsv';
import type { ExportSession } from './eligibility';
import { findMetadata } from './metadata';
import { exportPath } from './names';
import { CHANGED_MESSAGE, NO_SESSION_MESSAGE, REMOVED_MESSAGE, runExport } from './runExport';
import type { ExportDeps, ExportProgress, ExportSink } from './runExport';

// ---------------------------------------------------------------------------- test set-up

const PHOTO = makeAsset();
const PHOTO_BLOB = new Blob(['original photo']);

/** What the fake encoder returns: a JPG with an ICC profile and GPS, as a real browser might. */
const ENCODED = join(SOI, jfif(), exif('II'), ICC, DQT, SOF0, DHT, SCAN, EOI);
const CLEAN = join(SOI, jfif(), DQT, SOF0, DHT, SCAN, EOI);

const FEED = makeCard({ id: 'feed', placement: 'feed-vertical' });
const SQUARE = makeCard({ id: 'square', platform: 'linkedin', placement: 'image-square' });

let state: ExportSession | null;

function session(cards: Card[], overrides: Partial<ExportSession> = {}): ExportSession {
  return {
    id: 's1',
    name: 'Topping out',
    cards,
    assets: [PHOTO],
    missingAssetIds: [],
    ...overrides,
  };
}

/** Replaces one card in the open session, as an edit in the store would. */
function edit(cardId: string, change: (card: Card) => Card) {
  const current = state as ExportSession;
  state = { ...current, cards: current.cards.map((c) => (c.id === cardId ? change(c) : c)) };
}

function encoded(job: RenderJob, overrides: Partial<RenderResult> = {}): RenderResult {
  return resultFor(job, { blob: new Blob([ENCODED], { type: 'image/jpeg' }), ...overrides });
}

/** A client that answers each job at once, through `answer`. */
function autoClient(answer: (job: RenderJob) => RenderResult | Error = (job) => encoded(job)) {
  return {
    render: vi.fn(async (job: RenderJob) => {
      const outcome = answer(job);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
    cancel: vi.fn(() => false),
  };
}

function fakeSink(keepsPartial = true) {
  const files = new Map<string, Uint8Array>();
  const sink = {
    keepsPartial,
    files,
    csv: null as string | null,
    write: vi.fn(async (path: string, bytes: Uint8Array) => {
      files.set(path, bytes);
    }),
    finish: vi.fn(async (csv: string) => {
      sink.csv = csv;
    }),
    abandon: vi.fn(),
  };
  return sink;
}

const jpegType: FileType = { kind: 'image', format: 'jpeg' };

function deps(
  overrides: Partial<ExportDeps> = {},
): ExportDeps & { sink: ReturnType<typeof fakeSink> } {
  return {
    client: autoClient(),
    current: () => state,
    blobOf: (id) => (id === PHOTO.id ? PHOTO_BLOB : undefined),
    sniff: async () => jpegType,
    sink: fakeSink(),
    ...overrides,
  } as ExportDeps & { sink: ReturnType<typeof fakeSink> };
}

const pathOf = (card: Card, format: 'jpg' | 'png' = 'jpg') =>
  exportPath({
    sessionName: 'Topping out',
    platform: card.platform,
    placement: card.placement,
    cardId: card.id,
    format,
  });

beforeEach(() => {
  state = session([FEED, SQUARE]);
});

// ---------------------------------------------------------------------------- tests

describe('a complete export', () => {
  it('writes every card, stripped of hidden information, then captions.csv', async () => {
    const run = deps();
    const report = await runExport(run);

    expect(report).toMatchObject({ outcome: 'complete', total: 2, finished: true, error: null });
    expect(report.skipped).toEqual([]);
    expect(report.exported.map((f) => [f.cardId, f.path, f.result])).toEqual([
      ['feed', pathOf(FEED), 'pass'],
      ['square', pathOf(SQUARE), 'pass'],
    ]);
    expect(findMetadata(ENCODED)).not.toEqual([]);
    for (const bytes of run.sink.files.values()) {
      expect(bytes).toEqual(CLEAN);
      expect(findMetadata(bytes)).toEqual([]);
    }
    expect(run.sink.finish).toHaveBeenCalledTimes(1);
    expect(run.sink.csv).toBe(
      captionsCsv([
        { path: pathOf(FEED), card: FEED, result: 'pass' },
        { path: pathOf(SQUARE), card: SQUARE, result: 'pass' },
      ]),
    );
    expect(run.sink.abandon).not.toHaveBeenCalled();
  });

  it('renders each card at its own placement size from platforms.json, one at a time', async () => {
    const client = fakeRenderClient();
    const run = deps({ client });
    const done = runExport(run);
    await client.sent(1);
    expect(client.calls).toHaveLength(1);
    const first = client.calls[0]?.job as RenderJob;
    expect(first.plan.target).toEqual(getPlacement('instagram', 'feed-vertical')?.sizes[0]);
    expect(first.blob).toBe(PHOTO_BLOB);
    expect(first.sourceFormat).toBe('jpeg');
    client.calls[0]?.resolve(encoded(first));
    await client.sent(2);
    const second = client.calls[1]?.job as RenderJob;
    expect(second.plan.target).toEqual(getPlacement('linkedin', 'image-square')?.sizes[0]);
    expect(second.id).not.toBe(first.id);
    client.calls[1]?.resolve(encoded(second));
    expect((await done).outcome).toBe('complete');
  });

  it('exports Warning cards, with their warnings in the report', async () => {
    const warned = makeCard({ id: 'warned', copy: { ...FEED.copy, altText: '' } });
    state = session([warned]);
    const report = await runExport(deps());
    expect(report.exported[0]).toMatchObject({ cardId: 'warned', result: 'warn' });
    expect(report.exported[0]?.issues.map((i) => i.rule)).toEqual([8]);
  });

  it('takes the file extension from the format the encoder made', async () => {
    const png = makeCard({ id: 'png', edit: makeImageEdit({ format: 'png' }) });
    state = session([png]);
    const pngBytes = join(...cleanPngParts());
    const run = deps({
      client: autoClient((job) =>
        encoded(job, { blob: new Blob([pngBytes]), format: 'png', mimeType: 'image/png' }),
      ),
    });
    const report = await runExport(run);
    expect(report.exported[0]?.path).toBe(pathOf(png, 'png'));
    expect(run.sink.files.get(pathOf(png, 'png'))).toEqual(pngBytes);
  });

  it('reports progress card by card, then once more when finished', async () => {
    const seen: ExportProgress[] = [];
    await runExport(deps({ onProgress: (p) => seen.push(p) }));
    expect(seen).toEqual([
      { done: 0, total: 2, cardId: 'feed' },
      { done: 1, total: 2, cardId: 'square' },
      { done: 2, total: 2, cardId: null },
    ]);
  });

  it('exports every card in the session, with no filters', async () => {
    const cards = ['a', 'b', 'c', 'd', 'e'].map((id) => makeCard({ id }));
    state = session(cards);
    const report = await runExport(deps());
    expect(report.total).toBe(5);
    expect(report.exported).toHaveLength(5);
  });
});

describe('cards that fail their checks', () => {
  const wrongSize = (job: RenderJob) => encoded(job, { width: job.plan.target.width - 10 });

  it('are skipped without the override, with the first reason', async () => {
    state = session([FEED]);
    const run = deps({ client: autoClient(wrongSize) });
    const report = await runExport(run);
    expect(report.exported).toEqual([]);
    expect(report.skipped).toEqual([
      { cardId: 'feed', reason: 'fails-checks', message: expect.stringContaining('1070') },
    ]);
    expect(run.sink.write).not.toHaveBeenCalled();
  });

  it('are exported with the override, marked as such in the report and captions.csv', async () => {
    const overridden = { ...FEED, overrideFail: true };
    state = session([overridden]);
    const run = deps({ client: autoClient(wrongSize) });
    const report = await runExport(run);
    expect(report.exported[0]).toMatchObject({ result: 'override' });
    expect(report.exported[0]?.issues.some((i) => i.level === 'fail')).toBe(true);
    expect(run.sink.csv).toContain('"Fail, exported with override"');
  });

  it('use the override as it is when the file is checked, not when the run started', async () => {
    state = session([FEED]);
    const client = autoClient((job) => {
      edit('feed', (card) => ({ ...card, overrideFail: true }));
      return wrongSize(job);
    });
    const report = await runExport(deps({ client }));
    expect(report.exported[0]?.result).toBe('override');
  });

  it('leave nothing to hand over when no card can be exported', async () => {
    state = session([FEED]);
    const run = deps({ client: autoClient(wrongSize) });
    const report = await runExport(run);
    expect(report).toMatchObject({ outcome: 'complete', finished: false });
    expect(run.sink.finish).not.toHaveBeenCalled();
    expect(run.sink.abandon).toHaveBeenCalledTimes(1);
  });
});

describe('cards whose file cannot be made', () => {
  it('are skipped with the board message when the card cannot be rendered', async () => {
    const carousel = makeCard({
      id: 'carousel',
      edit: { slides: [], coverIndex: 0 },
    });
    state = session([carousel, FEED], { missingAssetIds: [] });
    const report = await runExport(deps({ blobOf: () => undefined }));
    expect(report.skipped.map((s) => [s.cardId, s.reason])).toEqual([
      ['carousel', 'cannot-export'],
      ['feed', 'cannot-export'],
    ]);
    expect(report.skipped[1]?.message).toContain('is missing');
  });

  it('are skipped when the original is not a usable image', async () => {
    state = session([FEED]);
    const report = await runExport(
      deps({
        sniff: async () => ({ kind: 'rejected', reason: 'damaged', message: 'Damaged photo.' }),
      }),
    );
    expect(report.skipped).toEqual([
      { cardId: 'feed', reason: 'cannot-export', message: 'Damaged photo.' },
    ]);
  });

  it('are skipped with the render error, or a plain message for anything unexpected', async () => {
    const client = autoClient((job) =>
      job.id === 'export-1' ? new RenderError('canvas', 'Out of memory.') : new Error('weird'),
    );
    const report = await runExport(deps({ client }));
    expect(report.skipped.map((s) => s.message)).toEqual([
      'Out of memory.',
      unexpectedError(PHOTO.fileName).message,
    ]);
    expect(report.outcome).toBe('complete');
  });

  it('are skipped when the encoded file cannot be checked for hidden information', async () => {
    const client = autoClient((job) =>
      job.id === 'export-1'
        ? encoded(job, { blob: new Blob(['not a jpeg']) })
        : encoded(job, {
            blob: { arrayBuffer: () => Promise.reject(new Error('gone')) } as unknown as Blob,
          }),
    );
    const run = deps({ client });
    const report = await runExport(run);
    expect(report.skipped.map((s) => s.message)).toEqual([
      expect.stringContaining('is not a valid JPG file'),
      unexpectedError(PHOTO.fileName).message,
    ]);
    expect(run.sink.write).not.toHaveBeenCalled();
  });

  it('are skipped if two files would end up with the same name', async () => {
    // Card ids that differ only in case, and an encoder that returned JPG for the PNG card.
    const lower = makeCard({ id: 'k', edit: makeImageEdit({ format: 'png' }) });
    const upper = makeCard({ id: 'K' });
    state = session([upper, lower]);
    const run = deps();
    const report = await runExport(run);
    expect(report.exported.map((f) => f.cardId)).toEqual(['K']);
    expect(report.skipped[0]).toMatchObject({ cardId: 'k', reason: 'cannot-export' });
    expect(report.skipped[0]?.message).toContain('Two cards would both be saved as');
  });
});

describe('nothing stale is exported', () => {
  it('skips a card whose crop changed while its file was being made', async () => {
    state = session([FEED, SQUARE]);
    const client = autoClient((job) => {
      if (job.id === 'export-1') {
        edit('feed', (card) => ({
          ...card,
          edit: { ...(card.edit as ImageEdit), crop: { x: 0, y: 0, width: 0.5, height: 0.5 } },
        }));
      }
      return encoded(job);
    });
    const run = deps({ client });
    const report = await runExport(run);
    expect(report.skipped).toEqual([
      { cardId: 'feed', reason: 'changed', message: CHANGED_MESSAGE },
    ]);
    expect(report.exported.map((f) => f.cardId)).toEqual(['square']);
    expect(run.sink.files.has(pathOf(FEED))).toBe(false);
  });

  it('skips a card whose photo file went missing while its file was being made', async () => {
    state = session([FEED]);
    const client = autoClient((job) => {
      state = { ...(state as ExportSession), missingAssetIds: [PHOTO.id] };
      return encoded(job);
    });
    const report = await runExport(deps({ client }));
    expect(report.skipped[0]).toMatchObject({ reason: 'changed', message: CHANGED_MESSAGE });
  });

  it('skips a card removed while its file was being made, or before its turn', async () => {
    state = session([FEED, SQUARE]);
    const client = autoClient((job) => {
      const current = state as ExportSession;
      state = { ...current, cards: [] };
      return encoded(job);
    });
    const report = await runExport(deps({ client }));
    expect(report.skipped).toEqual([
      { cardId: 'feed', reason: 'changed', message: REMOVED_MESSAGE },
      { cardId: 'square', reason: 'changed', message: REMOVED_MESSAGE },
    ]);
  });

  it('uses the caption as it is when the file is written', async () => {
    state = session([FEED]);
    const client = autoClient((job) => {
      edit('feed', (card) => ({ ...card, copy: { ...card.copy, caption: 'New words' } }));
      return encoded(job);
    });
    const run = deps({ client });
    await runExport(run);
    expect(run.sink.csv).toContain('"New words"');
  });
});

describe('two files with the same name', () => {
  it('stop the export before anything is rendered or written', async () => {
    state = session([makeCard({ id: 'A' }), makeCard({ id: 'a' })]);
    const run = deps();
    const report = await runExport(run);
    expect(report.outcome).toBe('failed');
    expect(report.error).toContain('Two cards would both be saved as');
    expect(run.client.render).not.toHaveBeenCalled();
    expect(run.sink.abandon).toHaveBeenCalledTimes(1);
    expect(run.sink.finish).not.toHaveBeenCalled();
  });
});

describe('cancelling', () => {
  it('before the first card writes nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = deps({ signal: controller.signal });
    const report = await runExport(run);
    expect(report).toMatchObject({ outcome: 'cancelled', exported: [], finished: false });
    expect(run.sink.write).not.toHaveBeenCalled();
    expect(run.sink.abandon).toHaveBeenCalledTimes(1);
  });

  it('cancels the file being made', async () => {
    const client = fakeRenderClient();
    const controller = new AbortController();
    const run = deps({ client, signal: controller.signal });
    const done = runExport(run);
    await client.sent(1);
    controller.abort();
    expect(client.cancel).toHaveBeenCalledWith('export-1');
    const report = await done;
    expect(report.outcome).toBe('cancelled');
    expect(run.sink.write).not.toHaveBeenCalled();
  });

  it('while the photo is being read stops before rendering', async () => {
    const controller = new AbortController();
    const run = deps({
      signal: controller.signal,
      sniff: async () => {
        controller.abort();
        return jpegType;
      },
    });
    const report = await runExport(run);
    expect(report.outcome).toBe('cancelled');
    expect(run.client.render).not.toHaveBeenCalled();
    expect(run.client.cancel).not.toHaveBeenCalled();
  });

  it('after a file is made but before it is written drops that file', async () => {
    const controller = new AbortController();
    const client = autoClient((job) => {
      controller.abort();
      return encoded(job);
    });
    const run = deps({ client, signal: controller.signal });
    const report = await runExport(run);
    expect(report.outcome).toBe('cancelled');
    expect(run.sink.write).not.toHaveBeenCalled();
  });

  it('in a folder writes captions.csv listing exactly the files already written', async () => {
    const controller = new AbortController();
    const client = autoClient((job) => {
      if (job.id === 'export-2') controller.abort();
      return encoded(job);
    });
    const run = deps({ client, signal: controller.signal });
    const report = await runExport(run);
    expect(report).toMatchObject({ outcome: 'cancelled', finished: true });
    expect([...run.sink.files.keys()]).toEqual([pathOf(FEED)]);
    expect(run.sink.csv).toBe(captionsCsv([{ path: pathOf(FEED), card: FEED, result: 'pass' }]));
  });

  it('of a zip hands nothing over, so nothing is downloaded', async () => {
    const controller = new AbortController();
    const client = autoClient((job) => {
      if (job.id === 'export-2') controller.abort();
      return encoded(job);
    });
    const run = deps({ client, signal: controller.signal, sink: fakeSink(false) });
    const report = await runExport(run);
    expect(report).toMatchObject({ outcome: 'cancelled', finished: false });
    expect(run.sink.finish).not.toHaveBeenCalled();
    expect(run.sink.abandon).toHaveBeenCalledTimes(1);
  });

  it('after the run has ended does nothing', async () => {
    const controller = new AbortController();
    const run = deps({ signal: controller.signal });
    await runExport(run);
    controller.abort();
    expect(run.client.cancel).not.toHaveBeenCalled();
  });
});

describe('a write that fails', () => {
  function failingSecondWrite(sink: ReturnType<typeof fakeSink>) {
    sink.write.mockImplementation(async (path, bytes) => {
      if (sink.files.size === 1) throw new Error('The disk is full.');
      sink.files.set(path, bytes);
    });
    return sink;
  }

  it('stops the export; a folder gets captions.csv for the files that were written', async () => {
    const sink = failingSecondWrite(fakeSink(true));
    const report = await runExport(deps({ sink }));
    expect(report).toMatchObject({
      outcome: 'write-error',
      finished: true,
      error: `Could not write "${pathOf(SQUARE)}": The disk is full.`,
    });
    expect(report.exported.map((f) => f.cardId)).toEqual(['feed']);
    expect(sink.csv).toBe(captionsCsv([{ path: pathOf(FEED), card: FEED, result: 'pass' }]));
  });

  it('stops a zip export with nothing handed over', async () => {
    const sink = failingSecondWrite(fakeSink(false));
    const report = await runExport(deps({ sink }));
    expect(report).toMatchObject({ outcome: 'write-error', finished: false });
    expect(sink.finish).not.toHaveBeenCalled();
    expect(sink.abandon).toHaveBeenCalledTimes(1);
  });

  it('adds to the error if captions.csv cannot be written either', async () => {
    const sink = failingSecondWrite(fakeSink(true));
    sink.finish.mockRejectedValue(new Error('captions.csv could not be written either.'));
    const report = await runExport(deps({ sink }));
    expect(report.finished).toBe(false);
    expect(report.error).toBe(
      `Could not write "${pathOf(SQUARE)}": The disk is full. captions.csv could not be written either.`,
    );
  });

  it('at the end (captions.csv, or building the zip) is reported', async () => {
    const sink: ExportSink = {
      ...fakeSink(false),
      finish: vi.fn().mockRejectedValue(new Error('Too large.')),
    };
    const report = await runExport(deps({ sink: sink as ReturnType<typeof fakeSink> }));
    expect(report).toMatchObject({ outcome: 'write-error', finished: false, error: 'Too large.' });
  });
});

describe('a session that closes or changes', () => {
  it('cannot be exported when none is open', async () => {
    state = null;
    const run = deps();
    const report = await runExport(run);
    expect(report).toMatchObject({
      outcome: 'session-closed',
      total: 0,
      error: NO_SESSION_MESSAGE,
    });
    expect(run.sink.abandon).toHaveBeenCalledTimes(1);
  });

  it('stops the run and hands nothing over, even with files already in a folder', async () => {
    const client = autoClient((job) => {
      if (job.id === 'export-2') state = session([FEED, SQUARE], { id: 'other' });
      return encoded(job);
    });
    const run = deps({ client });
    const report = await runExport(run);
    expect(report).toMatchObject({ outcome: 'session-closed', finished: false });
    expect([...run.sink.files.keys()]).toEqual([pathOf(FEED)]);
    expect(run.sink.finish).not.toHaveBeenCalled();
    expect(run.sink.abandon).toHaveBeenCalledTimes(1);
  });

  it('while a file is being made, which is then cancelled', async () => {
    const client = fakeRenderClient();
    const run = deps({ client });
    const done = runExport(run);
    await client.sent(1);
    state = null;
    client.calls[0]?.reject(new RenderError('cancelled', 'cancelled'));
    const report = await done;
    expect(report.outcome).toBe('session-closed');
    expect(run.sink.write).not.toHaveBeenCalled();
  });

  it('outranks a cancel', async () => {
    const controller = new AbortController();
    const client = autoClient((job) => {
      controller.abort();
      state = null;
      return encoded(job);
    });
    const report = await runExport(deps({ client, signal: controller.signal }));
    expect(report.outcome).toBe('session-closed');
  });

  it('after the last file was written still stops captions.csv', async () => {
    state = session([FEED]);
    const sink = fakeSink(true);
    sink.write.mockImplementation(async (path, bytes) => {
      sink.files.set(path, bytes);
      state = null;
    });
    const report = await runExport(deps({ sink }));
    expect(report.outcome).toBe('session-closed');
    expect(sink.finish).not.toHaveBeenCalled();
  });

  it('between cards stops before the next one', async () => {
    const sink = fakeSink(true);
    sink.write.mockImplementation(async (path, bytes) => {
      sink.files.set(path, bytes);
      state = session([FEED, SQUARE], { id: 'other' });
    });
    const run = deps({ sink });
    const report = await runExport(run);
    expect(report.outcome).toBe('session-closed');
    expect(run.client.render).toHaveBeenCalledTimes(1);
  });
});
