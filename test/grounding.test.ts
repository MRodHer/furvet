import { describe, expect, it } from "vitest";
import { checkField, incompleteMedications, numbersIn, validateGrounding } from "../src/clinical/grounding";
import { ConsultDraft } from "../src/clinical/schema";

const SEGS = [
  { idx: 0, text: "Buenas tardes, ¿qué le pasa a Firulais?" },
  { idx: 1, text: "Desde ayer no quiere comer y está muy decaído." },
  { idx: 2, text: "Tiene 39.5 grados de temperatura, la frecuencia cardíaca está en 120 y pesa 12,4 kilos." },
  { idx: 3, text: "Le vamos a dar amoxicilina 250 mg cada 12 horas durante 7 días." },
  { idx: 4, text: "Tiene fiebre y hay que vigilarlo." },
];
const segs = new Map(SEGS.map((s) => [s.idx, s.text]));
const g = (value: unknown, quote: string, ids = [2]) => ({ value, segment_ids: ids, quote });

/** A minimal valid draft around one leaf. */
function draftWith(patch: Record<string, unknown>) {
  return ConsultDraft.parse({ subjective: {}, vitals: {}, physical_exam: {}, assessment: {}, plan: {}, prescription: [], vaccines: [], billable: [], ...patch });
}

describe("grounding validator (V4, V5, V6)", () => {
  it("numbersIn normalizes comma decimals", () => {
    expect(numbersIn("pesa 12,4 kilos y 39.5 grados, 120 lpm")).toEqual(["12.4", "39.5", "120"]);
  });

  it("V4: quote must be a literal substring of the cited segments (accents and case ignored)", () => {
    expect(checkField(g("fiebre", "TIENE FIÉBRE", [4]), segs)).toBeNull();
    expect(checkField(g("fiebre", "tiene fiebre alta", [4]), segs)).toBe("quote_not_in_segments");
    // A quote spanning two consecutive segments is fine; one citing an unknown segment is not.
    expect(checkField(g("decaído", "muy decaído. Tiene 39.5", [1, 2]), segs)).toBeNull();
    expect(checkField(g("fiebre", "tiene fiebre", [99]), segs)).toBe("segment_unknown");
    expect(checkField(g("fiebre", "tiene fiebre", [4, 99]), segs)).toBe("segment_unknown");
  });

  it("V5: numbers must appear in the quote and lie in the physiological range", () => {
    expect(checkField(g(39.5, "tiene fiebre", [4]), segs, [30, 45])).toBe("number_not_quoted");
    expect(checkField(g(39.5, "treinta y nueve y medio", [4]), segs, [30, 45])).toBe("quote_not_in_segments");
    expect(checkField(g(900, "frecuencia cardíaca está en 120", [2]), segs, [20, 300])).toBe("number_not_quoted");
    expect(checkField(g(120, "frecuencia cardíaca está en 120", [2]), segs, [20, 300])).toBeNull();
    expect(checkField(g(39.5, "39.5 grados", [2]), segs, [30, 45])).toBeNull();
    expect(checkField(g(12.4, "pesa 12,4 kilos", [2]), segs, [0.1, 120])).toBeNull();
    // Quoted but impossible → out of range.
    expect(checkField(g(12.4, "pesa 12,4 kilos", [2]), segs, [20, 300])).toBe("out_of_range");
    // Text values carry numbers too: "250 mg" with a quote that lacks the figure is rejected.
    expect(checkField(g("250 mg", "cada 12 horas", [3]), segs)).toBe("number_not_quoted");
  });

  it("validateGrounding drops the bad leaves, keeps the good ones, and reports each reason with its path", () => {
    const draft = draftWith({
      vitals: { temperatura: g(39.5, "tiene fiebre", [4]), frecuencia_cardiaca: g(120, "frecuencia cardíaca está en 120"), peso: g(12.4, "pesa 12,4 kilos") },
      subjective: { motivo_consulta: g("no quiere comer", "no quiere comer", [1]) },
      prescription: [
        { medicamento: g("amoxicilina", "amoxicilina", [3]), dosis: g("250 mg", "250 mg", [3]), catalog_item_id: "cat-amoxi" },
        { medicamento: g("ibuprofeno", "le vamos a dar ibuprofeno", [3]) },
      ],
      billable: [
        { catalog_item_id: "cat-consulta", quantity: g(1, "una consulta", [0]) },
        { catalog_item_id: "cat-nope", quantity: g(1, "Buenas tardes", [0]) },
      ],
    });
    const { body, report } = validateGrounding(draft, SEGS, new Set(["cat-amoxi", "cat-consulta"]));
    expect(body.vitals).toEqual({ frecuencia_cardiaca: g(120, "frecuencia cardíaca está en 120"), peso: g(12.4, "pesa 12,4 kilos") });
    expect((body.subjective.motivo_consulta as { value: string }).value).toBe("no quiere comer");
    expect(body.prescription).toHaveLength(1);
    expect(body.prescription[0]?.catalog_item_id).toBe("cat-amoxi");
    expect(body.billable).toHaveLength(0);
    expect(report.discarded).toEqual(
      expect.arrayContaining([
        { path: "vitals.temperatura", reason: "number_not_quoted", quote: "tiene fiebre" },
        { path: "prescription[1].medicamento", reason: "quote_not_in_segments", quote: "le vamos a dar ibuprofeno" },
        { path: "billable[0].quantity", reason: "quote_not_in_segments", quote: "una consulta" },
        { path: "billable[1].catalog_item_id", reason: "catalog_item_unknown" },
      ]),
    );
    expect(report.incomplete_medications).toEqual([{ index: 0, missing: ["frecuencia", "duracion"] }]);
  });

  it("V6: a medication needs number + unit in dose, frequency and duration", () => {
    const complete = { medicamento: g("amoxicilina", "amoxicilina", [3]), dosis: g("250 mg", "250 mg", [3]), frecuencia: g("cada 12 horas", "cada 12 horas", [3]), duracion: g("7 días", "7 días", [3]) };
    expect(incompleteMedications({ prescription: [complete] })).toEqual([]);
    expect(incompleteMedications({ prescription: [{ ...complete, dosis: g("una tableta", "amoxicilina", [3]) }] })).toEqual([{ index: 0, missing: ["dosis"] }]);
    expect(incompleteMedications({ prescription: [{ ...complete, frecuencia: g("12", "12", [3]) }] })).toEqual([{ index: 0, missing: ["frecuencia"] }]);
    expect(incompleteMedications({ prescription: [{ ...complete, duracion: undefined }] })).toEqual([{ index: 0, missing: ["duracion"] }]);
  });

  it("the schema has no price field and rejects one at any level (strict)", () => {
    const base = { subjective: {}, vitals: {}, physical_exam: {}, assessment: {}, plan: {}, prescription: [], vaccines: [], billable: [] };
    expect(ConsultDraft.safeParse({ ...base, precio: 100 }).success).toBe(false);
    expect(ConsultDraft.safeParse({ ...base, billable: [{ catalog_item_id: "x", quantity: g(1, "1"), amount: 100 }] }).success).toBe(false);
    expect(ConsultDraft.safeParse({ ...base, prescription: [{ medicamento: g("a", "a"), precio: 1 }] }).success).toBe(false);
    expect(JSON.stringify(ConsultDraft.shape)).not.toMatch(/precio|amount|price|monto/i);
  });
});
