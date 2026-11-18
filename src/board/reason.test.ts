import { describe, expect, it } from 'vitest';
import type { Issue, ValidationResult } from '../types';
import { firstReason } from './reason';

const warn: Issue = { rule: 8, level: 'warn', message: 'Alt text is missing.' };
const fail: Issue = { rule: 5, level: 'fail', message: 'Too many hashtags.' };

describe('firstReason', () => {
  it('is null for a card with no reasons', () => {
    expect(firstReason({ level: 'pass', issues: [] })).toBeNull();
  });

  it('gives the only reason, without its full stop', () => {
    expect(firstReason({ level: 'warn', issues: [warn] })).toEqual({
      level: 'warn',
      message: 'Alt text is missing',
      more: 0,
    });
  });

  it('leads with a reason at the level of the card and counts the rest', () => {
    const result: ValidationResult = { level: 'fail', issues: [warn, fail, warn] };
    expect(firstReason(result)).toEqual({ level: 'fail', message: 'Too many hashtags', more: 2 });
  });

  it('falls back to the first reason when none is at the level of the card', () => {
    expect(firstReason({ level: 'pass', issues: [warn] })?.message).toBe('Alt text is missing');
  });

  it('keeps a message that does not end in a full stop', () => {
    const cut: Issue = { rule: 4, level: 'warn', message: 'Cut off after "Hello" …more' };
    expect(firstReason({ level: 'warn', issues: [cut] })?.message).toBe(cut.message);
  });
});
