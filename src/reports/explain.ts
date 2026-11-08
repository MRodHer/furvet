// Plain-language explanation for the owner. Claude sees ONLY the approved values (never the
// transcript, never prices — the schema has none). A deterministic validator rejects any number
// or dose that is not in the approved JSON; one retry, then a fixed template without AI.
import { z } from "zod";
import { askClaude } from "../agent/claude";
import type { ApprovedConsult } from "../clinical/schema";
import { numbersIn } from "../clinical/grounding";
import { errName, log } from "../log";
import { leafValue } from "./render";

const TOOL = {
  name: "plain_explanation",
  description: "Explicación en lenguaje sencillo para el dueño de la mascota.",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
};
const Out = z.object({ text: z.string().min(1).max(2000) }).strict();
// Tokens that must appear VERBATIM inside the prescription (not just "somewhere in the JSON").
// Owner-facing dose units, widened beyond mg/ml so a COUNT of pills/capsules/spoonfuls/doses the owner is
// told to give («12 pastillas», «7 comprimidos», «12 cucharadas») is also checked verbatim against the rx —
// otherwise the number alone (already somewhere in the JSON) let it pass unbacked (audit M3).
const DOSE_RE = /\d+(?:[.,]\d+)?\s*(?:mg\/kg|mg|ml|mcg|ui|g|gotas?|tabletas?|pastillas?|comprimidos?|c[aá]psulas?|cucharad(?:as?|itas?)|dosis|veces|aplicaciones?|unidades?)\b|\bcada\s+\d+\s*(?:h|horas?|d[ií]as?)\b|\b\d+\s*(?:d[ií]as?|semanas?|horas?)\b/gi;
// A cheap drug-name detector: common pharmacological suffixes. Any such word must be a prescribed medication.
const DRUG_RE = /\b[a-záéíóú]{3,}(?:cilina|micina|ciclina|azol|prazol|oxacino|profeno|sona|mectina|cam|zepam|cilinas)\b/gi;
const SYSTEM = `Explicas al dueño de una mascota, en español mexicano sencillo y cálido, lo que el médico veterinario aprobó.
Recibes SOLO el JSON aprobado. Reglas estrictas: no agregues diagnósticos, medicamentos, dosis, frecuencias ni NINGÚN número que no esté textualmente en el JSON; no des consejos nuevos; máximo 180 palabras; sin listas con precios.`;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Drops `source`/`segment_ids`/`quote` and catalog ids, so only the approved clinical values travel. */
export function approvedValues(node: unknown): Json {
  if (Array.isArray(node)) return node.map(approvedValues);
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if ("value" in o && "source" in o) return approvedValues(o.value);
    return Object.fromEntries(
      Object.entries(o)
        .filter(([k]) => k !== "catalog_item_id")
        .map(([k, v]) => [k, approvedValues(v)]),
    );
  }
  return node as Json;
}

const squash = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "");

/** Null when the text is fully backed by the JSON; else the offending tokens. */
export const MAX_EXPLANATION_CHARS = 1500;

export function explanationViolations(text: string, facts: Json): string[] | null {
  if (text.length > MAX_EXPLANATION_CHARS) return ["too_long"];
  const factsText = JSON.stringify(facts);
  const allowedNumbers = new Set(numbersIn(factsText));
  const bad = numbersIn(text).filter((n) => !allowedNumbers.has(n));
  const f = facts as { prescription?: Json[]; plan?: Json };
  const rx = f.prescription ?? [];
  // Doses/frequencies/durations must come from the prescription or the plan the doctor approved.
  const rxText = squash(JSON.stringify([rx, f.plan ?? null]));
  // Whole-token match: "50 mg" must not pass because "250 mg" exists, nor "5 mg" because of "5 mg/kg".
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  for (const tok of text.match(DOSE_RE) ?? []) if (!new RegExp(`(?<![\\d.,])${esc(squash(tok))}(?![a-z/])`).test(rxText)) bad.push(tok);
  const names = new Set(rx.map((m) => squash(String((m as { medicamento?: unknown }).medicamento ?? ""))));
  for (const word of text.match(DRUG_RE) ?? []) if (![...names].some((n) => n.includes(squash(word)))) bad.push(word);
  return bad.length ? [...new Set(bad)] : null;
}

export function templateExplanation(body: ApprovedConsult): string {
  const v = (leaf: unknown) => {
    const x = leafValue(leaf);
    return typeof x === "string" ? x : null;
  };
  const parts = ["Resumen de la consulta de su mascota, revisado y aprobado por el médico veterinario."];
  const dx = v(body.assessment.diagnostico);
  if (dx) parts.push(`Diagnóstico: ${dx}.`);
  if (body.prescription.length) {
    parts.push(
      `Tratamiento: ${body.prescription
        .map((m) => [v(m.medicamento), v(m.dosis), v(m.frecuencia), v(m.duracion)].filter(Boolean).join(", "))
        .join("; ")}.`,
    );
  }
  const plan = v(body.plan.instrucciones_cliente);
  // Approved leaves can be 2000 chars each and the stored column is bounded. Shortening never
  // cuts inside a sentence (so never inside "250 mg"): first the free-text instructions go as a
  // whole (they are in the rx anyway), then only complete sentences are kept.
  const closing = "Las indicaciones completas están en su receta. Si tiene dudas, escríbanos por este chat.";
  let text = [...parts, ...(plan ? [`Indicaciones: ${plan}`] : []), closing].join(" ");
  if (text.length > MAX_EXPLANATION_CHARS) text = [...parts, closing].join(" ");
  if (text.length > MAX_EXPLANATION_CHARS) {
    const head = parts.join(" ").slice(0, MAX_EXPLANATION_CHARS - closing.length - 1);
    text = `${head.slice(0, head.lastIndexOf(". ") + 1)} ${closing}`.trim();
  }
  // Validated AFTER shortening, like an AI text: anything unbacked falls to the neutral sentence.
  return explanationViolations(text, approvedValues(body)) ? closing : text;
}

export async function plainExplanation(
  fetchImpl: typeof fetch,
  apiKey: string | undefined,
  body: ApprovedConsult,
  consultId: string,
): Promise<{ text: string; source: "ai" | "template" }> {
  const template = { text: templateExplanation(body), source: "template" as const };
  if (!apiKey) return template;
  const facts = approvedValues(body);
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: JSON.stringify(facts) }];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text: string;
    try {
      const res = await askClaude(fetchImpl, apiKey, { system: SYSTEM, messages, tools: [TOOL], toolChoice: { type: "tool", name: TOOL.name }, maxTokens: 600 });
      const block = res.content.find((b) => b.type === "tool_use");
      const parsed = Out.safeParse(block?.type === "tool_use" ? block.input : undefined);
      if (!parsed.success) throw new Error("bad tool output");
      text = parsed.data.text;
    } catch (e) {
      log("explain_failed", { consult_id: consultId, attempt, error: errName(e) });
      return template;
    }
    const bad = explanationViolations(text, facts);
    if (!bad) return { text, source: "ai" };
    log("explain_rejected", { consult_id: consultId, attempt, violations: bad.length });
    messages.push({ role: "assistant", content: text }, { role: "user", content: `Tu texto incluyó datos que NO están en el JSON: ${bad.join(", ")}. Escríbelo de nuevo sin ellos.` });
  }
  return template;
}
