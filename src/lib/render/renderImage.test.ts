import { makeAsset } from '../../test/fixtures';
import { platforms } from '../platforms';
import { isImagePlacement, planRender } from './plan';
import type { RenderPlan } from './plan';
import { RenderError } from './protocol';
import type { RenderJob, RenderStage } from './protocol';
import {
  JPG_BACKGROUND,
  browserDeps,
  createImageRenderer,
  supportsCropResize,
} from './renderImage';
import type { RenderCanvas, RenderDeps } from './renderImage';

const spec = platforms.placements.find(isImagePlacement);
if (!spec) throw new Error('platforms.json has no image placement');
const asset = makeAsset({ width: 4032, height: 3024, focal: { x: 0.5, y: 0.5 } });

type FakeBitmap = ImageBitmap & { close: ReturnType<typeof vi.fn> };

function fakeBitmap(width: number, height: number): FakeBitmap {
  return { width, height, close: vi.fn() } as unknown as FakeBitmap;
}

/** A canvas that records, in order, what was done to it. */
function fakeCanvas(width: number, height: number, encoded: Blob | Error, hasContext = true) {
  const calls: unknown[][] = [];
  const context = {
    set fillStyle(value: string) {
      calls.push(['fillStyle', value]);
    },
    set imageSmoothingEnabled(value: boolean) {
      calls.push(['imageSmoothingEnabled', value]);
    },
    set imageSmoothingQuality(value: string) {
      calls.push(['imageSmoothingQuality', value]);
    },
    fillRect: (...args: number[]) => calls.push(['fillRect', ...args]),
    drawImage: (...args: unknown[]) => calls.push(['drawImage', ...args]),
  };
  const convertToBlob = vi.fn((options?: ImageEncodeOptions) => {
    void options;
    return encoded instanceof Error ? Promise.reject(encoded) : Promise.resolve(encoded);
  });
  const canvas = {
    width,
    height,
    getContext: () => (hasContext ? context : null),
    convertToBlob,
  } as unknown as RenderCanvas;
  return { canvas, calls, convertToBlob };
}

type Setup = {
  /** Whether createImageBitmap reads the resize options, as a supporting browser does. */
  readsResizeOptions?: boolean;
  /** What a decode call returns, or throws. Called for real decodes only, not the probe. */
  decode?: (args: unknown[]) => ImageBitmap | Error;
  heic?: () => ImageBitmap | Error;
  encoded?: Blob | Error;
  hasContext?: boolean;
  canvasThrows?: boolean;
};

function setup(options: Setup = {}) {
  const {
    readsResizeOptions = true,
    decode = () => fakeBitmap(asset.width, asset.height),
    heic = () => fakeBitmap(asset.width, asset.height),
    encoded = new Blob(['jpeg bytes'], { type: 'image/jpeg' }),
    hasContext = true,
    canvasThrows = false,
  } = options;
  const decodeCalls: unknown[][] = [];
  const probeCalls: unknown[][] = [];
  const canvases: ReturnType<typeof fakeCanvas>[] = [];
  const probeBitmap = fakeBitmap(1, 1);

  const createImageBitmap = vi.fn((...args: unknown[]) => {
    const isProbe = args.length === 6 && !(args[0] instanceof Blob);
    if (isProbe) {
      probeCalls.push(args);
      if (readsResizeOptions) {
        const o = args[5] as ImageBitmapOptions;
        void [o.resizeWidth, o.resizeHeight, o.resizeQuality];
      }
      return Promise.resolve(probeBitmap);
    }
    decodeCalls.push(args);
    const result = decode(args);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const heicDecoder = vi.fn(() => {
    const result = heic();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const deps = {
    createImageBitmap,
    createCanvas: (width: number, height: number) => {
      // The 1 x 1 probe canvas is never drawn on; real canvases are recorded.
      if (width === 1 && height === 1) return fakeCanvas(1, 1, encoded).canvas;
      if (canvasThrows) throw new Error('RangeError: Out of memory');
      const made = fakeCanvas(width, height, encoded, hasContext);
      canvases.push(made);
      return made.canvas;
    },
    heicDecoder,
  } as unknown as RenderDeps;
  return { deps, decodeCalls, probeCalls, canvases, probeBitmap, heicDecoder };
}

function makeJob(overrides: Partial<RenderJob> = {}, edit: Partial<RenderPlan> = {}): RenderJob {
  return {
    id: 'job-1',
    blob: new Blob(['original bytes'], { type: 'image/jpeg' }),
    fileName: 'site.jpg',
    sourceFormat: 'jpeg',
    plan: { ...planRender({ asset, spec: spec as NonNullable<typeof spec> }), ...edit },
    ...overrides,
  };
}

const { target, crop } = makeJob().plan;
const targetBitmap = () => fakeBitmap(target.width, target.height);

async function failureOf(run: Promise<unknown>): Promise<RenderError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof RenderError) return error;
    throw new Error(`expected a RenderError, got ${String(error)}`, { cause: error });
  }
  throw new Error('expected the render to fail');
}

/** Nothing a user should ever read in a message. */
const JARGON = /error|exception|stack|undefined|null|bitmap|canvas|blob|NaN|\bat \w+\.|\n/i;

describe('supportsCropResize', () => {
  it('is true when createImageBitmap reads all three resize options', async () => {
    const { deps, probeCalls, probeBitmap } = setup();
    expect(supportsCropResize(deps)).toBe(true);
    expect(probeCalls).toHaveLength(1);
    await Promise.resolve();
    expect(probeBitmap.close).toHaveBeenCalledOnce();
  });

  it('is false when createImageBitmap ignores the options', () => {
    expect(supportsCropResize(setup({ readsResizeOptions: false }).deps)).toBe(false);
  });

  it('is false when only some options are read', () => {
    const { deps } = setup();
    deps.createImageBitmap = ((...args: unknown[]) => {
      void (args[5] as ImageBitmapOptions).resizeWidth;
      return Promise.resolve(fakeBitmap(1, 1));
    }) as unknown as typeof createImageBitmap;
    expect(supportsCropResize(deps)).toBe(false);
  });

  it('is false when the probe throws, and survives the probe being rejected', async () => {
    const { deps } = setup();
    deps.createImageBitmap = (() => {
      throw new TypeError('not supported');
    }) as unknown as typeof createImageBitmap;
    expect(supportsCropResize(deps)).toBe(false);

    const rejecting = setup().deps;
    rejecting.createImageBitmap = ((...args: unknown[]) => {
      const o = args[5] as ImageBitmapOptions;
      void [o.resizeWidth, o.resizeHeight, o.resizeQuality];
      return Promise.reject(new Error('no source'));
    }) as unknown as typeof createImageBitmap;
    expect(supportsCropResize(rejecting)).toBe(true);
    await Promise.resolve();
  });

  it('is false when a canvas cannot be made', () => {
    const { deps } = setup();
    deps.createCanvas = () => {
      throw new ReferenceError('OffscreenCanvas is not defined');
    };
    expect(supportsCropResize(deps)).toBe(false);
  });
});

describe('choosing the path', () => {
  it('crops and resizes in one step when the browser supports it', async () => {
    const piece = targetBitmap();
    const { deps, decodeCalls, canvases } = setup({ decode: () => piece });
    const job = makeJob();
    await createImageRenderer(deps)(job);

    expect(decodeCalls).toEqual([
      [
        job.blob,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        {
          imageOrientation: 'from-image',
          resizeWidth: target.width,
          resizeHeight: target.height,
          resizeQuality: 'high',
        },
      ],
    ]);
    // The bitmap is already the output size, so it is drawn whole, without scaling.
    expect(canvases[0]?.calls.at(-1)).toEqual([
      'drawImage',
      piece,
      0,
      0,
      target.width,
      target.height,
      0,
      0,
      target.width,
      target.height,
    ]);
  });

  it('decodes the whole photo and draws the crop when the browser lacks the options', async () => {
    const full = fakeBitmap(asset.width, asset.height);
    const { deps, decodeCalls, canvases } = setup({
      readsResizeOptions: false,
      decode: () => full,
    });
    const job = makeJob();
    await createImageRenderer(deps)(job);

    expect(decodeCalls).toEqual([[job.blob, { imageOrientation: 'from-image' }]]);
    expect(canvases[0]?.calls).toEqual([
      ['fillStyle', JPG_BACKGROUND],
      ['fillRect', 0, 0, target.width, target.height],
      ['imageSmoothingEnabled', true],
      ['imageSmoothingQuality', 'high'],
      [
        'drawImage',
        full,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        target.width,
        target.height,
      ],
    ]);
  });

  it('falls back to a full decode when the one-step bitmap is the wrong size', async () => {
    const wrong = fakeBitmap(crop.width, crop.height); // the resize was ignored
    const full = fakeBitmap(asset.width, asset.height);
    const { deps, decodeCalls, canvases } = setup({
      decode: (args) => (args.length === 6 ? wrong : full),
    });
    await createImageRenderer(deps)(makeJob());

    expect(decodeCalls).toHaveLength(2);
    expect(wrong.close).toHaveBeenCalledOnce();
    expect(canvases[0]?.calls.at(-1)?.[1]).toBe(full);
    expect(full.close).toHaveBeenCalledOnce();
  });

  it('falls back to a full decode when the one-step call throws', async () => {
    const full = fakeBitmap(asset.width, asset.height);
    const { deps, decodeCalls } = setup({
      decode: (args) => (args.length === 6 ? new Error('unsupported') : full),
    });
    const result = await createImageRenderer(deps)(makeJob());
    expect(decodeCalls).toHaveLength(2);
    expect(result.width).toBe(target.width);
    expect(full.close).toHaveBeenCalledOnce();
  });

  it('always decodes HEIC with the HEIC decoder and draws the crop from the whole photo', async () => {
    const full = fakeBitmap(asset.width, asset.height);
    const { deps, decodeCalls, heicDecoder, canvases, probeCalls } = setup({ heic: () => full });
    const job = makeJob({ sourceFormat: 'heic', fileName: 'phone.heic' });
    await createImageRenderer(deps)(job);

    expect(heicDecoder).toHaveBeenCalledWith(job.blob);
    expect(decodeCalls).toEqual([]);
    expect(probeCalls).toEqual([]);
    expect(canvases[0]?.calls.at(-1)?.slice(1, 6)).toEqual([
      full,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
    ]);
    expect(full.close).toHaveBeenCalledOnce();
  });

  it('checks for browser support once, however many photos are rendered', async () => {
    const { deps, probeCalls } = setup({ decode: targetBitmap });
    const render = createImageRenderer(deps);
    await render(makeJob());
    await render(makeJob({ id: 'job-2' }));
    expect(probeCalls).toHaveLength(1);
  });
});

describe('closing bitmaps', () => {
  it('closes the bitmap after a successful render, on both paths', async () => {
    const piece = targetBitmap();
    await createImageRenderer(setup({ decode: () => piece }).deps)(makeJob());
    expect(piece.close).toHaveBeenCalledOnce();

    const full = fakeBitmap(asset.width, asset.height);
    await createImageRenderer(setup({ readsResizeOptions: false, decode: () => full }).deps)(
      makeJob(),
    );
    expect(full.close).toHaveBeenCalledOnce();
  });

  it('holds no bitmap when decoding throws', async () => {
    const { deps, decodeCalls } = setup({ decode: () => new Error('InvalidStateError') });
    await failureOf(createImageRenderer(deps)(makeJob()));
    // Both paths were tried and neither produced a bitmap to close.
    expect(decodeCalls).toHaveLength(2);
  });

  it('closes a decoded bitmap that is not the size recorded at import', async () => {
    const turned = fakeBitmap(asset.height, asset.width);
    const { deps } = setup({ readsResizeOptions: false, decode: () => turned });
    await failureOf(createImageRenderer(deps)(makeJob()));
    expect(turned.close).toHaveBeenCalledOnce();
  });

  it('closes the bitmap when the canvas cannot be made or drawn on', async () => {
    const first = targetBitmap();
    await failureOf(
      createImageRenderer(setup({ decode: () => first, canvasThrows: true }).deps)(makeJob()),
    );
    expect(first.close).toHaveBeenCalledOnce();

    const second = targetBitmap();
    await failureOf(
      createImageRenderer(setup({ decode: () => second, hasContext: false }).deps)(makeJob()),
    );
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('has already closed the bitmap when encoding throws or returns nothing usable', async () => {
    for (const encoded of [
      new Error('EncodingError'),
      new Blob([], { type: 'image/jpeg' }),
      new Blob(['webp'], { type: 'image/webp' }),
    ]) {
      const piece = targetBitmap();
      const { deps, canvases } = setup({ decode: () => piece, encoded });
      await failureOf(createImageRenderer(deps)(makeJob()));
      expect(piece.close).toHaveBeenCalledOnce();
      expect(piece.close.mock.invocationCallOrder[0]).toBeLessThan(
        canvases[0]?.convertToBlob.mock.invocationCallOrder[0] as number,
      );
    }
  });
});

describe('JPG and PNG output', () => {
  it('fills a JPG with white before drawing, so transparent areas come out white', async () => {
    const { deps, canvases } = setup({ decode: targetBitmap });
    await createImageRenderer(deps)(makeJob({ sourceFormat: 'png', fileName: 'logo.png' }));
    const calls = canvases[0]?.calls ?? [];
    const names = calls.map((call) => call[0]);
    expect(calls[0]).toEqual(['fillStyle', '#ffffff']);
    expect(calls[1]).toEqual(['fillRect', 0, 0, target.width, target.height]);
    expect(names.indexOf('fillRect')).toBeLessThan(names.indexOf('drawImage'));
  });

  it('leaves a PNG transparent: nothing is filled', async () => {
    const { deps, canvases } = setup({
      decode: targetBitmap,
      encoded: new Blob(['png bytes'], { type: 'image/png' }),
    });
    await createImageRenderer(deps)(makeJob({}, { format: 'png' }));
    const names = (canvases[0]?.calls ?? []).map((call) => call[0]);
    expect(names).toEqual(['imageSmoothingEnabled', 'imageSmoothingQuality', 'drawImage']);
  });

  it('encodes JPG at the planned quality', async () => {
    const { deps, canvases } = setup({ decode: targetBitmap });
    await createImageRenderer(deps)(makeJob({}, { quality: 0.72 }));
    expect(canvases[0]?.convertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.72 });
  });

  it.each([
    [7, 1],
    [-2, 0],
    [Number.NaN, 0.9],
  ])('clamps a JPG quality of %s to %s', async (given, used) => {
    const { deps, canvases } = setup({ decode: targetBitmap });
    await createImageRenderer(deps)(makeJob({}, { quality: given }));
    expect(canvases[0]?.convertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: used });
  });

  it('ignores quality for PNG', async () => {
    const { deps, canvases } = setup({
      decode: targetBitmap,
      encoded: new Blob(['png bytes'], { type: 'image/png' }),
    });
    await createImageRenderer(deps)(makeJob({}, { format: 'png', quality: 0.1 }));
    expect(canvases[0]?.convertToBlob).toHaveBeenCalledWith({ type: 'image/png' });
  });
});

describe('the result', () => {
  it('reports the output size, file size and type of the encoded file', async () => {
    const encoded = new Blob(['jpeg bytes'], { type: 'image/jpeg' });
    const { deps } = setup({ decode: targetBitmap, encoded });
    const result = await createImageRenderer(deps)(makeJob({}, { upscaled: true }));
    expect(result).toEqual({
      id: 'job-1',
      blob: encoded,
      width: target.width,
      height: target.height,
      bytes: encoded.size,
      mimeType: 'image/jpeg',
      format: 'jpg',
      upscaled: true,
    });
  });

  it('takes the type from the encoded file, not from what was asked for', async () => {
    // Asked for JPG; the browser handed back a PNG.
    const encoded = new Blob(['png bytes'], { type: 'image/png' });
    const { deps } = setup({ decode: targetBitmap, encoded });
    const result = await createImageRenderer(deps)(makeJob({}, { format: 'jpg' }));
    expect(result.format).toBe('png');
    expect(result.mimeType).toBe('image/png');
  });

  it('reports each stage in order', async () => {
    const stages: RenderStage[] = [];
    const { deps } = setup({ decode: targetBitmap });
    await createImageRenderer(deps)(makeJob(), (stage) => stages.push(stage));
    expect(stages).toEqual(['decoding', 'drawing', 'encoding']);
  });
});

describe('failures', () => {
  async function expectFailure(run: Promise<unknown>, reason: string, fileName: string) {
    const error = await failureOf(run);
    expect(error.reason).toBe(reason);
    expect(error.name).toBe('RenderError');
    expect(error.message).toContain(`"${fileName}"`);
    expect(error.message).not.toMatch(JARGON);
  }

  it('damaged: the file cannot be decoded', async () => {
    const { deps } = setup({ decode: () => new Error('InvalidStateError: source is broken') });
    await expectFailure(createImageRenderer(deps)(makeJob()), 'damaged', 'site.jpg');
  });

  it('heic: the HEIC decoder cannot open the file', async () => {
    const { deps } = setup({ heic: () => new Error('HEIF image not found') });
    const job = makeJob({ sourceFormat: 'heic', fileName: 'phone.heic' });
    await expectFailure(createImageRenderer(deps)(job), 'heic', 'phone.heic');
  });

  it('size-changed: the photo is not the size recorded at import', async () => {
    const { deps } = setup({
      readsResizeOptions: false,
      decode: () => fakeBitmap(asset.height, asset.width),
    });
    await expectFailure(createImageRenderer(deps)(makeJob()), 'size-changed', 'site.jpg');
  });

  it('size-changed also covers a HEIC decoded at another size', async () => {
    const small = fakeBitmap(asset.width, asset.height - 1);
    const { deps } = setup({ heic: () => small });
    const job = makeJob({ sourceFormat: 'heic', fileName: 'phone.heic' });
    await expectFailure(createImageRenderer(deps)(job), 'size-changed', 'phone.heic');
    expect(small.close).toHaveBeenCalledOnce();
  });

  it('canvas: the output picture cannot be made', async () => {
    const { deps } = setup({ decode: targetBitmap, canvasThrows: true });
    await expectFailure(createImageRenderer(deps)(makeJob()), 'canvas', 'site.jpg');
    const none = setup({ decode: targetBitmap, hasContext: false });
    await expectFailure(createImageRenderer(none.deps)(makeJob()), 'canvas', 'site.jpg');
  });

  it('encode: the file cannot be encoded, comes back empty, or is an unknown type', async () => {
    for (const encoded of [
      new Error('EncodingError'),
      new Blob([], { type: 'image/jpeg' }),
      new Blob(['?'], { type: '' }),
    ]) {
      const { deps } = setup({ decode: targetBitmap, encoded });
      await expectFailure(createImageRenderer(deps)(makeJob()), 'encode', 'site.jpg');
    }
    const png = setup({ decode: targetBitmap, encoded: new Error('EncodingError') });
    const error = await failureOf(createImageRenderer(png.deps)(makeJob({}, { format: 'png' })));
    expect(error.message).toContain('PNG');
  });

  it('unexpected: anything else, without passing on the original error text', async () => {
    const { deps } = setup({ decode: targetBitmap });
    const run = createImageRenderer(deps)(makeJob(), () => {
      throw new TypeError("Cannot read properties of undefined (reading 'x')");
    });
    await expectFailure(run, 'unexpected', 'site.jpg');
  });
});

describe('browserDeps', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the browser's own createImageBitmap and OffscreenCanvas", async () => {
    const bitmap = fakeBitmap(2, 2);
    const createImageBitmap = vi.fn().mockResolvedValue(bitmap);
    class FakeOffscreenCanvas {
      constructor(
        public width: number,
        public height: number,
      ) {}
    }
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

    const deps = browserDeps();
    const blob = new Blob(['x']);
    expect(await deps.createImageBitmap(blob)).toBe(bitmap);
    expect(createImageBitmap).toHaveBeenCalledWith(blob);
    const canvas = deps.createCanvas(3, 4);
    expect(canvas).toBeInstanceOf(FakeOffscreenCanvas);
    expect([canvas.width, canvas.height]).toEqual([3, 4]);
    expect(typeof deps.heicDecoder).toBe('function');
  });

  it('is what a renderer uses when none are given', () => {
    vi.stubGlobal('createImageBitmap', vi.fn());
    expect(typeof createImageRenderer()).toBe('function');
  });
});
