# CLAUDE.md

Social Content Studio is a browser-only React app that turns photos and short videos into
platform-ready social posts. **SPEC.md is the source of truth**; read it before starting any task.
Keep each task to one feature row from the SPEC feature table.

## Hard rules

- **Platform specs live in `src/data/platforms.json`, never in code.** Sizes, ratios, caption caps,
  truncation points, hashtag caps, durations, file-size caps, and safe zones are read from that file.
  Do not hard-code a platform number in a component, the validator, or a test helper; tests use the
  JSON. Marketing must be able to update the file without a code change. Every entry has a
  `verified` date; update it when a value is re-checked.
- No backend. Everything runs in the browser; only AI provider calls leave the machine.
- API keys are stored only in IndexedDB. They are never written into a session file, never logged,
  and sent only to that provider's API endpoint.
- Assets are immutable once imported; every change happens on a card.
- `session.json`, `brand.json` and `.scs` bundles are written only through the allowlist
  serializers in `src/lib/session/serialize.ts`. A new field on `Session` or `BrandKit` must be
  added there or it is not saved.
- A session folder is only ever written with the session it was opened or chosen for, and clearing
  a session deletes nothing on disk.
- Coverage for `src/lib/session` and `src/store` must stay at 100% (`npm run coverage`).
- The validator (`src/lib/validate.ts`) must keep pass and fail tests for all nine rules in SPEC.md.
- Supported browsers: Chrome and Edge only (WebCodecs, File System Access API).
- Git identity: this repo is public. Before the first commit in any session, set repo-level git
  config user.name "originaltash10" and user.email
  "345849549+originaltash10@users.noreply.github.com" (never global config), and confirm with
  git log -1 that author and committer use that address. Commit messages and PR descriptions have
  no Co-Authored-By or 'Generated with' trailer lines and name no company.

## Stack

| Concern          | Choice                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| Framework        | React 18, TypeScript (strict + `noUncheckedIndexedAccess`), Vite        |
| State            | Zustand with Immer; single session store, snapshot-based undo (50)      |
| Styling          | Tailwind CSS v4 (via `@tailwindcss/vite`)                               |
| Canvas           | Fabric.js for the image editor (Phase 1 step 7+)                        |
| Image processing | OffscreenCanvas in a Web Worker, `createImageBitmap`                    |
| HEIC decode      | `heic-to` or `libheif-js`                                               |
| Video            | WebCodecs via `mediabunny`; ffmpeg.wasm only as fallback (Phase 3)      |
| PDF              | pdf-lib                                                                 |
| Persistence      | File System Access API + `idb-keyval`; IndexedDB for blobs and keys     |
| Export           | Stream to session `exports/`; JSZip download fallback                   |
| Tests            | Vitest (jsdom) for lib and validator; Playwright for board flow (later) |
| Lint / format    | ESLint flat config + typescript-eslint (strict), Prettier               |

## Layout

```
src/app        routes and layout (App shell)
src/board      card grid, filters, compare
src/editor     canvas, crop handles, overlays
src/export     per-platform folders, captions.csv
src/settings   brand kit, AI keys
src/lib        image/, video/, validate.ts (pure, no DOM or store access)
src/lib/session  session.json/brand.json serializers, folder and .scs readers/writers (no store access)
src/store      session store (sessionStore.ts) and save/load/autosave (persistence.ts)
src/ai         provider interface (provider.ts), adapters, tasks/
src/workers    image, video, transcription workers
src/data       platforms.json, brand defaults
src/types.ts   core data model from SPEC.md
```

## Commands

```bash
npm run dev          # Vite dev server
npm run typecheck    # tsc -b
npm run lint         # ESLint
npm run format       # Prettier write
npm test             # Vitest, single run
npm run coverage     # Vitest with v8 coverage over src/lib
```

Run `typecheck`, `lint`, and `test` before every commit.
