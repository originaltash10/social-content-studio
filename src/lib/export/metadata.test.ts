import { describe, expect, it } from 'vitest';
import { MetadataError, crc32, detectFormat, findMetadata, stripMetadata } from './metadata';
import {
  ADOBE,
  APP15,
  COMMENT,
  DHT,
  DQT,
  DRI,
  EOI,
  ICC,
  IDAT_1,
  IEND,
  IHDR,
  IPTC,
  PNG_SIGNATURE,
  SCAN,
  SOF0,
  SOI,
  XMP,
  chunk,
  cleanJpegParts,
  cleanPngParts,
  exif,
  jfif,
  join,
  jpegWithMetadata,
  pngWithMetadata,
  segment,
  text,
  tiff,
} from '../../test/imageBytes';

const NOT_CHECKED = 'could not be checked for hidden information';

/** True when `needle` appears anywhere in `haystack`. */
function contains(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle, 'latin1'));
}

/** Text that only the hidden information in the test files contains. */
const SECRETS = [
  'Exif',
  'Fake',
  'xmpmeta',
  'GPS',
  'ICC_PROFILE',
  'Photoshop',
  'Adobe',
  'fake',
  'trailing secret',
  'tEXt',
  'zTXt',
  'iTXt',
  'eXIf',
  'iCCP',
  'tIME',
  'sRGB',
];

function expectNoSecrets(bytes: Uint8Array) {
  for (const secret of SECRETS) expect(contains(bytes, secret), secret).toBe(false);
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
  });

  it('matches the CRC every PNG file ends with (IEND)', () => {
    expect(crc32(text('IEND'))).toBe(0xae426082);
  });
});

describe('detectFormat', () => {
  it('recognises JPG and PNG from their first bytes', () => {
    expect(detectFormat(jpegWithMetadata())).toBe('jpg');
    expect(detectFormat(pngWithMetadata())).toBe('png');
  });

  it.each([
    ['empty', new Uint8Array()],
    ['two JPG bytes only', new Uint8Array([0xff, 0xd8])],
    ['a JPG start without a marker after it', new Uint8Array([0xff, 0xd8, 0x00])],
    ['a GIF', text('GIF89a')],
    ['a PNG signature cut short', PNG_SIGNATURE.subarray(0, 7)],
  ])('returns null for %s', (_, bytes) => {
    expect(detectFormat(bytes)).toBeNull();
  });
});

describe('JPG', () => {
  it('finds every kind of hidden information, including a GPS location', () => {
    expect(findMetadata(jpegWithMetadata())).toEqual([
      'EXIF with GPS location (APP1)',
      'XMP (APP1)',
      'ICC profile (APP2)',
      'IPTC (APP13)',
      'Adobe (APP14)',
      'APP15',
      'comment (COM)',
      'data after the end of the image',
    ]);
  });

  it('removes all of it and keeps the picture byte for byte', () => {
    const before = jpegWithMetadata();
    expect(contains(before, 'Exif')).toBe(true);
    const after = stripMetadata(before, 'jpg');
    expect(after).toEqual(join(...cleanJpegParts()));
    expect(findMetadata(after)).toEqual([]);
    expectNoSecrets(after);
  });

  it('leaves a clean file exactly as it was', () => {
    const clean = join(...cleanJpegParts());
    expect(stripMetadata(clean, 'jpg')).toEqual(clean);
    expect(findMetadata(clean)).toEqual([]);
  });

  it('does not change the file it was given', () => {
    const before = jpegWithMetadata();
    const copy = before.slice();
    stripMetadata(before, 'jpg');
    expect(before).toEqual(copy);
  });

  it('finds GPS in big-endian EXIF as well', () => {
    expect(findMetadata(join(SOI, exif('MM'), DQT, SCAN, EOI))).toEqual([
      'EXIF with GPS location (APP1)',
    ]);
  });

  it('names EXIF without GPS, or EXIF it cannot read, as plain EXIF, and still removes it', () => {
    const noGps = exif('II', false);
    const badOrder = segment(0xe1, join(text('Exif\0\0XX'), tiff('II').subarray(2)));
    const cutShort = segment(0xe1, join(text('Exif\0\0'), tiff('II').subarray(0, 12)));
    for (const app1 of [noGps, badOrder, cutShort]) {
      const file = join(SOI, app1, DQT, SCAN, EOI);
      expect(findMetadata(file)).toEqual(['EXIF (APP1)']);
      expect(stripMetadata(file, 'jpg')).toEqual(join(SOI, DQT, SCAN, EOI));
    }
  });

  it('removes an APP1 segment of any other kind', () => {
    const file = join(SOI, segment(0xe1, 'MPF\0something'), DQT, SCAN, EOI);
    expect(findMetadata(file)).toEqual(['APP1']);
    expect(stripMetadata(file, 'jpg')).toEqual(join(SOI, DQT, SCAN, EOI));
  });

  it('removes a JFIF thumbnail and keeps the plain header', () => {
    const file = join(SOI, jfif(true), DQT, SCAN, EOI);
    expect(findMetadata(file)).toEqual(['JFIF thumbnail (APP0)']);
    expect(stripMetadata(file, 'jpg')).toEqual(join(SOI, jfif(), DQT, SCAN, EOI));
  });

  it('treats a JFIF header that announces a thumbnail as having one', () => {
    const announced = jfif().slice();
    announced[16] = 1; // thumbnail width, with no thumbnail data
    const file = join(SOI, announced, DQT, SCAN, EOI);
    expect(findMetadata(file)).toEqual(['JFIF thumbnail (APP0)']);
    expect(stripMetadata(file, 'jpg')).toEqual(join(SOI, jfif(), DQT, SCAN, EOI));
  });

  it('removes an APP0 segment that is not a full JFIF header', () => {
    const jfxx = segment(0xe0, 'JFXX\0\x10thumbnail');
    const short = segment(0xe0, 'JFIF\0\x01');
    for (const app0 of [jfxx, short]) {
      const file = join(SOI, app0, DQT, SCAN, EOI);
      expect(findMetadata(file)).toEqual(['APP0']);
      expect(stripMetadata(file, 'jpg')).toEqual(join(SOI, DQT, SCAN, EOI));
    }
  });

  it('removes hidden information between the scans of a progressive JPG', () => {
    const file = join(SOI, DQT, SOF0, DHT, SCAN, COMMENT, DHT, SCAN, ICC, EOI);
    expect(findMetadata(file)).toEqual(['comment (COM)', 'ICC profile (APP2)']);
    expect(stripMetadata(file, 'jpg')).toEqual(join(SOI, DQT, SOF0, DHT, SCAN, DHT, SCAN, EOI));
  });

  it('accepts fill bytes before a marker and leaves them out', () => {
    const file = join(SOI, new Uint8Array([0xff, 0xff]), DQT, SCAN, EOI);
    expect(stripMetadata(file, 'jpg')).toEqual(join(SOI, DQT, SCAN, EOI));
  });

  it('keeps every kind of frame header and the table segments', () => {
    const frames = [0xc1, 0xc2, 0xc3, 0xc5, 0xc9, 0xcc, 0xcf].map((marker) =>
      segment(marker, new Uint8Array([1, 2, 3])),
    );
    const file = join(SOI, ...frames, DRI, SCAN, EOI);
    expect(stripMetadata(file, 'jpg')).toEqual(file);
  });

  it.each([
    ['a byte that is not a marker', join(SOI, DQT, new Uint8Array([0x00]), EOI)],
    ['a stuffed zero in place of a marker', join(SOI, new Uint8Array([0xff, 0x00]), EOI)],
    ['a TEM marker', join(SOI, new Uint8Array([0xff, 0x01]), EOI)],
    ['a restart marker outside a scan', join(SOI, new Uint8Array([0xff, 0xd3]), EOI)],
    ['a second start marker', join(SOI, SOI, EOI)],
    ['a length below 2', join(SOI, new Uint8Array([0xff, 0xdb, 0x00, 0x01]), EOI)],
    ['a length past the end', join(SOI, new Uint8Array([0xff, 0xdb, 0x40, 0x00]), EOI)],
    ['a length cut short', join(SOI, new Uint8Array([0xff, 0xdb, 0x00]))],
    ['the reserved C8 marker', join(SOI, segment(0xc8, 'x'), EOI)],
    ['an unknown marker', join(SOI, segment(0xde, 'x'), EOI)],
    ['a scan with no end', join(SOI, DQT, SCAN)],
    ['a file cut off before the end marker', join(SOI, DQT)],
    ['the format check passed but no marker follows', new Uint8Array([0xff, 0xd8, 0xff])],
  ])('refuses %s', (_, bytes) => {
    expect(() => stripMetadata(bytes, 'jpg')).toThrow(MetadataError);
    expect(() => stripMetadata(bytes, 'jpg')).toThrow(NOT_CHECKED);
  });
});

describe('PNG', () => {
  it('finds every text and metadata chunk', () => {
    expect(findMetadata(pngWithMetadata())).toEqual([
      'ICC profile (iCCP)',
      'sRGB chunk',
      'gAMA chunk',
      'pHYs chunk',
      'EXIF (eXIf)',
      'text (tEXt)',
      'compressed text (zTXt)',
      'international text (iTXt)',
      'timestamp (tIME)',
      'data after the end of the image',
    ]);
  });

  it('removes all of them and keeps the picture chunks byte for byte, CRCs intact', () => {
    const after = stripMetadata(pngWithMetadata(), 'png');
    expect(after).toEqual(join(...cleanPngParts()));
    // Reading it again checks every kept chunk's CRC.
    expect(findMetadata(after)).toEqual([]);
    expectNoSecrets(after);
  });

  it('leaves a clean file exactly as it was', () => {
    const clean = join(...cleanPngParts());
    expect(stripMetadata(clean, 'png')).toEqual(clean);
  });

  it.each([
    ['nothing after the signature', PNG_SIGNATURE],
    ['a first chunk that is not IHDR', join(PNG_SIGNATURE, IDAT_1, IHDR, IEND)],
    ['a chunk type that is not four letters', join(PNG_SIGNATURE, IHDR, chunk('ID4T'), IEND)],
    ['a chunk longer than the file', join(PNG_SIGNATURE, IHDR, IDAT_1.subarray(0, 10))],
    ['a wrong CRC', join(PNG_SIGNATURE, IHDR, IDAT_1.slice().fill(0, -4), IEND)],
    ['an unknown required chunk', join(PNG_SIGNATURE, IHDR, chunk('ABCD'), IEND)],
    ['no IEND', join(PNG_SIGNATURE, IHDR, IDAT_1)],
  ])('refuses %s', (_, bytes) => {
    expect(() => stripMetadata(bytes, 'png')).toThrow(NOT_CHECKED);
  });
});

describe('format checks', () => {
  it('refuses a file that is not the format it should be', () => {
    expect(() => stripMetadata(jpegWithMetadata(), 'png')).toThrow(
      'The image made for export is not a valid PNG file, so it was not exported.',
    );
    expect(() => stripMetadata(pngWithMetadata(), 'jpg')).toThrow('not a valid JPG file');
  });

  it('cannot list the hidden information of a file that is neither JPG nor PNG', () => {
    expect(() => findMetadata(text('GIF89a'))).toThrow(MetadataError);
  });

  it('names its error for the status line', () => {
    expect(new MetadataError('x').name).toBe('MetadataError');
  });
});

// Keep the fixture list honest: each segment the tests rely on is a real, distinct segment.
it('uses distinct test segments', () => {
  const all = [XMP, ICC, IPTC, ADOBE, APP15, COMMENT, DQT, SOF0, DHT, DRI, EOI];
  expect(new Set(all.map((part) => Buffer.from(part).toString('hex'))).size).toBe(all.length);
});
