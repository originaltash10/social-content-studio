/**
 * What the board shows: cards grouped by source photo, the platform and result filters, and the
 * one-line summary for screen readers.
 */

import type { Asset, Card, Platform, ValidationLevel } from '../../types';
import type { CardRender } from './controller';
import { BOARD_PLATFORMS } from './targets';

export type PlatformFilter = 'all' | Platform;
/** "unchecked" is a card whose file has not been rendered and checked yet in this visit. */
export type CardResult = ValidationLevel | 'unchecked';
export type ResultFilter = 'all' | CardResult;

export const RESULT_LABEL: Record<CardResult, string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Fail',
  unchecked: 'Not checked yet',
};

/** A symbol shown beside each result, so the badge never relies on colour alone. */
export const RESULT_ICON: Record<CardResult, string> = {
  pass: '✓',
  warn: '!',
  fail: '✕',
  unchecked: '…',
};

/** A file size in decimal units, as file browsers show it: "820 bytes", "412 KB", "1.4 MB". */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** What a finished file is, for example "1080 × 1350 JPG · 412 KB". */
export function renderedFileLabel(render: Extract<CardRender, { kind: 'done' }>): string {
  return `${render.width} × ${render.height} ${render.format.toUpperCase()} · ${fileSizeLabel(render.bytes)}`;
}

/** The alt text for a card's preview: the card's own when it has some. */
export function previewAlt(card: Pick<Card, 'copy'>, fileName: string, name: string): string {
  return card.copy.altText || `Preview of ${fileName} for ${name}`;
}

/** The note shown when a picture had to be enlarged to fill the placement. */
export function upscaledNote(width: number, height: number): string {
  return `Note: enlarged to fit. The cropped area is smaller than ${width} × ${height} pixels, so it may look soft.`;
}

/** A card's result: its validation level once its file is rendered, "unchecked" until then. */
export function resultOf(
  card: Pick<Card, 'validation'>,
  render: CardRender | undefined,
): CardResult {
  return render?.kind === 'done' ? card.validation.level : 'unchecked';
}

export type CardGroup = {
  assetId: string;
  /** The source photo; null when the card's photo is not in the session. */
  asset: Asset | null;
  cards: Card[];
};

export type Filters = { platform: PlatformFilter; result: ResultFilter };

/** True when a card passes both filters. */
export function matches(card: Card, render: CardRender | undefined, filters: Filters): boolean {
  return (
    (filters.platform === 'all' || card.platform === filters.platform) &&
    (filters.result === 'all' || resultOf(card, render) === filters.result)
  );
}

/**
 * Cards that pass the filters, grouped by source photo in import order. Cards whose photo is
 * not in the session come last, grouped by the id they point to. Empty groups are left out.
 */
export function groupCards(
  assets: readonly Asset[],
  cards: readonly Card[],
  renders: ReadonlyMap<string, CardRender>,
  filters: Filters,
): CardGroup[] {
  const groups = new Map<string, CardGroup>();
  for (const asset of assets) groups.set(asset.id, { assetId: asset.id, asset, cards: [] });
  for (const card of cards) {
    if (!matches(card, renders.get(card.id), filters)) continue;
    const assetId = card.assetIds[0] ?? '';
    const group = groups.get(assetId) ?? { assetId, asset: null, cards: [] };
    group.cards.push(card);
    groups.set(assetId, group);
  }
  return [...groups.values()].filter((group) => group.cards.length > 0);
}

/** How many cards each platform filter would show. */
export function platformCounts(cards: readonly Card[]): Record<'all' | Platform, number> {
  const counts = { all: cards.length, instagram: 0, linkedin: 0, facebook: 0, x: 0 };
  for (const card of cards) counts[card.platform] += 1;
  return counts;
}

/** The platform filter's choices: All, then each board platform. */
export const PLATFORM_FILTERS: readonly PlatformFilter[] = ['all', ...BOARD_PLATFORMS];
export const RESULT_FILTERS: readonly ResultFilter[] = ['all', 'pass', 'warn', 'fail', 'unchecked'];

/** True while a card's render is waiting or under way. */
export function isPending(render: CardRender | undefined): boolean {
  return render?.kind === 'waiting' || render?.kind === 'working';
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The board's progress line, for the live region: "Rendering 2 of 6…" while files are being
 * made, then a count of the results. Empty when there are no cards.
 */
export function renderSummary(
  cards: readonly Card[],
  renders: ReadonlyMap<string, CardRender>,
): string {
  if (cards.length === 0) return '';
  const statuses = cards.map((card) => renders.get(card.id));
  const pending = statuses.filter(isPending).length;
  if (pending > 0) {
    return `Rendering ${cards.length - pending + 1} of ${cards.length}…`;
  }
  const done = cards.filter((card) => renders.get(card.id)?.kind === 'done');
  const count = (level: ValidationLevel) =>
    done.filter((card) => card.validation.level === level).length;
  const parts = [`${count('pass')} pass`];
  if (count('warn') > 0) parts.push(`${count('warn')} with warnings`);
  if (count('fail') > 0) parts.push(`${count('fail')} fail`);
  const failed = statuses.filter((status) => status?.kind === 'failed').length;
  const cancelled = statuses.filter((status) => status?.kind === 'cancelled').length;
  if (failed > 0) parts.push(`${failed} could not be rendered`);
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);
  return `Rendered ${plural(done.length, 'card', 'cards')}: ${parts.join(', ')}.`;
}
