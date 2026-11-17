/**
 * The page's side of the image worker: send a job, hear its progress, get the finished file.
 * No store access; the caller supplies the job and decides what to do with the result.
 *
 * Nothing is left hanging. Every job ends by resolving with its file or rejecting with a
 * RenderError whose message is written for the user, including when the worker crashes, sends
 * something unreadable, cannot be started, or is shut down.
 *
 * Photos are not copied on the way. A job carries the asset's Blob, and posting a Blob passes a
 * reference to the same stored bytes. The finished file comes back the same way. Nothing here
 * reads a photo into memory.
 */

import { RenderError, cancelledError, unexpectedError, workerFailedError } from './protocol';
import type { FromWorker, RenderJob, RenderProgress, RenderResult, ToWorker } from './protocol';

/** The parts of a Worker the client uses. */
export type WorkerLike = Pick<
  Worker,
  'postMessage' | 'terminate' | 'addEventListener' | 'removeEventListener'
>;

export type ImageWorkerClient = {
  /**
   * Renders one job. `onProgress` hears each stage, ending with 'done' or 'failed'. Rejects
   * only with a RenderError. A job id must not be reused while that job is still pending.
   */
  render(job: RenderJob, onProgress?: (progress: RenderProgress) => void): Promise<RenderResult>;
  /** Cancels a pending job, which then rejects as 'cancelled'. False if it is not pending. */
  cancel(id: string): boolean;
  /** Stops the worker. Pending jobs fail, and so does any job sent afterwards. */
  dispose(): void;
};

type Pending = {
  fileName: string;
  onProgress: (progress: RenderProgress) => void;
  resolve: (result: RenderResult) => void;
  reject: (error: RenderError) => void;
};

/** Starts the real image worker. The worker's code is fetched only when this is first called. */
export function spawnImageWorker(): WorkerLike {
  return new Worker(new URL('../../workers/image.worker.ts', import.meta.url), { type: 'module' });
}

/**
 * `spawn` starts a worker. It is called when the first job arrives, and again for the next job
 * after a worker has failed, so one crash does not stop later renders.
 */
export function createImageWorkerClient(
  spawn: () => WorkerLike = spawnImageWorker,
): ImageWorkerClient {
  const pending = new Map<string, Pending>();
  let worker: WorkerLike | null = null;
  let disposed = false;

  function settle(id: string, error: RenderError): void;
  function settle(id: string, error: null, result: RenderResult): void;
  function settle(id: string, error: RenderError | null, result?: RenderResult): void {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (error) {
      job.onProgress('failed');
      job.reject(error);
    } else {
      job.onProgress('done');
      job.resolve(result as RenderResult);
    }
  }

  function onMessage(event: Event): void {
    const message = (event as MessageEvent<FromWorker | null | undefined>).data;
    if (typeof message !== 'object' || message === null) return;
    if (message.type === 'progress') pending.get(message.id)?.onProgress(message.stage);
    else if (message.type === 'done') settle(message.id, null, message.result);
    else if (message.type === 'failed') {
      settle(message.id, new RenderError(message.error.reason, message.error.message));
    }
  }

  /** The worker crashed or sent something unreadable: stop it and fail everything pending. */
  function onBroken(): void {
    stopWorker();
    for (const [id, job] of [...pending]) settle(id, workerFailedError(job.fileName));
  }

  function stopWorker(): void {
    if (!worker) return;
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onBroken);
    worker.removeEventListener('messageerror', onBroken);
    worker.terminate();
    worker = null;
  }

  function post(message: ToWorker): void {
    if (!worker) {
      worker = spawn();
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onBroken);
      worker.addEventListener('messageerror', onBroken);
    }
    worker.postMessage(message);
  }

  function render(
    job: RenderJob,
    onProgress: (progress: RenderProgress) => void = () => undefined,
  ): Promise<RenderResult> {
    return new Promise<RenderResult>((resolve, reject) => {
      if (disposed) {
        onProgress('failed');
        reject(workerFailedError(job.fileName));
        return;
      }
      if (pending.has(job.id)) {
        onProgress('failed');
        reject(unexpectedError(job.fileName));
        return;
      }
      pending.set(job.id, { fileName: job.fileName, onProgress, resolve, reject });
      try {
        post({ type: 'render', job });
      } catch {
        // The worker could not be started, or the job could not be sent to it.
        settle(job.id, workerFailedError(job.fileName));
      }
    });
  }

  function cancel(id: string): boolean {
    const job = pending.get(id);
    if (!job) return false;
    // Pending means a worker exists; if it has just died, the job is being failed anyway.
    try {
      post({ type: 'cancel', id });
    } catch {
      // Nothing to tell: the job is rejected below either way.
    }
    settle(id, cancelledError(job.fileName));
    return true;
  }

  function dispose(): void {
    disposed = true;
    onBroken();
  }

  return { render, cancel, dispose };
}
