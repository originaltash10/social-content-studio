import { RenderError } from './protocol';
import type { FromWorker, RenderJob, RenderResult, RenderStage } from './protocol';
import { createRenderQueue } from './queue';
import type { ImageRenderer } from './renderImage';

function makeJob(id: string): RenderJob {
  return {
    id,
    blob: new Blob([id]),
    fileName: `${id}.jpg`,
    sourceFormat: 'jpeg',
    plan: {} as RenderJob['plan'],
  };
}

function resultFor(job: RenderJob): RenderResult {
  return {
    id: job.id,
    blob: new Blob(['out'], { type: 'image/jpeg' }),
    width: 1,
    height: 1,
    bytes: 3,
    mimeType: 'image/jpeg',
    format: 'jpg',
    upscaled: false,
  };
}

/** A renderer whose jobs finish only when the test says so. */
function manualRenderer() {
  const started: string[] = [];
  const controls = new Map<
    string,
    {
      stage: (stage: RenderStage) => void;
      finish: () => void;
      fail: (error: unknown) => void;
    }
  >();
  const render: ImageRenderer = (job, onStage = () => undefined) =>
    new Promise((resolve, reject) => {
      started.push(job.id);
      controls.set(job.id, {
        stage: onStage,
        finish: () => resolve(resultFor(job)),
        fail: reject,
      });
    });
  const control = (id: string) => {
    const found = controls.get(id);
    if (!found) throw new Error(`job ${id} has not started`);
    return found;
  };
  return { render, started, control };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  const renderer = manualRenderer();
  const messages: FromWorker[] = [];
  const queue = createRenderQueue(renderer.render, (message) => messages.push(message));
  const summary = () =>
    messages.map((m) =>
      m.type === 'progress'
        ? `${m.id}:${m.stage}`
        : m.type === 'done'
          ? `${m.id}:done`
          : `${m.id}:failed:${m.error.reason}`,
    );
  return { ...renderer, queue, messages, summary };
}

describe('the render queue', () => {
  it('runs one job at a time, in the order they were added', async () => {
    const { queue, started, control } = setup();
    queue.add(makeJob('a'));
    queue.add(makeJob('b'));
    queue.add(makeJob('c'));
    expect(started).toEqual(['a']);

    control('a').finish();
    await flush();
    expect(started).toEqual(['a', 'b']);

    control('b').finish();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);
  });

  it('reports queued, each stage, then done with the result', async () => {
    const { queue, control, messages, summary } = setup();
    const job = makeJob('a');
    queue.add(job);
    for (const stage of ['decoding', 'drawing', 'encoding'] as const) control('a').stage(stage);
    control('a').finish();
    await flush();

    expect(summary()).toEqual(['a:queued', 'a:decoding', 'a:drawing', 'a:encoding', 'a:done']);
    const done = messages.at(-1);
    expect(done).toMatchObject({ type: 'done', id: 'a', result: { id: 'a', bytes: 3 } });
  });

  it('reports a waiting job as queued while another is running', () => {
    const { queue, summary } = setup();
    queue.add(makeJob('a'));
    queue.add(makeJob('b'));
    expect(summary()).toEqual(['a:queued', 'b:queued']);
  });

  it("reports a failed job with the renderer's reason and message, then carries on", async () => {
    const { queue, control, messages, started } = setup();
    queue.add(makeJob('a'));
    queue.add(makeJob('b'));
    control('a').fail(new RenderError('damaged', 'The file is damaged.'));
    await flush();

    expect(messages.at(-1)).toEqual({
      type: 'failed',
      id: 'a',
      error: { reason: 'damaged', message: 'The file is damaged.' },
    });
    expect(started).toEqual(['a', 'b']);
  });

  it('never passes on the text of an error it does not recognise', async () => {
    const { queue, control, messages } = setup();
    queue.add(makeJob('a'));
    control('a').fail(new TypeError("Cannot read properties of undefined (reading 'x')"));
    await flush();

    const last = messages.at(-1);
    expect(last).toMatchObject({ type: 'failed', id: 'a', error: { reason: 'unexpected' } });
    expect(JSON.stringify(last)).not.toContain('Cannot read');
    expect(JSON.stringify(last)).toContain('a.jpg');
  });

  it('cancels a waiting job: it is removed, reported as cancelled, and never starts', async () => {
    const { queue, control, started, summary, messages } = setup();
    queue.add(makeJob('a'));
    queue.add(makeJob('b'));
    queue.add(makeJob('c'));

    expect(queue.cancel('b')).toBe(true);
    expect(messages.at(-1)).toEqual({
      type: 'failed',
      id: 'b',
      error: { reason: 'cancelled', message: '"b.jpg" was cancelled before it was finished.' },
    });

    control('a').finish();
    await flush();
    control('c').finish();
    await flush();
    expect(started).toEqual(['a', 'c']);
    expect(summary()).toEqual([
      'a:queued',
      'b:queued',
      'c:queued',
      'b:failed:cancelled',
      'a:done',
      'c:done',
    ]);
  });

  it('cancels the running job: it finishes unseen and is reported as cancelled', async () => {
    const { queue, control, summary, started } = setup();
    queue.add(makeJob('a'));
    queue.add(makeJob('b'));
    control('a').stage('decoding');

    expect(queue.cancel('a')).toBe(true);
    control('a').stage('drawing'); // not reported after the cancel
    control('a').finish();
    await flush();

    expect(summary()).toEqual(['a:queued', 'b:queued', 'a:decoding', 'a:failed:cancelled']);
    expect(started).toEqual(['a', 'b']);
  });

  it('reports a cancelled running job as cancelled even when it then fails', async () => {
    const { queue, control, summary } = setup();
    queue.add(makeJob('a'));
    queue.cancel('a');
    control('a').fail(new RenderError('damaged', 'The file is damaged.'));
    await flush();
    expect(summary()).toEqual(['a:queued', 'a:failed:cancelled']);
  });

  it('returns false when asked to cancel a job it does not have', async () => {
    const { queue, control } = setup();
    expect(queue.cancel('nope')).toBe(false);
    queue.add(makeJob('a'));
    expect(queue.cancel('nope')).toBe(false);
    control('a').finish();
    await flush();
    expect(queue.cancel('a')).toBe(false);
  });

  it('handles render and cancel messages, and ignores anything else', async () => {
    const { queue, started, summary, control } = setup();
    queue.handle({ type: 'render', job: makeJob('a') });
    queue.handle({ type: 'render', job: makeJob('b') });
    queue.handle({ type: 'cancel', id: 'b' });
    for (const junk of [null, undefined, 'render', 7, {}, { type: 'render' }, { type: 'cancel' }]) {
      queue.handle(junk);
    }
    queue.handle({ type: 'cancel', id: 9 });
    queue.handle({ type: 'other', id: 'a' });
    control('a').finish();
    await flush();

    expect(started).toEqual(['a']);
    expect(summary()).toEqual(['a:queued', 'b:queued', 'b:failed:cancelled', 'a:done']);
  });
});
