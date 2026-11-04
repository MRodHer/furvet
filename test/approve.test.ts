import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { makePayPal, PayPalError } from "../src/paypal";
import { approvedBody, assertNoPii, captureLogs, claudeToolFake, count, depositCaptured, doctorEnv, doctorHeaders, makeApp, paypalFakes, PP, seedConsult, uniqueOrderFake, withEnv } from "./helpers";

const fakes = () => ({ ...paypalFakes(), ...uniqueOrderFake, ...claudeToolFake(["Su perro tiene gastroenteritis leve; amoxicilina 250 mg cada 12 h por 7 días."]) });
const post = (app: ReturnType<typeof makeApp>["app"], consult: string, body: unknown, e = doctorEnv(), headers: Record<string, string> = doctorHeaders({ "Content-Type": "application/json" })) =>
  app.request(`/api/v1/consults/${consult}/approve`, { method: "POST", headers, body: JSON.stringify(body) }, e);
const charge = (app: ReturnType<typeof makeApp>["app"], consult: string, e = doctorEnv()) => app.request(`/api/v1/consults/${consult}/charge`, { method: "POST", headers: doctorHeaders() }, e);
const sendExplanation = (app: ReturnType<typeof makeApp>["app"], consult: string, headers: Record<string, string> = doctorHeaders()) =>
  app.request(`/api/v1/consults/${consult}/send-explanation`, { method: "POST", headers }, doctorEnv());
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

  it("V9/M6-b: approve → rx NOW without any PayPal call; «Generar cobro» → 881.00 order with items + discount, once", async () => {
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
    expect(out).not.toHaveProperty("approve_url");
    // M6-b: the approval never talks to PayPal; the order comes later from the doctor's button.
    expect(calls.filter((c) => c.key === PP.orders)).toHaveLength(0);
    expect(await count("charges", "consult_id = ?1", consult)).toBe(0);
    const rxMsgs = (await messages(conv)).results.map((m) => m.text).join("\n");
    expect(rxMsgs).toContain("amoxicilina · 250 mg · cada 12 h · 7 días");
    expect(rxMsgs).not.toContain("sandbox.paypal.com");

    const charged = await charge(app, consult);
    expect(charged.status).toBe(201);
    expect(await charged.json()).toMatchObject({ charge_id: `balance-${consult}`, status: "created", balance_cents: 88100 });
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
    const chargeRow = await env.DB.prepare("SELECT kind, amount_cents, status, consult_id FROM charges_current WHERE consult_id = ?1").bind(consult).first();
    expect(chargeRow).toEqual({ kind: "balance", amount_cents: 88100, status: "created", consult_id: consult });

    const msgs = (await messages(conv)).results.map((m) => m.text).join("\n");
    expect(msgs).toContain("INDICACIONES URGENTES");
    expect(msgs).toContain("/rx/");
    expect(msgs).toContain("881.00");
    expect(msgs).toMatch(/Liga para pagar el saldo.*https:\/\/www\.sandbox\.paypal\.com\//);
    // Second click: same charge and link, no second order, no second message (M6-b idempotency).
    const msgsBefore = (await messages(conv)).results.length;
    const again = await charge(app, consult);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ charge_id: `balance-${consult}`, approve_url: expect.stringMatching(/^https:\/\/www\.sandbox\.paypal\.com\//) });
    expect(calls.filter((c) => c.key === PP.orders)).toHaveLength(1);
    expect((await messages(conv)).results.length).toBe(msgsBefore);
    expect(await count("charges", "consult_id = ?1", consult)).toBe(1);
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
    expect(await count("charges", "consult_id = ?1", consult)).toBe(0);
    expect(await count("consult_versions", "consult_id = ?1 AND kind = 'approved'", consult)).toBe(1);
  });

  it("B2/M6-b: concurrent «Generar cobro» → ONE charge whose id is the custom_id and the Request-Id, ONE pay-link message", async () => {
    const { consult, conv, ids } = await seedConsult();
    const { app, calls } = makeApp(fakes());
    expect((await post(app, consult, approvedBody(ids))).status).toBe(201);
    const msgsBefore = (await messages(conv)).results.length;
    const [a, b] = await Promise.all([charge(app, consult), charge(app, consult)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const orders = calls.filter((c) => c.key === PP.orders);
    expect(new Set(orders.map((c) => JSON.parse(c.body).purchase_units[0].custom_id))).toEqual(new Set([`balance-${consult}`]));
    expect(new Set(orders.map((c) => c.headers.get("PayPal-Request-Id")))).toEqual(new Set([`balance-${consult}`]));
    const row = await env.DB.prepare("SELECT id FROM charges WHERE consult_id = ?1").bind(consult).first<{ id: string }>();
    expect(row?.id).toBe(`balance-${consult}`);
    expect(await count("charges", "consult_id = ?1", consult)).toBe(1);
    expect((await messages(conv)).results.length).toBe(msgsBefore + 1);
    expect((await a.json() as { approve_url: string }).approve_url).toBe((await b.json() as { approve_url: string }).approve_url);
  });

  it("B2: a concurrent second approval → 409 and writes nothing of its own", async () => {
    const { consult, conv, ids } = await seedConsult();
    const { app } = makeApp(fakes());
    const [a, b] = await Promise.all([post(app, consult, approvedBody(ids)), post(app, consult, approvedBody(ids))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(1);
    expect(await count("delivery_tokens", "consult_id = ?1", consult)).toBe(2);
    // M2: the loser of the race writes NO lines (append-only: duplicates would be permanent) and NO second rx message.
    expect(await count("bill_lines", "consult_id = ?1", consult)).toBe(3);
    expect(await count("messages", "conversation_id = ?1 AND direction = 'outbound'", conv)).toBe(1);
  });

  it("M1: a deposit that is not captured, or captured in another currency, is NOT discounted", async () => {
    const full = 45000 + 38050 + 12525;
    const created = await seedConsult();
    await depositCaptured(created.appt, 20000, { status: "created" });
    const { app } = makeApp(fakes());
    const res = await post(app, created.consult, approvedBody(created.ids));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ total_cents: full, deposit_cents: 0, balance_cents: full });

    const usd = await seedConsult();
    await depositCaptured(usd.appt, 20000, { currency: "USD" });
    const preview = await app.request(`/api/v1/consults/${usd.consult}/bill-preview`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(approvedBody(usd.ids)) }, doctorEnv());
    expect(await preview.json()).toMatchObject({ deposit_cents: 0, balance_cents: full });
  });

  it("balance over MAX_CHARGE_CENTS → 422 before any write or PayPal call", async () => {
    const { consult, conv, ids } = await seedConsult();
    const { app, calls } = makeApp(fakes());
    const res = await post(app, consult, approvedBody(ids), doctorEnv({ MAX_CHARGE_CENTS: "1000" }));
    expect(res.status).toBe(422);
    expect((await messages(conv)).results).toHaveLength(0);
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(0);
    expect(calls.filter((c) => c.key === PP.orders)).toHaveLength(0);
  });

  it("createOrder refuses items whose total minus discount is not the amount (self-check)", async () => {
    const { fetchImpl, calls } = makeApp(fakes());
    const pp = makePayPal(fetchImpl, { clientId: "id", clientSecret: "s" });
    const base = { currency: "MXN", customId: "balance-x", requestId: "balance-x", description: "d", returnUrl: "https://furvet.test/r", cancelUrl: "https://furvet.test/c", items: [{ name: "a", quantity: 2, unitCents: 100 }] };
    await expect(pp.createOrder({ ...base, amountCents: 150, discountCents: 20 })).rejects.toThrow(PayPalError);
    await expect(pp.createOrder({ ...base, amountCents: 250 })).rejects.toThrow(/item_total - discount/);
    expect(calls).toHaveLength(0);
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
    expect(await res.json()).toMatchObject({ balance_cents: 0 });
    expect(calls.filter((c) => c.key === PP.orders)).toHaveLength(0);
    expect(await count("charges", "consult_id = ?1", consult)).toBe(0);
    const text = (await messages(conv)).results.map((m) => m.text).join("\n");
    expect(text).toMatch(/Informe completo: https:\/\/furvet\.test\/r\/[A-Za-z0-9_-]{43}$/m);
    expect((await env.DB.prepare("SELECT status FROM consults WHERE id = ?1").bind(consult).first<{ status: string }>())?.status).toBe("delivered");
  });

  it("M6-b1: with PayPal down or unconfigured the approval still goes through and the rx reaches the owner; «Generar cobro» → 503 and writes nothing", async () => {
    const { consult, conv, ids } = await seedConsult();
    const down = { ...fakes(), [PP.orders]: () => new Response("paypal down", { status: 503 }), [PP.token]: () => new Response("paypal down", { status: 503 }) };
    const { app } = makeApp(down);
    const noPayPal = doctorEnv({ PAYPAL_CLIENT_ID: "" });
    expect((await post(app, consult, approvedBody(ids), noPayPal)).status).toBe(201);
    const msgs = (await messages(conv)).results.map((m) => m.text).join("\n");
    expect(msgs).toContain("amoxicilina · 250 mg · cada 12 h · 7 días");
    expect(msgs).toContain("INDICACIONES URGENTES");
    expect(msgs).not.toContain("sandbox.paypal.com");
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(1);
    expect(await count("delivery_tokens", "consult_id = ?1", consult)).toBe(2);
    // Unconfigured → 503 before any write. Configured but down (fresh app: the client is memoised per
    // instance) → the PayPalError surfaces as 500 and nothing is written; the button stays retryable.
    expect((await charge(app, consult, noPayPal)).status).toBe(503);
    expect((await charge(makeApp(down).app, consult)).status).toBe(500);
    expect(await count("charges", "consult_id = ?1", consult)).toBe(0);
    expect((await messages(conv)).results.map((m) => m.text).join("\n")).not.toContain("Liga para pagar");
  });

  it("M6-b3: balance 0 → «Generar cobro» 409; «Generar cobro» before approval → 409", async () => {
    const paid = await seedConsult({ depositCents: 200000 });
    await depositCaptured(paid.appt, 200000);
    const { app, calls } = makeApp(fakes());
    expect((await charge(app, paid.consult)).status).toBe(409);
    expect((await post(app, paid.consult, approvedBody(paid.ids))).status).toBe(201);
    expect((await charge(app, paid.consult)).status).toBe(409);
    expect(calls.filter((c) => c.key === PP.orders)).toHaveLength(0);
  });

  it("fail-closed: approve without PUBLIC_BASE_URL → 503 before any write", async () => {
    const { app } = makeApp(fakes());
    // Balance 0 never calls PayPal, but the owner links must still be absolute.
    const paid = await seedConsult({ depositCents: 200000 });
    await depositCaptured(paid.appt, 200000);
    expect((await post(app, paid.consult, approvedBody(paid.ids), doctorEnv({ PUBLIC_BASE_URL: undefined }))).status).toBe(503);
    expect((await messages(paid.conv)).results).toHaveLength(0);
    expect(await count("consult_bills", "consult_id = ?1", paid.consult)).toBe(0);
  });
});

describe("«Enviar al dueño» (second approval of the AI explanation)", () => {
  const EXPLANATION = "Su perro tiene gastroenteritis leve; amoxicilina 250 mg cada 12 h por 7 días.";
  const pdfText = async (approvalId: string) => new TextDecoder("latin1").decode(await (await env.FILES.get(`reports/${approvalId}/report.pdf`))!.arrayBuffer());

  it("SEND-1/2: nothing written by the AI reaches the owner before the click; the click sends it once and puts it in the report", async () => {
    const { consult, conv, ids } = await seedConsult();
    const logs = captureLogs();
    const { app } = makeApp(fakes());
    try {
      const res = await post(app, consult, approvedBody(ids));
      expect(res.status).toBe(201);
      const out = (await res.json()) as { approval_id: string; explanation: string; explanation_source: string };
      expect(out).toMatchObject({ explanation: EXPLANATION, explanation_source: "ai" });
      // Before the click: the chat has the rx only, the report has no "En palabras sencillas" section.
      expect((await messages(conv)).results.map((m) => m.text).join("\n")).not.toContain("gastroenteritis leve");
      expect(await pdfText(out.approval_id)).not.toContain("En palabras sencillas");
      expect((await sendExplanation(app, consult, {})).status).toBe(401);
      expect(await count("explanation_releases", "consult_id = ?1", consult)).toBe(0);

      const delivery = await app.request(`/api/v1/consults/${consult}/delivery`, { headers: doctorHeaders() }, doctorEnv());
      expect(await delivery.json()).toMatchObject({ approved: true, explanation: EXPLANATION, explanation_sent_at: null, charge: null, balance_cents: 95575 });

      const sent = await sendExplanation(app, consult);
      expect(sent.status).toBe(201);
      const texts = (await messages(conv)).results.map((m) => m.text);
      expect(texts.filter((t) => t.includes(EXPLANATION))).toHaveLength(1);
      expect(texts.at(-1)).toMatch(/revisada por el m/);
      expect(await pdfText(out.approval_id)).toContain("En palabras sencillas");
      const release = await env.DB.prepare("SELECT released_by FROM explanation_releases WHERE consult_id = ?1").bind(consult).first<{ released_by: string }>();
      expect(release?.released_by).toBe("val");
      expect(((await (await app.request(`/api/v1/consults/${consult}/delivery`, { headers: doctorHeaders() }, doctorEnv())).json()) as { explanation_sent_at: string | null }).explanation_sent_at).not.toBeNull();

      // SEND-3: a second click → 409, no second message; append-only release row.
      expect((await sendExplanation(app, consult)).status).toBe(409);
      expect((await messages(conv)).results.filter((m) => m.text.includes(EXPLANATION))).toHaveLength(1);
      await expect(env.DB.prepare("DELETE FROM explanation_releases WHERE consult_id = ?1").bind(consult).run()).rejects.toThrow(/append-only/);
      assertNoPii(logs.lines);
      expect(logs.lines.join("\n")).not.toContain("gastroenteritis");
    } finally {
      logs.restore();
    }
  });

  it("SEND-3: two concurrent clicks → [201, 409] and ONE message", async () => {
    const { consult, conv, ids } = await seedConsult();
    const { app } = makeApp(fakes());
    expect((await post(app, consult, approvedBody(ids))).status).toBe(201);
    const before = (await messages(conv)).results.length;
    const [a, b] = await Promise.all([sendExplanation(app, consult), sendExplanation(app, consult)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((await messages(conv)).results.length).toBe(before + 1);
    expect(await count("explanation_releases", "consult_id = ?1", consult)).toBe(1);
  });

  it("not approved yet → 409 and nothing sent", async () => {
    const { consult, conv } = await seedConsult();
    const { app } = makeApp(fakes());
    expect((await sendExplanation(app, consult)).status).toBe(409);
    expect((await messages(conv)).results).toHaveLength(0);
  });
});
