/**
 * Version labels. SPEC.md: "Duplicating a card copies edit and copy, sets parentId, and
 * increments version." Taken literally, duplicating the same card twice makes two cards with
 * the same version number. The stored numbers are shown as they are; when copies of one card
 * share a number, a display-only "1 of 2" tells them apart, in board order.
 */

import type { Card } from '../../types';

export type VersionInfo = {
  version: number;
  /** 1-based position among copies of the same card with the same version, in board order. */
  copyIndex: number;
  /** How many copies of the same card share this version; 1 when there are no others. */
  copyCount: number;
  /** True for a duplicate. */
  isCopy: boolean;
  /** The version of the card it was copied from; null if that card is not in the session. */
  parentVersion: number | null;
};

type Linked = Pick<Card, 'id' | 'version' | 'parentId'>;

export function versionInfo(cards: readonly Linked[]): Map<string, VersionInfo> {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const siblings = new Map<string, string[]>();
  for (const card of cards) {
    if (card.parentId === undefined) continue;
    const key = `${card.parentId}\u0000${card.version}`;
    siblings.set(key, [...(siblings.get(key) ?? []), card.id]);
  }
  const info = new Map<string, VersionInfo>();
  for (const card of cards) {
    const group =
      card.parentId === undefined
        ? [card.id]
        : // Every copy was put in its group by the loop above.
          (siblings.get(`${card.parentId}\u0000${card.version}`) as string[]);
    info.set(card.id, {
      version: card.version,
      copyIndex: group.indexOf(card.id) + 1,
      copyCount: group.length,
      isCopy: card.parentId !== undefined,
      parentVersion:
        card.parentId === undefined ? null : (byId.get(card.parentId)?.version ?? null),
    });
  }
  return info;
}

/** The short badge, for example "v1", or "v2 · 1 of 2" when copies share the number. */
export function versionLabel(info: VersionInfo): string {
  const base = `v${info.version}`;
  return info.copyCount > 1 ? `${base} · ${info.copyIndex} of ${info.copyCount}` : base;
}

/** Where a copy came from, for example "Copy of v1"; null for an original card. */
export function lineageLabel(info: VersionInfo): string | null {
  if (!info.isCopy) return null;
  return info.parentVersion === null
    ? 'Copy of a card that is no longer here'
    : `Copy of v${info.parentVersion}`;
}

/** The full sentence for the card details, for example "Version 2, one of 2 copies made from version 1." */
export function versionDescription(info: VersionInfo): string {
  const version = `Version ${info.version}`;
  if (!info.isCopy) return `${version}.`;
  const from =
    info.parentVersion === null ? 'a card that is no longer here' : `version ${info.parentVersion}`;
  if (info.copyCount > 1) {
    return `${version}, copy ${info.copyIndex} of ${info.copyCount} made from ${from}.`;
  }
  return `${version}, a copy of ${from}.`;
}
