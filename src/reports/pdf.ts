// Minimal PDF writer: Helvetica/Courier text (WinAnsi) + JPEG/PNG images embedded WITHOUT decoding.
// Hand-written on purpose: pdf-lib measured 30–61 ms per report in workerd and the Workers
// free plan allows 10 ms of CPU per request (developers.cloudflare.com/workers/platform/limits).
// Output is plain text objects, no compression, no markup → nothing to inject.
import { wrapText } from "../prior/text";
import { pngIdat, type CleanImage } from "../images";

export type Block =
  | { kind: "h1" | "h2" | "p" | "small"; text: string }
  | { kind: "styled"; text: string; size: number; bold?: boolean; gap?: number; indent?: number } // explicit size/weight; indent in spaces, kept in the literal
  | { kind: "cols"; left: string; right: string; size: number } // two columns at fixed x (a simple table row)
  | { kind: "rule" } // thin full-width horizontal divider
  | { kind: "mono"; lines: string[] } // preformatted lines in Courier, written verbatim (spaces kept, no wrapping)
  | { kind: "image"; image: CleanImage; caption: string };

const A4 = { w: 595, h: 842, margin: 40 } as const;
const STYLE = { h1: [16, 2, 22], h2: [12, 2, 17], p: [10, 1, 13], small: [8, 1, 11] } as const; // size, font, leading
// Helvetica averages ≈0.5 em per glyph; 0.55 keeps lines inside the margin.
const approxFont = { widthOfTextAtSize: (t: string, s: number) => t.length * 0.55 * s };

const WINANSI: Record<string, number> = { "€": 0x80, "…": 0x85, "“": 0x93, "”": 0x94, "‘": 0x91, "’": 0x92, "–": 0x96, "—": 0x97, "•": 0x95 };

/** Unicode → WinAnsi bytes as a latin1 string, escaped for a PDF literal string. */
function pdfString(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 63;
    const byte = WINANSI[ch] ?? (code < 0x80 || (code >= 0xa0 && code <= 0xff) ? code : 63);
    const c = String.fromCharCode(byte);
    out += c === "(" || c === ")" || c === "\\" ? `\\${c}` : c;
  }
  return `(${out})`;
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function buildPdf(blocks: Block[], page: { w: number; h: number; margin: number } = A4): Uint8Array {
  const PAGE_W = page.w;
  const PAGE_H = page.h;
  const MARGIN = page.margin;
  const TEXT_W = PAGE_W - 2 * MARGIN;
  const pages: string[][] = [[]];
  const images: { obj: string; data: Uint8Array }[] = [];
  let y = PAGE_H - MARGIN;
  const newPage = () => {
    pages.push([]);
    y = PAGE_H - MARGIN;
  };
  const line = (text: string, size: number, font: number, leading: number) => {
    if (y - leading < MARGIN) newPage();
    y -= leading;
    pages[pages.length - 1]?.push(`BT /F${font} ${size} Tf ${MARGIN} ${y.toFixed(1)} Td ${pdfString(text)} Tj ET`);
  };

  for (const b of blocks) {
    if (b.kind === "styled") {
      if (b.gap) y -= b.gap;
      const leading = b.size * 1.2; // 120% line spacing (unrounded): compact enough to keep 4 meds on one half-letter page, still legible
      const pad = b.indent ? " ".repeat(b.indent) : ""; // leading spaces survive into the PDF literal (wrapText would strip them)
      const w = TEXT_W - (b.indent ? b.indent * 0.55 * b.size : 0);
      for (const l of wrapText(b.text, approxFont, b.size, w, 200)) line(pad + l, b.size, b.bold ? 2 : 1, leading);
      continue;
    }
    if (b.kind === "cols") {
      const leading = b.size * 1.2;
      if (y - leading < MARGIN) newPage();
      y -= leading;
      const midX = MARGIN + TEXT_W / 2;
      pages[pages.length - 1]?.push(`BT /F1 ${b.size} Tf ${MARGIN} ${y.toFixed(1)} Td ${pdfString(b.left)} Tj ET`, `BT /F1 ${b.size} Tf ${midX.toFixed(1)} ${y.toFixed(1)} Td ${pdfString(b.right)} Tj ET`);
      continue;
    }
    if (b.kind === "mono") {
      for (const l of b.lines) line(l, 9, 3, 11); // 32 cols x 0.6 em x 9 pt = 172.8 pt, inside the 80 mm ticket
      continue;
    }
    if (b.kind === "rule") {
      y -= 5;
      if (y < MARGIN) newPage();
      pages[pages.length - 1]?.push(`${MARGIN} ${y.toFixed(1)} m ${(MARGIN + TEXT_W).toFixed(1)} ${y.toFixed(1)} l 0.6 w S`);
      y -= 7;
      continue;
    }
    if (b.kind === "image") {
      const { image } = b;
      const scale = Math.min(TEXT_W / image.width, 300 / image.height, 1);
      const w = image.width * scale;
      const h = image.height * scale;
      if (y - h - 14 < MARGIN) newPage();
      y -= h;
      const n = images.length + 1;
      const gray = image.mime === "image/png" ? image.pngColorType === 0 : image.jpegComponents === 1;
      const data = image.mime === "image/png" ? pngIdat(image.bytes) : image.bytes;
      const filter =
        image.mime === "image/png"
          ? `/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${gray ? 1 : 3} /BitsPerComponent 8 /Columns ${image.width} >>`
          : "/Filter /DCTDecode";
      images.push({
        obj: `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${gray ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 ${filter} /Length ${data.length} >>`,
        data,
      });
      pages[pages.length - 1]?.push(`q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${MARGIN} ${y.toFixed(1)} cm /Im${n} Do Q`);
      if (b.caption) line(b.caption, 8, 1, 11);
      y -= 6;
      continue;
    }
    const [size, font, leading] = STYLE[b.kind];
    if (b.kind !== "p" && b.kind !== "small") y -= 4;
    for (const l of wrapText(b.text, approxFont, size, TEXT_W, 200)) line(l, size, font, leading);
  }

  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, 5 F3 (Courier), then per page (page, content), then images.
  const objs: (string | Uint8Array)[][] = [];
  const add = (parts: (string | Uint8Array)[]) => objs.push(parts) && objs.length;
  add(["<< /Type /Catalog /Pages 2 0 R >>"]);
  const pagesIdx = add(["PLACEHOLDER"]) - 1;
  add(["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]);
  add(["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"]);
  add(["<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"]);
  const imageRefs = images.map(() => 0);
  const pageIds: number[] = [];
  const xobjects = () => imageRefs.map((id, i) => `/Im${i + 1} ${id} 0 R`).join(" ");
  // Images first so pages can reference them.
  images.forEach((im, i) => {
    imageRefs[i] = add([`${im.obj}\nstream\n`, im.data, "\nendstream"]);
  });
  for (const ops of pages) {
    const content = ops.join("\n");
    const contentId = add([`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    pageIds.push(
      add([
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> /XObject << ${xobjects()} >> >> /Contents ${contentId} 0 R >>`,
      ]),
    );
  }
  objs[pagesIdx] = [`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`];

  const chunks: Uint8Array[] = [latin1("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  const offsets: number[] = [];
  let pos = chunks[0]?.length ?? 0;
  objs.forEach((parts, i) => {
    offsets.push(pos);
    const all = [latin1(`${i + 1} 0 obj\n`), ...parts.map((p) => (typeof p === "string" ? latin1(p) : p)), latin1("\nendobj\n")];
    for (const c of all) {
      chunks.push(c);
      pos += c.length;
    }
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(latin1(xref));
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
