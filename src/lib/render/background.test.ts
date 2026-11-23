import { DEFAULT_BACKGROUND, backgroundOf, parseBackground } from './background';

describe('parseBackground', () => {
  it('accepts a "#" and six hex digits, and returns them in lowercase', () => {
    expect(parseBackground('#1a2b3c')).toBe('#1a2b3c');
    expect(parseBackground('#1A2B3C')).toBe('#1a2b3c');
    expect(parseBackground('#AbCdEf')).toBe('#abcdef');
    expect(parseBackground('#000000')).toBe('#000000');
    expect(parseBackground('#ffffff')).toBe('#ffffff');
  });

  it.each([
    ['no "#"', '1a2b3c'],
    ['three digits', '#abc'],
    ['eight digits', '#1a2b3c4d'],
    ['five digits', '#1a2b3'],
    ['seven digits', '#1a2b3c4'],
    ['a letter that is not a hex digit', '#1a2b3g'],
    ['a colour name', 'white'],
    ['another way of writing a colour', 'rgb(255, 0, 0)'],
    ['a space before it', ' #1a2b3c'],
    ['a space after it', '#1a2b3c '],
    ['a line break after it', '#1a2b3c\n'],
    ['two "#"', '##1a2b3c'],
    ['an empty text', ''],
    ['a number', 0xffffff],
    ['null', null],
    ['undefined', undefined],
    ['true', true],
    ['a list', ['#1a2b3c']],
    ['an object', { colour: '#1a2b3c' }],
  ])('rejects %s', (_name, value) => {
    expect(parseBackground(value)).toBeUndefined();
  });
});

describe('backgroundOf', () => {
  it("is the card's own colour, in lowercase", () => {
    expect(backgroundOf({ background: '#1A2B3C' })).toBe('#1a2b3c');
  });

  it('is white for a card with no colour, or with one that cannot be used', () => {
    expect(DEFAULT_BACKGROUND).toBe('#ffffff');
    expect(backgroundOf({})).toBe('#ffffff');
    expect(backgroundOf({ background: 'red' })).toBe('#ffffff');
    expect(backgroundOf({ background: '#fff' })).toBe('#ffffff');
  });
});
