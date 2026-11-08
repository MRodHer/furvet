import { describe, expect, it } from "vitest";
import { checkField, incompleteMedications, numbersIn, validateGrounding } from "../src/clinical/grounding";
import { ConsultDraft } from "../src/clinical/schema";

const SEGS = [
  { idx: 0, text: "Buenas tardes, ¿qué le pasa a Firulais?", speaker: "doctor" },
  { idx: 1, text: "Desde ayer no quiere comer y está muy decaído.", speaker: "owner" },
  { idx: 2, text: "Tiene 39.5 grados de temperatura, la frecuencia cardíaca está en 120 y pesa 12,4 kilos.", speaker: "doctor" },
  { idx: 3, text: "Le vamos a dar amoxicilina 250 mg cada 12 horas durante 7 días.", speaker: "doctor" },
  { idx: 4, text: "Tiene fiebre y hay que vigilarlo.", speaker: "doctor" },
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
    // The quote must live in the CITED segments, not just anywhere in the transcript («ver frase» traceability).
    expect(checkField(g("fiebre", "tiene fiebre", [2]), segs)).toBe("quote_not_in_segments");
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

  it("M1: a prescription or vaccine leaf may anchor ONLY on doctor segments; an owner- or unknown-spoken one is discarded as quote_not_by_doctor (fail-closed)", () => {
    const segsM1 = [
      { idx: 0, text: "En casa le daba ibuprofeno 400 mg cada 8 horas.", speaker: "owner" }, // owner's history at home
      { idx: 1, text: "Le vamos a dar amoxicilina 250 mg cada 12 horas durante 7 días.", speaker: "doctor" },
      { idx: 2, text: "Aplicamos la vacuna triple felina, lote AB12.", speaker: "unknown" }, // unlabeled → not the doctor
    ];
    const draft = draftWith({
      prescription: [
        { medicamento: g("ibuprofeno", "ibuprofeno 400 mg", [0]), dosis: g("400 mg", "ibuprofeno 400 mg", [0]) }, // owner-spoken → dropped
        { medicamento: g("amoxicilina", "amoxicilina 250 mg", [1]), dosis: g("250 mg", "amoxicilina 250 mg", [1]) }, // doctor → kept
      ],
      vaccines: [{ vacuna: g("triple felina", "vacuna triple felina", [2]) }], // unknown speaker → dropped
    });
    const { body, report } = validateGrounding(draft, segsM1, new Set());
    expect(body.prescription.map((m) => (m.medicamento as { value: string }).value)).toEqual(["amoxicilina"]);
    expect(body.vaccines[0]).toEqual({}); // the only grounded field was dropped
    expect(report.discarded).toEqual(
      expect.arrayContaining([
        { path: "prescription[0].medicamento", reason: "quote_not_by_doctor", quote: "ibuprofeno 400 mg" },
        { path: "prescription[0].dosis", reason: "quote_not_by_doctor", quote: "ibuprofeno 400 mg" },
        { path: "vaccines[0].vacuna", reason: "quote_not_by_doctor", quote: "vacuna triple felina" },
      ]),
    );
    // A clean leaf under any other path (not prescription/vaccines) is unaffected by the speaker rule.
    expect(validateGrounding(draftWith({ subjective: { motivo_consulta: g("no quiere comer", "no quiere comer", [0]) } }), [{ idx: 0, text: "no quiere comer", speaker: "owner" }], new Set()).body.subjective.motivo_consulta).toBeTruthy();
  });

  it("M1b: a prescription leaf citing BOTH a doctor and an owner segment is discarded — the WHOLE citation must be the doctor's (.every, not .some)", () => {
    // The leaf is well grounded (quote in the cited segments, no numbers), so the ONLY reason it may drop
    // is the speaker rule. With a mixed citation .every(doctor) is false → dropped; a .some would keep it.
    const segsMix = [
      { idx: 0, text: "Le vamos a dar amoxicilina.", speaker: "doctor" },
      { idx: 1, text: "En casa le dábamos amoxicilina también.", speaker: "owner" },
    ];
    const draft = draftWith({ prescription: [{ medicamento: g("amoxicilina", "amoxicilina", [0, 1]) }] });
    const { body, report } = validateGrounding(draft, segsMix, new Set());
    expect(body.prescription).toHaveLength(0); // not every cited segment is the doctor's → the leaf is dropped
    expect(report.discarded).toContainEqual({ path: "prescription[0].medicamento", reason: "quote_not_by_doctor", quote: "amoxicilina" });
  });

  it("V6: a medication needs a quantity + unit in the dose, and a number + unit in frequency and duration", () => {
    const complete = { medicamento: g("amoxicilina", "amoxicilina", [3]), dosis: g("250 mg", "250 mg", [3]), frecuencia: g("cada 12 horas", "cada 12 horas", [3]), duracion: g("7 días", "7 días", [3]) };
    expect(incompleteMedications({ prescription: [complete] })).toEqual([]);
    expect(incompleteMedications({ prescription: [{ ...complete, dosis: g("un poquito", "un poquito", [3]) }] })).toEqual([{ index: 0, missing: ["dosis"] }]);
    expect(incompleteMedications({ prescription: [{ ...complete, frecuencia: g("12", "12", [3]) }] })).toEqual([{ index: 0, missing: ["frecuencia"] }]);
    expect(incompleteMedications({ prescription: [{ ...complete, duracion: undefined }] })).toEqual([{ index: 0, missing: ["duracion"] }]);
  });

  it("V6-b: the per-take amount accepts fractions and number words (media = ½ = 0.5 = 1/2, un cuarto = ¼, una … diez), each with a unit; a non-quantity word or a bare unit stays incomplete (fail-closed)", () => {
    const complete = { medicamento: g("Clindamicina", "Clindamicina", [3]), frecuencia: g("cada 12 horas", "cada 12 horas", [3]), duracion: g("7 días", "7 días", [3]) };
    const good = [
      "250 mg", "250 miligramos", "1 tableta", "2 tabletas", "una tableta", "un comprimido", "dos cápsulas", "5 mililitros", "dos gotas",
      "media tableta", "medio comprimido", "la mitad de una tableta", "un cuarto de tableta", "cuartito de tableta", "un octavo de tableta",
      "tres cuartos de tableta", "una y media tabletas", "un tercio de tableta", "1/2 tableta", "0.5 tableta", "½ tableta", "¼ comprimido", "1 1/2 tabletas",
    ];
    for (const d of good) expect(incompleteMedications({ prescription: [{ ...complete, dosis: g(d, d, [3]) }] }), d).toEqual([]);
    // A numeral counts ONLY next to the unit: a vague object in between is not a quantity (fail-closed). Plus the
    // earlier bad cases, and «medianamente tableta» (pins the \b: «media» inside a longer word is not a fraction word).
    const bad = [
      "un poquito de tableta", "un pedazo de la tableta", "una parte de la tableta", "un chorrito de mililitros", "una dosis alta de tabletas",
      "un poquito", "bastante", "una dosis alta", "lo normal", "medianamente tableta", "tableta", "250", "miligramos", "miligramos cada doce horas", "250 miligramitos",
    ];
    for (const d of bad) expect(incompleteMedications({ prescription: [{ ...complete, dosis: g(d, d, [3]) }] }), d).toEqual([{ index: 0, missing: ["dosis"] }]);
  });

  it("the schema has no price field and rejects one at any level (strict)", () => {
    const base = { subjective: {}, vitals: {}, physical_exam: {}, assessment: {}, plan: {}, prescription: [], vaccines: [], billable: [] };
    expect(ConsultDraft.safeParse({ ...base, precio: 100 }).success).toBe(false);
    expect(ConsultDraft.safeParse({ ...base, billable: [{ catalog_item_id: "x", quantity: g(1, "1"), amount: 100 }] }).success).toBe(false);
    expect(ConsultDraft.safeParse({ ...base, prescription: [{ medicamento: g("a", "a"), precio: 1 }] }).success).toBe(false);
    expect(JSON.stringify(ConsultDraft.shape)).not.toMatch(/precio|amount|price|monto/i);
  });
});
