import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { approvedBody, approvedEvent, assertNoPii, captureCompletedEvent, captureLogs, claudeToolFake, doctorEnv, doctorHeaders, makeApp, NOW, paypalFakes, seedConsult, uniqueOrderFake, webhookHeaders } from "./helpers";

const fakes = (captureValue = "881.00") => ({ ...paypalFakes({ captureValue }), ...uniqueOrderFake, ...claudeToolFake(["Su perro tiene gastroenteritis leve."]) });
const PRIVATE = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };

async function approved(captureValue = "881.00") {
  const seeded = await seedConsult();
  const made = makeApp(fakes(captureValue));
  const body = approvedBody(seeded.ids, { billable: [{ catalog_item_id: seeded.ids["MED-AMOXI"], quantity: { value: 2, source: "doctor" } }] });
  body.prescription[0] = { ...body.prescription[0], catalog_item_id: undefined };
  const res = await made.app.request(`/api/v1/consults/${seeded.consult}/approve`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) }, doctorEnv());
  expect(res.status).toBe(201);
  const out = (await res.json()) as { rx_url: string; report_url: string; balance_cents: number };
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

  it("V10: with the balance unpaid, /rx → 200 PDF and /r → 402 with the pay link; private headers on both", async () => {
    const t = await approved();
    expect(t.out.balance_cents).toBe(108100 - 0); // no deposit in this fixture
    const rx = await t.get(t.out.rx_url);
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
    const rxToken = t.out.rx_url.split("/rx/")[1]!;
    const reportToken = t.out.report_url.split("/r/")[1]!;
    const bodies = new Set<string>();
    for (const path of [`/rx/${reportToken}`, `/r/${rxToken}`, `/rx/${rxToken.slice(0, -1)}x`, "/r/short", `/rx/${"A".repeat(43)}`]) {
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
    expect((await later.app.request(new URL(t.out.rx_url).pathname, {}, doctorEnv())).status).toBe(404);
    expect((await later.app.request(new URL(t.out.report_url).pathname, {}, doctorEnv())).status).toBe(404);
    const stillValid = makeApp(fakes(), new Date(NOW.getTime() + 29 * 24 * 3600 * 1000));
    expect((await stillValid.app.request(new URL(t.out.rx_url).pathname, {}, doctorEnv())).status).toBe(200);
    const all = logs.lines.join("\n");
    expect(all).not.toContain(rxToken);
    expect(all).not.toContain(reportToken);
    assertNoPii(logs.lines);
  });
});
