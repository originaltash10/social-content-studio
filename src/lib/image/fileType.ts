/**
 * Works out what a dropped file really is from its first bytes, and decides whether the import
 * panel takes it. This step imports JPG, PNG and HEIC/HEIF photos only.
 *
 * The contents win over the file name:
 * - Contents are a supported photo: it is imported as what the contents say. If the name's
 *   extension says something else, the result carries a `note` for the user. The file name
 *   itself is never changed.
 * - Contents are a video (MP4 or MOV): rejected with the "video arrives later" message,
 *   whatever the name says.
 * - Contents are a known image type the app does not take (AVIF, GIF, WebP): rejected with a
 *   "convert first" message that names the type.
 * - Contents are not recognised: the name decides the wording only. A photo extension means the
 *   file is probably damaged; a video extension gets the video message; anything else is an
 *   unsupported file.
 *
 * Pure apart from `sniffFile`, which reads the first bytes of a file.
 */

export type ImageFormat = 'jpeg' | 'png' | 'heic';

export type RejectReason = 'video' | 'unsupported' | 'empty' | 'damaged';

export type FileType =
  | {
      kind: 'image';
      format: ImageFormat;
      /** Set when name and contents disagree. */ note?: string;
    }
  | { kind: 'rejected'; reason: RejectReason; message: string };

/** How much of a file is read to identify it. Enough for a long list of ISO brands. */
export const HEAD_BYTES = 4096;

/** What users call each format. */
export const FORMAT_LABEL: Record<ImageFormat, string> = { jpeg: 'JPG', png: 'PNG', heic: 'HEIC' };

const EXTENSION_FORMAT: Record<string, ImageFormat> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  heic: 'heic',
  heif: 'heic',
};

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v'];

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * ISO base media ("ftyp") brands. HEIF, AVIF, MP4 and MOV all share this container, and are
 * told apart by the brands the file lists.
 *
 * AVIF is checked before HEIF: an AVIF file usually lists the generic HEIF brands (mif1, miaf)
 * as well, and must never be handed to the HEIC decoder.
 */
const AVIF_BRANDS = ['avif', 'avis'];
const HEIF_BRANDS = [
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
];
const VIDEO_BRANDS = [
  'isom',
  'mp41',
  'mp42',
  'avc1',
  'qt  ',
  'M4V ',
  'M4VH',
  'M4VP',
  'mmp4',
  'dash',
];
const VIDEO_BRAND_PREFIXES = ['iso', '3gp', '3g2'];
/** Same container, not video: audio-only MP4 and Canon raw photos. */
const NOT_VIDEO_MAJOR_BRANDS = ['M4A ', 'M4B ', 'M4P ', 'crx '];
/** First-atom types of old QuickTime .mov files, which have no "ftyp" atom. */
const QUICKTIME_ATOMS = ['moov', 'mdat', 'wide'];

type Sniffed =
  | { kind: 'image'; format: ImageFormat }
  | { kind: 'video' }
  | { kind: 'other'; label: string }
  | { kind: 'unknown' };

function startsWith(head: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, i) => head[i] === byte);
}

function ascii(head: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...head.subarray(start, end));
}

/** The brands in a leading "ftyp" atom, major brand first, or null when there is none. */
function ftypBrands(head: Uint8Array): string[] | null {
  if (ascii(head, 4, 8) !== 'ftyp') return null;
  const declared = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
  // A size under 16 is not a real brand list (0 and 1 mean "to end of file" and "64-bit size").
  const end = declared >= 16 ? Math.min(declared, head.length) : head.length;
  const brands = [ascii(head, 8, 12)];
  // Bytes 12..16 are the minor version; the compatible brands follow.
  for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(head, at, at + 4));
  return brands;
}

function isVideoBrand(brand: string): boolean {
  return VIDEO_BRANDS.includes(brand) || VIDEO_BRAND_PREFIXES.some((p) => brand.startsWith(p));
}

/** Identifies the contents from the first bytes alone. */
function sniff(head: Uint8Array): Sniffed {
  if (startsWith(head, JPEG_SIGNATURE)) return { kind: 'image', format: 'jpeg' };
  if (startsWith(head, PNG_SIGNATURE)) return { kind: 'image', format: 'png' };

  const brands = ftypBrands(head);
  if (brands) {
    if (brands.some((brand) => AVIF_BRANDS.includes(brand))) {
      return { kind: 'other', label: 'an AVIF image' };
    }
    if (brands.some((brand) => HEIF_BRANDS.includes(brand))) {
      return { kind: 'image', format: 'heic' };
    }
    const major = brands[0] as string;
    if (!NOT_VIDEO_MAJOR_BRANDS.includes(major) && brands.some(isVideoBrand)) {
      return { kind: 'video' };
    }
    return { kind: 'unknown' };
  }

  if (QUICKTIME_ATOMS.includes(ascii(head, 4, 8))) return { kind: 'video' };
  if (ascii(head, 0, 4) === 'GIF8') return { kind: 'other', label: 'a GIF image' };
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') {
    return { kind: 'other', label: 'a WebP image' };
  }
  return { kind: 'unknown' };
}

/** The lowercase extension without the dot, or '' when the name has none. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

const CONVERT_FIRST = 'Convert it to JPG or PNG first.';

/**
 * Decides what to do with a file, from its first bytes (`head`), its name and its size.
 * See the top of this file for what happens when the name and the contents disagree.
 */
export function detectFileType(head: Uint8Array, fileName: string, size: number): FileType {
  if (size === 0) {
    return {
      kind: 'rejected',
      reason: 'empty',
      message:
        `"${fileName}" is empty (0 bytes). It may not have finished copying or downloading. ` +
        'Try again with the original file.',
    };
  }

  const extension = extensionOf(fileName);
  const sniffed = sniff(head);

  if (sniffed.kind === 'image') {
    const label = FORMAT_LABEL[sniffed.format];
    if (extension === '' || EXTENSION_FORMAT[extension] === sniffed.format) {
      return { kind: 'image', format: sniffed.format };
    }
    return {
      kind: 'image',
      format: sniffed.format,
      note:
        `"${fileName}" is named .${extension} but is really a ${label} photo. ` +
        `It is imported as ${label}; the file name is left as it is.`,
    };
  }

  const namedAsVideo = VIDEO_EXTENSIONS.includes(extension);
  if (sniffed.kind === 'video' || (sniffed.kind === 'unknown' && namedAsVideo)) {
    // Only worth a remark when the name claims to be a photo.
    const mismatch = EXTENSION_FORMAT[extension]
      ? ` (It is named .${extension}, but its contents are a video.)`
      : '';
    return {
      kind: 'rejected',
      reason: 'video',
      message:
        `"${fileName}" is a video, so it was not imported. Video support arrives in a later ` +
        `phase; for now only JPG, PNG and HEIC photos can be imported.${mismatch}`,
    };
  }

  if (sniffed.kind === 'other') {
    return {
      kind: 'rejected',
      reason: 'unsupported',
      message: `"${fileName}" is ${sniffed.label}, which is an unsupported file type here. ${CONVERT_FIRST}`,
    };
  }

  const namedAs = EXTENSION_FORMAT[extension];
  if (namedAs) {
    return {
      kind: 'rejected',
      reason: 'damaged',
      message:
        `"${fileName}" is named like a ${FORMAT_LABEL[namedAs]} photo, but its contents are not ` +
        'a JPG, PNG or HEIC image. The file may be damaged, or it may be a different kind of ' +
        'file with the wrong name. Open it in a photo app, save it as JPG or PNG, and try again.',
    };
  }

  return {
    kind: 'rejected',
    reason: 'unsupported',
    message:
      `"${fileName}" is an unsupported file. Only JPG, PNG and HEIC photos can be imported. ` +
      CONVERT_FIRST,
  };
}

/** Reads the first bytes of `blob` and decides what to do with it. */
export async function sniffBlob(blob: Blob, fileName: string): Promise<FileType> {
  const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
  return detectFileType(head, fileName, blob.size);
}

/** Reads the first bytes of `file` and decides what to do with it. */
export function sniffFile(file: File): Promise<FileType> {
  return sniffBlob(file, file.name);
}
