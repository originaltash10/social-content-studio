/**
 * What goes into and comes out of an image render. These are plain values (and blobs), so they
 * can be posted to and from the image worker as they are.
 */

import type { ImageFormat } from '../image/fileType';
import type { OutputFormat, RenderPlan } from './plan';

export type RenderJob = {
  /** Chosen by the caller; every progress event and result for the job carries it. */
  id: string;
  /** The asset's original file, exactly as imported. It is only read. */
  blob: Blob;
  /** Used in messages to the user. */
  fileName: string;
  /** The file type found at import, which decides how the file is decoded. */
  sourceFormat: ImageFormat;
  plan: RenderPlan;
};

/** The steps of a render that is under way. */
export type RenderStage = 'decoding' | 'drawing' | 'encoding';

/** Where a job has got to, from joining the queue to finishing one way or the other. */
export type RenderProgress = 'queued' | RenderStage | 'done' | 'failed';

export type RenderResult = {
  id: string;
  /** The encoded image. */
  blob: Blob;
  /** The output size in pixels. */
  width: number;
  height: number;
  /** The encoded file's size. */
  bytes: number;
  /** The type of the encoded file, read from the blob itself. */
  mimeType: string;
  /** The format of the encoded file, from `mimeType`; it is not copied from the request. */
  format: OutputFormat;
  /** True when the picture had to be enlarged to reach the output size. */
  upscaled: boolean;
};

export type RenderFailure =
  /** The file could not be decoded. */
  | 'damaged'
  /** A HEIC file the decoder could not open. */
  | 'heic'
  /** The decoded picture is not the size recorded when it was imported. */
  | 'size-changed'
  /** The browser could not create or draw the output picture. */
  | 'canvas'
  /** The browser could not encode the output file. */
  | 'encode'
  /** The job was cancelled before it produced a file. */
  | 'cancelled'
  /** The image worker stopped, could not be started, or was shut down. */
  | 'worker-failed'
  | 'unexpected';

/** Thrown when a render fails. The message is written for the user. */
export class RenderError extends Error {
  readonly reason: RenderFailure;

  constructor(reason: RenderFailure, message: string) {
    super(message);
    this.name = 'RenderError';
    this.reason = reason;
  }
}

export function cancelledError(fileName: string): RenderError {
  return new RenderError('cancelled', `"${fileName}" was cancelled before it was finished.`);
}

export function workerFailedError(fileName: string): RenderError {
  return new RenderError(
    'worker-failed',
    `"${fileName}" could not be processed because the part of the app that resizes images ` +
      'stopped working. Try again; if it keeps happening, reload the page.',
  );
}

export function unexpectedError(fileName: string): RenderError {
  return new RenderError(
    'unexpected',
    `"${fileName}" could not be processed because something unexpected went wrong. ` +
      'Try again; if it keeps happening, convert the file to JPG or PNG and import that copy.',
  );
}

// ---------------------------------------------------------------------------
// Messages between the page and the image worker
// ---------------------------------------------------------------------------

/**
 * Page to worker. A job's photo travels as a Blob. Posting a Blob hands the worker a reference
 * to the same stored bytes; the photo's data is not copied.
 */
export type ToWorker = { type: 'render'; job: RenderJob } | { type: 'cancel'; id: string };

/** Worker to page. The finished file also travels as a Blob, again without a copy. */
export type FromWorker =
  | { type: 'progress'; id: string; stage: 'queued' | RenderStage }
  | { type: 'done'; id: string; result: RenderResult }
  | { type: 'failed'; id: string; error: { reason: RenderFailure; message: string } };
