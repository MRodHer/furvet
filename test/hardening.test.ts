// Closes H3–H9, I1 and I3 of encargos/audit-furvet-seguridad.md: the audit's probes, inverted
// (they now assert the CORRECT behaviour), plus a "denies on error" case per barrier.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { LOCKOUT, originKey } from "../src/auth";
import { redactWebhook } from "../src/ledger";
import { approvedBody, approvedEvent, captureCompletedEvent, captureLogs, claudeToolFake, count, depositCaptured, doctorEnv, doctorHeaders, json, makeApp, paypalFakes, PP, seedConfirmed, seedConsult, uniqueOrderFake, webhookHeaders } from "./helpers";

const fakes = () => ({ ...paypalFakes(), ...uniqueOrderFake, ...claudeToolFake(["Resumen sencillo revisado por el médico."]) });
const JSON_H = { "Content-Type": "application/json" };
const WEBM = [0x1a, 0x45, 0xdf, 0xa3];
const msgs = (conv: string) => count("messages", "conversation_id = ?1", conv);
const from = (ip: string, extra: Record<string, string> = {}) => ({ "cf-connecting-ip": ip, ...extra });
const wrong = (ip: string) => ({ ...from(ip), Authorization: `Basic ${btoa("val:not-the-password")}` });
const failuresOf = (key: string) => env.DB.prepare("SELECT failures, blocked_until FROM auth_failures WHERE key = ?1").bind(key).first<{ failures: number; blocked_until: number }>();

/** A D1 whose prepare() throws for the statements `failWhen` selects; everything else passes through. */
function flakyDb(db: D1Database, failWhen: (sql: string) => boolean): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (failWhen(sql)) throw new Error("D1_ERROR");
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Consulta aprobada con anticipo capturado y «Generar cobro» hecho. */
async function charged() {
  const s = await seedConsult();
  await depositCaptured(s.appt, 20000);
  const made = makeApp(fakes());
  const body = approvedBody(s.ids, { billable: [{ catalog_item_id: s.ids["MED-AMOXI"], quantity: { value: 2, source: "doctor" } }] });
  body.prescription[0] = { ...body.prescription[0], catalog_item_id: undefined };
  expect((await made.app.request(`/api/v1/consults/${s.consult}/approve`, { method: "POST", headers: doctorHeaders(JSON_H), body: JSON.stringify(body) }, doctorEnv())).status).toBe(201);
  const out = (await (await made.app.request(`/api/v1/consults/${s.consult}/charge`, { method: "POST", headers: doctorHeaders() }, doctorEnv())).json()) as { balance_cents: number };
  const charge = (await env.DB.prepare("SELECT id, paypal_order_id FROM charges WHERE consult_id = ?1").bind(s.consult).first<{ id: string; paypal_order_id: string }>())!;
  const hook = (ev: unknown) => made.app.request("/api/v1/paypal/webhook", { method: "POST", headers: webhookHeaders(), body: JSON.stringify(ev) }, doctorEnv());
  return { ...s, ...made, charge, value: (out.balance_cents / 100).toFixed(2), hook };
}

describe("H3: doctor login lockout (per origin only, progressive, bounded, fail-closed)", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());
  const PATH = "/api/v1/consults/appointments";

  it("5 failures from one origin → 6th attempt 429 + Retry-After even with the right credential; other origins unaffected; the block lifts and a success clears the counter", async () => {
    const { app } = makeApp({});
    const A = "203.0.113.10";
    for (let i = 0; i < LOCKOUT.IP_THRESHOLD; i++) expect((await app.request(PATH, { headers: wrong(A) }, doctorEnv())).status).toBe(401);
    const blocked = await app.request(PATH, { headers: doctorHeaders(from(A)) }, doctorEnv());
    expect(blocked.status).toBe(429);
    const retry = Number(blocked.headers.get("Retry-After"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(LOCKOUT.IP_BLOCK_BASE_MS / 1000);
    // Another origin keeps working (no DoS of the doctor from elsewhere).
    expect((await app.request(PATH, { headers: doctorHeaders(from("203.0.113.11")) }, doctorEnv())).status).toBe(200);
    // Block lifts (simulated by moving the deadline into the past): a success deletes the origin's row.
    await env.DB.prepare("UPDATE auth_failures SET blocked_until = 1 WHERE key = ?1").bind(`ip:${A}`).run();
    expect((await app.request(PATH, { headers: doctorHeaders(from(A)) }, doctorEnv())).status).toBe(200);
    expect(await failuresOf(`ip:${A}`)).toBeNull();
  });

  it("the block grows with each further failure and is capped at IP_BLOCK_MAX_MS", async () => {
    const { app } = makeApp({});
    const A = "203.0.113.20";
    const now = Date.now();
    await env.DB.prepare("INSERT INTO auth_failures (key, failures, window_start, blocked_until) VALUES (?1, ?2, ?3, 0)").bind(`ip:${A}`, LOCKOUT.IP_THRESHOLD, now).run();
    expect((await app.request(PATH, { headers: wrong(A) }, doctorEnv())).status).toBe(401); // 6th failure
    const r6 = (await failuresOf(`ip:${A}`))!;
    expect(r6.failures).toBe(LOCKOUT.IP_THRESHOLD + 1);
    expect(r6.blocked_until - now).toBeGreaterThanOrEqual(2 * LOCKOUT.IP_BLOCK_BASE_MS - 5_000);
    expect(r6.blocked_until - now).toBeLessThanOrEqual(2 * LOCKOUT.IP_BLOCK_BASE_MS + 5_000);
    // Far past the threshold: bounded, never permanent.
    await env.DB.prepare("UPDATE auth_failures SET failures = 40, blocked_until = 0 WHERE key = ?1").bind(`ip:${A}`).run();
    expect((await app.request(PATH, { headers: wrong(A) }, doctorEnv())).status).toBe(401);
    expect((await failuresOf(`ip:${A}`))!.blocked_until - now).toBeLessThanOrEqual(LOCKOUT.IP_BLOCK_MAX_MS + 5_000);
  });

  it("failures older than the window do not count (the window restarts)", async () => {
    const { app } = makeApp({});
    const A = "203.0.113.30";
    await env.DB.prepare("INSERT INTO auth_failures (key, failures, window_start, blocked_until) VALUES (?1, ?2, ?3, 0)").bind(`ip:${A}`, LOCKOUT.IP_THRESHOLD - 1, Date.now() - LOCKOUT.WINDOW_MS - 1000).run();
    expect((await app.request(PATH, { headers: wrong(A) }, doctorEnv())).status).toBe(401);
    expect((await failuresOf(`ip:${A}`))!).toMatchObject({ failures: 1, blocked_until: 0 });
  });

  it("no global coupling: many failures from many origins never block a fresh origin (a stranger cannot lock the doctor out)", async () => {
    const { app } = makeApp({});
    for (let i = 0; i < 60; i++) expect((await app.request(PATH, { headers: wrong(`203.0.113.${100 + (i % 20)}`) }, doctorEnv())).status).toBe(401);
    expect(await count("auth_failures", "key = 'global'")).toBe(0);
    expect((await app.request(PATH, { headers: doctorHeaders(from("203.0.113.200")) }, doctorEnv())).status).toBe(200);
  });

  it("IPv6 counts by /64: addresses of the same /64 share the counter; another /64 is untouched", async () => {
    expect(originKey("2001:db8:abcd:12::1")).toBe("ip:2001:0db8:abcd:0012::/64");
    expect(originKey("2001:db8:abcd:12:ffff:ffff:ffff:ffff")).toBe("ip:2001:0db8:abcd:0012::/64");
    expect(originKey("::1")).toBe("ip:0000:0000:0000:0000::/64");
    expect(originKey("198.51.100.7")).toBe("ip:198.51.100.7");
    const { app } = makeApp({});
    for (let i = 0; i < LOCKOUT.IP_THRESHOLD; i++) expect((await app.request(PATH, { headers: wrong(`2001:db8:1:2::${i + 10}`) }, doctorEnv())).status).toBe(401);
    expect((await app.request(PATH, { headers: doctorHeaders(from("2001:db8:1:2:dead:beef::1")) }, doctorEnv())).status).toBe(429);
    expect((await app.request(PATH, { headers: doctorHeaders(from("2001:db8:1:3::1")) }, doctorEnv())).status).toBe(200);
  });

  it("denies on error: counter unreadable → 503; counter unwritable → 401 even with the right credential; never a pass", async () => {
    const { app } = makeApp({});
    const readDown = doctorEnv({ DB: flakyDb(env.DB, (sql) => sql.startsWith("SELECT blocked_until FROM auth_failures")) });
    expect((await app.request(PATH, { headers: doctorHeaders(from("203.0.113.50")) }, readDown)).status).toBe(503);
    const writeDown = doctorEnv({ DB: flakyDb(env.DB, (sql) => /auth_failures/.test(sql) && !sql.startsWith("SELECT")) });
    expect((await app.request(PATH, { headers: doctorHeaders(from("203.0.113.51")) }, writeDown)).status).toBe(401);
    expect((await app.request(PATH, { headers: wrong("203.0.113.51") }, writeDown)).status).toBe(401);
  });

  it("the denial is logged with the count and a reason, never the address nor anything derived from it", async () => {
    const logs = captureLogs();
    restore = logs.restore;
    const { app } = makeApp({});
    expect((await app.request(PATH, { headers: wrong("203.0.113.60") }, doctorEnv())).status).toBe(401);
    const denied = logs.lines.find((l) => l.includes("doctor_auth_denied"));
    expect(denied).toMatch(/"reason":"password"/);
    expect(denied).toMatch(/"failures":1/);
    expect(denied).not.toMatch(/origin|ip/i);
    for (const l of logs.lines) expect(l).not.toContain("203.0.113.60");
  });
});

describe("H4: the deposit concept is never a bill line", () => {
  it("bill-preview and approve with the ANTICIPO catalog id → 422, nothing billed (shared loader)", async () => {
    const s = await seedConsult();
    await depositCaptured(s.appt, 20000);
    const { app } = makeApp(fakes());
    const body = approvedBody(s.ids, { billable: [{ catalog_item_id: s.ids["ANTICIPO-CONSULTA"], quantity: { value: 1, source: "doctor" } }], vaccines: [] });
    body.prescription[0] = { ...body.prescription[0], catalog_item_id: undefined };
    for (const route of ["bill-preview", "approve"]) {
      const r = await app.request(`/api/v1/consults/${s.consult}/${route}`, { method: "POST", headers: doctorHeaders(JSON_H), body: JSON.stringify(body) }, doctorEnv());
      expect(r.status, route).toBe(422);
    }
    expect(await count("consult_bills", "consult_id = ?1", s.consult)).toBe(0);
  });
});

describe("H5: an upload over the daily audio cap burns no budget", () => {
  it("first upload of the day above the cap → 429 with the budget untouched; a small one afterwards → 200", async () => {
    const ai = { run: async () => ({ text: "hola", segments: [{ start: 0, end: 1, text: "hola" }] }) } as unknown as Ai;
    const { app } = makeApp(fakes(), new Date("2032-03-01T10:00:00.000Z"));
    const e = doctorEnv({ AI: ai, AUDIO_DAILY_SECONDS_CAP: "10" });
    const b = await seedConfirmed();
    const { id } = (await (await app.request("/api/v1/consults", { method: "POST", headers: doctorHeaders(JSON_H), body: JSON.stringify({ appointment_id: b.appt }) }, e)).json()) as { id: string };
    expect((await app.request(`/api/v1/consults/${id}/consent`, { method: "POST", headers: doctorHeaders(JSON_H), body: JSON.stringify({ version: "doctor-v1-2026-11-04" }) }, e)).status).toBe(200);
    const big = new Uint8Array(100_000); // ≈25 s estimated > cap 10
    big.set(WEBM, 0);
    expect((await app.request(`/api/v1/consults/${id}/audio`, { method: "POST", headers: doctorHeaders({ "Content-Type": "audio/webm" }), body: big }, e)).status).toBe(429);
    expect(await env.DB.prepare("SELECT audio_seconds FROM audio_usage WHERE day = '2032-03-01'").first()).toBeNull();
    const small = new Uint8Array(4000); // 1 s
    small.set(WEBM, 0);
    expect((await app.request(`/api/v1/consults/${id}/audio`, { method: "POST", headers: doctorHeaders({ "Content-Type": "audio/webm" }), body: small }, e)).status).toBe(200);
  });
});

describe("H6: the webhook cap counts BYTES and stops reading at the cap", () => {
  it("a 180 KB chunked body of 3-byte characters (under 64 K chars) → 413, verify never called", async () => {
    const seen: string[] = [];
    const { app } = makeApp({ ...paypalFakes(), [PP.verify]: (_r, body) => { seen.push(body); return json({ verification_status: "FAILURE" }); } });
    const payload = JSON.stringify({ id: "EV-BIG", event_type: "X", resource: {}, pad: "€".repeat(59_000) });
    expect(payload.length).toBeLessThan(64 * 1024);
    const r = await app.request("/api/v1/paypal/webhook", { method: "POST", headers: webhookHeaders(), body: new Blob([payload]).stream(), duplex: "half" } as RequestInit, doctorEnv());
    expect(r.status).toBe(413);
    expect(seen).toHaveLength(0);
  });
});

describe("H7 + H8: one capture per charge; a capture must name its order", () => {
  it("H7: a second capture with ANOTHER capture id → already_captured, one captured row, one message, no new token; the DB index is the second barrier", async () => {
    const t = await charged();
    const m0 = await msgs(t.conv);
    expect(await (await t.hook(captureCompletedEvent("EV-A", "CAP-A", t.charge.id, t.value, "MXN", t.charge.paypal_order_id))).json()).toEqual({ status: "captured" });
    expect(await msgs(t.conv)).toBe(m0 + 1);
    expect(await (await t.hook(captureCompletedEvent("EV-B", "CAP-B", t.charge.id, t.value, "MXN", t.charge.paypal_order_id))).json()).toEqual({ status: "already_captured" });
    expect(await count("charge_events", "charge_id = ?1 AND status = 'captured'", t.charge.id)).toBe(1);
    expect(await msgs(t.conv)).toBe(m0 + 1);
    expect(await count("delivery_tokens", "consult_id = ?1 AND kind = 'report'", t.consult)).toBe(2);
    await expect(
      env.DB.prepare("INSERT INTO charge_events (charge_id, status, paypal_capture_id, amount_cents, currency, raw) VALUES (?1, 'captured', 'CAP-C', 1, 'MXN', '{}')").bind(t.charge.id).run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("H8: a capture naming a FOREIGN order → ignored, 0 rows, no message; one naming no order is judged by custom_id + amount (cross-check when present, not required: R122 smoke pending)", async () => {
    const t = await charged();
    const m0 = await msgs(t.conv);
    expect(await (await t.hook(captureCompletedEvent("EV-FOREIGN", "CAP-F", t.charge.id, t.value, "MXN", "ORDER-OF-SOMEONE-ELSE"))).json()).toEqual({ status: "ignored" });
    expect(await count("charge_events", "charge_id = ?1 AND paypal_event_id IS NOT NULL", t.charge.id)).toBe(0);
    expect(await msgs(t.conv)).toBe(m0);
    expect(await (await t.hook(captureCompletedEvent("EV-NOREL", "CAP-X", t.charge.id, t.value))).json()).toEqual({ status: "captured" });
    expect(await count("charge_events", "charge_id = ?1 AND status = 'captured'", t.charge.id)).toBe(1);
    expect(await msgs(t.conv)).toBe(m0 + 1);
  });
});

describe("H9: webhook evidence is stored without the person, at any depth", () => {
  it("redactWebhook drops payer, payment_source, payee and shipping wherever they appear, keeps items and amounts", () => {
    const out = redactWebhook({
      id: "EV",
      resource: {
        id: "O",
        payer: { email_address: "a@b.c" },
        payment_source: { paypal: { name: "x" } },
        purchase_units: [{ custom_id: "C", amount: { value: "1.00" }, shipping: { name: { full_name: "Laura" }, address: { address_line_1: "Calle 1" } }, payee: { email_address: "m@c.d" }, items: [{ name: "Consulta", quantity: "1" }] }],
      },
    }) as { resource: { purchase_units: Record<string, unknown>[] } };
    const text = JSON.stringify(out);
    for (const s of ["payer", "payment_source", "payee", "shipping", "Laura", "Calle 1", "a@b.c"]) expect(text).not.toContain(s);
    expect(out.resource.purchase_units[0]).toEqual({ custom_id: "C", amount: { value: "1.00" }, items: [{ name: "Consulta", quantity: "1" }] });
  });

  it("an ORDER.APPROVED whose purchase unit carries shipping is stored in charge_events.raw without it", async () => {
    const t = await charged();
    const ev = approvedEvent("EV-SHIP", t.charge.paypal_order_id, t.charge.id) as { resource: { purchase_units: Record<string, unknown>[] } };
    ev.resource.purchase_units[0] = { ...ev.resource.purchase_units[0], shipping: { name: { full_name: "Laura Demo" }, address: { address_line_1: "Calle 1" } } };
    expect((await t.hook(ev)).status).toBe(200);
    const raw = (await env.DB.prepare("SELECT raw FROM charge_events WHERE paypal_event_id = 'EV-SHIP'").first<{ raw: string }>())!.raw;
    expect(raw).toContain(t.charge.id);
    for (const s of ["shipping", "Laura", "Calle 1", "payer", "buyer@example.com"]) expect(raw).not.toContain(s);
  });
});

describe("I1 + I3", () => {
  it("I1: delivery_tokens is append-only (expiry cannot be extended, tokens cannot be deleted)", async () => {
    const t = await charged();
    await expect(env.DB.prepare("UPDATE delivery_tokens SET expires_at = '2099-01-01T00:00:00.000Z' WHERE consult_id = ?1").bind(t.consult).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM delivery_tokens WHERE consult_id = ?1").bind(t.consult).run()).rejects.toThrow(/append-only/);
  });

  it("I3: the 402 page carries a CSP that allows only its own inline style (header and body agree)", async () => {
    const t = await charged();
    const token = (await env.DB.prepare("SELECT text FROM messages WHERE conversation_id = ?1 AND text LIKE '%/r/%' ORDER BY id DESC LIMIT 1").bind(t.conv).first<{ text: string }>())!.text;
    const path = new URL(/https:\/\/\S+\/r\/[A-Za-z0-9_-]{43}/.exec(token)![0]).pathname;
    const r = await t.app.request(path, {}, doctorEnv());
    expect(r.status).toBe(402);
    const html = await r.text();
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`);
    expect(html).not.toMatch(/<script|<img|<link|src=/); // nothing the policy would block
    expect(html).toMatch(/<body style="/); // the one inline style the policy allows
  });
});

