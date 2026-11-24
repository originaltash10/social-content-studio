import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlacement } from '../lib/platforms';
import { validate } from '../lib/validate';
import * as persistence from '../store/persistence';
import { useSessionStore } from '../store/sessionStore';
import { makeBrand, makeCard, makeSession } from '../test/fixtures';
import type { Brief, PlacementSpec, Session } from '../types';
import { BriefPanel } from './BriefPanel';
import { BRIEF_BOXES, BRIEF_HEADING, BRIEF_HINT, TONE_CHOICES, briefBoxText } from './briefText';
import { SessionPanel } from './SessionPanel';

// The session panel is rendered beside the brief panel for the Ctrl/Cmd-Z and New session tests.
// Its buttons reach the disk through this module, so it is replaced; New session does what the
// real one does to the store.
vi.mock('../store/persistence', () => ({
  currentFolderName: vi.fn(() => null),
  downloadBundle: vi.fn(() => Promise.resolve(true)),
  loadBundle: vi.fn(() => Promise.resolve(true)),
  newSession: vi.fn(),
  openSessionFolder: vi.fn(() => Promise.resolve(true)),
  reopenLastSession: vi.fn(() => Promise.resolve(true)),
  requestClearSession: vi.fn(() => Promise.resolve(true)),
  saveSession: vi.fn(() => Promise.resolve(true)),
  startAutosave: vi.fn(() => () => undefined),
}));

const store = () => useSessionStore.getState();

function open(): Session {
  const { session } = store();
  if (!session) throw new Error('expected an open session');
  return session;
}

/** The fixture session's brief: every field filled in, formal tone. */
const FIXTURE_BRIEF = makeSession().brief;
const EMPTY_BRIEF: Brief = { topic: '', audience: '', cta: '', tone: 'neutral' };

/** Puts a saved (not dirty) session in the store, as opening a folder or a .scs does. */
function load(overrides: Partial<Session> = {}) {
  act(() => {
    store().loadSession({
      session: makeSession(overrides),
      brand: makeBrand(),
      blobs: new Map(),
      missingAssetIds: [],
      brandMissing: false,
    });
  });
}

const box = (label: string) => screen.getByRole('textbox', { name: label });
const radio = (label: string) => screen.getByRole('radio', { name: label });
const shown = (label: string) => (box(label) as HTMLInputElement | HTMLTextAreaElement).value;

/** Types into a box as a person does: focus it, then change its text. It is not left. */
function type(label: string, text: string) {
  const element = box(label);
  fireEvent.focus(element);
  fireEvent.change(element, { target: { value: text } });
  return element;
}

/** Types into a box and leaves it. */
function typeAndLeave(label: string, text: string) {
  fireEvent.blur(type(label, text));
}

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  fireEvent(document, new Event('visibilitychange'));
}

beforeEach(() => {
  act(() => {
    store().clearSession(() => true);
  });
  vi.clearAllMocks();
});

afterEach(() => {
  Reflect.deleteProperty(document, 'visibilityState');
  vi.restoreAllMocks();
});

describe('with no session open', () => {
  it('shows nothing', () => {
    const { container } = render(<BriefPanel />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('heading', { name: BRIEF_HEADING })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('goes away when the session is cleared', () => {
    load();
    render(<BriefPanel />);
    expect(box('Topic')).toBeInTheDocument();
    act(() => {
      store().clearSession(() => true);
    });
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('the panel', () => {
  beforeEach(() => {
    act(() => store().createSession('S'));
    render(<BriefPanel />);
  });

  it('is a section named by its heading, with the hint under it', () => {
    expect(BRIEF_HEADING).toBe('Campaign brief');
    expect(BRIEF_HINT).toBe('Optional. Saved with the session; not exported.');
    const section = screen.getByRole('region', { name: 'Campaign brief' });
    const heading = within(section).getByRole('heading', { level: 2, name: 'Campaign brief' });
    const hint = within(section).getByText('Optional. Saved with the session; not exported.');
    expect(heading.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section).toHaveAccessibleDescription(BRIEF_HINT);
  });

  it('has multi-line Topic and Audience boxes and single-line Call to action and Link boxes', () => {
    expect(BRIEF_BOXES.map((b) => b.label)).toEqual([
      'Topic',
      'Audience',
      'Call to action',
      'Link',
    ]);
    expect(box('Topic').tagName).toBe('TEXTAREA');
    expect(box('Audience').tagName).toBe('TEXTAREA');
    for (const label of ['Call to action', 'Link']) {
      expect(box(label).tagName).toBe('INPUT');
      expect(box(label)).toHaveAttribute('type', 'text');
    }
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
  });

  it('the Link box is plain text with spell-checking off, and no box is required or limited', () => {
    expect(box('Link')).toHaveAttribute('type', 'text');
    expect(box('Link')).toHaveAttribute('spellcheck', 'false');
    for (const element of screen.getAllByRole('textbox')) {
      expect(element).not.toBeRequired();
      expect(element).not.toHaveAttribute('maxlength');
      expect(element).not.toHaveAttribute('pattern');
    }
    expect(box('Topic')).not.toHaveAttribute('spellcheck');
  });

  it('every text box uses the shared text field style', () => {
    for (const element of screen.getAllByRole('textbox')) {
      expect(element.className).toContain('rounded-control');
      expect(element.className).toContain('focus-visible:outline-accent');
    }
  });

  it('has a Tone group of three radio buttons: Formal, Neutral and Casual', () => {
    expect(TONE_CHOICES.map((c) => c.label)).toEqual(['Formal', 'Neutral', 'Casual']);
    const group = screen.getByRole('group', { name: 'Tone' });
    expect(group.tagName).toBe('FIELDSET');
    expect(within(group).getByText('Tone').tagName).toBe('LEGEND');
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['formal', 'neutral', 'casual']);
    expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual(['Formal', 'Neutral', 'Casual']);
    // One group for the arrow keys: all three share a name.
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios[0]?.name).not.toBe('');
  });

  it('a new session shows empty boxes and Neutral', () => {
    for (const { label } of BRIEF_BOXES) expect(shown(label)).toBe('');
    expect(radio('Neutral')).toBeChecked();
    expect(radio('Formal')).not.toBeChecked();
    expect(radio('Casual')).not.toBeChecked();
  });

  it('its controls come in the Tab order: Topic, Audience, Call to action, Link, then Tone', () => {
    const section = screen.getByRole('region', { name: 'Campaign brief' });
    const controls = [
      ...section.querySelectorAll('textarea, input, button, select, a, [tabindex]'),
    ];
    expect(controls).toEqual([
      box('Topic'),
      box('Audience'),
      box('Call to action'),
      box('Link'),
      radio('Formal'),
      radio('Neutral'),
      radio('Casual'),
    ]);
    // Nothing changes the order the page gives them.
    for (const control of controls) expect(control).not.toHaveAttribute('tabindex');
  });
});

describe('showing the open session', () => {
  it("shows the session's brief", () => {
    load();
    render(<BriefPanel />);
    expect(shown('Topic')).toBe(FIXTURE_BRIEF.topic);
    expect(shown('Audience')).toBe(FIXTURE_BRIEF.audience);
    expect(shown('Call to action')).toBe(FIXTURE_BRIEF.cta);
    expect(shown('Link')).toBe(FIXTURE_BRIEF.link);
    expect(radio('Formal')).toBeChecked();
  });

  it('follows a newly created session', () => {
    load();
    render(<BriefPanel />);
    act(() => store().createSession('Next'));
    for (const { label } of BRIEF_BOXES) expect(shown(label)).toBe('');
    expect(radio('Neutral')).toBeChecked();
  });

  it('follows a newly loaded session', () => {
    act(() => store().createSession('First'));
    render(<BriefPanel />);
    expect(shown('Topic')).toBe('');
    load({ id: 'other', brief: { topic: 'T2', audience: 'A2', cta: 'C2', tone: 'casual' } });
    expect(shown('Topic')).toBe('T2');
    expect(shown('Audience')).toBe('A2');
    expect(shown('Call to action')).toBe('C2');
    expect(shown('Link')).toBe('');
    expect(radio('Casual')).toBeChecked();
  });

  it('appears when a session is opened', () => {
    render(<BriefPanel />);
    expect(screen.queryByRole('textbox')).toBeNull();
    load();
    expect(shown('Topic')).toBe(FIXTURE_BRIEF.topic);
  });
});

describe('writing the text boxes', () => {
  beforeEach(() => {
    load();
    render(<BriefPanel />);
  });

  it('typing changes only the box', () => {
    const revision = store().revision;
    type('Topic', 'Typed, not left');
    expect(shown('Topic')).toBe('Typed, not left');
    expect(open().brief).toEqual(FIXTURE_BRIEF);
    expect(store().revision).toBe(revision);
    expect(store().dirty).toBe(false);
  });

  it.each(BRIEF_BOXES)('writes $label when the box is left, as one change', ({ field, label }) => {
    const revision = store().revision;
    const setBrief = vi.spyOn(store(), 'setBrief');
    type(label, 'First');
    type(label, 'First, then more');
    expect(setBrief).not.toHaveBeenCalled();
    fireEvent.blur(box(label));
    expect(open().brief).toEqual({ ...FIXTURE_BRIEF, [field]: 'First, then more' });
    expect(store().revision).toBe(revision + 1);
    expect(store().dirty).toBe(true);
    expect(shown(label)).toBe('First, then more');
  });

  it('adds no undo step', () => {
    typeAndLeave('Topic', 'Changed');
    typeAndLeave('Link', 'example.com/changed');
    expect(store().undoStack).toEqual([]);
  });

  it.each(BRIEF_BOXES)('writes nothing when $label is left unchanged', ({ field, label }) => {
    const revision = store().revision;
    const element = box(label);
    fireEvent.focus(element);
    fireEvent.blur(element);
    // Typed and put back as it was: still the stored text, so still no change.
    type(label, 'Something else');
    typeAndLeave(label, briefBoxText(FIXTURE_BRIEF, field));
    expect(open().brief).toEqual(FIXTURE_BRIEF);
    expect(store().revision).toBe(revision);
    expect(store().dirty).toBe(false);
  });

  it('stores text exactly as typed, with nothing trimmed', () => {
    typeAndLeave('Topic', '  Two lines \n\n second line  ');
    typeAndLeave('Audience', '\tCaf\u{E9} owners \u{1F44B} ');
    typeAndLeave('Call to action', ' See the "project" page.  ');
    typeAndLeave('Link', '  example.com/a page?x=1 ');
    expect(open().brief).toEqual({
      topic: '  Two lines \n\n second line  ',
      audience: '\tCaf\u{E9} owners \u{1F44B} ',
      cta: ' See the "project" page.  ',
      link: '  example.com/a page?x=1 ',
      tone: 'formal',
    });
    expect(shown('Call to action')).toBe(' See the "project" page.  ');
  });

  it.each([
    ['emptied', ''],
    ['left holding only spaces', '   '],
  ])('removes the link when the Link box is %s, and the box is then empty', (_name, text) => {
    typeAndLeave('Link', text);
    expect(Object.hasOwn(open().brief, 'link')).toBe(false);
    expect(store().dirty).toBe(true);
    expect(shown('Link')).toBe('');
  });

  it('only spaces in the Link box of a brief with no link is not a change', () => {
    load({ brief: EMPTY_BRIEF });
    const revision = store().revision;
    typeAndLeave('Link', '   ');
    expect(store().revision).toBe(revision);
    expect(store().dirty).toBe(false);
    expect(shown('Link')).toBe('');
  });

  it('a write from one box leaves the other boxes as they are stored', () => {
    typeAndLeave('Topic', 'New topic');
    expect(shown('Audience')).toBe(FIXTURE_BRIEF.audience);
    expect(shown('Call to action')).toBe(FIXTURE_BRIEF.cta);
    expect(shown('Link')).toBe(FIXTURE_BRIEF.link);
    typeAndLeave('Audience', 'New audience');
    expect(open().brief).toEqual({
      ...FIXTURE_BRIEF,
      topic: 'New topic',
      audience: 'New audience',
    });
  });
});

describe('when the page is hidden', () => {
  beforeEach(() => {
    load();
    render(<BriefPanel />);
  });

  it('writes the box being typed in, and leaving it afterwards is not a second change', () => {
    type('Call to action', 'Typed, then the tab was hidden');
    const revision = store().revision;
    setVisibility('hidden');
    expect(open().brief.cta).toBe('Typed, then the tab was hidden');
    expect(store().revision).toBe(revision + 1);
    setVisibility('visible');
    fireEvent.blur(box('Call to action'));
    expect(store().revision).toBe(revision + 1);
    expect(shown('Call to action')).toBe('Typed, then the tab was hidden');
  });

  it('carries on the same visit: more typing after it is written when the box is left', () => {
    type('Topic', 'One');
    setVisibility('hidden');
    setVisibility('visible');
    type('Topic', 'One, two');
    expect(open().brief.topic).toBe('One');
    fireEvent.blur(box('Topic'));
    expect(open().brief.topic).toBe('One, two');
  });

  it('writes nothing when no box is being typed in, or when the text did not change', () => {
    const revision = store().revision;
    setVisibility('hidden');
    fireEvent.focus(box('Topic'));
    setVisibility('hidden');
    expect(store().revision).toBe(revision);
    expect(store().dirty).toBe(false);
  });

  it('writes nothing when the page becomes visible', () => {
    type('Topic', 'Still typing');
    setVisibility('visible');
    expect(open().brief.topic).toBe(FIXTURE_BRIEF.topic);
    expect(store().dirty).toBe(false);
  });

  it('writes nothing for a box that was already left', () => {
    typeAndLeave('Topic', 'Left');
    const revision = store().revision;
    setVisibility('hidden');
    expect(store().revision).toBe(revision);
  });
});

describe('tone', () => {
  beforeEach(() => {
    load();
    render(<BriefPanel />);
  });

  it('is written as soon as it is chosen', () => {
    const revision = store().revision;
    fireEvent.click(radio('Casual'));
    expect(open().brief).toEqual({ ...FIXTURE_BRIEF, tone: 'casual' });
    expect(store().revision).toBe(revision + 1);
    expect(store().dirty).toBe(true);
    expect(radio('Casual')).toBeChecked();
    expect(radio('Formal')).not.toBeChecked();
    fireEvent.click(radio('Neutral'));
    expect(open().brief.tone).toBe('neutral');
    expect(store().undoStack).toEqual([]);
  });

  it('choosing the tone the brief already has writes nothing', () => {
    const revision = store().revision;
    fireEvent.click(radio('Formal'));
    expect(store().revision).toBe(revision);
    expect(store().dirty).toBe(false);
  });

  it('leaves the text of a box still being typed in alone', () => {
    type('Topic', 'Still typing');
    fireEvent.click(radio('Casual'));
    expect(open().brief).toEqual({ ...FIXTURE_BRIEF, tone: 'casual' });
    expect(shown('Topic')).toBe('Still typing');
    fireEvent.blur(box('Topic'));
    expect(open().brief).toEqual({ ...FIXTURE_BRIEF, topic: 'Still typing', tone: 'casual' });
  });
});

describe('typing not yet written is never written into another session', () => {
  const PENDING = 'PENDING: typed for the first session';
  const OTHER: Brief = {
    topic: 'Other topic',
    audience: 'Other audience',
    cta: 'Other',
    tone: 'casual',
  };

  /**
   * Every way a session is replaced, as the store sees it. Each returns the brief expected after.
   * The last item is a tone that neither the first session (Formal) nor the new one has, so
   * choosing it would be a change to either.
   */
  const replacements: [string, () => Brief | null, string][] = [
    [
      'Clear, then the same session opened again',
      () => {
        store().clearSession(() => true);
        store().loadSession({
          session: makeSession(),
          brand: makeBrand(),
          blobs: new Map(),
          missingAssetIds: [],
          brandMissing: false,
        });
        return FIXTURE_BRIEF;
      },
      'Casual',
    ],
    [
      'the same session loaded again over the open one',
      () => {
        store().loadSession({
          session: makeSession(),
          brand: makeBrand(),
          blobs: new Map(),
          missingAssetIds: [],
          brandMissing: false,
        });
        return FIXTURE_BRIEF;
      },
      'Casual',
    ],
    [
      'New session',
      () => {
        store().createSession('Next');
        return EMPTY_BRIEF;
      },
      'Casual',
    ],
    [
      'another session opened or loaded',
      () => {
        store().loadSession({
          session: makeSession({ id: 'other', brief: OTHER }),
          brand: makeBrand(),
          blobs: new Map(),
          missingAssetIds: [],
          brandMissing: false,
        });
        return OTHER;
      },
      'Neutral',
    ],
    [
      'Clear',
      () => {
        store().clearSession(() => true);
        return null;
      },
      'Casual',
    ],
  ];

  beforeEach(() => {
    load();
    render(<BriefPanel />);
  });

  it.each(replacements)('after %s, the panel shows the new brief', (_name, replace) => {
    const typedIn = type('Topic', PENDING);
    const setBrief = vi.spyOn(store(), 'setBrief');
    let expected: Brief | null = null;
    act(() => {
      expected = replace();
    });
    expect(store().session?.brief ?? null).toEqual(expected);
    expect(setBrief).not.toHaveBeenCalled();
    if (expected === null) {
      expect(screen.queryByRole('textbox')).toBeNull();
    } else {
      expect(shown('Topic')).toBe((expected as Brief).topic);
      expect(shown('Topic')).not.toBe(PENDING);
    }
    // The box that was typed in is gone; nothing it does now can write.
    expect(typedIn.isConnected).toBe(false);
    fireEvent.blur(typedIn);
    setVisibility('hidden');
    expect(setBrief).not.toHaveBeenCalled();
    expect(store().session?.brief ?? null).toEqual(expected);
    expect(JSON.stringify(store().session)).not.toContain('PENDING');
  });

  it.each(replacements)(
    'after %s, leaving the old box before the panel has shown the new session writes nothing',
    (_name, replace) => {
      const typedIn = type('Topic', PENDING);
      const setBrief = vi.spyOn(store(), 'setBrief');
      let expected: Brief | null = null;
      act(() => {
        expected = replace();
        // Still the boxes made for the first session: the panel has not rendered again yet.
        expect(typedIn.isConnected).toBe(true);
        fireEvent.blur(typedIn);
      });
      expect(setBrief).not.toHaveBeenCalled();
      expect(store().session?.brief ?? null).toEqual(expected);
      expect(JSON.stringify(store().session)).not.toContain('PENDING');
    },
  );

  it.each(replacements)(
    'after %s, the page being hidden before the panel has shown the new session writes nothing',
    (_name, replace) => {
      type('Topic', PENDING);
      const setBrief = vi.spyOn(store(), 'setBrief');
      let expected: Brief | null = null;
      act(() => {
        expected = replace();
        setVisibility('hidden');
      });
      expect(setBrief).not.toHaveBeenCalled();
      expect(store().session?.brief ?? null).toEqual(expected);
    },
  );

  it.each(replacements)(
    'after %s, a tone chosen on the old boxes writes nothing',
    (_name, replace, tone) => {
      const chosen = radio(tone);
      expect(chosen).not.toBeChecked();
      const setBrief = vi.spyOn(store(), 'setBrief');
      let expected: Brief | null = null;
      act(() => {
        expected = replace();
        // Neither session has this tone, so without the check this would be written.
        expect(store().session?.brief.tone).not.toBe((chosen as HTMLInputElement).value);
        fireEvent.click(chosen);
      });
      expect(setBrief).not.toHaveBeenCalled();
      expect(store().session?.brief ?? null).toEqual(expected);
    },
  );

  it('typing in the new session is written to the new session', () => {
    type('Topic', PENDING);
    act(() => store().createSession('Next'));
    typeAndLeave('Topic', 'Typed for the new session');
    expect(open().name).toBe('Next');
    expect(open().brief).toEqual({ ...EMPTY_BRIEF, topic: 'Typed for the new session' });
  });

  it('editing the open session does not count as a new one: typing is kept and written', () => {
    const before = store().opening;
    type('Topic', PENDING);
    act(() => {
      store().updateCard('card-1', (card) => {
        card.copy.caption = 'Edited';
      });
      store().setValidation('card-1', { level: 'pass', issues: [] });
      store().markSaved(store().revision);
      store().setStatus({ kind: 'info', message: 'Saved.' });
      store().undo();
    });
    expect(store().opening).toBe(before);
    expect(shown('Topic')).toBe(PENDING);
    fireEvent.blur(box('Topic'));
    expect(open().brief.topic).toBe(PENDING);
  });
});

describe('with the session panel beside it', () => {
  const ctrlZ = { key: 'z', ctrlKey: true };

  /** A card change, so the app's undo has something to take back. */
  function editCard() {
    act(() => {
      store().updateCard('card-1', (card) => {
        card.copy.caption = 'Edited caption';
      });
    });
  }
  const caption = () => open().cards.find((c) => c.id === 'card-1')?.copy.caption;
  const ORIGINAL_CAPTION = makeCard().copy.caption;

  beforeEach(() => {
    vi.mocked(persistence.newSession).mockImplementation((name) => store().createSession(name));
    load();
    render(
      <>
        <SessionPanel />
        <BriefPanel />
      </>,
    );
  });

  it("the app's Ctrl-Z undoes the last card change and never changes the brief", () => {
    editCard();
    typeAndLeave('Topic', 'Brief changed after the card');
    fireEvent.click(radio('Casual'));
    const brief = open().brief;
    fireEvent.keyDown(window, ctrlZ);
    expect(caption()).toBe(ORIGINAL_CAPTION);
    expect(open().brief).toBe(brief);
    expect(shown('Topic')).toBe('Brief changed after the card');
    expect(radio('Casual')).toBeChecked();
    // Nothing is left to undo, and the brief is still as it was set.
    fireEvent.keyDown(window, ctrlZ);
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(open().brief).toBe(brief);
    expect(store().undoStack).toEqual([]);
  });

  it.each(BRIEF_BOXES)(
    "Ctrl-Z in the $label box is left to the browser's typing undo: the app undoes nothing",
    ({ label }) => {
      editCard();
      const element = type(label, 'Typing');
      const undo = vi.spyOn(store(), 'undo');
      // fireEvent returns false when a listener cancelled the key, which would stop typing undo.
      expect(fireEvent.keyDown(element, ctrlZ)).toBe(true);
      expect(fireEvent.keyDown(element, { key: 'z', metaKey: true })).toBe(true);
      expect(undo).not.toHaveBeenCalled();
      expect(caption()).toBe('Edited caption');
      expect(shown(label)).toBe('Typing');
      expect(open().brief).toEqual(FIXTURE_BRIEF);
    },
  );

  it('Ctrl-Z on a tone radio button undoes the last card change and leaves the brief alone', () => {
    editCard();
    fireEvent.click(radio('Casual'));
    const brief = open().brief;
    expect(brief.tone).toBe('casual');
    expect(fireEvent.keyDown(radio('Casual'), ctrlZ)).toBe(false);
    expect(caption()).toBe(ORIGINAL_CAPTION);
    expect(open().brief).toBe(brief);
    expect(radio('Casual')).toBeChecked();
  });

  it('leaving a box by pressing New session writes it to the old session first, so the question about unsaved changes is asked', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const old = open().id;
    // A real click moves focus out of the box before the button's click runs.
    typeAndLeave('Topic', 'Typed, then New session');
    expect(open().id).toBe(old);
    expect(open().brief.topic).toBe('Typed, then New session');
    expect(store().dirty).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    // Answered "Cancel": the old session stays, with the typed text in it.
    expect(persistence.newSession).not.toHaveBeenCalled();
    expect(open().id).toBe(old);
    expect(shown('Topic')).toBe('Typed, then New session');

    // Answered "OK": the new session's brief is empty.
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(persistence.newSession).toHaveBeenCalledTimes(1);
    expect(open().id).not.toBe(old);
    expect(open().brief).toEqual(EMPTY_BRIEF);
    for (const { label } of BRIEF_BOXES) expect(shown(label)).toBe('');
    expect(radio('Neutral')).toBeChecked();
  });
});

describe('validation', () => {
  const feed = getPlacement('instagram', 'feed-vertical') as PlacementSpec;
  const LINK = 'https://example.com/brief-link';
  /** The card's rule 9 findings: what the validator says about its caption on Instagram. */
  const rule9 = (caption: string) =>
    validate({ kind: 'image', frames: [...feed.sizes], caption, hashtags: [] }, feed).issues.filter(
      (issue) => issue.rule === 9,
    );

  it('a link in the brief leaves an Instagram card and its validation result unchanged', () => {
    load();
    render(<BriefPanel />);
    const cards = open().cards;
    const card = cards[0];
    expect(card?.platform).toBe('instagram');
    typeAndLeave('Link', LINK);
    expect(open().brief.link).toBe(LINK);
    // Not one card was touched: the same objects, so the same validation results.
    expect(open().cards).toBe(cards);
    expect(open().cards[0]).toBe(card);
    expect(open().cards[0]?.validation).toBe(card?.validation);
    expect(
      open()
        .cards.flatMap((c) => c.validation.issues)
        .some((i) => i.rule === 9),
    ).toBe(false);
    // The validator is given the card's caption and never the brief, so there is no rule 9
    // warning; the same link in the caption itself does give one.
    expect(rule9((card as { copy: { caption: string } }).copy.caption)).toEqual([]);
    expect(rule9(`See ${LINK}`)).toHaveLength(1);
  });
});
