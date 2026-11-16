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

/** Where a job has got to. */
export type RenderStage = 'decoding' | 'drawing' | 'encoding';

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
