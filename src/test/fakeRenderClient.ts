/**
 * A stand-in for the image worker client, shared by the render controller and board tests.
 * Jobs finish only when a test says so. Like the real client, `cancel` rejects a pending job as
 * cancelled and returns false for one that has already finished, and `dispose` fails every
 * pending job.
 */
import { vi } from 'vitest';
import { cancelledError, workerFailedError } from '../lib/render/protocol';
import type { RenderJob, RenderProgress, RenderResult } from '../lib/render/protocol';

export type FakeCall = {
  job: RenderJob;
  onProgress: (progress: RenderProgress) => void;
  resolve: (result: RenderResult) => void;
  reject: (error: unknown) => void;
  /** True once the job has been answered, cancelled or failed. */
  settled: boolean;
};

export function fakeRenderClient() {
  const calls: FakeCall[] = [];
  const cancelled: string[] = [];
  const waiters: { count: number; done: () => void }[] = [];
  let disposed = false;
  return {
    calls,
    cancelled,
    get disposed() {
      return disposed;
    },
    /** Resolves once `count` jobs have been sent. */
    sent(count: number): Promise<void> {
      if (calls.length >= count) return Promise.resolve();
      return new Promise((done) => waiters.push({ count, done }));
    },
    render: vi.fn(
      (job: RenderJob, onProgress: (progress: RenderProgress) => void = () => undefined) =>
        new Promise<RenderResult>((resolve, reject) => {
          const entry: FakeCall = {
            job,
            onProgress,
            settled: false,
            resolve: (result) => {
              entry.settled = true;
              resolve(result);
            },
            reject: (error) => {
              entry.settled = true;
              reject(error);
            },
          };
          calls.push(entry);
          for (const waiter of waiters.filter((w) => calls.length >= w.count)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.done();
          }
        }),
    ),
    cancel: vi.fn((id: string) => {
      cancelled.push(id);
      const pending = calls.find((c) => c.job.id === id && !c.settled);
      if (!pending) return false;
      pending.reject(cancelledError(pending.job.fileName));
      return true;
    }),
    dispose: vi.fn(() => {
      disposed = true;
      for (const c of calls.filter((entry) => !entry.settled)) {
        c.reject(workerFailedError(c.job.fileName));
      }
    }),
  };
}

export type FakeRenderClient = ReturnType<typeof fakeRenderClient>;

/** A finished file at the job's planned size. */
export function resultFor(job: RenderJob, overrides: Partial<RenderResult> = {}): RenderResult {
  return {
    id: job.id,
    blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    width: job.plan.target.width,
    height: job.plan.target.height,
    bytes: 400_000,
    mimeType: 'image/jpeg',
    format: 'jpg',
    upscaled: job.plan.upscaled,
    ...overrides,
  };
}
