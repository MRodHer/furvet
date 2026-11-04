-- FurVet — D1 (SQLite). Money is INTEGER cents everywhere; never REAL.
-- Single-tenant demo: no tenant column. Timestamps are ISO-8601 UTC text.

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Visitante' CHECK (length(name) <= 120),
  email TEXT CHECK (email IS NULL OR length(email) <= 254),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  assigned_to TEXT,
  claimed_by TEXT,
  bot_escalated INTEGER NOT NULL DEFAULT 0 CHECK (bot_escalated IN (0, 1)),
  escalation_reason TEXT,
  -- Recording consent given by the owner through the chat button (versioned text).
  owner_consent_at TEXT,
  owner_consent_version TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_conversations_contact_id ON conversations (contact_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  text TEXT NOT NULL CHECK (length(text) <= 4000),
  is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_messages_conversation_id ON messages (conversation_id, id);

CREATE TABLE sim_usage (
  day TEXT PRIMARY KEY,
  messages INTEGER NOT NULL DEFAULT 0
);

-- Prices are set by the clinic (tax included). The model never sees price columns.
CREATE TABLE catalog_items (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(name) <= 120),
  category TEXT NOT NULL CHECK (category IN ('consulta', 'vacunacion', 'desparasitacion', 'laboratorio', 'medicamento', 'anticipo', 'otro')),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  unit TEXT NOT NULL DEFAULT 'pza',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE pets (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  name TEXT NOT NULL CHECK (length(name) <= 60),
  species TEXT NOT NULL CHECK (species IN ('perro', 'gato')),
  breed TEXT CHECK (breed IS NULL OR length(breed) <= 60),
  sex TEXT CHECK (sex IS NULL OR sex IN ('macho', 'hembra')),
  birth_date TEXT
);

CREATE TABLE slots (
  id TEXT PRIMARY KEY,
  starts_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 10 AND 120),
  taken INTEGER NOT NULL DEFAULT 0 CHECK (taken IN (0, 1))
);
CREATE INDEX idx_slots_free ON slots (taken, starts_at);

CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL UNIQUE REFERENCES slots(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  pet_id TEXT NOT NULL REFERENCES pets(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  status TEXT NOT NULL DEFAULT 'pending_deposit'
    CHECK (status IN ('pending_deposit', 'confirmed', 'in_consult', 'done', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_appointments_conversation_id ON appointments (conversation_id);

-- ===== Ledger (append-only) =====
CREATE TABLE charges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'balance')),
  appointment_id TEXT REFERENCES appointments(id),
  consult_id TEXT,
  conversation_id TEXT REFERENCES conversations(id),
  paypal_order_id TEXT UNIQUE,
  paypal_request_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  approve_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((kind = 'deposit') = (appointment_id IS NOT NULL)),
  CHECK ((kind = 'balance') = (consult_id IS NOT NULL))
);
CREATE UNIQUE INDEX charges_one_deposit_per_appointment ON charges (appointment_id) WHERE kind = 'deposit';
CREATE UNIQUE INDEX charges_one_balance_per_consult ON charges (consult_id) WHERE kind = 'balance';

CREATE TABLE charge_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charge_id TEXT NOT NULL REFERENCES charges(id),
  status TEXT NOT NULL CHECK (status IN ('created', 'approved', 'captured', 'amount_mismatch', 'capture_failed', 'denied')),
  paypal_event_id TEXT UNIQUE,
  paypal_capture_id TEXT,
  amount_cents INTEGER,
  currency TEXT,
  raw TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_charge_events_charge_id ON charge_events (charge_id, id);
CREATE UNIQUE INDEX charge_events_one_capture ON charge_events (charge_id, paypal_capture_id) WHERE status = 'captured';

CREATE TRIGGER charges_no_update BEFORE UPDATE ON charges
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER charges_no_delete BEFORE DELETE ON charges
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER charge_events_no_update BEFORE UPDATE ON charge_events
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER charge_events_no_delete BEFORE DELETE ON charge_events
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

-- Header + latest event. This is what the board and the report gate read.
CREATE VIEW charges_current AS
SELECT c.id, c.kind, c.appointment_id, c.consult_id, c.conversation_id,
       c.paypal_order_id, c.amount_cents, c.currency, c.approve_url, c.created_at,
       e.status, e.paypal_capture_id, e.created_at AS last_event_at
FROM charges c
LEFT JOIN charge_events e
  ON e.id = (SELECT id FROM charge_events WHERE charge_id = c.id ORDER BY id DESC LIMIT 1);
