import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovedConsult, ConsultDraft, FILL_CONSULT_TOOL } from "../src/clinical/schema";
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
    // ADENDA 2: the rx is never in the chat; the owner gets the fixed notice, urgent instructions and the bill.
    expect(rxMsgs).toContain("La receta te la entrega la doctora impresa y firmada.");
    expect(rxMsgs).not.toContain("amoxicilina");
    expect(rxMsgs).not.toContain("/rx/");
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
    expect(msgs).not.toContain("/rx/");
    expect(msgs).toContain("/t/");
    expect(msgs).toContain("881.00");
    expect(msgs).toMatch(/\nPagar saldo \(\$881\.00 MXN\): https:\/\/www\.sandbox\.paypal\.com\/\S+\nAl pagar recibirás el informe completo\.$/m); // the URL ends its line: no «.» glued to the href
    expect(msgs.split("\nTotal ").length - 1, "the account once").toBe(1);
    expect(msgs).not.toContain("/r/"); // the report is announced only when the balance is captured
    // Second click: same charge and link, no second order, no second message (M6-b idempotency).
    const msgsBefore = (await messages(conv)).results.length;
    const again = await charge(app, consult);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ charge_id: `balance-${consult}`, approve_url: expect.stringMatching(/^https:\/\/www\.sandbox\.paypal\.com\//) });
    expect(calls.filter((c) => c.key === PP.orders)).toHaveLength(1);
    expect((await messages(conv)).results.length).toBe(msgsBefore);
    expect(await count("charges", "consult_id = ?1", consult)).toBe(1);
    expect((await env.DB.prepare("SELECT status FROM consults WHERE id = ?1").bind(consult).first<{ status: string }>())?.status).toBe("approved");
    expect(await count("delivery_tokens", "consult_id = ?1", consult)).toBe(3); // approval: ticket + report; «Generar cobro»: the ticket link sent with the pay link
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
    expect(msgs).toContain("La receta te la entrega la doctora impresa y firmada.");
    expect(msgs).toContain("INDICACIONES URGENTES");
    expect(msgs).not.toContain("sandbox.paypal.com");
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(1);
    expect(await count("delivery_tokens", "consult_id = ?1", consult)).toBe(2);
    // Unconfigured → 503 before any write. Configured but down (fresh app: the client is memoised per
    // instance) → the PayPalError surfaces as 500 and nothing is written; the button stays retryable.
    expect((await charge(app, consult, noPayPal)).status).toBe(503);
    expect((await charge(makeApp(down).app, consult)).status).toBe(500);
    expect(await count("charges", "consult_id = ?1", consult)).toBe(0);
    expect((await messages(conv)).results.map((m) => m.text).join("\n")).not.toContain("Pagar saldo");
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
      expect(texts.at(-1)!.startsWith("Resumen de la consulta de Firulais, revisado por la doctora:\n")).toBe(true);
      expect(texts.at(-1)).not.toContain("Total"); // no account, no links in the summary
      expect(texts.at(-1)).not.toContain("https://");
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

  it("template fallback with every leaf at the schema maximum → approve 201 (never a 500 from the CHECK), explanation ≤ 2000, rx sent", async () => {
    const { consult, conv, ids } = await seedConsult();
    const { app, calls } = makeApp(fakes());
    const doc = (value: unknown) => ({ value, source: "doctor" });
    const med = { medicamento: doc("a".repeat(2000)), dosis: doc("5 mg"), frecuencia: doc("cada 8 h"), duracion: doc("3 días"), via_administracion: doc("oral"), catalog_item_id: ids["MED-AMOXI"] };
    const body = approvedBody(ids, { assessment: { diagnostico: doc("d".repeat(2000)), pronostico: doc("favorable") }, prescription: Array.from({ length: 20 }, () => med), plan: { instrucciones_cliente: doc("i".repeat(2000)) } });
    const res = await post(app, consult, body, doctorEnv({ ANTHROPIC_API_KEY: undefined }));
    expect(res.status).toBe(201);
    const out = (await res.json()) as { explanation: string; explanation_source: string };
    expect(out.explanation_source).toBe("template");
    expect(out.explanation.length).toBeLessThanOrEqual(2000);
    expect(calls.filter((c) => c.key === PP.claude)).toHaveLength(0);
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(1);
    expect((await messages(conv)).results.map((m) => m.text).join("\n")).toContain("La receta te la entrega la doctora impresa y firmada."); // ADENDA 2: the rx stays on paper
  });

  it("not approved yet → 409 and nothing sent", async () => {
    const { consult, conv } = await seedConsult();
    const { app } = makeApp(fakes());
    expect((await sendExplanation(app, consult)).status).toBe(409);
    expect((await messages(conv)).results).toHaveLength(0);
  });

  it("ratchet E13: the rx message is the doctor's (is_bot = 0) → an owner chat right after approval gets no bot reply", async () => {
    const { consult, conv, appt, ids } = await seedConsult();
    await depositCaptured(appt, 20000);
    const { app, count: calls } = makeApp(fakes());
    expect((await post(app, consult, approvedBody(ids))).status).toBe(201);
    expect(await count("messages", "conversation_id = ?1 AND direction = 'outbound' AND is_bot = 0", conv)).toBeGreaterThan(0);
    const before = calls(PP.claude);
    const chat = await app.request("/api/v1/sim/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: conv, text: "¿y ahora qué hago?" }) }, env);
    expect(await chat.json()).toEqual({ reply: null, escalated: false });
    expect(calls(PP.claude)).toBe(before);
  });
});

describe("bill breakdown, editable quantities and owner-sourced medications (BB1–BB4)", () => {
  const doc = (value: unknown) => ({ value, source: "doctor" });
  const preview = (app: ReturnType<typeof makeApp>["app"], consult: string, body: unknown) =>
    app.request(`/api/v1/consults/${consult}/bill-preview`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) }, doctorEnv());
  const delivery = (app: ReturnType<typeof makeApp>["app"], consult: string) => app.request(`/api/v1/consults/${consult}/delivery`, { headers: doctorHeaders() }, doctorEnv());
  const expectedLines = [
    { catalog_item_id: expect.any(String), name: "Consulta general", quantity: 1, unit_price: "$450.00 MXN", line_total_cents: 45000, source: "doctor_added" },
    { catalog_item_id: expect.any(String), name: "MED-AMOXI", quantity: 1, unit_price: "$125.25 MXN", line_total_cents: 12525, source: "ai_detected" },
    { catalog_item_id: expect.any(String), name: "VAC-RABIA", quantity: 1, unit_price: "$380.50 MXN", line_total_cents: 38050, source: "doctor_added" },
  ];

  it("BB1: consult + 1 medication + 1 vaccine → preview and /delivery list the 3 lines; total = Σ subtotals; balance = total − captured deposit", async () => {
    const { consult, appt, ids } = await seedConsult();
    await depositCaptured(appt, 20000);
    const { app } = makeApp(fakes());
    const pv = (await (await preview(app, consult, approvedBody(ids))).json()) as Record<string, unknown>;
    expect(pv).toEqual({ lines: expectedLines, total_cents: 95575, deposit_cents: 20000, balance_cents: 75575 });
    expect(await count("bill_lines", "consult_id = ?1", consult)).toBe(0);
    expect((await post(app, consult, approvedBody(ids))).status).toBe(201);
    const dl = (await (await delivery(app, consult)).json()) as Record<string, unknown>;
    expect(dl).toMatchObject({ approved: true, lines: expectedLines, total_cents: 95575, deposit_cents: 20000, balance_cents: 75575 });
    expect(dl.lines).toEqual(pv.lines); // what the console shows after a reload is the snapshot, field by field
    expect(await count("bill_lines", "consult_id = ?1", consult)).toBe(3);
  });

  it("BB2: a quantity the doctor typed (14) → subtotal 14 × unit price, source doctor_added", async () => {
    const { consult, appt, ids } = await seedConsult();
    await depositCaptured(appt, 20000);
    const { app } = makeApp(fakes());
    const body = approvedBody(ids, { billable: [{ catalog_item_id: ids["MED-AMOXI"], quantity: doc(14) }] });
    const out = (await (await post(app, consult, body)).json()) as { lines: Record<string, unknown>[]; total_cents: number; balance_cents: number };
    expect(out.lines[1]).toEqual({ catalog_item_id: ids["MED-AMOXI"], name: "MED-AMOXI", quantity: 14, unit_price: "$125.25 MXN", line_total_cents: 175350, source: "doctor_added" });
    expect(out.total_cents).toBe(45000 + 175350 + 38050);
    expect(out.balance_cents).toBe(out.total_cents - 20000);
    const row = await env.DB.prepare("SELECT quantity, line_total_cents, source FROM bill_lines WHERE consult_id = ?1 AND catalog_item_id = ?2").bind(consult, ids["MED-AMOXI"]).first();
    expect(row).toEqual({ quantity: 14, line_total_cents: 175350, source: "doctor_added" });
  });

  it("BB3: owner-sourced medication → prescribed to the owner, absent from bill_lines, total/balance drop, the order charges that exact balance; the flag stays in the approved body", async () => {
    const { consult, conv, appt, ids } = await seedConsult();
    await depositCaptured(appt, 20000);
    const { app, calls } = makeApp(fakes());
    const body = approvedBody(ids, { billable: [] });
    body.prescription[0] = { ...body.prescription[0], owner_sourced: true };
    // The console never sends a billable row for an excluded medication; a forged one is refused, nothing written.
    const forged = (await post(app, consult, { ...body, billable: [{ catalog_item_id: ids["MED-AMOXI"], quantity: doc(1) }] })) as Response;
    expect(forged.status).toBe(422);
    expect(await forged.json()).toEqual({ error: "owner-sourced item billed", status: 422 });
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(0);
    expect((await messages(conv)).results).toHaveLength(0);

    // An owner-sourced row still names a real, active catalog item (unknown ⇒ 422, nothing written).
    body.prescription.push({ ...body.prescription[0], medicamento: doc("otro"), owner_sourced: true, catalog_item_id: "not-in-catalog" });
    expect((await post(app, consult, body)).status).toBe(422);
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(0);
    body.prescription.pop();

    const out = (await (await post(app, consult, body)).json()) as { approval_id: string; lines: { name: string }[]; total_cents: number; balance_cents: number };
    expect(out.lines.map((l) => l.name)).toEqual(["Consulta general", "VAC-RABIA"]);
    expect(await env.FILES.head(`reports/${out.approval_id}/rx.pdf`)).not.toBeNull();
    expect(out).toMatchObject({ total_cents: 83050, balance_cents: 63050 });
    expect(await count("bill_lines", "consult_id = ?1 AND catalog_item_id = ?2", consult, ids["MED-AMOXI"])).toBe(0);
    const chat = (await messages(conv)).results.map((m) => m.text).join("\n");
    expect(chat).toContain("La receta te la entrega la doctora impresa y firmada.");
    const rxPdf = await app.request(`/api/v1/consults/${consult}/rx.pdf`, { headers: doctorHeaders() }, doctorEnv());
    expect(rxPdf.status).toBe(200);
    expect(new TextDecoder("latin1").decode(await rxPdf.arrayBuffer())).toContain("1. amoxicilina"); // still prescribed, on paper
    const version = await env.DB.prepare("SELECT body FROM consult_versions WHERE consult_id = ?1 AND kind = 'approved'").bind(consult).first<{ body: string }>();
    expect(JSON.parse(version!.body).prescription[0].owner_sourced).toBe(true);
    expect((await charge(app, consult)).status).toBe(201);
    const order = JSON.parse(calls.find((c) => c.key === PP.orders)!.body);
    expect(order.purchase_units[0].amount).toMatchObject({ currency_code: "MXN", value: "630.50" });
    expect(order.purchase_units[0].items.map((i: { name: string }) => i.name)).toEqual(["Consulta general", "VAC-RABIA"]);
  });

  it("BB3b: the same catalog item excluded on one row and sold on another (medication or vaccine), with the billable row the console sends, is billed once", async () => {
    const { consult, ids } = await seedConsult();
    const { app } = makeApp(fakes());
    // As the console sends it: the sold row contributes its billable line; the excluded row contributes nothing.
    const body = approvedBody(ids, { billable: [{ catalog_item_id: ids["MED-AMOXI"], quantity: doc(1) }] });
    body.prescription = [{ ...body.prescription[0], owner_sourced: true }, { ...body.prescription[0], medicamento: doc("amoxicilina (segunda caja)") }];
    const out = (await (await preview(app, consult, body)).json()) as { lines: { name: string; quantity: number }[] };
    expect(out.lines.map((l) => [l.name, l.quantity])).toEqual([["Consulta general", 1], ["MED-AMOXI", 1], ["VAC-RABIA", 1]]);
    // Sold as a VACCINE while excluded as a medication: still one line (the vaccine's).
    const vax = approvedBody(ids, { billable: [{ catalog_item_id: ids["MED-AMOXI"], quantity: doc(1) }], vaccines: [{ vacuna: doc("rabia"), catalog_item_id: ids["MED-AMOXI"] }] });
    vax.prescription = [{ ...vax.prescription[0], owner_sourced: true }];
    const out2 = (await (await preview(app, consult, vax)).json()) as { lines: { name: string; quantity: number }[] };
    expect(out2.lines.map((l) => [l.name, l.quantity])).toEqual([["Consulta general", 1], ["MED-AMOXI", 1]]);
  });

  it("BB5/R6: the model's schema (ConsultDraft) rejects owner_sourced; only the approved schema accepts it", () => {
    const med = { medicamento: { value: "amoxicilina", segment_ids: [1], quote: "amoxicilina" }, owner_sourced: true };
    const empty = { subjective: {}, vitals: {}, physical_exam: {}, assessment: {}, plan: {}, vaccines: [], billable: [] };
    expect(ConsultDraft.safeParse({ ...empty, prescription: [med] }).success).toBe(false);
    expect(ApprovedConsult.safeParse({ ...empty, prescription: [{ ...med, medicamento: { ...med.medicamento, source: "ai" } }] }).success).toBe(true);
    expect(FILL_CONSULT_TOOL.input_schema && JSON.stringify(FILL_CONSULT_TOOL.input_schema)).not.toContain("owner_sourced");
  });

  it("BB4: quantity 0 / 101 / 1.5, unknown id, non-boolean flag → 422 and nothing written", async () => {
    const { consult, conv, ids } = await seedConsult();
    const { app, calls } = makeApp(fakes());
    const bad = [
      ...[0, 101, 1.5].map((q) => approvedBody(ids, { billable: [{ catalog_item_id: ids["MED-AMOXI"], quantity: doc(q) }] })),
      approvedBody(ids, { billable: [{ catalog_item_id: "not-in-catalog", quantity: doc(1) }] }),
    ];
    for (const body of bad) {
      expect((await preview(app, consult, body)).status).toBe(422);
      expect((await post(app, consult, body)).status).toBe(422);
    }
    // A non-boolean flag is refused by the SCHEMA itself (no billable row, so no other barrier can catch it).
    const flagged = approvedBody(ids, { billable: [] });
    flagged.prescription[0] = { ...flagged.prescription[0], owner_sourced: "sí" };
    for (const res of [await preview(app, consult, flagged), await post(app, consult, flagged)]) {
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "invalid body", issues: ["prescription.0.owner_sourced"] });
    }
    expect(await count("consult_bills", "consult_id = ?1", consult)).toBe(0);
    expect(await count("bill_lines", "consult_id = ?1", consult)).toBe(0);
    expect((await messages(conv)).results).toHaveLength(0);
    expect(calls.length).toBe(0);
  });
});

describe("the rx is printed by the doctor, never sent (ADENDA 2)", () => {
  it("AD2: after approval the chat has no rx link and carries the fixed notice; /rx/<anything> → 404; the doctor's rx.pdf route: 401 without credential, 200 PDF with it, 404 before approval; the ticket token serves ONLY ticket.pdf", async () => {
    const { consult, conv, ids } = await seedConsult();
    const { app } = makeApp(fakes());
    const rxRoute = (headers: Record<string, string> = doctorHeaders()) => app.request(`/api/v1/consults/${consult}/rx.pdf`, { headers }, doctorEnv());
    expect((await rxRoute()).status).toBe(404); // not approved yet
    expect((await rxRoute({})).status).toBe(401);
    const res = await post(app, consult, approvedBody(ids));
    expect(res.status).toBe(201);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).not.toHaveProperty("rx_url");
    const ticketToken = String(out.ticket_url).split("/t/")[1]!;
    const chat = (await messages(conv)).results.map((m) => m.text).join("\n");
    expect(chat).toContain("La receta te la entrega la doctora impresa y firmada.");
    expect(chat).not.toMatch(/\/rx\/|Receta en PDF|amoxicilina/);
    for (const path of [`/rx/${ticketToken}`, "/rx/anything", `/rx/${"A".repeat(43)}`]) expect((await app.request(path, {}, doctorEnv())).status, path).toBe(404);
    const ticket = await app.request(`/t/${ticketToken}`, {}, doctorEnv());
    expect(ticket.status).toBe(200);
    const ticketText = new TextDecoder("latin1").decode(await ticket.arrayBuffer());
    expect(ticketText).toContain("/BaseFont /Courier");
    expect(ticketText).toMatch(/\(  Ticket \d{2}\/\d{2}\/\d{4} · Firulais\) Tj/);
    expect(ticketText).not.toContain("Medicamentos");
    expect((await rxRoute({})).status).toBe(401);
    const pdf = await rxRoute();
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("cache-control")).toBe("no-store");
    expect(pdf.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const rxText = new TextDecoder("latin1").decode(await pdf.arrayBuffer());
    expect(rxText).toContain("1. amoxicilina");
    expect(rxText).toContain("Original para el médico: imprimir, firmar y entregar.");
  });
});

describe("snapshot prices (TK4)", () => {
  it("TK4: after approval the catalog price changes; «Generar cobro» sends the SNAPSHOT unit price, never today's", async () => {
    const { consult, conv, ids } = await seedConsult();
    const { app, calls } = makeApp(fakes());
    expect((await post(app, consult, approvedBody(ids))).status).toBe(201);
    await env.DB.prepare("UPDATE catalog_items SET price_cents = 99999 WHERE id = ?1").bind(ids["MED-AMOXI"]).run();
    expect((await charge(app, consult)).status).toBe(201);
    const pay = (await messages(conv)).results.map((m) => m.text).find((m) => m.includes("Pagar saldo"))!;
    expect(pay).toContain("MED-AMOXI\n  1 x $125.25            $125.25\n");
    expect(pay).not.toContain("999.99");
    const order = JSON.parse(calls.find((c) => c.key === PP.orders)!.body);
    expect(order.purchase_units[0].items.map((i: { name: string; unit_amount: { value: string } }) => [i.name, i.unit_amount.value])).toContainEqual(["MED-AMOXI", "125.25"]);
  });
});
