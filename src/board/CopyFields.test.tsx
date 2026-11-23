/**
 * The caption, hashtags and first comment boxes: their labels, live counts and messages. The
 * store is real and the card is read from it on every render, as the card dialog does. What the
 * boxes say is checked against copyStatus(), which is itself checked against validate().
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
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
