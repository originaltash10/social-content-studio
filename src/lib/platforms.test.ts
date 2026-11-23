import rawPlatforms from '../data/platforms.json';
import { getPlacement, parsePlatforms, parseRatio, platforms, PlatformsError } from './platforms';

/** Deep clone of the real file so each test can break one thing. */
const clone = (): Record<string, unknown> & { placements: Record<string, unknown>[] } =>
  structuredClone(rawPlatforms) as never;

/** Index access that fails the test loudly instead of using a non-null assertion. */
function at<T>(list: T[], i: number): T {
  const item = list[i];
  if (item === undefined) throw new Error(`no item at index ${i}`);
  return item;
}

function problemsFor(input: unknown): string[] {
  try {
    parsePlatforms(input);
    return [];
  } catch (e) {
    if (e instanceof PlatformsError) return e.problems;
    throw e;
  }
}

describe('platforms.json (the real file)', () => {
  it('parses without problems', () => {
    expect(problemsFor(rawPlatforms)).toEqual([]);
    expect(platforms.placements.length).toBeGreaterThan(0);
  });

  it('covers the four platforms in SPEC.md', () => {
    const present = new Set(platforms.placements.map((p) => p.platform));
    expect([...present].sort()).toEqual(['facebook', 'instagram', 'linkedin', 'x']);
  });

  it('has a verified date and a known source on every entry', () => {
    for (const p of platforms.placements) {
      expect(p.verified.sizes).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.verified.limits).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(platforms.sources).toHaveProperty(p.sources.sizes);
      expect(platforms.sources).toHaveProperty(p.sources.limits);
    }
  });

  it('gives every size a listed ratio (within 1% — labels like 1.91:1 are rounded)', () => {
    for (const p of platforms.placements) {
      const ratios = p.ratios.map((r) => parseRatio(r) as number);
      for (const s of p.sizes) {
        const actual = s.width / s.height;
        const ok = ratios.some((r) => Math.abs(actual - r) / r <= 0.01);
        expect(ok, `${p.platform}.${p.placement} ${s.width}x${s.height}`).toBe(true);
      }
    }
  });

  it('gives video placements a duration range and image-set/pdf placements a slide range', () => {
    for (const p of platforms.placements) {
      const key = `${p.platform}.${p.placement}`;
      if (p.mediaTypes.includes('video')) expect(p.durationSec, key).not.toBeNull();
      if (p.mediaTypes.includes('image-set') || p.mediaTypes.includes('pdf'))
        expect(p.slides, key).not.toBeNull();
    }
  });

  it.each(['story', 'reel'])('notes the Facebook %s safe-zone assumption', (key) => {
    const fb = getPlacement('facebook', key);
    expect(fb?.safeZone?.kind).toBe('insets');
    expect(fb?.assumptions.join(' ')).toMatch(/safe zone/i);
  });
});

describe('canBeStory in platforms.json', () => {
  it('is true for the Instagram and Facebook story placements only', () => {
    const stories = platforms.placements
      .filter((p) => p.canBeStory)
      .map((p) => `${p.platform}/${p.placement}`);
    expect(stories.sort()).toEqual(['facebook/story', 'instagram/story']);
  });
});

describe('getPlacement', () => {
  it('finds a placement by platform and key', () => {
    const first = at(platforms.placements, 0);
    expect(getPlacement(first.platform, first.placement)).toBe(first);
  });

  it('returns undefined for an unknown placement', () => {
    expect(getPlacement('instagram', 'does-not-exist')).toBeUndefined();
  });
});

describe('parseRatio', () => {
  it.each([
    ['4:5', 0.8],
    ['1:1', 1],
    ['16:9', 16 / 9],
    ['1.91:1', 1.91],
  ])('parses %s', (input, expected) => {
    expect(parseRatio(input)).toBeCloseTo(expected);
  });

  it.each(['4/5', '4:', ':5', '0:1', 'a:b', ''])('rejects %j', (input) => {
    expect(parseRatio(input)).toBeNull();
  });
});

describe('parsePlatforms rejects bad edits', () => {
  it('rejects a non-object root', () => {
    expect(problemsFor([])).toEqual(['root: must be an object']);
  });

  it('rejects an unknown platform', () => {
    const d = clone();
    at(d.placements, 0).platform = 'tiktok';
    expect(problemsFor(d)).toEqual([expect.stringMatching(/placements\[0\]\.platform/)]);
  });

  it('rejects a duplicate placement', () => {
    const d = clone();
    d.placements.push(structuredClone(at(d.placements, 0)));
    expect(problemsFor(d)).toEqual([expect.stringMatching(/duplicate placement/)]);
  });

  it('rejects a malformed ratio', () => {
    const d = clone();
    at(d.placements, 0).ratios = ['4x5'];
    expect(problemsFor(d)).toEqual([expect.stringMatching(/ratios\[0\]/)]);
  });

  it('rejects a non-integer size', () => {
    const d = clone();
    at(d.placements, 0).sizes = [{ width: 1080.5, height: 1350 }];
    expect(problemsFor(d)).toEqual([expect.stringMatching(/sizes\[0\]/)]);
  });

  it('rejects a missing or malformed verified date', () => {
    const d = clone();
    at(d.placements, 0).verified = { sizes: 'Nov 2026', limits: '2026-07-01' };
    expect(problemsFor(d)).toEqual([expect.stringMatching(/verified\.sizes/)]);
  });

  it('rejects a source key that is not defined', () => {
    const d = clone();
    at(d.placements, 0).sources = { sizes: 'nowhere', limits: 'nowhere' };
    expect(problemsFor(d)).toHaveLength(2);
  });

  it('rejects a range with min above max', () => {
    const d = clone();
    at(d.placements, 0).durationSec = { min: 10, max: 5 };
    expect(problemsFor(d)).toEqual([expect.stringMatching(/min must not exceed max/)]);
  });

  it('rejects insets that leave no safe area', () => {
    const d = clone();
    at(d.placements, 0).safeZone = { kind: 'insets', top: 0.6, bottom: 0.5, left: 0, right: 0 };
    expect(problemsFor(d)).toEqual([expect.stringMatching(/no safe area/)]);
  });

  it('rejects a centered safe area larger than the frame', () => {
    const d = clone();
    at(d.placements, 0).safeZone = { kind: 'centered-area', width: 5000, height: 100 };
    expect(problemsFor(d)).toEqual([expect.stringMatching(/larger than sizes\[0\]/)]);
  });

  it('rejects a string where a number is expected', () => {
    const d = clone();
    at(d.placements, 0).captionCap = '2200';
    expect(problemsFor(d)).toEqual([expect.stringMatching(/captionCap/)]);
  });

  it('rejects a missing or non-boolean canBeStory', () => {
    const d = clone();
    delete at(d.placements, 0).canBeStory;
    at(d.placements, 1).canBeStory = 'yes';
    expect(problemsFor(d)).toEqual([
      expect.stringMatching(/placements\[0\]\.canBeStory: must be true or false/),
      expect.stringMatching(/placements\[1\]\.canBeStory: must be true or false/),
    ]);
  });

  it('lists every problem, not just the first', () => {
    const d = clone();
    at(d.placements, 0).captionCap = -1;
    at(d.placements, 1).hashtagCap = 0;
    expect(problemsFor(d)).toHaveLength(2);
  });
});
