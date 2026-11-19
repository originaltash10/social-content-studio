/**
 * Pixel tests for the renderer's drawing: what colour each part of the output is. The canvas is
 * a small one that keeps real pixels (src/test/pixelCanvas.ts); everything else is the real
 * plan and the real renderer. Real browsers are checked in e2e/image-worker.check.mjs.
 */
import { makeAsset } from '../../test/fixtures';
import { pixelBitmap, pixelCanvas } from '../../test/pixelCanvas';
import type { PixelCanvas, Rgba } from '../../test/pixelCanvas';
import type { PlacementSpec, Rect, Size } from '../../types';
import { platforms } from '../platforms';
import { DEFAULT_BACKGROUND } from './background';
import { centredOnPhoto, drawRects, fitSize, focalCrop } from './crop';
import type { PixelRect } from './crop';
import { isImagePlacement, planRender, targetSize } from './plan';
import type { OutputFormat, RenderPlan } from './plan';
import { createImageRenderer } from './renderImage';
import type { RenderDeps } from './renderImage';

/**
 * Every shape is read from platforms.json; none is typed in here. The canvas in these tests
 * works one pixel at a time, so each placement is used at an eighth of its real size: the same
 * shape to within a pixel, and a sixty-fourth of the pixels. Real sizes are rendered in real
 * Chromium by e2e/image-worker.check.mjs.
 */
const SCALE = 8;
const imagePlacements: PlacementSpec[] = platforms.placements
  .filter(isImagePlacement)
  .map((spec) => ({
    ...spec,
    sizes: spec.sizes.map((size) => ({
      width: Math.round(size.width / SCALE),
      height: Math.round(size.height / SCALE),
    })),
  }));
const name = (spec: PlacementSpec) => `${spec.platform} ${spec.placement}`;
const ratioOf = (spec: PlacementSpec) => targetSize(spec).width / targetSize(spec).height;
function placementWhere(test: (ratio: number) => boolean, what: string): PlacementSpec {
  const found = imagePlacements.find((spec) => test(ratioOf(spec)));
  if (!found) throw new Error(`platforms.json has no ${what} image placement`);
  return found;
}
/** Taller than it is wide, so a landscape photo shown whole has padding above and below. */
const TALL = placementWhere((ratio) => ratio < 1, 'tall');
/** Wider than it is tall, so a portrait photo shown whole has padding left and right. */
const WIDE = placementWhere((ratio) => ratio > 1, 'wide');

const LANDSCAPE: Size = { width: 400, height: 300 };
const PORTRAIT: Size = { width: 300, height: 400 };
const COLOUR = '#0a7f5c';
const COLOUR_RGBA: Rgba = [0x0a, 0x7f, 0x5c, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const CLEAR: Rgba = [0, 0, 0, 0];
/** No photo pixel has this much blue, and the padding colour has less. */
const PHOTO_BLUE = 200;

/** The transparent hole in the test photo, in fractions of it. */
const HOLE = { x0: 0.4, x1: 0.6, y0: 0.4, y1: 0.6 };

/**
 * The test photo: red rises from left to right and green from top to bottom, so a pixel's
 * colour says where in the photo it came from. With `hole`, the middle is transparent.
 */
function photo(size: Size, hole = false) {
  return pixelBitmap(size.width, size.height, (x, y) => {
    const fx = (x + 0.5) / size.width;
    const fy = (y + 0.5) / size.height;
    if (hole && fx > HOLE.x0 && fx < HOLE.x1 && fy > HOLE.y0 && fy < HOLE.y1) return [0, 0, 0, 0];
    return [Math.round(255 * fx), Math.round(255 * fy), PHOTO_BLUE, 255];
  });
}

type Options = {
  size: Size;
  spec: PlacementSpec;
  crop?: Rect;
  format?: OutputFormat;
  background?: string;
  hole?: boolean;
};

/** Plans and renders one picture with the real code, onto a canvas that keeps its pixels. */
async function render({ size, spec, crop, format = 'png', background, hole = false }: Options) {
  const asset = makeAsset({ ...size, focal: { x: 0.5, y: 0.5 } });
  const plan = planRender({ asset, spec, edit: crop ? { crop, format } : { format }, background });
  const canvases: PixelCanvas[] = [];
  const deps = {
    createImageBitmap: () => Promise.resolve(photo(size, hole)),
    createCanvas: (width: number, height: number) => {
      const made = pixelCanvas(width, height);
      canvases.push(made);
      return made.canvas;
    },
    heicDecoder: () => Promise.reject(new Error('not used')),
  } as unknown as RenderDeps;
  const result = await createImageRenderer(deps)({
    id: 'job',
    blob: new Blob(['original']),
    fileName: 'site.png',
    sourceFormat: 'png',
    plan,
  });
  const canvas = canvases[0] as PixelCanvas;
  return { plan, result, canvas, where: drawRects(plan.crop, plan.sourceSize, plan.target).dest };
}

/** The whole photo in the placement's shape: the Fit whole photo crop. */
const fitWhole = (size: Size, spec: PlacementSpec) => centredOnPhoto(fitSize(size, ratioOf(spec)));

/** A few columns across the output, edge to edge. */
const columns = (width: number) => [0, 1, Math.floor(width / 2), width - 2, width - 1];
const rows = (height: number) => [0, 1, Math.floor(height / 2), height - 2, height - 1];

function expectPhotoPixel(pixel: Rgba) {
  // Fully opaque photo, with none of the padding colour mixed in.
  expect(pixel[2]).toBe(PHOTO_BLUE);
  expect(pixel[3]).toBe(255);
}

describe('padding above and below a landscape photo', () => {
  it.each(['png', 'jpg'] as const)(
    'is exactly the colour at both padded edges, as %s',
    async (format) => {
      const { canvas, where, plan } = await render({
        size: LANDSCAPE,
        spec: TALL,
        crop: fitWhole(LANDSCAPE, TALL),
        format,
        background: COLOUR,
      });
      const { width, height } = plan.target;
      // The photo spans the full width, with padding of the same height above and below it.
      expect(where.x).toBe(0);
      expect(where.width).toBe(width);
      expect(where.y).toBeGreaterThan(0);
      expect(where.y + where.height).toBeLessThan(height);
      expect(Math.abs(where.y - (height - where.y - where.height))).toBeLessThanOrEqual(1);
      const bottom = where.y + where.height;
      for (const x of columns(width)) {
        // The first and last row of each strip of padding, right up to the photo.
        for (const y of [0, where.y - 1, bottom, height - 1]) {
          expect(canvas.pixel(x, y)).toEqual(COLOUR_RGBA);
        }
        // The photo's first and last row, right next to the padding: no seam, no gap.
        expectPhotoPixel(canvas.pixel(x, where.y));
        expectPhotoPixel(canvas.pixel(x, bottom - 1));
        // The top row comes from the top of the photo and the bottom row from its bottom.
        expect(canvas.pixel(x, where.y)[1]).toBeLessThan(8);
        expect(canvas.pixel(x, bottom - 1)[1]).toBeGreaterThan(247);
      }
      // Left to right the photo runs from its left edge to its right edge: all of it is there.
      expect(canvas.pixel(0, where.y)[0]).toBeLessThan(8);
      expect(canvas.pixel(width - 1, where.y)[0]).toBeGreaterThan(247);
    },
  );
});

describe('padding left and right of a portrait photo', () => {
  it.each(['png', 'jpg'] as const)(
    'is exactly the colour at both padded edges, as %s',
    async (format) => {
      const { canvas, where, plan } = await render({
        size: PORTRAIT,
        spec: WIDE,
        crop: fitWhole(PORTRAIT, WIDE),
        format,
        background: COLOUR,
      });
      const { width, height } = plan.target;
      expect(where.y).toBe(0);
      expect(where.height).toBe(height);
      expect(where.x).toBeGreaterThan(0);
      expect(Math.abs(where.x - (width - where.x - where.width))).toBeLessThanOrEqual(1);
      const right = where.x + where.width;
      for (const y of rows(height)) {
        for (const x of [0, where.x - 1, right, width - 1]) {
          expect(canvas.pixel(x, y)).toEqual(COLOUR_RGBA);
        }
        expectPhotoPixel(canvas.pixel(where.x, y));
        expectPhotoPixel(canvas.pixel(right - 1, y));
        expect(canvas.pixel(where.x, y)[0]).toBeLessThan(8);
        expect(canvas.pixel(right - 1, y)[0]).toBeGreaterThan(247);
      }
    },
  );
});

describe('every pixel of a padded picture', () => {
  it.each(imagePlacements.map((spec) => [name(spec), spec] as const))(
    'is either the photo or exactly the colour, with a straight edge between them: %s',
    async (_name, spec) => {
      for (const size of [LANDSCAPE, PORTRAIT]) {
        const { canvas, where, plan } = await render({
          size,
          spec,
          crop: fitWhole(size, spec),
          background: COLOUR,
        });
        const { width, height } = plan.target;
        let padding = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const inside =
              x >= where.x &&
              x < where.x + where.width &&
              y >= where.y &&
              y < where.y + where.height;
            const at = (y * width + x) * 4;
            const blue = canvas.data[at + 2];
            if (inside) {
              if (blue !== PHOTO_BLUE) throw new Error(`not the photo at ${x}, ${y}`);
            } else {
              padding += 1;
              if (
                canvas.data[at] !== COLOUR_RGBA[0] ||
                canvas.data[at + 1] !== COLOUR_RGBA[1] ||
                blue !== COLOUR_RGBA[2] ||
                canvas.data[at + 3] !== 255
              ) {
                throw new Error(`not the padding colour at ${x}, ${y}`);
              }
            }
          }
        }
        // There is padding unless the photo already has the placement's shape.
        expect(padding).toBe(width * height - where.width * where.height);
        // Only the photo itself was read, never an area outside it.
        expect(canvas.sourceRects).toEqual([[0, 0, size.width, size.height]]);
      }
    },
  );
});

describe('uneven padding', () => {
  it('puts the photo where the crop says, with more padding on one side', async () => {
    // A crop a little taller than the photo, with all of its padding below the photo.
    const fit = fitSize(LANDSCAPE, ratioOf(TALL));
    const fill = focalCrop(LANDSCAPE, ratioOf(TALL), { x: 0.5, y: 0.5 });
    const width = fill.width * 1.04;
    const crop = { x: 0.1, y: 0, width, height: (width / fit.width) * fit.height };
    const { canvas, where, plan } = await render({
      size: LANDSCAPE,
      spec: TALL,
      crop,
      background: COLOUR,
    });
    // The photo starts at the very top and stops short of the bottom.
    expect(where.y).toBe(0);
    expect(where.x).toBe(0);
    expect(where.width).toBe(plan.target.width);
    const bottom = where.height;
    expect(bottom).toBeLessThan(plan.target.height);
    for (const x of columns(plan.target.width)) {
      expectPhotoPixel(canvas.pixel(x, 0));
      expectPhotoPixel(canvas.pixel(x, bottom - 1));
      expect(canvas.pixel(x, bottom)).toEqual(COLOUR_RGBA);
      expect(canvas.pixel(x, plan.target.height - 1)).toEqual(COLOUR_RGBA);
    }
    // Only the part of the photo inside the crop was read: its full height, part of its width.
    const [[sx, sy, sw, sh]] = canvas.sourceRects as [[number, number, number, number]];
    expect([sy, sh]).toEqual([0, LANDSCAPE.height]);
    expect(sx).toBeGreaterThan(0);
    expect(sx + sw).toBeLessThanOrEqual(LANDSCAPE.width);
  });
});

describe('JPG and PNG, with a photo that has a transparent hole', () => {
  const crop = fitWhole(LANDSCAPE, TALL);
  /** A pixel in the middle of the hole, and one in the padding. */
  const points = (where: PixelRect, target: Size) => ({
    hole: [Math.floor(target.width / 2), where.y + Math.floor(where.height / 2)] as const,
    padding: [Math.floor(target.width / 2), Math.floor(where.y / 2)] as const,
    photo: [Math.floor(target.width / 10), where.y + Math.floor(where.height / 10)] as const,
  });

  it('JPG: the colour fills the padding and the transparent part of the photo', async () => {
    const { canvas, where, plan } = await render({
      size: LANDSCAPE,
      spec: TALL,
      crop,
      format: 'jpg',
      background: COLOUR,
      hole: true,
    });
    const at = points(where, plan.target);
    expect(canvas.pixel(...at.hole)).toEqual(COLOUR_RGBA);
    expect(canvas.pixel(...at.padding)).toEqual(COLOUR_RGBA);
    expectPhotoPixel(canvas.pixel(...at.photo));
    // No pixel of a JPG is left transparent.
    for (let i = 3; i < canvas.data.length; i += 4) {
      if (canvas.data[i] !== 255) throw new Error('a JPG pixel is not opaque');
    }
  });

  it('PNG: the colour fills the padding only, and the photo keeps its transparency', async () => {
    const { canvas, where, plan } = await render({
      size: LANDSCAPE,
      spec: TALL,
      crop,
      format: 'png',
      background: COLOUR,
      hole: true,
    });
    const at = points(where, plan.target);
    expect(canvas.pixel(...at.hole)).toEqual(CLEAR);
    expect(canvas.pixel(...at.padding)).toEqual(COLOUR_RGBA);
    expectPhotoPixel(canvas.pixel(...at.photo));
  });

  it('JPG with no colour: white, in the padding and in the hole, as a JPG always was', async () => {
    const { canvas, where, plan } = await render({
      size: LANDSCAPE,
      spec: TALL,
      crop,
      format: 'jpg',
      hole: true,
    });
    expect(plan.background).toBe(DEFAULT_BACKGROUND);
    const at = points(where, plan.target);
    expect(canvas.pixel(...at.hole)).toEqual(WHITE);
    expect(canvas.pixel(...at.padding)).toEqual(WHITE);
  });

  it('PNG with no colour: white padding, and the hole still transparent', async () => {
    const { canvas, where, plan } = await render({ size: LANDSCAPE, spec: TALL, crop, hole: true });
    const at = points(where, plan.target);
    expect(canvas.pixel(...at.hole)).toEqual(CLEAR);
    expect(canvas.pixel(...at.padding)).toEqual(WHITE);
  });

  it('a colour that cannot be used is white', async () => {
    const { canvas, where, plan } = await render({
      size: LANDSCAPE,
      spec: TALL,
      crop,
      background: 'tomato',
    });
    expect(plan.background).toBe(DEFAULT_BACKGROUND);
    expect(canvas.pixel(...points(where, plan.target).padding)).toEqual(WHITE);
  });

  it('an unpadded PNG is not coloured anywhere, whatever the colour', async () => {
    const { canvas, plan } = await render({
      size: LANDSCAPE,
      spec: TALL,
      format: 'png',
      background: COLOUR,
      hole: true,
    });
    const { width, height } = plan.target;
    expect(canvas.pixel(Math.floor(width / 2), Math.floor(height / 2))).toEqual(CLEAR);
    for (let i = 0; i < canvas.data.length; i += 4) {
      const clear = canvas.data[i + 3] === 0;
      if (!clear && canvas.data[i + 2] !== PHOTO_BLUE) throw new Error('a pixel was coloured');
    }
  });

  it('an unpadded JPG takes the colour in its transparent part only', async () => {
    const { canvas, plan } = await render({
      size: LANDSCAPE,
      spec: TALL,
      format: 'jpg',
      background: COLOUR,
      hole: true,
    });
    const { width, height } = plan.target;
    expect(canvas.pixel(Math.floor(width / 2), Math.floor(height / 2))).toEqual(COLOUR_RGBA);
    expectPhotoPixel(canvas.pixel(0, 0));
    expectPhotoPixel(canvas.pixel(width - 1, height - 1));
  });
});

describe('the enlarged flag', () => {
  const upscaled = async (size: Size, spec: PlacementSpec, crop?: Rect) =>
    (await render({ size, spec, crop, background: COLOUR })).result.upscaled;

  it('goes by the size of the crop, padding included', async () => {
    const target = targetSize(TALL);
    // Shown whole, this photo's crop is exactly the output size: nothing is enlarged, even
    // though the photo alone is shorter than the output.
    const exact = { width: target.width, height: Math.round(target.height / 2) };
    expect(exact.height).toBeLessThan(target.height);
    expect(await upscaled(exact, TALL, fitWhole(exact, TALL))).toBe(false);
    // One pixel narrower, and the crop is smaller than the output: enlarged.
    const narrower = { width: target.width - 1, height: exact.height };
    expect(await upscaled(narrower, TALL, fitWhole(narrower, TALL))).toBe(true);
  });

  it('is set for a small photo and not for a large one, with or without padding', async () => {
    const target = targetSize(TALL);
    const small = { width: Math.round(target.width / 2), height: Math.round(target.width / 3) };
    const large = { width: target.width * 4, height: target.width * 3 };
    for (const [size, enlarged] of [
      [small, true],
      [large, false],
    ] as const) {
      expect(await upscaled(size, TALL)).toBe(enlarged);
      expect(await upscaled(size, TALL, fitWhole(size, TALL))).toBe(enlarged);
    }
  });
});

describe('a card with no colour and a crop inside the photo', () => {
  /** The drawing as it was before crops could have padding, onto the same kind of canvas. */
  function drawnTheOldWay(plan: RenderPlan, size: Size, hole: boolean): Uint8ClampedArray {
    const { canvas, data } = pixelCanvas(plan.target.width, plan.target.height);
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    if (plan.format === 'jpg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, plan.target.width, plan.target.height);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      photo(size, hole),
      plan.crop.x,
      plan.crop.y,
      plan.crop.width,
      plan.crop.height,
      0,
      0,
      plan.target.width,
      plan.target.height,
    );
    return data;
  }

  /** Crops inside the photo: the automatic one, and one touching each edge in turn. */
  function crops(size: Size, spec: PlacementSpec): (Rect | undefined)[] {
    const fill = focalCrop(size, ratioOf(spec), { x: 0.5, y: 0.5 });
    const half = { width: fill.width / 2, height: fill.height / 2 };
    return [
      undefined,
      { x: 0, y: 0.2, ...half },
      { x: 0.2, y: 0, ...half },
      { x: 1 - half.width, y: 0.3, ...half },
      { x: 0.3, y: 1 - half.height, ...half },
      { x: 0, y: 0, width: 1, height: 1 },
    ];
  }

  it.each(imagePlacements.map((spec) => [name(spec), spec] as const))(
    'comes out pixel for pixel as it did before, as JPG and as PNG: %s',
    async (_name, spec) => {
      for (const size of [LANDSCAPE, PORTRAIT]) {
        for (const crop of crops(size, spec)) {
          for (const format of ['jpg', 'png'] as const) {
            const { canvas, plan } = await render({ size, spec, crop, format, hole: true });
            expect(plan.background).toBe(DEFAULT_BACKGROUND);
            const old = drawnTheOldWay(plan, size, true);
            // Compared as one value: a mismatch anywhere fails, without a million-line report.
            expect(Buffer.from(canvas.data).equals(Buffer.from(old))).toBe(true);
          }
        }
      }
    },
  );
});
