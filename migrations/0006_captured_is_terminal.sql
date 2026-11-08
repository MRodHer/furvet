-- 0006 — money audit M1: a captured charge stays captured. DDL only; forward-only.
-- charges_current used to take the LAST charge_events row, so a PAYMENT.CAPTURE.DENIED (or any later
-- event) stacked after `captured` "un-paid" the charge: /r answered 402 to a paid balance and the deposit
-- stopped being discounted. The view now prefers the captured row; charge_events_one_captured (0004)
-- guarantees there is at most one. Same columns, same consumers (ledger.ts, charges.ts, sim.ts).
DROP VIEW charges_current;
CREATE VIEW charges_current AS
SELECT c.id, c.kind, c.appointment_id, c.consult_id, c.conversation_id,
       c.paypal_order_id, c.amount_cents, c.currency, c.approve_url, c.created_at,
       e.status, e.paypal_capture_id, e.created_at AS last_event_at
FROM charges c
LEFT JOIN charge_events e
  ON e.id = (SELECT id FROM charge_events WHERE charge_id = c.id ORDER BY (status = 'captured') DESC, id DESC LIMIT 1);
