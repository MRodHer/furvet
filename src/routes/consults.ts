// Doctor-only clinical routes. Every route sits behind doctorAuth (503 when unconfigured).
// The audio route follows the strict order of the contract: 503 provider → 404/409 state &
// consent → 413 size (header AND stream) → 415 signature → 429 daily cap → provider.
// Audio bytes live in this request's memory only: never D1, never R2, never logs.
import { Hono } from "hono";
import { z } from "zod";
import { ClaudeError } from "../agent/claude";
import { doctorAuth } from "../auth";
import { DraftRejectedError, fillConsult } from "../clinical/fill";
import { redactOwner } from "../clinical/redact";
import { labelSpeakers, type Speaker } from "../clinical/roles";
import { sniffAudio, transcribe, TranscribeError, WHISPER_MODEL } from "../clinical/transcribe";
import type { Deps, Env } from "../env";
import { intVar } from "../env";
import { errName, log } from "../log";

export const DOCTOR_CONSENT_VERSION = "doctor-v1-2026-11-04";
const AUDIO_BYTES_PER_SECOND = 4000; // 32 kbps, the console's recorder setting
const PROVIDER_LOG = "workers-ai-whisper"; // the model id carries an "@" that the PII log guard rejects

const Id = z.string().uuid();
const CreateBody = z.object({ appointment_id: Id }).strict();
const ConsentBody = z.object({ version: z.literal(DOCTOR_CONSENT_VERSION) }).strict();
const SpeakerBody = z.object({ speaker: z.enum(["doctor", "owner", "unknown"]) }).strict();

interface ConsultRow {
  id: string;
  appointment_id: string;
  owner_consent_at: string | null;
  owner_consent_version: string | null;
  doctor_consent_at: string | null;
  audio_received_at: string | null;
  audio_seconds: number | null;
  transcribed_at: string | null;
  provider: string | null;
  status: string;
  created_at: string;
}
const CONSULT_COLUMNS =
  "id, appointment_id, owner_consent_at, owner_consent_version, doctor_consent_at, audio_received_at, audio_seconds, transcribed_at, provider, status, created_at";

interface SegmentRow {
  idx: number;
  start_ms: number;
  end_ms: number;
  speaker: Speaker;
  text: string;
}

/** Reads the whole body with a hard cap; null when the stream exceeds it. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}

export function consultsRoutes(deps: Deps) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", doctorAuth());

  const getConsult = (env: Env, id: string) =>
    env.DB.prepare(`SELECT ${CONSULT_COLUMNS} FROM consults WHERE id = ?1`).bind(id).first<ConsultRow>();
  /** Owner identity, only to strip it from what the model sees. */
  const ownerOf = async (env: Env, appointmentId: string) =>
    (await env.DB.prepare("SELECT c.name, c.email FROM appointments a JOIN contacts c ON c.id = a.contact_id WHERE a.id = ?1")
      .bind(appointmentId)
      .first<{ name: string | null; email: string | null }>()) ?? { name: null, email: null };

  // Appointments the doctor can open today: confirmed (deposit captured) or already in consult.
  app.get("/appointments", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, a.status, s.starts_at, p.name AS pet_name, p.species, p.breed, k.id AS consult_id, k.status AS consult_status
       FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN pets p ON p.id = a.pet_id
       LEFT JOIN consults k ON k.appointment_id = a.id
       WHERE a.status IN ('confirmed', 'in_consult') ORDER BY s.starts_at ASC LIMIT 50`,
    ).all();
    return c.json(results);
  });

  app.post("/", async (c) => {
    const body = CreateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const appt = await c.env.DB.prepare(
      `SELECT a.id, a.status, v.owner_consent_at, v.owner_consent_version
       FROM appointments a JOIN conversations v ON v.id = a.conversation_id WHERE a.id = ?1`,
    )
      .bind(body.data.appointment_id)
      .first<{ id: string; status: string; owner_consent_at: string | null; owner_consent_version: string | null }>();
    if (!appt) return c.json({ error: "unknown appointment" }, 404);
    if (appt.status !== "confirmed") return c.json({ error: `appointment is ${appt.status}` }, 409);
    const id = crypto.randomUUID();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO consults (id, appointment_id, owner_consent_at, owner_consent_version) VALUES (?1, ?2, ?3, ?4)").bind(
        id, appt.id, appt.owner_consent_at, appt.owner_consent_version,
      ),
      c.env.DB.prepare("UPDATE appointments SET status = 'in_consult' WHERE id = ?1 AND status = 'confirmed'").bind(appt.id),
    ]);
    log("consult_created", { consult_id: id, appointment_id: appt.id, owner_consent: appt.owner_consent_at !== null });
    return c.json({ id }, 201);
  });

  app.get("/:id", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "invalid id" }, 400);
    const consult = await getConsult(c.env, id.data);
    if (!consult) return c.json({ error: "not found" }, 404);
    const pet = await c.env.DB.prepare(
      "SELECT p.name, p.species, p.breed FROM appointments a JOIN pets p ON p.id = a.pet_id WHERE a.id = ?1",
    ).bind(consult.appointment_id).first<{ name: string; species: string; breed: string | null }>();
    const { results: segments } = await c.env.DB.prepare(
      "SELECT idx, start_ms, end_ms, speaker, text FROM transcript_segments WHERE consult_id = ?1 ORDER BY idx ASC",
    ).bind(id.data).all<SegmentRow>();
    const draft = await c.env.DB.prepare(
      "SELECT id, body, grounding, created_at FROM consult_versions WHERE consult_id = ?1 AND kind = 'ai_draft' ORDER BY id DESC LIMIT 1",
    ).bind(id.data).first<{ id: string; body: string; grounding: string; created_at: string }>();
    const approved = await c.env.DB.prepare("SELECT id FROM consult_versions WHERE consult_id = ?1 AND kind = 'approved'").bind(id.data).first<{ id: string }>();
    // Catalog for the doctor's billable picker: names only, prices stay on the server.
    const { results: catalog } = await c.env.DB.prepare("SELECT id, name, category FROM catalog_items WHERE active = 1 AND category <> 'anticipo' ORDER BY category, name").all();
    return c.json({
      catalog,
      consult,
      pet,
      segments,
      draft: draft ? { id: draft.id, body: JSON.parse(draft.body), grounding: JSON.parse(draft.grounding), created_at: draft.created_at } : null,
      approved_version_id: approved?.id ?? null,
    });
  });

  // Doctor's consent (second layer). First click wins; the text version is recorded.
  app.post("/:id/consent", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "invalid id" }, 400);
    const body = ConsentBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const res = await c.env.DB.prepare(
      "UPDATE consults SET doctor_consent_at = ?1, doctor_consent_version = ?2 WHERE id = ?3 AND doctor_consent_at IS NULL AND status = 'recording'",
    ).bind(deps.now().toISOString(), body.data.version, id.data).run();
    if (res.meta.changes === 0 && !(await getConsult(c.env, id.data))) return c.json({ error: "not found" }, 404);
    log("doctor_consent_recorded", { consult_id: id.data, version: body.data.version });
    return c.json({ ok: true });
  });

  app.post("/:id/audio", async (c) => {
    const env = c.env;
    // (1) provider configured
    if (!env.AI) return c.json({ error: "transcription provider not configured" }, 503);
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "invalid id" }, 400);
    const consult = await getConsult(env, id.data);
    if (!consult) return c.json({ error: "not found" }, 404);
    // (2) both consents, and the consult still waiting for its audio
    if (consult.status !== "recording") return c.json({ error: `consult is ${consult.status}` }, 409);
    if (!consult.owner_consent_at || !consult.doctor_consent_at) {
      log("audio_refused_no_consent", { consult_id: id.data, owner: consult.owner_consent_at !== null, doctor: consult.doctor_consent_at !== null });
      return c.json({ error: "recording consent missing (owner and doctor are both required)" }, 409);
    }
    // (3) size: header first, then the stream itself
    const max = intVar(env.MAX_AUDIO_BYTES, 8_000_000);
    const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > max) return c.json({ error: "audio too large" }, 413);
    const audio = await readCapped(c.req.raw.body, max);
    if (audio === null) return c.json({ error: "audio too large" }, 413);
    // (4) signature of the bytes, never the declared type
    const kind = sniffAudio(audio);
    if (!kind) return c.json({ error: "not a supported audio container (webm, ogg, mp4)" }, 415);
    // (5) daily budget reserved atomically before the provider sees a byte (fail-closed)
    const estSeconds = Math.max(1, Math.ceil(audio.byteLength / AUDIO_BYTES_PER_SECOND));
    const cap = intVar(env.AUDIO_DAILY_SECONDS_CAP, 7200);
    const day = deps.now().toISOString().slice(0, 10);
    const reserved = await env.DB.prepare(
      `INSERT INTO audio_usage (day, audio_seconds) VALUES (?1, ?2)
       ON CONFLICT(day) DO UPDATE SET audio_seconds = audio_seconds + ?2 WHERE audio_seconds + ?2 <= ?3
       RETURNING audio_seconds`,
    ).bind(day, estSeconds, cap).first();
    if (!reserved || estSeconds > cap) {
      log("audio_daily_cap_reached", { day, consult_id: id.data });
      return c.json({ error: "daily transcription budget reached" }, 429);
    }
    // (6) transcribe; the error surfaces to the doctor, never a silent fallback
    let result: Awaited<ReturnType<typeof transcribe>>;
    try {
      result = await transcribe(env.AI, audio);
    } catch (e) {
      log("transcribe_failed", { consult_id: id.data, provider: PROVIDER_LOG, error: errName(e), bytes: audio.byteLength });
      if (e instanceof TranscribeError && e.kind === "too_long") return c.json({ error: "consult too long" }, 413);
      return c.json({ error: "transcription failed, try again" }, 502);
    }
    // (7) roles by content; unlabeled is a visible state, reported in the response
    let labels = new Map<number, Speaker>();
    let labeled = false;
    if (env.ANTHROPIC_API_KEY && result.segments.length > 0) {
      try {
        const owner = await ownerOf(env, consult.appointment_id);
        labels = await labelSpeakers(deps.fetch, env.ANTHROPIC_API_KEY, result.segments.map((s) => ({ idx: s.idx, text: redactOwner(s.text, owner) })));
        labeled = labels.size > 0;
      } catch (e) {
        log("label_speakers_failed", { consult_id: id.data, error: errName(e) });
      }
    }
    const now = deps.now().toISOString();
    try {
      await env.DB.batch([
        ...result.segments.map((s) =>
          env.DB.prepare("INSERT INTO transcript_segments (consult_id, idx, start_ms, end_ms, speaker, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(
            id.data, s.idx, s.start_ms, s.end_ms, labels.get(s.idx) ?? "unknown", s.text,
          ),
        ),
        env.DB.prepare(
          "UPDATE consults SET status = 'transcribed', audio_received_at = ?1, transcribed_at = ?1, audio_seconds = ?2, provider = ?3 WHERE id = ?4 AND status = 'recording'",
        ).bind(now, result.seconds, WHISPER_MODEL, id.data),
      ]);
    } catch (e) {
      log("transcript_store_failed", { consult_id: id.data, error: errName(e) });
      return c.json({ error: "this consult already has a transcript" }, 409);
    }
    log("audio_transcribed", { consult_id: id.data, provider: PROVIDER_LOG, seconds: result.seconds, segments: result.segments.length, labeled, container: kind });
    return c.json({ ok: true, segments: result.segments.length, seconds: result.seconds, labeled });
  });

  app.patch("/:id/segments/:idx", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    const idx = z.coerce.number().int().min(0).safeParse(c.req.param("idx"));
    if (!id.success || !idx.success) return c.json({ error: "invalid id" }, 400);
    const body = SpeakerBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const res = await c.env.DB.prepare("UPDATE transcript_segments SET speaker = ?1 WHERE consult_id = ?2 AND idx = ?3").bind(body.data.speaker, id.data, idx.data).run();
    if (res.meta.changes === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/:id/fill", async (c) => {
    const env = c.env;
    if (!env.ANTHROPIC_API_KEY) return c.json({ error: "model not configured" }, 503);
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "invalid id" }, 400);
    const consult = await getConsult(env, id.data);
    if (!consult) return c.json({ error: "not found" }, 404);
    if (consult.status !== "transcribed" && consult.status !== "drafted") return c.json({ error: `consult is ${consult.status}` }, 409);
    const pet = await env.DB.prepare("SELECT p.species, p.breed FROM appointments a JOIN pets p ON p.id = a.pet_id WHERE a.id = ?1")
      .bind(consult.appointment_id)
      .first<{ species: string; breed: string | null }>();
    const { results: stored } = await env.DB.prepare("SELECT idx, speaker, text FROM transcript_segments WHERE consult_id = ?1 ORDER BY idx ASC")
      .bind(id.data)
      .all<{ idx: number; speaker: string; text: string }>();
    if (stored.length === 0) return c.json({ error: "no transcript" }, 409);
    // The model (and the grounding check, so quotes stay consistent) see the redacted text; D1 keeps the original.
    const owner = await ownerOf(env, consult.appointment_id);
    const segments = stored.map((s) => ({ ...s, text: redactOwner(s.text, owner) }));
    // Catalog WITHOUT prices; the deposit is not a consult item.
    const { results: catalog } = await env.DB.prepare(
      "SELECT id, name, category FROM catalog_items WHERE active = 1 AND category <> 'anticipo' ORDER BY category, name",
    ).all<{ id: string; name: string; category: string }>();
    let draft: Awaited<ReturnType<typeof fillConsult>>;
    try {
      draft = await fillConsult(deps.fetch, env.ANTHROPIC_API_KEY, { segments, species: pet?.species ?? "perro", breed: pet?.breed ?? null, catalog });
    } catch (e) {
      log("fill_failed", { consult_id: id.data, error: errName(e) });
      if (e instanceof DraftRejectedError) return c.json({ error: "model output rejected", issues: e.issues }, 422);
      if (e instanceof ClaudeError) return c.json({ error: "model call failed, try again" }, 502);
      throw e;
    }
    const versionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO consult_versions (id, consult_id, kind, body, grounding, created_by) VALUES (?1, ?2, 'ai_draft', ?3, ?4, 'ai')").bind(
        versionId, id.data, JSON.stringify(draft.body), JSON.stringify(draft.report),
      ),
      env.DB.prepare("UPDATE consults SET status = 'drafted' WHERE id = ?1 AND status = 'transcribed'").bind(id.data),
    ]);
    log("consult_drafted", { consult_id: id.data, version_id: versionId, discarded: draft.report.discarded.length, incomplete_medications: draft.report.incomplete_medications.length });
    return c.json({ version_id: versionId, body: draft.body, grounding: draft.report }, 201);
  });

  return app;
}
