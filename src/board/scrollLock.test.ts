import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockPageScroll } from './scrollLock';

const root = document.documentElement;

/** jsdom lays nothing out, so the sizes and the scroll position are set by hand. */
function page({ scrollbar = 15, x = 0, y = 0 } = {}) {
  vi.spyOn(root, 'clientWidth', 'get').mockReturnValue(window.innerWidth - scrollbar);
  vi.spyOn(window, 'scrollX', 'get').mockReturnValue(x);
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(y);
}

let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollTo = vi.fn();
  vi.spyOn(window, 'scrollTo').mockImplementation(scrollTo as () => void);
});

afterEach(() => {
  vi.restoreAllMocks();
  root.removeAttribute('style');
});

describe('lockPageScroll', () => {
  it('stops the page scrolling and keeps the room its scrollbar takes', () => {
    page();
    lockPageScroll();
    expect(root.style.overflow).toBe('hidden');
    expect(root.style.scrollbarGutter).toBe('stable');
  });

  it('keeps no room when the page has no scrollbar that takes any', () => {
    page({ scrollbar: 0 });
    lockPageScroll();
    expect(root.style.overflow).toBe('hidden');
    expect(root.style.scrollbarGutter).toBe('');
  });

  it('does not move the page when it locks', () => {
    page({ y: 640 });
    lockPageScroll();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('puts the styles back and returns the page to where it was', () => {
    page({ x: 12, y: 640 });
    const release = lockPageScroll();
    release();
    expect(root.style.overflow).toBe('');
    expect(root.style.scrollbarGutter).toBe('');
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(12, 640);
  });

  it('returns to where the page was when it locked, not where it is on release', () => {
    page({ y: 640 });
    const release = lockPageScroll();
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(900);
    release();
    expect(scrollTo).toHaveBeenCalledWith(0, 640);
  });

  it('puts back styles the page already had', () => {
    page();
    root.style.overflow = 'scroll';
    root.style.scrollbarGutter = 'stable both-edges';
    const release = lockPageScroll();
    expect(root.style.overflow).toBe('hidden');
    expect(root.style.scrollbarGutter).toBe('stable');
    release();
    expect(root.style.overflow).toBe('scroll');
    expect(root.style.scrollbarGutter).toBe('stable both-edges');
  });

  it('releases once: a second call changes nothing', () => {
    page({ y: 640 });
    const release = lockPageScroll();
    release();
    root.style.overflow = 'clip';
    release();
    expect(root.style.overflow).toBe('clip');
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});
