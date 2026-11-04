import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { DEFAULT_DEPS, type Deps, type Env } from "./env";
import { makePayPal, type PayPalClient } from "./paypal";
import { doctorAuth } from "./auth";
import { chargesRoutes } from "./routes/charges";
import { consultsRoutes } from "./routes/consults";
import { simRoutes } from "./routes/sim";
import { webhookRoutes } from "./routes/webhook";

/** Builds the Worker app. Tests pass fake deps; production passes real fetch. */
export function createApp(deps: Deps = DEFAULT_DEPS) {
  // One PayPal client per isolate (token cache); null when secrets are absent → callers fail closed.
  let paypal: PayPalClient | null | undefined;
  const paypalFor = (env: Env): PayPalClient | null => {
    if (paypal === undefined) {
      paypal =
        env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
          ? makePayPal(deps.fetch, { clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET })
          : null;
    }
    return paypal;
  };

  const app = new Hono<{ Bindings: Env }>();
  app.use("*", secureHeaders());

  // Fail-closed: anything other than the sandbox environment refuses every request.
  app.use("*", async (c, next) => {
    if (c.env.PAYPAL_ENV !== "sandbox") return c.json({ error: "PAYPAL_ENV must be sandbox" }, 503);
    await next();
  });

  app.get("/health", async (c) => {
    const unpriced = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM catalog_items WHERE active = 1 AND price_cents = 0 AND category <> 'otro'",
    ).first<{ n: number }>();
    const catalogUnpriced = (unpriced?.n ?? 0) > 0;
    return c.json(
      {
        ok: true,
        paypal_env: c.env.PAYPAL_ENV,
        paypal_configured: paypalFor(c.env) !== null && Boolean(c.env.PAYPAL_WEBHOOK_ID),
        catalog_unpriced: catalogUnpriced,
      },
      catalogUnpriced ? 503 : 200,
    );
  });

  app.route("/api/v1/paypal/webhook", webhookRoutes(paypalFor));
  app.route("/api/v1/charges", chargesRoutes());
  app.route("/api/v1/sim", simRoutes(deps, paypalFor));
  app.route("/api/v1/consults", consultsRoutes(deps));

  // The doctor console is a static page served only behind the doctor's credential
  // (wrangler.toml: run_worker_first routes /console here instead of to the asset worker).
  app.get("/console", doctorAuth(), async (c) => {
    const page = await c.env.ASSETS.fetch(new Request(new URL("/console.html", c.req.url)));
    return new Response(page.body, page); // a mutable copy: the asset response's headers are read-only and secureHeaders sets its own
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.log(JSON.stringify({ event: "unhandled_error", error: err.name, path: new URL(c.req.url).pathname }));
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
