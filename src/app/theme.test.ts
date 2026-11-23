/**
 * Contrast of the theme's text colours, read from src/index.css itself so the test follows the
 * file. Small text needs a contrast ratio of at least 4.5:1 (WCAG 2.1, level AA) against the
 * background it sits on, and the app has two backgrounds: surface and page.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');

/** The "#rrggbb" value of a colour token in the theme, for example token('page'). */
function token(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(css);
  if (!match?.[1]) throw new Error(`src/index.css has no six-digit hex colour named ${name}`);
  return match[1];
}

/** Relative luminance of a "#rrggbb" colour, as WCAG defines it. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two colours, from 1 (the same) to 21 (black on white). */
function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

const SMALL_TEXT_MINIMUM = 4.5;

/** The tokens the comment in src/index.css says are safe for small text. */
const SMALL_TEXT_TOKENS = [
  'danger-text',
  'success-text',
  'highlight-text',
  'muted-text',
  'ink',
  'ink-secondary',
  'primary',
  'accent',
  'link',
];

describe('theme text colours', () => {
  it('works out contrast the way WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // A well-known boundary: this grey is the lightest that reaches 4.5:1 on white.
    expect(contrast('#767676', '#ffffff')).toBeGreaterThanOrEqual(SMALL_TEXT_MINIMUM);
    expect(contrast('#777777', '#ffffff')).toBeLessThan(SMALL_TEXT_MINIMUM);
  });

  it('has the two backgrounds the contrast is measured against', () => {
    expect(token('surface').toLowerCase()).toBe('#ffffff');
    expect(token('page').toLowerCase()).toBe('#eef0f6');
  });

  it.each(SMALL_TEXT_TOKENS)('%s has at least 4.5:1 contrast on surface and on page', (name) => {
    expect(contrast(token(name), token('surface'))).toBeGreaterThanOrEqual(SMALL_TEXT_MINIMUM);
    expect(contrast(token(name), token('page'))).toBeGreaterThanOrEqual(SMALL_TEXT_MINIMUM);
  });
});
