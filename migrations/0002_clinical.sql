-- FurVet — clinical step: consult, transcript, AI drafts (append-only), daily audio cap.
-- The audio itself NEVER lands here (no blob column exists on purpose).

CREATE TABLE consults (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL UNIQUE REFERENCES appointments(id),
  -- Snapshot of the owner's chat consent at consult creation (repudiation evidence).
  owner_consent_at TEXT,
  owner_consent_version TEXT,
  doctor_consent_at TEXT,
  doctor_consent_version TEXT,
  audio_received_at TEXT,
  audio_seconds INTEGER CHECK (audio_seconds IS NULL OR audio_seconds >= 0),
  transcribed_at TEXT,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'recording'
    CHECK (status IN ('recording', 'transcribed', 'drafted', 'approved', 'delivered')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE transcript_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  consult_id TEXT NOT NULL REFERENCES consults(id),
  idx INTEGER NOT NULL CHECK (idx >= 0),
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
  speaker TEXT NOT NULL DEFAULT 'unknown' CHECK (speaker IN ('doctor', 'owner', 'unknown')),
  text TEXT NOT NULL CHECK (length(text) <= 4000),
  UNIQUE (consult_id, idx)
);

-- What the AI proposed and what the doctor approved: immutable evidence.
CREATE TABLE consult_versions (
  id TEXT PRIMARY KEY,
  consult_id TEXT NOT NULL REFERENCES consults(id),
  kind TEXT NOT NULL CHECK (kind IN ('ai_draft', 'approved')),
  body TEXT NOT NULL CHECK (json_valid(body)),
  grounding TEXT NOT NULL CHECK (json_valid(grounding)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_consult_versions_consult_id ON consult_versions (consult_id, id);
CREATE UNIQUE INDEX consult_versions_one_approved ON consult_versions (consult_id) WHERE kind = 'approved';
CREATE TRIGGER consult_versions_no_update BEFORE UPDATE ON consult_versions
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER consult_versions_no_delete BEFORE DELETE ON consult_versions
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

-- Daily transcription budget (fail-closed: the reservation happens before the provider call).
CREATE TABLE audio_usage (
  day TEXT PRIMARY KEY,
  audio_seconds INTEGER NOT NULL DEFAULT 0 CHECK (audio_seconds >= 0)
);
