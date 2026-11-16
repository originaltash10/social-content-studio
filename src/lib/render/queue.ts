/**
 * The image worker's job queue. Jobs run one at a time, in the order they arrive, so only one
 * photo is being decoded at any moment. Everything the queue has to say goes out through `emit`
 * as a message: progress for each stage, then exactly one `done` or `failed` per job.
 *
 * Kept apart from the worker file so it can be tested without a worker.
 */

import { RenderError, cancelledError, unexpectedError } from './protocol';
import type { FromWorker, RenderJob } from './protocol';
import type { ImageRenderer } from './renderImage';

export type RenderQueue = {
  /** Adds a job to the end of the queue. */
  add(job: RenderJob): void;
  /**
   * Cancels a job. A waiting job is removed and never starts. The job that is running cannot be
   * interrupted; it is left to finish, its file is thrown away, and it is reported as cancelled.
   * Returns false when no such job is waiting or running.
   */
  cancel(id: string): boolean;
  /** Handles a message from the page. Anything that is not a known message is ignored. */
  handle(message: unknown): void;
};

type Running = { id: string; cancelled: boolean };

function failed(id: string, error: RenderError): FromWorker {
  return { type: 'failed', id, error: { reason: error.reason, message: error.message } };
}

export function createRenderQueue(
  render: ImageRenderer,
  emit: (message: FromWorker) => void,
): RenderQueue {
  const waiting: RenderJob[] = [];
  let running: Running | null = null;

  async function run(job: RenderJob, state: Running): Promise<FromWorker> {
    try {
      const result = await render(job, (stage) => {
        if (!state.cancelled) emit({ type: 'progress', id: job.id, stage });
      });
      return state.cancelled
        ? failed(job.id, cancelledError(job.fileName))
        : { type: 'done', id: job.id, result };
    } catch (error) {
      if (state.cancelled) return failed(job.id, cancelledError(job.fileName));
      return failed(job.id, error instanceof RenderError ? error : unexpectedError(job.fileName));
    }
  }

  async function pump(): Promise<void> {
    if (running) return;
    const job = waiting.shift();
    if (!job) return;
    running = { id: job.id, cancelled: false };
    const outcome = await run(job, running);
    running = null;
    emit(outcome);
    void pump();
  }

  function add(job: RenderJob): void {
    waiting.push(job);
    emit({ type: 'progress', id: job.id, stage: 'queued' });
    void pump();
  }

  function cancel(id: string): boolean {
    const index = waiting.findIndex((job) => job.id === id);
    const job = waiting[index];
    if (job) {
      waiting.splice(index, 1);
      emit(failed(id, cancelledError(job.fileName)));
      return true;
    }
    if (running?.id === id) {
      running.cancelled = true;
      return true;
    }
    return false;
  }

  function handle(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const { type, job, id } = message as { type?: unknown; job?: RenderJob; id?: unknown };
    if (type === 'render' && job) add(job);
    else if (type === 'cancel' && typeof id === 'string') cancel(id);
  }

  return { add, cancel, handle };
}
