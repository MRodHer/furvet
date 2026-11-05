// POST /api/v1/paypal/webhook — public surface. Strict order (Security Charter):
//   1. webhook id configured, else 503 (fail-closed)
//   2. body size cap (413) — raw body read ONCE
//   3. all five PayPal headers present (400)
//   4. signature verified by PayPal (400) — BEFORE any parse beyond JSON, BEFORE any DB write
//   5. parse + validate shape (400)
//   6. idempotency: paypal_event_id UNIQUE; a replay is a 200 no-op
//   7. money: compare OUR capture (cents + currency) against OUR charge row; mismatch never captures
//   8. a transient capture failure is NOT sealed under the event id and answers 503, so PayPal retries
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { PayPalClient } from "../paypal";
import { WEBHOOK_HEADERS } from "../paypal";
import { currentCharge, redactWebhook, type ChargeRow, type ChargeStatus } from "../ledger";
import { messageInserts, newToken, tokenInsert } from "../delivery";
import { readCapped } from "../body";
import { valueToCents } from "../money";
import { errName, log } from "../log";
import { handleSubscriptionEvent } from "../subscription";

const MAX_BODY_BYTES = 64 * 1024;
export const DEPOSIT_CONFIRMED_TEXT = "¡Recibimos tu pago de anticipo! Tu cita quedó confirmada. 🐾";

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
  supplementary_data: z.object({ related_ids: z.object({ order_id: z.string().optional() }).optional() }).optional(),
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
    // The declared length is a hint; the real cap is on the BYTES read, and the read stops there (H6).
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return c.json({ error: "too large" }, 413);
    const bytes = await readCapped(c.req.raw.body, MAX_BODY_BYTES);
    if (bytes === null) return c.json({ error: "too large" }, 413);
    const rawBody = new TextDecoder().decode(bytes);

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

    const seen = await env.DB.prepare("SELECT 1 AS x FROM charge_events WHERE paypal_event_id = ?1 UNION ALL SELECT 1 FROM subscription_events WHERE paypal_event_id = ?1").bind(event.id).first();
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
        let captureId: string;
        let amountCents: number;
        let currency: string;
        try {
          const cap = await paypal.captureOrder(r.data.id);
          captureId = cap.captureId;
          amountCents = cap.amountCents;
          currency = cap.currency;
          status = cap.amountCents === charge.amount_cents && cap.currency === charge.currency && cap.status === "COMPLETED"
            ? "captured"
            : "amount_mismatch";
        } catch (e) {
          // Transient: record the attempt WITHOUT sealing the event id and answer 503 so
          // PayPal retries the same event (it only retries on non-2xx).
          log("paypal_capture_failed", { charge_id: charge.id, event_id: event.id, error: errName(e) });
          await recordAndSettle(env, charge, null, "capture_failed", null, null, null, raw);
          return c.json({ status: "capture_failed" }, 503);
        }
        await recordAndSettle(env, charge, event.id, status, captureId, amountCents, currency, raw);
        log("paypal_webhook_processed", { event_id: event.id, charge_id: charge.id, status });
        return c.json({ status });
      }
      case "PAYMENT.CAPTURE.COMPLETED":
      case "PAYMENT.CAPTURE.DENIED": {
        const r = CaptureResource.safeParse(event.resource);
        if (!r.success || !r.data.custom_id) return c.json({ status: "ignored" });
        // H8: when the capture names its order (supplementary_data.related_ids.order_id) it must be OUR order;
        // a foreign order is ignored. Whether PayPal always sends related_ids is not measured yet (R122 smoke),
        // so a capture without it is still judged by custom_id + amount + currency, never rejected silently.
        const relatedOrder = r.data.supplementary_data?.related_ids?.order_id;
        const charge = await currentCharge(env.DB, "id", r.data.custom_id);
        if (!charge || (relatedOrder !== undefined && relatedOrder !== charge.paypal_order_id)) {
          log("paypal_webhook_unknown_order", { event_id: event.id, reason: charge ? "order_mismatch" : "unknown_charge" });
          return c.json({ status: "ignored" });
        }
        let status: ChargeStatus = "denied";
        let amountCents: number | null = null;
        if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
          // H7: a charge is captured once. A second capture (same or another capture id) neither re-settles
          // nor re-sends the owner a token; the DB index charge_events_one_captured is the second barrier.
          if (charge.status === "captured") {
            log("paypal_webhook_already_captured", { event_id: event.id, charge_id: charge.id });
            return c.json({ status: "already_captured" });
          }
          try {
            amountCents = valueToCents(r.data.amount.value);
          } catch {
            return c.json({ error: "invalid amount" }, 400);
          }
          status = amountCents === charge.amount_cents && r.data.amount.currency_code === charge.currency ? "captured" : "amount_mismatch";
        }
        await recordAndSettle(env, charge, event.id, status, r.data.id, amountCents, r.data.amount.currency_code, raw);
        log("paypal_webhook_processed", { event_id: event.id, charge_id: charge.id, status });
        return c.json({ status });
      }
      default: {
        // The clinic's own subscription (BILLING.SUBSCRIPTION.* and PAYMENT.SALE.COMPLETED).
        const status = await handleSubscriptionEvent(env, event);
        return c.json({ status: status ?? "ignored" });
      }
    }
  });

  return app;
}

/**
 * One atomic batch: append the event (idempotent on paypal_event_id and on
 * (charge, capture)), then flip the non-ledger state ONLY if this batch
 * appended a `captured` row. Nothing confirms or is delivered on a mismatch;
 * a replay inserts no event, so no second message ever goes out.
 */
async function recordAndSettle(
  env: Env,
  charge: ChargeRow,
  eventId: string | null,
  status: ChargeStatus,
  captureId: string | null,
  amountCents: number | null,
  currency: string | null,
  raw: string,
): Promise<void> {
  // Settlement rows hang off "THIS batch inserted the event" (changes() = 1 right after the
  // event INSERT), never off "the event exists": two concurrent deliveries of the same event
  // both pass the `seen` check, but only one insert lands, so only one settles.
  const stmts = [
    env.DB.prepare(
      `INSERT INTO charge_events (charge_id, status, paypal_event_id, paypal_capture_id, amount_cents, currency, raw)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING`,
    ).bind(charge.id, status, eventId, captureId, amountCents, currency, raw),
  ];
  if (status === "captured" && charge.kind === "deposit" && charge.appointment_id) {
    stmts.push(env.DB.prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ?1 AND status = 'pending_deposit' AND changes() = 1").bind(charge.appointment_id));
    // The owner hears it in the chat only when THIS batch confirmed the appointment (changes() = 1 of the
    // UPDATE above): a replay or a concurrent duplicate confirms nothing and says nothing. Fixed text, no
    // payer data, no link. is_bot = 1 so the agent keeps answering (an is_bot = 0 outbound mutes it, E13).
    if (charge.conversation_id) stmts.push(...messageInserts(env.DB, charge.conversation_id, DEPOSIT_CONFIRMED_TEXT, "changes() = 1", [], 1));
  }
  if (status === "captured" && charge.kind === "balance" && charge.consult_id && charge.conversation_id) {
    // The report link needs a clear token, which only exists at creation time → a fresh one per release.
    const { token, hash } = await newToken();
    const base = env.PUBLIC_BASE_URL ?? "";
    const tokenLanded = (n: number) => `EXISTS (SELECT 1 FROM delivery_tokens WHERE token_sha256 = ?${n})`;
    stmts.push(
      tokenInsert(env.DB, hash, charge.consult_id, "report", new Date(), "changes() = 1"),
      ...messageInserts(env.DB, charge.conversation_id, `Pago confirmado. Su informe completo está aquí: ${base}/r/${token}`, tokenLanded(4), [hash]),
      env.DB.prepare(`UPDATE consults SET status = 'delivered' WHERE id = ?1 AND status = 'approved' AND ${tokenLanded(2)}`).bind(charge.consult_id, hash),
    );
  }
  await env.DB.batch(stmts);
}
