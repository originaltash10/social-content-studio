/**
 * Reads a rendered or exported picture in the page and says whether its padding is right, for
 * the editor and export checks. A card whose crop is larger than its photo has padding in the
 * card's background colour around the photo; this looks at every pixel of the picture.
 *
 * Where the photo should be is worked out from the crop alone (fractions of the photo, as the
 * editor shows them). Rounding the crop to whole photo pixels can move an edge by one output
 * pixel, so the pixels within one pixel of an expected edge are judged by neither rule.
 *
 * PNG is lossless, so its padding must be the colour exactly. JPG is lossy: more than
 * JPG_EDGE_PX pixels from the photo each channel must be within JPG_FAR_TOLERANCE of the
 * colour, and nearer than that, where a JPG smears colour across an edge, within
 * JPG_NEAR_TOLERANCE.
 *
 * It also counts the pixels of the photo that would pass for padding: those within
 * JPG_NEAR_TOLERANCE of the colour, the looser of the two rules. A check that wants that count
 * to be zero uses a colour at least PHOTO_MIN_DIFFERENCE from every colour in its photo, in
 * some channel, so the photo cannot come close to it.
 */

export const JPG_EDGE_PX = 16;
export const JPG_FAR_TOLERANCE = 4;
export const JPG_NEAR_TOLERANCE = 24;
export const PHOTO_MIN_DIFFERENCE = 128;

const LIMITS = { JPG_EDGE_PX, JPG_FAR_TOLERANCE, JPG_NEAR_TOLERANCE };

/** "#rrggbb" as [red, green, blue]. */
export const rgbOf = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

/**
 * Runs in the page. `source` is the picture's address (`url`) or its bytes (`base64`); `crop`
 * is the card's crop in fractions of the photo; `colour` is [red, green, blue].
 */
async function measureInPage({ source, crop, colour, limits }) {
  let blob;
  if (source.url) blob = await (await fetch(source.url)).blob();
  else {
    const binary = atob(source.base64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    blob = new Blob([data]);
  }
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  const type =
    head[0] === 0xff && head[1] === 0xd8
      ? 'jpg'
      : head[0] === 0x89 && head[1] === 0x50
        ? 'png'
        : 'other';
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = g.getImageData(0, 0, width, height);

  const photo = {
    left: Math.max(0, Math.round((-crop.x / crop.width) * width)),
    right: Math.min(width, Math.round(((1 - crop.x) / crop.width) * width)),
    top: Math.max(0, Math.round((-crop.y / crop.height) * height)),
    bottom: Math.min(height, Math.round(((1 - crop.y) / crop.height) * height)),
  };
  const png = type === 'png';
  const far = png ? 0 : limits.JPG_FAR_TOLERANCE;
  const near = png ? 0 : limits.JPG_NEAR_TOLERANCE;
  const report = {
    type,
    width,
    height,
    photo,
    paddingPixels: 0,
    wrongPadding: 0,
    firstWrong: '',
    notOpaque: 0,
    worstFar: 0,
    worstNear: 0,
    photoLikePadding: 0,
    firstPhotoLikePadding: '',
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const distance = Math.max(
        Math.abs(data[at] - colour[0]),
        Math.abs(data[at + 1] - colour[1]),
        Math.abs(data[at + 2] - colour[2]),
      );
      // How far outside the photo this pixel is; negative when it is inside.
      const outside = Math.max(
        photo.left - x,
        x - (photo.right - 1),
        photo.top - y,
        y - (photo.bottom - 1),
      );
      if (outside > 1) {
        report.paddingPixels += 1;
        const isFar = outside > limits.JPG_EDGE_PX + 1;
        if (isFar) report.worstFar = Math.max(report.worstFar, distance);
        else report.worstNear = Math.max(report.worstNear, distance);
        if (data[at + 3] !== 255) report.notOpaque += 1;
        if (distance > (isFar ? far : near)) {
          report.wrongPadding += 1;
          report.firstWrong ||= `(${x}, ${y}) is ${distance} from the colour`;
        }
      } else if (outside < -(limits.JPG_EDGE_PX + 1) && distance <= limits.JPG_NEAR_TOLERANCE) {
        report.photoLikePadding += 1;
        report.firstPhotoLikePadding ||= `(${x}, ${y}) is only ${distance} from the colour`;
      }
    }
  }
  return report;
}

/** Measures a picture in the page: see the top of this file. */
export function measurePadding(page, source, crop, colour) {
  return page.evaluate(measureInPage, { source, crop, colour, limits: LIMITS });
}

/**
 * True when the picture has padding, all of it is the colour, and (unless `photoMayMatch`, for
 * a colour the photo also contains) no pixel of the photo is.
 */
export function paddingOk(report, { photoMayMatch = false } = {}) {
  return (
    report.paddingPixels > report.width &&
    report.wrongPadding === 0 &&
    report.notOpaque === 0 &&
    (photoMayMatch || report.photoLikePadding === 0)
  );
}

export function describePadding(report) {
  const { photo } = report;
  const where = `photo at x ${photo.left} to ${photo.right}, y ${photo.top} to ${photo.bottom}`;
  const rule =
    report.type === 'png'
      ? 'exact'
      : `within ${JPG_FAR_TOLERANCE} away from the photo and ${JPG_NEAR_TOLERANCE} within ${JPG_EDGE_PX} px of it`;
  return (
    `${report.type}, ${report.width} × ${report.height}, ${where}; ${report.paddingPixels} ` +
    `padding pixels, ${report.wrongPadding} wrong (${rule}; largest difference ` +
    `${report.worstFar} away, ${report.worstNear} near)` +
    (report.firstWrong ? `; first: ${report.firstWrong}` : '') +
    (report.notOpaque ? `; ${report.notOpaque} not opaque` : '') +
    (report.photoLikePadding
      ? `; ${report.photoLikePadding} photo pixels look like padding, first: ${report.firstPhotoLikePadding}`
      : '')
  );
}
