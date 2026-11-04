// Tools the owner-facing agent may call. Every input is parsed with a STRICT Zod
// schema (an extra key such as `amount` is a rejection). No tool accepts money:
// the deposit amount is read from the catalog on the server.
import { formatClinicTime } from "../time";
import { z } from "zod";
import type { Deps, Env } from "../env";
import { intVar } from "../env";
import { claimCharge, currentCharge } from "../ledger";
import { formatCents } from "../money";
import type { PayPalClient } from "../paypal";
import { errName, log } from "../log";
import type { ToolDef } from "./claude";

export const DEPOSIT_SKU = "ANTICIPO-CONSULTA";
export const OWNER_CONSENT_VERSION = "v1-2026-11-04";

export const TOOLS: ToolDef[] = [
  {
    name: "list_slots",
    description: "List the next available appointment slots. Use before booking.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "book_appointment",
    description: "Book one of the listed slots for the owner's pet. Returns the appointment id.",
    input_schema: {
      type: "object",
      properties: {
        slot_id: { type: "string", description: "slot id from list_slots" },
        pet_name: { type: "string", maxLength: 60 },
        species: { type: "string", enum: ["perro", "gato"] },
      },
      required: ["slot_id", "pet_name", "species"],
      additionalProperties: false,
    },
  },
  {
    name: "create_deposit",
    description: "Create the PayPal link for the consult deposit of an appointment booked in this chat. The amount is fixed by the clinic; only the appointment id is accepted.",
    input_schema: {
      type: "object",
      properties: { appointment_id: { type: "string" } },
      required: ["appointment_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_prices",
    description: "Look up the clinic price list (consult, vaccines, medications). Use whenever the owner asks about prices. Never guess a price.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 80 } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "save_contact_info",
    description: "Save the owner's name or notes as soon as they mention them.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 120 },
        email: { type: "string", maxLength: 254 },
        notes: { type: "string", maxLength: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "escalate_to_human",
    description: "Hand the chat to the clinic staff: emergencies, anything medical, complaints, or when the owner asks for a person.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", maxLength: 300 } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

const ListSlots = z.object({}).strict();
const BookAppointment = z
  .object({ slot_id: z.string().uuid(), pet_name: z.string().trim().min(1).max(60), species: z.enum(["perro", "gato"]) })
  .strict();
const CreateDeposit = z.object({ appointment_id: z.string().uuid() }).strict();
const GetPrices = z.object({ query: z.string().trim().min(1).max(80) }).strict();
const SaveContact = z
  .object({ name: z.string().trim().max(120).optional(), email: z.string().trim().email().max(254).optional(), notes: z.string().trim().max(1000).optional() })
  .strict();
const Escalate = z.object({ reason: z.string().trim().min(1).max(300) }).strict();

export interface ToolContext {
  env: Env;
  deps: Deps;
  paypal: PayPalClient | null;
  conversationId: string;
  contactId: string;
}

/** Executes one tool call; always returns text for the model (errors become plain refusals). */
export async function executeTool(ctx: ToolContext, name: string, input: unknown): Promise<string> {
  try {
    switch (name) {
      case "list_slots":
        return ListSlots.safeParse(input).success ? listSlots(ctx) : "Entrada inválida.";
      case "book_appointment": {
        const p = BookAppointment.safeParse(input);
        return p.success ? bookAppointment(ctx, p.data) : "Entrada inválida para agendar.";
      }
      case "create_deposit": {
        const p = CreateDeposit.safeParse(input);
        return p.success ? createDeposit(ctx, p.data.appointment_id) : "Entrada inválida: sólo se acepta appointment_id.";
      }
      case "get_prices": {
        const p = GetPrices.safeParse(input);
        return p.success ? getPrices(ctx, p.data.query) : "Entrada inválida.";
      }
      case "save_contact_info": {
        const p = SaveContact.safeParse(input);
        return p.success ? saveContact(ctx, p.data) : "Entrada inválida.";
      }
      case "escalate_to_human": {
        const p = Escalate.safeParse(input);
        return p.success ? escalate(ctx, p.data.reason) : "Entrada inválida.";
      }
      default:
        return "Herramienta desconocida.";
    }
  } catch (e) {
    log("tool_error", { tool: name, conversation_id: ctx.conversationId, error: errName(e) });
    return "No se pudo completar la acción. Intenta de nuevo más tarde.";
  }
}

async function listSlots(ctx: ToolContext): Promise<string> {
  const { results } = await ctx.env.DB.prepare(
    "SELECT id, starts_at FROM slots WHERE taken = 0 AND starts_at > ?1 ORDER BY starts_at LIMIT 8",
  )
    .bind(ctx.deps.now().toISOString())
    .all<{ id: string; starts_at: string }>();
  if (results.length === 0) return "No hay horarios disponibles.";
  // Clinic-local text only: the model copies it to the owner and must not re-interpret a UTC instant.
  return results.map((s, i) => `${i + 1}) ${formatClinicTime(s.starts_at)} — slot_id: ${s.id}`).join("\n");
}

async function bookAppointment(ctx: ToolContext, p: z.infer<typeof BookAppointment>): Promise<string> {
  const petId = crypto.randomUUID();
  const appointmentId = crypto.randomUUID();
  // Atomic claim: each INSERT only runs if the previous statement changed exactly one row.
  const results = await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE slots SET taken = 1 WHERE id = ?1 AND taken = 0 AND starts_at > ?2").bind(p.slot_id, ctx.deps.now().toISOString()),
    ctx.env.DB.prepare("INSERT INTO pets (id, contact_id, name, species) SELECT ?1, ?2, ?3, ?4 WHERE changes() = 1").bind(petId, ctx.contactId, p.pet_name, p.species),
    ctx.env.DB.prepare(
      "INSERT INTO appointments (id, slot_id, contact_id, pet_id, conversation_id) SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() = 1",
    ).bind(appointmentId, p.slot_id, ctx.contactId, petId, ctx.conversationId),
  ]);
  if ((results[2]?.meta.changes ?? 0) !== 1) return "Ese horario ya se ocupó. Pide la lista de horarios otra vez.";
  log("appointment_booked", { appointment_id: appointmentId, conversation_id: ctx.conversationId });
  return `Cita agendada. appointment_id: ${appointmentId}. Ahora ofrece el anticipo con create_deposit.`;
}

async function createDeposit(ctx: ToolContext, appointmentId: string): Promise<string> {
  const env = ctx.env;
  const appt = await env.DB.prepare("SELECT id, status FROM appointments WHERE id = ?1 AND conversation_id = ?2")
    .bind(appointmentId, ctx.conversationId)
    .first<{ id: string; status: string }>();
  if (!appt) return "Cita inválida.";
  const existing = await currentCharge(env.DB, "appointment_id", appt.id);
  if (existing?.approve_url) return `Liga de pago: ${existing.approve_url} · Anticipo ${formatCents(existing.amount_cents, existing.currency)}`;
  if (appt.status !== "pending_deposit") return "Esta cita ya no requiere anticipo.";

  const item = await env.DB.prepare("SELECT price_cents FROM catalog_items WHERE sku = ?1 AND active = 1").bind(DEPOSIT_SKU).first<{ price_cents: number }>();
  if (!item || item.price_cents <= 0) {
    log("charge_refused", { reason: "catalog_unpriced", appointment_id: appt.id });
    return "El anticipo no está configurado todavía; la clínica lo confirmará.";
  }
  if (item.price_cents > intVar(env.MAX_CHARGE_CENTS, 0)) {
    log("charge_refused", { reason: "over_cap", appointment_id: appt.id });
    return "No se pudo generar el cobro.";
  }
  if (!ctx.paypal || !env.PUBLIC_BASE_URL) {
    log("charge_refused", { reason: "paypal_not_configured", appointment_id: appt.id });
    return "Los pagos no están disponibles en este momento.";
  }
  // The charge id IS the appointment id: deterministic, like the PayPal-Request-Id.
  // A retry after a crash between createOrder and claimCharge gets the same order
  // back from PayPal (same request id) with a custom_id that still equals our row.
  const chargeId = appt.id;
  const order = await ctx.paypal.createOrder({
    amountCents: item.price_cents,
    currency: env.CURRENCY,
    customId: chargeId,
    requestId: `deposit-${appt.id}`,
    description: "Anticipo de consulta veterinaria",
    returnUrl: `${env.PUBLIC_BASE_URL}/paypal-return.html`,
    cancelUrl: `${env.PUBLIC_BASE_URL}/paypal-cancel.html`,
  });
  const claimed = await claimCharge(
    env.DB,
    {
      id: chargeId,
      kind: "deposit",
      appointmentId: appt.id,
      conversationId: ctx.conversationId,
      paypalOrderId: order.orderId,
      paypalRequestId: `deposit-${appt.id}`,
      amountCents: item.price_cents,
      currency: env.CURRENCY,
      approveUrl: order.approveUrl,
    },
    order.raw,
  );
  const row = claimed ? null : await currentCharge(env.DB, "appointment_id", appt.id);
  const url = claimed ? order.approveUrl : row?.approve_url;
  if (!url) return "No se pudo generar el cobro.";
  log("charge_created", { charge_id: chargeId, claimed, kind: "deposit", amount_cents: item.price_cents });
  return `Liga de pago: ${url} · Anticipo ${formatCents(item.price_cents, env.CURRENCY)}`;
}

async function getPrices(ctx: ToolContext, query: string): Promise<string> {
  const { results } = await ctx.env.DB.prepare(
    "SELECT name, price_cents, unit FROM catalog_items WHERE active = 1 AND price_cents > 0 AND name LIKE ?1 ORDER BY name LIMIT 10",
  )
    .bind(`%${query.replace(/[%_]/g, "")}%`)
    .all<{ name: string; price_cents: number; unit: string }>();
  if (results.length === 0) return "No encontré ese concepto en la lista de precios.";
  return results.map((r) => `${r.name}: ${formatCents(r.price_cents, ctx.env.CURRENCY)} por ${r.unit}`).join("\n");
}

async function saveContact(ctx: ToolContext, p: z.infer<typeof SaveContact>): Promise<string> {
  // Partial update: only the fields given, never a full-row overwrite.
  const sets: string[] = [];
  const binds: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined) {
      sets.push(`${k} = ?${binds.length + 1}`);
      binds.push(v);
    }
  }
  if (sets.length === 0) return "Nada que guardar.";
  await ctx.env.DB.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?${binds.length + 1}`)
    .bind(...binds, ctx.contactId)
    .run();
  return "Datos guardados.";
}

async function escalate(ctx: ToolContext, reason: string): Promise<string> {
  await ctx.env.DB.prepare("UPDATE conversations SET bot_escalated = 1, escalation_reason = ?1 WHERE id = ?2").bind(reason, ctx.conversationId).run();
  log("conversation_escalated", { conversation_id: ctx.conversationId });
  return "La conversación pasó al equipo de la clínica.";
}
