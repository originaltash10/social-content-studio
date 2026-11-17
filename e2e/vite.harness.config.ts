/**
 * Builds the development-only worker check page the way the site is built, so the bundled
 * worker can be tried in a real browser. The output goes to a scratch folder, never to dist.
 * The site's own build (vite.config.ts) does not include this page.
 */
import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import siteConfig from '../vite.config';

const root = resolve(import.meta.dirname, '..');

export default mergeConfig(
  siteConfig,
  defineConfig({
    root,
    build: {
      outDir: process.env.HARNESS_OUT ?? resolve(root, 'node_modules/.tmp/worker-check-dist'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(root, 'e2e/worker-check/index.html') },
    },
  }),
);
