import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHashtags } from '../lib/board/copyChecks';
import { hashtagCell } from '../lib/export/captionsCsv';
import {
  ALT_TEXT_HINT,
  altTextCountText,
  captionCountText,
  clipboardText,
  COPY_BUTTON_NAME,
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

describe('the alt text words', () => {
  it('count characters, the en-US way, with no limit', () => {
    expect(altTextCountText({ count: 0 })).toBe('0 characters');
    expect(altTextCountText({ count: 1 })).toBe('1 character');
    expect(altTextCountText({ count: 1234 })).toBe('1,234 characters');
  });

  it('have the hint from the spec', () => {
    expect(ALT_TEXT_HINT).toBe('Describe the picture for people who use screen readers.');
  });
});

describe('COPY_BUTTON_NAME', () => {
  it('names each Copy button after its box', () => {
    expect(COPY_BUTTON_NAME).toEqual({
      caption: 'Copy caption',
      hashtags: 'Copy hashtags',
      firstComment: 'Copy first comment',
      altText: 'Copy alt text',
    });
  });
});

describe('clipboardText', () => {
  it('gives the caption, first comment and alt text exactly as typed', () => {
    for (const text of [
      'Hello',
      ' edge spaces ',
      'line one\nline two\n\nline four',
      'Topping out \u{1F477}\u{1F3FD}\u{200D}\u{2640}\u{FE0F}',
      'caf\u{E9}',
      'cafe\u{301}',
      '#notatag in a caption',
    ]) {
      for (const field of ['caption', 'firstComment', 'altText'] as const) {
        expect(clipboardText(field, text)).toBe(text);
      }
    }
    // Precomposed and decomposed accents are not normalised into each other.
    expect(clipboardText('caption', 'caf\u{E9}')).not.toBe(clipboardText('caption', 'cafe\u{301}'));
  });

  it('gives nothing for an empty box or one of only spaces and line breaks', () => {
    for (const text of ['', ' ', '\n', ' \t\r\n ']) {
      for (const field of ['caption', 'hashtags', 'firstComment', 'altText'] as const) {
        expect(clipboardText(field, text)).toBe('');
      }
    }
  });

  it('gives the hashtags with "#" added where missing, separated by single spaces', () => {
    expect(clipboardText('hashtags', 'build, #Site\n  caf\u{E9}\t##two')).toBe(
      '#build #Site #caf\u{E9} ##two',
    );
    expect(clipboardText('hashtags', '\u{1F3D7}\u{FE0F}')).toBe('#\u{1F3D7}\u{FE0F}');
  });

  it('gives nothing for hashtags of bare "#" marks only', () => {
    expect(clipboardText('hashtags', '# #')).toBe('');
    expect(clipboardText('hashtags', ' ##, #\n#')).toBe('');
    expect(clipboardText('hashtags', '# #a #')).toBe('#a');
  });

  it("gives the hashtags exactly as the export's captions.csv cell does", () => {
    for (const text of ['', '# #', 'a b', '#a,#b\nc', ' ##x  y ', 'cafe\u{301} caf\u{E9}']) {
      expect(clipboardText('hashtags', text)).toBe(hashtagCell(parseHashtags(text)));
    }
  });
});
