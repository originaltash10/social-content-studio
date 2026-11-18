/**
 * What the export panel says, in plain words: the summary before an export, the progress line,
 * and the results after it. Pure: the panel passes in what it knows.
 */

import type { Readiness } from './eligibility';
import type { ExportReport, SkippedCard } from './runExport';

/** How the files are delivered. */
export type ExportMode = 'folder' | 'zip';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The summary shown before exporting. It covers every card, whatever the board's filters show. */
export function exportSummary({ total, ready, failing }: Readiness): string {
  if (total === 0) return 'There are no cards in this session to export yet.';
  const all = total === 1 ? 'The 1 card in this session' : `All ${total} cards in this session`;
  if (failing === 0) return `${all} can be exported.`;
  if (ready === 0) {
    return total === 1
      ? `${all} fails its checks, so it cannot be exported.`
      : `${all} fail their checks, so none can be exported.`;
  }
  return `${all}: ${ready} can be exported, ${count(failing, 'fails its checks', 'fail their checks')}.`;
}

export const FILTERS_NOTE =
  "Export includes every card in the session, whatever the board's filters show. Cards with a " +
  'warning are exported; a card that fails its checks is left out unless you tick its override.';

export const BOARD_BUSY_HINT =
  'Export will be available when the board has finished making its previews.';

export const NO_FOLDER_HINT = 'Save the session to a folder first, or download a zip.';

export const EARLIER_FILES_NOTE =
  'Files from earlier exports are never deleted, so older files may still be in the exports ' +
  'folder.';

/**
 * The progress line, e.g. "Exporting 2 of 5: Instagram Feed vertical for site.jpg, v1". Without
 * a card, the export is starting (nothing done yet) or finishing.
 */
export function progressText(done: number, total: number, name: string | null): string {
  if (name === null) return done === 0 ? 'Starting the export' : 'Finishing the export';
  return `Exporting ${Math.min(done + 1, total)} of ${total}: ${name}`;
}

export function permissionRefusedText(folderName: string): string {
  return `Permission to write to folder "${folderName}" was not granted. Nothing was exported.`;
}

export type ExportResults = {
  /** The first line: what happened. */
  headline: string;
  /** Further notes, each a sentence or two. */
  notes: string[];
  /** One line per card that was left out, with the reason. */
  skipped: string[];
};

export type ResultsInput = {
  report: ExportReport;
  mode: ExportMode;
  /** The session folder's name (folder mode). */
  folderName: string;
  /** The zip's download name (zip mode). */
  zipName: string;
  /** A card's name as the board shows it, e.g. "Instagram Feed vertical for site.jpg, v1". */
  nameOf: (cardId: string) => string;
};

function skippedLine(skipped: SkippedCard, nameOf: (cardId: string) => string): string {
  const reason =
    skipped.reason === 'fails-checks' ? `fails its checks. ${skipped.message}` : skipped.message;
  return `${nameOf(skipped.cardId)}: ${reason}`;
}

/** The results after an export: what happened, notes, and every card left out. */
export function exportResults({
  report,
  mode,
  folderName,
  zipName,
  nameOf,
}: ResultsInput): ExportResults {
  const written = report.exported.length;
  const files = count(written, 'file', 'files');
  const one = written === 1;
  /** "1 file stays" / "2 files stay", and "lists it" / "lists them". */
  const stay = one ? 'stays' : 'stay';
  const them = one ? 'it' : 'them';
  const notes: string[] = [];
  let headline: string;

  switch (report.outcome) {
    case 'complete':
      if (written === 0) headline = 'No files were exported.';
      else if (mode === 'folder') {
        headline = `Exported ${files} and captions.csv to the exports folder in folder "${folderName}".`;
      } else headline = `Downloaded "${zipName}" with ${files} and captions.csv.`;
      break;
    case 'cancelled':
      headline =
        mode === 'zip'
          ? 'Export cancelled. Nothing was downloaded.'
          : written === 0
            ? 'Export cancelled. Nothing was written.'
            : `Export cancelled. ${files} ${one ? 'was' : 'were'} written before it stopped, and captions.csv lists ${them}.`;
      break;
    case 'write-error':
      headline = report.error as string;
      if (mode === 'zip') notes.push('Nothing was downloaded.');
      else if (written > 0) {
        notes.push(
          report.finished
            ? `The ${files} written before it stopped ${stay} in the folder, and captions.csv lists ${them}.`
            : `The ${files} written before it stopped ${stay} in the folder.`,
        );
      }
      break;
    case 'session-closed':
      headline =
        mode === 'folder' && written > 0
          ? `Export stopped because the session was closed. The ${files} already written ${stay} in the folder.`
          : 'Export stopped because the session was closed.';
      break;
    case 'failed':
      headline = report.error as string;
      break;
  }

  const overrides = report.exported.filter((file) => file.result === 'override').length;
  if (overrides > 0) {
    notes.push(
      `${count(overrides, 'file was', 'files were')} exported with an override, even though ` +
        `${overrides === 1 ? 'it fails its checks' : 'they fail their checks'}.`,
    );
  }
  if (mode === 'folder' && written > 0) notes.push(EARLIER_FILES_NOTE);

  return { headline, notes, skipped: report.skipped.map((s) => skippedLine(s, nameOf)) };
}
