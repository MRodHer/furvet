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
const DOSE_RE = /\d+(?:[.,]\d+)?\s*(?:mg\/kg|mg|ml|mcg|ui|g)\b/gi;
const SYSTEM = `Explicas al dueño de una mascota, en español mexicano sencillo y cálido, lo que el médico veterinario aprobó.
Recibes SOLO el JSON aprobado. Reglas estrictas: no agregues diagnósticos, medicamentos, dosis, frecuencias ni NINGÚN número que no esté textualmente en el JSON; no des consejos nuevos; máximo 180 palabras; sin listas con precios.`;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Drops `source`/`segment_ids`/`quote` so only the approved values travel. */
export function approvedValues(node: unknown): Json {
  if (Array.isArray(node)) return node.map(approvedValues);
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if ("value" in o && "source" in o) return approvedValues(o.value);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, approvedValues(v)]));
  }
  return node as Json;
}

/** Null when the text is fully backed by the JSON; else the offending tokens. */
export function explanationViolations(text: string, facts: Json): string[] | null {
  const factsText = JSON.stringify(facts);
  const allowedNumbers = new Set(numbersIn(factsText));
  const bad = numbersIn(text).filter((n) => !allowedNumbers.has(n));
  const factsNorm = factsText.toLowerCase().replace(/\s+/g, "");
  for (const dose of text.match(DOSE_RE) ?? []) {
    if (!factsNorm.includes(dose.toLowerCase().replace(/\s+/g, ""))) bad.push(dose);
  }
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
  if (plan) parts.push(`Indicaciones: ${plan}`);
  parts.push("Si tiene dudas, escríbanos por este chat.");
  return parts.join(" ");
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
      const res = await askClaude(fetchImpl, apiKey, { system: SYSTEM, messages, tools: [TOOL], toolChoice: { type: "tool", name: TOOL.name }, maxTokens: 600, temperature: 0 });
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
