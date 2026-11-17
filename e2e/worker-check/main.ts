/**
 * Development-only page that runs the image worker in a real browser. It is opened by
 * e2e/image-worker.check.mjs and is never part of the site build.
 *
 * Every picture used here is made by code: a colour gradient where red rises left to right and
 * green rises top to bottom. Because a pixel's colour says where in the source it came from,
 * reading a few pixels of an output shows exactly which part of the photo was cropped, and
 * whether it is the right way up. Output sizes are read from platforms.json.
 */

import heicUrl from '../fixtures/gradient.heic?url';
import { sniffBlob } from '../../src/lib/image/fileType';
import { importFile } from '../../src/lib/image/importFiles';
import { getPlacement } from '../../src/lib/platforms';
import { createImageWorkerClient } from '../../src/lib/render/client';
import { planRender } from '../../src/lib/render/plan';
import type { RenderPlan } from '../../src/lib/render/plan';
import type { RenderJob } from '../../src/lib/render/protocol';
import { renderValidationFields } from '../../src/lib/render/validation';
import { validate } from '../../src/lib/validate';
import type { Asset, ImageEdit, PlacementSpec, Platform } from '../../src/types';

const BLUE = 128;
/** Colour difference allowed for lossy encoding and resampling, out of 255. */
const TOLERANCE = 10;
/** The transparent hole in the PNG fixture, in fractions of the picture. */
const HOLE = { x0: 0.4, x1: 0.6, y0: 0.4, y1: 0.6 };

type Rgba = [number, number, number, number];
type Check = { name: string; ok: boolean; detail: string };
type CaseReport = { name: string; ok: boolean; checks: Check[]; info: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Fixtures, all generated
// ---------------------------------------------------------------------------

function gradientCanvas(width: number, height: number, hole = false): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fx = (x + 0.5) / width;
      const fy = (y + 0.5) / height;
      const inHole = hole && fx > HOLE.x0 && fx < HOLE.x1 && fy > HOLE.y0 && fy < HOLE.y1;
      image.data.set(
        [Math.round(255 * fx), Math.round(255 * fy), BLUE, inHole ? 0 : 255],
        (y * width + x) * 4,
      );
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function asFile(blob: Blob, name: string): File {
  return new File([blob], name, { type: blob.type });
}

async function jpgFixture(): Promise<File> {
  const blob = await gradientCanvas(2400, 1800).convertToBlob({
    type: 'image/jpeg',
    quality: 0.95,
  });
  return asFile(blob, 'gradient.jpg');
}

async function pngFixture(): Promise<File> {
  const blob = await gradientCanvas(2400, 1800, true).convertToBlob({ type: 'image/png' });
  return asFile(blob, 'gradient-with-hole.png');
}

/**
 * A JPG stored on its side with an orientation tag, as phones write them. Shown the right way
 * up it is the same 2400 x 1800 gradient; the stored pixels are 1800 x 2400. The only metadata
 * added is the orientation tag itself.
 */
async function rotatedJpgFixture(): Promise<File> {
  const upright = gradientCanvas(2400, 1800);
  const stored = new OffscreenCanvas(1800, 2400);
  const context = stored.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.translate(0, 2400);
  context.rotate(-Math.PI / 2);
  context.drawImage(upright, 0, 0);
  const jpeg = new Uint8Array(
    await (await stored.convertToBlob({ type: 'image/jpeg', quality: 0.95 })).arrayBuffer(),
  );
  // An Exif block holding one tag: Orientation (0x0112) = 6, "turn 90 degrees clockwise".
  const exif = new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const bytes = new Uint8Array(jpeg.length + exif.length);
  bytes.set(jpeg.subarray(0, 2), 0);
  bytes.set(exif, 2);
  bytes.set(jpeg.subarray(2), 2 + exif.length);
  return new File([bytes], 'gradient-rotated.jpg', { type: 'image/jpeg' });
}

async function heicFixture(): Promise<File> {
  const blob = await (await fetch(heicUrl)).blob();
  return new File([blob], 'gradient.heic', { type: 'image/heic' });
}

/** Gratings in the large test picture: line spacing in source pixels, and where each block is. */
const GRATINGS = [2, 3, 4, 6, 8].map((period, index) => ({
  period,
  x: 1900 + index * 860,
  y: 400,
  size: 760,
}));

/**
 * A 48-megapixel picture full of fine detail, the hardest case for shrinking: blocks of thin
 * black and white lines, a star of narrow wedges, thin diagonal lines and small text. Shrunk
 * well, the line blocks turn an even grey; shrunk badly they show bands and ripples.
 */
async function largeFixture(): Promise<File> {
  const width = 8064;
  const height = 6048;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#000000';
  for (const { period, x, y, size } of GRATINGS) {
    for (let offset = 0; offset < size; offset += period) {
      context.fillRect(x + offset, y, Math.max(1, period / 2), size); // vertical lines
      context.fillRect(x, y + size + 100 + offset, size, Math.max(1, period / 2)); // horizontal
    }
  }
  const cx = width / 2;
  const cy = 3900;
  const spokes = 144;
  for (let i = 0; i < spokes; i++) {
    const a0 = (i * 2 * Math.PI) / spokes;
    const a1 = a0 + Math.PI / spokes;
    context.beginPath();
    context.moveTo(cx, cy);
    context.arc(cx, cy, 1500, a0, a1);
    context.closePath();
    context.fill();
  }
  context.lineWidth = 2;
  for (let i = 0; i < 120; i++) {
    context.beginPath();
    context.moveTo(1800, 5500 + i * 3);
    context.lineTo(6200, 5560 + i * 7);
    context.stroke();
  }
  for (const [index, size] of [24, 36, 48, 72, 96].entries()) {
    context.font = `${size}px sans-serif`;
    context.fillText('Fine detail 0123456789 ABCDEFG abcdefg', 1900, 2300 + index * 110);
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  return asFile(blob, 'large-48mp.jpg');
}

// ---------------------------------------------------------------------------
// Reading results back
// ---------------------------------------------------------------------------

async function decodeOutput(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2d context');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { width: canvas.width, height: canvas.height, context };
}

/** The average colour of a 5 x 5 patch centred on a point given in fractions of the picture. */
function colourAt(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  u: number,
  v: number,
): Rgba {
  const x = Math.min(width - 5, Math.max(0, Math.round(u * width) - 2));
  const y = Math.min(height - 5, Math.max(0, Math.round(v * height) - 2));
  const { data } = context.getImageData(x, y, 5, 5);
  const sum = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i++) sum[i % 4] = (sum[i % 4] as number) + (data[i] as number);
  return sum.map((total) => Math.round(total / 25)) as Rgba;
}

/** The colour the output should have at (u, v), given which part of the source was cropped. */
function expectedColour(
  plan: RenderPlan,
  u: number,
  v: number,
  hole: boolean,
  format: string,
): Rgba {
  const fx = plan.cropRect.x + u * plan.cropRect.width;
  const fy = plan.cropRect.y + v * plan.cropRect.height;
  if (hole && fx > HOLE.x0 && fx < HOLE.x1 && fy > HOLE.y0 && fy < HOLE.y1) {
    return format === 'png' ? [0, 0, 0, 0] : [255, 255, 255, 255];
  }
  return [Math.round(255 * fx), Math.round(255 * fy), BLUE, 255];
}

const SAMPLE_POINTS: [number, number][] = [
  [0.08, 0.08],
  [0.92, 0.08],
  [0.5, 0.5],
  [0.08, 0.92],
  [0.92, 0.92],
  [0.3, 0.7],
];

function nearHoleEdge(plan: RenderPlan, u: number, v: number): boolean {
  const fx = plan.cropRect.x + u * plan.cropRect.width;
  const fy = plan.cropRect.y + v * plan.cropRect.height;
  const near = (value: number, edge: number) => Math.abs(value - edge) < 0.02;
  return near(fx, HOLE.x0) || near(fx, HOLE.x1) || near(fy, HOLE.y0) || near(fy, HOLE.y1);
}

async function comparePixels(blob: Blob, plan: RenderPlan, hole: boolean, format: string) {
  const { width, height, context } = await decodeOutput(blob);
  let worst = 0;
  const samples = SAMPLE_POINTS.filter(([u, v]) => !(hole && nearHoleEdge(plan, u, v))).map(
    ([u, v]) => {
      const got = colourAt(context, width, height, u, v);
      const want = expectedColour(plan, u, v, hole, format);
      const channels = want[3] === 0 ? [3] : [0, 1, 2, 3];
      const diff = Math.max(
        ...channels.map((c) => Math.abs((got[c] as number) - (want[c] as number))),
      );
      worst = Math.max(worst, diff);
      return { at: [u, v], want, got, diff };
    },
  );
  return { width, height, worst, samples };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const client = createImageWorkerClient();

function placement(platform: Platform, key: string): PlacementSpec {
  const spec = getPlacement(platform, key);
  if (!spec) throw new Error(`platforms.json has no ${platform} ${key}`);
  return spec;
}

/** The two placements of the Phase 1 gate; their sizes come from platforms.json. */
const PLACEMENTS = () => [
  placement('instagram', 'feed-vertical'),
  placement('linkedin', 'image-square'),
];

async function importAsset(file: File): Promise<{ asset: Asset; blob: Blob }> {
  const outcome = await importFile(file, { assets: [], missingAssetIds: [] });
  if (outcome.status !== 'imported') throw new Error(`import failed: ${outcome.message}`);
  return { asset: outcome.asset, blob: outcome.blob };
}

let jobCount = 0;

function makeJob(
  file: File,
  blob: Blob,
  plan: RenderPlan,
  sourceFormat: RenderJob['sourceFormat'],
): RenderJob {
  jobCount += 1;
  return { id: `job-${jobCount}`, blob, fileName: file.name, sourceFormat, plan };
}

async function checkRender(
  label: string,
  file: File,
  sourceFormat: RenderJob['sourceFormat'],
  spec: PlacementSpec,
  options: {
    hole?: boolean;
    edit?: Partial<Pick<ImageEdit, 'format' | 'quality'>>;
    focal?: Asset['focal'];
  } = {},
): Promise<CaseReport> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const info: Record<string, unknown> = {};
  try {
    const imported = await importAsset(file);
    const asset = { ...imported.asset, focal: options.focal ?? imported.asset.focal };
    const plan = planRender({ asset, spec, edit: options.edit });
    const wanted = spec.sizes[0];
    if (!wanted) throw new Error('placement has no size');
    const stages: string[] = [];
    const started = performance.now();
    const result = await client.render(makeJob(file, imported.blob, plan, sourceFormat), (stage) =>
      stages.push(stage),
    );
    info.ms = Math.round(performance.now() - started);
    info.importedSize = `${asset.width} x ${asset.height}`;
    info.crop = plan.crop;
    info.bytes = result.bytes;
    info.upscaled = result.upscaled;
    info.stages = stages.join(' > ');

    const format = options.edit?.format ?? 'jpg';
    const pixels = await comparePixels(result.blob, plan, options.hole ?? false, format);
    add(
      'decoded output size matches platforms.json',
      pixels.width === wanted.width && pixels.height === wanted.height,
      `${pixels.width} x ${pixels.height}, wanted ${wanted.width} x ${wanted.height}`,
    );
    const sniffed = await sniffBlob(result.blob, 'output');
    const sniffedFormat = sniffed.kind === 'image' ? sniffed.format : sniffed.kind;
    const wantSniff = format === 'jpg' ? 'jpeg' : 'png';
    add(
      'file type, from the bytes and from the result',
      sniffedFormat === wantSniff &&
        result.format === format &&
        result.mimeType === result.blob.type,
      `bytes say ${sniffedFormat}, result says ${result.format} (${result.mimeType})`,
    );
    const validation = validate(
      {
        ...renderValidationFields(
          { width: pixels.width, height: pixels.height, bytes: result.blob.size },
          plan,
          asset.focal,
        ),
        caption: '',
        hashtags: [],
      },
      spec,
    );
    const sizeIssues = validation.issues.filter((issue) => issue.rule === 1 || issue.rule === 2);
    add(
      'validate() raises no rule 1 or rule 2 issue',
      sizeIssues.length === 0,
      JSON.stringify(sizeIssues),
    );
    add(
      'pixels come from the planned crop, the right way up',
      pixels.worst <= TOLERANCE,
      `largest colour difference ${pixels.worst} of 255 (allowed ${TOLERANCE})`,
    );
    info.samples = pixels.samples;
    add(
      'progress ran queued to done',
      stages.join(',') === 'queued,decoding,drawing,encoding,done',
      stages.join(','),
    );
  } catch (error) {
    add(
      'completed',
      false,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
  return {
    name: `${label} -> ${spec.platform} ${spec.placement}`,
    ok: checks.every((c) => c.ok),
    checks,
    info,
  };
}

async function checkFocal(file: File, spec: PlacementSpec): Promise<CaseReport> {
  const checks: Check[] = [];
  const info: Record<string, unknown> = {};
  try {
    const { asset, blob } = await importAsset(file);
    const centres: number[] = [];
    for (const x of [0.2, 0.8]) {
      const plan = planRender({ asset: { ...asset, focal: { x, y: 0.5 } }, spec });
      const result = await client.render(makeJob(file, blob, plan, 'jpeg'));
      const { width, height, context } = await decodeOutput(result.blob);
      const [red] = colourAt(context, width, height, 0.5, 0.5);
      centres.push(red);
      info[`focal x ${x}`] = {
        cropX: plan.crop.x,
        centreRed: red,
        expectedRed: Math.round(255 * (plan.cropRect.x + plan.cropRect.width / 2)),
      };
    }
    const [left, right] = centres as [number, number];
    checks.push({
      name: 'moving the focal point right moves the crop right',
      ok: right - left > 40,
      detail: `red at the centre of the output: ${left} with the focal point at the left, ${right} at the right`,
    });
  } catch (error) {
    checks.push({ name: 'completed', ok: false, detail: String(error) });
  }
  return {
    name: `focal point -> ${spec.platform} ${spec.placement}`,
    ok: checks.every((c) => c.ok),
    checks,
    info,
  };
}

async function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

/** How uneven each line block is in the output: 0 is a perfectly even grey. */
async function gratingUnevenness(blob: Blob, plan: RenderPlan) {
  const { context } = await decodeOutput(blob);
  const scale = plan.target.width / plan.crop.width;
  return GRATINGS.map(({ period, x, y, size }) => {
    const inset = 60;
    const left = Math.round((x + inset - plan.crop.x) * scale);
    const top = Math.round((y + inset - plan.crop.y) * scale);
    const side = Math.floor((size - 2 * inset) * scale);
    const { data } = context.getImageData(left, top, side, side);
    let sum = 0;
    let squares = 0;
    const count = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const luma =
        0.299 * (data[i] as number) +
        0.587 * (data[i + 1] as number) +
        0.114 * (data[i + 2] as number);
      sum += luma;
      squares += luma * luma;
    }
    const mean = sum / count;
    return {
      linesEverySourcePixels: period,
      meanGrey: Math.round(mean),
      unevenness: Math.round(Math.sqrt(Math.max(0, squares / count - mean * mean)) * 10) / 10,
    };
  });
}

async function checkLarge(spec: PlacementSpec) {
  const info: Record<string, unknown> = {};
  const checks: Check[] = [];
  const images: Record<string, string> = {};
  try {
    let started = performance.now();
    const file = await largeFixture();
    info.generateMs = Math.round(performance.now() - started);
    info.sourceBytes = file.size;
    started = performance.now();
    const { asset, blob } = await importAsset(file);
    info.importMs = Math.round(performance.now() - started);
    info.megapixels = Math.round((asset.width * asset.height) / 100_000) / 10;
    info.sourceSize = `${asset.width} x ${asset.height}`;
    const plan = planRender({ asset, spec });
    info.crop = plan.crop;
    info.shrinkFactor = Math.round((plan.crop.width / plan.target.width) * 100) / 100;

    started = performance.now();
    const viaWorker = await client.render(makeJob(file, blob, plan, 'jpeg'));
    info.workerRenderMs = Math.round(performance.now() - started);
    const decoded = await decodeOutput(viaWorker.blob);
    checks.push({
      name: 'the 48-megapixel photo renders in the worker at the planned size',
      ok: decoded.width === plan.target.width && decoded.height === plan.target.height,
      detail: `${decoded.width} x ${decoded.height} in ${String(info.workerRenderMs)} ms, ${viaWorker.bytes} bytes`,
    });
    info.gratings = await gratingUnevenness(viaWorker.blob, plan);
    images['large-48mp-to-1080.jpg'] = await toDataUrl(viaWorker.blob);
  } catch (error) {
    checks.push({ name: 'completed', ok: false, detail: String(error) });
  }
  const report: CaseReport = {
    name: `large photo -> ${spec.platform} ${spec.placement}`,
    ok: checks.every((c) => c.ok),
    checks,
    info,
  };
  return { report, images };
}

async function runAll(options: { large?: boolean } = {}) {
  const reports: CaseReport[] = [];
  const images: Record<string, string> = {};
  const [jpg, png, rotated, heic] = await Promise.all([
    jpgFixture(),
    pngFixture(),
    rotatedJpgFixture(),
    heicFixture(),
  ]);
  const placements = PLACEMENTS();
  const [vertical] = placements;
  if (!vertical) throw new Error('no placement');

  for (const spec of placements) {
    reports.push(await checkRender('JPG', jpg, 'jpeg', spec));
    reports.push(await checkRender('JPG as PNG', jpg, 'jpeg', spec, { edit: { format: 'png' } }));
    reports.push(
      await checkRender('transparent PNG as JPG (white fill)', png, 'png', spec, { hole: true }),
    );
    reports.push(
      await checkRender('transparent PNG as PNG', png, 'png', spec, {
        hole: true,
        edit: { format: 'png' },
      }),
    );
    reports.push(await checkRender('EXIF-rotated JPG', rotated, 'jpeg', spec));
    reports.push(
      await checkRender('EXIF-rotated JPG, focal point off-centre', rotated, 'jpeg', spec, {
        focal: { x: 0.85, y: 0.3 },
      }),
    );
    reports.push(
      await checkRender('EXIF-rotated JPG, focal point in a corner', rotated, 'jpeg', spec, {
        focal: { x: 0, y: 1 },
      }),
    );
    reports.push(await checkRender('HEIC', heic, 'heic', spec));
    reports.push(await checkFocal(jpg, spec));
  }
  if (options.large) {
    const large = await checkLarge(vertical);
    reports.push(large.report);
    Object.assign(images, large.images);
  }
  client.dispose();
  return { ok: reports.every((report) => report.ok), reports, images };
}

(window as unknown as { runImageWorkerChecks: typeof runAll }).runImageWorkerChecks = runAll;
