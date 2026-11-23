import { makeAsset } from '../../test/fixtures';
import { platforms } from '../platforms';
import { DEFAULT_BACKGROUND } from './background';
import { centredOnPhoto, fitSize, focalCrop } from './crop';
import { isImagePlacement, planRender, targetSize } from './plan';
import type { RenderPlan } from './plan';
import { RenderError } from './protocol';
import type { RenderJob, RenderStage } from './protocol';
import { browserDeps, createImageRenderer } from './renderImage';
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
  /** What decoding a JPG or PNG returns, or throws. */
  decode?: () => ImageBitmap | Error;
  heic?: () => ImageBitmap | Error;
  encoded?: Blob | Error;
  hasContext?: boolean;
  canvasThrows?: boolean;
};

function setup(options: Setup = {}) {
  const {
    decode = () => fakeBitmap(asset.width, asset.height),
    heic = () => fakeBitmap(asset.width, asset.height),
    encoded = new Blob(['jpeg bytes'], { type: 'image/jpeg' }),
    hasContext = true,
    canvasThrows = false,
  } = options;
  const decodeCalls: unknown[][] = [];
  const canvases: ReturnType<typeof fakeCanvas>[] = [];

  const createImageBitmap = vi.fn((...args: unknown[]) => {
    decodeCalls.push(args);
    const result = decode();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const heicDecoder = vi.fn(() => {
    const result = heic();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const deps = {
    createImageBitmap,
    createCanvas: (width: number, height: number) => {
      if (canvasThrows) throw new Error('RangeError: Out of memory');
      const made = fakeCanvas(width, height, encoded, hasContext);
      canvases.push(made);
      return made.canvas;
    },
    heicDecoder,
  } as unknown as RenderDeps;
  return { deps, decodeCalls, canvases, heicDecoder };
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
const fullBitmap = () => fakeBitmap(asset.width, asset.height);

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

describe('decoding and drawing', () => {
  it('decodes the whole JPG or PNG the right way up, with no crop or resize options', async () => {
    const { deps, decodeCalls, heicDecoder } = setup();
    const job = makeJob();
    await createImageRenderer(deps)(job);
    expect(decodeCalls).toEqual([[job.blob, { imageOrientation: 'from-image' }]]);
    expect(heicDecoder).not.toHaveBeenCalled();
  });

  it('decodes HEIC with the HEIC decoder', async () => {
    const { deps, decodeCalls, heicDecoder } = setup();
    const job = makeJob({ sourceFormat: 'heic', fileName: 'phone.heic' });
    await createImageRenderer(deps)(job);
    expect(heicDecoder).toHaveBeenCalledWith(job.blob);
    expect(decodeCalls).toEqual([]);
  });

  it.each(['jpeg', 'png', 'heic'] as const)(
    'draws the planned crop of a %s at the output size with high-quality smoothing',
    async (sourceFormat) => {
      const full = fullBitmap();
      const { deps, canvases } = setup({ decode: () => full, heic: () => full });
      await createImageRenderer(deps)(makeJob({ sourceFormat }));

      expect(canvases).toHaveLength(1);
      expect([canvases[0]?.canvas.width, canvases[0]?.canvas.height]).toEqual([
        target.width,
        target.height,
      ]);
      expect(canvases[0]?.calls).toEqual([
        ['fillStyle', DEFAULT_BACKGROUND],
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
    },
  );
});

describe('a crop inside the photo, on a card with no colour', () => {
  const imagePlacements = platforms.placements.filter(isImagePlacement);
  const photos = [
    { width: 4032, height: 3024 },
    { width: 3024, height: 4032 },
    { width: 2000, height: 2000 },
    { width: 640, height: 480 },
  ];

  /** Crops inside the photo: the automatic ones, and one touching each edge in turn. */
  function insideCrops(source: { width: number; height: number }, ratio: number) {
    const fill = focalCrop(source, ratio, { x: 0.5, y: 0.5 });
    const half = { width: fill.width / 2, height: fill.height / 2 };
    return [
      undefined,
      focalCrop(source, ratio, { x: 0, y: 0 }),
      focalCrop(source, ratio, { x: 1, y: 1 }),
      { x: 0, y: 0.21, ...half },
      { x: 0.17, y: 0, ...half },
      { x: 1 - half.width, y: 0.33, ...half },
      { x: 0.29, y: 1 - half.height, ...half },
      { x: 0, y: 0, ...half },
      { x: 1 - half.width, y: 1 - half.height, ...half },
      { x: 0.123, y: 0.234, ...half },
      { x: 0, y: 0, width: 1, height: 1 },
    ];
  }

  describe.each(photos)('from a $width x $height photo', (source) => {
    it.each(imagePlacements.map((s) => [`${s.platform} ${s.placement}`, s] as const))(
      'makes exactly the canvas calls it made before padding: %s',
      async (_name, placement) => {
        const photo = makeAsset({ ...source, focal: { x: 0.5, y: 0.5 } });
        const size = targetSize(placement);
        for (const cropRect of insideCrops(source, size.width / size.height)) {
          for (const format of ['jpg', 'png'] as const) {
            const plan = planRender({
              asset: photo,
              spec: placement,
              edit: cropRect ? { crop: cropRect, format } : { format },
            });
            const full = fakeBitmap(source.width, source.height);
            const { deps, canvases } = setup({
              decode: () => full,
              encoded: new Blob(['bytes'], { type: format === 'jpg' ? 'image/jpeg' : 'image/png' }),
            });
            await createImageRenderer(deps)(makeJob({ plan }));
            // The crop is whole pixels inside the photo, as it always was.
            expect(plan.crop.x).toBeGreaterThanOrEqual(0);
            expect(plan.crop.y).toBeGreaterThanOrEqual(0);
            expect(plan.crop.x + plan.crop.width).toBeLessThanOrEqual(source.width);
            expect(plan.crop.y + plan.crop.height).toBeLessThanOrEqual(source.height);
            // The calls the renderer made before this feature, in the same order: a white fill
            // for a JPG and none for a PNG, then the crop drawn onto the whole output.
            expect(canvases[0]?.calls).toEqual([
              ...(format === 'jpg'
                ? [
                    ['fillStyle', '#ffffff'],
                    ['fillRect', 0, 0, size.width, size.height],
                  ]
                : []),
              ['imageSmoothingEnabled', true],
              ['imageSmoothingQuality', 'high'],
              [
                'drawImage',
                full,
                plan.crop.x,
                plan.crop.y,
                plan.crop.width,
                plan.crop.height,
                0,
                0,
                size.width,
                size.height,
              ],
            ]);
          }
        }
      },
    );
  });
});

describe('a crop with padding', () => {
  // A 4000 x 3000 photo shown whole in a square: 500 source pixels of padding above and below.
  const square = platforms.placements
    .filter(isImagePlacement)
    .find((s) => targetSize(s).width === targetSize(s).height);
  if (!square) throw new Error('platforms.json has no square image placement');
  const side = targetSize(square).width;
  const photo = makeAsset({ width: 4000, height: 3000 });
  const whole = centredOnPhoto(fitSize(photo, 1));
  const padded = (format: 'jpg' | 'png', background?: string) =>
    planRender({ asset: photo, spec: square, edit: { crop: whole, format }, background });
  /** Where the photo lands: three quarters of the height, in the middle. */
  const top = Math.round(side / 8);
  const bottom = Math.round((side * 7) / 8);

  async function callsFor(plan: RenderPlan) {
    const full = fakeBitmap(4000, 3000);
    const { deps, canvases } = setup({
      decode: () => full,
      encoded: new Blob(['bytes'], { type: plan.format === 'jpg' ? 'image/jpeg' : 'image/png' }),
    });
    await createImageRenderer(deps)(makeJob({ plan }));
    return { calls: canvases[0]?.calls ?? [], full };
  }

  it('reads only the photo itself, and draws it between the padding', async () => {
    const plan = padded('jpg', '#0a7f5c');
    expect(plan.crop).toEqual({ x: 0, y: -500, width: 4000, height: 4000 });
    const { calls, full } = await callsFor(plan);
    expect(calls.at(-1)).toEqual(['drawImage', full, 0, 0, 4000, 3000, 0, top, side, bottom - top]);
  });

  it('JPG: fills the whole picture with the colour first', async () => {
    const { calls } = await callsFor(padded('jpg', '#0a7f5c'));
    expect(calls.slice(0, 2)).toEqual([
      ['fillStyle', '#0a7f5c'],
      ['fillRect', 0, 0, side, side],
    ]);
    expect(calls.filter((call) => call[0] === 'fillRect')).toHaveLength(1);
  });

  it('PNG: fills only the padding, and its edges are the edges the photo is drawn to', async () => {
    const { calls } = await callsFor(padded('png', '#0a7f5c'));
    expect(calls.slice(0, 3)).toEqual([
      ['fillStyle', '#0a7f5c'],
      ['fillRect', 0, 0, side, top],
      ['fillRect', 0, bottom, side, side - bottom],
    ]);
    expect(calls.filter((call) => call[0] === 'fillRect')).toHaveLength(2);
  });

  it('uses white when the card has no colour', async () => {
    for (const format of ['jpg', 'png'] as const) {
      const { calls } = await callsFor(padded(format));
      expect(calls[0]).toEqual(['fillStyle', '#ffffff']);
    }
  });
});

describe('the size check', () => {
  it.each(['jpeg', 'png', 'heic'] as const)(
    'refuses a %s that does not decode at the size recorded at import',
    async (sourceFormat) => {
      const turned = fakeBitmap(asset.height, asset.width);
      const { deps, canvases } = setup({ decode: () => turned, heic: () => turned });
      const error = await failureOf(createImageRenderer(deps)(makeJob({ sourceFormat })));
      expect(error.reason).toBe('size-changed');
      expect(turned.close).toHaveBeenCalledOnce();
      expect(canvases).toEqual([]);
    },
  );

  it('refuses a photo that is off by a single pixel either way', async () => {
    for (const [width, height] of [
      [asset.width - 1, asset.height],
      [asset.width, asset.height + 1],
    ] as const) {
      const { deps } = setup({ decode: () => fakeBitmap(width, height) });
      expect((await failureOf(createImageRenderer(deps)(makeJob()))).reason).toBe('size-changed');
    }
  });
});

describe('closing bitmaps', () => {
  it.each(['jpeg', 'png', 'heic'] as const)(
    'closes the %s bitmap once after a successful render',
    async (sourceFormat) => {
      const full = fullBitmap();
      const { deps } = setup({ decode: () => full, heic: () => full });
      await createImageRenderer(deps)(makeJob({ sourceFormat }));
      expect(full.close).toHaveBeenCalledOnce();
    },
  );

  it('holds no bitmap when decoding throws', async () => {
    const { deps, decodeCalls, canvases } = setup({ decode: () => new Error('InvalidStateError') });
    await failureOf(createImageRenderer(deps)(makeJob()));
    expect(decodeCalls).toHaveLength(1);
    expect(canvases).toEqual([]);

    const heic = setup({ heic: () => new Error('HEIF image not found') });
    await failureOf(createImageRenderer(heic.deps)(makeJob({ sourceFormat: 'heic' })));
    expect(heic.canvases).toEqual([]);
  });

  it('closes the bitmap when the canvas cannot be made or drawn on', async () => {
    const first = fullBitmap();
    await failureOf(
      createImageRenderer(setup({ decode: () => first, canvasThrows: true }).deps)(makeJob()),
    );
    expect(first.close).toHaveBeenCalledOnce();

    const second = fullBitmap();
    await failureOf(
      createImageRenderer(setup({ decode: () => second, hasContext: false }).deps)(makeJob()),
    );
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('closes the bitmap when a progress listener throws while drawing starts', async () => {
    const full = fullBitmap();
    const { deps } = setup({ decode: () => full });
    const run = createImageRenderer(deps)(makeJob(), (stage) => {
      if (stage === 'drawing') throw new Error('listener failed');
    });
    expect((await failureOf(run)).reason).toBe('unexpected');
    expect(full.close).toHaveBeenCalledOnce();
  });

  it('has already closed the bitmap when encoding throws or returns nothing usable', async () => {
    for (const encoded of [
      new Error('EncodingError'),
      new Blob([], { type: 'image/jpeg' }),
      new Blob(['webp'], { type: 'image/webp' }),
    ]) {
      const full = fullBitmap();
      const { deps, canvases } = setup({ decode: () => full, encoded });
      await failureOf(createImageRenderer(deps)(makeJob()));
      expect(full.close).toHaveBeenCalledOnce();
      expect(full.close.mock.invocationCallOrder[0]).toBeLessThan(
        canvases[0]?.convertToBlob.mock.invocationCallOrder[0] as number,
      );
    }
  });
});

describe('JPG and PNG output', () => {
  it('fills a JPG with white before drawing, so transparent areas come out white', async () => {
    const { deps, canvases } = setup();
    await createImageRenderer(deps)(makeJob({ sourceFormat: 'png', fileName: 'logo.png' }));
    const calls = canvases[0]?.calls ?? [];
    const names = calls.map((call) => call[0]);
    expect(calls[0]).toEqual(['fillStyle', '#ffffff']);
    expect(calls[1]).toEqual(['fillRect', 0, 0, target.width, target.height]);
    expect(names.indexOf('fillRect')).toBeLessThan(names.indexOf('drawImage'));
  });

  it('leaves a PNG transparent: nothing is filled', async () => {
    const { deps, canvases } = setup({
      encoded: new Blob(['png bytes'], { type: 'image/png' }),
    });
    await createImageRenderer(deps)(makeJob({}, { format: 'png' }));
    const names = (canvases[0]?.calls ?? []).map((call) => call[0]);
    expect(names).toEqual(['imageSmoothingEnabled', 'imageSmoothingQuality', 'drawImage']);
  });

  it('encodes JPG at the planned quality', async () => {
    const { deps, canvases } = setup();
    await createImageRenderer(deps)(makeJob({}, { quality: 0.72 }));
    expect(canvases[0]?.convertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.72 });
  });

  it.each([
    [7, 1],
    [-2, 0],
    [Number.NaN, 0.9],
  ])('clamps a JPG quality of %s to %s', async (given, used) => {
    const { deps, canvases } = setup();
    await createImageRenderer(deps)(makeJob({}, { quality: given }));
    expect(canvases[0]?.convertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: used });
  });

  it('ignores quality for PNG', async () => {
    const { deps, canvases } = setup({
      encoded: new Blob(['png bytes'], { type: 'image/png' }),
    });
    await createImageRenderer(deps)(makeJob({}, { format: 'png', quality: 0.1 }));
    expect(canvases[0]?.convertToBlob).toHaveBeenCalledWith({ type: 'image/png' });
  });
});

describe('the result', () => {
  it('reports the output size, file size and type of the encoded file', async () => {
    const encoded = new Blob(['jpeg bytes'], { type: 'image/jpeg' });
    const { deps } = setup({ encoded });
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
    const { deps } = setup({ encoded });
    const result = await createImageRenderer(deps)(makeJob({}, { format: 'jpg' }));
    expect(result.format).toBe('png');
    expect(result.mimeType).toBe('image/png');
  });

  it('reports each stage in order', async () => {
    const stages: RenderStage[] = [];
    const { deps } = setup();
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
    const { deps } = setup({ decode: () => fakeBitmap(asset.height, asset.width) });
    const run = createImageRenderer(deps)(makeJob());
    await expectFailure(run, 'size-changed', 'site.jpg');
    // Importing the same file again would be skipped as a duplicate, so the advice must not
    // be to do that.
    expect((await failureOf(run)).message).toBe(
      `"site.jpg" opens as ${asset.height} x ${asset.width} pixels in this browser, but it was ` +
        `${asset.width} x ${asset.height} when it was imported, so its crop no longer fits. ` +
        'Try the browser you imported it with, or open it in a photo app, save a new copy as ' +
        'JPG, and import that copy.',
    );
  });

  it('size-changed also covers a HEIC decoded at another size', async () => {
    const small = fakeBitmap(asset.width, asset.height - 1);
    const { deps } = setup({ heic: () => small });
    const job = makeJob({ sourceFormat: 'heic', fileName: 'phone.heic' });
    await expectFailure(createImageRenderer(deps)(job), 'size-changed', 'phone.heic');
    expect(small.close).toHaveBeenCalledOnce();
  });

  it('canvas: the output picture cannot be made', async () => {
    const { deps } = setup({ canvasThrows: true });
    await expectFailure(createImageRenderer(deps)(makeJob()), 'canvas', 'site.jpg');
    const none = setup({ hasContext: false });
    await expectFailure(createImageRenderer(none.deps)(makeJob()), 'canvas', 'site.jpg');
  });

  it('encode: the file cannot be encoded, comes back empty, or is an unknown type', async () => {
    for (const encoded of [
      new Error('EncodingError'),
      new Blob([], { type: 'image/jpeg' }),
      new Blob(['?'], { type: '' }),
    ]) {
      const { deps } = setup({ encoded });
      await expectFailure(createImageRenderer(deps)(makeJob()), 'encode', 'site.jpg');
    }
    const png = setup({ encoded: new Error('EncodingError') });
    const error = await failureOf(createImageRenderer(png.deps)(makeJob({}, { format: 'png' })));
    expect(error.message).toContain('PNG');
  });

  it('unexpected: anything else, without passing on the original error text', async () => {
    const { deps } = setup();
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
