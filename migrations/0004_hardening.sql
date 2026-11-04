-- 0004 — hardening (audit H3, H7, I1). DDL only; forward-only.

-- H3: failed doctor-login counter per origin key ("ip:<addr>" or "global"), with a progressive block.
-- Only the Worker writes here; rows carry no credential and no PII (the ip is the key, never logged raw).
CREATE TABLE auth_failures (
  key TEXT PRIMARY KEY CHECK (length(key) <= 80),
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  window_start INTEGER NOT NULL CHECK (window_start >= 0),
  blocked_until INTEGER NOT NULL DEFAULT 0 CHECK (blocked_until >= 0)
);

-- H7: one `captured` row per charge, whatever the capture id. The (charge, capture) index stays
-- for the replay-of-the-same-capture case; this one closes the different-capture-id case in the DB.
CREATE UNIQUE INDEX charge_events_one_captured ON charge_events (charge_id) WHERE status = 'captured';

-- I1: owner links are evidence too; their expiry is never edited, a new token is issued instead.
CREATE TRIGGER delivery_tokens_no_update BEFORE UPDATE ON delivery_tokens
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER delivery_tokens_no_delete BEFORE DELETE ON delivery_tokens
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
