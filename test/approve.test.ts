import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { approvedBody, assertNoPii, captureLogs, claudeToolFake, count, depositCaptured, doctorEnv, doctorHeaders, makeApp, paypalFakes, PP, seedConsult, uniqueOrderFake, withEnv } from "./helpers";

const fakes = () => ({ ...paypalFakes(), ...uniqueOrderFake, ...claudeToolFake(["Su perro tiene gastroenteritis leve; amoxicilina 250 mg cada 12 h por 7 días."]) });
const post = (app: ReturnType<typeof makeApp>["app"], consult: string, body: unknown, e = doctorEnv(), headers: Record<string, string> = doctorHeaders({ "Content-Type": "application/json" })) =>
  app.request(`/api/v1/consults/${consult}/approve`, { method: "POST", headers, body: JSON.stringify(body) }, e);
const messages = (conv: string) => env.DB.prepare("SELECT text FROM messages WHERE conversation_id = ?1 ORDER BY id").bind(conv).all<{ text: string }>();

describe("POST /approve (V7-C, V8, V9, D.4)", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  it("V7: no auth → 401; empty credential → 503; unknown consult → 404; nothing reaches the owner", async () => {
    const { consult, conv, ids } = await seedConsult();
    const { app, calls } = makeApp(fakes());
    expect((await post(app, consult, approvedBody(ids), doctorEnv(), { "Content-Type": "application/json" })).status).toBe(401);
    expect((await post(app, consult, approvedBody(ids), withEnv({ DOCTOR_DEMO_USER: "val", DOCTOR_DEMO_PASSWORD: "" }))).status).toBe(503);
    expect((await post(app, crypto.randomUUID(), approvedBody(ids))).status).toBe(404);
    expect((await messages(conv)).results).toHaveLength(0);
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("V7/V8: incomplete medication → 422; a price key anywhere → 422; both write nothing and call nobody", async () => {
    const { consult, conv, ids } = await seedConsult();
    const { app, calls } = makeApp(fakes());
    const body = approvedBody(ids);
    const incomplete = { ...body, prescription: [{ ...body.prescription[0], dosis: { value: "una cucharada", source: "doctor" } }] };
    const r1 = await post(app, consult, incomplete);
    expect(r1.status).toBe(422);
    expect(await r1.json()).toMatchObject({ error: "incomplete medication", incomplete: [{ index: 0, missing: ["dosis"] }] });

    for (const bad of [
      { ...body, billable: [{ catalog_item_id: ids["MED-AMOXI"], quantity: { value: 1, source: "doctor" }, precio: 1 }] },
      { ...body, amount: "1.00" },
      { ...body, prescription: [{ ...body.prescription[0], unit_price: 5 }] },
      { ...body, billable: [{ catalog_item_id: "not-in-catalog", quantity: { value: 1, source: "doctor" } }] },
      { ...body, billable: [{ catalog_item_id: ids["MED-AMOXI"], quantity: { value: 2.5, source: "doctor" } }] },
    ]) {
      expect((await post(app, consult, bad)).status, JSON.stringify(Object.keys(bad))).toBe(422);
    }
    expect((await messages(conv)).results).toHaveLength(0);
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("V9: 450.00 + 380.50 + 2×125.25 − captured 200.00 → 881.00 order with items + discount; rx goes to the chat NOW", async () => {
    const { consult, conv, appt, ids } = await seedConsult();
    await depositCaptured(appt, 20000);
    const logs = captureLogs();
    restore = logs.restore;
    const { app, calls } = makeApp(fakes());
    const body = approvedBody(ids, { billable: [{ catalog_item_id: ids["MED-AMOXI"], quantity: { value: 2, source: "ai", segment_ids: [1], quote: "dos cajas" } }] });
    // 2 via billable + 1 via prescription.catalog_item_id = 3 × 125.25 would be 1206.25; the V9 figure uses 2 → drop the rx mapping.
    body.prescription[0] = { ...body.prescription[0], catalog_item_id: undefined };
    const res = await post(app, consult, body);
    expect(res.status).toBe(201);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toMatchObject({ total_cents: 108100, deposit_cents: 20000, balance_cents: 88100 });
    expect(out.approve_url).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);

    const order = JSON.parse(calls.find((c) => c.key === PP.orders)!.body);
    const unit = order.purchase_units[0];
    expect(unit.amount).toEqual({ currency_code: "MXN", value: "881.00", breakdown: { item_total: { currency_code: "MXN", value: "1081.00" }, discount: { currency_code: "MXN", value: "200.00" } } });
    expect(unit.items.map((i: { name: string; quantity: string; unit_amount: { value: string } }) => [i.name, i.quantity, i.unit_amount.value])).toEqual([
      ["Consulta general", "1", "450.00"],
      ["MED-AMOXI", "2", "125.25"],
      ["VAC-RABIA", "1", "380.50"],
    ]);
    expect(calls.find((c) => c.key === PP.orders)!.headers.get("PayPal-Request-Id")).toBe(`balance-${consult}`);

    const lines = await env.DB.prepare("SELECT name, quantity, unit_price_cents, line_total_cents, source FROM bill_lines WHERE consult_id = ?1 ORDER BY id").bind(consult).all();
    expect(lines.results).toEqual([
      { name: "Consulta general", quantity: 1, unit_price_cents: 45000, line_total_cents: 45000, source: "doctor_added" },
      { name: "MED-AMOXI", quantity: 2, unit_price_cents: 12525, line_total_cents: 25050, source: "ai_detected" },
      { name: "VAC-RABIA", quantity: 1, unit_price_cents: 38050, line_total_cents: 38050, source: "doctor_added" },
    ]);
    const charge = await env.DB.prepare("SELECT kind, amount_cents, status, consult_id FROM charges_current WHERE consult_id = ?1").bind(consult).first();
    expect(charge).toEqual({ kind: "balance", amount_cents: 88100, status: "created", consult_id: consult });

    const msgs = (await messages(conv)).results.map((m) => m.text).join("\n");
    expect(msgs).toContain("amoxicilina · 250 mg · cada 12 h · 7 días");
    expect(msgs).toContain("INDICACIONES URGENTES");
    expect(msgs).toContain("/rx/");
    expect(msgs).toContain("881.00");
    expect((await env.DB.prepare("SELECT status FROM consults WHERE id = ?1").bind(consult).first<{ status: string }>())?.status).toBe("approved");
    expect(await count("delivery_tokens", "consult_id = ?1", consult)).toBe(2);
    // B1: the approved clinical body is evidence in the append-only consult_versions, same batch.
    const version = await env.DB.prepare("SELECT body, created_by FROM consult_versions WHERE consult_id = ?1 AND kind = 'approved'").bind(consult).first<{ body: string; created_by: string }>();
    expect(version?.created_by).toBe("val");
    expect(JSON.parse(version!.body).prescription[0].medicamento.value).toBe("amoxicilina");
    expect(await count("consult_versions", "consult_id = ?1 AND kind = 'approved'", consult)).toBe(1);
    const tokenRow = await env.DB.prepare("SELECT token_sha256 FROM delivery_tokens WHERE consult_id = ?1 AND kind = 'rx'").bind(consult).first<{ token_sha256: string }>();
    expect(tokenRow!.token_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(msgs).not.toContain(tokenRow!.token_sha256);
    expect(await env.FILES.head(`reports/${out.approval_id}/rx.pdf`)).not.toBeNull();
    expect(await env.FILES.head(`reports/${out.approval_id}/report.pdf`)).not.toBeNull();
    assertNoPii(logs.lines);
    expect(logs.lines.join("\n")).not.toMatch(/\/rx\/|\/r\//);
  });

  it("V7: a second approval → 409, no new lines, messages or charges", async () => {
    const { consult, conv, ids } = await seedConsult();
    const { app, calls } = makeApp(fakes());
    expect((await post(app, consult, approvedBody(ids))).status).toBe(201);
    const before = { lines: await count("bill_lines", "consult_id = ?1", consult), msgs: (await messages(conv)).results.length, orders: calls.filter((c) => c.key === PP.orders).length };
    const again = await post(app, consult, approvedBody(ids));
    expect(again.status).toBe(409);
    expect(await count("bill_lines", "consult_id = ?1", consult)).toBe(before.lines);
    expect((await messages(conv)).results.length).toBe(before.msgs);
    expect(calls.filter((c) => c.key === PP.orders).length).toBe(before.orders);
    expect(await count("charges", "consult_id = ?1", consult)).toBe(1);
    expect(await count("consult_versions", "consult_id = ?1 AND kind = 'approved'", consult)).toBe(1);
  });

  it("B2: a retried approval reuses the SAME charge id as custom_id (PayPal returns the first order for the same Request-Id)", async () => {
    const { consult, ids } = await seedConsult();
    const { app, calls } = makeApp(fakes());
    const [a, b] = await Promise.all([post(app, consult, approvedBody(ids)), post(app, consult, approvedBody(ids))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const customIds = calls.filter((c) => c.key === PP.orders).map((c) => JSON.parse(c.body).purchase_units[0].custom_id);
    expect(new Set(customIds).size).toBe(1);
    const charge = await env.DB.prepare("SELECT id FROM charges WHERE consult_id = ?1").bind(consult).first<{ id: string }>();
    expect(charge?.id).toBe(customIds[0]);
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(1);
    expect(await count("delivery_tokens", "consult_id = ?1", consult)).toBe(2);
  });

  it("m2: an item present in billable AND mapped from the prescription is billed once", async () => {
    const { consult, ids } = await seedConsult();
    const { app } = makeApp(fakes());
    const preview = await app.request(`/api/v1/consults/${consult}/bill-preview`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(approvedBody(ids)) }, doctorEnv());
    expect(await preview.json()).toMatchObject({ total_cents: 45000 + 38050 + 12525 });
  });

  it("V8: the catalog price at approval time decides the total (the model never carries a price)", async () => {
    const { consult, ids } = await seedConsult({ prices: { "MED-AMOXI": 10000 } });
    await env.DB.prepare("UPDATE catalog_items SET price_cents = 30000 WHERE sku = 'MED-AMOXI'").run();
    const { app } = makeApp(fakes());
    const preview = await app.request(`/api/v1/consults/${consult}/bill-preview`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(approvedBody(ids)) }, doctorEnv());
    expect(preview.status).toBe(200);
    // consulta 450.00 + vacuna 380.50 + amoxi 300.00 (billable; the rx mapping of the same item is not billed twice)
    expect(await preview.json()).toMatchObject({ total_cents: 45000 + 38050 + 30000, deposit_cents: 0 });
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(0);
  });

  it("V9: deposit ≥ total → no PayPal order, balance 0, report link released", async () => {
    const { consult, conv, appt, ids } = await seedConsult({ depositCents: 200000 });
    await depositCaptured(appt, 200000);
    const { app, calls } = makeApp(fakes());
    const res = await post(app, consult, approvedBody(ids));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ balance_cents: 0, approve_url: null });
    expect(calls.filter((c) => c.key === PP.orders)).toHaveLength(0);
    expect(await count("charges", "consult_id = ?1", consult)).toBe(0);
    const text = (await messages(conv)).results.map((m) => m.text).join("\n");
    expect(text).toMatch(/Informe completo: https:\/\/furvet\.test\/r\/[A-Za-z0-9_-]{43}$/m);
    expect((await env.DB.prepare("SELECT status FROM consults WHERE id = ?1").bind(consult).first<{ status: string }>())?.status).toBe("delivered");
  });

  it("fail-closed: balance > 0 without PayPal configured → 503 before any write", async () => {
    const { consult, conv, ids } = await seedConsult();
    const { app } = makeApp(fakes());
    const res = await post(app, consult, approvedBody(ids), doctorEnv({ PAYPAL_CLIENT_ID: "" }));
    expect(res.status).toBe(503);
    expect((await messages(conv)).results).toHaveLength(0);
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(0);
  });
});
