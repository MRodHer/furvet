// Shape of what the model may propose for a consult. Every object is STRICT (an extra key
// such as `precio` or `amount` is a rejection) and there is NO price/money field anywhere:
// prices only ever come from catalog_items on the server.
// Field names port the author's earlier vet-clinical contract (Spanish clinical vocabulary).
import { z } from "zod";

export const MAX_QUOTE_CHARS = 300;
export const MAX_SEGMENT_REFS = 5;

const GroundedRefs = { segment_ids: z.array(z.number().int().min(0)).min(1).max(MAX_SEGMENT_REFS), quote: z.string().min(1).max(MAX_QUOTE_CHARS) };

/** AI leaf: value + the segments and exact quote that support it. */
const Grounded = <T extends z.ZodTypeAny>(value: T) => z.object({ value, ...GroundedRefs }).strict();

/** Approved leaf: what the doctor confirmed. `ai` keeps its evidence; `doctor` is the doctor's own entry. */
const Approved = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion("source", [
    z.object({ value, source: z.literal("ai"), ...GroundedRefs }).strict(),
    z.object({ value, source: z.literal("doctor") }).strict(),
  ]);

type Leaf = <T extends z.ZodTypeAny>(value: T) => z.ZodTypeAny;

export const Apetito = z.enum(["normal", "aumentado", "disminuido", "anorexia"]);
export const Actividad = z.enum(["normal", "aumentada", "disminuida", "letargia"]);
export const EstadoHidratacion = z.enum(["normal", "leve", "moderada", "severa"]);
export const Pronostico = z.enum(["favorable", "reservado", "grave", "malo"]);
export const ViaAdministracion = z.enum(["oral", "intramuscular", "subcutanea", "intravenosa", "topica", "oftalmica", "otica"]);
export const FormaFarmaceutica = z.enum([
  "tableta", "capsula", "suspension", "jarabe", "inyectable", "crema", "gotas_oft", "gotas_otic", "parche", "supositorio", "polvo", "solucion",
]);

export const BODY_SYSTEMS = [
  "cardiovascular", "respiratorio", "digestivo", "nervioso", "musculoesqueletico", "tegumentario",
  "oftalmologico", "urinario", "reproductivo", "linfatico", "otico",
] as const;

/** One shape, two leaf kinds (AI draft vs. approved). No price/money field exists at any level. */
function consultShape(L: Leaf) {
  const GText = L(z.string().min(1).max(2000));
  const GNum = L(z.number().finite());
  const SistemaEvaluacion = z.object({ evaluado: L(z.boolean()), normal: L(z.boolean()).optional(), hallazgos: GText.optional() }).strict();
  const Medication = z
    .object({
      medicamento: GText,
      dosis: GText.optional(),
      frecuencia: GText.optional(),
      duracion: GText.optional(),
      via_administracion: L(ViaAdministracion).optional(),
      forma_farmaceutica: L(FormaFarmaceutica).optional(),
      concentracion: GText.optional(),
      indicaciones: GText.optional(),
      catalog_item_id: z.string().optional(),
    })
    .strict();
  return z
    .object({
      subjective: z
        .object({
          motivo_consulta: GText.optional(),
          historia_propietario: GText.optional(),
          comportamiento: GText.optional(),
          apetito: L(Apetito).optional(),
          actividad: L(Actividad).optional(),
          cambios_recientes: GText.optional(),
        })
        .strict(),
      vitals: z
        .object({
          temperatura: GNum.optional(),
          frecuencia_cardiaca: GNum.optional(),
          frecuencia_respiratoria: GNum.optional(),
          peso: GNum.optional(),
          condicion_corporal: GNum.optional(),
          estado_hidratacion: L(EstadoHidratacion).optional(),
          mucosas: GText.optional(),
        })
        .strict(),
      physical_exam: z.object(Object.fromEntries(BODY_SYSTEMS.map((s) => [s, SistemaEvaluacion.optional()]))).strict(),
      assessment: z
        .object({
          sintomas: GText.optional(),
          diagnostico: GText.optional(),
          diagnostico_diferencial: z.array(GText).max(10).optional(),
          pronostico: L(Pronostico).optional(),
        })
        .strict(),
      plan: z
        .object({
          tratamiento: GText.optional(),
          instrucciones_cliente: GText.optional(),
          procedimientos_realizados: GText.optional(),
          procedimientos_recomendados: GText.optional(),
          proxima_cita: GText.optional(),
          urgent_instructions: z.array(GText).max(10).optional(),
        })
        .strict(),
      prescription: z.array(Medication).max(20),
      vaccines: z.array(z.object({ vacuna: GText, lote: GText.optional(), fecha_proxima: GText.optional(), catalog_item_id: z.string().optional() }).strict()).max(10),
      // Quantity only. Never a price.
      billable: z.array(z.object({ catalog_item_id: z.string(), quantity: GNum }).strict()).max(30),
    })
    .strict();
}

/** What the model may propose (every leaf grounded). */
export const ConsultDraft = consultShape(Grounded);
/** What the doctor approves (every leaf tagged `source`). Parsed by POST /approve. */
export const ApprovedConsult = consultShape(Approved);

export type ConsultDraft = z.infer<typeof ConsultDraft>;
export type ApprovedConsult = z.infer<typeof ApprovedConsult>;
export type GroundedField = { value: unknown; segment_ids: number[]; quote: string };

/** JSON Schema for the forced tool: derived from the Zod schema, so it cannot drift from it. */
export const FILL_CONSULT_TOOL = {
  name: "fill_consult",
  description:
    "Fill the consult record ONLY with what the transcript literally says. Every field carries the segment ids and the exact quote that supports it. Leave out anything not said. Never include prices or amounts.",
  input_schema: z.toJSONSchema(ConsultDraft) as Record<string, unknown>,
};
