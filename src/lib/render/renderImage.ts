/**
 * Renders one image: decode the original file, crop and resize it to the planned output size,
 * fill any padding with the card's background colour, and encode it as JPG or PNG. Written to
 * run inside the image worker, but nothing here depends on being in one: the browser functions
 * it uses are passed in, so tests can replace them.
 *
 * The whole photo is decoded, then `drawImage` crops and scales it in one go with high-quality
 * smoothing. `createImageBitmap` can also crop and resize while decoding, which would avoid
 * holding the full-size bitmap, but in Chromium that route takes the crop from the wrong place
 * for photos stored with a rotation, and shrinks a cropped photo with a coarse filter that
 * leaves fine detail jagged. It is not used.
 *
 * The output is the crop. Where the crop reaches past the photo there is padding in the plan's
 * background colour, and only the part of the crop that overlaps the photo is read from the
 * photo. A JPG is filled with the colour all over first, so transparent parts of the photo take
 * it too. A PNG has only its padding filled, so the photo keeps its own transparency.
 *
 * Orientation is handled as at import (`imageOrientation: 'from-image'`; the HEIC decoder
 * applies it itself), and the decoded size is checked against the size recorded at import, so
 * a crop always lines up with the photo it was planned for. The bitmap is closed before this
 * returns, whether the render worked or not.
 */

import { damagedMessage, heicMessage } from '../image/decode';
import { decodeHeic } from '../image/heic';
import type { HeicDecoder } from '../image/heic';
import { drawRects, paddingRects } from './crop';
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

const MIME: Record<OutputFormat, string> = { jpg: 'image/jpeg', png: 'image/png' };
const FORMAT_LABEL: Record<OutputFormat, string> = { jpg: 'JPG', png: 'PNG' };

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

/** Renders one job. Rejects only with a RenderError, whose message is written for the user. */
export type ImageRenderer = (
  job: RenderJob,
  onStage?: (stage: RenderStage) => void,
) => Promise<RenderResult>;

export function createImageRenderer(deps: RenderDeps = browserDeps()): ImageRenderer {
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

  function draw(bitmap: ImageBitmap, plan: RenderPlan, fileName: string): RenderCanvas {
    const { target } = plan;
    const { source, dest } = drawRects(plan.crop, plan.sourceSize, target);
    try {
      const canvas = deps.createCanvas(target.width, target.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      if (plan.format === 'jpg') {
        // JPG has no transparency: the colour goes everywhere, under the photo as well.
        context.fillStyle = plan.background;
        context.fillRect(0, 0, target.width, target.height);
      } else {
        // PNG keeps the photo's transparency: only the padding is coloured.
        const padding = paddingRects(dest, target);
        if (padding.length > 0) context.fillStyle = plan.background;
        for (const strip of padding) context.fillRect(strip.x, strip.y, strip.width, strip.height);
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(
        bitmap,
        source.x,
        source.y,
        source.width,
        source.height,
        dest.x,
        dest.y,
        dest.width,
        dest.height,
      );
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
    const bitmap = await fullDecode(job);
    let canvas: RenderCanvas;
    try {
      onStage('drawing');
      canvas = draw(bitmap, job.plan, job.fileName);
    } finally {
      bitmap.close();
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
