// PRE-EXISTING (copied verbatim from the author's earlier edge-function helpers,
// before the hackathon; see README "pre-existing"). Pure helpers, no I/O.

/**
 * Normalize a string for fuzzy comparison: lowercase, trim, strip accents,
 * collapse whitespace. Pure, deterministic, exported for unit tests.
 */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The media type by the file's OWN signature — never its name nor its declared MIME (both come
 * from the sender): a PDF, a PNG or a JPEG; anything else is null and is not shown to the model.
 */
export function sniffMediaType(
  b: Uint8Array,
): "application/pdf" | "image/png" | "image/jpeg" | null {
  const starts = (sig: number[]) =>
    b.length >= sig.length && sig.every((x, i) => b[i] === x);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  return null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Greedy word wrap against the real glyph widths of the embedded font. */
export function wrapText(
  text: string,
  font: { widthOfTextAtSize: (t: string, s: number) => number },
  size: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === 0) return [""];
  const consumed = lines.join(" ");
  if (consumed.length < words.join(" ").length && lines.length === maxLines) {
    let last = lines[maxLines - 1] ?? "";
    while (
      last.length > 1 &&
      font.widthOfTextAtSize(`${last}…`, size) > maxWidth
    ) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}
