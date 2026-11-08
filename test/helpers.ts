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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Heuristics for PII: an email, a phone-length digit run, or PayPal's payer object.
 * Ids are UUIDs and about 1.6% of random UUIDs contain 10+ consecutive digits, so
 * they are removed before the phone heuristic (that was the intermittent failure).
 */
export function assertNoPii(lines: string[]): void {
  for (const l of lines) {
    const noIds = l.replace(UUID, "");
    if (/@/.test(noIds) || /\d{10,}/.test(noIds) || /payer/i.test(noIds)) throw new Error(`PII-looking log line: ${l}`);
  }
}

/** Doctor Basic header for the test credential (vitest.config.ts). */
export const DOCTOR_AUTH = { Authorization: `Basic ${btoa("doctor:test-doctor-pass")}` };

/** A booking whose deposit was captured (appointment confirmed), owner consent optional. */
export async function seedConfirmed(opts: { ownerConsent?: boolean } = {}) {
  const b = await seedBooking();
  await env.DB.batch([
    env.DB.prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ?1").bind(b.appt),
    env.DB.prepare("UPDATE contacts SET name = 'Laura Demo', email = 'laura@example.com' WHERE id = ?1").bind(b.conv),
    ...(opts.ownerConsent === false
      ? []
      : [env.DB.prepare("UPDATE conversations SET owner_consent_at = '2026-11-04T11:00:00.000Z', owner_consent_version = 'v1-2026-11-04' WHERE id = ?1").bind(b.conv)]),
  ]);
  return b;
}

export { PAYPAL_BASE };

// ===== delivery (Constructora C) =====
export const DOCTOR = { DOCTOR_DEMO_USER: "val", DOCTOR_DEMO_PASSWORD: "demo-pass-1234" };
export const doctorHeaders = (extra: Record<string, string> = {}) => ({ Authorization: `Basic ${btoa("val:demo-pass-1234")}`, ...extra });
export const doctorEnv = (overrides: Partial<Env> = {}) => withEnv({ ...DOCTOR, ...overrides });

/** Booking + consult (0002) + a priced catalog. Returns ids and the catalog ids by sku. */
// One doctor-spoken transcript segment (idx 1) that literally carries every phrase and number the
// default AI leaves of approvedBody quote, so /approve's server-side re-anchor (audit M2) grounds the
// happy path. It names no owner words, so redactOwner leaves it unchanged.
export const SEG1 = "Vómito desde ayer, temperatura 39.5, amoxicilina 250 mg cada 12 h durante 7 días, 1 o 2 cajas.";

export async function seedConsult(opts: { depositCents?: number; prices?: Record<string, number> } = {}) {
  const booking = await seedBooking(opts.depositCents ?? 20000);
  const consult = crypto.randomUUID();
  const prices = { "VAC-RABIA": 38050, "MED-AMOXI": 12525, ...opts.prices };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO consults (id, appointment_id, status) VALUES (?1, ?2, 'drafted')").bind(consult, booking.appt),
    env.DB.prepare("INSERT INTO transcript_segments (consult_id, idx, start_ms, end_ms, speaker, text) VALUES (?1, 1, 0, 1000, 'doctor', ?2)").bind(consult, SEG1),
    ...Object.entries(prices).map(([sku, cents]) =>
      env.DB.prepare(
        "INSERT INTO catalog_items (id, sku, name, category, price_cents) VALUES (?1, ?2, ?2, 'otro', ?3) ON CONFLICT(sku) DO UPDATE SET price_cents = excluded.price_cents, active = 1",
      ).bind(crypto.randomUUID(), sku, cents),
    ),
  ]);
  const { results } = await env.DB.prepare("SELECT id, sku FROM catalog_items").all<{ id: string; sku: string }>();
  const ids = Object.fromEntries(results.map((r) => [r.sku, r.id]));
  return { ...booking, consult, ids };
}

export const ai = (value: unknown) => ({ value, source: "ai", segment_ids: [1], quote: SEG1 });
export const doc = (value: unknown) => ({ value, source: "doctor" });

/** V9 fixture: consulta 450.00 + vacuna 380.50 + 2 × 125.25 = 1081.00 */
export function approvedBody(ids: Record<string, string>, extra: Record<string, unknown> = {}): Record<string, unknown> & { prescription: Record<string, unknown>[] } {
  return {
    subjective: { motivo_consulta: ai("vómito desde ayer"), apetito: doc("disminuido") },
    vitals: { temperatura: ai(39.5), peso: doc(12.4) },
    physical_exam: {},
    assessment: { diagnostico: doc("gastroenteritis leve"), pronostico: doc("favorable") },
    plan: { instrucciones_cliente: doc("dieta blanda 3 días"), urgent_instructions: [doc("si vomita sangre, acuda de inmediato")] },
    prescription: [
      { medicamento: ai("amoxicilina"), dosis: ai("250 mg"), frecuencia: ai("cada 12 h"), duracion: ai("7 días"), via_administracion: doc("oral"), catalog_item_id: ids["MED-AMOXI"] },
    ],
    vaccines: [{ vacuna: doc("rabia"), catalog_item_id: ids["VAC-RABIA"] }],
    billable: [{ catalog_item_id: ids["MED-AMOXI"], quantity: ai(1) }],
    ...extra,
  };
}

/** A deposit charge in the ledger; by default captured in MXN. `status`/`currency` model an unpaid or foreign deposit (M1). */
export async function depositCaptured(appt: string, amountCents = 20000, opts: { status?: string; currency?: string } = {}) {
  const chargeId = crypto.randomUUID();
  const status = opts.status ?? "captured";
  const currency = opts.currency ?? "MXN";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO charges (id, kind, appointment_id, paypal_order_id, paypal_request_id, amount_cents, currency, approve_url) VALUES (?1, 'deposit', ?2, ?3, ?4, ?5, ?6, 'https://www.sandbox.paypal.com/x')",
    ).bind(chargeId, appt, `ORDER-${chargeId}`, `deposit-${appt}`, amountCents, currency),
    env.DB.prepare("INSERT INTO charge_events (charge_id, status, paypal_capture_id, amount_cents, currency, raw) VALUES (?1, ?4, ?2, ?3, ?5, '{}')").bind(
      chargeId,
      status === "captured" ? `CAP-${chargeId}` : null,
      amountCents,
      status,
      currency,
    ),
  ]);
  return chargeId;
}

/** Smallest valid JPEG-looking file: SOI, APP1 "Exif", SOF0 2x2 3 components, SOS, EOI. */
export function fakeJpeg(withExif = true): Uint8Array {
  const app1 = withExif ? [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00] : [];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34];
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof0, ...sos, 0xff, 0xd9]);
}

export function multipart(file: Uint8Array, filename: string, caption = "") {
  const fd = new FormData();
  fd.append("file", new Blob([file.buffer as ArrayBuffer], { type: "application/octet-stream" }), filename);
  if (caption) fd.append("caption", caption);
  return fd;
}

/** Unique PayPal order id per call (paypal_order_id is UNIQUE in the ledger). */
export const uniqueOrderFake = {
  [PP.orders]: (_r: Request, body: string) => {
    const id = `ORDER-${crypto.randomUUID()}`;
    return json({ id, status: "CREATED", links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}&cid=${JSON.parse(body).purchase_units[0].custom_id}` }] });
  },
};

/** The clinic's subscription in a given state (default active), seeded like a verified webhook would leave it. */
export async function seedSubscription(state: "approval_pending" | "active" | "suspended" | "cancelled" | "expired" = "active", opts: { paypalId?: string } = {}) {
  const id = crypto.randomUUID();
  const paypalId = opts.paypalId ?? `I-${id.slice(0, 13).toUpperCase()}`;
  await env.DB.batch([
    // One clinic, one subscription: seeding a non-active state means no other row is active either.
    ...(state === "active" ? [] : [env.DB.prepare("INSERT INTO subscription_events (subscription_id, kind, state, raw) SELECT id, 'cancelled', 'cancelled', '{}' FROM subscription_current WHERE state = 'active'")]),
    env.DB.prepare("INSERT INTO subscriptions (id, paypal_subscription_id, plan_id, amount_cents, currency, approve_url) VALUES (?1, ?2, ?3, 99900, 'MXN', 'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-TEST')").bind(id, paypalId, env.PAYPAL_PLAN_ID ?? "P-TEST"),
    env.DB.prepare("INSERT INTO subscription_events (subscription_id, kind, state, raw) VALUES (?1, 'created', 'approval_pending', '{}')").bind(id),
    ...(state === "approval_pending" ? [] : [env.DB.prepare("INSERT INTO subscription_events (subscription_id, kind, state, raw) VALUES (?1, ?2, ?3, '{}')").bind(id, state === "active" ? "activated" : state, state)]),
  ]);
  return { id, paypalId };
}

export function claudeToolFake(texts: string[]) {
  let n = 0;
  return {
    [PP.claude]: () => {
      const text = texts[Math.min(n, texts.length - 1)];
      n += 1;
      return json({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "plain_explanation", input: { text } }] });
    },
  };
}

// Minimal DOM stub for the served sim.js (same approach as ticket.test.ts): records the tree, throws on innerHTML.
export type N = { tag: string; children: N[]; textContent: string; value: string; disabled: boolean; listeners: Record<string, (e: unknown) => unknown>; [k: string]: unknown };
export const txt = (n: N) => n.children.map((c) => c.textContent).join("");
export function domStub() {
  const mk = (tag: string): N => {
    const n: N = {
      tag,
      children: [],
      textContent: "",
      value: "",
      disabled: false,
      listeners: {},
      appendChild(c: N) {
        n.children.push(c);
        return c;
      },
      replaceChildren() {
        n.children = [];
      },
      addEventListener(ev: string, fn: (e: unknown) => unknown) {
        n.listeners[ev] = fn;
      },
      focus() {},
    };
    Object.defineProperty(n, "innerHTML", {
      set() {
        throw new Error("innerHTML assigned");
      },
    });
    return n;
  };
  const byId: Record<string, N> = {};
  const document = {
    getElementById: (id: string) => (byId[id] ??= mk(id)),
    createElement: mk,
    createTextNode: (t: string) => ({ tag: "#text", children: [], textContent: t }),
    addEventListener() {},
    visibilityState: "visible",
  };
  return { document, byId };
}
