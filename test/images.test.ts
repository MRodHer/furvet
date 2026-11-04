import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cleanImage, ImageError } from "../src/images";
import { buildPdf } from "../src/reports/pdf";
import { count, doctorEnv, doctorHeaders, fakeJpeg, makeApp, multipart, paypalFakes, seedConsult, withEnv } from "./helpers";

const ascii = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("images (V15, D.6)", () => {
  it("JPEG with an APP1 Exif segment is stored without it; dimensions survive", () => {
    const out = cleanImage(fakeJpeg(true));
    expect(ascii(fakeJpeg(true))).toContain("Exif");
    expect(ascii(out.bytes)).not.toContain("Exif");
    expect(out).toMatchObject({ mime: "image/jpeg", width: 2, height: 2, jpegComponents: 3 });
    expect(out.bytes.length).toBe(fakeJpeg(false).length);
  });

  it("M3: metadata after the first scan (APP1 between scans, data after EOI) is dropped too", () => {
    const base = fakeJpeg(false);
    const body = base.subarray(0, base.length - 2); // without EOI
    const app1 = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
    const sos2 = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x56, 0x78];
    const progressive = new Uint8Array([...body, ...app1, ...sos2, 0xff, 0xd9, ...fakeJpeg(true)]); // trailing "motion photo"
    const out = cleanImage(progressive);
    expect(ascii(out.bytes)).not.toContain("Exif");
    expect(out.bytes[out.bytes.length - 2]).toBe(0xff);
    expect(out.bytes[out.bytes.length - 1]).toBe(0xd9);
    expect(() => cleanImage(body)).toThrow(expect.objectContaining({ status: 415 })); // no EOI → corrupt
  });

  it("the type comes from the bytes: a PDF or an .exe named .jpg → 415; > 2 MB → 413", () => {
    expect(() => cleanImage(new TextEncoder().encode("%PDF-1.4 ..."))).toThrow(ImageError);
    expect(() => cleanImage(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toThrow(expect.objectContaining({ status: 415 }));
    expect(() => cleanImage(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow(expect.objectContaining({ status: 413 }));
  });

  it("PNG: text/eXIf chunks dropped, only 8-bit grey/RGB non-interlaced accepted", () => {
    const chunk = (type: string, data: number[]) => {
      const len = [(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255];
      return [...len, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
    };
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdr = (colorType: number) => chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, colorType, 0, 0, 0]);
    const rgb = new Uint8Array([...sig, ...ihdr(2), ...chunk("eXIf", [1, 2, 3]), ...chunk("tEXt", [0x47, 0x50, 0x53]), ...chunk("IDAT", [0x78, 0x01]), ...chunk("IEND", [])]);
    const out = cleanImage(rgb);
    expect(ascii(out.bytes)).not.toContain("eXIf");
    expect(ascii(out.bytes)).not.toContain("tEXt");
    expect(out.pngColorType).toBe(2);
    const rgba = new Uint8Array([...sig, ...ihdr(6), ...chunk("IDAT", [0x78, 0x01]), ...chunk("IEND", [])]);
    expect(() => cleanImage(rgba)).toThrow(expect.objectContaining({ status: 415 }));
  });

  it("the PDF embeds the cleaned JPEG as DCTDecode and stays a valid file", () => {
    const pdf = buildPdf([{ kind: "h1", text: "Informe — Firulais ñandú" }, { kind: "image", image: cleanImage(fakeJpeg()), caption: "oído derecho" }]);
    const s = ascii(pdf);
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s).toContain("/DCTDecode");
    expect(s).toContain("/Im1");
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(s).not.toContain("Exif");
  });

  it("POST /images: 401 without auth, 503 without credential, 415/413 by bytes, 5th → 409, after approval → 409", async () => {
    const { consult } = await seedConsult();
    const { app } = makeApp(paypalFakes());
    const url = `/api/v1/consults/${consult}/images`;
    const post = (body: FormData, e = doctorEnv(), headers: Record<string, string> = doctorHeaders()) => app.request(url, { method: "POST", headers, body }, e);

    expect((await post(multipart(fakeJpeg(), "a.jpg"), doctorEnv(), {})).status).toBe(401);
    expect((await post(multipart(fakeJpeg(), "a.jpg"), withEnv({ DOCTOR_DEMO_USER: "val", DOCTOR_DEMO_PASSWORD: "" }))).status).toBe(503);
    expect((await post(multipart(new Uint8Array([0x4d, 0x5a, 0, 0]), "virus.jpg"))).status).toBe(415);
    expect((await post(multipart(new Uint8Array(3 * 1024 * 1024), "big.jpg"))).status).toBe(413);

    for (let i = 1; i <= 4; i += 1) {
      const res = await post(multipart(fakeJpeg(), `${i}.jpg`, `foto ${i}`));
      expect(res.status, `image ${i}`).toBe(201);
    }
    expect((await post(multipart(fakeJpeg(), "5.jpg"))).status).toBe(409);
    const stored = await env.DB.prepare("SELECT r2_key FROM report_images WHERE consult_id = ?1 ORDER BY position").bind(consult).all<{ r2_key: string }>();
    expect(stored.results).toHaveLength(4);
    const obj = await env.FILES.get(stored.results[0]!.r2_key);
    expect(ascii(new Uint8Array(await obj!.arrayBuffer()))).not.toContain("Exif");

    // After approval: a consult with 0 images (so the 409 comes from the bill, not from the position UNIQUE).
    const approved = await seedConsult();
    await env.DB.prepare("INSERT INTO consult_bills (consult_id, approval_id, total_cents, deposit_cents, balance_cents, approved_by) VALUES (?1, ?2, 1, 0, 1, 'val')").bind(approved.consult, crypto.randomUUID()).run();
    expect((await app.request(`/api/v1/consults/${approved.consult}/images`, { method: "POST", headers: doctorHeaders(), body: multipart(fakeJpeg(), "late.jpg") }, doctorEnv())).status).toBe(409);
    expect(await count("report_images", "consult_id = ?1", approved.consult)).toBe(0);
  });
});
