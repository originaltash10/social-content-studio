import { describe, expect, it, vi } from 'vitest';
import { Slot } from './slot';

describe('Slot', () => {
  it('holds a value and tells listeners when it changes', () => {
    const slot = new Slot<string | null>(null);
    const listener = vi.fn();
    const stop = slot.subscribe(listener);
    expect(slot.get()).toBeNull();
    slot.set('a');
    expect(slot.get()).toBe('a');
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    slot.set('b');
    expect(slot.get()).toBe('b');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('says nothing when set to the value it already has', () => {
    const value = {};
    const slot = new Slot(value);
    const listener = vi.fn();
    slot.subscribe(listener);
    slot.set(value);
    expect(listener).not.toHaveBeenCalled();
  });

  it('get and subscribe keep working when passed around on their own', () => {
    const slot = new Slot(1);
    const { get, subscribe } = slot;
    const listener = vi.fn();
    subscribe(listener);
    slot.set(2);
    expect(get()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
