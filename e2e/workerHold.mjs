/**
 * Holding back render jobs in the browser checks, so a check can see a card while its file is
 * still being made. Used by e2e/board.check.mjs, e2e/editor.check.mjs and e2e/export.check.mjs.
 *
 * Test-only: this runs in the page only because a check adds it with `addInitScript`. Nothing
 * here is imported by the app, so none of it is in `src` or in the production build.
 *
 * `__hold = 'board'` holds the board's jobs, `__hold = 'export'` holds the export's jobs (their
 * ids start with "export-"). `__release()` sends everything held, in the order it was held.
 */

/** Runs in the page before the app; give it to `context.addInitScript`. */
export function controlWorkers() {
  window.__hold = null;
  window.__held = [];
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function postMessage(message, ...rest) {
    const id = message && message.type === 'render' ? message.job.id : null;
    const isExport = typeof id === 'string' && id.startsWith('export-');
    if (id !== null && window.__hold !== null && (window.__hold === 'export') === isExport) {
      window.__held.push(() => post.call(this, message, ...rest));
      return undefined;
    }
    return post.call(this, message, ...rest);
  };
  window.__release = () => {
    window.__hold = null;
    const held = window.__held.splice(0);
    for (const send of held) send();
    return held.length;
  };
}

/** Starts holding the board's (or the export's) render jobs. */
export function holdRenders(page, which = 'board') {
  return page.evaluate((kind) => {
    window.__hold = kind;
  }, which);
}

/** Waits until at least `count` jobs are being held. */
export function waitForHeld(page, count = 1, timeout = 60_000) {
  return page.waitForFunction((least) => window.__held.length >= least, count, { timeout });
}

/** Stops holding and sends every held job; returns how many there were. */
export function releaseRenders(page) {
  return page.evaluate(() => window.__release());
}
