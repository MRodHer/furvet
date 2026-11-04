// Approved consult → PDF blocks. Pure text; every value comes from the approved JSON.
import type { Bill } from "../billing";
import type { ApprovedConsult } from "../clinical/schema";
import type { CleanImage } from "../images";
import { formatCents } from "../money";
import type { Block } from "./pdf";

export interface ReportHeader {
  /** Shown in the footer when the plain-language text came from the model, not the doctor. */
  explanationByAi?: boolean;
  clinicName: string;
  doctorName: string;
  licenseLabel: string;
  petName: string;
  species: string;
  /** Short printable folio derived from the random approval id (never sequential, never guessable). */
  folio: string;
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
    { kind: "small", text: `${h.doctorName} · ${h.licenseLabel} · Folio ${h.folio} · ${h.approvedAt.slice(0, 10)}` },
    { kind: "small", text: `Paciente: ${h.petName} (${h.species})` },
  ];
}

function footer(h: ReportHeader): Block[] {
  const ai = h.explanationByAi ? " La sección «En palabras sencillas» fue redactada automáticamente a partir del contenido aprobado." : "";
  return [{ kind: "small", text: `Contenido clínico revisado y aprobado por el médico el ${h.approvedAt.slice(0, 10)}, con asistencia de IA.${ai} No sustituye la atención presencial.` }];
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

/** Rx-only details: the owner's name is printed HERE and nowhere else (ticket, report, chat, logs never carry it). */
export interface RxDetails {
  ownerName: string;
  breed: string | null;
  sex: string | null;
  birthDate: string | null; // ISO date
  clinicAddress?: string;
  clinicPhone?: string;
  clinicEmail?: string;
}

const BLANK = "____________________";
/** «3 años» / «8 meses» from an ISO birth date at the approval date; null when unknown or not yet born. */
export function ageLabel(birthDate: string | null, at: string): string | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}/.test(birthDate)) return null;
  const b = new Date(birthDate.slice(0, 10));
  const a = new Date(at.slice(0, 10));
  if (Number.isNaN(b.getTime()) || b > a) return null;
  let months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + a.getUTCMonth() - b.getUTCMonth();
  if (a.getUTCDate() < b.getUTCDate()) months -= 1;
  return months >= 12 ? `${Math.floor(months / 12)} años` : `${months} meses`;
}

/** Printable A4 rx (common vet layout): clinic letterhead, owner and patient (blank line when unknown), one
 *  medication per block, review date and signature lines to fill by hand. Never gated. */
export function rxBlocks(body: ApprovedConsult, h: ReportHeader, d: RxDetails): Block[] {
  const field = (label: string, value: string | null | undefined) => `${label}: ${value || BLANK}`;
  const peso = v(body.vitals.peso);
  const out: Block[] = [
    ...header(h, "Receta"),
    { kind: "small", text: [d.clinicAddress, d.clinicPhone, d.clinicEmail].filter(Boolean).join(" · ") },
    { kind: "p", text: field("Tutor", d.ownerName) },
    { kind: "p", text: `${field("Raza", d.breed)}   ${field("Edad", ageLabel(d.birthDate, h.approvedAt))}` },
    { kind: "p", text: `${field("Peso", peso ? `${peso} kg` : null)}   ${field("Sexo", d.sex)}` },
    { kind: "h2", text: "Medicamentos" },
  ];
  if (!body.prescription.length) out.push({ kind: "p", text: "Sin medicamentos." });
  body.prescription.forEach((m, i) => {
    const name = [v(m.medicamento), v(m.concentracion), v(m.forma_farmaceutica)].filter(Boolean).join(" ");
    const how = [v(m.dosis), v(m.frecuencia), v(m.duracion), v(m.via_administracion) ? `vía ${v(m.via_administracion)}` : null].filter(Boolean).join(" · ");
    out.push({ kind: "p", text: `${i + 1}. ${name}` });
    if (how) out.push({ kind: "small", text: `   ${how}` });
    if (v(m.indicaciones)) out.push({ kind: "small", text: `   Indicaciones: ${v(m.indicaciones)}` });
  });
  const urgent = urgentLines(body);
  if (urgent.length) out.push({ kind: "h2", text: "Indicaciones urgentes" }, ...urgent.map((text) => ({ kind: "p" as const, text: `• ${text}` })));
  const plan = v(body.plan.instrucciones_cliente);
  if (plan) out.push({ kind: "h2", text: "Observaciones" }, { kind: "p", text: plan });
  // Blank line to sign by hand. Nothing is ever embedded here.
  out.push({ kind: "p", text: " " }, { kind: "p", text: "Fecha de revisión: ____ / ____ / ________" }, { kind: "p", text: " " }, { kind: "p", text: `Firma: ______________________________   ${h.doctorName}` });
  return [...out, ...footer(h)];
}

/** The bill, one line per snapshot concept. The ONLY text source for the ticket and the chat messages. */
export function billTextLines(bill: Bill, currency: string): string[] {
  const f = (cents: number) => formatCents(cents, currency);
  return [
    ...bill.lines.map((l) => `• ${l.name} ×${l.quantity} ${f(l.unitPriceCents)} = ${f(l.lineTotalCents)}`),
    `Total: ${f(bill.totalCents)}`,
    `Anticipo capturado: -${f(bill.depositCents)}`,
    bill.balanceCents > 0 ? `Saldo pendiente: ${f(bill.balanceCents)}` : "Sin saldo pendiente",
  ];
}

/** Account ticket from the approved snapshot (never today's prices). No payer data, no provider ids. */
export function ticketBlocks(h: ReportHeader, bill: Bill, currency: string): Block[] {
  return [...header(h, "Cuenta de la consulta"), { kind: "h2", text: "Conceptos" }, ...billTextLines(bill, currency).map((text) => ({ kind: "p" as const, text })), { kind: "small", text: `Estado: ${bill.balanceCents > 0 ? "saldo pendiente" : "sin saldo pendiente"}. Los precios incluyen impuestos y los fija la clínica; este documento no es un comprobante fiscal.` }];
}

/** Full report: SOAP, vitals, exam, vaccines, rx, plain explanation, images. */
/** `explanation` is null until the doctor releases it ("Enviar al dueño"): the section is then absent. */
export function reportBlocks(body: ApprovedConsult, h: ReportHeader, explanation: string | null, images: { image: CleanImage; caption: string }[]): Block[] {
  const out: Block[] = [...header(h, "Informe de consulta")];
  const section = (title: string, rows: [string, string | null][]) => {
    const present = rows.filter((r): r is [string, string] => r[1] !== null);
    if (present.length) out.push({ kind: "h2", text: title }, ...present.map(([k, val]) => ({ kind: "p" as const, text: `${k}: ${val}` })));
  };
  if (explanation) out.push({ kind: "h2", text: "En palabras sencillas" }, { kind: "p", text: explanation });
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
