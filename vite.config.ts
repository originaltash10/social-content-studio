/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // GitHub Pages serves the app from /<repository name>/; the deploy workflow sets BASE_PATH.
  // Unset (local dev, tests, preview) it is '/', Vite's default.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), tailwindcss()],
  // Module workers, so the image worker can load the HEIC decoder as a separate file on demand.
  worker: { format: 'es' },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'src/store/**/*.ts'],
      // src/workers/image.worker.ts is the only source file left out of coverage: it is a few
      // lines of wiring that can only run inside a real worker. Its logic is in src/lib/render.
      exclude: ['src/**/*.test.ts', 'src/workers/image.worker.ts'],
      reporter: [['text', { skipFull: false }]],
      thresholds: {
        // SPEC.md: "Validator must have 100% rule coverage."
        'src/lib/validate.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        // Session persistence and the store are held to the same bar.
        'src/lib/session/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
        // The import pipeline: file-type detection, hashing, decoding, thumbnails.
        'src/lib/image/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
        // Rendering: crop geometry, render plans and the bridge to the validator.
        'src/lib/render/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/store/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
