/**
 * The caption, hashtags and first comment boxes: their labels, live counts and messages. The
 * store is real and the card is read from it on every render, as the card dialog does. What the
 * boxes say is checked against copyStatus(), which is itself checked against validate().
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { copyStatus, parseHashtags } from '../lib/board/copyChecks';
import { getPlacement, platforms } from '../lib/platforms';
import { useSessionStore } from '../store/sessionStore';
import { hash, makeAsset, makeCard } from '../test/fixtures';
import type { Card, PlacementSpec, Platform } from '../types';
import {
  captionCountText,
  firstCommentCountText,
  hashtagCountText,
  HASHTAG_HINT,
  NO_LIMITS_NOTE,
  STORY_NOTE,
} from './copyText';
import { CopyFields } from './CopyFields';

const PHOTO = makeAsset({ id: hash('a'), fileName: 'site.jpg' });
const store = () => useSessionStore.getState();

function spec(platform: Platform, placement: string): PlacementSpec {
  const found = getPlacement(platform, placement);
  if (!found) throw new Error(`no ${platform} ${placement} in platforms.json`);
  return found;
}
function limit(value: number | null): number {
  if (value === null) throw new Error('expected a limit in platforms.json');
  return value;
}

const FEED = spec('instagram', 'feed-vertical');
const REEL_STORY = spec('instagram', 'story');
const LINKEDIN = spec('linkedin', 'image-square');

/** The boxes for the session's one card, as it is in the store now. */
function Live() {
  const card = useSessionStore((state) => state.session?.cards[0]);
  if (!card) return null;
  return (
    <CopyFields
      card={card}
      spec={getPlacement(card.platform, card.placement)}
      record={(change) => change()}
    />
  );
}

/** Opens a session with one card for this placement and the given copy, and shows its boxes. */
function openWith(platform: Platform, placement: string, copy: Partial<Card['copy']> = {}) {
  act(() => {
    store().clearSession(() => true);
    store().createSession('Copy test');
    store().addAssets([{ asset: PHOTO, blob: new Blob(['photo']) }]);
    const { id, version, parentId, ...draft } = makeCard({
      assetIds: [PHOTO.id],
      platform,
      placement,
      copy: { caption: '', firstComment: '', hashtags: [], altText: '', ...copy },
    });
    void [id, version, parentId]; // the store gives these
    store().addCard(draft);
  });
  return render(<Live />);
}

const box = (label: string) => screen.getByLabelText(label) as HTMLTextAreaElement;
const caption = () => box('Caption');
const hashtags = () => box('Hashtags');
const firstComment = () => box('First comment');

/** The elements a box's aria-describedby points at, in order. */
function describedBy(element: HTMLElement): HTMLElement[] {
  const ids = element.getAttribute('aria-describedby')?.split(' ') ?? [];
  return ids.map((id) => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`aria-describedby points at a missing id: ${id}`);
    return found;
  });
}
const describedText = (element: HTMLElement) => describedBy(element).map((e) => e.textContent);

/** Types into a box, as the browser reports it: the whole new value. */
function type(element: HTMLTextAreaElement, value: string) {
  fireEvent.focus(element);
  fireEvent.change(element, { target: { value } });
}

/** What copyStatus says for the boxes as they are now. */
function expected(s: PlacementSpec) {
  return copyStatus(
    {
      caption: caption().value,
      hashtags: parseHashtags(hashtags().value),
      firstComment: firstComment().value,
      altText: '',
    },
    s,
  );
}

beforeEach(() => {
  act(() => {
    store().clearSession(() => true);
  });
});

describe('the boxes', () => {
  it('are labelled text areas showing the card copy, hashtags separated by spaces', () => {
    openWith('instagram', 'feed-vertical', {
      caption: 'Topping out\ntoday.',
      hashtags: ['#build', 'site'],
      firstComment: 'More soon.',
    });
    expect(caption().tagName).toBe('TEXTAREA');
    expect(caption().value).toBe('Topping out\ntoday.');
    expect(hashtags().value).toBe('#build site');
    expect(firstComment().value).toBe('More soon.');
    expect(screen.getByRole('region', { name: 'Post text' })).toBeInTheDocument();
  });

  it('give empty boxes their counts and no messages', () => {
    openWith('instagram', 'feed-vertical');
    expect(describedText(caption())).toEqual([
      `0 of ${limit(FEED.captionCap).toLocaleString('en-US')} characters`,
    ]);
    expect(describedText(hashtags())).toEqual([
      `0 of ${limit(FEED.hashtagCap)} hashtags`,
      HASHTAG_HINT,
    ]);
    expect(describedText(firstComment())).toEqual(['0 characters']);
    expect(screen.queryAllByRole('listitem')).toEqual([]);
    expect(caption()).not.toHaveAttribute('aria-invalid');
  });
});

describe('the live counts', () => {
  it('follow typing and agree with copyStatus, counting emoji and accents as it does', () => {
    openWith('instagram', 'feed-vertical');
    const inputs = [
      'Hi \u{1F44B}',
      '\u{1F44D}\u{1F3FD}',
      '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}',
      'caf\u{E9}',
      'cafe\u{301}',
      'a\nb',
    ];
    for (const text of inputs) {
      type(caption(), text);
      type(firstComment(), text);
      const status = expected(FEED);
      expect(describedText(caption())[0]).toBe(captionCountText(status.caption));
      expect(describedText(firstComment())[0]).toBe(firstCommentCountText(status.firstComment));
    }
    // Spot checks of the same counts, in words.
    type(caption(), 'Hi \u{1F44B}');
    expect(describedText(caption())[0]).toMatch(/^4 of /);
    type(caption(), 'cafe\u{301}');
    expect(describedText(caption())[0]).toMatch(/^5 of /);
  });

  it('count the hashtags in the box and in the caption as rule 5 does', () => {
    openWith('instagram', 'feed-vertical');
    type(caption(), 'New site #Build');
    type(hashtags(), '#build, Site\n#site');
    expect(describedText(hashtags())[0]).toBe(hashtagCountText(expected(FEED).hashtags));
    expect(describedText(hashtags())[0]).toBe(`2 of ${limit(FEED.hashtagCap)} hashtags`);
  });

  it('include the hashtags in the caption count where they are posted in the caption', () => {
    openWith('linkedin', 'image-square');
    type(caption(), 'Hello');
    expect(describedText(caption())[0]).toMatch(/^5 of .* characters, including hashtags$/);
    // Typing in the hashtags box changes the caption count straight away.
    type(hashtags(), '#a b');
    expect(describedText(caption())[0]).toBe(captionCountText(expected(LINKEDIN).caption));
    expect(describedText(caption())[0]).toMatch(/^11 of /);
    expect(describedText(hashtags())[0]).toBe('2 hashtags');
  });
});

describe('the messages', () => {
  it('pass at the caption cap and fail one over, in words and not only colour', () => {
    openWith('instagram', 'feed-vertical');
    const cap = limit(FEED.captionCap);
    type(caption(), 'a'.repeat(cap));
    expect(describedText(caption())).toHaveLength(1);
    type(caption(), 'a'.repeat(cap + 1));
    const [count, messages] = describedBy(caption());
    expect(count).toHaveTextContent(
      `${(cap + 1).toLocaleString('en-US')} of ${cap.toLocaleString('en-US')} characters`,
    );
    const item = messages?.querySelector('li');
    expect(item).toHaveTextContent(/^Fail: Caption is /);
    expect(item).toHaveTextContent(expected(FEED).caption.issues[0]?.message as string);
    expect(item).toHaveClass('text-danger-text');
    expect(caption()).toHaveAttribute('aria-invalid', 'true');
  });

  it('give the Reel / Story placement the feed caption cap', () => {
    openWith('instagram', 'story');
    const cap = limit(REEL_STORY.captionCap);
    type(caption(), 'a'.repeat(cap + 1));
    expect(describedText(caption())[1]).toMatch(/^Fail: Caption is /);
  });

  it('fail one hashtag over the cap', () => {
    openWith('instagram', 'feed-vertical');
    const cap = limit(FEED.hashtagCap);
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(' ');
    type(hashtags(), tags(cap));
    expect(describedText(hashtags())).toHaveLength(2);
    type(hashtags(), tags(cap + 1));
    const messages = describedBy(hashtags())[2];
    expect(messages?.querySelector('li')).toHaveTextContent(/^Fail: \d+ hashtags; /);
    expect(messages?.querySelector('li')).toHaveClass('text-danger-text');
    expect(hashtags()).toHaveAttribute('aria-invalid', 'true');
  });

  it('warn past each "…more" cut-off from platforms.json, as plain text', () => {
    openWith('linkedin', 'image-square');
    const first = Math.min(...LINKEDIN.truncation.map((t) => t.chars));
    type(caption(), 'a'.repeat(first));
    expect(describedText(caption())).toHaveLength(1);
    type(caption(), 'a'.repeat(first + 1));
    const items = describedBy(caption())[1]?.querySelectorAll('li') ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent(/^Warning: Caption is .* cuts it off after .*…more$/);
    expect(items[0]).toHaveClass('text-highlight-text');
    expect(caption()).not.toHaveAttribute('aria-invalid');
  });

  it('show no cut-off warning where platforms.json gives none', () => {
    openWith('instagram', 'feed-vertical');
    expect(FEED.truncation).toEqual([]);
    type(caption(), 'a'.repeat(limit(FEED.captionCap)));
    expect(screen.queryAllByRole('listitem')).toEqual([]);
  });

  it('warn about a link in an Instagram caption', () => {
    openWith('instagram', 'feed-vertical');
    type(caption(), 'Apply at example.com/jobs');
    expect(describedText(caption())[1]).toMatch(/^Warning: Caption contains a link/);
  });

  it('are exactly copyStatus messages, in order', () => {
    openWith('linkedin', 'image-square');
    type(caption(), 'x'.repeat(limit(LINKEDIN.captionCap) - 3));
    type(hashtags(), '#one #two');
    const shown = [...(describedBy(caption())[1]?.querySelectorAll('li') ?? [])].map(
      (li) => li.textContent,
    );
    expect(shown).toEqual(
      expected(LINKEDIN).caption.issues.map(
        (issue) => `${issue.level === 'fail' ? 'Fail' : 'Warning'}: ${issue.message}`,
      ),
    );
  });
});

describe('the Story note', () => {
  it('shows under the boxes on the Reel / Story placement', () => {
    openWith('instagram', 'story');
    expect(REEL_STORY.canBeStory).toBe(true);
    const note = screen.getByText(STORY_NOTE);
    expect(note).toHaveClass('text-ink-secondary');
    // After the last box: the note is about all three.
    expect(
      firstComment().compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // It is not a message and does not mark any box.
    expect(screen.queryAllByRole('listitem')).toEqual([]);
  });

  it('shows wherever platforms.json says a placement can be a Story, and nowhere else', () => {
    for (const s of platforms.placements) {
      const view = openWith(s.platform, s.placement);
      expect(screen.queryByText(STORY_NOTE) !== null).toBe(s.canBeStory);
      view.unmount();
    }
  });
});

describe('a card whose placement is not in platforms.json', () => {
  it('has the boxes, no counts, and says its limits are not known', () => {
    openWith('instagram', 'gone', { caption: 'Hello' });
    expect(caption().value).toBe('Hello');
    expect(screen.getByText(NO_LIMITS_NOTE)).toBeInTheDocument();
    expect(caption()).not.toHaveAttribute('aria-describedby');
    expect(describedText(hashtags())).toEqual([HASHTAG_HINT]);
    expect(screen.queryByText(STORY_NOTE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Writing the text: one undo step per visit (SPEC.md, "Undo")
// ---------------------------------------------------------------------------------------------

const steps = () => store().undoStack.length;
const stored = () => store().session?.cards[0]?.copy;
/** Moves focus into a box, as Tab or a click does. */
const enter = (element: HTMLElement) => act(() => element.focus());
/** Moves focus out of a box, as Tab away or a click elsewhere does. */
const leave = (element: HTMLElement) => act(() => element.blur());
/** Marks the session as saved, so a later write would set the dirty flag again. */
const save = () => act(() => store().markSaved(store().revision));

/** Shows the page as hidden (another tab, or the tab closing), or visible again. */
function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('writing the text', () => {
  it('makes no store write while typing', () => {
    openWith('instagram', 'feed-vertical', { caption: 'Start' });
    save();
    const revision = store().revision;
    const before = steps();
    enter(caption());
    for (const text of ['S', 'St', 'Sta', 'Start again']) type(caption(), text);
    expect(store().revision).toBe(revision);
    expect(steps()).toBe(before);
    expect(store().dirty).toBe(false);
    expect(stored()?.caption).toBe('Start');
    expect(caption().value).toBe('Start again');
  });

  it('writes once, as one undo step, on leaving the box', () => {
    openWith('instagram', 'feed-vertical', { caption: 'Start' });
    const before = steps();
    enter(caption());
    type(caption(), 'Start again');
    type(caption(), 'Start again today');
    leave(caption());
    expect(steps()).toBe(before + 1);
    expect(stored()?.caption).toBe('Start again today');
  });

  it('writes nothing when the text is the same on leaving', () => {
    openWith('instagram', 'feed-vertical', { caption: 'Start', hashtags: ['#a', 'b'] });
    save();
    const before = steps();
    enter(caption());
    type(caption(), 'Something else');
    type(caption(), 'Start');
    leave(caption());
    enter(firstComment());
    leave(firstComment());
    expect(steps()).toBe(before);
    expect(store().dirty).toBe(false);
  });

  it('writes nothing when only the hashtag formatting changed', () => {
    openWith('instagram', 'feed-vertical', { hashtags: ['#a', 'b'] });
    save();
    const before = steps();
    enter(hashtags());
    type(hashtags(), '#a,\n b ');
    leave(hashtags());
    expect(steps()).toBe(before);
    expect(stored()?.hashtags).toEqual(['#a', 'b']);
    expect(store().dirty).toBe(false);
  });

  it('writes the parsed hashtags, in order and with duplicates, and shows them spaced', () => {
    openWith('instagram', 'feed-vertical');
    enter(hashtags());
    type(hashtags(), '#b, a\n#b');
    leave(hashtags());
    expect(stored()?.hashtags).toEqual(['#b', 'a', '#b']);
    expect(hashtags().value).toBe('#b a #b');
  });

  it('removes authoredBy when a box changes the text, and keeps it otherwise', () => {
    const by = { provider: 'test-provider', model: 'test-model', at: '2026-11-23T00:00:00.000Z' };
    for (const [field, from, to] of [
      ['Caption', 'Hello', 'Hello there'],
      ['Hashtags', '#a', '#a #b'],
      ['First comment', 'First', 'First!'],
    ] as const) {
      const view = openWith('instagram', 'feed-vertical', {
        caption: 'Hello',
        hashtags: ['#a'],
        firstComment: 'First',
        authoredBy: by,
      });
      // Visiting without a change, or reformatting the hashtags, keeps it.
      enter(box(field));
      type(box(field), field === 'Hashtags' ? '#a,' : from);
      leave(box(field));
      expect(stored()?.authoredBy).toEqual(by);
      // A change removes it, in the same undo step as the text.
      const before = steps();
      enter(box(field));
      type(box(field), to);
      leave(box(field));
      expect(steps()).toBe(before + 1);
      expect(stored()?.authoredBy).toBeUndefined();
      // Undo brings back both the text and authoredBy.
      act(() => {
        store().undo();
      });
      expect(stored()?.authoredBy).toEqual(by);
      view.unmount();
    }
  });

  it('writes a box still focused when the boxes go away (the dialog closing), once', () => {
    const view = openWith('instagram', 'feed-vertical', { firstComment: 'First' });
    const before = steps();
    enter(firstComment());
    type(firstComment(), 'First, and more');
    view.unmount();
    expect(steps()).toBe(before + 1);
    expect(stored()?.firstComment).toBe('First, and more');
  });

  it('writes nothing on going away when no box is focused', () => {
    const view = openWith('instagram', 'feed-vertical');
    const before = steps();
    enter(caption());
    type(caption(), 'Written on leaving');
    leave(caption());
    view.unmount();
    expect(steps()).toBe(before + 1);
  });

  it('writes the focused box when the page is hidden, and carries on from there', () => {
    try {
      openWith('instagram', 'feed-vertical');
      const before = steps();
      enter(caption());
      type(caption(), 'Typed before the tab closed');
      setVisibility('hidden');
      expect(steps()).toBe(before + 1);
      expect(stored()?.caption).toBe('Typed before the tab closed');
      // The box keeps its focus and its text; hiding again with nothing new writes nothing.
      expect(caption()).toHaveFocus();
      expect(caption().value).toBe('Typed before the tab closed');
      setVisibility('visible');
      setVisibility('hidden');
      expect(steps()).toBe(before + 1);
      // More typing in the same visit is written on leaving, as its own step.
      setVisibility('visible');
      type(caption(), 'Typed before the tab closed, and after');
      leave(caption());
      expect(steps()).toBe(before + 2);
      expect(stored()?.caption).toBe('Typed before the tab closed, and after');
    } finally {
      setVisibility('visible');
    }
  });

  it('writes nothing when the page is hidden with no box focused', () => {
    try {
      openWith('instagram', 'feed-vertical');
      save();
      setVisibility('hidden');
      expect(store().dirty).toBe(false);
    } finally {
      setVisibility('visible');
    }
  });

  it('does nothing when the card is gone by the time the text is written', () => {
    try {
      for (const how of ['blur', 'unmount', 'hidden'] as const) {
        openWith('instagram', 'feed-vertical', { caption: 'Hello' });
        const card = store().session?.cards[0] as Card;
        // The boxes are given the card as it was, as a dialog that has not closed yet would.
        cleanup();
        const view = render(<CopyFields card={card} spec={FEED} record={(change) => change()} />);
        enter(caption());
        type(caption(), 'Hello, gone');
        // Undo of the card's creation removes it.
        act(() => {
          store().undo();
        });
        expect(store().session?.cards).toEqual([]);
        save();
        const before = steps();
        if (how === 'blur') leave(caption());
        if (how === 'hidden') setVisibility('hidden');
        view.unmount();
        expect(steps()).toBe(before);
        expect(store().dirty).toBe(false);
        expect(store().session?.cards).toEqual([]);
        setVisibility('visible');
      }
    } finally {
      setVisibility('visible');
    }
  });

  it('shows the text again after an undo, in a box that is not focused', () => {
    openWith('instagram', 'feed-vertical', { caption: 'Before' });
    enter(caption());
    type(caption(), 'After');
    leave(caption());
    act(() => {
      store().undo();
    });
    expect(stored()?.caption).toBe('Before');
    expect(caption().value).toBe('Before');
  });

  it('keeps the draft of a focused box when another write changes the card', () => {
    openWith('instagram', 'feed-vertical', { caption: 'Caption', firstComment: 'Comment' });
    enter(caption());
    type(caption(), 'Caption being typed');
    act(() => {
      store().updateCard(store().session?.cards[0]?.id as string, (card) => {
        card.copy.firstComment = 'Comment changed elsewhere';
      });
    });
    expect(caption().value).toBe('Caption being typed');
    expect(firstComment().value).toBe('Comment changed elsewhere');
  });
});
