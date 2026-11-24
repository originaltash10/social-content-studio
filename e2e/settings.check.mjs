#!/usr/bin/env node
/**
 * Checks Settings in real Chromium, against the dev server and against a production build served
 * under a subpath:
 *
 *   node e2e/settings.check.mjs [--out <folder for the report>]
 *
 * It never contacts a real AI provider. Three layers make sure of that:
 * - A fake provider: `context.route` for https://api.anthropic.com/** is installed before the
 *   page loads. It answers each request from the scenario the check has set, and records every
 *   request (method, address, headers, body).
 * - Every other address that is not the app's own is aborted, and fails the check.
 * - Chromium is started with --host-resolver-rules mapping api.anthropic.com to a port on this
 *   machine where the check listens and closes every connection at once. So a request the route
 *   somehow missed (a CORS preflight, say) cannot reach the real service, and is counted: any
 *   connection there fails the check, as does any request to the provider's address that the
 *   route did not handle.
 *
 * Every control is reached the way a person reaches it: Tab and Shift+Tab from the page, keys
 * sent with page.keyboard (the key typed with page.keyboard.type, Enter and Space on buttons,
 * Space on the radio button). Nothing calls element.focus() or dispatches events at elements.
 * The one exception is the photo for the session with cards, which is given straight to the
 * file input, because the system's file picker cannot be driven (as in e2e/board.check.mjs).
 *
 * Like the other checks it needs Playwright with Chromium already installed, and is not part of
 * `npm test` or the deploy workflow. Nothing it produces is written inside the repository except
 * the normal `dist` build.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const BASE = '/social-content-studio/';
const PORTS = { dev: 5198, site: 5199, trap: 5186 };
const outFlag = process.argv.indexOf('--out');
const outDir = resolve(outFlag > -1 ? process.argv[outFlag + 1] : join(tmpdir(), 'settings-check'));
mkdirSync(outDir, { recursive: true });

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed on this machine, so the browser check cannot run.');
  process.exit(2);
}

/** The unit tests' fake key (src/test/fixtures.ts), read from there so there is one copy. */
const KEY = /export const SECRET = '([^']+)';/.exec(
  readFileSync(join(root, 'src/test/fixtures.ts'), 'utf8'),
)?.[1];
if (!KEY) throw new Error('src/test/fixtures.ts has no SECRET');

const PROVIDER_HOST = 'api.anthropic.com';
const MODELS_URL = `https://${PROVIDER_HOST}/v1/models?limit=1`;
/** Planted in every fake error answer: it must never reach the page. */
const PROVIDER_TEXT = 'PROVIDER-TEXT-MARKER';
const PHOTO = 'settings-check.jpg';

/** The app's own wording (src/settings/messages.ts). */
const TEXT = {
  noProvider: 'No provider chosen yet.',
  noKey: 'No key saved yet.',
  saved: 'Key saved on this computer.',
  chooseFirst: 'Choose a provider first.',
  pasteFirst: 'Paste a key first.',
  chosen: 'Claude (Anthropic) chosen.',
  keySaved: 'Key saved.',
  checking: 'Checking the connection…',
  removed: 'Key removed from this browser.',
  nothingToRemove: 'No key saved, so there was nothing to remove.',
  ok: 'Connected. Claude accepted your key.',
  'no-key': 'No key saved yet. Paste a key and press Save key first.',
  'wrong-key':
    "Claude didn't accept this key. Check that you copied all of it, or create a new key in your provider account.",
  'org-blocked':
    "Your organization's settings don't allow Claude to be used from a web page, so this app can't use this key. Your key itself may be fine.",
  workspace:
    "This key isn't tied to a workspace. Create a new key inside a workspace in your provider account, then save that key here.",
  'rate-limited': 'Too many requests to Claude right now. Wait a minute and try again.',
  'provider-problem':
    'Claude is having a problem or is busy right now. Try again in a few minutes.',
  unreachable:
    "Couldn't reach Claude. Check your internet connection and try again. If this keeps happening, your organization's network or settings may block calls from a web page.",
};
const NOTE = 'Sends your key to api.anthropic.com to check it. No photos or text are sent.';

// --------------------------------------------------------------------------- servers

const servers = [];
function serve(args, env, url) {
  const child = spawn('npx', ['vite', ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    detached: true,
  });
  servers.push(child);
  return waitFor(url);
}
async function waitFor(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`server did not start at ${url}`);
}
function stopServers() {
  for (const child of servers) {
    try {
      process.kill(-child.pid);
    } catch {
      // already gone
    }
  }
}

/** The address Chromium is given for the provider: counts connections and closes each at once. */
const wire = { connections: 0 };
const trap = createServer((socket) => {
  wire.connections++;
  socket.destroy();
});
await new Promise((done) => trap.listen(PORTS.trap, '127.0.0.1', done));

// --------------------------------------------------------------------------- helpers

/** Makes a JPEG in the page (no personal images), as e2e/board.check.mjs does. */
async function makePhoto(page) {
  const base64 = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(1600, 1200);
    const g = canvas.getContext('2d');
    const gradient = g.createLinearGradient(0, 0, 1600, 1200);
    gradient.addColorStop(0, '#4548cc');
    gradient.addColorStop(1, '#1b9c63');
    g.fillStyle = gradient;
    g.fillRect(0, 0, 1600, 1200);
    const bytes = new Uint8Array(
      await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer(),
    );
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  });
  return Buffer.from(base64, 'base64');
}

/** Presses `key` until `target` has focus; returns how many presses it took. */
async function pressUntilFocused(page, target, key = 'Tab', most = 40) {
  for (let presses = 0; presses <= most; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) return presses;
    await page.keyboard.press(key);
  }
  throw new Error(`${key} did not reach the control within ${most} presses`);
}

/** Which control has focus, by its label or text, with "(dialog)" when it is inside one. */
const focusName = (page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return '(nothing)';
    const label =
      element.labels?.[0]?.textContent?.trim() ||
      element.getAttribute('aria-label') ||
      element.textContent?.trim() ||
      element.tagName;
    const kind = element instanceof HTMLInputElement ? ` [${element.type}]` : '';
    return `${element.closest('dialog') ? '(dialog) ' : ''}${label}${kind}`;
  });

/** Everything on the page that could hold the key: markup, text and every input's value. */
const pageText = (page) =>
  page.evaluate(() =>
    [
      document.documentElement.outerHTML,
      document.body.innerText,
      ...[...document.querySelectorAll('input, textarea, select')].map((element) => element.value),
    ].join('\n'),
  );

/** localStorage, sessionStorage and every IndexedDB store, as text, by "database/store". */
const browserStorage = (page) =>
  page.evaluate(async () => {
    const dump = (storage) =>
      Array.from({ length: storage.length }, (_, i) => {
        const name = storage.key(i);
        return `${name}=${storage.getItem(name)}`;
      }).join('\n');
    const stores = {};
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((done, fail) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      });
      for (const store of db.objectStoreNames) {
        stores[`${name}/${store}`] = await new Promise((done, fail) => {
          const request = db.transaction(store).objectStore(store).getAll();
          request.onsuccess = () =>
            done(
              JSON.stringify(request.result, (_, value) =>
                typeof value === 'object' && value !== null && value.kind === 'directory'
                  ? `[folder ${value.name}]`
                  : value,
              ),
            );
          request.onerror = () => fail(request.error);
        });
      }
      db.close();
    }
    return { local: dump(localStorage), session: dump(sessionStorage), stores };
  });

// --------------------------------------------------------------------------- the check

async function runSettings(browser, name, url) {
  console.log(`\n== Settings check: ${name} (${url})`);
  const appOrigin = new URL(url).origin;
  const context = await browser.newContext({ acceptDownloads: true });

  // The fake provider. `scenario` is what it answers next; `hold` keeps an answer back until
  // released. Each request it handles is recorded, and so is each it was asked to answer.
  let scenario = { status: 200, body: '{"data":[]}' };
  let hold = null;
  const handled = [];
  const outside = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const address = new URL(request.url());
    if (address.hostname === PROVIDER_HOST) {
      const record = {
        method: request.method(),
        url: request.url(),
        headers: await request.allHeaders(),
        body: request.postData(),
        request,
      };
      handled.push(record);
      const cors = {
        'access-control-allow-origin': appOrigin,
        'access-control-allow-methods': 'GET',
        'access-control-allow-headers':
          'x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access',
        'access-control-max-age': '0',
      };
      // Not reached with Playwright 1.63, which answers preflights itself (see above); kept so a
      // Playwright that passes them on still gets a CORS answer, and the preflight is recorded.
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      if (hold) await hold.promise;
      try {
        if (scenario.fail) await route.abort('internetdisconnected');
        else {
          await route.fulfill({
            status: scenario.status,
            headers: { ...cors, 'content-type': 'application/json' },
            body: scenario.body,
          });
        }
      } catch {
        // The page cancelled the request while it was held: nothing to answer.
        record.cancelled = true;
      }
      return;
    }
    if (address.origin === appOrigin) {
      await route.continue();
      return;
    }
    outside.push(request.url());
    await route.abort('blockedbyclient');
  });

  const seen = [];
  const problems = [];
  context.on('request', (request) => seen.push(request));
  context.on('requestfailed', (request) => {
    const failedAtProvider = new URL(request.url()).hostname === PROVIDER_HOST;
    // Expected: the network-failure scenario, and a held request the page cancelled.
    const record = handled.find((r) => r.request === request);
    if (failedAtProvider && record) {
      record.failure = request.failure()?.errorText ?? 'failed';
      return;
    }
    problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`);
  });
  const page = await context.newPage();
  // Playwright answers an intercepted CORS preflight itself (a 204 that allows what was asked),
  // without passing it to context.route or reporting it as a request, so the browser's own
  // record of each request is read too: it shows every preflight Chromium makes.
  const preflightsMade = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Network.requestWillBeSent', (event) => {
    if (event.initiator?.type === 'preflight' || event.request.method === 'OPTIONS') {
      preflightsMade.push(`${event.request.method} ${event.request.url}`);
    }
  });
  await cdp.send('Network.enable');
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('dialog', (dialog) => dialog.accept());

  const checks = [];
  const check = (title, ok, detail = '') => {
    checks.push({ title, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${detail ? `: ${detail}` : ''}`);
  };
  /** Runs one step. If it cannot be carried out, that is its failure, and the next step runs. */
  const step = async (title, run) => {
    try {
      await run(title);
    } catch (error) {
      const lines = String(error).split('\n');
      const call = lines.find((line) => line.includes('- waiting for '));
      const waiting = call?.slice(call.indexOf('waiting for ')).split(String.fromCharCode(27))[0];
      // What the open dialog says, for the report: a step that timed out shows why.
      const shown = await page
        .evaluate(() => document.querySelector('dialog[open]')?.innerText.replace(/\s+/g, ' '))
        .catch(() => undefined);
      const reason = waiting ? `${lines[0]} It was ${waiting.trim()}.` : (lines[0] ?? '');
      check(title, false, shown ? `${reason} The open dialog said: "${shown}"` : reason);
    }
  };

  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
  const pageHeading = page.getByRole('heading', { name: 'Social Content Studio', level: 1 });
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const heading = dialog.getByRole('heading', { name: 'Settings' });
  const radio = dialog.getByRole('radio', { name: 'Claude (Anthropic)' });
  const keyBox = dialog.locator('input[type="password"]');
  const saveKey = dialog.getByRole('button', { name: 'Save key' });
  const testConnection = dialog.getByRole('button', { name: 'Test connection' });
  const removeKey = dialog.getByRole('button', { name: 'Remove key' });
  const close = dialog.getByRole('button', { name: 'Close' });
  const status = dialog.getByRole('status', { name: 'Settings messages' });
  const isFocused = (locator) => locator.evaluate((element) => element === document.activeElement);
  const openDialogs = () => page.evaluate(() => document.querySelectorAll('dialog[open]').length);
  /**
   * Waits until Settings has closed: hidden, and its content gone, which happens only once the
   * app's close handler has run (it releases the scroll lock and puts focus back on the button).
   * Chrome fires the dialog's close event a moment after hiding it, and moves focus back to the
   * button on its own before that, so neither "hidden" nor "focus is back" alone is enough; a
   * key pressed in that moment would arrive too early, and no person is that quick (as in
   * e2e/board.check.mjs). Returns whether focus is then on the Settings button.
   */
  const waitClosed = async () => {
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(
      () => ![...document.querySelectorAll('dialog h2')].some((h) => h.textContent === 'Settings'),
    );
    return isFocused(settingsButton);
  };
  const statusText = async () => ((await status.textContent()) ?? '').trim();
  const waitStatus = (text) =>
    page.waitForFunction(
      (want) =>
        document.querySelector('dialog[open] [role="status"]')?.textContent?.trim() === want,
      text,
      { timeout: 10_000 },
    );
  /**
   * Waits until Settings is open and has read what is saved: its key line says something. Until
   * then it knows no provider, as a person sees, and the check does not race ahead of it.
   */
  const waitLoaded = async () => {
    await dialog.waitFor();
    await page.waitForFunction(
      (texts) =>
        texts.some((t) => document.querySelector('dialog[open]')?.textContent?.includes(t)),
      [TEXT.noProvider, TEXT.noKey, TEXT.saved],
    );
  };
  /** Opens Settings from wherever focus is, by Shift+Tab back to the button and Enter. */
  const openSettings = async () => {
    await pressUntilFocused(page, settingsButton, 'Shift+Tab', 80);
    await page.keyboard.press('Enter');
    await waitLoaded();
  };
  /** Presses a dialog control: Tab from where focus is until it has focus, then `key`. */
  const press = async (locator, key = 'Enter') => {
    await pressUntilFocused(page, locator, 'Tab', 12);
    await page.keyboard.press(key);
  };
  /** The provider requests made since `from` (an index into `handled`), not preflights. */
  const callsSince = (from) => handled.slice(from).filter((r) => r.method !== 'OPTIONS');

  try {
    await page.goto(url, { waitUntil: 'load' });
    // A person waits for the page to appear before pressing keys. The heading appears in the
    // same render as the Settings button, and is there without it too, so on a page with no
    // Settings each step below still runs and fails on its own.
    await pageHeading.waitFor();

    await step(
      '1. Tab from the top of the page reaches Settings first, then the session controls',
      async (title) => {
        await page.keyboard.press('Tab');
        const first = await focusName(page);
        const onSettings = await isFocused(settingsButton);
        await page.keyboard.press('Tab');
        const second = await focusName(page);
        check(title, onSettings && second === 'Name [text]', `${first} > ${second}`);
      },
    );

    let requestsBeforeOpen = 0;
    await step(
      '2. Enter on Settings opens the dialog with focus on its heading, and makes no request',
      async (title) => {
        requestsBeforeOpen = seen.length;
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Enter');
        await waitLoaded();
        await page.waitForTimeout(500);
        const onHeading = await isFocused(heading);
        const modal = await dialog.evaluate((element) => element.matches(':modal'));
        const made = seen.slice(requestsBeforeOpen).map((r) => r.url());
        const keyState = await dialog.getByText(TEXT.noProvider).isVisible();
        check(
          title,
          onHeading && modal && made.length === 0 && keyState && !(await radio.isChecked()),
          `heading focused: ${onHeading}; modal: ${modal}; requests: ${made.length}${made.length ? ` (${made.join(', ')})` : ''}`,
        );
      },
    );

    const ORDER = [
      '(dialog) Claude (Anthropic) [radio]',
      '(dialog) API key [password]',
      '(dialog) Save key',
      '(dialog) Test connection',
      '(dialog) Remove key',
      '(dialog) Close',
    ];
    await step(
      '3. the dialog Tab order is the radio, key box, Save key, Test connection, Remove key, Close, and back',
      async (title) => {
        const forward = [];
        for (let i = 0; i < ORDER.length; i++) {
          await page.keyboard.press('Tab');
          forward.push(await focusName(page));
        }
        const back = [];
        for (let i = 0; i < ORDER.length - 1; i++) {
          await page.keyboard.press('Shift+Tab');
          back.push(await focusName(page));
        }
        const wantBack = ORDER.slice(0, -1).reverse();
        check(
          title,
          JSON.stringify(forward) === JSON.stringify(ORDER) &&
            JSON.stringify(back) === JSON.stringify(wantBack),
          `${forward.join(' > ')} | back: ${back.join(' > ')}`,
        );
      },
    );

    await step(
      '4. the note under Test connection says what it sends, and every button is enabled',
      async (title) => {
        const described = await testConnection.evaluate(
          (element) =>
            document.getElementById(element.getAttribute('aria-describedby'))?.textContent,
        );
        const enabled = await Promise.all(
          [saveKey, testConnection, removeKey, close].map((b) => b.isEnabled()),
        );
        check(title, described === NOTE && enabled.every(Boolean), `note: ${described}`);
      },
    );

    await step(
      '5. with no provider chosen, Test connection and Save key say "Choose a provider first." and send nothing',
      async (title) => {
        const before = handled.length;
        await press(testConnection, 'Enter');
        await waitStatus(TEXT.chooseFirst);
        await page.keyboard.press('Shift+Tab'); // Save key
        await page.keyboard.press('Shift+Tab'); // the key box
        await page.keyboard.type('not saved');
        await page.keyboard.press('Tab'); // Save key
        await page.keyboard.press('Space');
        await waitStatus(TEXT.chooseFirst);
        check(title, handled.length === before, `${handled.length - before} provider requests`);
      },
    );

    await step(
      '6. Space on the radio button chooses Claude (Anthropic), saved at once, and labels the key box',
      async (title) => {
        await pressUntilFocused(page, radio, 'Shift+Tab', 8);
        await page.keyboard.press('Space');
        await waitStatus(TEXT.chosen);
        const label = await keyBox.evaluate((element) => element.labels?.[0]?.textContent);
        const keyState = await dialog.getByText(TEXT.noKey).isVisible();
        check(
          title,
          (await radio.isChecked()) && label === 'Claude (Anthropic) API key' && keyState,
          `label: ${label}`,
        );
      },
    );

    await step(
      '7. Save key with an empty box (spaces only) says "Paste a key first."',
      async (title) => {
        await page.keyboard.press('Tab'); // the key box, still holding the text from step 5
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.keyboard.type('   ');
        await page.keyboard.press('Enter');
        await waitStatus(TEXT.pasteFirst);
        check(title, true, await statusText());
      },
    );

    await step(
      '8. a key typed and saved with Enter: "Key saved.", the box is empty and the key is nowhere on the page or in the browser but the settings store',
      async (title) => {
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(KEY);
        await page.keyboard.press('Enter');
        await waitStatus(TEXT.keySaved);
        const value = await keyBox.inputValue();
        const onPage = (await pageText(page)).includes(KEY);
        const stored = await browserStorage(page);
        const holders = Object.entries(stored.stores)
          .filter(([, text]) => text.includes(KEY))
          .map(([store]) => store);
        check(
          title,
          value === '' &&
            !onPage &&
            (await dialog.getByText(TEXT.saved).isVisible()) &&
            !stored.local.includes(KEY) &&
            !stored.session.includes(KEY) &&
            JSON.stringify(holders) === JSON.stringify(['social-content-studio-settings/keys']),
          `box: ${JSON.stringify(value)}; on page: ${onPage}; stores holding it: ${holders.join(', ')}`,
        );
      },
    );

    let preflights = 0;
    await step(
      '9. Test connection sends one GET to the model list, with the key only in x-api-key, the version and the browser opt-in; "Connected."',
      async (title) => {
        const from = handled.length;
        scenario = { status: 200, body: '{"data":[{"id":"fake-model"}]}' };
        await press(testConnection, 'Space');
        await waitStatus(TEXT.ok);
        const calls = callsSince(from);
        preflights += handled.slice(from).filter((r) => r.method === 'OPTIONS').length;
        const call = calls[0];
        const others = Object.entries(call?.headers ?? {}).filter(([name]) => name !== 'x-api-key');
        const ok =
          calls.length === 1 &&
          call.method === 'GET' &&
          call.url === MODELS_URL &&
          call.headers['x-api-key'] === KEY &&
          call.headers['anthropic-version'] === '2026-10-21' &&
          call.headers['anthropic-dangerous-direct-browser-access'] === 'true' &&
          !('authorization' in call.headers) &&
          !('cookie' in call.headers) &&
          !('referer' in call.headers) &&
          call.body === null &&
          !call.url.includes(KEY) &&
          others.every(([, value]) => !value.includes(KEY));
        check(
          title,
          ok,
          `${calls.length} request(s): ${call?.method} ${call?.url}; headers: ${Object.keys(
            call?.headers ?? {},
          )
            .sort()
            .join(', ')}; body: ${call?.body}`,
        );
      },
    );

    const cases = [
      ['wrong key (401)', { status: 401, body: errorBody('invalid x-api-key') }, 'wrong-key'],
      [
        'organization blocked (401)',
        {
          status: 401,
          body: errorBody(
            `CORS requests are not allowed for this Organization because of its settings. ${PROVIDER_TEXT}`,
          ),
        },
        'org-blocked',
      ],
      [
        'key not tied to a workspace (400)',
        {
          status: 400,
          body: errorBody(
            `This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header. ${PROVIDER_TEXT}`,
          ),
        },
        'workspace',
      ],
      ['too many requests (429)', { status: 429, body: errorBody() }, 'rate-limited'],
      ['provider problem (500)', { status: 500, body: errorBody() }, 'provider-problem'],
      ['overloaded (529)', { status: 529, body: errorBody('Overloaded') }, 'provider-problem'],
      ['network failure', { fail: true }, 'unreachable'],
    ];
    let n = 10;
    for (const [what, answer, result] of cases) {
      await step(
        `${n++}. ${what}: the app's own message, and no provider text on the page`,
        async (title) => {
          scenario = answer;
          // Focus is still on Test connection.
          await page.keyboard.press('Enter');
          await waitStatus(TEXT[result]);
          const text = await pageText(page);
          check(
            title,
            !text.includes(PROVIDER_TEXT) &&
              !text.includes('CORS requests') &&
              !text.includes('not scoped'),
            await statusText(),
          );
        },
      );
    }

    let heldRequest = null;
    for (const how of ['Escape', 'Close']) {
      await step(
        `${n++}. closing with ${how} while Test connection waits cancels it: no message later, and reopening shows a clean dialog`,
        async (title) => {
          scenario = { status: 200, body: '{}' };
          let release;
          hold = { promise: new Promise((done) => (release = done)) };
          const from = handled.length;
          await press(testConnection, 'Enter');
          await waitStatus(TEXT.checking);
          await page.waitForFunction(() => true);
          for (let i = 0; i < 50 && callsSince(from).length === 0; i++)
            await page.waitForTimeout(100);
          heldRequest = callsSince(from)[0] ?? null;
          if (how === 'Escape') await page.keyboard.press('Escape');
          else await press(close, 'Enter');
          const backOnButton = await waitClosed();
          // Reopened first, and only then is the provider's answer let through: an answer that
          // still reached the app would show its message in the open dialog.
          await page.keyboard.press('Enter');
          await waitLoaded();
          release();
          hold = null;
          await page.waitForTimeout(1500);
          const after = await statusText();
          // The page aborted it: the browser reports it failed, or answering it was refused.
          const cancelled =
            heldRequest?.cancelled === true || /ABORTED/.test(heldRequest?.failure ?? '');
          check(
            title,
            heldRequest !== null && backOnButton && after === '' && cancelled,
            `request held: ${heldRequest !== null}; cancelled by the page: ${cancelled}; focus back on Settings: ${backOnButton}; message after reopening: ${JSON.stringify(after)}`,
          );
        },
      );
    }

    await step(
      `${n++}. after a reload, Settings still says "Key saved on this computer." with Claude (Anthropic) chosen and an empty box`,
      async (title) => {
        await page.reload({ waitUntil: 'load' });
        await pageHeading.waitFor();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await waitLoaded();
        await dialog.getByText(TEXT.saved).waitFor();
        check(
          title,
          (await radio.isChecked()) &&
            (await keyBox.inputValue()) === '' &&
            !(await pageText(page)).includes(KEY),
          'key state shown',
        );
      },
    );

    await step(
      `${n++}. Remove key removes it at once, then Test connection says no key is saved and sends nothing`,
      async (title) => {
        await press(removeKey, 'Enter');
        await waitStatus(TEXT.removed);
        const keyState = await dialog.getByText(TEXT.noKey).isVisible();
        const from = handled.length;
        await page.keyboard.press('Shift+Tab'); // Test connection
        await page.keyboard.press('Enter');
        await waitStatus(TEXT['no-key']);
        const sent = handled.length - from;
        await page.keyboard.press('Tab'); // Remove key
        await page.keyboard.press('Space');
        await waitStatus(TEXT.nothingToRemove);
        const stored = await browserStorage(page);
        check(
          title,
          keyState && sent === 0 && !JSON.stringify(stored).includes(KEY),
          `requests after removal: ${sent}`,
        );
      },
    );

    await step(
      `${n++}. scroll is locked while Settings is open, and the page stays where it was`,
      async (title) => {
        await page.keyboard.press('Escape');
        await waitClosed();
        await page.setViewportSize({ width: 800, height: 300 });
        const scrollable = await page.evaluate(
          () => document.documentElement.scrollHeight > window.innerHeight,
        );
        const before = await page.evaluate(() => window.scrollY);
        await page.keyboard.press('Enter');
        await waitLoaded();
        const overflow = await page.evaluate(() => document.documentElement.style.overflow);
        await page.keyboard.press('PageDown');
        await page.keyboard.press('End');
        // The mouse wheel over the backdrop, beside the dialog: without the lock, this scrolls
        // the page behind a modal dialog.
        await page.mouse.move(20, 150);
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(300);
        const during = await page.evaluate(() => window.scrollY);
        await page.keyboard.press('Escape');
        await waitClosed();
        const restored = await page.evaluate(() => document.documentElement.style.overflow);
        await page.setViewportSize({ width: 1280, height: 720 });
        check(
          title,
          scrollable && overflow === 'hidden' && during === before && restored === '',
          `page taller than the window: ${scrollable}; overflow while open: ${overflow}; scrollY ${before} -> ${during}; after: ${JSON.stringify(restored)}`,
        );
      },
    );

    // A session with a photo and cards, then Settings opened over it.
    await step(
      `${n++}. with a session and cards: Escape from the key box closes only Settings, no card dialog opens, and focus is back on Settings`,
      async (title) => {
        await pressUntilFocused(page, page.getByRole('button', { name: 'New session' }), 'Tab', 10);
        await page.keyboard.press('Enter');
        // The system's file picker cannot be driven, so the file is given to the input directly.
        await page.getByLabel('Photos to import').setInputFiles({
          name: PHOTO,
          mimeType: 'image/jpeg',
          buffer: await makePhoto(page),
        });
        await page.getByRole('status').filter({ hasText: 'Import finished' }).first().waitFor();
        await pressUntilFocused(
          page,
          page.getByRole('button', { name: 'Create cards' }),
          'Tab',
          40,
        );
        await page.keyboard.press('Enter');
        const form = page.getByRole('form', { name: 'Create cards' });
        for (const placement of ['Feed vertical', 'Image post square']) {
          const box = form.getByRole('checkbox', { name: new RegExp(`^${placement} \\(`) });
          await pressUntilFocused(page, box, 'Tab', 40);
          await page.keyboard.press('Space');
        }
        await pressUntilFocused(page, form.getByRole('button', { name: 'Create' }), 'Tab', 40);
        await page.keyboard.press('Enter');
        const cards = page.getByRole('article');
        await cards.nth(1).waitFor();
        const cardCount = await cards.count();

        await openSettings();
        await press(keyBox, 'a');
        await page.keyboard.type('typed and not saved');
        await page.keyboard.press('Escape');
        const onButton = await waitClosed();
        await page.waitForTimeout(500);
        const dialogsOpen = await openDialogs();
        const after = await cards.count();
        await page.keyboard.press('Enter');
        await waitLoaded();
        const boxAfter = await keyBox.inputValue();
        check(
          title,
          dialogsOpen === 0 && onButton && after === cardCount && boxAfter === '',
          `${cardCount} cards; dialogs open after Escape: ${dialogsOpen}; focus on Settings: ${onButton}; key box on reopening: ${JSON.stringify(boxAfter)}`,
        );
      },
    );

    await step(
      `${n++}. Ctrl+Z inside Settings never changes the session; outside it, it is the app's undo`,
      async (title) => {
        // Settings is open from the step before; focus is on its heading.
        const cards = page.getByRole('article');
        const before = await cards.count();
        await page.keyboard.press('Tab'); // the radio button
        await page.keyboard.press('Control+z');
        await page.keyboard.press('Tab'); // the key box
        await page.keyboard.press('Control+z');
        await press(removeKey, 'Control+z');
        await page.waitForTimeout(300);
        const during = await cards.count();
        await page.keyboard.press('Escape');
        await waitClosed();
        await page.keyboard.press('Control+z'); // on the Settings button, outside the dialog
        await page.waitForFunction(
          (count) => document.querySelectorAll('article').length < count,
          before,
        );
        const after = await cards.count();
        check(
          title,
          during === before && after < before,
          `cards: ${before} -> ${during} inside -> ${after} outside`,
        );
      },
    );

    await step(
      `${n++}. a key saved with a session open survives New session and Clear session`,
      async (title) => {
        await page.keyboard.press('Enter');
        await waitLoaded();
        await press(keyBox, 'Control+a');
        await page.keyboard.type(KEY);
        await page.keyboard.press('Enter');
        await waitStatus(TEXT.keySaved);
        await page.keyboard.press('Escape');
        await waitClosed();
        await pressUntilFocused(
          page,
          page.getByRole('button', { name: 'Clear session' }),
          'Tab',
          20,
        );
        await page.keyboard.press('Enter');
        await page.getByRole('article').first().waitFor({ state: 'detached' });
        await pressUntilFocused(
          page,
          page.getByRole('button', { name: 'New session' }),
          'Shift+Tab',
          20,
        );
        await page.keyboard.press('Enter');
        await openSettings();
        const kept = await dialog.getByText(TEXT.saved).isVisible();
        const stored = await browserStorage(page);
        check(
          title,
          kept && (stored.stores['social-content-studio-settings/keys'] ?? '').includes(KEY),
          `key state: ${kept ? TEXT.saved : 'not saved'}`,
        );
        await page.keyboard.press('Escape');
      },
    );

    await step(
      `${n++}. at the end the key is not on the page, in localStorage, sessionStorage or any IndexedDB store but the settings one`,
      async (title) => {
        const stored = await browserStorage(page);
        const holders = Object.entries(stored.stores)
          .filter(([, text]) => text.includes(KEY))
          .map(([store]) => store);
        const onPage = (await pageText(page)).includes(KEY);
        check(
          title,
          !onPage &&
            !stored.local.includes(KEY) &&
            !stored.session.includes(KEY) &&
            JSON.stringify(holders) === JSON.stringify(['social-content-studio-settings/keys']),
          `on page: ${onPage}; stores holding it: ${holders.join(', ')}; all stores: ${Object.keys(stored.stores).join(', ')}`,
        );
      },
    );

    // The network, over the whole run.
    await step(
      `${n++}. every request to ${PROVIDER_HOST} was handled by the fake provider, and none reached the network`,
      async (title) => {
        const atProvider = seen.filter((r) => new URL(r.url()).hostname === PROVIDER_HOST);
        const unhandled = atProvider.filter((r) => !handled.some((h) => h.request === r));
        const allOptions = handled.filter((r) => r.method === 'OPTIONS').length;
        check(
          title,
          unhandled.length === 0 && wire.connections === 0 && atProvider.length > 0,
          `${atProvider.length} requests seen, ${handled.length} handled by the route (${allOptions} OPTIONS among them); unhandled: ${unhandled.length}; preflights Chromium made: ${preflightsMade.length}, answered by Playwright, not sent; connections at the trap address: ${wire.connections}`,
        );
      },
    );

    await step(
      `${n++}. the key went only to the model list address, in x-api-key, and in no other request`,
      async (title) => {
        const leaks = [];
        for (const request of seen) {
          const headers = await request.allHeaders().catch(() => ({}));
          const isModelList =
            request.url() === MODELS_URL &&
            request.method() === 'GET' &&
            headers['x-api-key'] === KEY;
          const others = Object.entries(headers).filter(
            ([h]) => !(isModelList && h === 'x-api-key'),
          );
          const text = [request.url(), request.postData() ?? '', ...others.flat()].join('\n');
          if (text.includes(KEY)) leaks.push(`${request.method()} ${request.url()}`);
        }
        check(
          title,
          leaks.length === 0,
          leaks.length ? leaks.join(', ') : `${seen.length} requests checked`,
        );
      },
    );

    await step(
      `${n++}. no request left the app's own address except to the fake provider`,
      async (title) => {
        const elsewhere = seen
          .map((r) => r.url())
          .filter(
            (u) =>
              !u.startsWith(appOrigin) &&
              !/^(blob|data):/.test(u) &&
              new URL(u).hostname !== PROVIDER_HOST,
          );
        check(title, elsewhere.length === 0 && outside.length === 0, elsewhere.join(', '));
      },
    );

    await step(
      `${n++}. no failed requests, no page errors, and no console errors except the browser's own notes on the fake provider's error answers`,
      async (title) => {
        // Chromium writes "Failed to load resource" for each non-2xx answer and for the aborted
        // requests of the network-failure and cancel steps; those are the expected ones.
        const unexpected = consoleErrors.filter(
          (text) =>
            !/^Failed to load resource: (the server responded with a status of (400|401|429|500|529)|net::ERR_INTERNET_DISCONNECTED)/.test(
              text,
            ),
        );
        const keyInConsole = consoleErrors.some((text) => text.includes(KEY));
        check(
          title,
          problems.length === 0 && unexpected.length === 0 && !keyInConsole,
          [...problems, ...unexpected].join(' | ') ||
            `${consoleErrors.length} expected console notes`,
        );
      },
    );

    console.log(
      `  (CORS preflight: Chromium made ${preflightsMade.length} over the run (${[...new Set(preflightsMade)].join(', ')}); ${preflights} reached the route in step 9 and ${handled.filter((r) => r.method === 'OPTIONS').length} over the whole run)`,
    );
  } catch (error) {
    check('the check ran to the end', false, String(error).split('\n')[0]);
  } finally {
    await context.close();
  }
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(checks, null, 2));
  return checks.every((c) => c.ok);
}

function errorBody(message = PROVIDER_TEXT) {
  return JSON.stringify({
    type: 'error',
    error: { type: 'some_error', message: `${message} ${PROVIDER_TEXT}` },
    request_id: `req_${PROVIDER_TEXT}`,
  });
}

let failed = false;
const browser = await chromium.launch({
  // The safety net: the provider's name leads only to the trap on this machine.
  args: [`--host-resolver-rules=MAP ${PROVIDER_HOST} 127.0.0.1:${PORTS.trap}`],
});
try {
  console.log(`Chromium ${browser.version()}; report in ${outDir}`);

  const devUrl = `http://localhost:${PORTS.dev}/`;
  await serve(['--port', String(PORTS.dev), '--strictPort'], {}, devUrl);
  failed = !(await runSettings(browser, 'dev', devUrl)) || failed;

  console.log(`\n== Production build with BASE_PATH=${BASE}`);
  execFileSync('npm', ['run', 'build'], {
    cwd: root,
    env: { ...process.env, BASE_PATH: BASE },
    stdio: 'ignore',
  });
  const siteUrl = `http://localhost:${PORTS.site}${BASE}`;
  await serve(
    ['preview', '--port', String(PORTS.site), '--strictPort'],
    { BASE_PATH: BASE },
    siteUrl,
  );
  failed = !(await runSettings(browser, 'production', siteUrl)) || failed;
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser.close();
  stopServers();
  trap.close();
}
console.log(
  `\nConnections that reached the trap address for ${PROVIDER_HOST}: ${wire.connections}`,
);
console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: all checks passed');
process.exit(failed ? 1 : 0);
