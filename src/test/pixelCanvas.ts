/**
 * A small canvas that keeps real pixels, for testing the renderer's drawing without a browser.
 * It does the three things the renderer asks of a canvas: fill a rectangle with a "#rrggbb"
 * colour, draw part of a picture into a rectangle, and hand back a file. Pictures are sampled
 * at the nearest source pixel and drawn over what is already there, so a transparent source
 * pixel leaves the canvas as it was, as in a browser.
 *
 * It is strict where a browser is forgiving: drawing from outside the picture, or with a
 * rectangle that is not whole pixels, throws. A test that passes has not done either.
 */

import type { RenderCanvas } from '../lib/render/renderImage';

/** Red, green, blue and alpha, each 0..255. */
export type Rgba = [number, number, number, number];

/** A picture whose pixels are worked out when asked for, so a large one costs no memory. */
export type PixelBitmap = ImageBitmap & { colourAt: (x: number, y: number) => Rgba };

export function pixelBitmap(
  width: number,
  height: number,
  colourAt: (x: number, y: number) => Rgba,
): PixelBitmap {
  return { width, height, close: () => undefined, colourAt } as unknown as PixelBitmap;
}

const MIME_TO_FORMAT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png' };

export type PixelCanvas = {
  canvas: RenderCanvas;
  /** The colour of one pixel. A pixel nothing has touched is transparent black. */
  pixel: (x: number, y: number) => Rgba;
  /** Every pixel, four bytes each, row by row. */
  data: Uint8ClampedArray;
  /** The source rectangle of each drawImage call: x, y, width, height. */
  sourceRects: [number, number, number, number][];
  /** The type and quality the file was asked for. */
  encodedAs: () => ImageEncodeOptions | undefined;
};

function parseColour(style: string): Rgba {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(style);
  if (!match) throw new Error(`the test canvas only knows "#rrggbb" colours, not "${style}"`);
  const [, red, green, blue] = match as unknown as [string, string, string, string];
  return [Number.parseInt(red, 16), Number.parseInt(green, 16), Number.parseInt(blue, 16), 255];
}

function mustBeWhole(name: string, values: number[]) {
  if (!values.every((value) => Number.isInteger(value))) {
    throw new Error(`${name} must be whole pixels, got ${values.join(', ')}`);
  }
}

export function pixelCanvas(width: number, height: number): PixelCanvas {
  const data = new Uint8ClampedArray(width * height * 4);
  const sourceRects: [number, number, number, number][] = [];
  let fill: Rgba = [0, 0, 0, 255];
  let encoded: ImageEncodeOptions | undefined;

  const context = {
    set fillStyle(value: string) {
      fill = parseColour(value);
    },
    set imageSmoothingEnabled(_value: boolean) {
      // Sampling here is always nearest-pixel.
    },
    set imageSmoothingQuality(_value: string) {
      // As above.
    },
    fillRect(x: number, y: number, w: number, h: number) {
      mustBeWhole('fillRect', [x, y, w, h]);
      if (x < 0 || y < 0 || x + w > width || y + h > height) {
        throw new Error(
          `fillRect ${x}, ${y}, ${w}, ${h} is outside the ${width} x ${height} canvas`,
        );
      }
      for (let row = y; row < y + h; row++) {
        for (let column = x; column < x + w; column++) data.set(fill, (row * width + column) * 4);
      }
    },
    drawImage(
      bitmap: PixelBitmap,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) {
      mustBeWhole('drawImage', [sx, sy, sw, sh, dx, dy, dw, dh]);
      if (
        sx < 0 ||
        sy < 0 ||
        sw < 1 ||
        sh < 1 ||
        sx + sw > bitmap.width ||
        sy + sh > bitmap.height
      ) {
        throw new Error(
          `drawImage reads ${sx}, ${sy}, ${sw}, ${sh}, which is outside the ` +
            `${bitmap.width} x ${bitmap.height} picture`,
        );
      }
      if (dx < 0 || dy < 0 || dx + dw > width || dy + dh > height) {
        throw new Error(`drawImage draws outside the ${width} x ${height} canvas`);
      }
      sourceRects.push([sx, sy, sw, sh]);
      for (let row = 0; row < dh; row++) {
        const fromY = sy + Math.min(sh - 1, Math.floor(((row + 0.5) * sh) / dh));
        for (let column = 0; column < dw; column++) {
          const fromX = sx + Math.min(sw - 1, Math.floor(((column + 0.5) * sw) / dw));
          const [red, green, blue, alpha] = bitmap.colourAt(fromX, fromY);
          const at = ((dy + row) * width + dx + column) * 4;
          const under = (data[at + 3] as number) / 255;
          const over = alpha / 255;
          const out = over + under * (1 - over);
          const mix = (top: number, below: number) =>
            out === 0 ? 0 : Math.round((top * over + below * under * (1 - over)) / out);
          data[at] = mix(red, data[at] as number);
          data[at + 1] = mix(green, data[at + 1] as number);
          data[at + 2] = mix(blue, data[at + 2] as number);
          data[at + 3] = Math.round(out * 255);
        }
      }
    },
  };

  const canvas = {
    width,
    height,
    getContext: () => context,
    convertToBlob: (options?: ImageEncodeOptions) => {
      encoded = options;
      // Not a real picture file: the type is all the renderer reads back from it.
      const type = options?.type ?? 'image/png';
      return Promise.resolve(new Blob([MIME_TO_FORMAT[type] ?? 'unknown'], { type }));
    },
  } as unknown as RenderCanvas;

  return {
    canvas,
    data,
    sourceRects,
    pixel: (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) throw new Error(`no pixel at ${x}, ${y}`);
      return [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] as Rgba;
    },
    encodedAs: () => encoded,
  };
}
