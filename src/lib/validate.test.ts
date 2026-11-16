/**
 * Tests for the nine validation rules in SPEC.md. Limits are read from platforms.json, never
 * hard-coded, so the tests keep working when marketing updates a value. Placements are found by
 * the property under test rather than by name.
 */
import { platforms } from './platforms';
import {
  charCount,
  collectHashtags,
  containsUrl,
  postedCaption,
  safeRect,
  validate,
  type ValidationInput,
} from './validate';
import type { Issue, PlacementSpec, Size } from '../types';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function find(desc: string, pred: (p: PlacementSpec) => boolean): PlacementSpec {
  const spec = platforms.placements.find(pred);
  if (!spec) throw new Error(`No placement in platforms.json ${desc}`);
  return spec;
}

function firstSize(spec: PlacementSpec): Size {
  const s = spec.sizes[0];
  if (!s) throw new Error(`${spec.placement} has no sizes`);
  return s;
}

/** An input that passes every rule for the given placement. */
function validInput(
  spec: PlacementSpec,
  overrides: Partial<ValidationInput> = {},
): ValidationInput {
  const kind = spec.mediaTypes[0] ?? 'image';
  const slideCount = spec.slides ? Math.max(spec.slides.min ?? 1, 1) : 1;
  const d = spec.durationSec;
  return {
    kind,
    frames: Array.from({ length: slideCount }, () => ({ ...firstSize(spec) })),
    fileBytes: spec.maxFileBytes ?? 1_000,
    durationMs: d ? (d.max ?? d.min ?? 1) * 1000 : undefined,
    fps: spec.recommendedFps ?? 30,
    caption: spec.captionCap === null ? '' : 'Topping out on the new science building today.',
    hashtags: [],
    altText: 'Ironworkers set the final steel beam on the roof.',
    overlays: [{ x: 0.4, y: 0.45, width: 0.2, height: 0.1 }],
    logo: { x: 0.45, y: 0.55, width: 0.1, height: 0.05 },
    focal: { x: 0.5, y: 0.5 },
    ...overrides,
  };
}

const issuesFor = (rule: Issue['rule'], input: ValidationInput, spec: PlacementSpec) =>
  validate(input, spec).issues.filter((i) => i.rule === rule);

const words = (n: number) => 'x'.repeat(n);

// ---------------------------------------------------------------------------------------------
// Overall
// ---------------------------------------------------------------------------------------------

describe('validate: overall', () => {
  it.each(platforms.placements.map((p) => [`${p.platform}.${p.placement}`, p] as const))(
    'a valid %s output passes every rule',
    (_key, spec) => {
      expect(validate(validInput(spec), spec)).toEqual({ level: 'pass', issues: [] });
    },
  );

  it('is "warn" when there are warnings but no failures', () => {
    const spec = find('with an image type', (p) => p.mediaTypes.includes('image'));
    expect(validate(validInput(spec, { altText: '' }), spec).level).toBe('warn');
  });

  it('is "fail" when any rule fails, even alongside warnings', () => {
    const spec = find('with an image type', (p) => p.mediaTypes.includes('image'));
    const result = validate(
      validInput(spec, { altText: '', frames: [{ width: 10, height: 10 }] }),
      spec,
    );
    expect(result.level).toBe('fail');
    expect(result.issues.map((i) => i.level).sort()).toEqual(['fail', 'warn']);
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 1: dimensions and ratio
// ---------------------------------------------------------------------------------------------

describe('rule 1: dimensions and ratio', () => {
  const spec = find(
    'with a single image size',
    (p) => p.mediaTypes.includes('image') && p.sizes.length === 1,
  );
  const { width, height } = firstSize(spec);

  it('passes at the exact listed size', () => {
    expect(issuesFor(1, validInput(spec), spec)).toEqual([]);
  });

  it.each([
    [1, 0],
    [-1, 0],
    [0, 1],
    [1, -1],
  ])('passes within 1 px (%i, %i)', (dw, dh) => {
    const input = validInput(spec, { frames: [{ width: width + dw, height: height + dh }] });
    expect(issuesFor(1, input, spec)).toEqual([]);
  });

  it.each([
    [2, 0],
    [0, -2],
  ])('fails beyond 1 px (%i, %i)', (dw, dh) => {
    const input = validInput(spec, { frames: [{ width: width + dw, height: height + dh }] });
    const issues = issuesFor(1, input, spec);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'fail' });
    expect(issues[0]?.message).toContain(`${width} x ${height}`);
  });

  it('fails a same-ratio frame at the wrong scale when the ratio has a listed size', () => {
    const input = validInput(spec, { frames: [{ width: width / 2, height: height / 2 }] });
    expect(issuesFor(1, input, spec)).toHaveLength(1);
  });

  it('passes every listed size on a multi-size placement', () => {
    const multi = find('with several sizes', (p) => p.sizes.length > 1);
    for (const s of multi.sizes) {
      expect(issuesFor(1, validInput(multi, { frames: [s] }), multi)).toEqual([]);
    }
  });

  it('fails with no frames', () => {
    expect(issuesFor(1, validInput(spec, { frames: [] }), spec)).toEqual([
      expect.objectContaining({ level: 'fail', message: 'No output dimensions to check.' }),
    ]);
  });

  it('names the slide that is the wrong size', () => {
    const carousel = find('with slides', (p) => p.slides !== null && (p.slides.max ?? 2) >= 2);
    const good = firstSize(carousel);
    const input = validInput(carousel, { frames: [good, { width: 500, height: 500 }] });
    const issues = issuesFor(1, input, carousel);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/^Slide 2 is 500 x 500/);
  });

  describe('a ratio with no listed size (1% tolerance)', () => {
    // Synthetic: take a multi-ratio placement and drop the size that covers one of its ratios.
    const base = find('with several sizes', (p) => p.sizes.length > 1);
    const dropped = base.sizes[base.sizes.length - 1] as Size;
    const spec: PlacementSpec = { ...base, sizes: base.sizes.slice(0, -1) };
    const r = dropped.width / dropped.height;

    it('passes any frame at that ratio', () => {
      const frame = { width: 640, height: Math.round(640 / r) };
      expect(issuesFor(1, validInput(spec, { frames: [frame] }), spec)).toEqual([]);
    });

    it('passes within 1% of that ratio', () => {
      const frame = { width: 1000, height: Math.round(1000 / (r * 1.009)) };
      expect(issuesFor(1, validInput(spec, { frames: [frame] }), spec)).toEqual([]);
    });

    it('fails beyond 1% of that ratio, and the message offers the ratio', () => {
      const frame = { width: 1000, height: Math.round(1000 / (r * 1.03)) };
      const issues = issuesFor(1, validInput(spec, { frames: [frame] }), spec);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toMatch(/ size\.$/);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 2: file size
// ---------------------------------------------------------------------------------------------

describe('rule 2: file size', () => {
  const spec = find('with a file size cap', (p) => p.maxFileBytes !== null);
  const cap = spec.maxFileBytes as number;

  it('passes at the cap', () => {
    expect(issuesFor(2, validInput(spec, { fileBytes: cap }), spec)).toEqual([]);
  });

  it('fails one byte over the cap', () => {
    expect(issuesFor(2, validInput(spec, { fileBytes: cap + 1 }), spec)).toEqual([
      expect.objectContaining({ level: 'fail' }),
    ]);
  });

  it('is skipped before the file is rendered', () => {
    expect(issuesFor(2, validInput(spec, { fileBytes: undefined }), spec)).toEqual([]);
  });

  it('is skipped when the placement has no cap', () => {
    const uncapped = find('without a file size cap', (p) => p.maxFileBytes === null);
    expect(issuesFor(2, validInput(uncapped, { fileBytes: 1e12 }), uncapped)).toEqual([]);
  });

  it.each([
    [2_500, /KB/],
    [7_500_000, /MB/],
    [6e9, /GB/],
  ])('formats %d bytes readably', (bytes, unit) => {
    const tiny: PlacementSpec = { ...spec, maxFileBytes: 1_000 };
    expect(issuesFor(2, validInput(tiny, { fileBytes: bytes }), tiny)[0]?.message).toMatch(unit);
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 3: video duration and frame rate
// ---------------------------------------------------------------------------------------------

describe('rule 3: video duration and frame rate', () => {
  const spec = find(
    'with a min and max duration',
    (p) => p.durationSec?.min != null && p.durationSec.max != null,
  );
  const min = spec.durationSec?.min as number;
  const max = spec.durationSec?.max as number;

  it('passes at the minimum and the maximum', () => {
    expect(issuesFor(3, validInput(spec, { durationMs: min * 1000 }), spec)).toEqual([]);
    expect(issuesFor(3, validInput(spec, { durationMs: max * 1000 }), spec)).toEqual([]);
  });

  it('fails under the minimum', () => {
    const issues = issuesFor(3, validInput(spec, { durationMs: min * 1000 - 1 }), spec);
    expect(issues).toEqual([expect.objectContaining({ level: 'fail' })]);
    expect(issues[0]?.message).toContain('at least');
  });

  it('fails over the maximum', () => {
    const issues = issuesFor(3, validInput(spec, { durationMs: max * 1000 + 1 }), spec);
    expect(issues).toEqual([expect.objectContaining({ level: 'fail' })]);
    expect(issues[0]?.message).toContain('up to');
  });

  it('applies to a max-only range', () => {
    const maxOnly = find(
      'with a max-only duration',
      (p) => p.durationSec?.min === null && p.durationSec.max !== null,
    );
    const m = maxOnly.durationSec?.max as number;
    const video = { kind: 'video' as const };
    expect(issuesFor(3, validInput(maxOnly, { ...video, durationMs: 100 }), maxOnly)).toEqual([]);
    expect(
      issuesFor(3, validInput(maxOnly, { ...video, durationMs: m * 1000 + 1 }), maxOnly),
    ).toHaveLength(1);
  });

  it('is skipped when the duration is unknown', () => {
    expect(issuesFor(3, validInput(spec, { durationMs: undefined }), spec)).toEqual([]);
  });

  it('ignores duration and fps on a still image', () => {
    const story = find(
      'with image and video types',
      (p) => p.mediaTypes.includes('image') && p.mediaTypes.includes('video'),
    );
    const input = validInput(story, { kind: 'image', durationMs: 1e9, fps: 5 });
    expect(issuesFor(3, input, story)).toEqual([]);
  });

  it.each([30, 29.97, 30.4])('passes at %d fps', (fps) => {
    expect(issuesFor(3, validInput(spec, { fps }), spec)).toEqual([]);
  });

  it.each([24, 25, 60])('warns at %d fps', (fps) => {
    expect(issuesFor(3, validInput(spec, { fps }), spec)).toEqual([
      expect.objectContaining({ level: 'warn' }),
    ]);
  });

  it('can fail on duration and warn on fps together', () => {
    const issues = issuesFor(3, validInput(spec, { durationMs: max * 1000 + 1, fps: 24 }), spec);
    expect(issues.map((i) => i.level)).toEqual(['fail', 'warn']);
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 4: caption length and truncation
// ---------------------------------------------------------------------------------------------

describe('rule 4: caption length and truncation', () => {
  const capped = find(
    'with a caption cap and no truncation',
    (p) => p.captionCap !== null && p.truncation.length === 0,
  );
  const cap = capped.captionCap as number;

  it('passes at the cap', () => {
    expect(issuesFor(4, validInput(capped, { caption: words(cap) }), capped)).toEqual([]);
  });

  it('fails one character over the cap', () => {
    expect(issuesFor(4, validInput(capped, { caption: words(cap + 1) }), capped)).toEqual([
      expect.objectContaining({ level: 'fail' }),
    ]);
  });

  it('counts an emoji as one character', () => {
    const caption = words(cap - 1) + '🏗️'.slice(0, 2); // one code point, two UTF-16 units
    expect(caption.length).toBe(cap + 1);
    expect(issuesFor(4, validInput(capped, { caption }), capped)).toEqual([]);
  });

  it('is skipped where the placement has no caption', () => {
    const none = find('without a caption cap', (p) => p.captionCap === null);
    expect(issuesFor(4, validInput(none, { caption: words(100_000) }), none)).toEqual([]);
  });

  describe('truncation', () => {
    const spec = find('with two truncation points', (p) => p.truncation.length >= 2);
    const points = [...spec.truncation].sort((a, b) => a.chars - b.chars);
    const shortest = points[0] as (typeof points)[number];
    const longest = points[points.length - 1] as (typeof points)[number];

    it('passes at the shortest truncation point', () => {
      expect(issuesFor(4, validInput(spec, { caption: words(shortest.chars) }), spec)).toEqual([]);
    });

    it('warns once per truncation point passed, showing the cut-off', () => {
      const caption = 'a'.repeat(shortest.chars - 5) + 'VISIBLE' + 'b'.repeat(longest.chars);
      const issues = issuesFor(4, validInput(spec, { caption }), spec);
      expect(issues).toHaveLength(points.length);
      expect(issues.every((i) => i.level === 'warn')).toBe(true);
      const first = issues.find((i) => i.message.includes(shortest.context));
      expect(first?.message).toContain(`after ${shortest.chars}`);
      expect(first?.message).toMatch(/VISIB" …more$/);
    });

    it('warns only for the points the caption passes', () => {
      const caption = words(shortest.chars + 1);
      expect(issuesFor(4, validInput(spec, { caption }), spec)).toHaveLength(1);
    });

    it('fails instead of warning when the caption is over the cap', () => {
      const caption = words((spec.captionCap as number) + 1);
      expect(issuesFor(4, validInput(spec, { caption }), spec)).toEqual([
        expect.objectContaining({ level: 'fail' }),
      ]);
    });

    it('shows the whole visible part when the cut-off is short', () => {
      const short: PlacementSpec = { ...spec, truncation: [{ context: 'tiny', chars: 5 }] };
      const issues = issuesFor(4, validInput(short, { caption: 'Hello world' }), short);
      expect(issues[0]?.message).toContain('"Hello" …more');
    });
  });
});

describe('rule 4: hashtags counted in the caption', () => {
  const inCaption = find(
    'that posts hashtags in the caption',
    (p) => p.hashtagsInCaption && p.captionCap !== null,
  );
  const inComment = find(
    'that posts hashtags in the first comment',
    (p) => !p.hashtagsInCaption && p.captionCap !== null,
  );
  // Use a spec without truncation so only the cap is under test.
  const capOnly: PlacementSpec = { ...inCaption, truncation: [] };
  const cap = capOnly.captionCap as number;

  describe('where hashtags are posted in the caption', () => {
    it('passes when caption + space + hashtags is exactly at the cap', () => {
      const input = validInput(capOnly, { caption: words(cap - 4), hashtags: ['#ab'] });
      expect(issuesFor(4, input, capOnly)).toEqual([]);
    });

    it('fails when the hashtags push it one character over the cap', () => {
      const input = validInput(capOnly, { caption: words(cap - 3), hashtags: ['#ab'] });
      const issues = issuesFor(4, input, capOnly);
      expect(issues).toEqual([expect.objectContaining({ level: 'fail' })]);
      expect(issues[0]?.message).toMatch(/^Caption with hashtags is \d+ characters/);
    });

    it('fails on a caption that fits only without its hashtags', () => {
      const input = validInput(capOnly, { caption: words(cap), hashtags: ['#a'] });
      expect(issuesFor(4, input, capOnly)).toHaveLength(1);
    });

    it('adds a # to tags entered without one', () => {
      const pass = validInput(capOnly, { caption: words(cap - 4), hashtags: ['ab'] });
      const fail = validInput(capOnly, { caption: words(cap - 3), hashtags: ['ab'] });
      expect(issuesFor(4, pass, capOnly)).toEqual([]);
      expect(issuesFor(4, fail, capOnly)).toHaveLength(1);
    });

    it('ignores blank tags', () => {
      const input = validInput(capOnly, { caption: words(cap), hashtags: ['', '  ', '#'] });
      expect(issuesFor(4, input, capOnly)).toEqual([]);
    });

    it('counts hashtags toward truncation too', () => {
      const spec = find(
        'with truncation that posts hashtags in the caption',
        (p) => p.hashtagsInCaption && p.truncation.length > 0,
      );
      const cut = Math.min(...spec.truncation.map((t) => t.chars));
      const atCut = validInput(spec, { caption: words(cut - 4), hashtags: ['#ab'] });
      const overCut = validInput(spec, { caption: words(cut - 4), hashtags: ['#abc'] });
      expect(issuesFor(4, atCut, spec)).toEqual([]);
      const issues = issuesFor(4, overCut, spec);
      expect(issues).toEqual([expect.objectContaining({ level: 'warn' })]);
      expect(issues[0]?.message).toMatch(/^Caption with hashtags/);
    });
  });

  describe('where hashtags go in the first comment', () => {
    const commentCap = inComment.captionCap as number;
    const many = Array.from({ length: 10 }, (_, i) => `#tag${i}`);

    it('passes a caption at the cap regardless of hashtags', () => {
      const input = validInput(inComment, { caption: words(commentCap), hashtags: many });
      expect(issuesFor(4, input, inComment)).toEqual([]);
    });

    it('still fails a caption over the cap, and does not mention hashtags', () => {
      const input = validInput(inComment, { caption: words(commentCap + 1), hashtags: many });
      const issues = issuesFor(4, input, inComment);
      expect(issues).toEqual([expect.objectContaining({ level: 'fail' })]);
      expect(issues[0]?.message).toMatch(/^Caption is /);
    });
  });
});

describe('postedCaption', () => {
  const inCaption = find('that posts hashtags in the caption', (p) => p.hashtagsInCaption);
  const inComment = find('that posts hashtags in the first comment', (p) => !p.hashtagsInCaption);

  it('joins caption and hashtags with spaces, adding # where missing', () => {
    const input = validInput(inCaption, {
      caption: 'Topping out.',
      hashtags: ['#Build', ' crane '],
    });
    expect(postedCaption(input, inCaption)).toBe('Topping out. #Build #crane');
  });

  it('has no leading space when the caption is empty', () => {
    const input = validInput(inCaption, { caption: '', hashtags: ['#ab'] });
    expect(postedCaption(input, inCaption)).toBe('#ab');
  });

  it('is the caption alone where hashtags go in the first comment', () => {
    const input = validInput(inComment, { caption: 'Topping out.', hashtags: ['#Build'] });
    expect(postedCaption(input, inComment)).toBe('Topping out.');
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 5: hashtag count
// ---------------------------------------------------------------------------------------------

describe('rule 5: hashtag count', () => {
  const spec = find('with a hashtag cap', (p) => p.hashtagCap !== null);
  const cap = spec.hashtagCap as number;
  const tags = (n: number, prefix = 't') => Array.from({ length: n }, (_, i) => `#${prefix}${i}`);

  it('passes at the cap', () => {
    expect(issuesFor(5, validInput(spec, { hashtags: tags(cap) }), spec)).toEqual([]);
  });

  it('fails one over the cap', () => {
    expect(issuesFor(5, validInput(spec, { hashtags: tags(cap + 1) }), spec)).toEqual([
      expect.objectContaining({ level: 'fail' }),
    ]);
  });

  it('counts hashtags in the caption with the hashtag field', () => {
    const input = validInput(spec, { hashtags: tags(cap), caption: 'Great day #extra' });
    expect(issuesFor(5, input, spec)).toHaveLength(1);
  });

  it('counts a tag in both places once', () => {
    const input = validInput(spec, { hashtags: tags(cap), caption: 'Great day #T0' });
    expect(issuesFor(5, input, spec)).toEqual([]);
  });

  it('is skipped when the placement has no cap', () => {
    const uncapped = find('without a hashtag cap', (p) => p.hashtagCap === null);
    expect(issuesFor(5, validInput(uncapped, { hashtags: tags(500) }), uncapped)).toEqual([]);
  });
});

describe('collectHashtags', () => {
  it('normalizes the field: strips #, trims, lower-cases, drops empties', () => {
    expect(collectHashtags('', ['#Build', 'build', ' ##Crane ', '#', ''])).toEqual([
      'build',
      'crane',
    ]);
  });

  it('finds caption tags at the start or after whitespace, with Unicode letters', () => {
    expect(collectHashtags('#One two\n#Três #4th', [])).toEqual(['one', 'três', '4th']);
  });

  it('ignores URL fragments and mid-word #', () => {
    expect(collectHashtags('see https://x.com/page#top and C#sharp', [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 6: carousel slide count and ratio
// ---------------------------------------------------------------------------------------------

describe('rule 6: carousel slides', () => {
  const spec = find(
    'with a min and max slide count',
    (p) => p.slides?.min != null && p.slides.max != null,
  );
  const min = spec.slides?.min as number;
  const max = spec.slides?.max as number;
  const frames = (n: number) => Array.from({ length: n }, () => ({ ...firstSize(spec) }));

  it('passes at the minimum and the maximum', () => {
    expect(issuesFor(6, validInput(spec, { frames: frames(min) }), spec)).toEqual([]);
    expect(issuesFor(6, validInput(spec, { frames: frames(max) }), spec)).toEqual([]);
  });

  it('fails under the minimum', () => {
    const issues = issuesFor(6, validInput(spec, { frames: frames(min - 1) }), spec);
    expect(issues).toEqual([expect.objectContaining({ level: 'fail' })]);
    expect(issues[0]?.message).toContain(`${min} to ${max}`);
  });

  it('fails over the maximum', () => {
    expect(issuesFor(6, validInput(spec, { frames: frames(max + 1) }), spec)).toEqual([
      expect.objectContaining({ level: 'fail' }),
    ]);
  });

  it('fails when slides have different ratios, naming them', () => {
    const f = frames(Math.max(min, 3));
    f[1] = { width: 1000, height: 1000 };
    f[2] = { width: 1000, height: 500 };
    const issues = issuesFor(6, validInput(spec, { frames: f }), spec);
    expect(issues).toEqual([expect.objectContaining({ level: 'fail' })]);
    expect(issues[0]?.message).toContain('slide 2, 3 differ ');
  });

  it('passes slides within 1% of the same ratio', () => {
    const base = firstSize(spec);
    const f = frames(min);
    f[1] = { width: base.width * 2, height: Math.round(base.height * 2 * 1.005) };
    expect(issuesFor(6, validInput(spec, { frames: f }), spec)).toEqual([]);
  });

  it('allows mixed ratios when the placement does not require one ratio', () => {
    const mixed: PlacementSpec = { ...spec, slides: { min, max, sameRatio: false } };
    const f = frames(min);
    f[1] = { width: 1000, height: 1000 };
    expect(issuesFor(6, validInput(mixed, { frames: f }), mixed)).toEqual([]);
  });

  it('describes a max-only range as "up to"', () => {
    const maxOnly = find(
      'with a max-only slide count',
      (p) => p.slides?.min === null && p.slides.max !== null,
    );
    const n = (maxOnly.slides?.max as number) + 1;
    const f = Array.from({ length: n }, () => ({ ...firstSize(maxOnly) }));
    expect(issuesFor(6, validInput(maxOnly, { frames: f }), maxOnly)[0]?.message).toContain(
      'up to',
    );
  });

  it('describes a min-only range as "at least"', () => {
    const minOnly: PlacementSpec = { ...spec, slides: { min: 3, max: null, sameRatio: true } };
    expect(issuesFor(6, validInput(minOnly, { frames: frames(2) }), minOnly)[0]?.message).toContain(
      'at least 3',
    );
  });

  it('is skipped on placements without slides', () => {
    const single = find('without slides', (p) => p.slides === null);
    expect(issuesFor(6, validInput(single, { frames: frames(50) }), single)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 7: unsafe zones
// ---------------------------------------------------------------------------------------------

describe('rule 7: Story and Reel unsafe zones', () => {
  const insets = find('with an insets safe zone', (p) => p.safeZone?.kind === 'insets');
  const centered = find(
    'with a centered-area safe zone',
    (p) => p.safeZone?.kind === 'centered-area',
  );

  it('passes when overlays, logo, and focal point are inside the safe area', () => {
    expect(issuesFor(7, validInput(insets), insets)).toEqual([]);
    expect(issuesFor(7, validInput(centered), centered)).toEqual([]);
  });

  it('warns for a text overlay in the top inset', () => {
    const input = validInput(insets, { overlays: [{ x: 0.3, y: 0.01, width: 0.4, height: 0.05 }] });
    const issues = issuesFor(7, input, insets);
    expect(issues).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(issues[0]?.message).toContain('text overlay 1');
  });

  it('warns for a logo in the bottom inset', () => {
    const input = validInput(insets, { logo: { x: 0.4, y: 0.9, width: 0.2, height: 0.05 } });
    expect(issuesFor(7, input, insets)[0]?.message).toContain('logo');
  });

  it('warns for a box crossing a side inset', () => {
    const input = validInput(insets, { overlays: [{ x: 0.5, y: 0.4, width: 0.5, height: 0.1 }] });
    expect(issuesFor(7, input, insets)).toHaveLength(1);
  });

  it('warns for a focal point outside the safe area', () => {
    const input = validInput(insets, { focal: { x: 0.5, y: 0.95 } });
    expect(issuesFor(7, input, insets)[0]?.message).toContain('focal point');
  });

  it('lists every item outside the safe area in one warning', () => {
    const input = validInput(insets, {
      overlays: [
        { x: 0.4, y: 0.45, width: 0.1, height: 0.1 },
        { x: 0, y: 0, width: 0.1, height: 0.1 },
      ],
      logo: { x: 0.9, y: 0.9, width: 0.1, height: 0.1 },
      focal: { x: 0, y: 0 },
    });
    const issues = issuesFor(7, input, insets);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/text overlay 2, logo, focal point\.$/);
  });

  it('passes a box touching the safe-area edge exactly', () => {
    const zone = insets.safeZone as Extract<PlacementSpec['safeZone'], { kind: 'insets' }>;
    const box = {
      x: zone.left,
      y: zone.top,
      width: 1 - zone.left - zone.right,
      height: 1 - zone.top - zone.bottom,
    };
    expect(issuesFor(7, validInput(insets, { overlays: [box] }), insets)).toEqual([]);
  });

  it('warns for an overlay above a centered safe area', () => {
    const input = validInput(centered, { overlays: [{ x: 0.3, y: 0, width: 0.4, height: 0.05 }] });
    expect(issuesFor(7, input, centered)).toEqual([expect.objectContaining({ level: 'warn' })]);
  });

  it('is skipped on placements without a safe zone', () => {
    const none = find('without a safe zone', (p) => p.safeZone === null);
    const input = validInput(none, {
      overlays: [{ x: 0, y: 0, width: 1, height: 1 }],
      focal: { x: 0, y: 0 },
    });
    expect(issuesFor(7, input, none)).toEqual([]);
  });

  it('is skipped with nothing placed', () => {
    const input = validInput(insets, { overlays: undefined, logo: undefined, focal: undefined });
    expect(issuesFor(7, input, insets)).toEqual([]);
  });
});

describe('safeRect', () => {
  it('converts insets to a rect', () => {
    expect(
      safeRect(
        { kind: 'insets', top: 0.1, bottom: 0.2, left: 0.05, right: 0.05 },
        { width: 100, height: 100 },
      ),
    ).toEqual({
      x: 0.05,
      y: 0.1,
      width: expect.closeTo(0.9) as number,
      height: expect.closeTo(0.7) as number,
    });
  });

  it('centers a pixel safe area in the frame', () => {
    const r = safeRect(
      { kind: 'centered-area', width: 50, height: 80 },
      { width: 100, height: 100 },
    );
    expect(r).toEqual({ x: 0.25, y: expect.closeTo(0.1) as number, width: 0.5, height: 0.8 });
  });

  it('clamps a safe area larger than the frame to the frame', () => {
    const r = safeRect(
      { kind: 'centered-area', width: 500, height: 500 },
      { width: 100, height: 100 },
    );
    expect(r).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 8: alt text
// ---------------------------------------------------------------------------------------------

describe('rule 8: alt text', () => {
  const image = find('with an image type', (p) => p.mediaTypes.includes('image'));
  const imageSet = find('with an image-set type', (p) => p.mediaTypes.includes('image-set'));
  const video = find('video-only', (p) => p.mediaTypes.length === 1 && p.mediaTypes[0] === 'video');
  const pdf = find('with a pdf type', (p) => p.mediaTypes.includes('pdf'));

  it('passes an image with alt text', () => {
    expect(issuesFor(8, validInput(image), image)).toEqual([]);
  });

  it.each([undefined, '', '   \n'])('warns for an image with alt text %j', (altText) => {
    expect(issuesFor(8, validInput(image, { altText }), image)).toEqual([
      expect.objectContaining({ level: 'warn' }),
    ]);
  });

  it('warns for a carousel without alt text', () => {
    expect(issuesFor(8, validInput(imageSet, { altText: '' }), imageSet)).toHaveLength(1);
  });

  it('does not apply to video or PDF documents', () => {
    expect(issuesFor(8, validInput(video, { altText: '' }), video)).toEqual([]);
    expect(issuesFor(8, validInput(pdf, { altText: '' }), pdf)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 9: links in captions where they are not clickable
// ---------------------------------------------------------------------------------------------

describe('rule 9: links in captions', () => {
  const noLinks = find(
    'where caption links are not clickable',
    (p) => !p.captionLinksClickable && p.captionCap !== null,
  );
  const links = find(
    'where caption links are clickable',
    (p) => p.captionLinksClickable && p.captionCap !== null,
  );

  it.each([
    'Read more at https://www.example.com/news',
    'Details: http://example.org',
    'Visit www.example.com today',
    'Apply at example.com/careers',
  ])('warns for %j', (caption) => {
    const issues = issuesFor(9, validInput(noLinks, { caption }), noLinks);
    expect(issues).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(issues[0]?.message).toContain(noLinks.platform);
  });

  it('passes a caption without a link', () => {
    expect(
      issuesFor(9, validInput(noLinks, { caption: 'Link in bio. Great day on site.' }), noLinks),
    ).toEqual([]);
  });

  it('passes a link where links are clickable', () => {
    const caption = 'Read more at https://www.example.com/news';
    expect(issuesFor(9, validInput(links, { caption }), links)).toEqual([]);
  });
});

describe('containsUrl', () => {
  it.each(['https://a.b', 'www.example.com', 'example.io/x', 'see bit.ly/abc'])('finds %j', (t) => {
    expect(containsUrl(t)).toBe(true);
  });

  it.each(['No links here.', 'End of sentence.Next one', 'v2.5 release', 'www.'])(
    'ignores %j',
    (t) => {
      expect(containsUrl(t)).toBe(false);
    },
  );
});

describe('charCount', () => {
  it('counts code points', () => {
    expect(charCount('abc')).toBe(3);
    expect(charCount('👷')).toBe(1);
  });
});
