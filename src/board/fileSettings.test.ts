import { describe, expect, it } from 'vitest';
import {
  QUALITY_MAX,
  QUALITY_MIN,
  fromPercent,
  keyPercent,
  qualityText,
  qualityValueText,
  shownFormat,
  shownPercent,
  toPercent,
} from './fileSettings';

describe('what a card shows', () => {
  it('is JPG unless the card says PNG', () => {
    expect(shownFormat({})).toBe('jpg');
    expect(shownFormat({ format: 'jpg' })).toBe('jpg');
    expect(shownFormat({ format: 'png' })).toBe('png');
  });

  it('is the quality the renderer uses: 90% when missing or unusable, kept inside 0..100%', () => {
    expect(shownPercent({})).toBe(90);
    expect(shownPercent({ quality: Number.NaN })).toBe(90);
    expect(shownPercent({ quality: 0.6 })).toBe(60);
    expect(shownPercent({ quality: 0.05 })).toBe(5);
    expect(shownPercent({ quality: 2 })).toBe(100);
    expect(shownPercent({ quality: -1 })).toBe(0);
  });
});

describe('percent and quality', () => {
  it('round to whole percent, and back to at most two decimals', () => {
    expect(toPercent(0.904)).toBe(90);
    expect(fromPercent(90)).toBe(0.9);
    expect(fromPercent(7)).toBe(0.07);
    for (let percent = QUALITY_MIN; percent <= QUALITY_MAX; percent += 1) {
      expect(toPercent(fromPercent(percent))).toBe(percent);
    }
  });

  it('are written as "Quality: 90%" and "90%"', () => {
    expect(qualityText(90)).toBe('Quality: 90%');
    expect(qualityValueText(90)).toBe('90%');
  });
});

describe('keyPercent', () => {
  it('moves by one for the arrow keys, ten for Page Up and Down, and to the ends for Home and End', () => {
    expect(keyPercent('ArrowRight', 50)).toBe(51);
    expect(keyPercent('ArrowUp', 50)).toBe(51);
    expect(keyPercent('ArrowLeft', 50)).toBe(49);
    expect(keyPercent('ArrowDown', 50)).toBe(49);
    expect(keyPercent('PageUp', 50)).toBe(60);
    expect(keyPercent('PageDown', 50)).toBe(40);
    expect(keyPercent('Home', 50)).toBe(QUALITY_MIN);
    expect(keyPercent('End', 50)).toBe(QUALITY_MAX);
  });

  it('stops at the ends of the range', () => {
    expect(keyPercent('ArrowRight', QUALITY_MAX)).toBe(QUALITY_MAX);
    expect(keyPercent('PageUp', 95)).toBe(QUALITY_MAX);
    expect(keyPercent('ArrowLeft', QUALITY_MIN)).toBe(QUALITY_MIN);
    expect(keyPercent('PageDown', 15)).toBe(QUALITY_MIN);
  });

  it('never raises a value below the range with a key that means lower', () => {
    expect(keyPercent('ArrowLeft', 5)).toBe(5);
    expect(keyPercent('PageDown', 5)).toBe(5);
    expect(keyPercent('Home', 5)).toBe(5);
    expect(keyPercent('ArrowRight', 5)).toBe(QUALITY_MIN);
    expect(keyPercent('End', 5)).toBe(QUALITY_MAX);
  });

  it('ignores other keys', () => {
    expect(keyPercent('Tab', 50)).toBeNull();
    expect(keyPercent('a', 50)).toBeNull();
  });
});
