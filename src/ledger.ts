// Append-only ledger over D1. Header rows (charges) are claimed atomically with
// INSERT ... ON CONFLICT DO NOTHING; events are appended, never updated.

export type ChargeKind = "deposit" | "balance";
export type ChargeStatus = "created" | "approved" | "captured" | "amount_mismatch" | "capture_failed" | "denied";

export interface ChargeRow {
  id: string;
  kind: ChargeKind;
  appointment_id: string | null;
  consult_id: string | null;
  conversation_id: string | null;
  paypal_order_id: string | null;
  amount_cents: number;
  currency: string;
  approve_url: string | null;
  created_at: string;
  status: ChargeStatus | null;
  paypal_capture_id: string | null;
  last_event_at: string | null;
}

export const CHARGE_COLUMNS =
  "id, kind, appointment_id, consult_id, conversation_id, paypal_order_id, amount_cents, currency, approve_url, created_at, status, paypal_capture_id, last_event_at";

export interface NewCharge {
  id: string;
  kind: ChargeKind;
  appointmentId?: string;
  consultId?: string;
  conversationId?: string;
  paypalOrderId: string;
  paypalRequestId: string;
  amountCents: number;
  currency: string;
  approveUrl: string;
}

/**
 * The two statements of a claim: header INSERT (ON CONFLICT DO NOTHING) + 'created' event that
 * only lands when the header was inserted by the same batch (changes() = 1). `guardSql` lets a
 * caller chain the claim behind another row of its own batch (e.g. the bill of an approval);
 * its placeholders start at ?11.
 */
export function claimChargeStatements(db: D1Database, c: NewCharge, createdRaw: unknown, guardSql = "1 = 1", ...guardBinds: unknown[]) {
  return [
    db
      .prepare(
        `INSERT INTO charges (id, kind, appointment_id, consult_id, conversation_id, paypal_order_id, paypal_request_id, amount_cents, currency, approve_url)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE ${guardSql}
         ON CONFLICT DO NOTHING`,
      )
      .bind(c.id, c.kind, c.appointmentId ?? null, c.consultId ?? null, c.conversationId ?? null, c.paypalOrderId, c.paypalRequestId, c.amountCents, c.currency, c.approveUrl, ...guardBinds),
    db
      .prepare(
        `INSERT INTO charge_events (charge_id, status, amount_cents, currency, raw)
         SELECT ?1, 'created', ?2, ?3, ?4 WHERE changes() = 1`,
      )
      .bind(c.id, c.amountCents, c.currency, JSON.stringify(createdRaw)),
  ];
}

/** Claims the header row. Returns true when THIS call inserted it (0 changes = someone else did). */
export async function claimCharge(db: D1Database, c: NewCharge, createdRaw: unknown): Promise<boolean> {
  const [ins] = await db.batch(claimChargeStatements(db, c, createdRaw));
  return (ins?.meta.changes ?? 0) === 1;
}

export function currentCharge(db: D1Database, where: "id" | "paypal_order_id" | "appointment_id" | "consult_id", value: string) {
  return db
    .prepare(`SELECT ${CHARGE_COLUMNS} FROM charges_current WHERE ${where} = ?1 LIMIT 1`)
    .bind(value)
    .first<ChargeRow>();
}

/** Keys under which PayPal nests a person (buyer or merchant): name, e-mail, phone, address. */
const PII_KEYS = new Set(["payer", "payment_source", "payee", "shipping"]);

/** Webhook payloads carry payer data at several depths; keep the evidence, drop the person (H9). */
export function redactWebhook(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactWebhook);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !PII_KEYS.has(k))
        .map(([k, v]) => [k, redactWebhook(v)]),
    );
  }
  return value;
}
