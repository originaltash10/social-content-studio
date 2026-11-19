import { describe, expect, it } from 'vitest';
import {
  CAPTIONS_FILE,
  ExportNameError,
  FALLBACK_SESSION_PART,
  MAX_SESSION_PART,
  assertUniquePaths,
  exportFileName,
  exportPath,
  safePart,
  sessionPart,
  zipFileName,
} from './names';
import type { FileNameParts } from './names';

const CARD = '3f2a9c1e-7b4d-4e8a-9f00-1c2d3e4f5a6b';

function parts(overrides: Partial<FileNameParts> = {}): FileNameParts {
  return {
    sessionName: 'Topping out',
    platform: 'instagram',
    placement: 'feed-vertical',
    cardId: CARD,
    format: 'jpg',
    ...overrides,
  };
}

describe('safePart', () => {
  it('keeps letters, digits and "-"', () => {
    expect(safePart('Site-42-west')).toBe('Site-42-west');
  });

  it('turns spaces and "_" into "-", so "_" only ever separates the parts of a name', () => {
    expect(safePart('Topping out_phase 2')).toBe('Topping-out-phase-2');
  });

  it('drops accents rather than the letters they sit on', () => {
    expect(safePart('Café Zoë Ñandú')).toBe('Cafe-Zoe-Nandu');
  });

  it.each([
    ['a/b\\c', 'a-b-c'],
    ['a:b*c?d', 'a-b-c-d'],
    ['"a" <b> |c|', 'a-b-c'],
    ['../../etc/passwd', 'etc-passwd'],
    ['tab\tnew\nline', 'tab-new-line'],
    ['emoji 🎉 party', 'emoji-party'],
    ['日本語 site', 'site'],
  ])('makes %j safe in a file name', (input, expected) => {
    expect(safePart(input)).toBe(expected);
  });

  it('collapses runs of "-" and trims them from both ends', () => {
    expect(safePart('  -- a - b --  ')).toBe('a-b');
  });

  it('returns an empty string when nothing can be kept', () => {
    expect(safePart('🎉 / ✨')).toBe('');
  });
});

describe('sessionPart', () => {
  it('is the safe form of the session name', () => {
    expect(sessionPart('Topping out')).toBe('Topping-out');
  });

  it(`is cut to ${MAX_SESSION_PART} characters`, () => {
    const long = 'a'.repeat(MAX_SESSION_PART + 10);
    expect(sessionPart(long)).toBe('a'.repeat(MAX_SESSION_PART));
  });

  it('does not end with "-" after being cut', () => {
    const name = `${'a'.repeat(MAX_SESSION_PART - 1)} b`;
    expect(sessionPart(name)).toBe('a'.repeat(MAX_SESSION_PART - 1));
  });

  it.each(['', '   ', '🎉', '___'])('falls back to "session" for %j', (name) => {
    expect(sessionPart(name)).toBe(FALLBACK_SESSION_PART);
  });
});

describe('exportFileName', () => {
  it('follows {session}_{platform}_{placement}_{cardId}.{ext}', () => {
    expect(exportFileName(parts())).toBe(`Topping-out_instagram_feed-vertical_${CARD}.jpg`);
  });

  it('takes the extension from the format of the file that was made', () => {
    expect(exportFileName(parts({ format: 'png' }))).toBe(
      `Topping-out_instagram_feed-vertical_${CARD}.png`,
    );
  });

  it('gives a duplicated card ("v2") its own name through its own card id', () => {
    const copy = '9e8d7c6b-5a49-4382-a716-151413121110';
    expect(exportFileName(parts({ cardId: copy }))).not.toBe(exportFileName(parts()));
  });

  it('does not depend on the photo, so two photos with the same file name cannot clash', () => {
    const name = exportFileName(parts());
    expect(name).not.toContain('IMG');
    expect(name).not.toMatch(/\.(heic|jpe?g|png)_/i);
  });

  it('makes a placement key or card id from outside the app safe as well', () => {
    expect(exportFileName(parts({ placement: 'feed/../vertical', cardId: 'a_b c' }))).toBe(
      'Topping-out_instagram_feed-vertical_a-b-c.jpg',
    );
  });

  it('uses the fallback session part for a name with nothing to keep', () => {
    expect(exportFileName(parts({ sessionName: '🎉' }))).toBe(
      `session_instagram_feed-vertical_${CARD}.jpg`,
    );
  });
});

describe('exportPath', () => {
  it('puts each file in a folder named after its platform', () => {
    expect(exportPath(parts({ platform: 'linkedin', placement: 'image-square' }))).toBe(
      `linkedin/Topping-out_linkedin_image-square_${CARD}.jpg`,
    );
  });
});

describe('zipFileName', () => {
  it('names the zip after the session', () => {
    expect(zipFileName('Topping out: phase 2')).toBe('Topping-out-phase-2_export.zip');
  });

  it('falls back to "session"', () => {
    expect(zipFileName('')).toBe('session_export.zip');
  });
});

describe('assertUniquePaths', () => {
  it('accepts paths that all differ', () => {
    expect(() =>
      assertUniquePaths(['instagram/a.jpg', 'linkedin/a.jpg', CAPTIONS_FILE]),
    ).not.toThrow();
  });

  it('accepts no paths', () => {
    expect(() => assertUniquePaths([])).not.toThrow();
  });

  it('refuses two paths that differ only in case, as Windows and macOS would merge them', () => {
    const run = () => assertUniquePaths(['instagram/A.jpg', 'instagram/a.jpg']);
    expect(run).toThrow(ExportNameError);
    expect(run).toThrow('Two cards would both be saved as "instagram/a.jpg"');
  });

  it('names the error for the status line', () => {
    expect(new ExportNameError('x').name).toBe('ExportNameError');
  });
});
