import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captionCountText,
  firstCommentCountText,
  formatCount,
  hashtagCountText,
  STORY_NOTE,
} from './copyText';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatCount', () => {
  it('writes numbers the en-US way', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(2200)).toBe('2,200');
    expect(formatCount(63206)).toBe('63,206');
    expect(formatCount(1234567)).toBe('1,234,567');
  });

  it("does not follow the browser's language", () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE']);
    expect(formatCount(2200)).toBe('2,200');
    expect(captionCountText({ count: 1500, cap: 2200, includesHashtags: false })).toBe(
      '1,500 of 2,200 characters',
    );
  });
});

describe('captionCountText', () => {
  it('says the count and the limit', () => {
    expect(captionCountText({ count: 120, cap: 2200, includesHashtags: false })).toBe(
      '120 of 2,200 characters',
    );
  });

  it('says when the count includes the hashtags', () => {
    expect(captionCountText({ count: 250, cap: 3000, includesHashtags: true })).toBe(
      '250 of 3,000 characters, including hashtags',
    );
  });

  it('says only the count where there is no limit', () => {
    expect(captionCountText({ count: 120, cap: null, includesHashtags: false })).toBe(
      '120 characters',
    );
    expect(captionCountText({ count: 120, cap: null, includesHashtags: true })).toBe(
      '120 characters, including hashtags',
    );
  });

  it('uses the singular for one', () => {
    expect(captionCountText({ count: 1, cap: null, includesHashtags: false })).toBe('1 character');
    expect(captionCountText({ count: 0, cap: 1, includesHashtags: false })).toBe(
      '0 of 1 character',
    );
  });
});

describe('hashtagCountText', () => {
  it('says the count and the limit, or only the count', () => {
    expect(hashtagCountText({ count: 4, cap: 30 })).toBe('4 of 30 hashtags');
    expect(hashtagCountText({ count: 4, cap: null })).toBe('4 hashtags');
    expect(hashtagCountText({ count: 1, cap: null })).toBe('1 hashtag');
    expect(hashtagCountText({ count: 0, cap: null })).toBe('0 hashtags');
  });
});

describe('firstCommentCountText', () => {
  it('says only the count', () => {
    expect(firstCommentCountText({ count: 0 })).toBe('0 characters');
    expect(firstCommentCountText({ count: 1 })).toBe('1 character');
    expect(firstCommentCountText({ count: 2201 })).toBe('2,201 characters');
  });
});

describe('STORY_NOTE', () => {
  it('is the wording SPEC.md gives', () => {
    expect(STORY_NOTE).toBe(
      "Reels show this caption. Stories don't show captions, hashtags or a first comment.",
    );
  });
});
