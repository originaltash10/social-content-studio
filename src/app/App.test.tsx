import 'fake-indexeddb/auto';
import { act, render, screen } from '@testing-library/react';
import { useSessionStore } from '../store/sessionStore';
import { makeBrand, makeSession } from '../test/fixtures';
import { App } from './App';

/** Controls a person reaches with Tab, in page order. */
const tabStops = () =>
  [...document.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]')].filter(
    (element) => element.tabIndex >= 0 && !element.closest('dialog:not([open])'),
  );

describe('App shell', () => {
  it('renders the app name', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Social Content Studio' })).toBeInTheDocument();
  });

  it('puts Settings first in the Tab order, with no session open', () => {
    render(<App />);
    expect(useSessionStore.getState().session).toBeNull();
    expect(tabStops()[0]).toBe(screen.getByRole('button', { name: 'Settings' }));
  });

  it('puts Settings first in the Tab order, before the session controls, with a session open', () => {
    render(<App />);
    act(() => {
      useSessionStore.getState().loadSession({
        session: makeSession(),
        brand: makeBrand(),
        blobs: new Map(),
        missingAssetIds: [],
        brandMissing: false,
      });
    });
    const stops = tabStops();
    expect(stops[0]).toBe(screen.getByRole('button', { name: 'Settings' }));
    const session = screen.getByRole('region', { name: 'Session' });
    expect(session.contains(stops[1] ?? null)).toBe(true);
  });
});
