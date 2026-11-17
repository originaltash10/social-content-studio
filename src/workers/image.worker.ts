/**
 * The image worker. This file only connects the worker's message channel to the render queue;
 * all the logic is in src/lib/render, where it is unit-tested. Because it can only run inside a
 * real worker, this is the one file left out of unit-test coverage (see vite.config.ts). It is
 * exercised by the Chromium check instead.
 */

import type { FromWorker } from '../lib/render/protocol';
import { createRenderQueue } from '../lib/render/queue';
import { createImageRenderer } from '../lib/render/renderImage';

const queue = createRenderQueue(createImageRenderer(), (message: FromWorker) =>
  self.postMessage(message),
);

self.addEventListener('message', (event: MessageEvent<unknown>) => queue.handle(event.data));
