import { describe, expect, it } from 'vitest';
import {
  CAPTION_COLUMNS,
  CSV_MIME,
  captionsCsv,
  hashtagCell,
  quote,
  resultCell,
} from './captionsCsv';
import type { CaptionRow } from './captionsCsv';

type RowCard = CaptionRow['card'];

type CardOverrides = Partial<Omit<RowCard, 'copy'>> & { copy?: Partial<RowCard['copy']> };

function card(overrides: CardOverrides = {}): RowCard {
  const { copy, ...rest } = overrides;
  return {
    platform: 'instagram',
    placement: 'feed-vertical',
    ...rest,
    copy: { caption: '', firstComment: '', hashtags: [], altText: '', ...copy },
  };
}

/** A strict RFC 4180 reader for checking the output: every field must be quoted. */
function parse(csv: string): string[][] {
  expect(csv.startsWith('\uFEFF')).toBe(true);
  const rows: string[][] = [];
  let index = 1;
  while (index < csv.length) {
    const row: string[] = [];
    for (;;) {
      expect(csv[index]).toBe('"');
      let field = '';
      index += 1;
      for (;;) {
        const at = csv.indexOf('"', index);
        expect(at).toBeGreaterThan(-1);
        field += csv.slice(index, at);
        if (csv[at + 1] === '"') {
          field += '"';
          index = at + 2;
        } else {
          index = at + 1;
          break;
        }
      }
      row.push(field);
      if (csv[index] === ',') {
        index += 1;
        continue;
      }
      expect(csv.slice(index, index + 2)).toBe('\r\n');
      index += 2;
      break;
    }
    rows.push(row);
  }
  return rows;
}

describe('captionsCsv', () => {
  it('starts with a UTF-8 byte order mark and the header row', () => {
    const csv = captionsCsv([]);
    expect(Array.from(new TextEncoder().encode(csv).subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv).toBe(
      '\uFEFF"file","platform","placement","caption","hashtags","first_comment","alt_text","result"\r\n',
    );
    expect(parse(csv)).toEqual([[...CAPTION_COLUMNS]]);
  });

  it('writes one row per file, in the order given, with every column from the card', () => {
    const rows: CaptionRow[] = [
      {
        path: 'instagram/a.jpg',
        card: card({
          copy: {
            caption: 'Topped out today.',
            hashtags: ['build', '#crane'],
            firstComment: 'More soon',
            altText: 'A crane lifts the last beam.',
          },
        }),
        result: 'warn',
      },
      {
        path: 'linkedin/b.png',
        card: card({ platform: 'linkedin', placement: 'image-square' }),
        result: 'pass',
      },
    ];
    expect(parse(captionsCsv(rows)).slice(1)).toEqual([
      [
        'instagram/a.jpg',
        'instagram',
        'feed-vertical',
        'Topped out today.',
        '#build #crane',
        'More soon',
        'A crane lifts the last beam.',
        'Warning',
      ],
      ['linkedin/b.png', 'linkedin', 'image-square', '', '', '', '', 'Pass'],
    ]);
  });

  it('writes text exactly as it is on the card, whatever it contains', () => {
    const tricky = [
      'He said "hello", then left.',
      'Line one\nLine two\r\nLine three',
      '=SUM(A1:A2)',
      '+1 for safety',
      '-20% waste',
      '@site_team',
      'Café 🎉 日本語, done',
      '  leading and trailing spaces  ',
      '\t',
    ];
    for (const text of tricky) {
      const rows = parse(
        captionsCsv([
          {
            path: 'instagram/a.jpg',
            card: card({ copy: { caption: text, firstComment: text, altText: text } }),
            result: 'pass',
          },
        ]),
      );
      const [, row] = rows;
      expect(row?.[3]).toBe(text);
      expect(row?.[5]).toBe(text);
      expect(row?.[6]).toBe(text);
    }
  });

  it('is served as UTF-8 CSV', () => {
    expect(CSV_MIME).toBe('text/csv;charset=utf-8');
  });
});

describe('hashtagCell', () => {
  it('joins the tags with spaces, each with one leading "#"', () => {
    expect(hashtagCell(['build', '#crane', '##double'])).toBe('#build #crane ##double');
  });

  it('trims each tag and leaves out empty ones, as the posted caption does', () => {
    expect(hashtagCell([' site ', '', '  ', '#', 'é'])).toBe('#site #é');
  });

  it('is empty when there are no tags', () => {
    expect(hashtagCell([])).toBe('');
  });
});

describe('resultCell', () => {
  it.each([
    ['pass', 'Pass'],
    ['warn', 'Warning'],
    ['override', 'Fail, exported with override'],
  ] as const)('says %s as %j', (result, expected) => {
    expect(resultCell(result)).toBe(expected);
  });
});

describe('quote', () => {
  it('wraps a field in quotes and doubles the quotes inside', () => {
    expect(quote('a "b" c')).toBe('"a ""b"" c"');
    expect(quote('')).toBe('""');
  });
});
