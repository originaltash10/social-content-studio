# Social Content Studio — Product Spec

As of November 16, 2026

## Purpose

Social Content Studio is a browser app that turns a photo, a set of photos, or a short video into platform-ready social posts: correctly sized, formatted, captioned, validated against each platform's rules, and exported as files. It runs locally with no backend, saves sessions to the user's own machine, and uses the user's own Claude, Gemini, or OpenAI key for writing help.

Primary users are an in-house marketing team. Secondary users are anyone in the office (project managers, recruiters, field staff) who has a photo or clip and needs it ready for LinkedIn or Instagram without asking a designer.

Target platforms, in priority order: Instagram (feed, carousel, Stories, Reels), LinkedIn (image, document carousel, video), Facebook, X. YouTube is out of scope.

What success looks like: a non-designer opens the app, drops in a site photo and a clip, picks two platforms, and leaves ten minutes later with validated, on-brand files and captions. This spec is the working brief for building it with Claude Code; the user runs Claude Code on their desktop and pastes its output back into chat for review.

## Core workflow

The user moves left to right once, then loops between the board, the editor, and validation until every card is green.

```
Import → Pick targets → Generate → Board
                                      ↓
          Export ← Edit ← Validate ←──┘
                    ↑__________________↓   (re-generate after an edit)

Session autosaves to disk throughout.
```

- **Import**: photos, video, and an optional text brief.
- **Pick targets**: platform + placement, one card created per placement.
- **Generate**: crops, resizes, captions, alt text run in the background.
- **Board**: one card per variant, with validation badge.
- **Validate**: pass / warn / fail on every change.
- **Edit**: duplicate, compare, fix.
- **Export**: per-platform files plus captions.csv.

Import accepts drag-and-drop of JPG, PNG, HEIC, MP4, and MOV plus an optional text brief. Picking targets creates one card per platform placement (for example, Instagram Reel and LinkedIn video from one clip). Generate runs crops, resizes, and AI copy in the background while the board fills in. Validate runs on every edit, and Export only includes cards that pass or that the user explicitly overrides.

## Features by area

Each row is a feature Claude Code should treat as a unit of work. Priority: P1 ships in the MVP, P2 in the second release, P3 later.

| Area | Feature | Priority | Notes |
| --- | --- | --- | --- |
| Import | Drag-and-drop images and video, HEIC and MOV decoded in browser | P1 | Fall back to a clear "convert first" message if the codec is unsupported |
| Import | Campaign brief field (topic, audience, CTA, link) | P1 | Fed into every AI prompt |
| Images | Smart crop with draggable focal point per source image | P1 | One focal point drives all ratios; a duplicated card gets its own |
| Images | Resize and export to platform dimensions, JPG and PNG, quality slider | P1 | |
| Images | Text overlay with brand fonts, colors, alignment, shadow, safe-zone snapping | P1 | |
| Images | Logo and watermark placement with opacity | P1 | |
| Images | Carousel builder: order slides, per-slide text, cover slide | P1 | Instagram up to 20 slides; LinkedIn exports as PDF document |
| Images | Collage: 2 to 6 images in grid or freeform layout into one image | P2 | |
| Images | Background removal | P3 | Browser-side model is heavy; defer |
| Video | Trim in and out points with frame-accurate scrubber | P1 | |
| Video | Crop and reframe to 9:16, 4:5, 1:1, 16:9 with focal point tracking | P1 | Static focal point in P1, subject tracking in P2 |
| Video | Cover frame picker and custom cover image upload | P1 | |
| Video | Auto-captions from speech, styled from brand kit, burned in at export | P2 | Whisper via transformers.js or the user's AI provider |
| Video | Mute, lower, or replace audio track | P2 | |
| Video | Export H.264 MP4 at platform spec with progress bar | P1 | WebCodecs first, ffmpeg.wasm fallback |
| Copy | Caption generation per platform with tone setting | P1 | Formal for LinkedIn, lighter for Instagram |
| Copy | Fit-to-limit: shorten to character cap while keeping the CTA | P1 | |
| Copy | Alt text generation for every image | P1 | |
| Copy | Hashtag block and first-comment field, separate from caption | P1 | |
| Copy | Repurpose: paste a URL or text and generate a post set | P2 | |
| Copy | UTM link builder | P2 | |
| Validation | Per-card pass / warn / fail against platform rules | P1 | Dimensions, ratio, file size, duration, caption length, slide count |
| Validation | Safe-zone overlay on canvas for Stories and Reels | P1 | |
| Validation | Preview mock inside a fake feed, Story, and LinkedIn card | P2 | Shows where "...more" truncates |
| Board | Card grid grouped by source asset or campaign, filter by platform and status | P1 | |
| Board | Duplicate card as linked variant with lineage | P1 | |
| Board | Compare two to four cards side by side with caption diff | P1 | |
| Board | Status field (Draft, Review, Approved) and comments per card | P2 | Keep it light; no permissions system |
| Board | Calendar view with a planned date per card | P3 | |
| Brand | Brand kit: logos, fonts, colors, voice document, overlay presets | P1 | Stored in the session and exportable as a brand file |
| Brand | Templates: Project announcement, Job posting, Event recap, Safety message | P2 | |
| Session | Autosave to a local folder via File System Access API; manual save and load | P1 | Chrome and Edge; download a .scs bundle as fallback |
| Session | Clear session with confirmation | P1 | |
| Export | Per-platform folders with named files, captions.csv, alt text, hashtags | P1 | |
| Export | Proof sheet PDF for approval | P2 | |
| Export | Buffer and Hootsuite bulk-import CSV | P3 | |
| AI | Provider settings: Claude, Gemini, OpenAI with user's own key | P1 | Key stored only in the browser; never sent anywhere but the provider |
| AI | Show which provider wrote each piece of text | P1 | |

## Platform specs and validation rules

These rules live in `src/data/platforms.json`, not in code, so marketing can update them without a rebuild. Image sizes below are from [Hootsuite's guide](https://blog.hootsuite.com/social-media-image-sizes-guide/) updated November 2, 2026. Video and caption limits are from platform help pages as of mid-2026 and should be re-checked at build time; Claude Code should add a `verified` date field to each entry.

| Platform | Placement | Size (px) | Ratio | Type | Caption cap | Other limits |
| --- | --- | --- | --- | --- | --- | --- |
| Instagram | Feed vertical | 1080 x 1350 | 4:5 | image | 2,200 chars | 30 hashtags; grid shows 3:4 crop |
| Instagram | Feed square | 1080 x 1080 | 1:1 | image | 2,200 chars | |
| Instagram | Feed landscape | 1080 x 566 | 1.91:1 | image | 2,200 chars | |
| Instagram | Carousel | 1080 x 1350 | 4:5 | image set | 2,200 chars | 2 to 20 slides, same ratio for all |
| Instagram | Story | 1080 x 1920 | 9:16 | image or video | n/a | Safe area 1080 x 1610 centered; video up to 60 s per Story |
| Instagram | Reel | 1080 x 1920 | 9:16 | video | 2,200 chars | Up to 3 min; MP4 H.264, AAC; keep top 14%, bottom 35%, sides 6% clear; 30 fps; cover crops to 3:4 on grid |
| LinkedIn | Image post square | 1200 x 1200 | 1:1 | image | 3,000 chars | "...see more" cuts around 210 chars on desktop, 140 on mobile |
| LinkedIn | Image post vertical | 720 x 900 | 4:5 | image | 3,000 chars | |
| LinkedIn | Link preview | 1200 x 627 | 1.91:1 | image | 3,000 chars | |
| LinkedIn | Document carousel | 1080 x 1350 | 4:5 | PDF | 3,000 chars | Export slides as one PDF, max 300 pages, under 100 MB |
| LinkedIn | Video | 1080 x 1920, 1080 x 1080, or 1920 x 1080 | 9:16, 1:1, 16:9 | video | 3,000 chars | 3 s to 10 min, under 5 GB, MP4 recommended; 1920 x 1080 for 16:9 is assumed |
| Facebook | Feed vertical | 1080 x 1350 | 4:5 | image | 63,206 chars | Truncates at 477 chars |
| Facebook | Story | 1080 x 1920 | 9:16 | image or video | n/a | Video up to 60 s per Story (assumed, same as Instagram); keep top 14%, bottom 35%, sides 6% clear (assumed, same as Instagram Reel) |
| Facebook | Reel | 1080 x 1920 | 9:16 | video | n/a | Up to 90 s; keep top 14%, bottom 35%, sides 6% clear (assumed, same as Instagram Reel) |
| X | Landscape | 1280 x 720 | 16:9 | image | 280 chars | Up to 4 images; 5 MB on mobile |
| X | Square | 1080 x 1080 | 1:1 | image | 280 chars | |
| X | Video | 1280 x 720 or 720 x 1280 | 16:9, 9:16 | video | 280 chars | Up to 2 min 20 s standard, 512 MB |

Validation runs on every change and produces one result per card: pass, warn, or fail with a reason. Fail blocks export unless overridden. Rules to implement in `src/lib/validate.ts`:

1. Dimensions and ratio match the placement within 1 px rounding; otherwise fail.
2. File size under the placement cap; otherwise fail.
3. Video duration within range; otherwise fail. Frame rate 30 fps recommended; otherwise warn.
4. Caption length under cap; otherwise fail. Caption longer than the truncation point; warn with the cut-off shown.
   Where a placement's `hashtagsInCaption` is true in `platforms.json` (LinkedIn, Facebook, X), the length is measured on the caption plus the hashtags joined with spaces, for both the cap and the truncation warnings. Where it is false (Instagram, where hashtags go in the first comment), only the caption counts.
5. Hashtag count under cap; otherwise fail.
6. Carousel slide count in range and all slides the same ratio; otherwise fail.
7. Any text overlay, logo, or focal point inside a Story or Reel unsafe zone; warn.
8. Alt text missing on an image; warn.
9. Caption contains a URL on Instagram, where links are not clickable; warn.

## AI provider layer

One interface, three adapters. The app never depends on a specific vendor's response shape, and every call carries the brand voice document, the campaign brief, and the platform rules so output is specific rather than generic.

```typescript
interface AIProvider {
  id: 'anthropic' | 'google' | 'openai';
  complete(req: { system: string; user: string; image?: Blob; maxTokens: number }): Promise<string>;
  describeImage(image: Blob): Promise<string>;
  transcribe?(audio: Blob): Promise<Caption[]>;
}
```

Tasks built on that interface, each a function in `src/ai/tasks/`:

| Task | Input | Output | Notes |
| --- | --- | --- | --- |
| caption | brief, platform, tone, image description | caption text | Returns JSON `{caption, firstComment, hashtags}` |
| fitToLimit | caption, cap, CTA | shortened caption | Keeps the CTA sentence verbatim |
| altText | image | one or two sentences | Describes content, not mood; no "image of" prefix |
| rewriteTone | text, target tone | text | LinkedIn formal, Instagram conversational, X terse |
| describeImage | image | structured description | Used to ground captions; cached per source asset |
| repurpose | pasted text or URL content | post set per platform | P2 |
| transcribe | audio track | timed captions | P2; Whisper via transformers.js when no provider supports audio |

Key handling: the user pastes a key in Settings. It is stored in the browser's IndexedDB for this app only, never written into the session file, never logged, and sent only to that provider's API endpoint. Settings shows a "Test connection" button and a per-provider usage counter. Browser calls to the Anthropic API need the `anthropic-dangerous-direct-browser-access` header; Gemini and OpenAI accept browser calls with a key directly.

Every generated text records `{provider, model, timestamp}` so the card can show who wrote it. A "Regenerate" button re-runs the same task; "Edit" opens the text for manual change and clears the provider badge.

Prompt structure, in order: system prompt with brand voice and hard platform rules; user message with the brief, the image description, the task, and the required JSON shape. Parse the JSON, strip code fences, retry once on parse failure.

## Architecture and tech stack

A single-page React app built with Vite, no server. Chrome and Edge are the supported browsers because the app depends on WebCodecs and the File System Access API.

Everything runs in the browser; only AI calls leave the machine.

```
Browser (Chrome or Edge), React + Vite, no backend
┌──────────────────────────────────────────────────────────────┐
│  UI:      Board      │  Editor     │  Export     │ Settings  │
│           cards,     │  canvas,    │  folders,   │ brand kit,│
│           compare    │  timeline   │  CSV, proof │ AI keys   │
├──────────────────────────────────────────────────────────────┤
│  Lib:     Image      │  Video      │  Validator  │ AI        │
│           pipeline   │  pipeline   │  reads      │ adapters  │
│           (worker)   │  (WebCodecs)│  platforms  │ (3 vendors│
├──────────────────────────────────────────────────────────────┤
│  State:   Session store (Zustand) + IndexedDB    │ API keys  │
│           asset cache; autosaves every 30 s      │ IndexedDB │
└──────────────────────────────────────────────────────────────┘
            ↓                                          ↓
   Local disk: session folder                  AI vendor APIs
   (File System Access API)                    Claude, Gemini, OpenAI
   session.json + assets/ + exports/
```

The session folder is the only thing the user needs to back up or move between machines.

Stack decisions for Claude Code to follow:

| Concern | Choice | Why |
| --- | --- | --- |
| Framework | React 18, TypeScript, Vite | Fast dev loop, strong typing for the data model |
| State | Zustand with Immer | Single store, cheap undo via snapshots |
| Styling | Tailwind CSS | Quick to iterate on a board UI |
| Canvas | Phase 1 crop and focal point use plain elements with pointer events. Whether to use Fabric.js for Phase 2 text and logo overlays is decided at the start of Phase 2 | The crop and focal point need no canvas library. Fabric 7 adds node-canvas and jsdom as optional dependencies |
| Image processing | OffscreenCanvas in a Web Worker, `createImageBitmap` | Keeps the UI responsive during batch resize |
| HEIC decode | `heic-to` or `libheif-js` | iPhone photos |
| Video | WebCodecs via `mediabunny` (demux, decode, encode, mux MP4) | Hardware-accelerated; ffmpeg.wasm only as fallback for unsupported codecs |
| Captions | transformers.js Whisper tiny or base, P2 | Runs offline; swap for provider transcription if available |
| PDF | pdf-lib | LinkedIn document carousels and proof sheets |
| Persistence | File System Access API with `idb-keyval` for the directory handle; IndexedDB for asset blobs and keys | Session survives reloads; folder handle persists with permission re-prompt |
| Export | Streams to the session's `exports/` folder; JSZip fallback for download | |
| Tests | Vitest for lib and validator; Playwright for the board flow | Validator must have 100% rule coverage |

Workers: one for image jobs, one for video jobs, one for transcription. Each exposes a typed job queue with progress events so the board can show per-card progress bars.

Undo: every store mutation pushes a snapshot of the affected card; Cmd/Ctrl-Z pops it. Fifty levels is enough.

## Data model and session file format

A session is a folder on disk. `session.json` holds everything except binary assets, which live beside it so the folder can be zipped, moved, or committed.

```
MySession/
  session.json
  brand.json
  assets/           original uploads, named by content hash
  renders/          cached outputs per card, regenerated if missing
  exports/          final deliverables by platform
    instagram/
    linkedin/
    captions.csv
```

Core types in `src/types.ts`:

```typescript
type Session = {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  brief: Brief;
  assets: Asset[];
  cards: Card[];
  groups: Group[];
};

type Brief = { topic: string; audience: string; cta: string; link?: string; tone: 'formal' | 'neutral' | 'casual' };

type Asset = {
  id: string;              // sha256 of the file
  kind: 'image' | 'video';
  fileName: string;
  width: number; height: number;
  durationMs?: number;
  focal: { x: number; y: number };   // 0..1, drives all crops except for cards with their own focal point
  description?: string;    // AI image description, cached
};

type Card = {
  id: string;
  assetIds: string[];      // one for a post, many for a carousel or collage
  platform: 'instagram' | 'linkedin' | 'facebook' | 'x';
  placement: string;       // key into platforms.json
  parentId?: string;       // set when duplicated; gives lineage
  focal?: { x: number; y: number };   // 0..1; the card's own focal point, set when duplicated; without it the card uses its asset's
  version: number;
  status: 'draft' | 'review' | 'approved';
  edit: ImageEdit | VideoEdit | CarouselEdit;
  copy: { caption: string; firstComment: string; hashtags: string[]; altText: string; authoredBy?: Provenance };
  validation: { level: 'pass' | 'warn' | 'fail'; issues: Issue[] };
  overrideFail: boolean;
  comments: Comment[];
  plannedDate?: string;
};

type ImageEdit = { crop: Rect; overlays: Overlay[]; logo?: LogoPlacement; format: 'jpg' | 'png'; quality: number };
type VideoEdit = { inMs: number; outMs: number; crop: Rect; overlays: Overlay[]; coverMs: number; captions?: Caption[]; audio: 'keep' | 'mute' | 'replace' };
type CarouselEdit = { slides: { assetId: string; edit: ImageEdit }[]; coverIndex: number };
type Provenance = { provider: string; model: string; at: string };
```

Rules: asset files are immutable once imported; only the focal point can be changed afterwards, and every other change happens on a card. Duplicating a card copies `edit` and `copy`, gives the copy its own `focal` (the source card's focal point at that moment), sets `parentId`, and increments `version`. Compare view loads two to four cards and diffs `copy.caption` word by word while showing renders side by side. Clear session deletes nothing on disk until the user confirms, then empties the store and releases the folder handle.

Brand kit (`brand.json`): logos as PNG paths, fonts as uploaded files or Google Fonts names, a color palette, a voice document (plain text, under 500 words), and overlay presets. It is exportable on its own so the marketing team can share one file with the office.

## Build phases and MVP scope

The MVP is Phases 1 and 2: images only, Instagram and LinkedIn, AI copy, brand kit, board with validation, session save, export. Video is deliberately Phase 3 so the pipeline, data model, and board are solid before the hardest technical piece lands.

| Phase | Scope | Gate to pass before the next phase |
| --- | --- | --- |
| 1: Foundation | Import, data model, session save and load, image crop and resize, validator, board. Instagram + LinkedIn. | One photo becomes two valid files; session survives a browser reload |
| 2: Copy + brand | AI adapters for 3 vendors, captions, alt text, brand kit, overlays, carousel, export. MVP complete. | Marketing uses it for a real week of posts without opening Canva |
| 3: Video | Trim, reframe, cover frame, WebCodecs export, auto-captions, duplicate and compare. Reels + LinkedIn video. | A 60-second iPhone clip becomes a validated Reel in under a minute on an office laptop |
| 4: Team use | Status and comments, templates, previews, collage, repurpose, proof sheet PDF. Facebook + X. | |

Each gate is a test the user runs, not a code milestone.

Suggested order inside Phase 1, each a Claude Code task:

1. Scaffold: Vite, React, TypeScript, Tailwind, Zustand, Vitest, ESLint. Commit.
2. `platforms.json` and `validate.ts` with full unit tests. Commit.
3. Types and session store with save and load through the File System Access API; fallback download of a zip.
4. Import panel: drag-and-drop, HEIC decode, asset hashing, thumbnails.
5. Image worker: crop from focal point, resize, encode JPG and PNG.
6. Board: card grid, platform filter, validation badge, open card.
7. Editor: canvas with crop handles and focal point; text and logo overlays come in Phase 2.
8. Export: per-platform folders with naming scheme `{session}_{platform}_{placement}_{cardId}.{ext}`.

## Out of scope and open questions

Not in any phase: direct publishing to platforms, analytics, AI image or video generation, YouTube, TikTok, a shared backend or user accounts, mobile browsers, Firefox and Safari support. Any of these can be revisited once Phase 4 is in use.

Open questions to settle before or during Phase 1:

- [ ] Hosting: run from a local folder or from a static web host? A hosted URL is simplest for the team; the app still needs no server.
- [ ] Brand kit ownership: who maintains `brand.json` and the voice document for each brand or company the team serves? One brand file per company, switchable in Settings?
- [ ] AI vendor default: which provider does the team already pay for? Default to it in Settings.
- [ ] Photo release tracking: does marketing need a per-asset "release on file" flag for images with identifiable people? Cheap to add in Phase 1 if yes.
- [ ] Font licensing: are the brand fonts licensed for embedding in exported images? If not, fall back to Google Fonts equivalents.
- [ ] Session location: default to a `Social Content Studio` folder in Documents, or ask every time?
- [ ] Key storage on shared computers: API keys are kept in browser IndexedDB. Confirm this is acceptable where several people share one computer, or require a key per user login.

## Kickoff prompt for Claude Code

Open Claude Code in the repo folder containing this file and paste the prompt below. Then paste Claude Code's plan back into chat for review before approving it.

```
Read SPEC.md in full before doing anything. It is the product spec for Social Content Studio, a browser-only React app.

Your first job is Phase 1, step 1 only: scaffold the project.

- Vite + React 18 + TypeScript (strict), Tailwind CSS, Zustand with Immer, Vitest, ESLint with typescript-eslint, Prettier.
- Folder layout: src/app (routes and layout), src/board, src/editor, src/export, src/settings, src/lib (image, video, validate), src/ai (provider interface and adapters), src/workers, src/data (platforms.json, brand defaults), src/types.ts.
- Add a CLAUDE.md at the root that summarizes the stack decisions and the rule that platform specs live in src/data/platforms.json, never in code.
- Add a .gitignore that excludes node_modules, dist, and .env files.
- Create src/data/platforms.json from the table in SPEC.md, with a verified date on each entry.
- Write src/lib/validate.ts implementing the nine validation rules, with a Vitest test for every rule, pass and fail cases.
- Do not build any UI beyond an empty App shell that renders the text Social Content Studio.
- Commit when tests pass.

Before writing code, print your plan as a numbered list and stop. Wait for me to approve it. After each step, run the tests and show me the output, then stop and wait.
```

Review loop: paste Claude Code's plan or output into chat. Keep each Claude Code task to one feature row from the table so review stays short.
