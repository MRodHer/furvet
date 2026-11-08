// Deterministic grounding validator. Runs ALWAYS on the model output before it is stored.
// Whatever fails is DROPPED from the draft and recorded in the report with its reason —
// it is never shown pre-filled. No model, no network: pure functions.
import { normalize } from "../prior/text";
import { BODY_SYSTEMS, type ConsultDraft, type GroundedField } from "./schema";

export interface SegmentIn {
  idx: number;
  text: string;
}
export interface Discard {
  path: string;
  reason: "segment_unknown" | "quote_not_in_segments" | "number_not_quoted" | "out_of_range" | "catalog_item_unknown";
  quote?: string;
}
export interface GroundingReport {
  discarded: Discard[];
  incomplete_medications: { index: number; missing: string[] }[];
}

const NUMBER_RE = /\d+(?:[.,]\d+)?/g;
const RANGES: Record<string, [number, number]> = {
  temperatura: [30, 45],
  frecuencia_cardiaca: [20, 300],
  frecuencia_respiratoria: [5, 150],
  peso: [0.1, 120],
  condicion_corporal: [1, 9],
};
// Abbreviations and the spelled-out forms the transcriber writes («250 miligramos»); the number is still required (numbersIn).
const DOSE_UNIT_RE = /\b(mg\/kg|mg|ml|ui|mcg|g|miligramos?|mililitros?|microgramos?|gramos?|unidad(?:es)? internacional(?:es)?|gotas?|tabletas?|c[aá]psulas?|comprimidos?)\b/i;
const FREQ_RE = /\b(cada|c\/|veces|al d[ií]a|diari[oa]|horas?|hrs?|h)\b/i;
const DURATION_RE = /\b(d[ií]as?|semanas?|meses|mes|horas?)\b/i;
// Closed, small set of per-take QUANTITIES, all equivalent for validation only (never converted): a digit or
// decimal (\d covers 1, 0.5, 1/2, 1 1/2), a unicode fraction (½ ¼ ¾ ⅛ …), a fraction word (media/medio/mitad,
// cuarto(s)/cuartito, octavo(s)/octavito, tercio(s)), or a numeral up to ten (un/uno/una … diez). Anything the
// transcriber could not have meant as a count — «un poquito», «bastante», «una dosis alta» — carries no token
// here, so the dose stays incomplete (fail-closed). Shared by the validator; exported for the render if it needs it.
export const QTY_RE = /(\d|[½¼¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚]|\b(?:un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|medi[oa]|mitad|cuartos?|cuartito|octavos?|octavito|tercios?)\b)/i;

export function numbersIn(s: string): string[] {
  return (s.match(NUMBER_RE) ?? []).map((n) => String(Number(n.replace(",", "."))));
}

/** Validates ONE grounded leaf; null when it is well grounded, else the reason. */
export function checkField(
  field: GroundedField,
  segments: Map<number, string>,
  range?: [number, number],
): Discard["reason"] | null {
  const texts: string[] = [];
  for (const id of field.segment_ids) {
    const t = segments.get(id);
    if (t === undefined) return "segment_unknown";
    texts.push(t);
  }
  const quote = normalize(field.quote);
  if (!quote || !normalize(texts.join(" ")).includes(quote)) return "quote_not_in_segments";
  const quoted = new Set(numbersIn(field.quote));
  const valueText = typeof field.value === "number" ? String(field.value) : typeof field.value === "string" ? field.value : "";
  for (const n of numbersIn(valueText)) if (!quoted.has(n)) return "number_not_quoted";
  if (range && typeof field.value === "number" && (field.value < range[0] || field.value > range[1])) return "out_of_range";
  return null;
}

function isGrounded(v: unknown): v is GroundedField {
  return typeof v === "object" && v !== null && "segment_ids" in v && "quote" in v && "value" in v;
}

/**
 * Walks the draft, drops every ungrounded leaf, and reports why. `catalogIds` are the ids the
 * model was shown; any other id is removed (the item is kept, just not billable).
 */
export function validateGrounding(draft: ConsultDraft, segments: SegmentIn[], catalogIds: Set<string>): { body: ConsultDraft; report: GroundingReport } {
  const seg = new Map(segments.map((s) => [s.idx, s.text]));
  const discarded: Discard[] = [];

  const prune = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      node.forEach((item, i) => {
        const r = prune(item, `${path}[${i}]`);
        if (r !== undefined) out.push(r);
      });
      return out;
    }
    if (isGrounded(node)) {
      const leaf = path.split(/[.[]/).pop()?.replace("]", "") ?? "";
      const reason = checkField(node, seg, RANGES[leaf]);
      if (reason) {
        discarded.push({ path, reason, quote: node.quote });
        return undefined;
      }
      return node;
    }
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === "catalog_item_id") {
          if (typeof v === "string" && catalogIds.has(v)) out[k] = v;
          else if (v !== undefined) discarded.push({ path: `${path}.${k}`, reason: "catalog_item_unknown" });
          continue;
        }
        const r = prune(v, path ? `${path}.${k}` : k);
        if (r !== undefined) out[k] = r;
      }
      return out;
    }
    return node;
  };

  const body = prune(draft, "") as ConsultDraft;
  // A medication whose name was dropped is gone entirely; a billable line without a valid item or quantity is gone.
  body.prescription = body.prescription.filter((m) => m.medicamento);
  body.billable = body.billable.filter((b) => b.catalog_item_id && b.quantity);
  for (const s of BODY_SYSTEMS) if (body.physical_exam[s] && !body.physical_exam[s]?.evaluado) delete body.physical_exam[s];
  return { body, report: { discarded, incomplete_medications: incompleteMedications(body) } };
}

/**
 * A medication is complete only when dose, frequency and duration each carry a number AND a unit
 * (already grounded by validateGrounding). Incomplete ones block approval (consumed by /approve).
 */
export function incompleteMedications(body: { prescription: Record<string, unknown>[] }): { index: number; missing: string[] }[] {
  const out: { index: number; missing: string[] }[] = [];
  body.prescription.forEach((m, index) => {
    const missing: string[] = [];
    const val = (f: unknown) => (typeof f === "object" && f !== null ? (f as { value?: unknown }).value : undefined);
    const has = (f: unknown, unit: RegExp) => {
      const v = val(f);
      return typeof v === "string" && numbersIn(v).length > 0 && unit.test(v);
    };
    // The per-take amount counts when it names a quantity in ANY recognised form — a digit, a fraction, or a
    // number word (QTY_RE) — together with a dose unit. So «media tableta», «un cuarto de tableta», «1/2 tableta»
    // and «250 mg» all pass, while «un poquito» or «una dosis alta» (no unit) and «tableta» (no quantity) do not.
    // QTY_RE only VALIDATES: the rx prints the doctor's own words, never a converted number.
    const hasDose = (f: unknown) => {
      const v = val(f);
      return typeof v === "string" && QTY_RE.test(v) && DOSE_UNIT_RE.test(v);
    };
    if (!hasDose(m.dosis)) missing.push("dosis");
    if (!has(m.frecuencia, FREQ_RE)) missing.push("frecuencia");
    if (!has(m.duracion, DURATION_RE)) missing.push("duracion");
    if (missing.length) out.push({ index, missing });
  });
  return out;
}
