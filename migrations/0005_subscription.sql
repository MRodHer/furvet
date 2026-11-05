-- 0005 — the clinic's own subscription (PayPal Subscriptions, sandbox). Single clinic: no tenant.
-- Same shape as charges/charge_events: append-only header + events, "current" state is a view.

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  paypal_subscription_id TEXT NOT NULL UNIQUE CHECK (length(paypal_subscription_id) <= 64),
  plan_id TEXT NOT NULL CHECK (length(plan_id) <= 40),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  approve_url TEXT CHECK (approve_url IS NULL OR length(approve_url) <= 2048),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- `state` is the subscription state AFTER the event; NULL for informational events
-- (payment, payment_failed, amount_mismatch) that leave the state as it was.
CREATE TABLE subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  kind TEXT NOT NULL CHECK (kind IN ('created', 'activated', 'payment', 'payment_failed', 'suspended', 'cancelled', 'expired', 'amount_mismatch')),
  state TEXT CHECK (state IS NULL OR state IN ('approval_pending', 'active', 'suspended', 'cancelled', 'expired')),
  paypal_event_id TEXT UNIQUE CHECK (paypal_event_id IS NULL OR length(paypal_event_id) <= 100),
  amount_cents INTEGER,
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  next_billing_at TEXT CHECK (next_billing_at IS NULL OR length(next_billing_at) <= 40),
  raw TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Second barrier for the money rule: a mismatch never carries a state, and only a checked payment activates.
  CHECK (kind <> 'amount_mismatch' OR state IS NULL),
  CHECK (state IS NOT 'active' OR kind IN ('activated', 'payment'))
);
CREATE INDEX idx_subscription_events_subscription_id ON subscription_events (subscription_id, id);

CREATE TRIGGER subscriptions_no_update BEFORE UPDATE ON subscriptions
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER subscriptions_no_delete BEFORE DELETE ON subscriptions
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER subscription_events_no_update BEFORE UPDATE ON subscription_events
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER subscription_events_no_delete BEFORE DELETE ON subscription_events
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

-- Header + last state-changing event + last known next billing time. What the AI gate reads.
-- `seq` (insertion order) picks the latest subscription: a stale approval_pending is superseded by a new row.
CREATE VIEW subscription_current AS
SELECT s.rowid AS seq, s.id, s.paypal_subscription_id, s.plan_id, s.amount_cents, s.currency, s.approve_url, s.created_at,
       (SELECT state FROM subscription_events WHERE subscription_id = s.id AND state IS NOT NULL ORDER BY id DESC LIMIT 1) AS state,
       (SELECT next_billing_at FROM subscription_events WHERE subscription_id = s.id AND next_billing_at IS NOT NULL ORDER BY id DESC LIMIT 1) AS next_billing_at
FROM subscriptions s;
