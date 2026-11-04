import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { claimCharge } from "../src/ledger";
import {
  approvedEvent,
  assertNoPii,
  captureCompletedEvent,
  captureLogs,
  count,
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
  return { appt, chargeId, orderId, apptStatus, events };
}

function post(app: ReturnType<typeof makeApp>["app"], body: unknown, e = env, headers = webhookHeaders()) {
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
    const { app, count: calls } = makeApp(paypalFakes({ verify: "FAILURE" }));
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

  it("PayPal capture failure → capture_failed event, retry (new event id) can still capture", async () => {
    const { chargeId, orderId, apptStatus } = await seedDeposit();
    const failing = paypalFakes();
    failing[PP.captureAny] = () => new Response("boom", { status: 500 });
    const { app } = makeApp(failing);
    expect(await (await post(app, approvedEvent("WH-7", orderId, chargeId))).json()).toEqual({ status: "capture_failed" });
    const { app: app2 } = makeApp(paypalFakes());
    expect(await (await post(app2, approvedEvent("WH-8", orderId, chargeId))).json()).toEqual({ status: "captured" });
    expect(await apptStatus()).toBe("confirmed");
  });

  it("PAYMENT.CAPTURE.COMPLETED with exact amount → captured once; same capture id twice is one row", async () => {
    const { chargeId, events } = await seedDeposit();
    const { app } = makeApp(paypalFakes());
    expect(await (await post(app, captureCompletedEvent("WH-9", "CAP-9", chargeId, "200.00"))).json()).toEqual({ status: "captured" });
    expect(await (await post(app, captureCompletedEvent("WH-10", "CAP-9", chargeId, "200.00"))).json()).toEqual({ status: "captured" });
    expect(await events("status = 'captured'")).toBe(1);
  });

  it("PAYMENT.CAPTURE.COMPLETED with a different amount → amount_mismatch", async () => {
    const { chargeId, events } = await seedDeposit();
    const { app } = makeApp(paypalFakes());
    expect(await (await post(app, captureCompletedEvent("WH-11", "CAP-11", chargeId, "199.99"))).json()).toEqual({ status: "amount_mismatch" });
    expect(await events("status = 'captured'")).toBe(0);
  });

  it("unknown event types are acknowledged and ignored", async () => {
    const { app } = makeApp(paypalFakes());
    const res = await post(app, { id: "WH-12", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: {} });
    expect(await res.json()).toEqual({ status: "ignored" });
  });
});
