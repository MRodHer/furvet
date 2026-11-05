// The clinic's subscription, behind the doctor's credential (doctorAuth = Basic + CSRF guard).
// The plan id and the price come from the server; the body carries nothing (strict, empty).
import { Hono } from "hono";
import { z } from "zod";
import { doctorAuth } from "../auth";
import type { Deps, Env } from "../env";
import { eventInsert, currentSubscription, PENDING_TTL_MS, SUBSCRIPTION_PRICE_CENTS, subscriptionRequired } from "../subscription";
import type { PayPalClient } from "../paypal";
import { errName, log } from "../log";
import { redactWebhook } from "../ledger";

// Derived from PAYPAL_ENV = sandbox (any other env is a 503 before this runs): https and this exact host.
const APPROVE_ORIGIN = "https://www.sandbox.paypal.com";
const StartBody = z.object({}).strict();

export function subscriptionRoutes(deps: Deps, paypalFor: (env: Env) => PayPalClient | null) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", doctorAuth());

  app.get("/", async (c) => {
    const sub = await currentSubscription(c.env.DB);
    c.header("Cache-Control", "no-store");
    return c.json({
      status: sub?.state ?? "none",
      next_billing_at: sub?.next_billing_at ?? null,
      price_cents: SUBSCRIPTION_PRICE_CENTS,
      currency: c.env.CURRENCY,
      required: subscriptionRequired(c.env),
    });
  });

  app.post("/start", async (c) => {
    const env = c.env;
    const paypal = paypalFor(env);
    if (!paypal || !env.PAYPAL_PLAN_ID || !env.PUBLIC_BASE_URL) return c.json({ error: "subscription not configured" }, 503);
    // An empty body is the only shape; anything else must parse and be the empty object.
    const text = await c.req.text();
    let json: unknown = {};
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    const body = StartBody.safeParse(json);
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const existing = await currentSubscription(env.DB);
    if (existing?.state === "active") return c.json({ error: "already active" }, 409);
    // Same link while the approval is fresh; an abandoned one (older than PENDING_TTL_MS) is superseded by a new row.
    const fresh = existing?.state === "approval_pending" && deps.now().getTime() - Date.parse(existing.created_at) < PENDING_TTL_MS;
    if (fresh && existing?.approve_url) return c.json({ approve_url: existing.approve_url });

    const id = crypto.randomUUID();
    let sub: Awaited<ReturnType<PayPalClient["createSubscription"]>>;
    try {
      sub = await paypal.createSubscription({ planId: env.PAYPAL_PLAN_ID, customId: id, requestId: id, returnUrl: `${env.PUBLIC_BASE_URL}/console`, cancelUrl: `${env.PUBLIC_BASE_URL}/console` });
    } catch (e) {
      log("subscription_start_failed", { error: errName(e) });
      return c.json({ error: "payment provider failed" }, 502);
    }
    if (new URL(sub.approveUrl).origin !== APPROVE_ORIGIN) {
      log("subscription_start_failed", { error: "approve_host" });
      return c.json({ error: "payment provider failed" }, 502);
    }
    await env.DB.batch([
      env.DB.prepare("INSERT INTO subscriptions (id, paypal_subscription_id, plan_id, amount_cents, currency, approve_url) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(
        id, sub.subscriptionId, env.PAYPAL_PLAN_ID, SUBSCRIPTION_PRICE_CENTS, env.CURRENCY, sub.approveUrl,
      ),
      eventInsert(env.DB, id, "created", "approval_pending", null, null, null, null, JSON.stringify(redactWebhook(sub.raw))),
    ]);
    log("subscription_started", { subscription_id: id });
    return c.json({ approve_url: sub.approveUrl }, 201);
  });

  return app;
}
