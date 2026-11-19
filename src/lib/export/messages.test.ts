import { describe, expect, it } from 'vitest';
import {
  BOARD_BUSY_HINT,
  EARLIER_FILES_NOTE,
  FILTERS_NOTE,
  NO_FOLDER_HINT,
  exportResults,
  exportSummary,
  permissionRefusedText,
  progressText,
} from './messages';
import type { ResultsInput } from './messages';
import type { ExportReport, ExportedFile, SkippedCard } from './runExport';

const file = (cardId: string, result: ExportedFile['result'] = 'warn'): ExportedFile => ({
  cardId,
  path: `instagram/${cardId}.jpg`,
  result,
  issues: [],
});

function report(overrides: Partial<ExportReport> = {}): ExportReport {
  return {
    outcome: 'complete',
    total: 2,
    exported: [file('a'), file('b')],
    skipped: [],
    finished: true,
    error: null,
    ...overrides,
  };
}

function results(overrides: Partial<ExportReport>, input: Partial<ResultsInput> = {}) {
  return exportResults({
    report: report(overrides),
    mode: 'folder',
    folderName: 'Topping out',
    zipName: 'Topping-out_export.zip',
    nameOf: (id) => `Card ${id}`,
    ...input,
  });
}

describe('exportSummary', () => {
  it.each([
    [{ total: 0, ready: 0, failing: 0 }, 'There are no cards in this session to export yet.'],
    [{ total: 1, ready: 1, failing: 0 }, 'The 1 card in this session can be exported.'],
    [
      { total: 1, ready: 0, failing: 1 },
      'The 1 card in this session fails its checks, so it cannot be exported.',
    ],
    [{ total: 5, ready: 5, failing: 0 }, 'All 5 cards in this session can be exported.'],
    [
      { total: 5, ready: 0, failing: 5 },
      'All 5 cards in this session fail their checks, so none can be exported.',
    ],
    [
      { total: 5, ready: 4, failing: 1 },
      'All 5 cards in this session: 4 can be exported, 1 fails its checks.',
    ],
    [
      { total: 5, ready: 3, failing: 2 },
      'All 5 cards in this session: 3 can be exported, 2 fail their checks.',
    ],
  ])('summarises %j', (readiness, text) => {
    expect(exportSummary(readiness)).toBe(text);
  });

  it('says the board filters do not matter', () => {
    expect(FILTERS_NOTE).toContain("whatever the board's filters show");
  });
});

describe('fixed texts', () => {
  it('match the agreed wording', () => {
    expect(BOARD_BUSY_HINT).toBe(
      'Export will be available when the board has finished making its previews.',
    );
    expect(NO_FOLDER_HINT).toBe('Save the session to a folder first, or download a zip.');
    expect(EARLIER_FILES_NOTE).toContain('never deleted');
    expect(permissionRefusedText('X')).toBe(
      'Permission to write to folder "X" was not granted. Nothing was exported.',
    );
  });
});

describe('progressText', () => {
  it('names the card being exported, counting from 1', () => {
    expect(progressText(1, 5, 'Card b')).toBe('Exporting 2 of 5: Card b');
  });

  it('never counts past the total', () => {
    expect(progressText(5, 5, 'Card e')).toBe('Exporting 5 of 5: Card e');
  });

  it('says when the export is starting or finishing', () => {
    expect(progressText(0, 5, null)).toBe('Starting the export');
    expect(progressText(5, 5, null)).toBe('Finishing the export');
  });
});

describe('exportResults', () => {
  it('reports a folder export, with the note about earlier files', () => {
    expect(results({})).toEqual({
      headline: 'Exported 2 files and captions.csv to the exports folder in folder "Topping out".',
      notes: [EARLIER_FILES_NOTE],
      skipped: [],
    });
  });

  it('reports a zip download, without the folder note', () => {
    expect(results({ exported: [file('a')] }, { mode: 'zip' })).toEqual({
      headline: 'Downloaded "Topping-out_export.zip" with 1 file and captions.csv.',
      notes: [],
      skipped: [],
    });
  });

  it('says when nothing was exported', () => {
    expect(results({ exported: [], finished: false })).toEqual({
      headline: 'No files were exported.',
      notes: [],
      skipped: [],
    });
  });

  it('lists every card left out, with its reason', () => {
    const skipped: SkippedCard[] = [
      { cardId: 'c', reason: 'fails-checks', message: 'The image is too small.' },
      { cardId: 'd', reason: 'changed', message: 'It changed.' },
      { cardId: 'e', reason: 'cannot-export', message: 'The photo is missing.' },
    ];
    expect(results({ skipped }).skipped).toEqual([
      'Card c: fails its checks. The image is too small.',
      'Card d: It changed.',
      'Card e: The photo is missing.',
    ]);
  });

  it('notes files exported with an override', () => {
    expect(results({ exported: [file('a', 'override')] }).notes).toEqual([
      '1 file was exported with an override, even though it fails its checks.',
      EARLIER_FILES_NOTE,
    ]);
    expect(
      results({ exported: [file('a', 'override'), file('b', 'override')] }, { mode: 'zip' }).notes,
    ).toEqual(['2 files were exported with an override, even though they fail their checks.']);
  });

  describe('a cancelled export', () => {
    it('in a folder says what was written and that captions.csv lists it', () => {
      expect(results({ outcome: 'cancelled', exported: [file('a')] }).headline).toBe(
        'Export cancelled. 1 file was written before it stopped, and captions.csv lists it.',
      );
      expect(results({ outcome: 'cancelled' }).headline).toBe(
        'Export cancelled. 2 files were written before it stopped, and captions.csv lists them.',
      );
    });

    it('in a folder with nothing written says so', () => {
      expect(results({ outcome: 'cancelled', exported: [], finished: false })).toEqual({
        headline: 'Export cancelled. Nothing was written.',
        notes: [],
        skipped: [],
      });
    });

    it('as a zip says nothing was downloaded', () => {
      expect(results({ outcome: 'cancelled', finished: false }, { mode: 'zip' }).headline).toBe(
        'Export cancelled. Nothing was downloaded.',
      );
    });
  });

  describe('a write error', () => {
    const error = 'Could not write "linkedin/b.jpg": There is not enough space on the disk.';

    it('in a folder gives the reason and what stays, listed in captions.csv', () => {
      expect(results({ outcome: 'write-error', error, exported: [file('a')] })).toEqual({
        headline: error,
        notes: [
          'The 1 file written before it stopped stays in the folder, and captions.csv lists it.',
          EARLIER_FILES_NOTE,
        ],
        skipped: [],
      });
    });

    it('in a folder whose captions.csv also failed does not claim it lists them', () => {
      expect(
        results({
          outcome: 'write-error',
          error,
          exported: [file('a'), file('b')],
          finished: false,
        }).notes[0],
      ).toBe('The 2 files written before it stopped stay in the folder.');
    });

    it('in a folder before any file was written gives only the reason', () => {
      expect(results({ outcome: 'write-error', error, exported: [], finished: false })).toEqual({
        headline: error,
        notes: [],
        skipped: [],
      });
    });

    it('as a zip says nothing was downloaded', () => {
      expect(results({ outcome: 'write-error', error, finished: false }, { mode: 'zip' })).toEqual({
        headline: error,
        notes: ['Nothing was downloaded.'],
        skipped: [],
      });
    });
  });

  describe('a session that closed', () => {
    it('in a folder says the files already written stay', () => {
      expect(
        results({ outcome: 'session-closed', exported: [file('a')], finished: false }).headline,
      ).toBe(
        'Export stopped because the session was closed. The 1 file already written stays in the folder.',
      );
    });

    it('with nothing written, or as a zip, just says it stopped', () => {
      const stopped = 'Export stopped because the session was closed.';
      const closed = { outcome: 'session-closed', finished: false } as const;
      expect(results({ ...closed, exported: [] }).headline).toBe(stopped);
      expect(results(closed, { mode: 'zip' }).headline).toBe(stopped);
    });
  });

  it('passes on why an export could not start', () => {
    expect(
      results({ outcome: 'failed', error: 'Two cards would both be saved as "x".', exported: [] }),
    ).toEqual({ headline: 'Two cards would both be saved as "x".', notes: [], skipped: [] });
  });
});
