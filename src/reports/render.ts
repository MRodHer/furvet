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
  // An impossible date (2023-02-30) rolls over in Date: refuse it instead of inventing an age.
  if (Number.isNaN(b.getTime()) || b.toISOString().slice(0, 10) !== birthDate.slice(0, 10) || b > a) return null;
  let months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + a.getUTCMonth() - b.getUTCMonth();
  if (a.getUTCDate() < b.getUTCDate()) months -= 1;
  const n = months >= 12 ? Math.floor(months / 12) : months;
  const unit = months >= 12 ? ["año", "años"] : ["mes", "meses"];
  return `${n} ${n === 1 ? unit[0] : unit[1]}`;
}

/** Half-letter page for the rx (5.5 × 8.5 in = 396 × 612 pt): a real Mexican vet prescription size,
 *  printable on half a sheet or on letter cut in two. 36 pt (1.27 cm) margins print on any printer. */
export const RX_PAGE = { w: 396, h: 612, margin: 36 };

/** Printable half-letter rx (common Mexican vet layout): clinic + doctor letterhead, a patient/owner band,
 *  Rp/ with one numbered medication per block (name in bold, dose · frequency · duration legible below),
 *  observations, review date, signature and seal, legal footer. Three font sizes only. Never gated. */
export function rxBlocks(body: ApprovedConsult, h: ReportHeader, d: RxDetails): Block[] {
  const T = 14; // letterhead
  const B = 10.5; // body: patient data, medication name/dose, observations, signature — every number ≥ 10 pt
  const F = 8; // legal fine print
  const field = (label: string, value: string | null | undefined) => `${label}: ${value || BLANK}`;
  // 'Visitante' is the contacts.name DB default (migration 0001): the owner never gave a name → em dash, not the placeholder.
  const tutor = d.ownerName && d.ownerName !== "Visitante" ? d.ownerName : "—";
  const peso = v(body.vitals.peso);
  const out: Block[] = [
    { kind: "styled", text: h.clinicName, size: T, bold: true },
    { kind: "styled", text: `${h.doctorName} · ${h.licenseLabel}`, size: B },
  ];
  // Address on its own line, phone + email on the next: a narrow page must never split a phone number across lines.
  if (d.clinicAddress) out.push({ kind: "styled", text: d.clinicAddress, size: B });
  const contact = [d.clinicPhone, d.clinicEmail].filter(Boolean).join(" · ");
  if (contact) out.push({ kind: "styled", text: contact, size: B });
  out.push({ kind: "styled", text: `Folio ${h.folio} · ${h.approvedAt.slice(0, 10)}`, size: B });
  out.push({ kind: "rule" });
  out.push(
    { kind: "styled", text: `Paciente: ${h.petName} (${h.species})`, size: B, bold: true },
    { kind: "styled", text: `Tutor: ${tutor}`, size: B },
    { kind: "cols", left: field("Raza", d.breed), right: field("Edad", ageLabel(d.birthDate, h.approvedAt)), size: B },
    { kind: "cols", left: field("Peso", peso ? `${peso} kg` : null), right: field("Sexo", d.sex), size: B },
  );
  out.push({ kind: "rule" });
  out.push({ kind: "styled", text: "Rp/", size: B, bold: true, gap: 2 });
  if (!body.prescription.length) out.push({ kind: "styled", text: "Sin medicamentos.", size: B });
  body.prescription.forEach((m, i) => {
    const name = [v(m.medicamento), v(m.concentracion), v(m.forma_farmaceutica)].filter(Boolean).join(" ");
    const how = [v(m.dosis), v(m.frecuencia), v(m.duracion), v(m.via_administracion) ? `vía ${v(m.via_administracion)}` : null].filter(Boolean).join(" · ");
    out.push({ kind: "styled", text: `${i + 1}. ${name}`, size: B, bold: true, gap: 3 });
    if (how) out.push({ kind: "styled", text: how, size: B, indent: 4 });
    if (v(m.indicaciones)) out.push({ kind: "styled", text: `Indicaciones: ${v(m.indicaciones)}`, size: B, indent: 4 });
  });
  const urgent = urgentLines(body);
  if (urgent.length) {
    out.push({ kind: "styled", text: "Indicaciones urgentes", size: B, bold: true, gap: 4 });
    urgent.forEach((text) => out.push({ kind: "styled", text: `• ${text}`, size: B }));
  }
  const plan = v(body.plan.instrucciones_cliente);
  if (plan) out.push({ kind: "styled", text: "Observaciones", size: B, bold: true, gap: 4 }, { kind: "styled", text: plan, size: B });
  out.push({ kind: "rule" });
  // Signature and seal to fill by hand. Nothing is ever embedded here. Firma and Sello sit on their own
  // lines with open space below each (wrapText collapses runs of spaces, so a single line leaves no room to stamp).
  out.push(
    { kind: "styled", text: "Fecha de revisión: ____ / ____ / ________", size: B, gap: 2 },
    { kind: "styled", text: "Firma: ______________________________", size: B, gap: 8 },
    { kind: "styled", text: "Sello:", size: B, gap: 12 },
    { kind: "styled", text: `${h.doctorName} · ${h.licenseLabel}`, size: B, gap: 14 },
  );
  out.push({ kind: "styled", text: "Original para el médico: imprimir, firmar y entregar.", size: F, gap: 4 });
  out.push({ kind: "styled", text: `Contenido clínico revisado y aprobado por el médico el ${h.approvedAt.slice(0, 10)}, con asistencia de IA. No sustituye la atención presencial.`, size: F, gap: 2 });
  return out;
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

/** Full report: SOAP, vitals, exam, vaccines, plain explanation, images (never the rx). */
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
  // No rx section here: the prescription is printed and signed by the doctor, never delivered to the owner (ADENDA 2).
  const urgent = urgentLines(body);
  if (urgent.length) out.push({ kind: "h2", text: "Indicaciones urgentes" }, ...urgent.map((text) => ({ kind: "p" as const, text: `• ${text}` })));
  if (images.length) out.push({ kind: "h2", text: "Imágenes" }, ...images.map((im) => ({ kind: "image" as const, ...im })));
  return [...out, ...footer(h)];
}
