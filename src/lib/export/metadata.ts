/**
 * Removes hidden information from exported images, so a file carries only its picture: no
 * camera details, no location, no editing history, no comments, no colour profile text.
 *
 * Exported files are drawn fresh on a canvas, so nothing from the original photo is carried
 * over, but the browser's encoder adds data of its own (Chromium puts an ICC colour profile in
 * every JPG). Rather than trust any encoder, every exported file is passed through
 * `stripMetadata`, which keeps only what is needed to show the picture:
 *
 * - JPG: the start and end markers, a plain JFIF header (with any thumbnail removed), the
 *   quantisation and Huffman tables, the frame header, the restart interval, and the scans.
 *   Every APP1 to APP15 segment (EXIF and GPS, XMP, ICC profile, IPTC, Adobe, ...) and every
 *   comment is removed.
 * - PNG: IHDR, PLTE, tRNS, IDAT and IEND. Every other chunk (tEXt, zTXt, iTXt, eXIf, iCCP,
 *   tIME, sRGB, gAMA, pHYs, ...) is removed.
 * - Anything after the end of the image is removed.
 *
 * What is kept is copied byte for byte, so the picture is not re-encoded. A file that cannot be
 * read with certainty (cut short, damaged, an unknown required part, or not the format it
 * claims to be) is refused with a MetadataError and never passed through unchecked.
 *
 * Pure byte handling: no DOM, no browser APIs.
 */

import type { OutputFormat } from '../render/plan';

/** The file could not be checked. The message is written for the user. */
export class MetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataError';
  }
}

const FORMAT_LABEL: Record<OutputFormat, string> = { jpg: 'JPG', png: 'PNG' };

function notFormatError(format: OutputFormat): MetadataError {
  return new MetadataError(
    `The image made for export is not a valid ${FORMAT_LABEL[format]} file, so it was not ` +
      'exported. Try again.',
  );
}

const DAMAGED = new MetadataError(
  'The image made for export could not be checked for hidden information (such as location ' +
    'data), so it was not exported. Try again.',
);

/** Reads one byte; a read past the end means the file was cut short. */
function u8(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined) throw DAMAGED;
  return value;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

/** The format the bytes start like, or null when they look like neither JPG nor PNG. */
export function detectFormat(bytes: Uint8Array): OutputFormat | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return 'png';
  return null;
}

// ---------------------------------------------------------------------------
// JPG
// ---------------------------------------------------------------------------

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP15 = 0xef;
const COM = 0xfe;

/**
 * Segments that describe the picture and are kept: frame headers SOF0 to SOF15 (C0 to CF,
 * which also covers DHT at C4 and DAC at CC; C8 is reserved and refused), DQT and DRI.
 * SOI, EOI, SOS and APP0 are handled on their own.
 */
function isPictureSegment(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8) || marker === 0xdb || marker === 0xdd
  );
}

/** The fixed part of a JFIF header: "JFIF\0", version (2), units (1), density (4), thumbnail size (2). */
const JFIF_HEADER = 14;

type JpegSegment = { marker: number; start: number; end: number };

/** The end of a scan's coded data: the next marker that is not a stuffed byte or a restart. */
function scanEnd(bytes: Uint8Array, from: number): number {
  let index = from;
  for (;;) {
    if (u8(bytes, index) !== 0xff) {
      index += 1;
      continue;
    }
    const next = u8(bytes, index + 1);
    if (next === 0xff) index += 1;
    else if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) index += 2;
    else return index;
  }
}

/** Splits a JPG into its segments. A scan's segment includes its coded data. */
function jpegSegments(bytes: Uint8Array): { segments: JpegSegment[]; trailing: boolean } {
  const segments: JpegSegment[] = [{ marker: SOI, start: 0, end: 2 }];
  let index = 2;
  for (;;) {
    if (u8(bytes, index) !== 0xff) throw DAMAGED;
    let at = index + 1;
    while (u8(bytes, at) === 0xff) at += 1; // fill bytes before a marker
    const marker = u8(bytes, at);
    if (marker === EOI) {
      segments.push({ marker, start: at - 1, end: at + 1 });
      return { segments, trailing: at + 1 < bytes.length };
    }
    // Markers without a length (TEM, RST0-7, a second SOI) or a stuffed zero do not belong here.
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= SOI)) throw DAMAGED;
    const length = (u8(bytes, at + 1) << 8) | u8(bytes, at + 2);
    let end = at + 1 + length;
    if (length < 2 || end > bytes.length) throw DAMAGED;
    if (marker === SOS) end = scanEnd(bytes, end);
    segments.push({ marker, start: at - 1, end });
    index = end;
  }
}

/** True when EXIF data (TIFF layout, from the byte-order mark) has a GPS section in IFD0. */
function exifHasGps(tiff: Uint8Array): boolean {
  try {
    const order = ascii(tiff, 0, 2);
    if (order !== 'II' && order !== 'MM') return false;
    const little = order === 'II';
    const u16 = (at: number) =>
      little ? u8(tiff, at) | (u8(tiff, at + 1) << 8) : (u8(tiff, at) << 8) | u8(tiff, at + 1);
    const u32 = (at: number) =>
      little ? u16(at) + u16(at + 2) * 0x10000 : u16(at) * 0x10000 + u16(at + 2);
    const ifd = u32(4);
    const count = u16(ifd);
    for (let entry = 0; entry < count; entry += 1) {
      if (u16(ifd + 2 + entry * 12) === 0x8825) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** What an APPn segment holds, in words. */
function appLabel(bytes: Uint8Array, segment: JpegSegment): string {
  const n = segment.marker - APP0;
  const payload = segment.start + 4;
  const id = ascii(bytes, payload, payload + 32);
  if (n === 1 && id.startsWith('Exif\0\0')) {
    return exifHasGps(bytes.subarray(payload + 6, segment.end))
      ? 'EXIF with GPS location (APP1)'
      : 'EXIF (APP1)';
  }
  if (n === 1 && id.startsWith('http://ns.adobe.com/xap/1.0/\0')) return 'XMP (APP1)';
  if (n === 2 && id.startsWith('ICC_PROFILE\0')) return 'ICC profile (APP2)';
  if (n === 13 && id.startsWith('Photoshop 3.0\0')) return 'IPTC (APP13)';
  if (n === 14 && id.startsWith('Adobe')) return 'Adobe (APP14)';
  return `APP${n}`;
}

/** A JFIF header with no thumbnail, or null when the APP0 segment is not a usable JFIF header. */
function plainJfif(bytes: Uint8Array, segment: JpegSegment): Uint8Array | null {
  const payload = segment.start + 4;
  if (segment.end - payload < JFIF_HEADER || ascii(bytes, payload, payload + 5) !== 'JFIF\0') {
    return null;
  }
  const out = new Uint8Array(4 + JFIF_HEADER);
  out.set([0xff, APP0, 0, 2 + JFIF_HEADER]);
  out.set(bytes.subarray(payload, payload + JFIF_HEADER - 2), 4);
  // Thumbnail width and height stay 0: no thumbnail.
  return out;
}

type Sorted = { kept: Uint8Array[]; removed: string[] };

function sortJpeg(bytes: Uint8Array): Sorted {
  const { segments, trailing } = jpegSegments(bytes);
  const kept: Uint8Array[] = [];
  const removed: string[] = [];
  for (const segment of segments) {
    const { marker } = segment;
    const whole = bytes.subarray(segment.start, segment.end);
    if (marker === SOI || marker === EOI || marker === SOS || isPictureSegment(marker)) {
      kept.push(whole);
    } else if (marker === APP0) {
      const jfif = plainJfif(bytes, segment);
      if (!jfif) removed.push('APP0');
      else {
        kept.push(jfif);
        // Thumbnail width and height are the last two bytes of the fixed header.
        const size = u8(bytes, segment.start + 16) | u8(bytes, segment.start + 17);
        if (whole.length > jfif.length || size !== 0) removed.push('JFIF thumbnail (APP0)');
      }
    } else if (marker > APP0 && marker <= APP15) removed.push(appLabel(bytes, segment));
    else if (marker === COM) removed.push('comment (COM)');
    else throw DAMAGED;
  }
  if (trailing) removed.push('data after the end of the image');
  return { kept, removed };
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** The CRC-32 PNG uses for each chunk (over the chunk type and data). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u32be(bytes: Uint8Array, at: number): number {
  return (
    u8(bytes, at) * 0x1000000 +
    ((u8(bytes, at + 1) << 16) | (u8(bytes, at + 2) << 8) | u8(bytes, at + 3))
  );
}

/** Chunks that make up the picture and are kept. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

const PNG_LABEL: Record<string, string> = {
  tEXt: 'text (tEXt)',
  zTXt: 'compressed text (zTXt)',
  iTXt: 'international text (iTXt)',
  eXIf: 'EXIF (eXIf)',
  iCCP: 'ICC profile (iCCP)',
  tIME: 'timestamp (tIME)',
};

function sortPng(bytes: Uint8Array): Sorted {
  const kept: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)];
  const removed: string[] = [];
  let index: number = PNG_SIGNATURE.length;
  for (;;) {
    const length = u32be(bytes, index);
    const type = ascii(bytes, index + 4, index + 8);
    const end = index + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || end > bytes.length) throw DAMAGED;
    if (index === PNG_SIGNATURE.length && type !== 'IHDR') throw DAMAGED;
    if (crc32(bytes.subarray(index + 4, end - 4)) !== u32be(bytes, end - 4)) throw DAMAGED;
    if (PNG_KEEP.has(type)) kept.push(bytes.subarray(index, end));
    // A required chunk this code does not know cannot be dropped safely.
    else if (/^[A-Z]/.test(type)) throw DAMAGED;
    else removed.push(PNG_LABEL[type] ?? `${type} chunk`);
    if (type === 'IEND') {
      if (end < bytes.length) removed.push('data after the end of the image');
      return { kept, removed };
    }
    index = end;
  }
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

function sort(bytes: Uint8Array, format: OutputFormat): Sorted {
  return format === 'jpg' ? sortJpeg(bytes) : sortPng(bytes);
}

/**
 * Lists the hidden information in a JPG or PNG file, in words, e.g. "EXIF with GPS location
 * (APP1)" or "text (tEXt)": everything `stripMetadata` would remove. Empty for a clean file.
 * Throws a MetadataError for a file that is neither, or cannot be read.
 */
export function findMetadata(bytes: Uint8Array): string[] {
  const format = detectFormat(bytes);
  if (!format) throw DAMAGED;
  return sort(bytes, format).removed;
}

/**
 * Returns a copy of the file with all hidden information removed (see the top of this file).
 * Throws a MetadataError if the file is not a `format` file or cannot be read with certainty.
 */
export function stripMetadata(bytes: Uint8Array, format: OutputFormat): Uint8Array {
  if (detectFormat(bytes) !== format) throw notFormatError(format);
  return concat(sort(bytes, format).kept);
}
