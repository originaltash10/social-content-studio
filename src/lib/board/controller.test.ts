import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlacement } from '../platforms';
import { planRender } from '../render/plan';
import type { RenderJob, RenderProgress, RenderResult } from '../render/protocol';
import { RenderError, cancelledError } from '../render/protocol';
import type { Asset, Card, ImageEdit, PlacementSpec, ValidationResult } from '../../types';
import { makeAsset, makeCard } from '../../test/fixtures';
import {
  NOT_SINGLE_IMAGE_MESSAGE,
  NO_PHOTO_MESSAGE,
  createRenderController,
  missingFileMessage,
  progressLabel,
  progressPercent,
  unknownPlacementMessage,
} from './controller';
import type { BoardSession, CardRender, ControllerDeps, RenderController } from './controller';
import { renderedValidation } from './renderValidation';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Call = {
  job: RenderJob;
  onProgress: (progress: RenderProgress) => void;
  resolve: (result: RenderResult) => void;
  reject: (error: unknown) => void;
};

/** A worker client whose jobs finish only when the test says so. */
function fakeClient() {
  const calls: Call[] = [];
  const cancelled: string[] = [];
  return {
    calls,
    cancelled,
    render: vi.fn(
      (job: RenderJob, onProgress: (progress: RenderProgress) => void = () => undefined) =>
        new Promise<RenderResult>((resolve, reject) => {
          calls.push({ job, onProgress, resolve, reject });
        }),
    ),
    cancel: vi.fn((id: string) => {
      cancelled.push(id);
      return true;
    }),
  };
}

/** Object URLs that are recorded instead of made. */
function fakeUrls() {
  const made: string[] = [];
  const revoked: string[] = [];
  return {
    made,
    revoked,
    /** URLs made and not yet revoked. */
    live: () => made.filter((url) => !revoked.includes(url)),
    api: {
      create: vi.fn(() => {
        const url = `blob:render-${made.length + 1}`;
        made.push(url);
        return url;
      }),
      revoke: vi.fn((url: string) => {
        revoked.push(url);
      }),
    },
  };
}

const spec = (platform: Card['platform'], placement: string): PlacementSpec => {
  const found = getPlacement(platform, placement);
  if (!found) throw new Error(`no placement ${platform} ${placement}`);
  return found;
};
const FEED = spec('instagram', 'feed-vertical');
const SQUARE = spec('linkedin', 'image-square');
const target = (s: PlacementSpec) => s.sizes[0] as { width: number; height: number };

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const photo = () => new Blob([JPEG], { type: 'image/jpeg' });

const ASSET: Asset = makeAsset({ width: 4032, height: 3024, focal: { x: 0.5, y: 0.5 } });

function card(id: string, s: PlacementSpec = FEED, overrides: Partial<Card> = {}): Card {
  return makeCard({
    id,
    assetIds: [ASSET.id],
    platform: s.platform,
    placement: s.placement,
    edit: { crop: { x: 0, y: 0, width: 1, height: 1 }, overlays: [], format: 'jpg', quality: 0.9 },
    copy: { caption: '', firstComment: '', hashtags: [], altText: 'A crane.' },
    // What a card holds before its file is checked: different from any rendered result here.
    validation: { level: 'warn', issues: [{ rule: 8, level: 'warn', message: 'Planned only.' }] },
    ...overrides,
  });
}

function session(cards: Card[], overrides: Partial<BoardSession> = {}): BoardSession {
  return { id: 'session-1', cards, assets: [ASSET], missingAssetIds: [], ...overrides };
}

/** A finished file at the job's planned size. */
function resultFor(job: RenderJob, overrides: Partial<RenderResult> = {}): RenderResult {
  return {
    id: job.id,
    blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    width: job.plan.target.width,
    height: job.plan.target.height,
    bytes: 400_000,
    mimeType: 'image/jpeg',
    format: 'jpg',
    upscaled: job.plan.upscaled,
    ...overrides,
  };
}

/** Lets pending promises (the file-type check, a finished render) run. */
const settle = () => new Promise((done) => setTimeout(done, 0));

let client: ReturnType<typeof fakeClient>;
let urls: ReturnType<typeof fakeUrls>;
let writes: [string, ValidationResult][];
let blobs: Map<string, Blob>;
let controller: RenderController;

function make(overrides: Partial<ControllerDeps> = {}): RenderController {
  return createRenderController({
    client,
    blobOf: (id) => blobs.get(id),
    writeResult: (id, result) => writes.push([id, result]),
    urls: urls.api,
    ...overrides,
  });
}

const renderOf = (id: string): CardRender | undefined => controller.snapshot().get(id);
const call = (index: number): Call => {
  const found = client.calls[index];
  if (!found) throw new Error(`no render call ${index}`);
  return found;
};

beforeEach(() => {
  client = fakeClient();
  urls = fakeUrls();
  writes = [];
  blobs = new Map([[ASSET.id, photo()]]);
  controller = make();
});

afterEach(() => {
  controller.dispose();
});

// ---------------------------------------------------------------------------

describe('rendering a card', () => {
  it('sends one job with the planned crop and the file type read from the photo', async () => {
    const c = card('c1');
    controller.sync(session([c]));
    expect(renderOf('c1')).toEqual({ kind: 'waiting' });
    await settle();
    expect(client.render).toHaveBeenCalledTimes(1);
    const { job } = call(0);
    expect(job.fileName).toBe(ASSET.fileName);
    expect(job.sourceFormat).toBe('jpeg');
    expect(job.blob).toBe(blobs.get(ASSET.id));
    expect(job.plan).toEqual(planRender({ asset: ASSET, spec: FEED, edit: c.edit as ImageEdit }));
    expect(job.plan.target).toEqual(target(FEED));
  });

  it('shows each stage of the render as it happens', async () => {
    controller.sync(session([card('c1')]));
    await settle();
    const { onProgress } = call(0);
    onProgress('queued');
    expect(renderOf('c1')).toEqual({ kind: 'waiting' });
    onProgress('decoding');
    expect(renderOf('c1')).toEqual({ kind: 'working', stage: 'decoding' });
    onProgress('drawing');
    expect(renderOf('c1')).toEqual({ kind: 'working', stage: 'drawing' });
    onProgress('encoding');
    expect(renderOf('c1')).toEqual({ kind: 'working', stage: 'encoding' });
    // The end of a job is reported by its promise, not by these events.
    onProgress('done');
    onProgress('failed');
    expect(renderOf('c1')).toEqual({ kind: 'working', stage: 'encoding' });
  });

  it('keeps the finished file, gives it a URL, and records the validation result', async () => {
    const c = card('c1');
    controller.sync(session([c]));
    await settle();
    const { job, resolve } = call(0);
    const result = resultFor(job, { upscaled: true });
    resolve(result);
    await settle();
    expect(renderOf('c1')).toEqual({
      kind: 'done',
      url: 'blob:render-1',
      width: target(FEED).width,
      height: target(FEED).height,
      bytes: 400_000,
      format: 'jpg',
      upscaled: true,
    });
    expect(urls.api.create).toHaveBeenCalledWith(result.blob);
    const expected = renderedValidation(c, ASSET, FEED, job.plan, result);
    expect(writes).toEqual([['c1', expected]]);
  });

  it('records nothing when the result is the one the card already has', async () => {
    const c = card('c1');
    controller.sync(session([c]));
    await settle();
    const { job } = call(0);
    const result = resultFor(job);
    const same = renderedValidation(c, ASSET, FEED, job.plan, result);
    controller.sync(session([{ ...c, validation: same }]));
    call(0).resolve(result);
    await settle();
    expect(renderOf('c1')?.kind).toBe('done');
    expect(writes).toEqual([]);
  });

  it('records a failing result for a file of the wrong size', async () => {
    controller.sync(session([card('c1')]));
    await settle();
    const { job, resolve } = call(0);
    resolve(resultFor(job, { width: 1000, height: 1000 }));
    await settle();
    expect(writes[0]?.[1].level).toBe('fail');
    expect(writes[0]?.[1].issues.map((issue) => issue.rule)).toContain(1);
  });

  it('sends every card at once and lets the worker queue them', async () => {
    controller.sync(session([card('c1'), card('c2', SQUARE)]));
    await settle();
    expect(client.calls.map((c) => c.job.plan.target)).toEqual([target(FEED), target(SQUARE)]);
    expect(new Set(client.calls.map((c) => c.job.id)).size).toBe(2);
  });

  it('does not render a card again when nothing it is made from has changed', async () => {
    const c = card('c1');
    controller.sync(session([c]));
    await settle();
    controller.sync(session([{ ...c, copy: { ...c.copy, caption: 'New words' } }]));
    await settle();
    expect(client.render).toHaveBeenCalledTimes(1);
  });

  it('checks a finished card again when its words change, without rendering it again', async () => {
    const c = card('c1');
    controller.sync(session([c]));
    await settle();
    call(0).resolve(resultFor(call(0).job));
    await settle();
    writes.length = 0;
    const withLink = { ...c, copy: { ...c.copy, caption: 'See https://example.com' } };
    controller.sync(session([withLink]));
    expect(client.render).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1].issues.map((issue) => issue.rule)).toContain(9);
  });

  it('checks a finished card again after undo restored an older result', async () => {
    const c = card('c1');
    controller.sync(session([c]));
    await settle();
    call(0).resolve(resultFor(call(0).job));
    await settle();
    const fresh = writes[0]?.[1] as ValidationResult;
    writes.length = 0;
    // The store now holds `fresh`; an undo puts the card back with its earlier result.
    controller.sync(session([{ ...c, validation: fresh }]));
    expect(writes).toEqual([]);
    controller.sync(session([{ ...c, validation: { level: 'fail', issues: [] } }]));
    expect(writes).toEqual([['c1', fresh]]);
  });

  it('renders again when the crop changes, and releases the old file', async () => {
    const c = card('c1');
    controller.sync(session([c]));
    await settle();
    call(0).resolve(resultFor(call(0).job));
    await settle();
    expect(urls.live()).toEqual(['blob:render-1']);
    const cropped = { ...c, edit: { ...c.edit, crop: { x: 0, y: 0, width: 0.5, height: 1 } } };
    controller.sync(session([cropped]));
    expect(urls.revoked).toEqual(['blob:render-1']);
    expect(renderOf('c1')).toEqual({ kind: 'waiting' });
    await settle();
    expect(client.render).toHaveBeenCalledTimes(2);
    call(1).resolve(resultFor(call(1).job));
    await settle();
    expect(urls.live()).toEqual(['blob:render-2']);
  });
});

describe('cards that cannot be rendered', () => {
  it('says the original file is missing when it is listed as missing', async () => {
    controller.sync(session([card('c1')], { missingAssetIds: [ASSET.id] }));
    await settle();
    expect(renderOf('c1')).toEqual({ kind: 'failed', message: missingFileMessage(ASSET.fileName) });
    expect(client.render).not.toHaveBeenCalled();
  });

  it('says the original file is missing when it is not in memory', () => {
    blobs.clear();
    controller.sync(session([card('c1')]));
    expect(renderOf('c1')).toEqual({ kind: 'failed', message: missingFileMessage(ASSET.fileName) });
  });

  it('renders once the missing file is supplied', async () => {
    controller.sync(session([card('c1')], { missingAssetIds: [ASSET.id] }));
    controller.sync(session([card('c1')]));
    await settle();
    expect(client.render).toHaveBeenCalledTimes(1);
  });

  it("says so when the card's photo is not in the session", () => {
    controller.sync(session([card('c1')], { assets: [] }));
    expect(renderOf('c1')).toEqual({ kind: 'failed', message: NO_PHOTO_MESSAGE });
  });

  it('says so when the placement is no longer in the platform data', () => {
    controller.sync(session([card('c1', FEED, { placement: 'gone' })]));
    expect(renderOf('c1')).toEqual({
      kind: 'failed',
      message: unknownPlacementMessage('instagram', 'gone'),
    });
  });

  it('says so for a card that is not a single photo', () => {
    const carousel = card('c1', FEED, { edit: { slides: [], coverIndex: 0 } });
    const twoPhotos = card('c2', FEED, { assetIds: [ASSET.id, ASSET.id] });
    controller.sync(session([carousel, twoPhotos]));
    expect(renderOf('c1')).toEqual({ kind: 'failed', message: NOT_SINGLE_IMAGE_MESSAGE });
    expect(renderOf('c2')).toEqual({ kind: 'failed', message: NOT_SINGLE_IMAGE_MESSAGE });
  });

  it('passes on the plan message for a photo too large to process', () => {
    const huge = { ...ASSET, width: 20_000, height: 20_000 };
    controller.sync(session([card('c1')], { assets: [huge] }));
    const render = renderOf('c1');
    expect(render?.kind).toBe('failed');
    expect(render?.kind === 'failed' && render.message).toMatch(/too large to process/);
  });

  it('says something went wrong when planning fails unexpectedly', () => {
    const broken = createRenderController({
      client,
      blobOf: (id) => blobs.get(id),
      writeResult: () => undefined,
      urls: urls.api,
      specOf: () => ({ ...FEED, mediaTypes: ['image'], sizes: null as unknown as [] }),
    });
    broken.sync(session([card('c1')]));
    const render = broken.snapshot().get('c1');
    expect(render?.kind === 'failed' && render.message).toMatch(/something unexpected went wrong/);
    broken.dispose();
  });

  it('passes on the message when the file is not a usable image', async () => {
    blobs.set(ASSET.id, new Blob(['not an image']));
    controller.sync(session([card('c1')]));
    await settle();
    const render = renderOf('c1');
    expect(render?.kind).toBe('failed');
    expect(client.render).not.toHaveBeenCalled();
  });

  it('says something went wrong when the file cannot be read', async () => {
    controller.dispose();
    controller = make({ sniff: () => Promise.reject(new Error('read failed')) });
    controller.sync(session([card('c1')]));
    await settle();
    const render = renderOf('c1');
    expect(render?.kind === 'failed' && render.message).toMatch(/something unexpected went wrong/);
  });

  it("passes on the worker's message when a render fails", async () => {
    controller.sync(session([card('c1')]));
    await settle();
    call(0).reject(new RenderError('canvas', 'The browser may be short of memory.'));
    await settle();
    expect(renderOf('c1')).toEqual({
      kind: 'failed',
      message: 'The browser may be short of memory.',
    });
    expect(writes).toEqual([]);
  });

  it('says something went wrong for an error that is not a render error', async () => {
    controller.sync(session([card('c1')]));
    await settle();
    call(0).reject(new Error('boom'));
    await settle();
    const render = renderOf('c1');
    expect(render?.kind === 'failed' && render.message).toMatch(/something unexpected went wrong/);
  });
});

describe('cancel', () => {
  it('cancels a waiting render and tells the worker', async () => {
    controller.sync(session([card('c1')]));
    await settle();
    const jobId = call(0).job.id;
    expect(controller.cancel('c1')).toBe(true);
    expect(client.cancelled).toEqual([jobId]);
    expect(renderOf('c1')).toEqual({ kind: 'cancelled' });
  });

  it('cancels before the job has even been sent', async () => {
    controller.sync(session([card('c1')]));
    expect(controller.cancel('c1')).toBe(true);
    await settle();
    expect(client.render).not.toHaveBeenCalled();
    expect(renderOf('c1')).toEqual({ kind: 'cancelled' });
  });

  it('cancels a render under way', async () => {
    controller.sync(session([card('c1')]));
    await settle();
    call(0).onProgress('drawing');
    expect(controller.cancel('c1')).toBe(true);
    expect(renderOf('c1')).toEqual({ kind: 'cancelled' });
  });

  it("shows cancelled when the worker reports a cancel the board didn't ask for", async () => {
    controller.sync(session([card('c1')]));
    await settle();
    call(0).reject(cancelledError(ASSET.fileName));
    await settle();
    expect(renderOf('c1')).toEqual({ kind: 'cancelled' });
  });

  it('returns false for a card that is not rendering or not known', async () => {
    expect(controller.cancel('nope')).toBe(false);
    controller.sync(session([card('c1')], { missingAssetIds: [ASSET.id] }));
    expect(controller.cancel('c1')).toBe(false);
    controller.sync(session([card('c2')]));
    await settle();
    call(0).resolve(resultFor(call(0).job));
    await settle();
    expect(controller.cancel('c2')).toBe(false);
  });

  it('cancels every pending render and leaves finished ones alone', async () => {
    controller.sync(session([card('c1'), card('c2', SQUARE), card('c3')]));
    await settle();
    call(0).resolve(resultFor(call(0).job));
    await settle();
    expect(controller.cancelAll()).toBe(2);
    expect(renderOf('c1')?.kind).toBe('done');
    expect(renderOf('c2')).toEqual({ kind: 'cancelled' });
    expect(renderOf('c3')).toEqual({ kind: 'cancelled' });
    expect(controller.cancelAll()).toBe(0);
  });

  it('a cancelled card stays cancelled until Render again', async () => {
    const c = card('c1');
    controller.sync(session([c]));
    await settle();
    controller.cancel('c1');
    controller.sync(session([c]));
    await settle();
    expect(client.render).toHaveBeenCalledTimes(1);
    controller.renderAgain('c1');
    expect(renderOf('c1')).toEqual({ kind: 'waiting' });
    await settle();
    expect(client.render).toHaveBeenCalledTimes(2);
    call(1).resolve(resultFor(call(1).job));
    await settle();
    expect(renderOf('c1')?.kind).toBe('done');
  });

  it('Render again replaces a finished file and cancels a pending one', async () => {
    controller.sync(session([card('c1')]));
    await settle();
    call(0).resolve(resultFor(call(0).job));
    await settle();
    controller.renderAgain('c1');
    expect(urls.revoked).toEqual(['blob:render-1']);
    await settle();
    const pending = call(1).job.id;
    controller.renderAgain('c1');
    expect(client.cancelled).toEqual([pending]);
  });

  it('Render again does nothing for an unknown card', () => {
    controller.sync(session([card('c1')]));
    const before = controller.snapshot();
    controller.renderAgain('nope');
    expect(controller.snapshot()).toBe(before);
  });
});

describe('a finished file nobody wants any more is discarded', () => {
  /** Asserts the late file got no URL, no validation, and changed nothing on screen. */
  async function expectDiscarded(late: Call, cardId: string, before: CardRender | undefined) {
    const urlsBefore = urls.made.length;
    late.resolve(resultFor(late.job));
    await settle();
    expect(writes.filter(([id]) => id === cardId)).toEqual([]);
    expect(urls.made).toHaveLength(urlsBefore);
    expect(renderOf(cardId)).toEqual(before);
  }

  it("when it arrives after the card's plan changed", async () => {
    const c = card('c1');
    controller.sync(session([c]));
    await settle();
    const late = call(0);
    const cropped = { ...c, edit: { ...c.edit, crop: { x: 0.2, y: 0, width: 0.5, height: 1 } } };
    controller.sync(session([cropped]));
    expect(client.cancelled).toEqual([late.job.id]);
    await expectDiscarded(late, 'c1', { kind: 'waiting' });
    // Its progress is ignored too.
    late.onProgress('encoding');
    expect(renderOf('c1')).toEqual({ kind: 'waiting' });
    // The new render is the one that counts.
    await settle();
    call(1).resolve(resultFor(call(1).job));
    await settle();
    expect(writes.map(([id]) => id)).toEqual(['c1']);
    expect(urls.live()).toEqual(['blob:render-1']);
  });

  it('when it arrives after the card was removed', async () => {
    controller.sync(session([card('c1'), card('c2', SQUARE)]));
    await settle();
    const late = call(0);
    controller.sync(session([card('c2', SQUARE)]));
    expect(client.cancelled).toEqual([late.job.id]);
    expect(renderOf('c1')).toBeUndefined();
    await expectDiscarded(late, 'c1', undefined);
  });

  it('when it arrives after another session was opened', async () => {
    controller.sync(session([card('c1')]));
    await settle();
    const late = call(0);
    controller.sync(session([card('c1')], { id: 'session-2' }));
    expect(client.cancelled).toEqual([late.job.id]);
    await settle();
    // The same card id in the new session is rendered afresh, not with the old file.
    expect(client.render).toHaveBeenCalledTimes(2);
    await expectDiscarded(late, 'c1', { kind: 'waiting' });
  });

  it('when it arrives after the session was closed', async () => {
    controller.sync(session([card('c1')]));
    await settle();
    const late = call(0);
    controller.sync(session([], { id: null, assets: [] }));
    await expectDiscarded(late, 'c1', undefined);
  });

  it('when it fails after it stopped being wanted', async () => {
    controller.sync(session([card('c1')]));
    await settle();
    const late = call(0);
    controller.sync(session([]));
    late.reject(new RenderError('canvas', 'late failure'));
    await settle();
    expect(renderOf('c1')).toBeUndefined();
  });

  it('when the file type check finishes after it stopped being wanted', async () => {
    controller.sync(session([card('c1')]));
    controller.sync(session([]));
    await settle();
    expect(client.render).not.toHaveBeenCalled();
    expect(renderOf('c1')).toBeUndefined();
  });

  it('when it arrives after the controller was disposed', async () => {
    controller.sync(session([card('c1')]));
    await settle();
    const late = call(0);
    controller.dispose();
    await expectDiscarded(late, 'c1', undefined);
  });
});

describe('object URLs', () => {
  async function finishAll() {
    await settle();
    for (const c of client.calls) c.resolve(resultFor(c.job));
    await settle();
  }

  it('are revoked when a render is replaced', async () => {
    controller.sync(session([card('c1')]));
    await finishAll();
    controller.renderAgain('c1');
    await settle();
    call(1).resolve(resultFor(call(1).job));
    await settle();
    expect(urls.made).toEqual(['blob:render-1', 'blob:render-2']);
    expect(urls.live()).toEqual(['blob:render-2']);
  });

  it('are revoked when their card goes away', async () => {
    controller.sync(session([card('c1'), card('c2', SQUARE)]));
    await finishAll();
    controller.sync(session([card('c2', SQUARE)]));
    expect(urls.live()).toEqual(['blob:render-2']);
  });

  it('are all revoked when the session closes', async () => {
    controller.sync(session([card('c1'), card('c2', SQUARE)]));
    await finishAll();
    controller.sync(session([], { id: null, assets: [] }));
    expect(urls.made).toHaveLength(2);
    expect(urls.live()).toEqual([]);
    expect(controller.snapshot().size).toBe(0);
  });

  it('are all revoked when another session is opened', async () => {
    controller.sync(session([card('c1')]));
    await finishAll();
    controller.sync(session([], { id: 'session-2' }));
    expect(urls.live()).toEqual([]);
  });

  it('are all revoked on dispose, and nothing happens afterwards', async () => {
    controller.sync(session([card('c1'), card('c2', SQUARE)]));
    await finishAll();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.dispose();
    expect(urls.live()).toEqual([]);
    expect(controller.snapshot().size).toBe(0);
    listener.mockClear();
    controller.sync(session([card('c3')]));
    controller.renderAgain('c1');
    controller.dispose();
    await settle();
    expect(listener).not.toHaveBeenCalled();
    expect(client.render).toHaveBeenCalledTimes(2);
  });

  it('uses the browser functions by default', async () => {
    const create = vi.fn(() => 'blob:browser');
    const revoke = vi.fn();
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    const real = createRenderController({
      client,
      blobOf: (id) => blobs.get(id),
      writeResult: () => undefined,
    });
    real.sync(session([card('c1')]));
    await settle();
    call(0).resolve(resultFor(call(0).job));
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    real.dispose();
    expect(revoke).toHaveBeenCalledWith('blob:browser');
  });
});

describe('listeners', () => {
  it('hear every change and can stop listening', async () => {
    const listener = vi.fn();
    const stop = controller.subscribe(listener);
    controller.sync(session([card('c1')]));
    expect(listener).toHaveBeenCalledTimes(1);
    const first = controller.snapshot();
    await settle();
    call(0).onProgress('decoding');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).not.toBe(first);
    stop();
    call(0).onProgress('drawing');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('progress', () => {
  it('maps each state to a percentage', () => {
    expect(progressPercent(undefined)).toBe(0);
    expect(progressPercent({ kind: 'waiting' })).toBe(0);
    expect(progressPercent({ kind: 'working', stage: 'decoding' })).toBe(25);
    expect(progressPercent({ kind: 'working', stage: 'drawing' })).toBe(60);
    expect(progressPercent({ kind: 'working', stage: 'encoding' })).toBe(85);
    expect(progressPercent({ kind: 'cancelled' })).toBe(0);
    expect(
      progressPercent({
        kind: 'done',
        url: 'u',
        width: 1,
        height: 1,
        bytes: 1,
        format: 'jpg',
        upscaled: false,
      }),
    ).toBe(100);
  });

  it('describes each step in words', () => {
    expect(progressLabel({ kind: 'waiting' })).toBe('Waiting to render');
    expect(progressLabel({ kind: 'working', stage: 'decoding' })).toBe('Opening the photo');
    expect(progressLabel({ kind: 'working', stage: 'drawing' })).toBe('Cropping and resizing');
    expect(progressLabel({ kind: 'working', stage: 'encoding' })).toBe('Saving the file');
    expect(progressLabel({ kind: 'cancelled' })).toBe('');
    expect(progressLabel(undefined)).toBe('');
  });
});
