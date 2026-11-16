/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // GitHub Pages serves the app from /<repository name>/; the deploy workflow sets BASE_PATH.
  // Unset (local dev, tests, preview) it is '/', Vite's default.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), tailwindcss()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'src/store/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: [['text', { skipFull: false }]],
      thresholds: {
        // SPEC.md: "Validator must have 100% rule coverage."
        'src/lib/validate.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        // Session persistence and the store are held to the same bar.
        'src/lib/session/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/store/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
