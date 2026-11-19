/**
 * Measures parts of the page on every animation frame while a check does something, and reports
 * how far each one moved from where it was when sampling started. Used by the browser checks
 * that make sure the card dialog and the board's tiles keep their size while a card renders.
 *
 * Test-only, like e2e/workerHold.mjs: nothing here is imported by the app.
 *
 * A probe is `{ selector, text?, edge }`: the first element matching `selector` (and, when
 * given, whose text is exactly `text`), and which of its edges to read from
 * getBoundingClientRect(): 'top', 'left' or 'height'. A watch is a selector; the report says
 * whether it ever matched, which shows the state being checked really happened.
 */

/** Starts sampling in the page. Probes and watches are keyed by name. */
export function startSampling(page, probes, watches = {}) {
  return page.evaluate(
    ({ probes, watches }) => {
      const find = ({ selector, text }) =>
        [...document.querySelectorAll(selector)].find(
          (element) => text === undefined || element.textContent.trim() === text,
        );
      const measure = () =>
        Object.fromEntries(
          Object.entries(probes).map(([name, probe]) => {
            const element = find(probe);
            return [name, element ? element.getBoundingClientRect()[probe.edge] : null];
          }),
        );
      const state = {
        running: true,
        frames: 0,
        baseline: measure(),
        largest: Object.fromEntries(Object.keys(probes).map((name) => [name, 0])),
        missing: Object.fromEntries(Object.keys(probes).map((name) => [name, 0])),
        seen: Object.fromEntries(Object.keys(watches).map((name) => [name, false])),
      };
      const sample = () => {
        if (!state.running) return;
        state.frames += 1;
        const now = measure();
        for (const name of Object.keys(probes)) {
          const value = now[name];
          const base = state.baseline[name];
          if (value === null || base === null) state.missing[name] += 1;
          else state.largest[name] = Math.max(state.largest[name], Math.abs(value - base));
        }
        for (const [name, selector] of Object.entries(watches)) {
          if (document.querySelector(selector)) state.seen[name] = true;
        }
        requestAnimationFrame(sample);
      };
      window.__sampling = state;
      requestAnimationFrame(sample);
    },
    { probes, watches },
  );
}

/**
 * Stops sampling and returns `{ frames, baseline, largest, missing, seen }`, where `largest`
 * is each probe's largest difference from its starting value, in CSS pixels.
 */
export function stopSampling(page) {
  return page.evaluate(
    () =>
      new Promise((done) =>
        // One more frame, so the last change is measured too.
        requestAnimationFrame(() => {
          const state = window.__sampling;
          state.running = false;
          const { frames, baseline, largest, missing, seen } = state;
          done({ frames, baseline, largest, missing, seen });
        }),
      ),
  );
}

/** True when every probe was found in every frame and stayed within `tolerance` pixels. */
export function steady(result, tolerance = 1) {
  return (
    result.frames > 0 &&
    Object.values(result.missing).every((count) => count === 0) &&
    Object.values(result.largest).every((difference) => difference <= tolerance)
  );
}

/** The result in words, for a check's detail line. */
export function describeSampling(result) {
  const largest = Object.entries(result.largest)
    .map(([name, difference]) => `${name} ${difference.toFixed(1)} px`)
    .join(', ');
  const missing = Object.entries(result.missing)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} missing in ${count}`);
  const seen = Object.entries(result.seen)
    .map(([name, was]) => `${name} ${was ? 'seen' : 'NOT seen'}`)
    .join(', ');
  return [`${result.frames} frames; largest change: ${largest}`, ...missing, seen]
    .filter(Boolean)
    .join('; ');
}
