// Read-only board API. No payer data exists in these rows; raw payloads never leave the DB.
import { Hono } from "hono";
import type { Env } from "../env";
import { CHARGE_COLUMNS, type ChargeRow } from "../ledger";
import { centsToValue } from "../money";

interface EventRow {
  id: number;
  status: string;
  paypal_capture_id: string | null;
  amount_cents: number | null;
  currency: string | null;
  created_at: string;
}

export function chargesRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "100") || 100, 1), 200);
    const { results } = await c.env.DB.prepare(
      `SELECT ${CHARGE_COLUMNS} FROM charges_current ORDER BY created_at DESC LIMIT ?1`,
    )
      .bind(limit)
      .all<ChargeRow>();
    return c.json(
      results.map((r) => ({
        id: r.id,
        kind: r.kind,
        created_at: r.created_at,
        amount: centsToValue(r.amount_cents),
        currency: r.currency,
        status: r.status ?? "created",
        paypal_order_id: r.paypal_order_id,
        appointment_id: r.appointment_id,
        consult_id: r.consult_id,
        approve_url: r.approve_url,
        last_event_at: r.last_event_at,
      })),
    );
  });

  app.get("/:id/events", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, status, paypal_capture_id, amount_cents, currency, created_at
       FROM charge_events WHERE charge_id = ?1 ORDER BY id ASC`,
    )
      .bind(c.req.param("id"))
      .all<EventRow>();
    return c.json(
      results.map((e) => ({
        id: e.id,
        status: e.status,
        paypal_capture_id: e.paypal_capture_id,
        amount: e.amount_cents === null ? null : centsToValue(e.amount_cents),
        currency: e.currency,
        created_at: e.created_at,
      })),
    );
  });

  return app;
}
