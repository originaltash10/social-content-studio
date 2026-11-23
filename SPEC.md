# Social Content Studio — Product Spec

As of November 23, 2026

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
| Images | Fit whole photo: show the whole photo in the placement's shape, with padding | P1 | New cards still fill the frame; padding appears only when the user chooses it |
| Images | Background colour per card, filling any space where the crop goes past the photo's edges | P1 | White unless the user picks another colour |
| Images | Text overlay with brand fonts, colors, alignment, shadow, safe-zone snapping | P1 | |
| Images | Logo placement with opacity | P1 | One logo per card; no separate watermark in the MVP |
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
| Board | Compare two to four cards side by side with caption diff | P2 | Phase 3 |
| Board | Status field (Draft, Review, Approved) and comments per card | P2 | Keep it light; no permissions system |
| Board | Calendar view with a planned date per card | P3 | |
| Brand | Brand kit: logos, fonts, colors, voice document, overlay presets | P1 | Stored in the session; exported and imported as one bundle |
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
| Instagram | Story | 1080 x 1920 | 9:16 | image or video | n/a | Safe area 1080 x 1610 centered; video up to 60 s per Story. Shown in the app as "Reel / Story" (key `story`) |
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
7. Any text overlay, logo, or focal point inside a Story or Reel unsafe zone; warn. The focal point is always inside the photo, so this rule is the same for a crop with padding.
   The Instagram placement shown as "Reel / Story" (key `story`) warns inside either the Story or the Reel unsafe zone, whichever is larger on each edge. With the current figures that is the Reel's on every edge, so its entry in `platforms.json` uses the Reel insets.
   Text overlay and logo boxes are stored as fractions of the finished frame (the output picture), and this rule compares them with the safe zone in that same space.
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
| altText | a reduced copy of the card's finished picture, metadata removed | one or two sentences | Describes content, not mood; no "image of" prefix. The original file is never sent |
| rewriteTone | text, target tone | text | LinkedIn formal, Instagram conversational, X terse |
| describeImage | image | structured description | Used to ground captions; cached per source asset |
| repurpose | pasted text or URL content | post set per platform | P2 |
| transcribe | audio track | timed captions | P2; Whisper via transformers.js when no provider supports audio |

Key handling: the user pastes a key in Settings. It is stored in the browser's IndexedDB for this app only, never written into a session file, an export or a log, and sent only to that provider's API endpoint. Settings shows a "Test connection" button, a visible "Remove key" button and a per-provider usage counter. There is no default provider; the user chooses one in Settings. Whether each provider allows calls straight from a web page with the user's own key is confirmed before its adapter is built. When this spec was first written, the understanding was that browser calls to the Anthropic API need the `anthropic-dangerous-direct-browser-access` header and that Gemini and OpenAI accept browser calls with a key directly; both are to be confirmed.

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
| Canvas | Plain elements with pointer events for the crop, the focal point and the overlays. Overlays are drawn by our own code, with no Fabric.js and no Konva: one drawing function in `src/lib/render` is used for the export and for the editor preview | Preview and export cannot drift apart when they are the same drawing, and it runs in the image worker. See "Phase 2 decisions" |
| Image processing | OffscreenCanvas in a Web Worker, `createImageBitmap` | Keeps the UI responsive during batch resize |
| HEIC decode | `heic-to` or `libheif-js` | iPhone photos |
| Video | WebCodecs via `mediabunny` (demux, decode, encode, mux MP4) | Hardware-accelerated; ffmpeg.wasm only as fallback for unsupported codecs |
| Captions | transformers.js Whisper tiny or base, P2 | Runs offline; swap for provider transcription if available |
| PDF | pdf-lib | LinkedIn document carousels and proof sheets |
| Persistence | File System Access API with `idb-keyval` for the directory handle; IndexedDB for asset blobs and keys | Session survives reloads; folder handle persists with permission re-prompt |
| Export | Streams to the session's `exports/` folder; JSZip fallback for download | |
| Tests | Vitest for lib and validator; Playwright for the board flow | Validator must have 100% rule coverage |

Workers: one for image jobs, one for video jobs, one for transcription. Each exposes a typed job queue with progress events so the board can show per-card progress bars.

Undo: every store mutation pushes a snapshot of the affected card; Cmd/Ctrl-Z pops it. Fifty levels is enough. The campaign brief and the brand kit are not cards and are not part of undo.

## Data model and session file format

A session is a folder on disk. `session.json` holds everything except binary assets, which live beside it so the folder can be zipped, moved, or committed.

```
MySession/
  session.json
  brand.json
  assets/           original uploads, named by content hash
  brand/            logo and font files, named by content hash (Phase 2)
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
  background?: string;     // "#rrggbb", lowercase; fills any space where the crop goes past the photo's edges; without it, white
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

Rules: asset files are immutable once imported: a photo's file and its pixels never change. Two things can be set afterwards: the focal point, and a cached AI description of the photo (`description`). Every other change happens on a card. Duplicating a card copies `edit`, `copy` and `background`, gives the copy its own `focal` (the source card's focal point at that moment), sets `parentId`, and increments `version`. Compare view loads two to four cards and diffs `copy.caption` word by word while showing renders side by side. Clear session deletes nothing on disk until the user confirms, then empties the store and releases the folder handle.

Background colour: `background` is stored as `#rrggbb` in lowercase, and a card without one is white (`#ffffff`). When a session is loaded, only a valid six-digit hex colour is accepted, in any case, and it is made lowercase; anything else is dropped, so the card is treated as white. The field is in the serializer's allowlist, and undo snapshots include it. The session `version` stays 1: a session saved without the field loads and renders exactly as before.

Crop limits: a crop is stored as fractions of the photo as it is displayed, after any rotation recorded in the file, which is the space the renderer draws from. It is always locked to the placement's shape. The "fit size" is the smallest crop of the placement's shape that contains the whole photo, and the "fit frame" is the fit-size crop centred on the photo's centre. Each axis is treated separately:

- On an axis where the crop is no longer than the photo, the crop stays inside the photo.
- On an axis where the crop is longer than the photo, the crop contains the photo on that axis and stays inside the fit frame. A crop between the photo's length and the fit length can slide within the fit frame, so the padding can be uneven; at the full fit size the crop is centred.
- A crop is never larger than the fit size. The smallest crop is unchanged: half the output size, or the fill-the-frame crop when the photo is too small for that. If the smallest crop were ever larger than the fit size, the crop would be that smallest size, centred on the photo; with the current smallest crop this cannot happen.

A session file keeps a crop as four finite numbers and is not checked against these limits when it is loaded. The limits are applied wherever the crop is used, in the editor and in the renderer, where the photo's size and the placement are known. A saved crop that breaks them is shown and rendered corrected, and is written back only when the user changes the crop.

Brand kit (`brand.json`): logos as PNG files and fonts as uploaded files, both kept in the session's `brand/` folder, a color palette, a voice document (plain text, under 500 words), and overlay presets. Fonts are never fetched from a font service. The brand kit is exported and imported as one bundle, so the marketing team can share one file with the office.

## Fit whole photo and background colour

A new card's crop fills the frame: the largest crop of the placement's shape inside the photo, centred on the focal point. Padding appears only when the user chooses it, by pressing Fit whole photo or by dragging or resizing the crop past the photo's edges.

Editor:

- Fit whole photo, next to Reset crop, sets the fit-size crop, centred on the photo's centre and not on the focal point. It is one undo step. If the crop already equals that crop, within 1e-9, it does nothing and adds no undo step. The card is then no longer on its automatic crop, so moving the photo's focal point does not re-centre it.
- Reset crop returns the card to the automatic fill-the-frame crop and keeps the background colour.
- The editor shows the fit frame, or the photo alone when the photo and the placement have the same shape, so every place the crop can reach is visible. The area is the same size before, during and after a drag, whether or not the card has padding.
- Inside the crop, the space outside the photo is drawn in the card's background colour, and follows the colour picker while it is being used.
- Dragging the crop, dragging a corner, and the keyboard (arrow keys, = and -, the number pad's + and -, Shift for steps ten times as big) all follow the crop limits. A key press is one undo step.
- The focal point stays inside the photo, and its marker is kept on the photo even though the area shown is larger.

Card details shows a Background colour control for every card the editor can open, with a short note that the colour fills any space where the crop goes past the photo's edges. It has the browser's colour picker and a labelled text box showing the hex code:

- Colour picker: the editor shows each colour as it is tried. Whatever colour the picker shows when it closes is kept, however it closes: a click outside it, Enter, the picker's own controls, or the dialog losing focus. It is one undo step if it differs from the card's colour, and no undo step if it is the same. Each opening of the picker gives at most one undo step, even when the browser reports both a change and a loss of focus. Escape puts back the colour the picker opened with, so it changes nothing.
- Text box: takes six hex digits, with or without `#`, in any case. The colour is applied on Enter or when the box loses focus, as one undo step if it changed. Anything else shows a plain-language message, is not applied, and the box goes back to the card's colour when it loses focus.
- Both go through the card dialog's shared undo. Ctrl/Cmd-Z on the colour picker undoes the last change in the dialog, as on a checkbox, a radio button or a slider; in the text box it undoes typing.

The Tab order in the card dialog is: crop area, focal point, Reset crop, Fit whole photo, colour picker, hex text box, file type, quality, export override, Close. Arrow keys on the crop never change any other control.

Rendering:

- The output is the crop. The part of the crop that overlaps the photo is drawn from the photo, and only that overlapping part of the photo is read, never an area outside it. The rest is the background colour.
- The edges between the photo and the padding are rounded to whole output pixels once and used for both, so there is no seam and no gap.
- JPG: the whole picture is filled with the background colour first, so transparent parts of the photo take it. With the default white this is what a JPG has always done.
- PNG: only the padding is coloured, and the photo's own transparency is kept.
- Whether a picture counts as enlarged is worked out from the crop's size, padding included, as before.
- Board tiles, the card dialog's preview and export all show the padded result. Export renders each card again and strips metadata as before.
- A card with no background colour and a crop inside the photo renders byte for byte as it did before this feature.

## Phase 2 decisions

Decided before Phase 2 began. Where an earlier part of this spec said something else, it has been changed to match. The type listings above still show the data model as it is built today; a field a decision adds is added to them by the task that builds it.

### Overlays

- Text and logo overlays are drawn by our own code. No Fabric.js and no Konva.
- One drawing function in `src/lib/render` draws the overlays. The image worker uses it for the exported file, and the editor uses the same function for its preview.
- Line breaks are always decided at the output size. The preview is that same drawing scaled down; text is never laid out again at screen size.
- Text is typed in an ordinary text box beside the picture, not on the picture itself.
- The MVP has no rotated text and no mixed styles inside one text box.

### Where overlays and the logo sit

- Overlay and logo positions are stored as fractions of the finished frame (the output picture), not of the photo. Changing the crop never moves them.
- Rule 7 compares these boxes with the safe zones in the same space.
- They are edited in a second view in the card dialog, "Text and logo", which shows the finished frame.

### Fonts

- Inter and Inter Tight are bundled with the app. Fonts the user uploads come later, with the brand kit.
- Fonts are never fetched from Google or any other font service.
- The MVP supports Latin text only. Non-Latin scripts are out of scope.
- The image worker loads the font files itself and waits for them before it draws.

### Brand files

- Logo and font files live in a `brand/` folder in the session folder, named by content hash like photos, and are included in `.scs` bundles.
- The brand kit can be exported and imported as one bundle.
- A card has one logo. There is no separate watermark in the MVP.

### Who wrote each piece of text

- Today a card's `copy` has one optional `authoredBy`, beside `caption`, `firstComment`, `hashtags` and `altText`, so it stands for all four at once. Nothing in the app sets it yet.
- From Phase 2, `authoredBy` covers the caption, the hashtags and the first comment, which the caption task writes together.
- Alt text gets its own optional provenance field, separate from `authoredBy`. Its name is settled in the task that builds AI alt text.
- When a person's edit changes the caption, the hashtags or the first comment (compared when they leave the box), `authoredBy` is removed. If nothing changed, it stays.

### Caption boxes

- Every card shows the caption, hashtags and first comment boxes, including the Instagram "Reel / Story" placement. Reels use captions.
- On any placement that can be a Story (`canBeStory` is true in `platforms.json`), a short plain note under the boxes says: "Reels show this caption. Stories don't show captions, hashtags or a first comment." The note is neutral text, not a warning. It does not change any validation result.
- Because Reels post the caption, the Instagram "Reel / Story" placement (key `story`) uses the Instagram feed caption and hashtag limits (`captionCap`, `hashtagCap`, `hashtagsInCaption`), so rules 4 and 5 apply to it.

### Photos

- A photo may store a cached AI description of itself. This is the second exception to "asset files are immutable"; the focal point is the other. The photo's file and its pixels never change.

### Undo

- The campaign brief and the brand kit are not part of undo.
- Text boxes keep the browser's own typing undo.
- The caption, hashtags, first comment and alt text boxes each add one undo step per visit, written when the person leaves the box.

### AI

- Before every send, a panel shows exactly what will be sent, with a Send button. The MVP has no "don't show again" option.
- The image sent for alt text is a reduced copy of the card's finished picture with metadata removed, never the original file.
- There is no default provider. The user chooses one in Settings.
- Keys are kept in this browser on this computer only, never in session files, exports or logs. Settings has a visible "Remove key" button.
- Before any adapter is built, confirm that each provider allows calls straight from a web page with the user's own key.

### Carousels

- Alt text is per slide. Background colour is per carousel.
- Slide image files are named like single images, with a two-digit slide number added after the card id, starting at `_01`: `{session}_{platform}_{placement}_{cardId}_01.{ext}`.
- `captions.csv` keeps its rule of one row per file written. Each slide file gets its own row, with the carousel's caption repeated.
- A LinkedIn document carousel exports its slides as one PDF, so it is one file: it is named like a single image, with no slide number, and gets one row in `captions.csv`.

### Padding

- One-sided padding (the photo at the top of the frame, with an empty band below it for text) is planned for Phase 2, before the text editor task. It is recorded here as planned only: the "Crop limits" rules above are unchanged until the task that builds it.
- A transparent background for padded PNG exports is parked. It is not in Phase 2.

### Compare view

- The compare view stays in Phase 3.

### Phase 2 task order

1. This cleanup: the error-text colour, the CLAUDE.md fixes and these decisions.
2. Caption, hashtags and first comment boxes.
3. Alt text box.
4. Campaign brief panel.
5. AI settings with the first provider, starting with the browser-call check.
6. The other two providers.
7. AI alt text, with the "what is sent" panel.
8. AI captions with tone.
9. Shorten-to-fit and change-tone.
10. Brand kit colours and voice.
11. Brand logo and font files.
12. Overlays drawn in the preview and the export, including every style field (font, colour, alignment, shadow), with a preview-versus-export pixel check.
13. One-sided padding.
14. Text box editing.
15. Style controls.
16. Safe-zone guide and snapping.
17. Logo on a card.
18. Carousel builder.
19. Per-slide editing.
20. Carousel export: numbered images and the LinkedIn PDF.
21. README and the real-week-of-posts checklist.

### Still open

Phase 2 questions this spec does not yet answer:

- [ ] Tone: one setting for the whole session (`Brief.tone`), or one per platform ("Formal for LinkedIn, lighter for Instagram")?
- [ ] AI usage counter: where is it stored, and what does it count?
- [ ] Cover slide: what does choosing a carousel's cover slide (`coverIndex`) change?
- [ ] LinkedIn document carousel: alt text is per slide, but the PDF is one file with one row in `captions.csv`. Where does each slide's alt text go?
- [x] Placements with no caption (the Story placements): are the caption, hashtags and first comment boxes shown for them? Decided: yes, see "Caption boxes".
- [ ] Voice document: is the 500-word limit enforced, or only advised?
- [ ] Overlay presets: which settings does a preset hold?
- [ ] Carousel focal point: a card's own focal point is a single point, but a carousel has several photos. How do the two fit together?
- [ ] Brand bundle: what is the exported file called, and what is its file type?

## Build phases and MVP scope

The MVP is Phases 1 and 2: images only, Instagram and LinkedIn, AI copy, brand kit, board with validation, session save, export. Video is deliberately Phase 3 so the pipeline, data model, and board are solid before the hardest technical piece lands.

| Phase | Scope | Gate to pass before the next phase |
| --- | --- | --- |
| 1: Foundation | Import, data model, session save and load, image crop and resize, validator, board. Instagram + LinkedIn. | One photo becomes two valid files; session survives a browser reload |
| 2: Copy + brand | AI adapters for 3 vendors, captions, alt text, brand kit, overlays, carousel, export. MVP complete. | Marketing uses it for a real week of posts without opening Canva |
| 3: Video | Trim, reframe, cover frame, WebCodecs export, auto-captions, compare. Reels + LinkedIn video. | A 60-second iPhone clip becomes a validated Reel in under a minute on an office laptop |
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

- [x] Hosting: decided. The app is served from a static web host (GitHub Pages).
- [ ] Brand kit ownership: who maintains `brand.json` and the voice document for each brand or company the team serves? One brand file per company, switchable in Settings?
- [x] AI vendor default: decided. There is no default provider; the user chooses one in Settings.
- [ ] Photo release tracking: does marketing need a per-asset "release on file" flag for images with identifiable people? Cheap to add in Phase 1 if yes.
- [ ] Font licensing: are the brand fonts licensed for embedding in exported images? If not, use the bundled Inter and Inter Tight. Fonts are never fetched from a font service.
- [ ] Session location: default to a `Social Content Studio` folder in Documents, or ask every time?
- [x] Key storage on shared computers: decided. Keys are kept in this browser on this computer only, and Settings has a visible "Remove key" button.

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
