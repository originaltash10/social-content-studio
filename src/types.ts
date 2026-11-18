/**
 * Core data model. The session types are transcribed from SPEC.md
 * ("Data model and session file format"). Types the spec references but does not define
 * (Rect, Overlay, LogoPlacement, Issue, Comment, Group, Caption) have provisional shapes here,
 * marked PROVISIONAL, and will be settled when the session store and editor are built.
 */

// ---------------------------------------------------------------------------
// Session model (from SPEC.md)
// ---------------------------------------------------------------------------

export type Platform = 'instagram' | 'linkedin' | 'facebook' | 'x';

export type Session = {
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

export type Brief = {
  topic: string;
  audience: string;
  cta: string;
  link?: string;
  tone: 'formal' | 'neutral' | 'casual';
};

export type Asset = {
  id: string; // sha256 of the file
  kind: 'image' | 'video';
  fileName: string;
  width: number;
  height: number;
  durationMs?: number;
  focal: { x: number; y: number }; // 0..1, drives all crops
  description?: string; // AI image description, cached
};

export type Card = {
  id: string;
  assetIds: string[]; // one for a post, many for a carousel or collage
  platform: Platform;
  placement: string; // key into platforms.json (PlacementSpec.placement)
  parentId?: string; // set when duplicated; gives lineage
  /** 0..1. The card's own focal point, set when duplicated. Without it the card uses its photo's. */
  focal?: { x: number; y: number };
  version: number;
  status: 'draft' | 'review' | 'approved';
  edit: ImageEdit | VideoEdit | CarouselEdit;
  copy: {
    caption: string;
    firstComment: string;
    hashtags: string[];
    altText: string;
    authoredBy?: Provenance;
  };
  validation: ValidationResult;
  overrideFail: boolean;
  comments: Comment[];
  plannedDate?: string;
};

export type ImageEdit = {
  crop: Rect;
  overlays: Overlay[];
  logo?: LogoPlacement;
  format: 'jpg' | 'png';
  quality: number;
};

export type VideoEdit = {
  inMs: number;
  outMs: number;
  crop: Rect;
  overlays: Overlay[];
  coverMs: number;
  captions?: Caption[];
  audio: 'keep' | 'mute' | 'replace';
};

export type CarouselEdit = { slides: { assetId: string; edit: ImageEdit }[]; coverIndex: number };

export type Provenance = { provider: string; model: string; at: string };

// ---------------------------------------------------------------------------
// Supporting types the spec references but does not define
// ---------------------------------------------------------------------------

/**
 * PROVISIONAL. A rectangle in fractions (0..1) of the frame it belongs to: the source asset
 * for a crop, the output frame for overlays and logos.
 */
export type Rect = { x: number; y: number; width: number; height: number };

/** PROVISIONAL. Text overlays arrive in Phase 2; only the box matters to validation. */
export type Overlay = { id: string; kind: 'text'; rect: Rect; text: string };

/** PROVISIONAL. Logo or watermark placement on the output frame. */
export type LogoPlacement = { logoId: string; rect: Rect; opacity: number };

/** PROVISIONAL. Board grouping by source asset or campaign. */
export type Group = { id: string; name: string; cardIds: string[] };

/** PROVISIONAL. Lightweight per-card comment (P2). */
export type Comment = { id: string; author: string; at: string; text: string };

/** PROVISIONAL. A timed caption segment; settled when transcription lands (P2). */
export type Caption = { startMs: number; endMs: number; text: string };

export type ValidationLevel = 'pass' | 'warn' | 'fail';

/** One finding from the validator. `rule` is the rule number (1–9) in SPEC.md. */
export type Issue = {
  rule: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  level: Exclude<ValidationLevel, 'pass'>;
  message: string;
};

export type ValidationResult = { level: ValidationLevel; issues: Issue[] };

// ---------------------------------------------------------------------------
// Brand kit (shape of brand.json in the session folder)
// ---------------------------------------------------------------------------

/**
 * PROVISIONAL. SPEC.md describes the brand kit in prose only: "logos as PNG paths, fonts as
 * uploaded files or Google Fonts names, a color palette, a voice document (plain text, under
 * 500 words), and overlay presets." The five fields below are the five things that sentence
 * lists; their names and exact shapes are inferred and will be settled with the brand kit
 * feature (Phase 2). Nothing else belongs here, and in particular no API keys.
 */
export type BrandKit = {
  /** Paths to PNG logo files. INFERRED: a plain list; where the files live is not yet decided. */
  logos: string[];
  fonts: BrandFont[];
  /** The color palette. INFERRED: CSS hex strings such as "#0a2540". */
  colors: string[];
  /** The voice document, plain text. The spec's 500-word limit is not enforced yet. */
  voice: string;
  overlayPresets: OverlayPreset[];
};

/** PROVISIONAL. "fonts as uploaded files or Google Fonts names"; the tagged shape is inferred. */
export type BrandFont = { source: 'file'; path: string } | { source: 'google'; name: string };

/**
 * PROVISIONAL and INFERRED. The spec names "overlay presets" without a shape. These fields come
 * from the text overlay feature row: "brand fonts, colors, alignment, shadow".
 */
export type OverlayPreset = {
  id: string;
  name: string;
  font: string;
  color: string;
  align: 'left' | 'center' | 'right';
  shadow: boolean;
};

// ---------------------------------------------------------------------------
// Platform data (shape of src/data/platforms.json)
// ---------------------------------------------------------------------------

export type MediaType = 'image' | 'video' | 'image-set' | 'pdf';

export type Size = { width: number; height: number };

/** Where a caption gets cut off behind "...more", e.g. LinkedIn desktop at 210 chars. */
export type TruncationPoint = { context: string; chars: number };

/**
 * Story / Reel unsafe zones.
 * - `centered-area`: a safe area of the given pixel size centered in the frame.
 * - `insets`: fractions (0..1) of the frame to keep clear on each edge.
 */
export type SafeZone =
  | { kind: 'centered-area'; width: number; height: number }
  | { kind: 'insets'; top: number; bottom: number; left: number; right: number };

export type Range = { min: number | null; max: number | null };

export type PlacementSpec = {
  platform: Platform;
  placement: string;
  label: string;
  mediaTypes: MediaType[];
  sizes: Size[];
  /** Ratios as "w:h" strings, e.g. "4:5", "1.91:1". */
  ratios: string[];
  captionCap: number | null;
  truncation: TruncationPoint[];
  hashtagCap: number | null;
  slides: (Range & { sameRatio: boolean }) | null;
  durationSec: Range | null;
  recommendedFps: number | null;
  maxFileBytes: number | null;
  maxImages: number | null;
  /** False where links in a caption are not clickable (Instagram); validation rule 9 warns. */
  captionLinksClickable: boolean;
  /**
   * True where the hashtag block is posted inside the caption, so it counts toward the caption
   * cap (rule 4). False where hashtags go in the first comment (Instagram).
   */
  hashtagsInCaption: boolean;
  safeZone: SafeZone | null;
  /** ISO dates each group of values was last checked against its source. */
  verified: { sizes: string; limits: string };
  /** Keys into PlatformsFile.sources. */
  sources: { sizes: string; limits: string };
  /** Interpretations made when transcribing the spec table. */
  assumptions: string[];
  /** Platform facts that are informational and not checked by the validator. */
  notes: string[];
};

export type SourceInfo = { title: string; url: string | null; note: string };

export type PlatformsFile = {
  version: 1;
  sources: Record<string, SourceInfo>;
  placements: PlacementSpec[];
};
