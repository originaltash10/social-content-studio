import { createImageWorkerClient, spawnImageWorker } from './client';
import type { WorkerLike } from './client';
import { RenderError } from './protocol';
import type { FromWorker, RenderJob, RenderProgress, RenderResult, ToWorker } from './protocol';

function makeJob(id: string): RenderJob {
  return {
    id,
    blob: new Blob([`photo ${id}`]),
    fileName: `${id}.jpg`,
    sourceFormat: 'jpeg',
    plan: {} as RenderJob['plan'],
  };
}

function resultFor(id: string): RenderResult {
  return {
    id,
    blob: new Blob(['out'], { type: 'image/jpeg' }),
    width: 1,
    height: 1,
    bytes: 3,
    mimeType: 'image/jpeg',
    format: 'jpg',
    upscaled: false,
  };
}

class FakeWorker implements WorkerLike {
  posted: { message: ToWorker; transfer: unknown }[] = [];
  terminated = false;
  postThrows: ((message: ToWorker) => boolean) | null = null;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  postMessage(message: ToWorker, transfer?: unknown): void {
    if (this.postThrows?.(message)) throw new DOMException('could not be cloned', 'DataCloneError');
    this.posted.push({ message, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
  /** Delivers a message from the worker. */
  send(data: unknown): void {
    this.emit('message', { data } as MessageEvent);
  }
  emit(type: string, event: Event = new Event(type)): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const spawn = vi.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as WorkerLike;
  });
  const client = createImageWorkerClient(spawn);
  const worker = () => {
    const latest = workers.at(-1);
    if (!latest) throw new Error('no worker has been started');
    return latest;
  };
  return { client, spawn, workers, worker };
}

async function failureOf(run: Promise<unknown>): Promise<RenderError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof RenderError) return error;
    throw new Error(`expected a RenderError, got ${String(error)}`, { cause: error });
  }
  throw new Error('expected the render to fail');
}

const JARGON = /error|exception|stack|undefined|null|worker|thread|clone|\n/i;

describe('rendering through the worker', () => {
  it('does not start the worker until the first job', () => {
    const { client, spawn } = setup();
    expect(spawn).not.toHaveBeenCalled();
    void client.render(makeJob('a'));
    void client.render(makeJob('b'));
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('resolves with the result the worker sends', async () => {
    const { client, worker } = setup();
    const run = client.render(makeJob('a'));
    const result = resultFor('a');
    worker().send({ type: 'done', id: 'a', result } satisfies FromWorker);
    expect(await run).toBe(result);
  });

  it('posts the photo as the same Blob, without reading or transferring its bytes', () => {
    const { client, worker } = setup();
    const job = makeJob('a');
    const arrayBuffer = vi.spyOn(job.blob, 'arrayBuffer');
    void client.render(job);

    const [sent] = worker().posted;
    expect(sent?.message).toEqual({ type: 'render', job });
    expect((sent?.message as { job: RenderJob }).job.blob).toBe(job.blob);
    expect(sent?.transfer).toBeUndefined();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('passes on every stage, ending with done', async () => {
    const { client, worker } = setup();
    const heard: RenderProgress[] = [];
    const run = client.render(makeJob('a'), (progress) => heard.push(progress));
    for (const stage of ['queued', 'decoding', 'drawing', 'encoding'] as const) {
      worker().send({ type: 'progress', id: 'a', stage } satisfies FromWorker);
    }
    worker().send({ type: 'done', id: 'a', result: resultFor('a') } satisfies FromWorker);
    await run;
    expect(heard).toEqual(['queued', 'decoding', 'drawing', 'encoding', 'done']);
  });

  it('keeps jobs apart by id', async () => {
    const { client, worker } = setup();
    const heardA: RenderProgress[] = [];
    const heardB: RenderProgress[] = [];
    const a = client.render(makeJob('a'), (progress) => heardA.push(progress));
    const b = client.render(makeJob('b'), (progress) => heardB.push(progress));
    worker().send({ type: 'progress', id: 'b', stage: 'queued' });
    worker().send({ type: 'done', id: 'b', result: resultFor('b') });
    worker().send({ type: 'done', id: 'a', result: resultFor('a') });
    expect((await a).id).toBe('a');
    expect((await b).id).toBe('b');
    expect(heardA).toEqual(['done']);
    expect(heardB).toEqual(['queued', 'done']);
  });

  it("rejects with the worker's reason and message when a job fails", async () => {
    const { client, worker } = setup();
    const heard: RenderProgress[] = [];
    const run = client.render(makeJob('a'), (progress) => heard.push(progress));
    worker().send({
      type: 'failed',
      id: 'a',
      error: { reason: 'damaged', message: 'The file is damaged.' },
    } satisfies FromWorker);
    const error = await failureOf(run);
    expect(error.reason).toBe('damaged');
    expect(error.message).toBe('The file is damaged.');
    expect(heard).toEqual(['failed']);
  });

  it('ignores messages it cannot use', async () => {
    const { client, worker } = setup();
    const heard: RenderProgress[] = [];
    const run = client.render(makeJob('a'), (progress) => heard.push(progress));
    for (const junk of [null, undefined, 'done', 5, {}, { type: 'weird', id: 'a' }]) {
      worker().send(junk);
    }
    worker().send({ type: 'progress', id: 'other', stage: 'queued' });
    worker().send({ type: 'done', id: 'other', result: resultFor('other') });
    worker().send({ type: 'failed', id: 'other', error: { reason: 'damaged', message: 'x' } });
    expect(heard).toEqual([]);
    worker().send({ type: 'done', id: 'a', result: resultFor('a') });
    await run;
  });

  it('refuses a job id that is still pending, without disturbing the first job', async () => {
    const { client, worker } = setup();
    const first = client.render(makeJob('a'));
    const heard: RenderProgress[] = [];
    const error = await failureOf(client.render(makeJob('a'), (p) => heard.push(p)));
    expect(error.reason).toBe('unexpected');
    expect(heard).toEqual(['failed']);
    expect(worker().posted).toHaveLength(1);

    worker().send({ type: 'done', id: 'a', result: resultFor('a') });
    expect((await first).id).toBe('a');
    // Once it has finished, the id can be used again.
    const again = client.render(makeJob('a'));
    worker().send({ type: 'done', id: 'a', result: resultFor('a') });
    await again;
  });
});

describe('cancelling', () => {
  it('rejects the job as cancelled at once and tells the worker', async () => {
    const { client, worker } = setup();
    const heard: RenderProgress[] = [];
    const run = client.render(makeJob('a'), (progress) => heard.push(progress));
    expect(client.cancel('a')).toBe(true);

    const error = await failureOf(run);
    expect(error.reason).toBe('cancelled');
    expect(error.message).toBe('"a.jpg" was cancelled before it was finished.');
    expect(heard).toEqual(['failed']);
    expect(worker().posted.at(-1)?.message).toEqual({ type: 'cancel', id: 'a' });
  });

  it('ignores what the worker says about a job after it was cancelled', async () => {
    const { client, worker } = setup();
    const heard: RenderProgress[] = [];
    const run = client.render(makeJob('a'), (progress) => heard.push(progress));
    client.cancel('a');
    worker().send({ type: 'failed', id: 'a', error: { reason: 'cancelled', message: 'x' } });
    worker().send({ type: 'done', id: 'a', result: resultFor('a') });
    await failureOf(run);
    expect(heard).toEqual(['failed']);
  });

  it('returns false for a job that is not pending', () => {
    const { client, spawn } = setup();
    expect(client.cancel('nope')).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still cancels when the worker cannot be told', async () => {
    const { client, worker } = setup();
    const run = client.render(makeJob('a'));
    worker().postThrows = (message) => message.type === 'cancel';
    expect(client.cancel('a')).toBe(true);
    expect((await failureOf(run)).reason).toBe('cancelled');
  });
});

describe('when the worker goes wrong', () => {
  it.each(['error', 'messageerror'])(
    'fails every pending job with a plain message on a worker %s event',
    async (eventType) => {
      const { client, worker } = setup();
      const heard: RenderProgress[] = [];
      const a = client.render(makeJob('a'), (progress) => heard.push(progress));
      const b = client.render(makeJob('b'));
      const broken = worker();
      broken.emit(eventType);

      const errorA = await failureOf(a);
      const errorB = await failureOf(b);
      expect(errorA.reason).toBe('worker-failed');
      expect(errorA.message).toBe(
        '"a.jpg" could not be processed because the part of the app that resizes images ' +
          'stopped working. Try again; if it keeps happening, reload the page.',
      );
      expect(errorA.message).not.toMatch(JARGON);
      expect(errorB.message).toContain('"b.jpg"');
      expect(heard).toEqual(['failed']);
      expect(broken.terminated).toBe(true);
      expect(broken.listenerCount()).toBe(0);
    },
  );

  it('starts a fresh worker for the next job after a crash', async () => {
    const { client, worker, workers, spawn } = setup();
    const first = client.render(makeJob('a'));
    worker().emit('error');
    await failureOf(first);

    const second = client.render(makeJob('b'));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(workers).toHaveLength(2);
    worker().send({ type: 'done', id: 'b', result: resultFor('b') });
    expect((await second).id).toBe('b');
  });

  it('fails the job when the worker cannot be started, and tries again next time', async () => {
    const good = new FakeWorker();
    const spawn = vi
      .fn<() => WorkerLike>()
      .mockImplementationOnce(() => {
        throw new Error('SecurityError: worker script blocked');
      })
      .mockImplementation(() => good as unknown as WorkerLike);
    const client = createImageWorkerClient(spawn);

    const error = await failureOf(client.render(makeJob('a')));
    expect(error.reason).toBe('worker-failed');
    expect(error.message).not.toMatch(JARGON);

    const second = client.render(makeJob('b'));
    good.send({ type: 'done', id: 'b', result: resultFor('b') });
    expect((await second).id).toBe('b');
  });

  it('fails only the job that could not be sent', async () => {
    const { client, worker } = setup();
    const a = client.render(makeJob('a'));
    worker().postThrows = () => true;
    const error = await failureOf(client.render(makeJob('b')));
    expect(error.reason).toBe('worker-failed');

    worker().send({ type: 'done', id: 'a', result: resultFor('a') });
    expect((await a).id).toBe('a');
  });
});

describe('dispose', () => {
  it('terminates the worker and fails pending jobs', async () => {
    const { client, worker } = setup();
    const heard: RenderProgress[] = [];
    const a = client.render(makeJob('a'), (progress) => heard.push(progress));
    const b = client.render(makeJob('b'));
    const used = worker();
    client.dispose();

    expect(used.terminated).toBe(true);
    expect(used.listenerCount()).toBe(0);
    expect((await failureOf(a)).reason).toBe('worker-failed');
    expect((await failureOf(b)).reason).toBe('worker-failed');
    expect(heard).toEqual(['failed']);
  });

  it('fails any job sent afterwards without starting a worker', async () => {
    const { client, spawn } = setup();
    client.dispose();
    const heard: RenderProgress[] = [];
    const error = await failureOf(client.render(makeJob('a'), (p) => heard.push(p)));
    expect(error.reason).toBe('worker-failed');
    expect(heard).toEqual(['failed']);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('can be called twice, and before any job', () => {
    const { client } = setup();
    client.dispose();
    expect(() => client.dispose()).not.toThrow();
  });
});

describe('spawnImageWorker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts the image worker file as a module worker, and is what a client uses by default', async () => {
    const made: { url: URL; options: WorkerOptions; posted: unknown[] }[] = [];
    class StubWorker {
      posted: unknown[] = [];
      constructor(url: URL, options: WorkerOptions) {
        made.push({ url, options, posted: this.posted });
      }
      postMessage(message: unknown) {
        this.posted.push(message);
      }
      addEventListener() {}
      removeEventListener() {}
      terminate() {}
    }
    vi.stubGlobal('Worker', StubWorker);

    expect(spawnImageWorker()).toBeInstanceOf(StubWorker);
    expect(String(made[0]?.url)).toContain('/src/workers/image.worker.ts');
    expect(made[0]?.options).toEqual({ type: 'module' });

    const client = createImageWorkerClient();
    const run = client.render(makeJob('a'));
    expect(made).toHaveLength(2);
    expect(made[1]?.posted).toHaveLength(1);
    client.dispose();
    await failureOf(run);
  });
});
