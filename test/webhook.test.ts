import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { claimCharge } from "../src/ledger";
import { DEPOSIT_CONFIRMED_TEXT, depositConfirmedText } from "../src/routes/webhook";

// seedBooking: pet «Firulais», slot 2026-11-10T10:00Z = 4:00 a.m. in America/Mexico_City.
const DEPOSIT_TEXT = depositConfirmedText({ pet_name: "Firulais", starts_at: "2026-11-10T10:00:00.000Z" });
import {
  approvedEvent,
  assertNoPii,
  captureCompletedEvent,
  captureLogs,
  count,
  json,
  makeApp,
  paypalFakes,
  PP,
  seedBooking,
  webhookHeaders,
  withEnv,
} from "./helpers";

const PATH = "/api/v1/paypal/webhook";

async function seedDeposit(amountCents = 20000) {
  const { appt, conv } = await seedBooking(amountCents);
  const chargeId = crypto.randomUUID();
  const orderId = `ORDER-${crypto.randomUUID()}`;
  await claimCharge(
    env.DB,
    { id: chargeId, kind: "deposit", appointmentId: appt, conversationId: conv, paypalOrderId: orderId, paypalRequestId: `deposit-${appt}`, amountCents, currency: "MXN", approveUrl: "https://www.sandbox.paypal.com/x" },
    {},
  );
  const apptStatus = async () => (await env.DB.prepare("SELECT status FROM appointments WHERE id = ?1").bind(appt).first<{ status: string }>())?.status;
  const events = (where = "1=1") => count("charge_events", `charge_id = ?1 AND ${where}`, chargeId);
  const botMsgs = () => count("messages", "conversation_id = ?1 AND direction = 'outbound' AND is_bot = 1 AND text = ?2", conv, DEPOSIT_TEXT);
  return { appt, conv, chargeId, orderId, apptStatus, events, botMsgs };
}

function post(app: ReturnType<typeof makeApp>["app"], body: unknown, e: Env = env, headers = webhookHeaders()) {
  return app.request(PATH, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }, e);
}

describe("PayPal webhook (E1-E4, E6, E14, D.1)", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  it("E2: no PAYPAL_WEBHOOK_ID → 503 before calling PayPal", async () => {
    const { app, count: calls } = makeApp(paypalFakes());
    const res = await post(app, { id: "E", event_type: "X", resource: {} }, withEnv({ PAYPAL_WEBHOOK_ID: "" }));
    expect(res.status).toBe(503);
    expect(calls(PP.verify)).toBe(0);
  });

  it("E1/E3: invalid signature → 400, zero rows written, no capture, no PII in logs", async () => {
    const { chargeId, orderId, apptStatus, events } = await seedDeposit();
    const logs = captureLogs();
    restore = logs.restore;
    const { app, count: calls } = makeApp(paypalFakes({ verify: { verification_status: "FAILURE" } }));
    const res = await post(app, approvedEvent("WH-1", orderId, chargeId));
    expect(res.status).toBe(400);
    expect(calls("POST api-m.sandbox.paypal.com/v2/checkout/orders/")).toBe(0);
    expect(await events("paypal_event_id IS NOT NULL")).toBe(0);
    expect(await apptStatus()).toBe("pending_deposit");
    assertNoPii(logs.lines);
    expect(logs.lines.join("\n")).toContain("paypal_webhook_rejected");
  });

  it("missing PayPal headers → 400 without calling verify", async () => {
    const { app, count: calls } = makeApp(paypalFakes());
    const res = await post(app, { id: "E", event_type: "X", resource: {} }, env, { "Content-Type": "application/json" });
    expect(res.status).toBe(400);
    expect(calls(PP.verify)).toBe(0);
  });

  it("oversized body → 413; malformed JSON after a valid signature → 400", async () => {
    const { app } = makeApp(paypalFakes());
    expect((await post(app, "x".repeat(70_000))).status).toBe(413);
    expect((await post(app, "{not json")).status).toBe(400);
  });

  it("happy path: APPROVED → own capture → captured event → appointment confirmed; no PII logged", async () => {
    const { chargeId, orderId, apptStatus } = await seedDeposit();
    const logs = captureLogs();
    restore = logs.restore;
    const { app, count: calls } = makeApp(paypalFakes({ captureValue: "200.00" }));
    const res = await post(app, approvedEvent("WH-2", orderId, chargeId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "captured" });
    expect(calls(PP.capture(orderId))).toBe(1);
    const ev = await env.DB.prepare("SELECT status, paypal_capture_id, amount_cents, raw FROM charge_events WHERE paypal_event_id = 'WH-2'").first<{ status: string; paypal_capture_id: string; amount_cents: number; raw: string }>();
    expect(ev).toMatchObject({ status: "captured", paypal_capture_id: "CAP-1", amount_cents: 20000 });
    expect(ev?.raw).not.toContain("buyer@example.com");
    expect(await apptStatus()).toBe("confirmed");
    assertNoPii(logs.lines);
  });

  it("E4: replay of the same event id → 200 duplicate, capture called once, one event", async () => {
    const { chargeId, orderId, events } = await seedDeposit();
    const { app, count: calls } = makeApp(paypalFakes());
    const body = approvedEvent("WH-3", orderId, chargeId);
    expect((await post(app, body)).status).toBe(200);
    const second = await post(app, body);
    expect(await second.json()).toEqual({ status: "duplicate" });
    expect(calls(PP.capture(orderId))).toBe(1);
    expect(await events("paypal_event_id = 'WH-3'")).toBe(1);
  });

  it("E6: capture amount differs by one cent → amount_mismatch, never captured, appointment stays pending", async () => {
    const { chargeId, orderId, apptStatus, events } = await seedDeposit();
    const { app } = makeApp(paypalFakes({ captureValue: "200.01" }));
    const res = await post(app, approvedEvent("WH-4", orderId, chargeId));
    expect(await res.json()).toEqual({ status: "amount_mismatch" });
    expect(await events("status = 'captured'")).toBe(0);
    expect(await events("status = 'amount_mismatch'")).toBe(1);
    expect(await apptStatus()).toBe("pending_deposit");
  });

  it("capture that is not COMPLETED is not a payment", async () => {
    const { chargeId, orderId } = await seedDeposit();
    const { app } = makeApp(paypalFakes({ captureStatus: "PENDING" }));
    const res = await post(app, approvedEvent("WH-5", orderId, chargeId));
    expect(await res.json()).toEqual({ status: "amount_mismatch" });
  });

  it("custom_id that does not match our charge → ignored, nothing written", async () => {
    const { orderId, events } = await seedDeposit();
    const { app, count: calls } = makeApp(paypalFakes());
    const res = await post(app, approvedEvent("WH-6", orderId, crypto.randomUUID()));
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(calls("POST api-m.sandbox.paypal.com/v2/checkout/orders/")).toBe(0);
    expect(await events("paypal_event_id IS NOT NULL")).toBe(0);
  });

  it("M2: transient capture failure → 503, event id NOT sealed; PayPal's retry of the SAME body captures", async () => {
    const { chargeId, orderId, apptStatus, events } = await seedDeposit();
    const failing = paypalFakes();
    failing[PP.captureAny] = () => new Response("boom", { status: 500 });
    const { app } = makeApp(failing);
    const body = approvedEvent("WH-7", orderId, chargeId);
    const first = await post(app, body);
    expect(first.status).toBe(503);
    expect(await events("status = 'capture_failed'")).toBe(1);
    expect(await events("paypal_event_id = 'WH-7'")).toBe(0);
    const { app: app2 } = makeApp(paypalFakes());
    const retry = await post(app2, body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: "captured" });
    expect(await events("paypal_event_id = 'WH-7' AND status = 'captured'")).toBe(1);
    expect(await apptStatus()).toBe("confirmed");
  });

  it("M3: capture in another currency with the same number → amount_mismatch (both webhook paths)", async () => {
    const a = await seedDeposit();
    const { app } = makeApp(paypalFakes({ captureCurrency: "USD", captureValue: "200.00" }));
    expect(await (await post(app, approvedEvent("WH-13", a.orderId, a.chargeId))).json()).toEqual({ status: "amount_mismatch" });
    expect(await a.events("status = 'captured'")).toBe(0);
    expect(await a.apptStatus()).toBe("pending_deposit");

    const b = await seedDeposit();
    const { app: app2 } = makeApp(paypalFakes());
    expect(await (await post(app2, captureCompletedEvent("WH-14", "CAP-14", b.chargeId, "200.00", "USD", b.orderId))).json()).toEqual({ status: "amount_mismatch" });
    expect(await b.events("status = 'captured'")).toBe(0);
  });

  it("M4: verify answers anything but SUCCESS (PENDING, empty, malformed) → 400 and nothing written", async () => {
    const { chargeId, orderId, events } = await seedDeposit();
    for (const verify of [{ verification_status: "PENDING" }, {}, { verification_status: "success" }, "not-json-object"]) {
      const { app, count: calls } = makeApp(paypalFakes({ verify }));
      const res = await post(app, approvedEvent("WH-15", orderId, chargeId));
      expect(res.status, JSON.stringify(verify)).toBe(400);
      expect(calls("POST api-m.sandbox.paypal.com/v2/checkout/orders/")).toBe(0);
    }
    expect(await events("paypal_event_id IS NOT NULL")).toBe(0);
  });

  it("PAYMENT.CAPTURE.COMPLETED whose related order is not ours → ignored", async () => {
    const { chargeId, events } = await seedDeposit();
    const { app } = makeApp(paypalFakes());
    expect(await (await post(app, captureCompletedEvent("WH-16", "CAP-16", chargeId, "200.00", "MXN", "ORDER-OF-SOMEONE-ELSE"))).json()).toEqual({ status: "ignored" });
    expect(await events("paypal_event_id IS NOT NULL")).toBe(0);
  });

  it("PAYMENT.CAPTURE.COMPLETED with exact amount → captured once; same capture id twice is one row", async () => {
    const { chargeId, orderId, events } = await seedDeposit();
    const { app } = makeApp(paypalFakes());
    expect(await (await post(app, captureCompletedEvent("WH-9", "CAP-9", chargeId, "200.00", "MXN", orderId))).json()).toEqual({ status: "captured" });
    expect(await (await post(app, captureCompletedEvent("WH-10", "CAP-9", chargeId, "200.00", "MXN", orderId))).json()).toEqual({ status: "already_captured" });
    expect(await events("status = 'captured'")).toBe(1);
  });

  it("PAYMENT.CAPTURE.COMPLETED with a different amount → amount_mismatch", async () => {
    const { chargeId, orderId, events } = await seedDeposit();
    const { app } = makeApp(paypalFakes());
    expect(await (await post(app, captureCompletedEvent("WH-11", "CAP-11", chargeId, "199.99", "MXN", orderId))).json()).toEqual({ status: "amount_mismatch" });
    expect(await events("status = 'captured'")).toBe(0);
  });

  it("M3: a deposit captured for a cancelled (lazily released) appointment is logged as late, confirms nothing and says nothing", async () => {
    const { chargeId, orderId, apptStatus, appt, botMsgs } = await seedDeposit();
    await env.DB.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?1").bind(appt).run();
    const logs = captureLogs();
    restore = logs.restore;
    const { app } = makeApp(paypalFakes());
    expect(await (await post(app, captureCompletedEvent("WH-M3", "CAP-M3", chargeId, "200.00", "MXN", orderId))).json()).toEqual({ status: "captured" });
    expect(await apptStatus()).toBe("cancelled");
    expect(await botMsgs()).toBe(0);
    const late = logs.lines.filter((l) => l.includes("deposit_captured_late"));
    expect(late).toHaveLength(1);
    expect(late[0]).toContain(chargeId);
    expect(late[0]).toContain('"appointment_status":"cancelled"');
    assertNoPii(logs.lines);
  });

  describe("M1: captured is terminal (a late DENIED never un-pays a charge)", () => {
    const denied = (id: string, captureId: string, customId: string, orderId: string) => ({
      ...captureCompletedEvent(id, captureId, customId, "200.00", "MXN", orderId),
      event_type: "PAYMENT.CAPTURE.DENIED",
    });
    const current = (chargeId: string) => env.DB.prepare("SELECT status FROM charges_current WHERE id = ?1").bind(chargeId).first<{ status: string }>();

    it("code barrier: DENIED after captured → 200 already_captured, no row appended, appointment stays confirmed", async () => {
      const { chargeId, orderId, apptStatus, events } = await seedDeposit();
      const { app } = makeApp(paypalFakes());
      expect(await (await post(app, captureCompletedEvent("WH-M1a", "CAP-M1", chargeId, "200.00", "MXN", orderId))).json()).toEqual({ status: "captured" });
      expect(await (await post(app, denied("WH-M1b", "CAP-M1", chargeId, orderId))).json()).toEqual({ status: "already_captured" });
      expect(await events()).toBe(2); // created + captured; nothing for the DENIED
      expect(await events("status = 'denied'")).toBe(0);
      expect(await apptStatus()).toBe("confirmed");
      expect((await current(chargeId))?.status).toBe("captured");
    });

    it("DB barrier (0006): a denied row written straight into the ledger after captured leaves charges_current = captured", async () => {
      const { chargeId } = await seedDeposit();
      await env.DB.prepare("INSERT INTO charge_events (charge_id, status, paypal_event_id, paypal_capture_id, amount_cents, currency, raw) VALUES (?1, 'captured', ?2, ?3, 20000, 'MXN', '{}')").bind(chargeId, `WH-${chargeId}-c`, `CAP-${chargeId}`).run();
      await env.DB.prepare("INSERT INTO charge_events (charge_id, status, paypal_event_id, paypal_capture_id, amount_cents, currency, raw) VALUES (?1, 'denied', ?2, ?3, NULL, NULL, '{}')").bind(chargeId, `WH-${chargeId}-d`, `CAP-${chargeId}-d`).run();
      expect(await count("charge_events", "charge_id = ?1", chargeId)).toBe(3);
      expect((await current(chargeId))?.status).toBe("captured");
      // Without a captured row the view still shows the latest event (unchanged behaviour).
      const { chargeId: other } = await seedDeposit();
      await env.DB.prepare("INSERT INTO charge_events (charge_id, status, paypal_event_id, raw) VALUES (?1, 'denied', ?2, '{}')").bind(other, `WH-${other}-d`).run();
      expect((await current(other))?.status).toBe("denied");
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first<{ n: number }>())?.n).toBe(6);
    });
  });

  it("unknown event types are acknowledged and ignored", async () => {
    const { app } = makeApp(paypalFakes());
    const res = await post(app, { id: "WH-12", event_type: "CUSTOMER.DISPUTE.CREATED", resource: {} }); // subscription events have their own suite now
    expect(await res.json()).toEqual({ status: "ignored" });
  });

  describe("deposit confirmation message (D1-D5)", () => {
    const endTurn = (text: string) => () => json({ stop_reason: "end_turn", content: [{ type: "text", text }] });

    it("D1: captured deposit → exactly one bot message with the fixed text; appointment confirmed; no PII logged", async () => {
      const { chargeId, orderId, apptStatus, botMsgs, conv } = await seedDeposit();
      const logs = captureLogs();
      restore = logs.restore;
      const { app } = makeApp(paypalFakes({ captureValue: "200.00" }));
      expect(await (await post(app, approvedEvent("WH-D1", orderId, chargeId))).json()).toEqual({ status: "captured" });
      expect(await apptStatus()).toBe("confirmed");
      expect(await botMsgs()).toBe(1); // the ONE confirmation: pet, day and hour from OUR appointment row
      expect(DEPOSIT_TEXT).toMatch(/^¡Pago recibido! Firulais queda agendado el 10\/11\/2026 a las 4:00 .*🐾$/);
      expect(DEPOSIT_TEXT).not.toContain("..");
      expect(await count("messages", "conversation_id = ?1 AND direction = 'outbound'", conv)).toBe(1);
      expect(await count("messages", "conversation_id = ?1 AND text LIKE '%anticipo%'", conv)).toBe(0);
      assertNoPii(logs.lines);
      // Fail-safe: no readable appointment row → the fixed text, never a crash and never two messages.
      expect(depositConfirmedText(null)).toBe(DEPOSIT_CONFIRMED_TEXT);
      expect(DEPOSIT_CONFIRMED_TEXT.startsWith("¡Pago recibido!")).toBe(true);
    });

    it("D2: two concurrent deliveries of the same event, then a CAPTURE.COMPLETED for the same charge → still one message", async () => {
      const { chargeId, orderId, botMsgs, events } = await seedDeposit();
      const { app } = makeApp(paypalFakes({ captureValue: "200.00" }));
      const ev = approvedEvent("WH-D2", orderId, chargeId);
      const results = await Promise.all([post(app, ev), post(app, ev)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(await events("status = 'captured'")).toBe(1);
      expect(await botMsgs()).toBe(1);
      expect(await (await post(app, captureCompletedEvent("WH-D2b", "CAP-D2", chargeId, "200.00", "MXN", orderId))).json()).toEqual({ status: "already_captured" });
      expect(await (await post(app, ev)).json()).toEqual({ status: "duplicate" });
      expect(await botMsgs()).toBe(1);
    });

    it("D3: amount or currency mismatch → no message, appointment stays pending", async () => {
      const a = await seedDeposit();
      const { app } = makeApp(paypalFakes({ captureValue: "200.01" }));
      expect(await (await post(app, approvedEvent("WH-D3", a.orderId, a.chargeId))).json()).toEqual({ status: "amount_mismatch" });
      expect(await a.botMsgs()).toBe(0);
      expect(await a.apptStatus()).toBe("pending_deposit");
      const b = await seedDeposit();
      expect(await (await post(app, captureCompletedEvent("WH-D3b", "CAP-D3", b.chargeId, "200.00", "USD", b.orderId))).json()).toEqual({ status: "amount_mismatch" });
      expect(await b.botMsgs()).toBe(0);
    });

    it("D4: a deposit charge without conversation_id captures and confirms without failing", async () => {
      const { appt, conv } = await seedBooking();
      const chargeId = crypto.randomUUID();
      const orderId = `ORDER-${crypto.randomUUID()}`;
      await claimCharge(env.DB, { id: chargeId, kind: "deposit", appointmentId: appt, paypalOrderId: orderId, paypalRequestId: `deposit-${appt}`, amountCents: 20000, currency: "MXN", approveUrl: "https://www.sandbox.paypal.com/x" }, {});
      const { app } = makeApp(paypalFakes({ captureValue: "200.00" }));
      expect(await (await post(app, approvedEvent("WH-D4", orderId, chargeId))).json()).toEqual({ status: "captured" });
      expect((await env.DB.prepare("SELECT status FROM appointments WHERE id = ?1").bind(appt).first<{ status: string }>())?.status).toBe("confirmed");
      expect(await count("messages", "conversation_id = ?1 AND text LIKE '¡Pago recibido!%'", conv)).toBe(0);
    });

    it("ratchet D2b: the appointment is no longer pending_deposit when the capture lands → captured event, confirmed stays, 0 messages (the guard hangs off the UPDATE, not the event INSERT)", async () => {
      const { appt, chargeId, orderId, botMsgs, events, apptStatus } = await seedDeposit();
      await env.DB.prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ?1").bind(appt).run();
      const { app } = makeApp(paypalFakes({ captureValue: "200.00" }));
      expect(await (await post(app, approvedEvent("WH-D2b-pre", orderId, chargeId))).json()).toEqual({ status: "captured" });
      expect(await events("status = 'captured'")).toBe(1);
      expect(await apptStatus()).toBe("confirmed");
      expect(await botMsgs()).toBe(0);
    });

    it("D5: the confirmation is the BOT's message (is_bot = 1): the agent keeps answering the owner right after", async () => {
      const { chargeId, orderId, conv } = await seedDeposit();
      const { app } = makeApp({ ...paypalFakes({ captureValue: "200.00" }), [PP.claude]: endTurn("Te esperamos mañana.") });
      expect(await (await post(app, approvedEvent("WH-D5", orderId, chargeId))).json()).toEqual({ status: "captured" });
      const chat = await app.request("/api/v1/sim/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: conv, text: "¿a qué hora llego?" }) }, env);
      expect(await chat.json()).toEqual({ reply: "Te esperamos mañana.", escalated: false });
    });
  });
});
