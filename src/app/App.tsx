import { SessionPanel } from './SessionPanel';

export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 bg-white p-6 text-slate-900">
      <h1 className="text-2xl font-semibold">Social Content Studio</h1>
      <SessionPanel />
    </main>
  );
}
