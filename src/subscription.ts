// The clinic's subscription (PayPal Subscriptions, sandbox). Append-only rows over D1, same
// discipline as the ledger: the price lives on the server, every state change comes from a
// verified webhook whose amount AND currency match ours, and the AI gate reads the derived view.
import { z } from "zod";
import type { Env } from "./env";
import { valueToCents } from "./money";
import { redactWebhook } from "./ledger";
import { log } from "./log";

/** Demo plan price: $999.00 MXN a month. Mirrors the PayPal plan; the client never sends an amount. */
export const SUBSCRIPTION_PRICE_CENTS = 99900;

export type SubscriptionState = "approval_pending" | "active" | "suspended" | "cancelled" | "expired";
type EventKind = "created" | "activated" | "payment" | "payment_failed" | "suspended" | "cancelled" | "expired" | "amount_mismatch";

export interface SubscriptionRow {
  id: string;
  paypal_subscription_id: string;
  plan_id: string;
  amount_cents: number;
  currency: string;
  approve_url: string | null;
  created_at: string;
  state: SubscriptionState | null;
  next_billing_at: string | null;
}
const COLUMNS = "id, paypal_subscription_id, plan_id, amount_cents, currency, approve_url, created_at, state, next_billing_at";

/** Default ON. Only the exact text "false" switches the AI gate off (emergency switch for the demo). */
export function subscriptionRequired(env: Env): boolean {
  return env.SUBSCRIPTION_REQUIRED !== "false";
}

/**
 * The clinic's subscription: an ACTIVE row wins over any newer one (a stale approval can be paid
 * after /start issued a replacement), otherwise the latest row. Gate, GET and /start all read this.
 */
export function currentSubscription(db: D1Database, where: "1 = 1" | "paypal_subscription_id = ?1" = "1 = 1", value?: string) {
  const q = db.prepare(`SELECT ${COLUMNS} FROM subscription_current WHERE ${where} ORDER BY (state = 'active') DESC, seq DESC LIMIT 1`);
  return (value === undefined ? q : q.bind(value)).first<SubscriptionRow>();
}

/** A pending approval older than this is abandoned: /start issues a fresh subscription. */
export const PENDING_TTL_MS = 30 * 60_000;

/** Throws when D1 fails: the caller denies (503), never passes. */
export async function isSubscriptionActive(env: Env): Promise<boolean> {
  return (await currentSubscription(env.DB))?.state === "active";
}

export function eventInsert(db: D1Database, subscriptionId: string, kind: EventKind, state: SubscriptionState | null, eventId: string | null, amountCents: number | null, currency: string | null, nextBillingAt: string | null, raw: string) {
  return db
    .prepare(
      `INSERT INTO subscription_events (subscription_id, kind, state, paypal_event_id, amount_cents, currency, next_billing_at, raw)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT DO NOTHING`,
    )
    .bind(subscriptionId, kind, state, eventId, amountCents, currency, nextBillingAt, raw);
}

// Resource shapes [subscriptions/v1 schema: subscription.status, plan_id, billing_info.last_payment,
// billing_info.next_billing_time]. PAYMENT.SALE.COMPLETED is the deprecated Payments v1 "sale":
// amount.total / amount.currency, billing_agreement_id = the subscription id (not measured in sandbox).
const Money = z.object({ currency_code: z.string().length(3), value: z.string() });
const SubscriptionResource = z.object({
  id: z.string().min(1),
  plan_id: z.string().max(40).optional(), // required to ACTIVATE (checked below); a deactivation applies on the subscription id alone
  billing_info: z
    .object({ last_payment: z.object({ amount: Money }).optional(), next_billing_time: z.string().max(40).optional() })
    .optional(),
});
const SaleResource = z.object({
  id: z.string().min(1),
  billing_agreement_id: z.string().min(1),
  amount: z.object({ total: z.string(), currency: z.string().length(3) }),
});

const STATE_EVENTS: Record<string, { kind: EventKind; state: SubscriptionState | null }> = {
  "BILLING.SUBSCRIPTION.ACTIVATED": { kind: "activated", state: "active" },
  "BILLING.SUBSCRIPTION.SUSPENDED": { kind: "suspended", state: "suspended" },
  "BILLING.SUBSCRIPTION.CANCELLED": { kind: "cancelled", state: "cancelled" },
  "BILLING.SUBSCRIPTION.EXPIRED": { kind: "expired", state: "expired" },
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED": { kind: "payment_failed", state: null },
};

/**
 * Handles one VERIFIED, not-yet-seen webhook event. Returns the response status, or null when the
 * event is not about subscriptions. Only OUR row (paypal_subscription_id) changes; only a payment
 * whose amount AND currency equal our price activates; a mismatch is recorded and activates nothing.
 */
export async function handleSubscriptionEvent(env: Env, event: { id: string; event_type: string; resource: Record<string, unknown> }): Promise<string | null> {
  const stateEvent = STATE_EVENTS[event.event_type];
  const isSale = event.event_type === "PAYMENT.SALE.COMPLETED";
  if (!stateEvent && !isSale) return null;
  const raw = JSON.stringify(redactWebhook(event));

  let subId: string;
  let paid: { amountCents: number; currency: string } | null = null;
  let planId: string | null = null;
  let nextBillingAt: string | null = null;
  try {
    if (isSale) {
      const r = SaleResource.parse(event.resource);
      subId = r.billing_agreement_id;
      paid = { amountCents: valueToCents(r.amount.total), currency: r.amount.currency };
    } else {
      const r = SubscriptionResource.parse(event.resource);
      subId = r.id;
      planId = r.plan_id ?? null;
      nextBillingAt = r.billing_info?.next_billing_time ?? null;
      const lp = r.billing_info?.last_payment?.amount;
      if (lp) paid = { amountCents: valueToCents(lp.value), currency: lp.currency_code };
    }
  } catch {
    log("subscription_webhook_unknown", { event_id: event.id, reason: "invalid_resource" });
    return "invalid_resource";
  }
  const sub = await currentSubscription(env.DB, "paypal_subscription_id = ?1", subId);
  if (!sub) {
    log("subscription_webhook_unknown", { event_id: event.id, reason: "unknown_subscription" });
    return "ignored";
  }
  if (stateEvent?.kind === "activated") {
    // Activation is the guarded direction: our plan, and never over a terminal state (a stale retry
    // of ACTIVATED after CANCELLED/EXPIRED would otherwise reopen the AI gate for free).
    if (planId !== sub.plan_id) {
      log("subscription_webhook_unknown", { event_id: event.id, reason: "plan_mismatch" });
      return "ignored";
    }
    if (sub.state === "cancelled" || sub.state === "expired") {
      log("subscription_webhook_unknown", { event_id: event.id, reason: "stale_activation" });
      return "ignored";
    }
  }

  let kind: EventKind;
  let state: SubscriptionState | null;
  // Money gate on BOTH paths to `active`: ACTIVATED with its last payment, or the first SALE.
  const amountOk = paid !== null && paid.amountCents === sub.amount_cents && paid.currency === sub.currency;
  if (isSale) {
    kind = amountOk ? "payment" : "amount_mismatch";
    // A payment only activates a subscription awaiting its first charge; a suspended, cancelled or
    // expired one is reactivated by PayPal's own ACTIVATED event, never resurrected by a sale.
    state = amountOk && sub.state === "approval_pending" ? "active" : null;
  } else if (stateEvent!.kind === "activated") {
    kind = amountOk ? "activated" : "amount_mismatch";
    state = amountOk ? "active" : null;
  } else {
    kind = stateEvent!.kind;
    state = stateEvent!.state;
  }
  await eventInsert(env.DB, sub.id, kind, state, event.id, paid?.amountCents ?? null, paid?.currency ?? null, nextBillingAt, raw).run();
  log("subscription_webhook_processed", { event_id: event.id, subscription_id: sub.id, kind, state });
  return kind;
}
