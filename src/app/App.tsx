import { useState } from 'react';
import { Board } from '../board/Board';
import { Settings } from '../settings/SettingsDialog';
import { ExportPanel } from '../export/ExportPanel';
import { BriefPanel } from './BriefPanel';
import { ImportPanel } from './ImportPanel';
import { SessionPanel } from './SessionPanel';

export function App() {
  // Export waits while the board is still making its previews.
  const [boardBusy, setBoardBusy] = useState(false);
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6 text-ink">
      {/* Settings is the page's first control, with or without a session (SPEC.md, "AI"). */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-heading text-2xl font-semibold">Social Content Studio</h1>
        <Settings />
      </header>
      <SessionPanel />
      <ImportPanel />
      <BriefPanel />
      <Board onBusyChange={setBoardBusy} />
      <ExportPanel busy={boardBusy} />
    </main>
  );
}
