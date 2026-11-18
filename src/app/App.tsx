import { useState } from 'react';
import { Board } from '../board/Board';
import { ExportPanel } from '../export/ExportPanel';
import { ImportPanel } from './ImportPanel';
import { SessionPanel } from './SessionPanel';

export function App() {
  // Export waits while the board is still making its previews.
  const [boardBusy, setBoardBusy] = useState(false);
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6 text-ink">
      <h1 className="font-heading text-2xl font-semibold">Social Content Studio</h1>
      <SessionPanel />
      <ImportPanel />
      <Board onBusyChange={setBoardBusy} />
      <ExportPanel busy={boardBusy} />
    </main>
  );
}
