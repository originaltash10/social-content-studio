import { describe, expect, it } from 'vitest';
import { lineageLabel, versionDescription, versionInfo, versionLabel } from './versions';

const card = (id: string, version: number, parentId?: string) =>
  parentId === undefined ? { id, version } : { id, version, parentId };

describe('versionInfo', () => {
  it('gives an original card its version, with no copies', () => {
    const info = versionInfo([card('a', 1)]).get('a');
    expect(info).toEqual({
      version: 1,
      copyIndex: 1,
      copyCount: 1,
      isCopy: false,
      parentVersion: null,
    });
  });

  it('numbers copies of one card that share a version in board order', () => {
    const cards = [card('a', 1), card('b', 2, 'a'), card('c', 2, 'a')];
    const info = versionInfo(cards);
    expect(info.get('b')).toEqual({
      version: 2,
      copyIndex: 1,
      copyCount: 2,
      isCopy: true,
      parentVersion: 1,
    });
    expect(info.get('c')).toEqual({
      version: 2,
      copyIndex: 2,
      copyCount: 2,
      isCopy: true,
      parentVersion: 1,
    });
  });

  it('does not count copies of other cards, or originals, as siblings', () => {
    const cards = [
      card('a', 1),
      card('x', 1),
      card('b', 2, 'a'),
      card('y', 2, 'x'),
      card('d', 3, 'b'),
    ];
    const info = versionInfo(cards);
    expect(info.get('a')?.copyCount).toBe(1);
    expect(info.get('x')?.copyCount).toBe(1);
    expect(info.get('b')?.copyCount).toBe(1);
    expect(info.get('y')?.copyCount).toBe(1);
    expect(info.get('d')).toMatchObject({ version: 3, copyCount: 1, parentVersion: 2 });
  });

  it('knows when the card a copy came from is gone', () => {
    expect(versionInfo([card('b', 2, 'gone')]).get('b')?.parentVersion).toBeNull();
  });
});

describe('labels', () => {
  const [original, first, second, lone, orphan] = [
    { version: 1, copyIndex: 1, copyCount: 1, isCopy: false, parentVersion: null },
    { version: 2, copyIndex: 1, copyCount: 2, isCopy: true, parentVersion: 1 },
    { version: 2, copyIndex: 2, copyCount: 2, isCopy: true, parentVersion: 1 },
    { version: 3, copyIndex: 1, copyCount: 1, isCopy: true, parentVersion: 2 },
    { version: 2, copyIndex: 1, copyCount: 1, isCopy: true, parentVersion: null },
  ] as const;

  it('badge', () => {
    expect(versionLabel(original)).toBe('v1');
    expect(versionLabel(first)).toBe('v2 · 1 of 2');
    expect(versionLabel(second)).toBe('v2 · 2 of 2');
    expect(versionLabel(lone)).toBe('v3');
  });

  it('lineage', () => {
    expect(lineageLabel(original)).toBeNull();
    expect(lineageLabel(first)).toBe('Copy of v1');
    expect(lineageLabel(orphan)).toBe('Copy of a card that is no longer here');
  });

  it('full sentence', () => {
    expect(versionDescription(original)).toBe('Version 1.');
    expect(versionDescription(second)).toBe('Version 2, copy 2 of 2 made from version 1.');
    expect(versionDescription(lone)).toBe('Version 3, a copy of version 2.');
    expect(versionDescription(orphan)).toBe('Version 2, a copy of a card that is no longer here.');
  });
});
