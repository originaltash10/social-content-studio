/**
 * Renders one image: decode the original file, crop and resize it to the planned output size,
 * and encode it as JPG or PNG. Written to run inside the image worker, but nothing here depends
 * on being in one: the browser functions it uses are passed in, so tests can replace them.
 *
 * Two ways of getting from file to pixels:
 *
 * - Crop-and-resize in one step. `createImageBitmap` is asked to decode, crop and resize
 *   together, so the only bitmap this code ever holds is the size of the output. This keeps
 *   memory low for large photos. Not every browser supports the options it needs.
 * - Full decode, then draw. The whole photo is decoded and `drawImage` crops and scales it with
 *   high-quality smoothing. Works everywhere. HEIC always goes this way, because the HEIC
 *   decoder hands back the whole photo.
 *
 * The first is used when the browser reads the options (checked once), and its result is
 * checked: if it throws or the bitmap is not the planned size, the second is used instead.
 *
 * Orientation is handled as at import (`imageOrientation: 'from-image'`), so crops line up with
 * the width and height stored on the asset. Every bitmap is closed before this returns, whether
 * the render worked or not.
 */

import { damagedMessage, heicMessage } from '../image/decode';
import { decodeHeic } from '../image/heic';
import type { HeicDecoder } from '../image/heic';
import type { PixelRect } from './crop';
import { clampQuality } from './plan';
import type { OutputFormat, RenderPlan } from './plan';
import { RenderError, unexpectedError } from './protocol';
import type { RenderJob, RenderResult, RenderStage } from './protocol';

/** The parts of an OffscreenCanvas this code uses. */
export type RenderCanvas = Pick<OffscreenCanvas, 'width' | 'height' | 'convertToBlob'> & {
  getContext(contextId: '2d'): OffscreenCanvasRenderingContext2D | null;
};

/** The browser functions a render needs. */
export type RenderDeps = {
  createImageBitmap: typeof createImageBitmap;
  createCanvas: (width: number, height: number) => RenderCanvas;
  heicDecoder: HeicDecoder;
};

/** The real browser functions. The HEIC decoder is only loaded when a HEIC file is rendered. */
export function browserDeps(): RenderDeps {
  return {
    createImageBitmap: createImageBitmap.bind(globalThis),
    createCanvas: (width, height) => new OffscreenCanvas(width, height),
    heicDecoder: decodeHeic,
  };
}

const RESIZE_OPTIONS = ['resizeWidth', 'resizeHeight', 'resizeQuality'] as const;

/**
 * True when this browser's `createImageBitmap` reads the resize options. It is called once with
 * an options object that records which options were looked at; a browser that does not know an
 * option never looks at it.
 */
export function supportsCropResize(deps: Pick<RenderDeps, 'createImageBitmap' | 'createCanvas'>) {
  const read = new Set<string>();
  const options = {
    get resizeWidth() {
      read.add('resizeWidth');
      return 1;
    },
    get resizeHeight() {
      read.add('resizeHeight');
      return 1;
    },
    get resizeQuality(): ResizeQuality {
      read.add('resizeQuality');
      return 'high';
    },
  };
  try {
    const probe = deps.createCanvas(1, 1) as unknown as ImageBitmapSource;
    deps.createImageBitmap(probe, 0, 0, 1, 1, options).then(
      (bitmap) => bitmap.close(),
      () => undefined,
    );
  } catch {
    return false;
  }
  return RESIZE_OPTIONS.every((option) => read.has(option));
}

const MIME: Record<OutputFormat, string> = { jpg: 'image/jpeg', png: 'image/png' };
const FORMAT_LABEL: Record<OutputFormat, string> = { jpg: 'JPG', png: 'PNG' };
/** JPG has no transparency, so transparent parts of the source are filled with this. */
export const JPG_BACKGROUND = '#ffffff';

function sizeChangedMessage(job: RenderJob, bitmap: ImageBitmap): string {
  const { width, height } = job.plan.sourceSize;
  return (
    `"${job.fileName}" opens as ${bitmap.width} x ${bitmap.height} pixels in this browser, but ` +
    `it was ${width} x ${height} when it was imported, so its crop no longer fits. ` +
    'Try the browser you imported it with, or open it in a photo app, save a new copy as JPG, ' +
    'and import that copy.'
  );
}

function canvasMessage(fileName: string): string {
  return (
    `"${fileName}" could not be resized. The browser may be short of memory. ` +
    'Close other tabs or programs and try again.'
  );
}

function encodeMessage(fileName: string, format: OutputFormat): string {
  return (
    `"${fileName}" was resized but could not be saved as ${FORMAT_LABEL[format]}. ` +
    'Try again, or choose the other file format.'
  );
}

/** A bitmap ready to draw, and the part of it that goes into the output. */
type Drawable = { bitmap: ImageBitmap; from: PixelRect };

/** Renders one job. Rejects only with a RenderError, whose message is written for the user. */
export type ImageRenderer = (
  job: RenderJob,
  onStage?: (stage: RenderStage) => void,
) => Promise<RenderResult>;

export function createImageRenderer(deps: RenderDeps = browserDeps()): ImageRenderer {
  let cropResize: boolean | undefined;
  const canCropResize = () => (cropResize ??= supportsCropResize(deps));

  /** Decode, crop and resize in one step. Null when that did not give the planned bitmap. */
  async function cropResizeDecode({ blob, plan }: RenderJob): Promise<ImageBitmap | null> {
    const { crop, target } = plan;
    let bitmap: ImageBitmap;
    try {
      bitmap = await deps.createImageBitmap(blob, crop.x, crop.y, crop.width, crop.height, {
        imageOrientation: 'from-image',
        resizeWidth: target.width,
        resizeHeight: target.height,
        resizeQuality: 'high',
      });
    } catch {
      return null;
    }
    if (bitmap.width === target.width && bitmap.height === target.height) return bitmap;
    bitmap.close();
    return null;
  }

  /** Decodes the whole photo in displayed orientation. */
  async function fullDecode(job: RenderJob): Promise<ImageBitmap> {
    const { blob, fileName, sourceFormat, plan } = job;
    let bitmap: ImageBitmap;
    try {
      bitmap =
        sourceFormat === 'heic'
          ? await deps.heicDecoder(blob)
          : await deps.createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      throw sourceFormat === 'heic'
        ? new RenderError('heic', heicMessage(fileName))
        : new RenderError('damaged', damagedMessage(fileName, sourceFormat));
    }
    if (bitmap.width === plan.sourceSize.width && bitmap.height === plan.sourceSize.height) {
      return bitmap;
    }
    const error = new RenderError('size-changed', sizeChangedMessage(job, bitmap));
    bitmap.close();
    throw error;
  }

  async function decode(job: RenderJob): Promise<Drawable> {
    if (job.sourceFormat !== 'heic' && canCropResize()) {
      const bitmap = await cropResizeDecode(job);
      if (bitmap) {
        return { bitmap, from: { x: 0, y: 0, width: bitmap.width, height: bitmap.height } };
      }
    }
    return { bitmap: await fullDecode(job), from: job.plan.crop };
  }

  function draw({ bitmap, from }: Drawable, plan: RenderPlan, fileName: string): RenderCanvas {
    const { width, height } = plan.target;
    try {
      const canvas = deps.createCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      if (plan.format === 'jpg') {
        context.fillStyle = JPG_BACKGROUND;
        context.fillRect(0, 0, width, height);
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, from.x, from.y, from.width, from.height, 0, 0, width, height);
      return canvas;
    } catch {
      throw new RenderError('canvas', canvasMessage(fileName));
    }
  }

  async function encode(
    canvas: RenderCanvas,
    plan: RenderPlan,
    fileName: string,
  ): Promise<{ blob: Blob; format: OutputFormat }> {
    let blob: Blob;
    try {
      // PNG is lossless, so it takes no quality.
      blob = await canvas.convertToBlob(
        plan.format === 'png'
          ? { type: MIME.png }
          : { type: MIME.jpg, quality: clampQuality(plan.quality) },
      );
    } catch {
      throw new RenderError('encode', encodeMessage(fileName, plan.format));
    }
    // A browser that cannot encode the type asked for returns another one, so the format is
    // read from the file that was actually made.
    const format = (['jpg', 'png'] as const).find((candidate) => MIME[candidate] === blob.type);
    if (!format || blob.size === 0) {
      throw new RenderError('encode', encodeMessage(fileName, plan.format));
    }
    return { blob, format };
  }

  async function render(job: RenderJob, onStage: (stage: RenderStage) => void) {
    onStage('decoding');
    const drawable = await decode(job);
    let canvas: RenderCanvas;
    try {
      onStage('drawing');
      canvas = draw(drawable, job.plan, job.fileName);
    } finally {
      drawable.bitmap.close();
    }
    onStage('encoding');
    const { blob, format } = await encode(canvas, job.plan, job.fileName);
    return {
      id: job.id,
      blob,
      width: canvas.width,
      height: canvas.height,
      bytes: blob.size,
      mimeType: blob.type,
      format,
      upscaled: job.plan.upscaled,
    };
  }

  return async (job, onStage = () => undefined) => {
    try {
      return await render(job, onStage);
    } catch (error) {
      if (error instanceof RenderError) throw error;
      throw unexpectedError(job.fileName);
    }
  };
}
