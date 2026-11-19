/**
 * Builds JPG and PNG byte streams in memory for the metadata tests: just enough structure for a
 * parser, with made-up EXIF, GPS, XMP, ICC, IPTC and PNG text data. The picture parts are
 * placeholder bytes, not a real image. Nothing here is written to disk, and no real photo or
 * real location is involved: the GPS position is an obviously fake 12° 34' 56" N.
 */

import { crc32 } from '../lib/export/metadata';

export const text = (value: string): Uint8Array => new TextEncoder().encode(value);

export function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// JPG
// ---------------------------------------------------------------------------

/** A JPG segment: 0xFF, the marker, a two-byte length, and the payload. */
export function segment(marker: number, payload: Uint8Array | string): Uint8Array {
  const data = typeof payload === 'string' ? text(payload) : payload;
  const length = data.length + 2;
  return join(new Uint8Array([0xff, marker, length >> 8, length & 0xff]), data);
}

export const SOI = new Uint8Array([0xff, 0xd8]);
export const EOI = new Uint8Array([0xff, 0xd9]);

/** A JFIF APP0 segment; `thumbnail` adds a 1 x 1 thumbnail (3 bytes of RGB). */
export function jfif(thumbnail = false): Uint8Array {
  const header = [...text('JFIF\0'), 1, 2, 0, 0, 1, 0, 1];
  return segment(
    0xe0,
    new Uint8Array(thumbnail ? [...header, 1, 1, 10, 20, 30] : [...header, 0, 0]),
  );
}

/** Placeholder picture segments: tables, frame header, restart interval. */
export const DQT = segment(0xdb, new Uint8Array(65).fill(1));
export const SOF0 = segment(0xc0, new Uint8Array([8, 0, 2, 0, 2, 1, 1, 0x11, 0]));
export const DHT = segment(0xc4, new Uint8Array(20).fill(2));
export const DRI = segment(0xdd, new Uint8Array([0, 4]));

/**
 * A scan: its header, then coded data that contains a stuffed 0xFF 0x00, a restart marker and a
 * fill byte, none of which end the scan.
 */
export const SCAN = join(
  segment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])),
  new Uint8Array([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78, 0xff]),
);

/** EXIF data in TIFF layout: a camera make in IFD0 and, with `gps`, a GPS section. */
export function tiff(order: 'II' | 'MM', gps = true): Uint8Array {
  const out: number[] = [];
  const u16 = (v: number) =>
    order === 'II' ? out.push(v & 0xff, v >> 8) : out.push(v >> 8, v & 0xff);
  const u32 = (v: number) => {
    if (order === 'II') {
      u16(v & 0xffff);
      u16(v >>> 16);
    } else {
      u16(v >>> 16);
      u16(v & 0xffff);
    }
  };
  out.push(...text(order));
  u16(42);
  u32(8);
  // IFD0 at 8.
  const ifd0Entries = gps ? 2 : 1;
  const gpsIfd = 8 + 2 + ifd0Entries * 12 + 4;
  u16(ifd0Entries);
  u16(0x010f); // Make
  u16(2); // ASCII
  u32(4);
  out.push(...text('Fake'));
  if (gps) {
    u16(0x8825); // GPS IFD pointer
    u16(4); // LONG
    u32(1);
    u32(gpsIfd);
  }
  u32(0); // no next IFD
  if (gps) {
    const rationals = gpsIfd + 2 + 2 * 12 + 4;
    u16(2);
    u16(0x0001); // GPSLatitudeRef
    u16(2);
    u32(2);
    out.push(...text('N\0\0\0'));
    u16(0x0002); // GPSLatitude
    u16(5); // RATIONAL
    u32(3);
    u32(rationals);
    u32(0);
    for (const value of [12, 34, 56]) {
      u32(value);
      u32(1);
    }
  }
  return new Uint8Array(out);
}

export const exif = (order: 'II' | 'MM' = 'II', gps = true): Uint8Array =>
  segment(0xe1, join(text('Exif\0\0'), tiff(order, gps)));
export const XMP = segment(
  0xe1,
  'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>12,34.9N</exif:GPSLatitude></x:xmpmeta>',
);
export const ICC = segment(0xe2, 'ICC_PROFILE\0\x01\x01fake profile desc sRGB-ish');
export const IPTC = segment(0xed, 'Photoshop 3.0\0fake caption by somebody');
export const ADOBE = segment(0xee, 'Adobe\0\x64\0\0\0\0\x01');
export const APP15 = segment(0xef, 'something else');
export const COMMENT = segment(0xfe, 'fake comment: taken at a made-up place');

/** The parts every test JPG keeps after stripping, in order. */
export function cleanJpegParts(): Uint8Array[] {
  return [SOI, jfif(), DQT, SOF0, DHT, DRI, SCAN, EOI];
}

/** A JPG with every kind of hidden information this app removes, and data after the end. */
export function jpegWithMetadata(): Uint8Array {
  return join(
    SOI,
    jfif(),
    exif('II'),
    XMP,
    ICC,
    IPTC,
    ADOBE,
    APP15,
    COMMENT,
    DQT,
    SOF0,
    DHT,
    DRI,
    SCAN,
    EOI,
    text('trailing secret'),
  );
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function u32be(value: number): Uint8Array {
  return new Uint8Array([value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** A PNG chunk with a correct CRC. */
export function chunk(type: string, data: Uint8Array | string = new Uint8Array()): Uint8Array {
  const body = join(text(type), typeof data === 'string' ? text(data) : data);
  return join(u32be(body.length - 4), body, u32be(crc32(body)));
}

export const IHDR = chunk('IHDR', new Uint8Array([0, 0, 0, 2, 0, 0, 0, 2, 8, 3, 0, 0, 0]));
export const PLTE = chunk('PLTE', new Uint8Array([255, 0, 0, 0, 0, 255]));
export const TRNS = chunk('tRNS', new Uint8Array([255, 128]));
export const IDAT_1 = chunk('IDAT', new Uint8Array([0x78, 0x9c, 1, 2, 3]));
export const IDAT_2 = chunk('IDAT', new Uint8Array([4, 5, 6, 7]));
export const IEND = chunk('IEND');

export function cleanPngParts(): Uint8Array[] {
  return [PNG_SIGNATURE, IHDR, PLTE, TRNS, IDAT_1, IDAT_2, IEND];
}

/** A PNG with every kind of text and metadata chunk, and data after the end. */
export function pngWithMetadata(): Uint8Array {
  return join(
    PNG_SIGNATURE,
    IHDR,
    chunk('iCCP', 'fake profile\0\0compressed'),
    chunk('sRGB', new Uint8Array([0])),
    chunk('gAMA', u32be(45455)),
    chunk('pHYs', new Uint8Array(9)),
    chunk('eXIf', tiff('MM')),
    PLTE,
    TRNS,
    chunk('tEXt', 'Comment\0fake comment'),
    IDAT_1,
    chunk('zTXt', 'Author\0\0fake'),
    IDAT_2,
    chunk('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>fake GPS</x:xmpmeta>'),
    chunk('tIME', new Uint8Array([7, 234, 11, 18, 12, 0, 0])),
    IEND,
    text('trailing secret'),
  );
}
