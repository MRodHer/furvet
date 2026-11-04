// Doctor-only routes of the delivery step (mounted under /api/v1/consults, behind doctorAuth):
//   POST /:id/bill-preview  — lines with catalog prices, no writes
//   POST /:id/images        — report images (signature-sniffed, metadata stripped, R2)
//   POST /:id/approve       — ONE approval per consult: bill snapshot + rx to the chat (always)
//                             + balance order (if any) + PDFs in R2, all in one D1 batch
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
import { plainExplanation } from "../reports/explain";
import { buildPdf } from "../reports/pdf";
import { leafSource, leafValue, prescriptionLines, reportBlocks, rxBlocks, urgentLines, type ReportHeader } from "../reports/render";

const CONSULT_SKU = "CONSULTA-GENERAL";
const MAX_BODY_BYTES = 256 * 1024;

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
    const billed = new Set(wanted.map((w) => w.catalogItemId));
    for (const m of body.prescription) if (m.catalog_item_id && !billed.has(m.catalog_item_id)) wanted.push({ catalogItemId: m.catalog_item_id, quantity: 1, source: src(m.medicamento) });
    for (const vx of body.vaccines) if (vx.catalog_item_id && !billed.has(vx.catalog_item_id)) wanted.push({ catalogItemId: vx.catalog_item_id, quantity: 1, source: src(vx.vacuna) });
    const consultItem = await c.env.DB.prepare("SELECT id, name, price_cents, active FROM catalog_items WHERE sku = ?1 AND active = 1").bind(CONSULT_SKU).first<CatalogRow>();
    if (!consultItem) return { error: "catalog has no consultation item", status: 503 as const };
    wanted.unshift({ catalogItemId: consultItem.id, quantity: 1, source: "doctor_added" });

    const ids = [...new Set(wanted.map((w) => w.catalogItemId))];
    const { results: catalog } = await c.env.DB.prepare(`SELECT id, name, price_cents, active FROM catalog_items WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...ids)
      .all<CatalogRow>();
    const deposit = await currentCharge(c.env.DB, "appointment_id", consult.appointment_id);
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

  app.post("/:id/approve", async (c) => {
    const env = c.env;
    const consult = await loadConsult(env, c.req.param("id"));
    if (!consult) return c.json({ error: "not found" }, 404);
    if (await billExists(env, consult.id)) return c.json({ error: "already approved" }, 409);
    const p = await prepare(c, consult);
    if ("error" in p) return c.json(p, p.status);
    const { body, bill, raw } = p;
    const paypal = paypalFor(env);
    if (bill.balanceCents > intVar(env.MAX_CHARGE_CENTS, 0)) return c.json({ error: "balance over cap" }, 422);
    if (bill.balanceCents > 0 && (!paypal || !env.PUBLIC_BASE_URL)) {
      log("charge_refused", { reason: "paypal_not_configured", consult_id: consult.id });
      return c.json({ error: "payments not configured" }, 503);
    }
    const base = env.PUBLIC_BASE_URL ?? "";
    const now = deps.now();
    const approvalId = crypto.randomUUID();
    const rx = await newToken();
    const report = await newToken();

    // Content first (slow network calls), then ONE atomic batch. A lost race leaves orphan R2
    // objects under an approval_id nobody references — harmless.
    const explanation = await plainExplanation(deps.fetch, env.ANTHROPIC_API_KEY, body, consult.id);
    const { results: imageRows } = await env.DB.prepare("SELECT r2_key, caption FROM report_images WHERE consult_id = ?1 ORDER BY position").bind(consult.id).all<{ r2_key: string; caption: string }>();
    const images: { image: CleanImage; caption: string }[] = [];
    for (const row of imageRows) {
      const obj = await env.FILES.get(row.r2_key);
      if (obj) images.push({ image: cleanImage(new Uint8Array(await obj.arrayBuffer())), caption: row.caption });
    }
    const header: ReportHeader = { explanationByAi: explanation.source === "ai", clinicName: env.CLINIC_NAME, doctorName: env.DOCTOR_DISPLAY_NAME, licenseLabel: env.DOCTOR_LICENSE_LABEL, petName: consult.pet_name, approvedAt: now.toISOString() };
    await Promise.all([
      env.FILES.put(`reports/${approvalId}/rx.pdf`, buildPdf(rxBlocks(body, header)), { httpMetadata: { contentType: "application/pdf" } }),
      env.FILES.put(`reports/${approvalId}/report.pdf`, buildPdf(reportBlocks(body, header, explanation.text, images)), { httpMetadata: { contentType: "application/pdf" } }),
    ]);

    let order: { orderId: string; approveUrl: string; raw: unknown } | null = null;
    // Deterministic, like PayPal-Request-Id: a retry gets the SAME order back from PayPal with the
    // same custom_id, so the ledger row and the order always agree (a random id would orphan the order).
    const chargeId = `balance-${consult.id}`;
    if (bill.balanceCents > 0 && paypal) {
      order = await paypal.createOrder({
        amountCents: bill.balanceCents,
        currency: env.CURRENCY,
        customId: chargeId,
        requestId: `balance-${consult.id}`,
        description: `Saldo de consulta veterinaria (${consult.pet_name})`.slice(0, 127),
        returnUrl: `${base}/paypal-return.html`,
        cancelUrl: `${base}/paypal-cancel.html`,
        items: bill.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitCents: l.unitPriceCents })),
        discountCents: bill.depositCents,
      });
    }

    const rxText = [
      `Receta de ${consult.pet_name} (aprobada por el médico):`,
      ...prescriptionLines(body),
      ...(urgentLines(body).length ? ["", "INDICACIONES URGENTES:", ...urgentLines(body).map((u) => `• ${u}`)] : []),
      "",
      `Receta en PDF: ${base}/rx/${rx.token}`,
      bill.balanceCents > 0
        ? `Informe completo: ${base}/r/${report.token} (se libera al confirmarse el pago del saldo ${formatCents(bill.balanceCents, env.CURRENCY)}${order ? `: ${order.approveUrl}` : ""})`
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
      db.prepare("INSERT INTO consult_bills (consult_id, approval_id, total_cents, deposit_cents, balance_cents, approved_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING").bind(
        consult.id,
        approvalId,
        bill.totalCents,
        bill.depositCents,
        bill.balanceCents,
        env.DOCTOR_DEMO_USER ?? "doctor",
      ),
      ...bill.lines.map((l) =>
        db
          .prepare(`INSERT INTO bill_lines (consult_id, catalog_item_id, name, quantity, unit_price_cents, line_total_cents, source) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${guard(8)}`)
          .bind(consult.id, l.catalogItemId, l.name, l.quantity, l.unitPriceCents, l.lineTotalCents, l.source, approvalId),
      ),
      tokenInsert(db, rx.hash, consult.id, "rx", now, guard(5), approvalId),
      tokenInsert(db, report.hash, consult.id, "report", now, guard(5), approvalId),
      ...messageInserts(db, consult.conversation_id, rxText, guard(3), approvalId),
      // balance 0 = the report is released right away, so the consult is already delivered.
      db.prepare(`UPDATE consults SET status = ?3 WHERE id = ?1 AND status NOT IN ('approved', 'delivered') AND ${guard(2)}`).bind(consult.id, approvalId, bill.balanceCents > 0 ? "approved" : "delivered"),
    ];
    if (order) {
      stmts.push(
        ...claimChargeStatements(
          db,
          { id: chargeId, kind: "balance", consultId: consult.id, conversationId: consult.conversation_id, paypalOrderId: order.orderId, paypalRequestId: `balance-${consult.id}`, amountCents: bill.balanceCents, currency: env.CURRENCY, approveUrl: order.approveUrl },
          order.raw,
          guard(11),
          approvalId,
        ),
      );
    }
    let results: D1Result[];
    try {
      results = await db.batch(stmts);
    } catch (e) {
      log("approve_failed", { consult_id: consult.id, error: errName(e) });
      throw e;
    }
    if ((results[1]?.meta.changes ?? 0) !== 1) return c.json({ error: "already approved" }, 409);
    if (order && (results[stmts.length - 2]?.meta.changes ?? 0) !== 1) {
      // The bill and the rx are committed; a balance without its ledger row must be loud, never silent.
      log("balance_charge_not_recorded", { consult_id: consult.id, charge_id: chargeId });
      throw new Error("balance charge not recorded");
    }
    log("consult_approved", { consult_id: consult.id, total_cents: bill.totalCents, deposit_cents: bill.depositCents, balance_cents: bill.balanceCents, lines: bill.lines.length, explanation: explanation.source });
    return c.json(
      { approval_id: approvalId, ...billJson(bill, env.CURRENCY), approve_url: order?.approveUrl ?? null, rx_url: `${base}/rx/${rx.token}`, report_url: `${base}/r/${report.token}`, explanation: explanation.text, explanation_source: explanation.source },
      201,
    );
  });

  return app;
}
