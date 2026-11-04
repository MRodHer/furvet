// Owner-facing links: GET /rx/:token and GET /t/:token (the account ticket, same token, never gated) and GET /r/:token (402 until the balance
// is `captured` in the ledger view, or balance == 0). Token: 256 bits, looked up by sha256;
// unknown / expired / wrong kind / missing file → the same 404. Nothing here is cacheable,
// indexable or referable. Per-IP rate limiting is a WAF rule (README), like the webhook.
import { Hono } from "hono";
import { lookupToken } from "../delivery";
import type { Deps, Env } from "../env";
import { currentCharge } from "../ledger";
import { log } from "../log";
import { formatCents } from "../money";

const PRIVATE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function reportRoutes(deps: Deps) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/rx/*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(PRIVATE)) c.header(k, v);
  });
  app.use("/t/*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(PRIVATE)) c.header(k, v);
  });
  app.use("/r/*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(PRIVATE)) c.header(k, v);
  });

  const notFound = (c: { text: (t: string, s: 404) => Response }, reason: string) => {
    log("delivery_token_rejected", { reason });
    return c.text("No encontrado", 404);
  };

  async function servePdf(env: Env, consultId: string, file: "rx" | "report" | "ticket") {
    const bill = await env.DB.prepare("SELECT approval_id FROM consult_bills WHERE consult_id = ?1").bind(consultId).first<{ approval_id: string }>();
    const obj = bill ? await env.FILES.get(`reports/${bill.approval_id}/${file}.pdf`) : null;
    if (!obj) return null;
    return new Response(obj.body, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${file}.pdf"`, ...PRIVATE } });
  }

  app.get("/rx/:token", async (c) => {
    const t = await lookupToken(c.env.DB, c.req.param("token"), "rx", deps.now());
    if (!t) return notFound(c, "unknown");
    return (await servePdf(c.env, t.consult_id, "rx")) ?? notFound(c, "no_file");
  });

  // The ticket travels with the rx token: same recipient, same expiry, same (absent) gate.
  app.get("/t/:token", async (c) => {
    const t = await lookupToken(c.env.DB, c.req.param("token"), "rx", deps.now());
    if (!t) return notFound(c, "unknown");
    return (await servePdf(c.env, t.consult_id, "ticket")) ?? notFound(c, "no_file");
  });

  app.get("/r/:token", async (c) => {
    const t = await lookupToken(c.env.DB, c.req.param("token"), "report", deps.now());
    if (!t) return notFound(c, "unknown");
    const bill = await c.env.DB.prepare("SELECT balance_cents FROM consult_bills WHERE consult_id = ?1").bind(t.consult_id).first<{ balance_cents: number }>();
    if (!bill) return notFound(c, "no_bill");
    if (bill.balance_cents > 0) {
      // The gate reads the ledger view, never a flag someone could flip.
      const charge = await currentCharge(c.env.DB, "consult_id", t.consult_id);
      if (charge?.status !== "captured") {
        log("report_gate_denied", { consult_id: t.consult_id, charge_status: charge?.status ?? "none" });
        const pay = charge?.approve_url && /^https:\/\/www\.sandbox\.paypal\.com\//.test(charge.approve_url) ? charge.approve_url : null;
        const amount = charge ? formatCents(charge.amount_cents, charge.currency) : "";
        return c.html(
          `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="robots" content="noindex"><title>Informe pendiente</title></head><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">
<h1>Su receta ya está en el chat</h1><p>El informe completo se libera al confirmarse el pago del saldo${amount ? ` (${escapeHtml(amount)})` : ""}.</p>
${pay ? `<p><a href="${escapeHtml(pay)}" rel="noreferrer">Pagar el saldo con PayPal</a></p>` : ""}</body></html>`,
          402,
        );
      }
    }
    return (await servePdf(c.env, t.consult_id, "report")) ?? notFound(c, "no_file");
  });

  return app;
}
