import { makeAsset } from '../../test/fixtures';
import type { PlacementSpec } from '../../types';
import { platforms } from '../platforms';
import { validate } from '../validate';
import { PADDING_TOLERANCE, centredOnPhoto, cropToPixels, fitSize, focalInFrame } from './crop';
import {
  DEFAULT_QUALITY,
  MAX_SOURCE_PIXELS,
  RenderPlanError,
  defaultCrop,
  isImagePlacement,
  planRender,
  targetSize,
} from './plan';
import { renderValidationFields } from './validation';

// Every expectation about a platform is read from platforms.json; none is typed in here.
const imagePlacements = platforms.placements.filter(isImagePlacement);
const videoOnly = platforms.placements.filter((spec) => !isImagePlacement(spec));
const name = (spec: PlacementSpec) => `${spec.platform} ${spec.placement}`;
const first = <T>(items: T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error('platforms.json has no such placement');
  return item;
};
const anyImage = first(imagePlacements);

const sources = [
  { width: 4032, height: 3024 },
  { width: 3024, height: 4032 },
  { width: 2000, height: 2000 },
  { width: 6000, height: 1000 },
  { width: 320, height: 240 },
];
const focals = [
  { x: 0.5, y: 0.5 },
  { x: 0, y: 0 },
  { x: 1, y: 1 },
  { x: 0.67, y: 0.2 },
];

function failureOf(run: () => unknown): RenderPlanError {
  try {
    run();
  } catch (error) {
    if (error instanceof RenderPlanError) return error;
  }
  throw new Error('expected a RenderPlanError');
}

describe('isImagePlacement', () => {
  it('finds both image and video-only placements in platforms.json', () => {
    expect(imagePlacements.length).toBeGreaterThan(0);
    expect(videoOnly.length).toBeGreaterThan(0);
  });

  it('accepts posts, carousel slides and document pages, and rejects video-only placements', () => {
    for (const type of ['image', 'image-set', 'pdf'] as const) {
      expect(isImagePlacement({ ...anyImage, mediaTypes: [type] })).toBe(true);
    }
    expect(isImagePlacement({ ...anyImage, mediaTypes: ['video'] })).toBe(false);
    expect(isImagePlacement({ ...anyImage, mediaTypes: ['video', 'image'] })).toBe(true);
  });
});

describe('targetSize', () => {
  it('returns a copy of the listed size', () => {
    const listed = first(anyImage.sizes);
    expect(targetSize(anyImage)).toEqual(listed);
    expect(targetSize(anyImage)).not.toBe(listed);
  });

  it('returns the size at the given index', () => {
    const multi = first(platforms.placements.filter((spec) => spec.sizes.length > 1));
    expect(targetSize(multi, 1)).toEqual(multi.sizes[1]);
  });

  it('throws a plain-language error for a size that is not listed', () => {
    const error = failureOf(() => targetSize(anyImage, anyImage.sizes.length));
    expect(error.reason).toBe('no-such-size');
    expect(error.name).toBe('RenderPlanError');
    expect(error.message).toContain(anyImage.label);
  });
});

describe('planRender for every image placement in platforms.json', () => {
  describe.each(imagePlacements.map((spec) => [name(spec), spec] as const))('%s', (_name, spec) => {
    it('plans the exact listed size, which passes the dimension rule', () => {
      for (const source of sources) {
        for (const focal of focals) {
          const asset = makeAsset({ ...source, focal });
          const plan = planRender({ asset, spec });
          expect(plan.target).toEqual(first(spec.sizes));

          const fields = renderValidationFields({ ...plan.target, bytes: 1 }, plan, asset.focal);
          const result = validate({ ...fields, caption: '', hashtags: [] }, spec);
          expect(result.issues.filter((issue) => issue.rule === 1)).toEqual([]);
        }
      }
    });

    it('keeps the crop inside the photo, in the target shape, using its full width or height', () => {
      const target = first(spec.sizes);
      for (const source of sources) {
        for (const focal of focals) {
          const { crop } = planRender({ asset: makeAsset({ ...source, focal }), spec });
          expect(crop.x).toBeGreaterThanOrEqual(0);
          expect(crop.y).toBeGreaterThanOrEqual(0);
          expect(crop.x + crop.width).toBeLessThanOrEqual(source.width);
          expect(crop.y + crop.height).toBeLessThanOrEqual(source.height);
          expect(crop.width === source.width || crop.height === source.height).toBe(true);
          // Within one source pixel of the target shape.
          expect(Math.abs(crop.width - (crop.height * target.width) / target.height)).toBeLessThan(
            1,
          );
        }
      }
    });
  });
});

describe('planRender', () => {
  const asset = makeAsset({ width: 4032, height: 3024, focal: { x: 0.5, y: 0.5 } });

  it('uses the default crop from the focal point when the edit has no crop', () => {
    const plan = planRender({ asset, spec: anyImage });
    expect(plan.cropRect).toEqual(defaultCrop(asset, anyImage));
    expect(plan.sourceSize).toEqual({ width: 4032, height: 3024 });
  });

  it('moves the crop when the focal point moves', () => {
    const tall = first(
      imagePlacements.filter((spec) => {
        const size = first(spec.sizes);
        return size.height > size.width;
      }),
    );
    const left = planRender({ asset: { ...asset, focal: { x: 0.2, y: 0.5 } }, spec: tall });
    const right = planRender({ asset: { ...asset, focal: { x: 0.8, y: 0.5 } }, spec: tall });
    expect(right.crop.x).toBeGreaterThan(left.crop.x);
    expect(right.crop.width).toBe(left.crop.width);
  });

  it("fits the card's own crop to the target shape instead of stretching it", () => {
    const target = first(anyImage.sizes);
    const plan = planRender({
      asset,
      spec: anyImage,
      edit: { crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
    });
    expect(plan.crop.x).toBeGreaterThanOrEqual(2016);
    expect(plan.crop.y).toBeGreaterThanOrEqual(1512);
    expect(plan.crop.width / plan.crop.height).toBeCloseTo(target.width / target.height, 2);
  });

  describe.each(sources)(
    'a saved crop that breaks the crop limits, on a $width x $height photo',
    (source) => {
      const photo = makeAsset(source);

      it.each(imagePlacements.map((spec) => [name(spec), spec] as const))(
        'is rendered corrected for %s, and the card is left as it was',
        (_name, spec) => {
          const ratio = targetSize(spec).width / targetSize(spec).height;
          const frame = centredOnPhoto(fitSize(source, ratio));
          // Three times the fit size and far off to one side; and, where the fit size has
          // padding, the fit size itself placed off-centre.
          const tooLarge = { x: -3, y: 2.5, width: frame.width * 3, height: frame.height * 3 };
          const offCentre = { ...frame, x: frame.x + 0.4, y: frame.y - 0.4 };
          const hasPadding = Math.max(frame.width, frame.height) > 1 + PADDING_TOLERANCE;
          const stored = hasPadding ? [tooLarge, offCentre] : [tooLarge];
          for (const crop of stored) {
            const edit = Object.freeze({ crop: Object.freeze({ ...crop }) });
            const plan = planRender({ asset: photo, spec, edit });
            // The corrected crop is the fit frame: the whole photo, centred.
            expect(plan.cropRect.x).toBeCloseTo(frame.x, 12);
            expect(plan.cropRect.y).toBeCloseTo(frame.y, 12);
            expect(plan.cropRect.width).toBeCloseTo(frame.width, 12);
            expect(plan.cropRect.height).toBeCloseTo(frame.height, 12);
            expect(plan.crop).toEqual(cropToPixels(frame, source));
            // The pixels hold the whole photo.
            expect(plan.crop.x).toBeLessThanOrEqual(0);
            expect(plan.crop.y).toBeLessThanOrEqual(0);
            expect(plan.crop.x + plan.crop.width).toBeGreaterThanOrEqual(source.width);
            expect(plan.crop.y + plan.crop.height).toBeGreaterThanOrEqual(source.height);
            // Planning only reads the card's edit: the stored crop is the same four numbers.
            expect(edit.crop).toEqual(crop);
          }
        },
      );
    },
  );

  it('plans a crop with padding as it is stored, in pixels that reach past the photo', () => {
    // A square from the 4000 x 3000 photo, showing all of it: 500 px of padding above and below.
    const square = first(
      imagePlacements.filter((spec) => targetSize(spec).width === targetSize(spec).height),
    );
    const photo = makeAsset({ width: 4000, height: 3000 });
    const crop = { x: 0, y: -1 / 6, width: 1, height: 4 / 3 };
    const plan = planRender({ asset: photo, spec: square, edit: { crop } });
    expect(plan.crop).toEqual({ x: 0, y: -500, width: 4000, height: 4000 });
    expect(plan.target).toEqual(targetSize(square));
    // Enlarged or not is worked out from the crop's size, padding included.
    expect(plan.upscaled).toBe(targetSize(square).width > 4000);
  });

  it("carries the card's background colour, in lowercase, and white without a usable one", () => {
    expect(planRender({ asset, spec: anyImage }).background).toBe('#ffffff');
    expect(planRender({ asset, spec: anyImage, background: undefined }).background).toBe('#ffffff');
    expect(planRender({ asset, spec: anyImage, background: '#0A7F5C' }).background).toBe('#0a7f5c');
    for (const unusable of ['0a7f5c', '#0af', '#0a7f5cff', 'white', '']) {
      expect(planRender({ asset, spec: anyImage, background: unusable }).background).toBe(
        '#ffffff',
      );
    }
  });

  it('plans the same crop, size, format and quality whatever the colour', () => {
    const plain = planRender({ asset, spec: anyImage });
    const coloured = planRender({ asset, spec: anyImage, background: '#0a7f5c' });
    expect({ ...coloured, background: plain.background }).toEqual(plain);
  });

  it('defaults to JPG at the default quality', () => {
    const plan = planRender({ asset, spec: anyImage });
    expect(plan.format).toBe('jpg');
    expect(plan.quality).toBe(DEFAULT_QUALITY);
  });

  it("takes the card's format and quality, keeping quality inside 0..1", () => {
    expect(planRender({ asset, spec: anyImage, edit: { format: 'png' } }).format).toBe('png');
    expect(planRender({ asset, spec: anyImage, edit: { quality: 0.5 } }).quality).toBe(0.5);
    expect(planRender({ asset, spec: anyImage, edit: { quality: 4 } }).quality).toBe(1);
    expect(planRender({ asset, spec: anyImage, edit: { quality: -1 } }).quality).toBe(0);
    expect(planRender({ asset, spec: anyImage, edit: { quality: Number.NaN } }).quality).toBe(
      DEFAULT_QUALITY,
    );
  });

  it('flags a render that has to enlarge the picture', () => {
    const target = first(anyImage.sizes);
    const big = makeAsset({ width: target.width * 3, height: target.height * 3 });
    const exact = makeAsset({ width: target.width, height: target.height });
    const narrow = makeAsset({ width: target.width - 1, height: target.height * 3 });
    const short = makeAsset({ width: target.width * 3, height: target.height - 1 });
    expect(planRender({ asset: big, spec: anyImage }).upscaled).toBe(false);
    expect(planRender({ asset: exact, spec: anyImage }).upscaled).toBe(false);
    expect(planRender({ asset: narrow, spec: anyImage }).upscaled).toBe(true);
    expect(planRender({ asset: short, spec: anyImage }).upscaled).toBe(true);
  });

  it('renders another listed size when asked', () => {
    const two = { ...anyImage, sizes: [first(anyImage.sizes), { width: 640, height: 480 }] };
    expect(planRender({ asset, spec: two, sizeIndex: 1 }).target).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('refuses a video asset', () => {
    const error = failureOf(() =>
      planRender({ asset: makeAsset({ kind: 'video', fileName: 'clip.mp4' }), spec: anyImage }),
    );
    expect(error.reason).toBe('not-image-asset');
    expect(error.message).toContain('clip.mp4');
  });

  it('refuses every video-only placement in platforms.json', () => {
    for (const spec of videoOnly) {
      const error = failureOf(() => planRender({ asset, spec }));
      expect(error.reason).toBe('not-image-placement');
      expect(error.message).toContain(spec.label);
    }
  });

  it('refuses a photo over the pixel limit, and accepts one at the limit', () => {
    const atLimit = makeAsset({ width: MAX_SOURCE_PIXELS / 10_000, height: 10_000 });
    expect(() => planRender({ asset: atLimit, spec: anyImage })).not.toThrow();

    const over = makeAsset({ ...atLimit, height: 10_001, fileName: 'huge.jpg' });
    const error = failureOf(() => planRender({ asset: over, spec: anyImage }));
    expect(error.reason).toBe('too-large');
    expect(error.message).toContain('huge.jpg');
    expect(error.message).toContain('megapixels');
  });
});

describe('renderValidationFields', () => {
  it('gives the validator the frame, the file size and the focal point in the output', () => {
    const asset = makeAsset({ width: 4032, height: 3024, focal: { x: 0.6, y: 0.25 } });
    const plan = planRender({ asset, spec: anyImage });
    const fields = renderValidationFields(
      { width: 10, height: 20, bytes: 1234 },
      plan,
      asset.focal,
    );
    expect(fields).toEqual({
      kind: 'image',
      frames: [{ width: 10, height: 20 }],
      fileBytes: 1234,
      focal: focalInFrame(asset.focal, plan.cropRect),
    });
  });

  it('lets the validator fail an output over the placement file-size cap', () => {
    const capped = first(imagePlacements.filter((spec) => spec.maxFileBytes !== null));
    const cap = capped.maxFileBytes as number;
    const asset = makeAsset();
    const plan = planRender({ asset, spec: capped });
    const check = (bytes: number) =>
      validate(
        {
          ...renderValidationFields({ ...plan.target, bytes }, plan, asset.focal),
          caption: '',
          hashtags: [],
        },
        capped,
      ).issues.filter((issue) => issue.rule === 2);
    expect(check(cap)).toEqual([]);
    expect(check(cap + 1)).toHaveLength(1);
  });
});
