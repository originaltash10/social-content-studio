import { describe, expect, it } from 'vitest';
import { isTyping, isUndoKey } from './keys';

function input(type: string) {
  const element = document.createElement('input');
  element.type = type;
  return element;
}

describe('isTyping', () => {
  it('is true for fields that hold text', () => {
    expect(isTyping(input('text'))).toBe(true);
    expect(isTyping(input('search'))).toBe(true);
    expect(isTyping(input('number'))).toBe(true);
    expect(isTyping(document.createElement('textarea'))).toBe(true);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not work out isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTyping(editable)).toBe(true);
  });

  it('is false for a checkbox, a radio button, a slider and a colour picker, which hold no text', () => {
    expect(isTyping(input('checkbox'))).toBe(false);
    expect(isTyping(input('radio'))).toBe(false);
    expect(isTyping(input('range'))).toBe(false);
    expect(isTyping(input('color'))).toBe(false);
  });

  it('is false for anything else', () => {
    expect(isTyping(document.createElement('button'))).toBe(false);
    expect(isTyping(document.body)).toBe(false);
    expect(isTyping(window)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

describe('isUndoKey', () => {
  const key = (init: Partial<KeyboardEvent>) => ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    key: 'z',
    ...init,
  });

  it('is Ctrl-Z or Cmd-Z, in either case', () => {
    expect(isUndoKey(key({ ctrlKey: true }))).toBe(true);
    expect(isUndoKey(key({ metaKey: true }))).toBe(true);
    expect(isUndoKey(key({ ctrlKey: true, key: 'Z' }))).toBe(true);
  });

  it('is not redo, a plain z, or another key', () => {
    expect(isUndoKey(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isUndoKey(key({}))).toBe(false);
    expect(isUndoKey(key({ ctrlKey: true, key: 'y' }))).toBe(false);
  });
});
