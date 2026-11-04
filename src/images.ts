// Image intake without decoding: type by byte signature (never by name/MIME), metadata
// stripped structurally. JPEG keeps only the segments a decoder needs; PNG keeps only
// critical chunks (+PLTE/tRNS). Nothing is ever decompressed, so there is no decompression
// bomb to defend against here.
import { sniffMediaType } from "./prior/text";

export class ImageError extends Error {
  constructor(message: string, readonly status: 413 | 415) {
    super(message);
    this.name = "ImageError";
  }
}

export interface CleanImage {
  mime: "image/jpeg" | "image/png";
  bytes: Uint8Array;
  width: number;
  height: number;
  /** PNG only: 8-bit grey/RGB, non-interlaced → embeddable in the PDF without decoding. */
  pngColorType?: 0 | 2;
  /** JPEG only: 1 = grey, 3 = YCbCr/RGB (CMYK is refused). */
  jpegComponents?: 1 | 3;
}

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function cleanImage(input: Uint8Array): CleanImage {
  if (input.length > MAX_IMAGE_BYTES) throw new ImageError("too large", 413);
  const kind = sniffMediaType(input);
  if (kind === "image/jpeg") return stripJpeg(input);
  if (kind === "image/png") return stripPng(input);
  throw new ImageError("unsupported image", 415);
}

const be16 = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const be32 = (b: Uint8Array, i: number) => ((be16(b, i) << 16) | be16(b, i + 2)) >>> 0;

function stripJpeg(b: Uint8Array): CleanImage {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let width = 0;
  let height = 0;
  let components: 1 | 3 | undefined;
  let sawEoi = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new ImageError("corrupt jpeg", 415);
    const marker = b[i + 1] ?? 0;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = be16(b, i + 2);
    if (len < 2 || i + 2 + len > b.length) throw new ImageError("corrupt jpeg", 415);
    const segment = b.subarray(i, i + 2 + len);
    const isApp = marker >= 0xe0 && marker <= 0xef && marker !== 0xee; // APP14 (Adobe) decides colour transform; keep it
    const isComment = marker === 0xfe;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      height = be16(b, i + 5);
      width = be16(b, i + 7);
      const n = b[i + 9];
      if (n === 1 || n === 3) components = n;
    }
    if (!isApp && !isComment) out.push(segment);
    i += 2 + len;
    if (marker === 0xda) {
      // Entropy-coded data: runs until the next real marker (0xFF followed by neither 0x00 nor RSTn).
      const start = i;
      while (i + 1 < b.length && !(b[i] === 0xff && b[i + 1] !== 0x00 && !((b[i + 1] ?? 0) >= 0xd0 && (b[i + 1] ?? 0) <= 0xd7))) i += 1;
      out.push(b.subarray(start, i));
      if (b[i + 1] === 0xd9) {
        out.push(new Uint8Array([0xff, 0xd9]));
        sawEoi = true;
        break; // anything after EOI (motion-photo video, MPF secondary images) is dropped
      }
    }
  }
  if (!sawEoi) throw new ImageError("corrupt jpeg", 415);
  if (!width || !height) throw new ImageError("corrupt jpeg", 415);
  if (!components) throw new ImageError("jpeg must be grey or colour (no CMYK)", 415);
  return { mime: "image/jpeg", bytes: concat(out), width, height, jpegComponents: components };
}

const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

function stripPng(b: Uint8Array): CleanImage {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let width = 0;
  let height = 0;
  let colorType: 0 | 2 | undefined;
  let sawEnd = false;
  while (i + 12 <= b.length) {
    const len = be32(b, i);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > b.length) throw new ImageError("corrupt png", 415);
    if (type === "IHDR") {
      width = be32(b, i + 8);
      height = be32(b, i + 12);
      const depth = b[i + 16];
      const ct = b[i + 17];
      const interlace = b[i + 20];
      if (depth === 8 && (ct === 0 || ct === 2) && interlace === 0) colorType = ct;
    }
    if (PNG_KEEP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || !width || !height) throw new ImageError("corrupt png", 415);
  if (colorType === undefined) throw new ImageError("png must be 8-bit grey or RGB without alpha or interlace; use JPEG", 415);
  return { mime: "image/png", bytes: concat(out), width, height, pngColorType: colorType };
}

/** Raw IDAT payload (zlib stream) of an already-cleaned PNG, for /FlateDecode embedding. */
export function pngIdat(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = be32(b, i);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    if (type === "IDAT") parts.push(b.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
