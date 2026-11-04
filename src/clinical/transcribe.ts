// Workers AI Whisper. Input verified against the wrangler-generated types
// (Ai_Cf_Openai_Whisper_Large_V3_Turbo_Input: `audio` is a base64 string) and Cloudflare's
// official chunking tutorial. The bytes live only in this call's scope: nothing is stored.
import { z } from "zod";
import { bytesToBase64 } from "../prior/text";

export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const MAX_SEGMENT_CHARS = 4000;
export const MAX_SEGMENTS = 600;

export class TranscribeError extends Error {
  constructor(message: string, readonly kind: "provider" | "too_long") {
    super(message);
    this.name = "TranscribeError";
  }
}

export interface Segment {
  idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

const Output = z.object({
  text: z.string(),
  transcription_info: z.object({ duration: z.number().optional() }).partial().optional(),
  segments: z.array(z.object({ start: z.number().optional(), end: z.number().optional(), text: z.string().optional() })).optional(),
});

/** Media type by the file's own signature (the declared Content-Type is sender data). */
export function sniffAudio(b: Uint8Array): "webm" | "ogg" | "mp4" | null {
  const at = (off: number, sig: number[]) => b.length >= off + sig.length && sig.every((x, i) => b[off + i] === x);
  if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
  if (at(0, [0x4f, 0x67, 0x67, 0x53])) return "ogg";
  if (at(4, [0x66, 0x74, 0x79, 0x70])) return "mp4";
  return null;
}

export async function transcribe(ai: Ai, audio: Uint8Array): Promise<{ segments: Segment[]; seconds: number }> {
  let raw: unknown;
  try {
    raw = await ai.run(WHISPER_MODEL, { audio: bytesToBase64(audio), language: "es", task: "transcribe" });
  } catch (e) {
    throw new TranscribeError(`provider failed: ${e instanceof Error ? e.name : typeof e}`, "provider");
  }
  const out = Output.safeParse(raw);
  if (!out.success) throw new TranscribeError("provider returned an unexpected shape", "provider");
  const src = out.data.segments?.length ? out.data.segments : [{ start: 0, end: out.data.transcription_info?.duration ?? 0, text: out.data.text }];
  const segments: Segment[] = [];
  for (const s of src) {
    const text = (s.text ?? "").trim();
    if (!text) continue;
    const start_ms = Math.round((s.start ?? 0) * 1000);
    const end_ms = Math.max(start_ms, Math.round((s.end ?? s.start ?? 0) * 1000));
    // Over-long segments are split; the split parts share the timestamps.
    for (let i = 0; i < text.length; i += MAX_SEGMENT_CHARS) {
      segments.push({ idx: segments.length, start_ms, end_ms, text: text.slice(i, i + MAX_SEGMENT_CHARS) });
    }
  }
  if (segments.length > MAX_SEGMENTS) throw new TranscribeError("consult too long", "too_long");
  const last = segments[segments.length - 1];
  const seconds = Math.ceil(out.data.transcription_info?.duration ?? (last ? last.end_ms / 1000 : 0));
  return { segments, seconds };
}
