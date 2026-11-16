import { describe, expect, it } from 'vitest';
import { HEAD_BYTES, detectFileType, sniffFile } from './fileType';
import type { FileType } from './fileType';

const text = (value: string) => [...value].map((char) => char.charCodeAt(0));

const JPEG = [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const GIF = text('GIF89a\x01\x00\x01\x00');
const WEBP = [...text('RIFF'), 0x24, 0, 0, 0, ...text('WEBPVP8 ')];
const NONSENSE = text('This is just some text, not a picture.');

/** An ISO "ftyp" atom: size, "ftyp", major brand, minor version, compatible brands. */
function ftyp(major: string, compatible: string[] = [], declaredSize?: number): number[] {
  const size = declaredSize ?? 16 + compatible.length * 4;
  return [
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...text('ftyp'),
    ...text(major),
    0,
    0,
    0,
    0,
    ...compatible.flatMap(text),
  ];
}

/** An old QuickTime file: no ftyp, the first atom is `type`. */
const atom = (type: string) => [0, 0, 0, 8, ...text(type), 0, 0, 0, 0];

function detect(bytes: number[], fileName: string): FileType {
  return detectFileType(new Uint8Array(bytes), fileName, bytes.length);
}

function expectImage(result: FileType, format: string) {
  expect(result).toMatchObject({ kind: 'image', format });
}

function expectRejected(result: FileType, reason: string): string {
  expect(result).toMatchObject({ kind: 'rejected', reason });
  return (result as { message: string }).message;
}

describe('photos whose name matches their contents', () => {
  it.each([
    ['site.jpg', JPEG, 'jpeg'],
    ['site.JPEG', JPEG, 'jpeg'],
    ['logo.png', PNG, 'png'],
    ['IMG_0001.HEIC', ftyp('heic', ['mif1', 'heic']), 'heic'],
    ['IMG_0001.heif', ftyp('mif1', ['mif1', 'heic']), 'heic'],
  ])('%s is imported without a note', (fileName, bytes, format) => {
    const result = detect(bytes, fileName);
    expect(result).toEqual({ kind: 'image', format });
  });

  it('imports a photo that has no extension, without a note', () => {
    expect(detect(JPEG, 'photo')).toEqual({ kind: 'image', format: 'jpeg' });
    // A leading dot is a hidden file, not an extension.
    expect(detect(PNG, '.png')).toEqual({ kind: 'image', format: 'png' });
  });
});

describe('HEIC and HEIF brands', () => {
  it.each(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1'])(
    'recognises major brand %s',
    (brand) => {
      expectImage(detect(ftyp(brand), 'photo.heic'), 'heic');
    },
  );

  it('recognises a HEIF brand that appears only in the compatible list', () => {
    expectImage(detect(ftyp('miaf', ['miaf', 'heic']), 'photo.heic'), 'heic');
  });

  it('reads brands when the atom declares no usable size', () => {
    expectImage(detect(ftyp('xxxx', ['heic'], 0), 'photo.heic'), 'heic');
    expectImage(detect(ftyp('xxxx', ['heic'], 1), 'photo.heic'), 'heic');
  });

  it('stops reading brands at the end of the ftyp atom', () => {
    // "heic" sits just after an atom that only lists a video brand, so it is not a brand.
    const bytes = [...ftyp('isom', ['mp42']), ...text('heic')];
    expectRejected(detect(bytes, 'clip.mp4'), 'video');
  });

  it('copes with an atom that claims to be longer than the bytes that were read', () => {
    expectImage(detect(ftyp('heic', ['mif1'], 100_000), 'photo.heic'), 'heic');
  });

  it('ignores a partial brand at the end of the bytes', () => {
    const bytes = [...ftyp('isom', [], 24), ...text('he')];
    expectRejected(detect(bytes, 'clip.mp4'), 'video');
  });
});

describe('AVIF is checked before HEIF', () => {
  it('imports a HEIF file that lists mif1', () => {
    expectImage(detect(ftyp('heic', ['mif1', 'miaf', 'heic']), 'IMG_1.heic'), 'heic');
  });

  it('rejects an AVIF file that also lists mif1 and miaf, so it never reaches the HEIC decoder', () => {
    const message = expectRejected(
      detect(ftyp('avif', ['avif', 'mif1', 'miaf']), 'photo.avif'),
      'unsupported',
    );
    expect(message).toBe(
      '"photo.avif" is an AVIF image, which is an unsupported file type here. ' +
        'Convert it to JPG or PNG first.',
    );
  });

  it('rejects AVIF when mif1 is the major brand and avif is only a compatible brand', () => {
    expectRejected(detect(ftyp('mif1', ['mif1', 'avif', 'miaf']), 'photo.avif'), 'unsupported');
  });

  it('rejects an AVIF sequence (avis), including one named .heic', () => {
    const message = expectRejected(
      detect(ftyp('avis', ['avis', 'msf1', 'miaf']), 'burst.heic'),
      'unsupported',
    );
    expect(message).toContain('an AVIF image');
  });
});

describe('when the name and the contents disagree, the contents win', () => {
  it('imports a HEIC that is named .jpg as HEIC, with a note', () => {
    expect(detect(ftyp('heic', ['mif1']), 'IMG_2.jpg')).toEqual({
      kind: 'image',
      format: 'heic',
      note:
        '"IMG_2.jpg" is named .jpg but is really a HEIC photo. ' +
        'It is imported as HEIC; the file name is left as it is.',
    });
  });

  it('imports a JPG that is named .png as JPG, with a note', () => {
    const result = detect(JPEG, 'logo.png');
    expectImage(result, 'jpeg');
    expect(result).toHaveProperty('note', expect.stringContaining('really a JPG photo'));
  });

  it('imports a PNG with an unrelated extension, with a note', () => {
    const result = detect(PNG, 'export.dat');
    expectImage(result, 'png');
    expect(result).toHaveProperty('note', expect.stringContaining('named .dat'));
  });

  it('imports a photo that is named like a video', () => {
    const result = detect(JPEG, 'still.mp4');
    expectImage(result, 'jpeg');
    expect(result).toHaveProperty('note', expect.stringContaining('named .mp4'));
  });

  it('rejects a video that is named like a photo, and says why', () => {
    const message = expectRejected(detect(ftyp('isom', ['isom', 'mp42']), 'clip.jpg'), 'video');
    expect(message).toContain('(It is named .jpg, but its contents are a video.)');
  });

  it('rejects a GIF or WebP that is named like a photo, naming the real type', () => {
    expect(expectRejected(detect(GIF, 'anim.jpg'), 'unsupported')).toContain('a GIF image');
    expect(expectRejected(detect(WEBP, 'pic.png'), 'unsupported')).toContain('a WebP image');
  });
});

describe('video', () => {
  const VIDEO_MESSAGE =
    'is a video, so it was not imported. Video support arrives in a later phase; ' +
    'for now only JPG, PNG and HEIC photos can be imported.';

  it.each([
    ['clip.mp4', ftyp('isom', ['isom', 'iso2', 'avc1', 'mp41'])],
    ['clip.mp4', ftyp('mp42', ['mp42', 'isom'])],
    ['clip.MOV', ftyp('qt  ', ['qt  '])],
    ['clip.m4v', ftyp('M4V ', ['M4V ', 'mp42'])],
    ['clip.3gp', ftyp('3gp4', ['3gp4'])],
    ['clip.mp4', ftyp('iso5', ['dash'])],
    ['old.mov', atom('moov')],
    ['old.mov', atom('mdat')],
    ['old.mov', atom('wide')],
  ])('rejects %s with the video message', (fileName, bytes) => {
    const message = expectRejected(detect(bytes, fileName), 'video');
    expect(message).toBe(`"${fileName}" ${VIDEO_MESSAGE}`);
  });

  it('rejects a video with no extension without a mismatch remark', () => {
    const message = expectRejected(detect(ftyp('mp42'), 'clip'), 'video');
    expect(message).toBe(`"clip" ${VIDEO_MESSAGE}`);
  });

  it('gives the video message to a file named .mp4 or .mov whose contents are not recognised', () => {
    expectRejected(detect(NONSENSE, 'clip.mp4'), 'video');
    expectRejected(detect(atom('free'), 'clip.mov'), 'video');
    expectRejected(detect(ftyp('zzzz'), 'clip.m4v'), 'video');
  });

  it('does not call audio-only MP4 or Canon raw files video', () => {
    for (const [fileName, major] of [
      ['song.m4a', 'M4A '],
      ['book.m4b', 'M4B '],
      ['raw.cr3', 'crx '],
    ] as const) {
      expectRejected(detect(ftyp(major, ['isom', 'mp42']), fileName), 'unsupported');
    }
  });
});

describe('unsupported, damaged and empty files', () => {
  it('rejects other image types by name', () => {
    expect(expectRejected(detect(GIF, 'anim.gif'), 'unsupported')).toBe(
      '"anim.gif" is a GIF image, which is an unsupported file type here. ' +
        'Convert it to JPG or PNG first.',
    );
    expect(expectRejected(detect(WEBP, 'pic.webp'), 'unsupported')).toContain('a WebP image');
  });

  it('does not mistake another RIFF file for WebP', () => {
    const wav = [...text('RIFF'), 0x24, 0, 0, 0, ...text('WAVEfmt ')];
    expect(expectRejected(detect(wav, 'sound.wav'), 'unsupported')).not.toContain('WebP');
  });

  it('rejects any other file with the convert-first message', () => {
    for (const fileName of ['notes.txt', 'report.pdf', 'README', 'drawing.tiff']) {
      expect(expectRejected(detect(NONSENSE, fileName), 'unsupported')).toBe(
        `"${fileName}" is an unsupported file. Only JPG, PNG and HEIC photos can be imported. ` +
          'Convert it to JPG or PNG first.',
      );
    }
  });

  it.each([
    ['broken.jpg', 'JPG'],
    ['broken.jpeg', 'JPG'],
    ['broken.png', 'PNG'],
    ['broken.heic', 'HEIC'],
    ['broken.heif', 'HEIC'],
  ])('says %s may be damaged when its contents are not an image', (fileName, label) => {
    expect(expectRejected(detect(NONSENSE, fileName), 'damaged')).toBe(
      `"${fileName}" is named like a ${label} photo, but its contents are not a JPG, PNG or ` +
        'HEIC image. The file may be damaged, or it may be a different kind of file with the ' +
        'wrong name. Open it in a photo app, save it as JPG or PNG, and try again.',
    );
  });

  it('treats a file too short to hold a signature as damaged or unsupported, by name', () => {
    expectRejected(detect([0xff, 0xd8], 'cut.jpg'), 'damaged');
    expectRejected(detect([0x00], 'cut.bin'), 'unsupported');
    expectRejected(detect(ftyp('zzzz'), 'odd.heic'), 'damaged');
  });

  it('has its own message for an empty file, whatever its name', () => {
    for (const fileName of ['empty.jpg', 'empty.mp4', 'empty.txt']) {
      expect(expectRejected(detect([], fileName), 'empty')).toBe(
        `"${fileName}" is empty (0 bytes). It may not have finished copying or downloading. ` +
          'Try again with the original file.',
      );
    }
  });
});

describe('sniffFile', () => {
  const file = (bytes: number[], name: string, type = '') =>
    new File([new Uint8Array(bytes)], name, { type });

  it('reads the first bytes of a real file', async () => {
    expectImage(await sniffFile(file(JPEG, 'site.jpg')), 'jpeg');
    expectImage(await sniffFile(file(ftyp('heic', ['mif1']), 'IMG_1.HEIC')), 'heic');
    expectRejected(await sniffFile(file(ftyp('mp42'), 'clip.mp4')), 'video');
    expectRejected(await sniffFile(file([], 'empty.png')), 'empty');
  });

  it('goes by the contents, not the type the browser reports', async () => {
    expectRejected(await sniffFile(file(NONSENSE, 'fake.jpg', 'image/jpeg')), 'damaged');
    expectImage(await sniffFile(file(PNG, 'real.png', 'video/mp4')), 'png');
  });

  it('identifies a large file from its first bytes only', async () => {
    const big = new File([new Uint8Array(PNG), new Uint8Array(HEAD_BYTES * 3)], 'big.png');
    expect(big.size).toBeGreaterThan(HEAD_BYTES);
    expectImage(await sniffFile(big), 'png');
  });
});
