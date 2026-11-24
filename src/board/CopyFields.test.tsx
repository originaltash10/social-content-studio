/**
 * The caption, hashtags, first comment and alt text boxes: their labels, live counts and
 * messages, and their Copy buttons. The store is real and the card is read from it on every
 * render, as the card dialog does. What the boxes say is checked against copyStatus(), which is
 * itself checked against validate(). The clipboard is a stand-in: jsdom has none.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyStatus, parseHashtags } from '../lib/board/copyChecks';
import { captionsCsv, hashtagCell, quote } from '../lib/export/captionsCsv';
import { getPlacement, platforms } from '../lib/platforms';
import { useSessionStore } from '../store/sessionStore';
import { hash, makeAsset, makeCard } from '../test/fixtures';
import type { Card, PlacementSpec, Platform } from '../types';
import {
  ALT_TEXT_HINT,
  altTextCountText,
  captionCountText,
  COPIED,
  STATUS_MS,
  COPY_FAILED,
  firstCommentCountText,
  hashtagCountText,
  HASHTAG_HINT,
  NO_LIMITS_NOTE,
  NOTHING_TO_COPY,
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
const altText = () => box('Alt text');

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
      altText: altText().value,
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
    // The only message is rule 8, under the alt text box: there is no alt text yet.
    expect(describedText(altText())).toEqual([
      '0 characters',
      ALT_TEXT_HINT,
      'Warning: Alt text is missing.',
    ]);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
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
    openWith('instagram', 'feed-vertical', { altText: 'A crane lifts a beam.' });
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
    openWith('instagram', 'story', { altText: 'A crane lifts a beam.' });
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
    // No rule 8 message either: without the placement there are no checks to agree with.
    expect(describedText(altText())).toEqual([ALT_TEXT_HINT]);
    expect(screen.queryByText(STORY_NOTE)).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Copy / })).toHaveLength(4);
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

// ---------------------------------------------------------------------------------------------
// The alt text box (SPEC.md, "Caption boxes")
// ---------------------------------------------------------------------------------------------

describe('the alt text box', () => {
  it('is a labelled text area after First comment, showing the alt text exactly as stored', () => {
    openWith('instagram', 'feed-vertical', { altText: ' A crane\nlifts a beam. ' });
    expect(altText().tagName).toBe('TEXTAREA');
    expect(altText().rows).toBe(3);
    expect(altText().value).toBe(' A crane\nlifts a beam. ');
    expect(
      firstComment().compareDocumentPosition(altText()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(describedText(altText())).toEqual([altTextCountText({ count: 23 }), ALT_TEXT_HINT]);
    expect(describedText(altText())[0]).toBe('23 characters');
  });

  it('counts live as copyStatus does, emoji and accents included, the en-US way', () => {
    openWith('instagram', 'feed-vertical');
    for (const [text, words] of [
      ['A', '1 character'],
      ['Crane \u{1F3D7}\u{FE0F}', '8 characters'],
      ['caf\u{E9}', '4 characters'],
      ['cafe\u{301}', '5 characters'],
      ['one\ntwo', '7 characters'],
      ['a'.repeat(1234), '1,234 characters'],
    ] as const) {
      type(altText(), text);
      expect(describedText(altText())[0]).toBe(words);
      expect(describedText(altText())[0]).toBe(altTextCountText(expected(FEED).altText));
    }
  });

  it('shows the rule 8 message while the alt text is missing, and clears it as soon as there is text', () => {
    openWith('instagram', 'feed-vertical');
    const message = () => describedBy(altText()).find((e) => e.tagName === 'UL');
    expect(message()).toHaveTextContent('Warning: Alt text is missing.');
    expect(expected(FEED).altText.issues.map((i) => i.message)).toEqual(['Alt text is missing.']);
    // A warning, not a failure, so the box is not marked invalid.
    expect(altText()).not.toHaveAttribute('aria-invalid');
    type(altText(), 'A');
    expect(message()).toBeUndefined();
    // Spaces and line breaks only still count as missing.
    type(altText(), ' \n ');
    expect(message()).toHaveTextContent('Warning: Alt text is missing.');
    type(altText(), ' \n x');
    expect(message()).toBeUndefined();
  });

  it('shows the rule 8 message on the Reel / Story placement too', () => {
    openWith('instagram', 'story');
    expect(describedText(altText())).toContain('Warning: Alt text is missing.');
  });

  it('gives no length warning, however long the alt text', () => {
    openWith('instagram', 'feed-vertical');
    type(altText(), 'a'.repeat(10_000));
    expect(describedText(altText())).toEqual(['10,000 characters', ALT_TEXT_HINT]);
    expect(screen.queryAllByRole('listitem')).toEqual([]);
  });

  it('writes once per visit, as typed, keeps authoredBy, and one undo takes the whole visit back', () => {
    const by = { provider: 'test-provider', model: 'test-model', at: '2026-11-23T00:00:00.000Z' };
    openWith('instagram', 'feed-vertical', { caption: 'Hi', authoredBy: by });
    save();
    const before = steps();
    enter(altText());
    for (const text of ['A', 'A c', 'A crane\n', ' A crane\nlifts. ']) type(altText(), text);
    expect(steps()).toBe(before);
    expect(store().dirty).toBe(false);
    leave(altText());
    expect(steps()).toBe(before + 1);
    expect(stored()).toEqual({
      caption: 'Hi',
      hashtags: [],
      firstComment: '',
      altText: ' A crane\nlifts. ',
      authoredBy: by,
    });
    act(() => {
      store().undo();
    });
    expect(stored()?.altText).toBe('');
    expect(altText().value).toBe('');
    expect(steps()).toBe(before);
  });

  it('writes nothing when the alt text is the same on leaving', () => {
    openWith('instagram', 'feed-vertical', { altText: 'Same' });
    save();
    const before = steps();
    enter(altText());
    type(altText(), 'Different');
    type(altText(), 'Same');
    leave(altText());
    expect(steps()).toBe(before);
    expect(store().dirty).toBe(false);
  });

  it('writes the alt text when the boxes go away (the dialog closing) and when the page is hidden', () => {
    try {
      let view = openWith('instagram', 'feed-vertical');
      let before = steps();
      enter(altText());
      type(altText(), 'Closed while typing');
      view.unmount();
      expect(steps()).toBe(before + 1);
      expect(stored()?.altText).toBe('Closed while typing');

      view = openWith('instagram', 'feed-vertical');
      before = steps();
      enter(altText());
      type(altText(), 'Hidden while typing');
      setVisibility('hidden');
      expect(steps()).toBe(before + 1);
      expect(stored()?.altText).toBe('Hidden while typing');
      view.unmount();
      // Already written, so going away afterwards writes nothing more.
      expect(steps()).toBe(before + 1);
    } finally {
      setVisibility('visible');
    }
  });

  it('writes nothing when the card is gone by the time the alt text is written', () => {
    try {
      for (const how of ['blur', 'unmount', 'hidden'] as const) {
        openWith('instagram', 'feed-vertical');
        const card = store().session?.cards[0] as Card;
        cleanup();
        const view = render(<CopyFields card={card} spec={FEED} record={(change) => change()} />);
        enter(altText());
        type(altText(), 'Gone');
        act(() => {
          store().undo();
        });
        save();
        const before = steps();
        if (how === 'blur') leave(altText());
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
});

// ---------------------------------------------------------------------------------------------
// Copy buttons (SPEC.md, "Copy buttons")
// ---------------------------------------------------------------------------------------------

type WriteText = (text: string) => Promise<void>;

/** Gives the page a clipboard whose writeText is this mock, or no clipboard at all. */
function setClipboard(writeText: WriteText | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText === undefined ? undefined : { writeText },
  });
}

/** A clipboard that accepts every write; the mock records what was written. */
function workingClipboard() {
  const writeText = vi.fn<WriteText>(() => Promise.resolve());
  setClipboard(writeText);
  return writeText;
}

const copyButton = (name: string) => screen.getByRole('button', { name });
/** The status message beside a Copy button. */
function statusOf(name: string): HTMLElement {
  const found = copyButton(name).parentElement?.querySelector<HTMLElement>('[role="status"]');
  if (!found) throw new Error(`no status beside ${name}`);
  return found;
}
/** Presses a Copy button and lets the clipboard answer. */
async function press(name: string) {
  await act(async () => {
    fireEvent.click(copyButton(name));
    await Promise.resolve();
  });
}

const COPY_NAMES = ['Copy caption', 'Copy hashtags', 'Copy first comment', 'Copy alt text'];

describe('the Copy buttons', () => {
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('follow each box, say "Copy", have their own names, and are never disabled', () => {
    openWith('instagram', 'feed-vertical');
    const order = [
      ...document.querySelectorAll<HTMLElement>('textarea, button, input, [tabindex="0"]'),
    ].map(
      (e) => e.getAttribute('aria-label') ?? (e as HTMLTextAreaElement).labels?.[0]?.textContent,
    );
    expect(order).toEqual([
      'Caption',
      'Copy caption',
      'Hashtags',
      'Copy hashtags',
      'First comment',
      'Copy first comment',
      'Alt text',
      'Copy alt text',
    ]);
    for (const name of COPY_NAMES) {
      expect(copyButton(name)).toHaveTextContent(/^Copy$/);
      expect(copyButton(name)).toHaveAttribute('type', 'button');
      expect(copyButton(name)).toBeEnabled();
      expect(statusOf(name)).toHaveTextContent(/^$/);
    }
  });

  it('copy the caption, first comment and alt text exactly as typed', async () => {
    const writeText = workingClipboard();
    // Emoji, a skin tone, a joiner sequence, precomposed and decomposed accents, line breaks
    // and edge spaces: all kept.
    const typed = {
      Caption: ' Topping out \u{1F477}\u{1F3FD}\u{200D}\u{2640}\u{FE0F}\nat the caf\u{E9} ',
      'First comment': 'More soon \u{1F3D7}\u{FE0F}\n\nat the cafe\u{301}',
      'Alt text': 'A crane lifts\nthe final beam at the caf\u{E9}.',
    };
    openWith('instagram', 'feed-vertical');
    for (const [label, text] of Object.entries(typed)) {
      type(box(label), text);
      leave(box(label));
    }
    await press('Copy caption');
    await press('Copy first comment');
    await press('Copy alt text');
    expect(writeText.mock.calls).toEqual([
      [typed.Caption],
      [typed['First comment']],
      [typed['Alt text']],
    ]);
    expect(writeText.mock.calls[0]?.[0]).not.toBe(typed.Caption.normalize('NFD'));
    expect(writeText.mock.calls[1]?.[0]).not.toBe(typed['First comment'].normalize('NFC'));
  });

  it('copy the hashtags with "#" added where missing, joined as captions.csv writes them', async () => {
    const writeText = workingClipboard();
    openWith('instagram', 'feed-vertical');
    type(hashtags(), 'build, #Site\n  caf\u{E9} #\u{1F3D7}\u{FE0F} # ##two');
    leave(hashtags());
    await press('Copy hashtags');
    expect(writeText).toHaveBeenLastCalledWith('#build #Site #caf\u{E9} #\u{1F3D7}\u{FE0F} ##two');
  });

  it('copy the same hashtags text as the captions.csv hashtags cell for the same card', async () => {
    const writeText = workingClipboard();
    openWith('instagram', 'feed-vertical', { hashtags: ['build', '#Site', ' #', 'cafe\u{301}'] });
    await press('Copy hashtags');
    const card = store().session?.cards[0] as Card;
    const copied = writeText.mock.calls[0]?.[0];
    expect(copied).toBe('#build #Site #cafe\u{301}');
    expect(copied).toBe(hashtagCell(card.copy.hashtags));
    // And the whole captions.csv row holds exactly that cell.
    const csv = captionsCsv([{ path: 'instagram/x.jpg', card, result: 'pass' }]);
    expect(csv.split('\r\n')[1]?.split(',')[4]).toBe(quote(copied as string));
  });

  it('copy what is typed but not yet written, and the box is still written once when it is left', async () => {
    const writeText = workingClipboard();
    openWith('instagram', 'feed-vertical', { caption: 'Saved' });
    const before = steps();
    enter(caption());
    type(caption(), 'Saved, and typed');
    // In a browser, pressing Copy moves focus out of the box first; here the box keeps focus,
    // which shows that the draft itself is copied, not the stored text.
    await press('Copy caption');
    expect(writeText).toHaveBeenLastCalledWith('Saved, and typed');
    expect(stored()?.caption).toBe('Saved');
    expect(steps()).toBe(before);
    leave(caption());
    expect(steps()).toBe(before + 1);
    expect(stored()?.caption).toBe('Saved, and typed');
  });

  it('never change the card and never add an undo step', async () => {
    workingClipboard();
    openWith('instagram', 'feed-vertical', {
      caption: 'C',
      hashtags: ['#h'],
      firstComment: 'F',
      altText: 'A',
    });
    save();
    const session = store().session;
    const before = { steps: steps(), revision: store().revision };
    for (const name of COPY_NAMES) await press(name);
    expect(store().session).toBe(session);
    expect(steps()).toBe(before.steps);
    expect(store().revision).toBe(before.revision);
    expect(store().dirty).toBe(false);
  });

  it('say "Copied." for about two seconds', async () => {
    vi.useFakeTimers();
    workingClipboard();
    openWith('instagram', 'feed-vertical', { caption: 'C' });
    await press('Copy caption');
    expect(statusOf('Copy caption')).toHaveTextContent(COPIED);
    expect(COPIED).toBe('Copied.');
    act(() => {
      vi.advanceTimersByTime(STATUS_MS - 1);
    });
    expect(statusOf('Copy caption')).toHaveTextContent(COPIED);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(statusOf('Copy caption')).toHaveTextContent(/^$/);
    expect(STATUS_MS).toBe(2000);
  });

  it('start the two seconds again on another press', async () => {
    vi.useFakeTimers();
    workingClipboard();
    openWith('instagram', 'feed-vertical', { caption: 'C' });
    await press('Copy caption');
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await press('Copy caption');
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(statusOf('Copy caption')).toHaveTextContent(COPIED);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(statusOf('Copy caption')).toHaveTextContent(/^$/);
  });

  it('say "Nothing to copy yet." for an empty box and leave the clipboard alone', async () => {
    const writeText = workingClipboard();
    openWith('instagram', 'feed-vertical');
    for (const name of COPY_NAMES) {
      await press(name);
      expect(statusOf(name)).toHaveTextContent(NOTHING_TO_COPY);
    }
    expect(NOTHING_TO_COPY).toBe('Nothing to copy yet.');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('say "Nothing to copy yet." for about two seconds, and start again on another press', async () => {
    vi.useFakeTimers();
    workingClipboard();
    openWith('instagram', 'feed-vertical');
    await press('Copy alt text');
    expect(statusOf('Copy alt text')).toHaveTextContent(NOTHING_TO_COPY);
    act(() => {
      vi.advanceTimersByTime(STATUS_MS - 1);
    });
    expect(statusOf('Copy alt text')).toHaveTextContent(NOTHING_TO_COPY);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(statusOf('Copy alt text')).toHaveTextContent(/^$/);
    // A new press shows it again for a full two seconds, even part-way through the last one.
    await press('Copy alt text');
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await press('Copy alt text');
    act(() => {
      vi.advanceTimersByTime(STATUS_MS - 1);
    });
    expect(statusOf('Copy alt text')).toHaveTextContent(NOTHING_TO_COPY);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(statusOf('Copy alt text')).toHaveTextContent(/^$/);
  });

  it('treat spaces and line breaks only, and hashtags of bare "#" only, as nothing to copy', async () => {
    const writeText = workingClipboard();
    openWith('instagram', 'feed-vertical');
    for (const label of ['Caption', 'Hashtags', 'First comment', 'Alt text']) {
      type(box(label), ' \n\t \n');
    }
    type(hashtags(), '# #');
    for (const name of COPY_NAMES) {
      await press(name);
      expect(statusOf(name)).toHaveTextContent(NOTHING_TO_COPY);
    }
    type(hashtags(), ' ## , #\n');
    await press('Copy hashtags');
    expect(statusOf('Copy hashtags')).toHaveTextContent(NOTHING_TO_COPY);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('say how to copy by hand when the clipboard refuses, until the next attempt', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn<WriteText>(() => Promise.reject(new Error('denied')));
    setClipboard(writeText);
    openWith('instagram', 'feed-vertical', { altText: 'A crane.' });
    await press('Copy alt text');
    expect(writeText).toHaveBeenCalledWith('A crane.');
    expect(statusOf('Copy alt text')).toHaveTextContent(COPY_FAILED);
    expect(COPY_FAILED).toBe("Couldn't copy. Select the text and press Ctrl+C.");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(statusOf('Copy alt text')).toHaveTextContent(COPY_FAILED);
    // The next attempt replaces it.
    writeText.mockImplementation(() => Promise.resolve());
    await press('Copy alt text');
    expect(statusOf('Copy alt text')).toHaveTextContent(COPIED);
  });

  it('say how to copy by hand when the browser gives no clipboard at all', async () => {
    setClipboard(undefined);
    openWith('instagram', 'feed-vertical', { firstComment: 'F' });
    await press('Copy first comment');
    expect(statusOf('Copy first comment')).toHaveTextContent(COPY_FAILED);
  });

  it('keep the newest message when an earlier press is answered late', async () => {
    let answer: () => void = () => undefined;
    const writeText = vi.fn<WriteText>(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    setClipboard(writeText);
    openWith('instagram', 'feed-vertical', { caption: 'C' });
    await press('Copy caption');
    expect(statusOf('Copy caption')).toHaveTextContent(/^$/);
    type(caption(), '');
    await press('Copy caption');
    expect(statusOf('Copy caption')).toHaveTextContent(NOTHING_TO_COPY);
    await act(async () => {
      answer();
      await Promise.resolve();
    });
    expect(statusOf('Copy caption')).toHaveTextContent(NOTHING_TO_COPY);
  });

  it('do nothing when the clipboard answers after the boxes have gone', async () => {
    vi.useFakeTimers();
    let answer: () => void = () => undefined;
    setClipboard(
      vi.fn<WriteText>(
        () =>
          new Promise<void>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    const view = openWith('instagram', 'feed-vertical', { caption: 'C' });
    await press('Copy caption');
    view.unmount();
    await act(async () => {
      answer();
      await Promise.resolve();
    });
    // No "Copied." timer was started for a button that is no longer there.
    expect(vi.getTimerCount()).toBe(0);
  });
});
