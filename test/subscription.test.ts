// Clinic subscription (PayPal Subscriptions, sandbox) + AI gate — contract feat-clinic-subscription S1–S17.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { assertNoPii, captureLogs, count, DOCTOR_AUTH, json, makeApp, paypalFakes, PP, seedSubscription, webhookHeaders, withEnv } from "./helpers";

const WEBHOOK = "/api/v1/paypal/webhook";
const PLAN = env.PAYPAL_PLAN_ID!;
const SUBS = "POST api-m.sandbox.paypal.com/v1/billing/subscriptions";
const APPROVE = "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-TEST1";
const UNKNOWN_CONSULT = "/api/v1/consults/00000000-0000-4000-8000-000000000000/fill";

const subsFake = (href = APPROVE) => ({
  [SUBS]: (r: Request, body: string) => json({ id: `I-${(r.headers.get("PayPal-Request-Id") ?? "x").slice(0, 8)}`, status: "APPROVAL_PENDING", plan_id: JSON.parse(body).plan_id, links: [{ rel: "approve", href }] }),
});
const activated = (id: string, subId: string, value = "999.00", currency = "MXN", planId = PLAN, extra: Record<string, unknown> = {}) => ({
  id, event_type: "BILLING.SUBSCRIPTION.ACTIVATED", create_time: "2026-11-04T12:00:00Z",
  resource: { id: subId, status: "ACTIVE", plan_id: planId, billing_info: { last_payment: { amount: { currency_code: currency, value }, time: "2026-11-04T12:00:00Z" }, next_billing_time: "2026-12-04T10:00:00Z" }, subscriber: { name: { given_name: "Val" }, email_address: "val@example.com" }, ...extra },
});
const sale = (id: string, subId: string, total = "999.00", currency = "MXN") => ({ id, event_type: "PAYMENT.SALE.COMPLETED", resource: { id: `SALE-${id}`, state: "completed", amount: { total, currency }, billing_agreement_id: subId } });
const stateEvent = (id: string, type: string, subId: string) => ({ id, event_type: `BILLING.SUBSCRIPTION.${type}`, resource: { id: subId, status: type, plan_id: PLAN } });

const post = (app: ReturnType<typeof makeApp>["app"], path: string, body: unknown, e: Env = env, headers: Record<string, string> = webhookHeaders()) =>
  app.request(path, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }, e);
const start = (app: ReturnType<typeof makeApp>["app"], body?: unknown, e: Env = env, headers: Record<string, string> = DOCTOR_AUTH) =>
  post(app, "/api/v1/subscription/start", body, e, { "Content-Type": "application/json", ...headers });
const status = async (app: ReturnType<typeof makeApp>["app"]) => (await (await app.request("/api/v1/subscription", { headers: DOCTOR_AUTH }, env)).json()) as { status: string; next_billing_at: string | null; price_cents: number; currency: string; required: boolean };
const stateOf = async (id: string) => (await env.DB.prepare("SELECT state FROM subscription_current WHERE id = ?1").bind(id).first<{ state: string | null }>())?.state;
const events = (id: string, where = "1=1") => count("subscription_events", `subscription_id = ?1 AND ${where}`, id);
const fill = (app: ReturnType<typeof makeApp>["app"], e: Env = env, headers: Record<string, string> = DOCTOR_AUTH) => app.request(UNKNOWN_CONSULT, { method: "POST", headers }, e);

describe("clinic subscription — rows and routes (S1–S6)", () => {
  it("S1: UPDATE / DELETE on subscriptions and subscription_events abort (append-only triggers)", async () => {
    const { id } = await seedSubscription();
    await expect(env.DB.prepare("UPDATE subscriptions SET amount_cents = 1 WHERE id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM subscriptions WHERE id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("UPDATE subscription_events SET state = 'active' WHERE subscription_id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM subscription_events WHERE subscription_id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
  });

  it("S2: /start without PAYPAL_PLAN_ID, without PayPal secrets or without PUBLIC_BASE_URL → 503 before calling PayPal; no header → 401; empty doctor credential → 503", async () => {
    await seedSubscription("cancelled"); // nothing pending or active: a configured /start WOULD create
    for (const e of [withEnv({ PAYPAL_PLAN_ID: "" }), withEnv({ PAYPAL_CLIENT_SECRET: undefined }), withEnv({ PUBLIC_BASE_URL: undefined })]) {
      const fresh = makeApp({ ...paypalFakes(), ...subsFake() }); // the PayPal client is built once per app, from the first env it sees
      expect((await start(fresh.app, undefined, e)).status).toBe(503);
      expect(fresh.count(SUBS)).toBe(0);
    }
    const { app, count: calls } = makeApp({ ...paypalFakes(), ...subsFake() });
    expect((await start(app, undefined, env, {})).status).toBe(401);
    expect((await start(app, undefined, withEnv({ DOCTOR_DEMO_PASSWORD: "" }))).status).toBe(503);
    expect(calls(SUBS)).toBe(0);
  });

  it("S3: /start creates the subscription with the configured plan (never the body's), stores header + created/approval_pending, answers only {approve_url}; a body with plan_id or amount → 400 and no call", async () => {
    await seedSubscription("cancelled"); // the latest row is closed: /start has to create
    const { app, calls, count: cnt } = makeApp({ ...paypalFakes(), ...subsFake() }, new Date());
    const before = await count("subscriptions");
    expect((await start(app, { plan_id: "P-EVIL" })).status).toBe(400);
    expect((await start(app, { amount: "1.00" })).status).toBe(400);
    expect((await post(app, "/api/v1/subscription/start", "{\"plan_id\":", env, { "Content-Type": "application/json", ...DOCTOR_AUTH })).status).toBe(400); // malformed JSON is not an empty body
    expect(cnt(SUBS)).toBe(0);
    const res = await start(app);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ approve_url: APPROVE });
    const sent = JSON.parse(calls.find((c) => c.key === SUBS)!.body);
    expect(sent.plan_id).toBe(PLAN);
    expect(sent).not.toHaveProperty("amount");
    expect(await count("subscriptions")).toBe(before + 1);
    const row = await env.DB.prepare("SELECT state, amount_cents, currency, plan_id FROM subscription_current ORDER BY seq DESC LIMIT 1").first<Record<string, unknown>>();
    expect(row).toEqual({ state: "approval_pending", amount_cents: 99900, currency: "MXN", plan_id: PLAN });
    expect((await status(app)).status).toBe("approval_pending");
  });

  it("S4: a fresh approval_pending → same approve_url, no second row, no PayPal call; active → 409", async () => {
    const { app, count: cnt } = makeApp({ ...paypalFakes(), ...subsFake("https://www.sandbox.paypal.com/x?ba_token=NEW") }, new Date());
    const { id } = await seedSubscription("approval_pending");
    const res = await start(app);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approve_url: string }).approve_url).toContain("ba_token=BA-TEST");
    expect(cnt(SUBS)).toBe(0);
    expect(await count("subscriptions", "rowid > (SELECT rowid FROM subscriptions WHERE id = ?1)", id)).toBe(0);
    await seedSubscription("active");
    expect((await start(app)).status).toBe(409);
    expect(cnt(SUBS)).toBe(0);
  });

  it("S4b: an approval_pending older than PENDING_TTL_MS is superseded: /start issues a new subscription and the status follows the new row", async () => {
    const { id: old } = await seedSubscription("approval_pending");
    const { app, count: cnt } = makeApp({ ...paypalFakes(), ...subsFake("https://www.sandbox.paypal.com/x?ba_token=NEW") }, new Date(Date.now() + 31 * 60_000));
    const res = await start(app);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { approve_url: string }).approve_url).toContain("ba_token=NEW");
    expect(cnt(SUBS)).toBe(1);
    const latest = await env.DB.prepare("SELECT id FROM subscription_current ORDER BY seq DESC LIMIT 1").first<{ id: string }>();
    expect(latest!.id).not.toBe(old);
  });

  it("S5: approve link not on https://www.sandbox.paypal.com (look-alike host, http, other host) → 502 and no row", async () => {
    for (const href of ["https://www.sandbox.paypal.com.evil.com/x", "http://www.sandbox.paypal.com/x", "https://www.paypal.example/x"]) {
      const { app } = makeApp({ ...paypalFakes(), ...subsFake(href) }, new Date());
      await seedSubscription("cancelled"); // so /start has to create
      const before = await count("subscriptions");
      expect((await start(app)).status, href).toBe(502);
      expect(await count("subscriptions")).toBe(before);
    }
  });

  it("S6: GET /subscription → none / state of the latest row, server price, next billing when known, required switch; no-store", async () => {
    const { app } = makeApp({});
    // 'none': the rows are append-only, so an empty subscription_current is simulated by a DB whose read returns nothing.
    const emptyDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes("subscription_current")) return stmt;
          return new Proxy(stmt, { get: (s, p, r) => (p === "first" ? async () => null : p === "bind" ? (...a: unknown[]) => s.bind(...a) : Reflect.get(s, p, r)) });
        };
      },
    });
    const fresh = await app.request("/api/v1/subscription", { headers: DOCTOR_AUTH }, withEnv({ DB: emptyDb }));
    expect(fresh.headers.get("Cache-Control")).toBe("no-store");
    expect(await fresh.json()).toEqual({ status: "none", next_billing_at: null, price_cents: 99900, currency: "MXN", required: true });
    const { id, paypalId } = await seedSubscription("approval_pending");
    expect((await status(app)).status).toBe("approval_pending");
    await env.DB.prepare("INSERT INTO subscription_events (subscription_id, kind, state, next_billing_at, raw) VALUES (?1, 'activated', 'active', '2026-12-04T10:00:00Z', '{}')").bind(id).run();
    expect(await status(app)).toMatchObject({ status: "active", next_billing_at: "2026-12-04T10:00:00Z" });
    expect(paypalId).toMatch(/^I-/);
    const off = (await (await app.request("/api/v1/subscription", { headers: DOCTOR_AUTH }, withEnv({ SUBSCRIPTION_REQUIRED: "false" }))).json()) as { required: boolean };
    expect(off.required).toBe(false);
  });
});

describe("clinic subscription — webhook (S7–S13, S17)", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  it("S7: verified ACTIVATED for OUR subscription, our plan, 999.00 MXN → active, one event, next billing stored; raw without subscriber; logs without PII", async () => {
    const { id, paypalId } = await seedSubscription("approval_pending");
    const logs = captureLogs();
    restore = logs.restore;
    const { app } = makeApp(paypalFakes());
    const res = await post(app, WEBHOOK, activated("WH-S7", paypalId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "activated" });
    expect(await stateOf(id)).toBe("active");
    expect(await events(id, "paypal_event_id = 'WH-S7' AND kind = 'activated' AND amount_cents = 99900 AND currency = 'MXN' AND next_billing_at = '2026-12-04T10:00:00Z'")).toBe(1);
    const raw = (await env.DB.prepare("SELECT raw FROM subscription_events WHERE paypal_event_id = 'WH-S7'").first<{ raw: string }>())!.raw;
    expect(raw).not.toContain("subscriber");
    expect(raw).not.toContain("val@example.com");
    assertNoPii(logs.lines);
    expect(logs.lines.join("\n")).not.toContain("ba_token");
  });

  it("S8: ACTIVATED with 998.00 MXN, with USD, or with another plan id → amount_mismatch / ignored, still approval_pending, /fill 402", async () => {
    const { id, paypalId } = await seedSubscription("approval_pending");
    const { app, count: calls } = makeApp(paypalFakes());
    expect(await (await post(app, WEBHOOK, activated("WH-S8a", paypalId, "998.00"))).json()).toEqual({ status: "amount_mismatch" });
    expect(await (await post(app, WEBHOOK, activated("WH-S8b", paypalId, "999.00", "USD"))).json()).toEqual({ status: "amount_mismatch" });
    expect(await (await post(app, WEBHOOK, activated("WH-S8c", paypalId, "999.00", "MXN", "P-OTHERPLAN"))).json()).toEqual({ status: "ignored" });
    expect(await events(id, "kind = 'amount_mismatch'")).toBe(2);
    expect(await stateOf(id)).toBe("approval_pending");
    expect((await fill(app)).status).toBe(402);
    expect(calls(PP.claude)).toBe(0);
  });

  it("S8b: ACTIVATED without last_payment or without plan_id never activates (fail-closed)", async () => {
    const { id, paypalId } = await seedSubscription("approval_pending");
    const { app } = makeApp(paypalFakes());
    const noPay = activated("WH-S8d", paypalId);
    delete (noPay.resource.billing_info as { last_payment?: unknown }).last_payment;
    expect(await (await post(app, WEBHOOK, noPay)).json()).toEqual({ status: "amount_mismatch" });
    const noPlan = activated("WH-S8e", paypalId);
    delete (noPlan.resource as { plan_id?: unknown }).plan_id;
    expect(await (await post(app, WEBHOOK, noPlan)).json()).toEqual({ status: "ignored" });
    expect(await stateOf(id)).toBe("approval_pending");
  });

  it("S8c: a late ACTIVATED over a cancelled or expired subscription is ignored (stale retry never reopens the gate); a CANCELLED without plan_id still applies", async () => {
    const { app } = makeApp(paypalFakes());
    for (const terminal of ["cancelled", "expired"] as const) {
      const { id, paypalId } = await seedSubscription(terminal);
      expect(await (await post(app, WEBHOOK, activated(`WH-S8c-${terminal}`, paypalId))).json()).toEqual({ status: "ignored" });
      expect(await stateOf(id)).toBe(terminal);
      expect(await events(id, "paypal_event_id IS NOT NULL")).toBe(0);
    }
    const { id, paypalId } = await seedSubscription("active");
    const ev = stateEvent("WH-S8c-cancel", "CANCELLED", paypalId);
    delete (ev.resource as { plan_id?: unknown }).plan_id;
    expect(await (await post(app, WEBHOOK, ev)).json()).toEqual({ status: "cancelled" });
    expect(await stateOf(id)).toBe("cancelled");
  });

  it("S9: ACTIVATED for an unknown subscription id → ignored, zero rows", async () => {
    await seedSubscription("approval_pending");
    const { app } = makeApp(paypalFakes());
    const before = await count("subscription_events");
    expect(await (await post(app, WEBHOOK, activated("WH-S9", "I-NOBODY"))).json()).toEqual({ status: "ignored" });
    expect(await count("subscription_events")).toBe(before);
    expect(await count("subscription_events", "paypal_event_id = 'WH-S9'")).toBe(0);
  });

  it("S10: the same event twice (sequential and concurrent) → one row; the replay answers duplicate", async () => {
    const { id, paypalId } = await seedSubscription("approval_pending");
    const { app } = makeApp(paypalFakes());
    const ev = activated("WH-S10", paypalId);
    expect(await (await post(app, WEBHOOK, ev)).json()).toEqual({ status: "activated" });
    expect(await (await post(app, WEBHOOK, ev)).json()).toEqual({ status: "duplicate" });
    const both = await Promise.all([post(app, WEBHOOK, sale("WH-S10b", paypalId)), post(app, WEBHOOK, sale("WH-S10b", paypalId))]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(await events(id, "paypal_event_id = 'WH-S10'")).toBe(1);
    expect(await events(id, "paypal_event_id = 'WH-S10b'")).toBe(1);
  });

  it("S11: PAYMENT.SALE.COMPLETED for our subscription with 999.00 MXN → payment + active from approval_pending; wrong amount → amount_mismatch, not active; foreign billing_agreement_id → ignored; never resurrects a cancelled one", async () => {
    const { id, paypalId } = await seedSubscription("approval_pending");
    const { app } = makeApp(paypalFakes());
    expect(await (await post(app, WEBHOOK, sale("WH-S11a", paypalId, "1.00"))).json()).toEqual({ status: "amount_mismatch" });
    expect(await stateOf(id)).toBe("approval_pending");
    expect(await (await post(app, WEBHOOK, sale("WH-S11b", "I-FOREIGN"))).json()).toEqual({ status: "ignored" });
    expect(await (await post(app, WEBHOOK, sale("WH-S11c", paypalId, "999.00", "USD"))).json()).toEqual({ status: "amount_mismatch" });
    expect(await (await post(app, WEBHOOK, sale("WH-S11d", paypalId))).json()).toEqual({ status: "payment" });
    expect(await stateOf(id)).toBe("active");
    expect(await events(id, "paypal_event_id = 'WH-S11d' AND state = 'active' AND amount_cents = 99900")).toBe(1);
    // A later monthly payment keeps the state (no second 'active' row).
    expect(await (await post(app, WEBHOOK, sale("WH-S11e", paypalId))).json()).toEqual({ status: "payment" });
    expect(await events(id, "state = 'active'")).toBe(1);
    const c = await seedSubscription("cancelled");
    expect(await (await post(app, WEBHOOK, sale("WH-S11f", c.paypalId))).json()).toEqual({ status: "payment" });
    expect(await stateOf(c.id)).toBe("cancelled");
  });

  it("S12: SUSPENDED / CANCELLED / EXPIRED change the state and close the AI gate; PAYMENT.FAILED is informational", async () => {
    const { app, count: calls } = makeApp(paypalFakes());
    for (const [type, state] of [["SUSPENDED", "suspended"], ["CANCELLED", "cancelled"], ["EXPIRED", "expired"]] as const) {
      const { id, paypalId } = await seedSubscription("active");
      expect((await fill(app)).status).toBe(404); // gate open: the unknown consult is what fails
      expect(await (await post(app, WEBHOOK, stateEvent(`WH-S12-${type}`, type, paypalId))).json()).toEqual({ status: state });
      expect(await stateOf(id)).toBe(state);
      expect((await fill(app)).status).toBe(402);
    }
    const { id, paypalId } = await seedSubscription("active");
    expect(await (await post(app, WEBHOOK, stateEvent("WH-S12-PF", "PAYMENT.FAILED", paypalId))).json()).toEqual({ status: "payment_failed" });
    expect(await stateOf(id)).toBe("active");
    expect(await events(id, "kind = 'payment_failed' AND state IS NULL")).toBe(1);
    expect(calls(PP.claude)).toBe(0);
  });

  it("S13: invalid signature or missing headers on a subscription event → 400, zero rows", async () => {
    const { id, paypalId } = await seedSubscription("approval_pending");
    const bad = makeApp(paypalFakes({ verify: { verification_status: "FAILURE" } }));
    expect((await post(bad.app, WEBHOOK, activated("WH-S13a", paypalId))).status).toBe(400);
    const ok = makeApp(paypalFakes());
    expect((await post(ok.app, WEBHOOK, activated("WH-S13b", paypalId), env, { "Content-Type": "application/json" })).status).toBe(400);
    expect(await events(id, "paypal_event_id IS NOT NULL")).toBe(0);
    expect(await stateOf(id)).toBe("approval_pending");
  });
});

describe("AI gate on /fill (S14–S16)", () => {
  it("S14: order is 401 auth → 503 model config → 402 subscription → 400 id; without an active subscription Claude is never called", async () => {
    await seedSubscription("cancelled");
    const { app, count: calls } = makeApp(paypalFakes());
    expect((await fill(app, withEnv({ ANTHROPIC_API_KEY: undefined }), {})).status).toBe(401);
    expect((await fill(app, withEnv({ ANTHROPIC_API_KEY: undefined }))).status).toBe(503);
    const res = await fill(app);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "subscription_required" });
    expect((await app.request("/api/v1/consults/not-a-uuid/fill", { method: "POST", headers: DOCTOR_AUTH }, env)).status).toBe(402);
    await seedSubscription("active");
    expect((await app.request("/api/v1/consults/not-a-uuid/fill", { method: "POST", headers: DOCTOR_AUTH }, env)).status).toBe(400);
    expect(calls(PP.claude)).toBe(0);
  });

  it("S15: the subscription store failing → 503, never a pass, Claude not called", async () => {
    await seedSubscription("active");
    const { app, count: calls } = makeApp(paypalFakes());
    const db = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (sql.includes("subscription_current")) throw new Error("D1 down");
          return target.prepare(sql);
        };
      },
    });
    const res = await fill(app, withEnv({ DB: db }));
    expect(res.status).toBe(503);
    expect(calls(PP.claude)).toBe(0);
  });

  it("S16: SUBSCRIPTION_REQUIRED exactly \"false\" opens the gate; absent, \"0\", \"no\" or \"FALSE\" keep it closed", async () => {
    await seedSubscription("cancelled");
    const { app } = makeApp(paypalFakes());
    expect((await fill(app, withEnv({ SUBSCRIPTION_REQUIRED: "false" }))).status).toBe(404);
    for (const v of [undefined, "", "0", "no", "FALSE", "true"]) expect((await fill(app, withEnv({ SUBSCRIPTION_REQUIRED: v }))).status, String(v)).toBe(402);
  });
});
