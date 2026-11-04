import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { ageLabel } from "../src/reports/render";
import { approvedBody, approvedEvent, assertNoPii, captureCompletedEvent, captureLogs, claudeToolFake, doctorEnv, doctorHeaders, makeApp, NOW, paypalFakes, seedConsult, uniqueOrderFake, webhookHeaders } from "./helpers";

const fakes = (captureValue = "881.00") => ({ ...paypalFakes({ captureValue }), ...uniqueOrderFake, ...claudeToolFake(["Su perro tiene gastroenteritis leve."]) });
const PRIVATE = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };

// A name that cannot appear by any other path (clinic, drugs, template), so a «not.toContain» measures something.
const OWNER = "Zutano Quirquincho";
async function approved(captureValue = "881.00") {
  const seeded = await seedConsult();
  await env.DB.prepare("UPDATE contacts SET name = ?2 WHERE id = ?1").bind(seeded.conv, OWNER).run(); // seeded BEFORE approval: the ticket and the chat are built then
  const made = makeApp(fakes(captureValue));
  const body = approvedBody(seeded.ids, { billable: [{ catalog_item_id: seeded.ids["MED-AMOXI"], quantity: { value: 2, source: "doctor" } }] });
  body.prescription[0] = { ...body.prescription[0], catalog_item_id: undefined };
  const res = await made.app.request(`/api/v1/consults/${seeded.consult}/approve`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) }, doctorEnv());
  expect(res.status).toBe(201);
  const out = (await res.json()) as { ticket_url: string; report_url: string; balance_cents: number };
  // M6-b4: before «Generar cobro» the report gate is a 402 WITHOUT a pay link, never a 200.
  const early = await made.app.request(new URL(out.report_url).pathname, {}, doctorEnv());
  expect(early.status).toBe(402);
  expect(await early.text()).not.toContain("sandbox.paypal.com");
  expect((await made.app.request(`/api/v1/consults/${seeded.consult}/charge`, { method: "POST", headers: doctorHeaders() }, doctorEnv())).status).toBe(201);
  const charge = await env.DB.prepare("SELECT id, paypal_order_id FROM charges WHERE consult_id = ?1").bind(seeded.consult).first<{ id: string; paypal_order_id: string }>();
  const msgCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1").bind(seeded.conv).first<{ n: number }>())!.n;
  const get = (url: string) => made.app.request(new URL(url).pathname, {}, doctorEnv());
  const webhook = (ev: unknown) => made.app.request("/api/v1/paypal/webhook", { method: "POST", headers: webhookHeaders(), body: JSON.stringify(ev) }, doctorEnv());
  return { ...seeded, ...made, out, charge: charge!, msgCount, get, webhook };
}

describe("owner links /rx and /r (V10-V13, D.6)", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  it("V10: with the balance unpaid, /t (ticket) → 200 PDF and /r → 402 with the pay link; private headers on both", async () => {
    const t = await approved();
    expect(t.out.balance_cents).toBe(108100 - 0); // no deposit in this fixture
    const rx = await t.get(t.out.ticket_url);
    expect(rx.status).toBe(200);
    expect(rx.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder("latin1").decode(await rx.arrayBuffer())).toMatch(/^%PDF-1\.4/);
    const r = await t.get(t.out.report_url);
    expect(r.status).toBe(402);
    const html = await r.text();
    expect(html).toContain("Su receta ya está en el chat");
    expect(html).toContain("https://www.sandbox.paypal.com/");
    for (const res of [rx, r]) for (const [k, v] of Object.entries(PRIVATE)) expect(res.headers.get(k), k).toBe(v);
  });

  it("V11: verified capture with the exact amount → /r 200 PDF + ONE 'informe listo' message; replay adds nothing", async () => {
    const t = await approved("1081.00");
    const before = await t.msgCount();
    const w1 = await t.webhook(approvedEvent("WH-R1", t.charge.paypal_order_id, t.charge.id));
    expect(await w1.json()).toEqual({ status: "captured" });
    expect(await t.msgCount()).toBe(before + 1);
    const last = await env.DB.prepare("SELECT text FROM messages WHERE conversation_id = ?1 ORDER BY id DESC LIMIT 1").bind(t.conv).first<{ text: string }>();
    expect(last!.text).toMatch(/Pago confirmado.*\/r\/([A-Za-z0-9_-]{43})/);
    const newLink = /https:\/\/furvet\.test\/r\/[A-Za-z0-9_-]{43}/.exec(last!.text)![0];
    for (const url of [t.out.report_url, newLink]) {
      const r = await t.get(url);
      expect(r.status, url).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/pdf");
    }
    expect((await env.DB.prepare("SELECT status FROM consults WHERE id = ?1").bind(t.consult).first<{ status: string }>())?.status).toBe("delivered");
    const replay = await t.webhook(approvedEvent("WH-R1", t.charge.paypal_order_id, t.charge.id));
    expect(await replay.json()).toEqual({ status: "duplicate" });
    expect(await t.msgCount()).toBe(before + 1);
    // m6: PayPal also sends PAYMENT.CAPTURE.COMPLETED for the same capture under another event id.
    const dup = await t.webhook(captureCompletedEvent("WH-R1b", "CAP-1", t.charge.id, "1081.00", "MXN", t.charge.paypal_order_id));
    expect(dup.status).toBe(200);
    expect(await t.msgCount()).toBe(before + 1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM delivery_tokens WHERE consult_id = ?1 AND kind = 'report'").bind(t.consult).first<{ n: number }>()).toEqual({ n: 2 });
  });

  it("M1: two concurrent deliveries of the same event settle once (one message, one new token)", async () => {
    const t = await approved("1081.00");
    const before = await t.msgCount();
    const ev = approvedEvent("WH-C1", t.charge.paypal_order_id, t.charge.id);
    const results = await Promise.all([t.webhook(ev), t.webhook(ev)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await t.msgCount()).toBe(before + 1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM delivery_tokens WHERE consult_id = ?1 AND kind = 'report'").bind(t.consult).first<{ n: number }>()).toEqual({ n: 2 });
  });

  it("V12: capture with a different amount → amount_mismatch, /r stays 402, no message", async () => {
    const t = await approved("1080.99");
    const before = await t.msgCount();
    const w = await t.webhook(approvedEvent("WH-R2", t.charge.paypal_order_id, t.charge.id));
    expect(await w.json()).toEqual({ status: "amount_mismatch" });
    expect((await t.get(t.out.report_url)).status).toBe(402);
    expect(await t.msgCount()).toBe(before);
    // A later PAYMENT.CAPTURE.COMPLETED with the wrong amount does not release either.
    const w2 = await t.webhook(captureCompletedEvent("WH-R3", "CAP-X", t.charge.id, "1080.99", "MXN", t.charge.paypal_order_id));
    expect(await w2.json()).toEqual({ status: "amount_mismatch" });
    expect((await t.get(t.out.report_url)).status).toBe(402);
  });

  it("V13: wrong, cross-kind, expired or malformed tokens → identical 404; DB holds only sha256; logs never carry the token", async () => {
    const logs = captureLogs();
    restore = logs.restore;
    const t = await approved();
    const rxToken = t.out.ticket_url.split("/t/")[1]!;
    const reportToken = t.out.report_url.split("/r/")[1]!;
    const bodies = new Set<string>();
    for (const path of [`/t/${reportToken}`, `/r/${rxToken}`, `/t/${rxToken.slice(0, -1)}x`, "/r/short", `/t/${"A".repeat(43)}`]) {
      const res = await t.app.request(path, {}, doctorEnv());
      expect(res.status, path).toBe(404);
      bodies.add(`${res.headers.get("content-type")}|${await res.text()}`);
      for (const [k, v] of Object.entries(PRIVATE)) expect(res.headers.get(k), k).toBe(v);
    }
    expect(bodies.size).toBe(1);
    const rows = await env.DB.prepare("SELECT token_sha256 FROM delivery_tokens WHERE consult_id = ?1").bind(t.consult).all<{ token_sha256: string }>();
    for (const r of rows.results) {
      expect(r.token_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect([rxToken, reportToken]).not.toContain(r.token_sha256);
    }
    // Expiry: 31 days later the same links are gone.
    const later = makeApp(fakes(), new Date(NOW.getTime() + 31 * 24 * 3600 * 1000));
    expect((await later.app.request(new URL(t.out.ticket_url).pathname, {}, doctorEnv())).status).toBe(404);
    expect((await later.app.request(new URL(t.out.report_url).pathname, {}, doctorEnv())).status).toBe(404);
    const stillValid = makeApp(fakes(), new Date(NOW.getTime() + 29 * 24 * 3600 * 1000));
    expect((await stillValid.app.request(new URL(t.out.ticket_url).pathname, {}, doctorEnv())).status).toBe(200);
    const all = logs.lines.join("\n");
    expect(all).not.toContain(rxToken);
    expect(all).not.toContain(reportToken);
    assertNoPii(logs.lines);
  });
});

describe("printable rx and account ticket (RX1, TK1–TK5)", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());
  // The PDF is plain windows-1252 text; parentheses are escaped inside literals.
  const pdfText = async (res: Response) => new TextDecoder("latin1").decode(await res.arrayBuffer()).replace(/\\([()\\])/g, "$1");
  const EMAIL = "zq-tutor@correo-prueba.invalid";

  it("RX1 (adenda): rx.pdf = date, clinic letterhead, owner name, patient (name, species, breed, age, weight, sex), medications in order, review-date and signature lines; owner email nowhere; the rx never carries money", async () => {
    const seeded = await seedConsult();
    await env.DB.batch([
      env.DB.prepare("UPDATE contacts SET name = ?2, email = ?3 WHERE id = ?1").bind(seeded.conv, OWNER, EMAIL),
      env.DB.prepare("UPDATE pets SET breed = 'labrador', sex = 'macho', birth_date = '2023-02-10' WHERE id = ?1").bind(seeded.pet),
    ]);
    const { app } = makeApp(fakes());
    const body = approvedBody(seeded.ids);
    body.prescription.push({ medicamento: { value: "zzz-omeprazol", source: "doctor" }, dosis: { value: "10 mg", source: "doctor" }, frecuencia: { value: "cada 24 h", source: "doctor" }, duracion: { value: "5 días", source: "doctor" } });
    const res = await app.request(`/api/v1/consults/${seeded.consult}/approve`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) }, doctorEnv());
    expect(res.status).toBe(201);
    const text = await pdfText(await app.request(`/api/v1/consults/${seeded.consult}/rx.pdf`, { headers: doctorHeaders() }, doctorEnv()));
    for (const s of ["2026-11-04", "FurVet demo clinic", "Calle Ejemplo 123", "55 0000 0000", "contacto@furvet.example", `Tutor: ${OWNER}`, "Paciente: Firulais (perro)", "Raza: labrador", "Edad: 3 años", "Peso: 12.4 kg", "Sexo: macho", "Folio ", "1. amoxicilina", "250 mg · cada 12 h · 7 días · vía oral", "MVZ (demo)", "Cédula profesional: DEMO", "Fecha de revisión: ____ / ____ / ________", "Firma: ______", "Original para el médico: imprimir, firmar y entregar.", "aprobado por el médico"]) expect(text, s).toContain(s);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("MXN");
    // Order of medications = order approved (the second one sorts first alphabetically, so order is what is measured).
    expect(text.indexOf("1. amoxicilina")).toBeGreaterThan(0);
    expect(text.indexOf("1. amoxicilina")).toBeLessThan(text.indexOf("2. zzz-omeprazol"));
    expect(text.indexOf("2. zzz-omeprazol")).toBeLessThan(text.indexOf("Indicaciones urgentes"));
  });

  it("RX3: ageLabel — years/months, singular, birthday today, future, impossible and garbage dates", () => {
    const at = "2026-11-04T12:00:00.000Z";
    expect(ageLabel("2023-02-10", at)).toBe("3 años");
    expect(ageLabel("2025-11-04", at)).toBe("1 año");
    expect(ageLabel("2025-11-05", at)).toBe("11 meses");
    expect(ageLabel("2026-10-01", at)).toBe("1 mes");
    expect(ageLabel("2026-11-04", at)).toBe("0 meses");
    for (const bad of ["2026-11-05", "2023-02-30", "ayer", "", null]) expect(ageLabel(bad, at), String(bad)).toBeNull();
  });

  it("RX2 (adenda): unknown breed, age, sex and weight → blank lines to fill by hand, never «null» or «undefined»; clinic letterhead vars missing → empty, not «undefined»", async () => {
    const seeded = await seedConsult();
    const { app } = makeApp(fakes());
    const body = approvedBody(seeded.ids, { vitals: {} });
    const e = doctorEnv({ CLINIC_ADDRESS: undefined, CLINIC_PHONE: undefined, CLINIC_EMAIL: undefined });
    const res = await app.request(`/api/v1/consults/${seeded.consult}/approve`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) }, e);
    expect(res.status).toBe(201);
    const text = await pdfText(await app.request(`/api/v1/consults/${seeded.consult}/rx.pdf`, { headers: doctorHeaders() }, e));
    for (const s of ["Tutor: Visitante", "Raza: ____", "Edad: ____", "Peso: ____", "Sexo: ____"]) expect(text, s).toContain(s);
    expect(text).not.toMatch(/null|undefined/);
    expect(text).not.toContain("Calle Ejemplo");
  });

  it("TK1/TK2: ticket.pdf = every bill_line with quantity, unit price and subtotal; Σ = total; total − deposit = balance; the SAME lines in both chat messages; /t only with the rx token, private headers", async () => {
    const t = await approved();
    const ticket = await t.get(t.out.ticket_url);
    expect(ticket.status).toBe(200);
    expect(ticket.headers.get("content-type")).toBe("application/pdf");
    for (const [k, v] of Object.entries(PRIVATE)) expect(ticket.headers.get(k), k).toBe(v);
    const text = await pdfText(ticket);
    const rows = (await env.DB.prepare("SELECT name, quantity, unit_price_cents, line_total_cents FROM bill_lines WHERE consult_id = ?1 ORDER BY id").bind(t.consult).all<{ name: string; quantity: number; unit_price_cents: number; line_total_cents: number }>()).results;
    expect(rows).toHaveLength(3);
    const expected = [
      "• Consulta general ×1 $450.00 MXN = $450.00 MXN",
      "• MED-AMOXI ×2 $125.25 MXN = $250.50 MXN",
      "• VAC-RABIA ×1 $380.50 MXN = $380.50 MXN",
      "Total: $1081.00 MXN",
      "Anticipo capturado: -$0.00 MXN",
      "Saldo pendiente: $1081.00 MXN",
    ];
    expect(rows.reduce((s, r) => s + r.line_total_cents, 0)).toBe(108100);
    for (const line of expected) expect(text).toContain(line);
    expect(text).not.toMatch(/paypal|ORDER-|CAP-/i);
    // The owner's name (seeded before approval) is printed on the rx only: never on the ticket, in the chat or in the logs.
    expect(await pdfText(await t.get(t.out.ticket_url))).not.toContain(OWNER);
    // messageInserts may split a long message in 4000-char rows: compare on the JOINED text, and expect each line twice (rx + pay link).
    const all = (await env.DB.prepare("SELECT text FROM messages WHERE conversation_id = ?1 ORDER BY id").bind(t.conv).all<{ text: string }>()).results.map((m) => m.text).join("");
    for (const line of expected) expect(all.split(line).length - 1, line).toBe(2);
    expect(all).toContain("Cuenta en PDF: https://furvet.test/t/");
    expect(all).not.toContain(OWNER);
    expect(all).not.toContain("/rx/");
    // Other kinds and garbage: the same 404, and the token never reaches the logs.
    const logs = captureLogs();
    restore = logs.restore;
    const reportToken = t.out.report_url.split("/r/")[1]!;
    for (const path of [`/t/${reportToken}`, "/t/not-a-token", `/t/${"A".repeat(43)}`]) {
      const res = await t.app.request(path, {}, doctorEnv());
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("No encontrado");
    }
    expect(logs.lines.join("\n")).not.toContain(reportToken);
  });

  it("TK3: an edited quantity shows ×14 and an owner-sourced medication is absent from the ticket and from both messages", async () => {
    const seeded = await seedConsult({ prices: { "MED-OTRO": 1000 } });
    const { app } = makeApp(fakes());
    const body = approvedBody(seeded.ids, { billable: [{ catalog_item_id: seeded.ids["MED-OTRO"], quantity: { value: 14, source: "doctor" } }] });
    body.prescription = [{ ...body.prescription[0], owner_sourced: true }, { ...body.prescription[0], medicamento: { value: "otro", source: "doctor" }, catalog_item_id: seeded.ids["MED-OTRO"] }];
    const res = await app.request(`/api/v1/consults/${seeded.consult}/approve`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) }, doctorEnv());
    expect(res.status).toBe(201);
    const out = (await res.json()) as { ticket_url: string };
    expect((await app.request(`/api/v1/consults/${seeded.consult}/charge`, { method: "POST", headers: doctorHeaders() }, doctorEnv())).status).toBe(201);
    const text = await pdfText(await app.request(new URL(out.ticket_url).pathname, {}, doctorEnv()));
    const msgs = (await env.DB.prepare("SELECT text FROM messages WHERE conversation_id = ?1 ORDER BY id").bind(seeded.conv).all<{ text: string }>()).results.map((m) => m.text).join("\n");
    for (const doc of [text, msgs]) {
      expect(doc).toContain("MED-OTRO ×14 $10.00 MXN = $140.00 MXN");
      expect(doc).not.toContain("MED-AMOXI");
    }
    expect(msgs).not.toContain("amoxicilina"); // the rx never reaches the chat
    expect(await pdfText(await app.request(`/api/v1/consults/${seeded.consult}/rx.pdf`, { headers: doctorHeaders() }, doctorEnv()))).toContain("1. amoxicilina"); // still prescribed, on paper
  });

  it("TK5: deposit ≥ total → ticket and messages say «Sin saldo pendiente», never a pending balance", async () => {
    const seeded = await seedConsult({ depositCents: 200000 });
    const { depositCaptured } = await import("./helpers");
    await depositCaptured(seeded.appt, 200000);
    const { app } = makeApp(fakes());
    const res = await app.request(`/api/v1/consults/${seeded.consult}/approve`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(approvedBody(seeded.ids)) }, doctorEnv());
    expect(res.status).toBe(201);
    const out = (await res.json()) as { ticket_url: string; balance_cents: number };
    expect(out.balance_cents).toBe(0);
    const text = await pdfText(await app.request(new URL(out.ticket_url).pathname, {}, doctorEnv()));
    const msgs = (await env.DB.prepare("SELECT text FROM messages WHERE conversation_id = ?1").bind(seeded.conv).all<{ text: string }>()).results.map((m) => m.text).join("");
    for (const doc of [text, msgs]) {
      expect(doc).toContain("Sin saldo pendiente");
      expect(doc).not.toContain("Saldo pendiente:");
    }
    expect(text).toContain("Estado: sin saldo pendiente");
  });
});
