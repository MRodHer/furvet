// Doctor-only routes of the delivery step (mounted under /api/v1/consults, behind doctorAuth):
//   POST /:id/bill-preview  — lines with catalog prices, no writes
//   POST /:id/images        — report images (signature-sniffed, metadata stripped, R2)
//   POST /:id/approve       — ONE approval per consult: bill snapshot + rx to the chat (always,
//                             never waiting on PayPal) + PDFs in R2, all in one D1 batch
//   POST /:id/charge        — "Generar cobro": the balance order, idempotent per consult
//   POST /:id/send-explanation — "Enviar al dueño": releases the AI explanation, once
//   GET  /:id/delivery      — read model for the console
import { Hono } from "hono";
import { doctorAuth } from "../auth";
import { buildLines, computeBill, BillingError, type Bill, type BillLine, type CatalogRow } from "../billing";
import { ApprovedConsult } from "../clinical/schema";
import { incompleteMedications } from "../clinical/grounding";
import { messageInserts, newToken, tokenInsert } from "../delivery";
import { intVar, type Deps, type Env } from "../env";
import { cleanImage, ImageError, MAX_IMAGE_BYTES, type CleanImage } from "../images";
import { claimChargeStatements, currentCharge } from "../ledger";
import { errName, log } from "../log";
import { formatCents } from "../money";
import type { PayPalClient } from "../paypal";
import { MAX_EXPLANATION_CHARS, plainExplanation } from "../reports/explain";
import { buildPdf } from "../reports/pdf";
import { leafSource, leafValue, prescriptionLines, reportBlocks, rxBlocks, urgentLines, type ReportHeader } from "../reports/render";

const CONSULT_SKU = "CONSULTA-GENERAL";
const MAX_BODY_BYTES = 256 * 1024;

interface BillRow {
  approval_id: string;
  total_cents: number;
  deposit_cents: number;
  balance_cents: number;
  explanation: string;
  explanation_source: "ai" | "template";
  created_at: string;
}

interface ConsultRow {
  id: string;
  status: string;
  appointment_id: string;
  conversation_id: string;
  pet_name: string;
}

export function approveRoutes(deps: Deps, paypalFor: (env: Env) => PayPalClient | null) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", doctorAuth());

  const loadConsult = (env: Env, id: string) =>
    env.DB.prepare(
      `SELECT c.id, c.status, c.appointment_id, a.conversation_id, p.name AS pet_name
       FROM consults c JOIN appointments a ON a.id = c.appointment_id JOIN pets p ON p.id = a.pet_id WHERE c.id = ?1`,
    )
      .bind(id)
      .first<ConsultRow>();
  const billExists = async (env: Env, id: string) =>
    Boolean(await env.DB.prepare("SELECT 1 AS x FROM consult_bills WHERE consult_id = ?1").bind(id).first());

  /** Parses + prices the approved body. Returns a Response on any refusal (422/400). */
  async function prepare(c: { env: Env; req: { header: (n: string) => string | undefined; text: () => Promise<string> } }, consult: ConsultRow) {
    if (Number(c.req.header("content-length") ?? "0") > MAX_BODY_BYTES) return { error: "too large", status: 413 as const };
    const text = await c.req.text(); // the declared length is a hint; the real cap is on the bytes read
    if (text.length > MAX_BODY_BYTES) return { error: "too large", status: 413 as const };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { error: "invalid json", status: 400 as const };
    }
    const parsed = ApprovedConsult.safeParse(raw);
    if (!parsed.success) return { error: "invalid body", status: 422 as const, issues: parsed.error.issues.slice(0, 10).map((i) => i.path.join(".")) };
    const body = parsed.data;
    const incomplete = incompleteMedications(body);
    if (incomplete.length) return { error: "incomplete medication", status: 422 as const, incomplete };

    const wanted: { catalogItemId: string; quantity: number; source: BillLine["source"] }[] = [];
    const src = (leaf: unknown) => (leafSource(leaf) === "ai" ? "ai_detected" : "doctor_added");
    for (const b of body.billable) wanted.push({ catalogItemId: b.catalog_item_id, quantity: Number(leafValue(b.quantity)), source: src(b.quantity) });
    // A medication/vaccine mapped to the catalog is billed once; an explicit `billable` row wins.
    // An owner-sourced medication (bought elsewhere) is prescribed but never billed, not even via `billable`.
    const billed = new Set(wanted.map((w) => w.catalogItemId));
    const sold = new Set([...body.prescription.filter((m) => !m.owner_sourced), ...body.vaccines].map((x) => x.catalog_item_id));
    if (body.prescription.some((m) => m.owner_sourced && m.catalog_item_id && !sold.has(m.catalog_item_id) && billed.has(m.catalog_item_id))) return { error: "owner-sourced item billed", status: 422 as const };
    for (const m of body.prescription) if (m.catalog_item_id && !m.owner_sourced && !billed.has(m.catalog_item_id)) wanted.push({ catalogItemId: m.catalog_item_id, quantity: 1, source: src(m.medicamento) });
    for (const vx of body.vaccines) if (vx.catalog_item_id && !billed.has(vx.catalog_item_id)) wanted.push({ catalogItemId: vx.catalog_item_id, quantity: 1, source: src(vx.vacuna) });
    const consultItem = await c.env.DB.prepare("SELECT id, name, price_cents, active FROM catalog_items WHERE sku = ?1 AND active = 1").bind(CONSULT_SKU).first<CatalogRow>();
    if (!consultItem) return { error: "catalog has no consultation item", status: 503 as const };
    wanted.unshift({ catalogItemId: consultItem.id, quantity: 1, source: "doctor_added" });

    // Owner-sourced ids are validated too (unknown/inactive ⇒ 422, like any client id), just never priced.
    const ownerSourced = body.prescription.flatMap((m) => (m.owner_sourced && m.catalog_item_id ? [m.catalog_item_id] : []));
    const ids = [...new Set([...wanted.map((w) => w.catalogItemId), ...ownerSourced])];
    const { results: catalog } = await c.env.DB.prepare(`SELECT id, name, price_cents, active FROM catalog_items WHERE category <> 'anticipo' AND id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...ids)
      .all<CatalogRow>();
    const deposit = await currentCharge(c.env.DB, "appointment_id", consult.appointment_id);
    if (ownerSourced.some((id) => !catalog.some((row) => row.id === id && row.active === 1))) return { error: "unknown catalog item", status: 422 as const };
    let bill: Bill;
    try {
      bill = computeBill(buildLines(wanted, catalog), deposit?.status === "captured" && deposit.currency === c.env.CURRENCY ? deposit.amount_cents : 0);
    } catch (e) {
      if (e instanceof BillingError) return { error: e.message, status: 422 as const };
      throw e;
    }
    return { body, bill, raw };
  }

  const billJson = (bill: Bill, currency: string) => ({
    lines: bill.lines.map((l) => ({ catalog_item_id: l.catalogItemId, name: l.name, quantity: l.quantity, unit_price: formatCents(l.unitPriceCents, currency), line_total_cents: l.lineTotalCents, source: l.source })),
    total_cents: bill.totalCents,
    deposit_cents: bill.depositCents,
    balance_cents: bill.balanceCents,
  });

  app.post("/:id/bill-preview", async (c) => {
    const consult = await loadConsult(c.env, c.req.param("id"));
    if (!consult) return c.json({ error: "not found" }, 404);
    const p = await prepare(c, consult);
    if ("error" in p) return c.json(p, p.status);
    return c.json(billJson(p.bill, c.env.CURRENCY));
  });

  app.post("/:id/images", async (c) => {
    const consult = await loadConsult(c.env, c.req.param("id"));
    if (!consult) return c.json({ error: "not found" }, 404);
    if (await billExists(c.env, consult.id)) return c.json({ error: "already approved" }, 409);
    if (Number(c.req.header("content-length") ?? "0") > MAX_IMAGE_BYTES + 4096) return c.json({ error: "too large" }, 413);
    const buf = await c.req.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES + 4096) return c.json({ error: "too large" }, 413);
    const form = await new Request(c.req.url, { method: "POST", headers: c.req.raw.headers, body: buf }).formData().then((f) => Object.fromEntries(f.entries()) as Record<string, unknown>, () => ({}) as Record<string, unknown>);
    const file = form.file;
    const caption = typeof form.caption === "string" ? form.caption.slice(0, 200) : "";
    if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
    let image: CleanImage;
    try {
      image = cleanImage(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      if (e instanceof ImageError) return c.json({ error: e.message }, e.status);
      throw e;
    }
    const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM report_images WHERE consult_id = ?1").bind(consult.id).first<{ n: number }>();
    const position = (n?.n ?? 0) + 1;
    if (position > 4) return c.json({ error: "max 4 images" }, 409);
    const id = crypto.randomUUID();
    const key = `images/${consult.id}/${id}`;
    await c.env.FILES.put(key, image.bytes, { httpMetadata: { contentType: image.mime } });
    try {
      await c.env.DB.prepare("INSERT INTO report_images (id, consult_id, position, r2_key, mime, bytes, caption) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
        .bind(id, consult.id, position, key, image.mime, image.bytes.length, caption)
        .run();
    } catch (e) {
      await c.env.FILES.delete(key);
      if (/UNIQUE|CHECK/.test(e instanceof Error ? e.message : "")) return c.json({ error: "max 4 images" }, 409);
      throw e;
    }
    log("report_image_stored", { consult_id: consult.id, position, bytes: image.bytes.length, mime: image.mime });
    return c.json({ id, position, mime: image.mime, bytes: image.bytes.length }, 201);
  });

  /** Renders report.pdf into R2 (explanation null until released). Same key: a re-render overwrites. */
  async function putReport(env: Env, consult: ConsultRow, approvalId: string, body: ApprovedConsult, explanation: string | null, byAi: boolean, approvedAt: string) {
    const { results: imageRows } = await env.DB.prepare("SELECT r2_key, caption FROM report_images WHERE consult_id = ?1 ORDER BY position").bind(consult.id).all<{ r2_key: string; caption: string }>();
    const images: { image: CleanImage; caption: string }[] = [];
    for (const row of imageRows) {
      const obj = await env.FILES.get(row.r2_key);
      if (obj) images.push({ image: cleanImage(new Uint8Array(await obj.arrayBuffer())), caption: row.caption });
    }
    const header: ReportHeader = { explanationByAi: byAi && explanation !== null, clinicName: env.CLINIC_NAME, doctorName: env.DOCTOR_DISPLAY_NAME, licenseLabel: env.DOCTOR_LICENSE_LABEL, petName: consult.pet_name, approvedAt };
    await env.FILES.put(`reports/${approvalId}/report.pdf`, buildPdf(reportBlocks(body, header, explanation, images)), { httpMetadata: { contentType: "application/pdf" } });
    return header;
  }

  const loadBill = (env: Env, consultId: string) =>
    env.DB.prepare("SELECT approval_id, total_cents, deposit_cents, balance_cents, explanation, explanation_source, created_at FROM consult_bills WHERE consult_id = ?1").bind(consultId).first<BillRow>();

  app.post("/:id/approve", async (c) => {
    const env = c.env;
    const consult = await loadConsult(env, c.req.param("id"));
    if (!consult) return c.json({ error: "not found" }, 404);
    if (await billExists(env, consult.id)) return c.json({ error: "already approved" }, 409);
    const p = await prepare(c, consult);
    if ("error" in p) return c.json(p, p.status);
    const { body, bill, raw } = p;
    if (bill.balanceCents > intVar(env.MAX_CHARGE_CENTS, 0)) return c.json({ error: "balance over cap" }, 422);
    // Owner links must be absolute. PayPal is NOT needed here: the approval never waits on it (M6-b).
    if (!env.PUBLIC_BASE_URL) {
      log("approve_refused", { reason: "public_base_url_missing", consult_id: consult.id });
      return c.json({ error: "delivery not configured" }, 503);
    }
    const base = env.PUBLIC_BASE_URL;
    const now = deps.now();
    const approvalId = crypto.randomUUID();
    const rx = await newToken();
    const report = await newToken();

    // Content first (slow calls), then ONE atomic batch. A lost race leaves orphan R2 objects
    // under an approval_id nobody references — harmless. The explanation is stored, not sent.
    const explanation = await plainExplanation(deps.fetch, env.ANTHROPIC_API_KEY, body, consult.id);
    // Second barrier before the column CHECK: a visible refusal, never a 500 from the batch.
    if (explanation.text.length > MAX_EXPLANATION_CHARS) return c.json({ error: "explanation too long" }, 422);
    const header = await putReport(env, consult, approvalId, body, null, explanation.source === "ai", now.toISOString());
    await env.FILES.put(`reports/${approvalId}/rx.pdf`, buildPdf(rxBlocks(body, header)), { httpMetadata: { contentType: "application/pdf" } });

    const rxText = [
      `Receta de ${consult.pet_name} (aprobada por el médico):`,
      ...prescriptionLines(body),
      ...(urgentLines(body).length ? ["", "INDICACIONES URGENTES:", ...urgentLines(body).map((u) => `• ${u}`)] : []),
      "",
      `Receta en PDF: ${base}/rx/${rx.token}`,
      bill.balanceCents > 0
        ? `Informe completo: ${base}/r/${report.token} (se libera al confirmarse el pago del saldo ${formatCents(bill.balanceCents, env.CURRENCY)}; la clínica le enviará la liga de pago)`
        : `Informe completo: ${base}/r/${report.token}`,
    ].join("\n");

    const guard = (n: number) => `EXISTS (SELECT 1 FROM consult_bills WHERE approval_id = ?${n})`;
    const db = env.DB;
    const stmts = [
      // The clinical evidence (what the doctor approved) goes to B's append-only table first.
      db.prepare(
        `INSERT INTO consult_versions (id, consult_id, kind, body, grounding, created_by)
         SELECT ?1, ?2, 'approved', ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM consult_bills WHERE consult_id = ?2) ON CONFLICT DO NOTHING`,
      ).bind(approvalId, consult.id, JSON.stringify(raw), JSON.stringify({ approved_by_doctor: true, explanation: explanation.source }), env.DOCTOR_DEMO_USER ?? "doctor"),
      db.prepare(
        "INSERT INTO consult_bills (consult_id, approval_id, total_cents, deposit_cents, balance_cents, approved_by, explanation, explanation_source) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT DO NOTHING",
      ).bind(consult.id, approvalId, bill.totalCents, bill.depositCents, bill.balanceCents, env.DOCTOR_DEMO_USER ?? "doctor", explanation.text, explanation.source),
      ...bill.lines.map((l) =>
        db
          .prepare(`INSERT INTO bill_lines (consult_id, catalog_item_id, name, quantity, unit_price_cents, line_total_cents, source) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${guard(8)}`)
          .bind(consult.id, l.catalogItemId, l.name, l.quantity, l.unitPriceCents, l.lineTotalCents, l.source, approvalId),
      ),
      tokenInsert(db, rx.hash, consult.id, "rx", now, guard(5), approvalId),
      tokenInsert(db, report.hash, consult.id, "report", now, guard(5), approvalId),
      ...messageInserts(db, consult.conversation_id, rxText, guard(4), [approvalId]),
      // balance 0 = the report is released right away, so the consult is already delivered.
      db.prepare(`UPDATE consults SET status = ?3 WHERE id = ?1 AND status NOT IN ('approved', 'delivered') AND ${guard(2)}`).bind(consult.id, approvalId, bill.balanceCents > 0 ? "approved" : "delivered"),
    ];
    let results: D1Result[];
    try {
      results = await db.batch(stmts);
    } catch (e) {
      log("approve_failed", { consult_id: consult.id, error: errName(e) });
      throw e;
    }
    if ((results[1]?.meta.changes ?? 0) !== 1) return c.json({ error: "already approved" }, 409);
    log("consult_approved", { consult_id: consult.id, total_cents: bill.totalCents, deposit_cents: bill.depositCents, balance_cents: bill.balanceCents, lines: bill.lines.length, explanation: explanation.source });
    return c.json(
      { approval_id: approvalId, ...billJson(bill, env.CURRENCY), rx_url: `${base}/rx/${rx.token}`, report_url: `${base}/r/${report.token}`, explanation: explanation.text, explanation_source: explanation.source },
      201,
    );
  });

  // "Generar cobro": the balance order, created AFTER the approval so PayPal can never block it.
  // Idempotent: one `balance` charge per consult (ledger index) with a deterministic id/Request-Id.
  app.post("/:id/charge", async (c) => {
    const env = c.env;
    const consult = await loadConsult(env, c.req.param("id"));
    if (!consult) return c.json({ error: "not found" }, 404);
    const bill = await loadBill(env, consult.id);
    if (!bill) return c.json({ error: "not approved" }, 409);
    if (bill.balance_cents === 0) return c.json({ error: "nothing to charge" }, 409);
    const existing = await currentCharge(env.DB, "consult_id", consult.id);
    if (existing) return c.json({ charge_id: existing.id, status: existing.status, approve_url: existing.approve_url, balance_cents: bill.balance_cents });
    const paypal = paypalFor(env);
    if (!paypal || !env.PUBLIC_BASE_URL) {
      log("charge_refused", { reason: "paypal_not_configured", consult_id: consult.id });
      return c.json({ error: "payments not configured" }, 503);
    }
    const { results: lines } = await env.DB.prepare("SELECT name, quantity, unit_price_cents FROM bill_lines WHERE consult_id = ?1 ORDER BY id").bind(consult.id).all<{ name: string; quantity: number; unit_price_cents: number }>();
    const chargeId = `balance-${consult.id}`;
    const order = await paypal.createOrder({
      amountCents: bill.balance_cents,
      currency: env.CURRENCY,
      customId: chargeId,
      requestId: chargeId,
      description: `Saldo de consulta veterinaria (${consult.pet_name})`.slice(0, 127),
      returnUrl: `${env.PUBLIC_BASE_URL}/paypal-return.html`,
      cancelUrl: `${env.PUBLIC_BASE_URL}/paypal-cancel.html`,
      items: lines.map((l) => ({ name: l.name, quantity: l.quantity, unitCents: l.unit_price_cents })),
      discountCents: bill.deposit_cents,
    });
    const text = `Liga para pagar el saldo de la consulta de ${consult.pet_name} (${formatCents(bill.balance_cents, env.CURRENCY)}): ${order.approveUrl}\nAl confirmarse el pago recibirá el informe completo.`;
    // claim (header → event) → message, each statement chained on "the previous one landed".
    const results = await env.DB.batch([
      ...claimChargeStatements(env.DB, { id: chargeId, kind: "balance", consultId: consult.id, conversationId: consult.conversation_id, paypalOrderId: order.orderId, paypalRequestId: chargeId, amountCents: bill.balance_cents, currency: env.CURRENCY, approveUrl: order.approveUrl }, order.raw),
      ...messageInserts(env.DB, consult.conversation_id, text, "changes() = 1"),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      const winner = await currentCharge(env.DB, "consult_id", consult.id);
      return c.json({ charge_id: winner?.id ?? chargeId, status: winner?.status ?? "created", approve_url: winner?.approve_url ?? null, balance_cents: bill.balance_cents });
    }
    log("balance_charge_created", { consult_id: consult.id, charge_id: chargeId, amount_cents: bill.balance_cents });
    return c.json({ charge_id: chargeId, status: "created", approve_url: order.approveUrl, balance_cents: bill.balance_cents }, 201);
  });

  // "Enviar al dueño": the doctor has read the plain-language explanation and releases it, once.
  app.post("/:id/send-explanation", async (c) => {
    const env = c.env;
    const consult = await loadConsult(env, c.req.param("id"));
    if (!consult) return c.json({ error: "not found" }, 404);
    const bill = await loadBill(env, consult.id);
    if (!bill) return c.json({ error: "not approved" }, 409);
    if (await env.DB.prepare("SELECT 1 AS x FROM explanation_releases WHERE consult_id = ?1").bind(consult.id).first()) return c.json({ error: "already sent" }, 409);
    const version = await env.DB.prepare("SELECT body FROM consult_versions WHERE id = ?1 AND kind = 'approved'").bind(bill.approval_id).first<{ body: string }>();
    if (!version) throw new Error("approved version missing");
    const body = ApprovedConsult.parse(JSON.parse(version.body));
    // The report now carries the explanation (same R2 key, so a race re-renders identical bytes).
    await putReport(env, consult, bill.approval_id, body, bill.explanation, bill.explanation_source === "ai", bill.created_at);
    const results = await env.DB.batch([
      env.DB.prepare("INSERT INTO explanation_releases (consult_id, released_by) VALUES (?1, ?2) ON CONFLICT DO NOTHING").bind(consult.id, env.DOCTOR_DEMO_USER ?? "doctor"),
      ...messageInserts(env.DB, consult.conversation_id, `Explicación sencilla de la consulta de ${consult.pet_name} (revisada por el médico):\n${bill.explanation}`, "changes() = 1"),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return c.json({ error: "already sent" }, 409);
    log("explanation_sent", { consult_id: consult.id, source: bill.explanation_source });
    return c.json({ sent: true }, 201);
  });

  // Read model for the console after a reload: what was approved, what is still pending.
  app.get("/:id/delivery", async (c) => {
    const consult = await loadConsult(c.env, c.req.param("id"));
    if (!consult) return c.json({ error: "not found" }, 404);
    const bill = await loadBill(c.env, consult.id);
    if (!bill) return c.json({ approved: false });
    const [sent, charge, lines] = await Promise.all([
      c.env.DB.prepare("SELECT created_at FROM explanation_releases WHERE consult_id = ?1").bind(consult.id).first<{ created_at: string }>(),
      currentCharge(c.env.DB, "consult_id", consult.id),
      c.env.DB.prepare("SELECT catalog_item_id AS catalogItemId, name, quantity, unit_price_cents AS unitPriceCents, line_total_cents AS lineTotalCents, source FROM bill_lines WHERE consult_id = ?1 ORDER BY id").bind(consult.id).all<BillLine>(),
    ]);
    return c.json({
      approved: true,
      // The snapshot lines, through the same shaper as the preview: what is shown is what was charged.
      ...billJson({ lines: lines.results, totalCents: bill.total_cents, depositCents: bill.deposit_cents, balanceCents: bill.balance_cents }, c.env.CURRENCY),
      explanation: bill.explanation,
      explanation_source: bill.explanation_source,
      explanation_sent_at: sent?.created_at ?? null,
      charge: charge ? { status: charge.status, approve_url: charge.approve_url } : null,
    });
  });

  return app;
}
