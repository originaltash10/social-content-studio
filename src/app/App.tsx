import { ImportPanel } from './ImportPanel';
import { SessionPanel } from './SessionPanel';

export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6 text-ink">
      <h1 className="font-heading text-2xl font-semibold">Social Content Studio</h1>
      <SessionPanel />
      <ImportPanel />
    </main>
  );
}
