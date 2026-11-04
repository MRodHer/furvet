-- FurVet — delivery: bill snapshot, delivery tokens, report images. Cents INTEGER everywhere.
-- `consults` is created by 0002 (clinical); bill rows reference it by id without FK so the two
-- migrations stay independent (D1 applies them in order anyway).

-- One row per approval. The PRIMARY KEY is what makes a second approval a 409.
CREATE TABLE consult_bills (
  consult_id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL UNIQUE,
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  deposit_cents INTEGER NOT NULL CHECK (deposit_cents >= 0),
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0 AND balance_cents = max(total_cents - deposit_cents, 0)),
  approved_by TEXT NOT NULL CHECK (length(approved_by) <= 120),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Price snapshot copied from catalog_items at approval time. Append-only evidence.
CREATE TABLE bill_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  consult_id TEXT NOT NULL REFERENCES consult_bills(consult_id),
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items(id),
  name TEXT NOT NULL CHECK (length(name) <= 120),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents = quantity * unit_price_cents),
  source TEXT NOT NULL CHECK (source IN ('ai_detected', 'doctor_added')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_bill_lines_consult_id ON bill_lines (consult_id, id);

CREATE TRIGGER consult_bills_no_update BEFORE UPDATE ON consult_bills
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER consult_bills_no_delete BEFORE DELETE ON consult_bills
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER bill_lines_no_update BEFORE UPDATE ON bill_lines
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER bill_lines_no_delete BEFORE DELETE ON bill_lines
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

-- The clear token only travels in the link; the database keeps its sha256 (hex).
CREATE TABLE delivery_tokens (
  token_sha256 TEXT PRIMARY KEY CHECK (length(token_sha256) = 64),
  consult_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('rx', 'report')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

-- Image bytes live in R2 (metadata stripped before the put); D1 keeps the pointer.
-- position 1..4 + UNIQUE: a fifth image has nowhere to go (409 by constraint, not by code).
CREATE TABLE report_images (
  id TEXT PRIMARY KEY,
  consult_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 4),
  r2_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png')),
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 2097152),
  caption TEXT NOT NULL DEFAULT '' CHECK (length(caption) <= 200),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (consult_id, position)
);
