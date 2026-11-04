import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { assertNoPii, captureLogs, count, DOCTOR_AUTH, json, makeApp, PP, seedConfirmed, withEnv } from "./helpers";

const WEBM = [0x1a, 0x45, 0xdf, 0xa3];
const toolUse = (name: string, input: unknown) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu-1", name, input }] });

/** Fake Workers AI binding that records calls and returns a scripted transcript. */
function fakeAi(result: unknown | (() => unknown) = { text: "hola", segments: [{ start: 0, end: 2.5, text: "hola" }] }) {
  const calls: unknown[] = [];
  const ai = {
    run: async (_model: string, input: unknown) => {
      calls.push(input);
      return typeof result === "function" ? (result as () => unknown)() : result;
    },
  } as unknown as Ai;
  return { ai, calls };
}

function audioBody(marker: string, size = 0): Uint8Array {
  const payload = new TextEncoder().encode(marker);
  const out = new Uint8Array(Math.max(size, WEBM.length + payload.length));
  out.set(WEBM, 0);
  out.set(payload, WEBM.length);
  return out;
}

async function createConsult(app: ReturnType<typeof makeApp>["app"], e: Env, opts: { ownerConsent?: boolean; doctorConsent?: boolean } = {}) {
  const b = await seedConfirmed({ ownerConsent: opts.ownerConsent });
  const res = await app.request("/api/v1/consults", { method: "POST", headers: { ...DOCTOR_AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ appointment_id: b.appt }) }, e);
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  if (opts.doctorConsent !== false) {
    const c = await app.request(`/api/v1/consults/${id}/consent`, { method: "POST", headers: { ...DOCTOR_AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ version: "doctor-v1-2026-11-04" }) }, e);
    expect(c.status).toBe(200);
  }
  return { id, ...b };
}

function upload(app: ReturnType<typeof makeApp>["app"], id: string, body: Uint8Array | ReadableStream, e: Env, headers: Record<string, string> = {}) {
  return app.request(`/api/v1/consults/${id}/audio`, { method: "POST", headers: { ...DOCTOR_AUTH, "Content-Type": "audio/webm", ...headers }, body: body as BodyInit, duplex: "half" } as RequestInit, e);
}

/** Every text column of every table, searched for the marker. */
async function dbContains(marker: string): Promise<string[]> {
  const { results: tables } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'd1_%'").all<{ name: string }>();
  const hits: string[] = [];
  for (const t of tables) {
    const { results: cols } = await env.DB.prepare(`PRAGMA table_info(${t.name})`).all<{ name: string }>();
    const where = cols.map((c) => `CAST("${c.name}" AS TEXT) LIKE ?1`).join(" OR ");
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t.name} WHERE ${where}`).bind(`%${marker}%`).first<{ n: number }>();
    if ((n?.n ?? 0) > 0) hits.push(t.name);
  }
  return hits;
}

describe("audio upload (V1, V2, V3, V19) — strict order 503 → 409 → 413 → 415 → 429", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  it("happy path: transcribed, speakers labeled by Claude, consult → transcribed, audio never persisted (V2)", async () => {
    const marker = `MARK-${crypto.randomUUID().slice(0, 8)}`; // D1 caps LIKE patterns at 50 chars
    const { ai, calls } = fakeAi({ text: "x", transcription_info: { duration: 61.2 }, segments: [{ start: 0, end: 3, text: " ¿Qué le pasa a Firulais? " }, { start: 3, end: 7, text: "No quiere comer desde ayer." }] });
    const { app, count: fetchCalls } = makeApp({ [PP.claude]: () => json(toolUse("label_speakers", { labels: [{ idx: 0, speaker: "doctor" }, { idx: 1, speaker: "owner" }] })) });
    const e = withEnv({ AI: ai });
    const { id } = await createConsult(app, e);
    const logs = captureLogs();
    restore = logs.restore;
    const res = await upload(app, id, audioBody(marker), e);
    logs.restore();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, segments: 2, seconds: 62, labeled: true });
    expect(calls).toHaveLength(1);
    expect((calls[0] as { audio: string }).audio).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(fetchCalls(PP.claude)).toBe(1);

    const consult = await env.DB.prepare("SELECT status, audio_seconds, provider, audio_received_at FROM consults WHERE id = ?1").bind(id).first();
    expect(consult).toMatchObject({ status: "transcribed", audio_seconds: 62, provider: "@cf/openai/whisper-large-v3-turbo" });
    const { results } = await env.DB.prepare("SELECT idx, start_ms, end_ms, speaker, text FROM transcript_segments WHERE consult_id = ?1 ORDER BY idx").bind(id).all();
    expect(results).toEqual([
      { idx: 0, start_ms: 0, end_ms: 3000, speaker: "doctor", text: "¿Qué le pasa a Firulais?" },
      { idx: 1, start_ms: 3000, end_ms: 7000, speaker: "owner", text: "No quiere comer desde ayer." },
    ]);
    // V2: no table holds the audio, and no log line carries the transcript or the audio.
    expect(await dbContains(marker)).toEqual([]);
    expect(await count("audio_usage", "audio_seconds > 0")).toBeGreaterThan(0);
    for (const l of logs.lines) {
      expect(l).not.toContain(marker);
      expect(l).not.toContain("Firulais");
      expect(l).not.toContain("comer");
    }
    assertNoPii(logs.lines);

    // A second upload for the same consult is refused before the provider is touched.
    expect((await upload(app, id, audioBody(marker), e)).status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("V1: owner consent missing → 409; doctor consent missing → 409; provider called 0 times", async () => {
    const { ai, calls } = fakeAi();
    const { app } = makeApp({});
    const e = withEnv({ AI: ai });
    const noOwner = await createConsult(app, e, { ownerConsent: false });
    const r1 = await upload(app, noOwner.id, audioBody("x"), e);
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as { error: string }).error).toMatch(/consent/);
    const noDoctor = await createConsult(app, e, { doctorConsent: false });
    expect((await upload(app, noDoctor.id, audioBody("x"), e)).status).toBe(409);
    expect(calls).toHaveLength(0);
    expect(await count("transcript_segments", "consult_id IN (?1, ?2)", noOwner.id, noDoctor.id)).toBe(0);
  });

  it("V3: no AI binding → 503 before anything else (even without consent)", async () => {
    const { app } = makeApp({});
    const e = withEnv({ AI: undefined });
    const { id } = await createConsult(app, e, { ownerConsent: false });
    expect((await upload(app, id, audioBody("x"), e)).status).toBe(503);
  });

  it("V3: over MAX_AUDIO_BYTES → 413 by Content-Length, and by the stream when the header lies", async () => {
    const { ai, calls } = fakeAi();
    const { app } = makeApp({});
    const e = withEnv({ AI: ai, MAX_AUDIO_BYTES: "1000" });
    const { id } = await createConsult(app, e);
    expect((await upload(app, id, audioBody("x", 1001), e)).status).toBe(413);
    // Chunked stream, no Content-Length: the reader cuts at the cap.
    const big = audioBody("x", 5000);
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (let i = 0; i < big.length; i += 700) ctl.enqueue(big.subarray(i, i + 700));
        ctl.close();
      },
    });
    const res = await upload(app, id, stream, e);
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
    // Exactly at the cap is accepted.
    expect((await upload(app, id, audioBody("x", 1000), e)).status).toBe(200);
  });

  it("V3: declared audio/webm but PDF bytes → 415 (signature wins over the header)", async () => {
    const { ai, calls } = fakeAi();
    const { app } = makeApp({});
    const e = withEnv({ AI: ai });
    const { id } = await createConsult(app, e);
    expect((await upload(app, id, new TextEncoder().encode("%PDF-1.4 not audio"), e)).status).toBe(415);
    expect((await upload(app, id, new Uint8Array(0), e)).status).toBe(415);
    expect(calls).toHaveLength(0);
    // ogg and mp4 signatures pass the sniff.
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);
    expect((await upload(app, id, ogg, e, { "Content-Type": "audio/ogg" })).status).toBe(200);
  });

  it("V3: daily budget → 429 with an atomic reservation before the provider; 0 provider calls", async () => {
    const { ai, calls } = fakeAi();
    // 2030-02-02 so no other test shares the day row; 8000 bytes ≈ 2 s at 32 kbps.
    const { app } = makeApp({}, new Date("2030-02-02T10:00:00.000Z"));
    const e = withEnv({ AI: ai, AUDIO_DAILY_SECONDS_CAP: "3" });
    const a = await createConsult(app, e);
    expect((await upload(app, a.id, audioBody("x", 8000), e)).status).toBe(200);
    const b = await createConsult(app, e);
    expect((await upload(app, b.id, audioBody("x", 8000), e)).status).toBe(429);
    expect(calls).toHaveLength(1);
    const usage = await env.DB.prepare("SELECT audio_seconds FROM audio_usage WHERE day = '2030-02-02'").first<{ audio_seconds: number }>();
    expect(usage?.audio_seconds).toBe(2);
    expect(await count("consults", "id = ?1 AND status = 'recording'", b.id)).toBe(1);
  });

  it("V19: provider failure is visible (502), consult stays 'recording', nothing stored, error TYPE logged without PII", async () => {
    const { ai } = fakeAi(() => {
      throw new Error("upstream boom");
    });
    const { app } = makeApp({});
    const e = withEnv({ AI: ai });
    const { id } = await createConsult(app, e);
    const logs = captureLogs();
    restore = logs.restore;
    const res = await upload(app, id, audioBody("x"), e);
    logs.restore();
    expect(res.status).toBe(502);
    expect(await count("consults", "id = ?1 AND status = 'recording'", id)).toBe(1);
    expect(await count("transcript_segments", "consult_id = ?1", id)).toBe(0);
    expect(logs.lines.some((l) => l.includes('"event":"transcribe_failed"') && l.includes("TranscribeError"))).toBe(true);
    assertNoPii(logs.lines);
    // A malformed provider response is a failure too, never a silent empty transcript.
    const { ai: weird } = fakeAi({ nope: true });
    expect((await upload(app, id, audioBody("x"), withEnv({ AI: weird }))).status).toBe(502);
  });

  it("more than 600 segments → 413 (consult too long); Claude not called", async () => {
    const segments = Array.from({ length: 601 }, (_, i) => ({ start: i, end: i + 1, text: `seg ${i}` }));
    const { ai } = fakeAi({ text: "x", segments });
    const { app, count: fetchCalls } = makeApp({ [PP.claude]: () => json({ stop_reason: "end_turn", content: [] }) });
    const e = withEnv({ AI: ai });
    const { id } = await createConsult(app, e);
    expect((await upload(app, id, audioBody("x"), e)).status).toBe(413);
    expect(fetchCalls(PP.claude)).toBe(0);
  });

  it("without Claude key the transcript is stored with speakers 'unknown' and labeled:false (visible, not silent)", async () => {
    const { ai } = fakeAi();
    const { app } = makeApp({});
    const e = withEnv({ AI: ai, ANTHROPIC_API_KEY: undefined });
    const { id } = await createConsult(app, e);
    const res = await upload(app, id, audioBody("x"), e);
    expect(await res.json()).toMatchObject({ ok: true, labeled: false });
    expect(await count("transcript_segments", "consult_id = ?1 AND speaker = 'unknown'", id)).toBe(1);
    // The doctor can flip a label; an unknown segment → 404; a bad label → 400.
    const patch = (idx: number, body: unknown) =>
      app.request(`/api/v1/consults/${id}/segments/${idx}`, { method: "PATCH", headers: { ...DOCTOR_AUTH, "Content-Type": "application/json" }, body: JSON.stringify(body) }, e);
    expect((await patch(0, { speaker: "doctor" })).status).toBe(200);
    expect(await count("transcript_segments", "consult_id = ?1 AND speaker = 'doctor'", id)).toBe(1);
    expect((await patch(7, { speaker: "doctor" })).status).toBe(404);
    expect((await patch(0, { speaker: "cat" })).status).toBe(400);
  });

  it("consult creation: only confirmed appointments; one consult per appointment; owner consent snapshotted", async () => {
    const { app } = makeApp({});
    const b = await seedConfirmed();
    const create = () => app.request("/api/v1/consults", { method: "POST", headers: { ...DOCTOR_AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ appointment_id: b.appt }) }, env);
    const first = await create();
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    expect(await env.DB.prepare("SELECT owner_consent_version FROM consults WHERE id = ?1").bind(id).first()).toEqual({ owner_consent_version: "v1-2026-11-04" });
    expect(await count("appointments", "id = ?1 AND status = 'in_consult'", b.appt)).toBe(1);
    expect((await create()).status).toBe(409); // now in_consult
    const unknown = await app.request("/api/v1/consults", { method: "POST", headers: { ...DOCTOR_AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ appointment_id: crypto.randomUUID() }) }, env);
    expect(unknown.status).toBe(404);
    // Detail returns explicit columns and the snapshot; the appointment list shows the consult.
    const detail = await app.request(`/api/v1/consults/${id}`, { headers: DOCTOR_AUTH }, env);
    expect(detail.status).toBe(200);
    const d = (await detail.json()) as { consult: Record<string, unknown>; pet: { name: string }; segments: unknown[]; draft: unknown };
    expect(d.pet.name).toBe("Firulais");
    expect(d.consult.status).toBe("recording");
    expect(d.segments).toEqual([]);
    expect(d.draft).toBeNull();
    const list = (await (await app.request("/api/v1/consults/appointments", { headers: DOCTOR_AUTH }, env)).json()) as { id: string; consult_id: string | null }[];
    expect(list.find((a) => a.id === b.appt)?.consult_id).toBe(id);
  });
});
