import { describe, expect, it } from 'vitest';
import { invalidHexMessage, parseHexInput } from './backgroundColour';

describe('parseHexInput', () => {
  it('takes six hex digits with or without "#", in any case, as "#rrggbb" in lowercase', () => {
    expect(parseHexInput('#0a7f5c')).toBe('#0a7f5c');
    expect(parseHexInput('0a7f5c')).toBe('#0a7f5c');
    expect(parseHexInput('#0A7F5C')).toBe('#0a7f5c');
    expect(parseHexInput('0A7f5C')).toBe('#0a7f5c');
    expect(parseHexInput('FFFFFF')).toBe('#ffffff');
    expect(parseHexInput('000000')).toBe('#000000');
  });

  it('ignores spaces around what was typed', () => {
    expect(parseHexInput('  #0a7f5c ')).toBe('#0a7f5c');
    expect(parseHexInput('\t0A7F5C\n')).toBe('#0a7f5c');
  });

  it.each([
    ['nothing', ''],
    ['only spaces', '   '],
    ['only "#"', '#'],
    ['three digits', '#0af'],
    ['five digits', '0a7f5'],
    ['seven digits', '0a7f5c1'],
    ['eight digits', '#0a7f5cff'],
    ['two "#"', '##0a7f5c'],
    ['a letter that is not a hex digit', '0a7f5z'],
    ['a space in the middle', '0a7 f5c'],
    ['a colour name', 'white'],
    ['another way of writing a colour', 'rgb(10, 127, 92)'],
  ])('is null for %s', (_name, text) => {
    expect(parseHexInput(text)).toBeNull();
  });
});

describe('invalidHexMessage', () => {
  it('says in plain words what to type, and that the colour has not changed', () => {
    const message = invalidHexMessage('#0a7f5c');
    expect(message).toContain('six characters');
    expect(message).toContain('The colour is still #0a7f5c.');
    expect(message).not.toMatch(/hex|invalid|error|regex|undefined|null/i);
  });
});
