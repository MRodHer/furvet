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

export function paypalFakes(opts: { verify?: "SUCCESS" | "FAILURE"; captureValue?: string; captureStatus?: string } = {}): Record<string, Handler> {
  return {
    [PP.token]: () => json({ access_token: "tok", expires_in: 3600 }),
    [PP.orders]: (_r, body) => {
      const b = JSON.parse(body);
      return json({ id: "ORDER-1", status: "CREATED", links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1&cid=${b.purchase_units[0].custom_id}` }] });
    },
    [PP.captureAny]: () =>
      json({
        id: "ORDER-1",
        status: "COMPLETED",
        purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: opts.captureStatus ?? "COMPLETED", amount: { currency_code: "MXN", value: opts.captureValue ?? "200.00" } }] } }],
      }),
    [PP.verify]: () => json({ verification_status: opts.verify ?? "SUCCESS" }),
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

export function captureCompletedEvent(id: string, captureId: string, customId: string, value: string) {
  return { id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: captureId, custom_id: customId, amount: { currency_code: "MXN", value } } };
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
export async function seedConsult(opts: { depositCents?: number; prices?: Record<string, number> } = {}) {
  const booking = await seedBooking(opts.depositCents ?? 20000);
  const consult = crypto.randomUUID();
  const prices = { "VAC-RABIA": 38050, "MED-AMOXI": 12525, ...opts.prices };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO consults (id, appointment_id, status) VALUES (?1, ?2, 'drafted')").bind(consult, booking.appt),
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

const ai = (value: unknown) => ({ value, source: "ai", segment_ids: [1], quote: "dicho en consulta" });
const doc = (value: unknown) => ({ value, source: "doctor" });

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

export async function depositCaptured(appt: string, amountCents = 20000) {
  const chargeId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO charges (id, kind, appointment_id, paypal_order_id, paypal_request_id, amount_cents, currency, approve_url) VALUES (?1, 'deposit', ?2, ?3, ?4, ?5, 'MXN', 'https://www.sandbox.paypal.com/x')",
    ).bind(chargeId, appt, `ORDER-${chargeId}`, `deposit-${appt}`, amountCents),
    env.DB.prepare("INSERT INTO charge_events (charge_id, status, paypal_capture_id, amount_cents, currency, raw) VALUES (?1, 'captured', ?2, ?3, 'MXN', '{}')").bind(chargeId, `CAP-${chargeId}`, amountCents),
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
