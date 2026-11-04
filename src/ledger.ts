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

/** Claims the header row. Returns true when THIS call inserted it (0 changes = someone else did). */
export async function claimCharge(db: D1Database, c: NewCharge, createdRaw: unknown): Promise<boolean> {
  const [ins] = await db.batch([
    db
      .prepare(
        `INSERT INTO charges (id, kind, appointment_id, consult_id, conversation_id, paypal_order_id, paypal_request_id, amount_cents, currency, approve_url)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT DO NOTHING`,
      )
      .bind(c.id, c.kind, c.appointmentId ?? null, c.consultId ?? null, c.conversationId ?? null, c.paypalOrderId, c.paypalRequestId, c.amountCents, c.currency, c.approveUrl),
    // Only lands if the header above was inserted by this batch (changes() = 1).
    db
      .prepare(
        `INSERT INTO charge_events (charge_id, status, amount_cents, currency, raw)
         SELECT ?1, 'created', ?2, ?3, ?4 WHERE changes() = 1`,
      )
      .bind(c.id, c.amountCents, c.currency, JSON.stringify(createdRaw)),
  ]);
  return (ins?.meta.changes ?? 0) === 1;
}

export function currentCharge(db: D1Database, where: "id" | "paypal_order_id" | "appointment_id" | "consult_id", value: string) {
  return db
    .prepare(`SELECT ${CHARGE_COLUMNS} FROM charges_current WHERE ${where} = ?1 LIMIT 1`)
    .bind(value)
    .first<ChargeRow>();
}

/** Webhook payloads carry payer data; keep the evidence, drop the person. */
export function redactWebhook(event: Record<string, unknown>): Record<string, unknown> {
  const resource = (event.resource ?? {}) as Record<string, unknown>;
  const { payer: _p, payment_source: _s, payee: _e, ...rest } = resource;
  return { ...event, resource: rest };
}
