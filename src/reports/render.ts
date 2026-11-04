// Approved consult → PDF blocks. Pure text; every value comes from the approved JSON.
import type { ApprovedConsult } from "../clinical/schema";
import type { CleanImage } from "../images";
import type { Block } from "./pdf";

export interface ReportHeader {
  clinicName: string;
  doctorName: string;
  licenseLabel: string;
  petName: string;
  approvedAt: string; // ISO
}

// B's schema types every leaf loosely (`unknown`), so leaves are read defensively here.
export function leafValue(leaf: unknown): unknown {
  return leaf && typeof leaf === "object" && "value" in leaf ? (leaf as { value: unknown }).value : undefined;
}
export function leafSource(leaf: unknown): "ai" | "doctor" {
  return leaf && typeof leaf === "object" && (leaf as { source?: unknown }).source === "ai" ? "ai" : "doctor";
}
const v = (leaf: unknown): string | null => {
  const x = leafValue(leaf);
  return x === null || x === undefined || x === "" ? null : String(x);
};

function header(h: ReportHeader, title: string): Block[] {
  return [
    { kind: "h1", text: `${h.clinicName} — ${title}` },
    { kind: "small", text: `${h.doctorName} · ${h.licenseLabel} · Paciente: ${h.petName} · ${h.approvedAt.slice(0, 10)}` },
  ];
}

function footer(h: ReportHeader): Block[] {
  return [{ kind: "small", text: `Generado con asistencia de IA y revisado/aprobado por el médico el ${h.approvedAt.slice(0, 10)}. No sustituye la atención presencial.` }];
}

export function prescriptionLines(body: ApprovedConsult): string[] {
  return body.prescription.map((m, i) => {
    const parts = [
      v(m.medicamento),
      v(m.concentracion),
      v(m.dosis),
      v(m.frecuencia),
      v(m.duracion),
      v(m.via_administracion) ? `vía ${v(m.via_administracion)}` : null,
      v(m.forma_farmaceutica),
      v(m.indicaciones),
    ].filter((x): x is string => Boolean(x));
    return `${i + 1}. ${parts.join(" · ")}`;
  });
}

export function urgentLines(body: ApprovedConsult): string[] {
  return (body.plan.urgent_instructions ?? []).map((u: unknown) => v(u)).filter((x): x is string => Boolean(x));
}

/** Rx + urgent instructions. Sent to the owner at approval, never gated. */
export function rxBlocks(body: ApprovedConsult, h: ReportHeader): Block[] {
  const out: Block[] = [...header(h, "Receta"), { kind: "h2", text: "Medicamentos" }];
  const rx = prescriptionLines(body);
  out.push(...(rx.length ? rx : ["Sin medicamentos."]).map((text) => ({ kind: "p" as const, text })));
  const urgent = urgentLines(body);
  if (urgent.length) out.push({ kind: "h2", text: "Indicaciones urgentes" }, ...urgent.map((text) => ({ kind: "p" as const, text: `• ${text}` })));
  const plan = v(body.plan.instrucciones_cliente);
  if (plan) out.push({ kind: "h2", text: "Indicaciones" }, { kind: "p", text: plan });
  return [...out, ...footer(h)];
}

/** Full report: SOAP, vitals, exam, vaccines, rx, plain explanation, images. */
export function reportBlocks(body: ApprovedConsult, h: ReportHeader, explanation: string, images: { image: CleanImage; caption: string }[]): Block[] {
  const out: Block[] = [...header(h, "Informe de consulta")];
  const section = (title: string, rows: [string, string | null][]) => {
    const present = rows.filter((r): r is [string, string] => r[1] !== null);
    if (present.length) out.push({ kind: "h2", text: title }, ...present.map(([k, val]) => ({ kind: "p" as const, text: `${k}: ${val}` })));
  };
  out.push({ kind: "h2", text: "En palabras sencillas" }, { kind: "p", text: explanation });
  const s = body.subjective;
  section("Motivo e historia", [
    ["Motivo", v(s.motivo_consulta)],
    ["Historia", v(s.historia_propietario)],
    ["Comportamiento", v(s.comportamiento)],
    ["Apetito", v(s.apetito)],
    ["Actividad", v(s.actividad)],
    ["Cambios recientes", v(s.cambios_recientes)],
  ]);
  const vt = body.vitals;
  section("Signos vitales", [
    ["Temperatura (°C)", v(vt.temperatura)],
    ["Frecuencia cardiaca (lpm)", v(vt.frecuencia_cardiaca)],
    ["Frecuencia respiratoria (rpm)", v(vt.frecuencia_respiratoria)],
    ["Peso (kg)", v(vt.peso)],
    ["Condición corporal (1-9)", v(vt.condicion_corporal)],
    ["Hidratación", v(vt.estado_hidratacion)],
    ["Mucosas", v(vt.mucosas)],
  ]);
  section(
    "Examen físico por sistemas",
    Object.entries(body.physical_exam).map(([sys, e]) => {
      if (!e || v(e.evaluado) !== "true") return [sys, null];
      const normal = v(e.normal);
      return [sys, [normal === "true" ? "normal" : normal === "false" ? "anormal" : null, v(e.hallazgos)].filter(Boolean).join(" — ") || "evaluado"];
    }),
  );
  const a = body.assessment;
  section("Evaluación", [
    ["Síntomas", v(a.sintomas)],
    ["Diagnóstico", v(a.diagnostico)],
    ["Diferenciales", a.diagnostico_diferencial?.map((d: unknown) => v(d)).filter(Boolean).join(", ") || null],
    ["Pronóstico", v(a.pronostico)],
  ]);
  const p = body.plan;
  section("Plan", [
    ["Tratamiento", v(p.tratamiento)],
    ["Procedimientos realizados", v(p.procedimientos_realizados)],
    ["Procedimientos recomendados", v(p.procedimientos_recomendados)],
    ["Próxima cita", v(p.proxima_cita)],
    ["Indicaciones", v(p.instrucciones_cliente)],
  ]);
  section("Vacunas aplicadas", body.vaccines.map((x) => [v(x.vacuna) ?? "Vacuna", [v(x.lote) ? `lote ${v(x.lote)}` : null, v(x.fecha_proxima) ? `próxima ${v(x.fecha_proxima)}` : null].filter(Boolean).join(", ") || "aplicada"]));
  const rx = prescriptionLines(body);
  if (rx.length) out.push({ kind: "h2", text: "Receta" }, ...rx.map((text) => ({ kind: "p" as const, text })));
  const urgent = urgentLines(body);
  if (urgent.length) out.push({ kind: "h2", text: "Indicaciones urgentes" }, ...urgent.map((text) => ({ kind: "p" as const, text: `• ${text}` })));
  if (images.length) out.push({ kind: "h2", text: "Imágenes" }, ...images.map((im) => ({ kind: "image" as const, ...im })));
  return [...out, ...footer(h)];
}
