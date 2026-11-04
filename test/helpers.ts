import { env } from "cloudflare:test";
import { createApp } from "../src/app";
import type { Deps, Env } from "../src/env";
import { PAYPAL_BASE } from "../src/paypal";

export const NOW = new Date("2026-11-04T12:00:00.000Z");

type Handler = (req: Request, body: string) => Response | Promise<Response>;

/** In-memory HTTP router standing in for fetch. Records every call. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: { key: string; body: string; headers: Headers }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const key = `${req.method} ${url.host}${url.pathname}`;
    const body = await req.text();
    calls.push({ key, body, headers: req.headers });
    const handler = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith("*") && key.startsWith(k.slice(0, -1)))?.[1];
    if (!handler) return new Response(`no fake for ${key}`, { status: 599 });
    return handler(req, body);
  }) as typeof fetch;
  return { fetchImpl, calls, count: (prefix: string) => calls.filter((c) => c.key.startsWith(prefix)).length };
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export const PP = {
  token: `POST api-m.sandbox.paypal.com/v1/oauth2/token`,
  orders: `POST api-m.sandbox.paypal.com/v2/checkout/orders`,
  capture: (id: string) => `POST api-m.sandbox.paypal.com/v2/checkout/orders/${id}/capture`,
  captureAny: `POST api-m.sandbox.paypal.com/v2/checkout/orders/*`,
  verify: `POST api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature`,
  claude: `POST api.anthropic.com/v1/messages`,
};

const ordersByRequestId = new Map<string, string>();

export function paypalFakes(
  opts: { verify?: unknown; captureValue?: string; captureStatus?: string; captureCurrency?: string } = {},
): Record<string, Handler> {
  return {
    [PP.token]: () => json({ access_token: "tok", expires_in: 3600 }),
    // Like PayPal: the same PayPal-Request-Id yields the same order (and keeps the first custom_id).
    [PP.orders]: (r, body) => {
      const rid = r.headers.get("PayPal-Request-Id") ?? crypto.randomUUID();
      const id = `ORDER-${rid}`;
      const seen = ordersByRequestId.get(rid);
      const customId = seen ?? String(JSON.parse(body).purchase_units[0].custom_id);
      ordersByRequestId.set(rid, customId);
      return json({ id, status: "CREATED", links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}&cid=${customId}` }] });
    },
    [PP.captureAny]: () =>
      json({
        id: "ORDER-1",
        status: "COMPLETED",
        purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: opts.captureStatus ?? "COMPLETED", amount: { currency_code: opts.captureCurrency ?? "MXN", value: opts.captureValue ?? "200.00" } }] } }],
      }),
    [PP.verify]: () => json(opts.verify === undefined ? { verification_status: "SUCCESS" } : opts.verify),
  };
}

export function makeApp(routes: Record<string, Handler>, now: Date = NOW) {
  const ff = fakeFetch(routes);
  const deps: Deps = { fetch: ff.fetchImpl, now: () => now };
  return { app: createApp(deps), ...ff };
}

export function withEnv(overrides: Partial<Env>): Env {
  return { ...env, ...overrides } as Env;
}

export function webhookHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "TX-1",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-11-04T12:00:00Z",
  };
}

export function approvedEvent(id: string, orderId: string, customId: string) {
  return {
    id,
    event_type: "CHECKOUT.ORDER.APPROVED",
    resource: { id: orderId, purchase_units: [{ custom_id: customId }], payer: { email_address: "buyer@example.com", name: { given_name: "Laura" } } },
  };
}

export function captureCompletedEvent(id: string, captureId: string, customId: string, value: string, currency = "MXN", orderId?: string) {
  return {
    id,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: captureId,
      custom_id: customId,
      amount: { currency_code: currency, value },
      ...(orderId ? { supplementary_data: { related_ids: { order_id: orderId } } } : {}),
    },
  };
}

/** Catalog + slot + contact/conversation/pet/appointment ready for a deposit. */
export async function seedBooking(depositCents = 20000) {
  const conv = crypto.randomUUID();
  const slot = crypto.randomUUID();
  const pet = crypto.randomUUID();
  const appt = crypto.randomUUID();
  // The pool shares one D1 per test file, so catalog rows are upserted by sku.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO catalog_items (id, sku, name, category, price_cents) VALUES (?1, 'ANTICIPO-CONSULTA', 'Anticipo', 'anticipo', ?2) ON CONFLICT(sku) DO UPDATE SET price_cents = excluded.price_cents, active = 1",
    ).bind(crypto.randomUUID(), depositCents),
    env.DB.prepare(
      "INSERT INTO catalog_items (id, sku, name, category, price_cents) VALUES (?1, 'CONSULTA-GENERAL', 'Consulta general', 'consulta', 45000) ON CONFLICT(sku) DO UPDATE SET price_cents = excluded.price_cents, active = 1",
    ).bind(crypto.randomUUID()),
    env.DB.prepare("INSERT INTO contacts (id) VALUES (?1)").bind(conv),
    env.DB.prepare("INSERT INTO conversations (id, contact_id) VALUES (?1, ?1)").bind(conv),
    env.DB.prepare("INSERT INTO slots (id, starts_at, taken) VALUES (?1, '2026-11-10T10:00:00.000Z', 1)").bind(slot),
    env.DB.prepare("INSERT INTO pets (id, contact_id, name, species) VALUES (?1, ?2, 'Firulais', 'perro')").bind(pet, conv),
    env.DB.prepare("INSERT INTO appointments (id, slot_id, contact_id, pet_id, conversation_id) VALUES (?1, ?2, ?3, ?4, ?3)").bind(appt, slot, conv, pet),
  ]);
  return { conv, slot, pet, appt };
}

export async function count(table: string, where = "1=1", ...binds: unknown[]): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...binds).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Captures console.log output for PII assertions. */
export function captureLogs() {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  return { lines, restore: () => (console.log = orig) };
}

export function assertNoPii(lines: string[]): void {
  for (const l of lines) {
    if (/@/.test(l) || /\d{10,}/.test(l) || /payer/i.test(l)) throw new Error(`PII-looking log line: ${l}`);
  }
}

export { PAYPAL_BASE };
