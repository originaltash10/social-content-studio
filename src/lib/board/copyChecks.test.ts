import { describe, expect, it } from 'vitest';
import { getPlacement, platforms } from '../platforms';
import { charCount, collectHashtags, postedCaption, validate } from '../validate';
import type { Card, Issue, PlacementSpec, Platform } from '../../types';
import { boxText, copyEdit, copyStatus, parseHashtags, sameTags } from './copyChecks';
import type { CopyText } from './copyChecks';
import { boardPlacements } from './targets';

function spec(platform: Platform, placement: string): PlacementSpec {
  const found = getPlacement(platform, placement);
  if (!found) throw new Error(`no ${platform} ${placement} in platforms.json`);
  return found;
}

/** A limit from platforms.json that the test needs to be set. */
function limit(value: number | null): number {
  if (value === null) throw new Error('expected a limit in platforms.json');
  return value;
}

const feed = spec('instagram', 'feed-vertical');
const reelStory = spec('instagram', 'story');
const linkedin = spec('linkedin', 'image-square');
const boardSpecs = boardPlacements(platforms).flatMap((group) => group.placements);

const text = (over: Partial<CopyText> = {}): CopyText => ({
  caption: '',
  hashtags: [],
  firstComment: '',
  ...over,
});

/** The validator's own result for the same text, as the card's checks would get it. */
function validatorIssues(t: CopyText, s: PlacementSpec, rules: Issue['rule'][]): Issue[] {
  return validate(
    { kind: 'image', frames: [], caption: t.caption, hashtags: t.hashtags },
    s,
  ).issues.filter((issue) => rules.includes(issue.rule));
}

const copy = (over: Partial<Card['copy']> = {}): Card['copy'] => ({
  caption: '',
  firstComment: '',
  hashtags: [],
  altText: '',
  ...over,
});

/** Applies an edit to a copy of the card's copy, as the store's update would. */
function applied(c: Card['copy'], edit: ((draft: Card['copy']) => void) | null): Card['copy'] {
  if (!edit) throw new Error('expected a change');
  const draft = structuredClone(c);
  edit(draft);
  return draft;
}

describe('parseHashtags', () => {
  it('splits on spaces, commas, tabs and line breaks', () => {
    expect(parseHashtags('#a #b,#c\n#d\t#e\r\n#f')).toEqual(['#a', '#b', '#c', '#d', '#e', '#f']);
  });

  it('drops empty entries', () => {
    expect(parseHashtags('')).toEqual([]);
    expect(parseHashtags('  , ,\n ')).toEqual([]);
    expect(parseHashtags(' ,#a,, #b ,')).toEqual(['#a', '#b']);
  });

  it('keeps the order, duplicates, and each tag as typed, with or without "#"', () => {
    expect(parseHashtags('#Site build #site ##two #')).toEqual([
      '#Site',
      'build',
      '#site',
      '##two',
      '#',
    ]);
  });
});

describe('boxText', () => {
  it('shows the stored caption and first comment as they are', () => {
    const c = copy({ caption: 'Hello\nthere', firstComment: 'First!' });
    expect(boxText(c, 'caption')).toBe('Hello\nthere');
    expect(boxText(c, 'firstComment')).toBe('First!');
  });

  it('shows the stored hashtags separated by spaces', () => {
    expect(boxText(copy({ hashtags: ['#a', 'b'] }), 'hashtags')).toBe('#a b');
    expect(boxText(copy(), 'hashtags')).toBe('');
  });
});

describe('sameTags', () => {
  it('is true only for the same tags in the same order', () => {
    expect(sameTags([], [])).toBe(true);
    expect(sameTags(['#a', '#b'], ['#a', '#b'])).toBe(true);
    expect(sameTags(['#a', '#b'], ['#b', '#a'])).toBe(false);
    expect(sameTags(['#a'], ['#a', '#a'])).toBe(false);
    expect(sameTags(['#a'], ['a'])).toBe(false);
  });
});

describe('copyStatus counts characters as the validator does', () => {
  // Code points, as charCount counts them: no normalisation, so a decomposed accent is two.
  // Joiners, modifiers and the combining accent are escapes, so they can be seen in review.
  it.each([
    ['', 0],
    ['Hi 👋', 4],
    ['👍\u{1F3FD}', 2],
    ['\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}', 5],
    ['caf\u{E9}', 4],
    ['cafe\u{301}', 5],
    ['a\nb', 3],
  ])('counts %j as %i', (caption, count) => {
    expect(copyStatus(text({ caption }), feed).caption.count).toBe(count);
    expect(copyStatus(text({ firstComment: caption }), feed).firstComment.count).toBe(count);
  });

  it('counts only the caption where hashtags go in the first comment', () => {
    expect(feed.hashtagsInCaption).toBe(false);
    const status = copyStatus(text({ caption: 'Hello', hashtags: ['#a', 'b'] }), feed);
    expect(status.caption.count).toBe(5);
    expect(status.caption.includesHashtags).toBe(false);
  });

  it('counts the caption and hashtags joined with spaces where hashtags go in the caption', () => {
    expect(linkedin.hashtagsInCaption).toBe(true);
    const status = copyStatus(text({ caption: 'Hello', hashtags: ['#a', 'b'] }), linkedin);
    // "Hello #a #b"
    expect(status.caption.count).toBe(11);
    expect(status.caption.includesHashtags).toBe(true);
  });

  it('gives the caption and hashtag caps from platforms.json', () => {
    const status = copyStatus(text(), feed);
    expect(status.caption.cap).toBe(feed.captionCap);
    expect(status.hashtags.cap).toBe(feed.hashtagCap);
    expect(copyStatus(text(), linkedin).hashtags.cap).toBeNull();
  });
});

describe('copyStatus counts hashtags as rule 5 does', () => {
  it('counts the field and caption tags once each, ignoring case', () => {
    const status = copyStatus(
      text({ caption: 'New site #Build', hashtags: ['#build', 'Site', '#site'] }),
      feed,
    );
    expect(status.hashtags.count).toBe(2);
  });

  it('counts no tags in an empty box', () => {
    expect(copyStatus(text(), feed).hashtags.count).toBe(0);
  });
});

describe('copyStatus messages', () => {
  it('has no messages for empty boxes', () => {
    for (const s of boardSpecs) {
      const status = copyStatus(text(), s);
      expect(status.caption.issues).toEqual([]);
      expect(status.hashtags.issues).toEqual([]);
    }
  });

  it('passes at the caption cap and fails one character over', () => {
    for (const s of [feed, reelStory, linkedin]) {
      const cap = limit(s.captionCap);
      const atCap = copyStatus(text({ caption: 'a'.repeat(cap) }), s).caption;
      const over = copyStatus(text({ caption: 'a'.repeat(cap + 1) }), s).caption;
      expect(atCap.count).toBe(cap);
      expect(atCap.issues.filter((i) => i.level === 'fail')).toEqual([]);
      expect(over.count).toBe(cap + 1);
      expect(over.issues).toEqual([expect.objectContaining({ rule: 4, level: 'fail' })]);
    }
  });

  it('fails the caption when the hashtags take it over the cap where they are posted in it', () => {
    const cap = limit(linkedin.captionCap);
    // Caption plus one space plus "#a" is one over.
    const status = copyStatus(text({ caption: 'a'.repeat(cap - 2), hashtags: ['#a'] }), linkedin);
    expect(status.caption.count).toBe(cap + 1);
    expect(status.caption.issues).toEqual([expect.objectContaining({ rule: 4, level: 'fail' })]);
    expect(status.caption.issues[0]?.message).toMatch(/^Caption with hashtags is /);
  });

  it('passes at the hashtag cap and fails one tag over', () => {
    for (const s of [feed, reelStory]) {
      const cap = limit(s.hashtagCap);
      const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`);
      expect(copyStatus(text({ hashtags: tags(cap) }), s).hashtags).toEqual({
        count: cap,
        cap,
        issues: [],
      });
      const over = copyStatus(text({ hashtags: tags(cap + 1) }), s).hashtags;
      expect(over.count).toBe(cap + 1);
      expect(over.issues).toEqual([expect.objectContaining({ rule: 5, level: 'fail' })]);
    }
  });

  it('warns past each "…more" cut-off in platforms.json, and not at it', () => {
    const points = linkedin.truncation.map((t) => t.chars).sort((a, b) => a - b);
    expect(points.length).toBeGreaterThan(0);
    points.forEach((chars, index) => {
      const atPoint = copyStatus(text({ caption: 'a'.repeat(chars) }), linkedin).caption.issues;
      const past = copyStatus(text({ caption: 'a'.repeat(chars + 1) }), linkedin).caption.issues;
      expect(atPoint).toHaveLength(index);
      expect(past).toHaveLength(index + 1);
      for (const issue of past) expect(issue).toMatchObject({ rule: 4, level: 'warn' });
      expect(past.at(-1)?.message).toContain('…more');
    });
  });

  it('shows no cut-off warning where platforms.json gives no cut-off', () => {
    expect(feed.truncation).toEqual([]);
    const cap = limit(feed.captionCap);
    expect(copyStatus(text({ caption: 'a'.repeat(cap) }), feed).caption.issues).toEqual([]);
  });

  it('warns about a link in the caption only where links are not clickable', () => {
    const caption = 'Details at example.com/jobs';
    expect(feed.captionLinksClickable).toBe(false);
    expect(copyStatus(text({ caption }), feed).caption.issues).toEqual([
      expect.objectContaining({ rule: 9, level: 'warn' }),
    ]);
    expect(linkedin.captionLinksClickable).toBe(true);
    expect(copyStatus(text({ caption }), linkedin).caption.issues).toEqual([]);
  });

  it('keeps every limit off a placement that sets none', () => {
    const none = platforms.placements.find((p) => p.captionCap === null && p.hashtagCap === null);
    if (!none) throw new Error('expected a placement without caption limits');
    const tags = Array.from({ length: 100 }, (_, i) => `#t${i}`);
    const status = copyStatus(text({ caption: 'a'.repeat(100_000), hashtags: tags }), none);
    expect(status.caption).toMatchObject({ cap: null, issues: [] });
    expect(status.hashtags).toMatchObject({ count: 100, cap: null, issues: [] });
  });

  it('leaves out the rules that need a rendered file', () => {
    // Alt text (rule 8) and dimensions (rule 1) would complain about this input on their own.
    for (const s of boardSpecs) {
      const status = copyStatus(text({ caption: 'Hello' }), s);
      for (const issue of [...status.caption.issues, ...status.hashtags.issues]) {
        expect([4, 5, 9]).toContain(issue.rule);
      }
    }
  });
});

describe('copyStatus agrees with validate() on every board placement', () => {
  const tags = (n: number) => Array.from({ length: n }, (_, i) => `#Tag${i}`);
  const inputs: CopyText[] = [
    text(),
    text({
      caption:
        'Topping out today \u{1F477}\u{1F3FD}\u{200D}\u{2640}\u{FE0F} at the caf\u{E9}\non site #Build',
      hashtags: ['#build'],
    }),
    text({ caption: 'Apply at www.example.org/jobs', hashtags: ['careers', '#Hiring'] }),
    text({ caption: 'x'.repeat(139) }),
    text({ caption: 'x'.repeat(141) }),
    text({ caption: 'x'.repeat(211), hashtags: tags(3) }),
    text({ caption: '\u{E9}'.repeat(2199), hashtags: tags(30) }),
    text({ caption: '👋'.repeat(2201), hashtags: tags(31) }),
    text({ caption: 'y'.repeat(3001) }),
  ];

  for (const s of boardSpecs) {
    it(`${s.platform} ${s.placement}`, () => {
      for (const t of inputs) {
        const status = copyStatus(t, s);
        const input = {
          kind: 'image' as const,
          frames: [],
          caption: t.caption,
          hashtags: t.hashtags,
        };
        expect(status.caption.count).toBe(charCount(postedCaption(input, s)));
        expect(status.hashtags.count).toBe(collectHashtags(t.caption, t.hashtags).length);
        expect(status.caption.issues).toEqual(validatorIssues(t, s, [4, 9]));
        expect(status.hashtags.issues).toEqual(validatorIssues(t, s, [5]));
      }
    });
  }
});

describe('copyEdit', () => {
  const by = { provider: 'test-provider', model: 'test-model', at: '2026-11-23T00:00:00.000Z' };

  it('is no change when the text is what the box showed', () => {
    const c = copy({ caption: 'Hi', firstComment: 'First', hashtags: ['#a', 'b'], authoredBy: by });
    expect(copyEdit(c, 'caption', 'Hi')).toBeNull();
    expect(copyEdit(c, 'firstComment', 'First')).toBeNull();
    expect(copyEdit(c, 'hashtags', '#a b')).toBeNull();
  });

  it('writes a changed caption or first comment and removes authoredBy', () => {
    const c = copy({ caption: 'Hi', firstComment: 'First', authoredBy: by });
    expect(applied(c, copyEdit(c, 'caption', 'Hi there'))).toEqual(
      copy({ caption: 'Hi there', firstComment: 'First' }),
    );
    expect(applied(c, copyEdit(c, 'firstComment', ''))).toEqual(copy({ caption: 'Hi' }));
  });

  it('writes the parsed hashtags and removes authoredBy', () => {
    const c = copy({ hashtags: ['#a'], authoredBy: by });
    expect(applied(c, copyEdit(c, 'hashtags', '#a, #b\n#a'))).toEqual(
      copy({ hashtags: ['#a', '#b', '#a'] }),
    );
    expect(applied(c, copyEdit(c, 'hashtags', ' , '))).toEqual(copy({ hashtags: [] }));
  });

  it('is no change when only the hashtag formatting changed', () => {
    const c = copy({ hashtags: ['#a', 'b'], authoredBy: by });
    expect(copyEdit(c, 'hashtags', '#a, b')).toBeNull();
    expect(copyEdit(c, 'hashtags', '  #a\nb  ')).toBeNull();
  });

  it('is no change for a stored tag with a space in it when the box text is unchanged', () => {
    // Parsing "two words" again would split it, so the shown text is compared first.
    const c = copy({ hashtags: ['two words'] });
    expect(copyEdit(c, 'hashtags', 'two words')).toBeNull();
    expect(applied(c, copyEdit(c, 'hashtags', 'two  words'))).toEqual(
      copy({ hashtags: ['two', 'words'] }),
    );
  });

  it('changes only its own field', () => {
    const c = copy({ caption: 'C', firstComment: 'F', hashtags: ['#h'], altText: 'A' });
    expect(applied(c, copyEdit(c, 'hashtags', '#x'))).toEqual(
      copy({ caption: 'C', firstComment: 'F', hashtags: ['#x'], altText: 'A' }),
    );
  });
});
