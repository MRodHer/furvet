// POST /api/v1/paypal/webhook — public surface. Strict order (Security Charter):
//   1. webhook id configured, else 503 (fail-closed)
//   2. body size cap (413) — raw body read ONCE
//   3. all five PayPal headers present (400)
//   4. signature verified by PayPal (400) — BEFORE any parse beyond JSON, BEFORE any DB write
//   5. parse + validate shape (400)
//   6. idempotency: paypal_event_id UNIQUE; a replay is a 200 no-op
//   7. money: compare OUR capture (cents + currency) against OUR charge row; mismatch never captures
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { PayPalClient } from "../paypal";
import { WEBHOOK_HEADERS } from "../paypal";
import { currentCharge, redactWebhook, type ChargeStatus } from "../ledger";
import { valueToCents } from "../money";
import { errName, log } from "../log";

const MAX_BODY_BYTES = 64 * 1024;

const EventSchema = z.object({
  id: z.string().min(1).max(100),
  event_type: z.string().min(1).max(100),
  resource: z.record(z.string(), z.unknown()),
});
const OrderResource = z.object({
  id: z.string().min(1),
  purchase_units: z.array(z.object({ custom_id: z.string().optional() })).optional(),
});
const CaptureResource = z.object({
  id: z.string().min(1),
  custom_id: z.string().optional(),
  amount: z.object({ currency_code: z.string().length(3), value: z.string() }),
});

export function webhookRoutes(paypalFor: (env: Env) => PayPalClient | null) {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/", async (c) => {
    const env = c.env;
    const paypal = paypalFor(env);
    if (!env.PAYPAL_WEBHOOK_ID || !paypal) {
      log("paypal_webhook_rejected", { reason: "not_configured" });
      return c.json({ error: "webhook not configured" }, 503);
    }
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return c.json({ error: "too large" }, 413);
    const rawBody = await c.req.text();
    if (rawBody.length > MAX_BODY_BYTES) return c.json({ error: "too large" }, 413);

    const headers = c.req.raw.headers;
    const transmissionId = headers.get("paypal-transmission-id") ?? "";
    if (WEBHOOK_HEADERS.some((h) => !headers.get(h))) {
      log("paypal_webhook_rejected", { reason: "missing_headers" });
      return c.json({ error: "missing headers" }, 400);
    }
    if (!(await paypal.verifyWebhookSignature(headers, rawBody, env.PAYPAL_WEBHOOK_ID))) {
      log("paypal_webhook_rejected", { reason: "signature", transmission_id: transmissionId });
      return c.json({ error: "invalid signature" }, 400);
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const parsed = EventSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid event" }, 400);
    const event = parsed.data;

    const seen = await env.DB.prepare("SELECT 1 AS x FROM charge_events WHERE paypal_event_id = ?1").bind(event.id).first();
    if (seen) {
      log("paypal_webhook_duplicate", { event_id: event.id });
      return c.json({ status: "duplicate" });
    }
    const raw = JSON.stringify(redactWebhook(event));

    switch (event.event_type) {
      case "CHECKOUT.ORDER.APPROVED": {
        const r = OrderResource.safeParse(event.resource);
        if (!r.success) return c.json({ error: "invalid resource" }, 400);
        const charge = await currentCharge(env.DB, "paypal_order_id", r.data.id);
        if (!charge || r.data.purchase_units?.[0]?.custom_id !== charge.id) {
          log("paypal_webhook_unknown_order", { event_id: event.id });
          return c.json({ status: "ignored" });
        }
        if (charge.status === "captured") return c.json({ status: "already_captured" });

        let status: ChargeStatus;
        let captureId: string | null = null;
        let amountCents: number | null = null;
        let currency: string | null = null;
        try {
          const cap = await paypal.captureOrder(r.data.id);
          captureId = cap.captureId;
          amountCents = cap.amountCents;
          currency = cap.currency;
          status = cap.amountCents === charge.amount_cents && cap.currency === charge.currency && cap.status === "COMPLETED"
            ? "captured"
            : "amount_mismatch";
        } catch (e) {
          log("paypal_capture_failed", { charge_id: charge.id, error: errName(e) });
          status = "capture_failed";
        }
        await recordAndSettle(env, charge.id, charge.kind, charge.appointment_id, event.id, status, captureId, amountCents, currency, raw);
        log("paypal_webhook_processed", { event_id: event.id, charge_id: charge.id, status });
        return c.json({ status });
      }
      case "PAYMENT.CAPTURE.COMPLETED":
      case "PAYMENT.CAPTURE.DENIED": {
        const r = CaptureResource.safeParse(event.resource);
        if (!r.success || !r.data.custom_id) return c.json({ status: "ignored" });
        const charge = await currentCharge(env.DB, "id", r.data.custom_id);
        if (!charge) {
          log("paypal_webhook_unknown_order", { event_id: event.id });
          return c.json({ status: "ignored" });
        }
        let status: ChargeStatus = "denied";
        let amountCents: number | null = null;
        if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
          try {
            amountCents = valueToCents(r.data.amount.value);
          } catch {
            return c.json({ error: "invalid amount" }, 400);
          }
          status = amountCents === charge.amount_cents && r.data.amount.currency_code === charge.currency ? "captured" : "amount_mismatch";
        }
        await recordAndSettle(env, charge.id, charge.kind, charge.appointment_id, event.id, status, r.data.id, amountCents, r.data.amount.currency_code, raw);
        log("paypal_webhook_processed", { event_id: event.id, charge_id: charge.id, status });
        return c.json({ status });
      }
      default:
        return c.json({ status: "ignored" });
    }
  });

  return app;
}

/**
 * One atomic batch: append the event (idempotent on paypal_event_id and on
 * (charge, capture)), then flip the non-ledger state ONLY if this batch
 * appended a `captured` row. The appointment never confirms on a mismatch.
 */
async function recordAndSettle(
  env: Env,
  chargeId: string,
  kind: "deposit" | "balance",
  appointmentId: string | null,
  eventId: string,
  status: ChargeStatus,
  captureId: string | null,
  amountCents: number | null,
  currency: string | null,
  raw: string,
): Promise<void> {
  const stmts = [
    env.DB.prepare(
      `INSERT INTO charge_events (charge_id, status, paypal_event_id, paypal_capture_id, amount_cents, currency, raw)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING`,
    ).bind(chargeId, status, eventId, captureId, amountCents, currency, raw),
  ];
  if (status === "captured" && kind === "deposit" && appointmentId) {
    stmts.push(
      env.DB.prepare(
        `UPDATE appointments SET status = 'confirmed'
         WHERE id = ?1 AND status = 'pending_deposit'
           AND EXISTS (SELECT 1 FROM charge_events WHERE paypal_event_id = ?2 AND status = 'captured')`,
      ).bind(appointmentId, eventId),
    );
  }
  await env.DB.batch(stmts);
}
