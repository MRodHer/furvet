import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { DEFAULT_DEPS, type Deps, type Env } from "./env";
import { makePayPal, type PayPalClient } from "./paypal";
import { doctorAuth } from "./auth";
import { approveRoutes } from "./routes/approve";
import { chargesRoutes } from "./routes/charges";
import { consultsRoutes } from "./routes/consults";
import { reportRoutes } from "./routes/report";
import { simRoutes } from "./routes/sim";
import { subscriptionRoutes } from "./routes/subscription";
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
  // One header set for EVERY response, Hono routes and static assets alike (see notFound below). The CSP
  // header is the union of what the pages need; each page's <meta> CSP keeps its own tighter policy.
  app.use(
    "*",
    secureHeaders({
      xFrameOptions: "DENY",
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"], // AG Grid's Quartz theme ships its icon font and icons as data: URIs
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        formAction: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

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
  app.route("/api/v1/subscription", subscriptionRoutes(deps, paypalFor));
  app.route("/api/v1/sim", simRoutes(deps, paypalFor));
  app.route("/api/v1/consults", consultsRoutes(deps));
  app.route("/api/v1/consults", approveRoutes(deps, paypalFor));
  app.route("/", reportRoutes(deps));

  // Static assets are served through the Worker (wrangler.toml: run_worker_first = true) so secureHeaders
  // applies to them; the doctor console and the ledger board only behind the doctor's credential.
  const serveAsset = async (env: Env, req: Request) => {
    const asset = await env.ASSETS.fetch(req);
    return new Response(asset.body, asset); // a mutable copy: the asset response's headers are read-only and secureHeaders sets its own
  };
  const page = (file: string) => (c: { env: Env; req: { url: string } }) => serveAsset(c.env, new Request(new URL(file, c.req.url)));
  app.get("/console", doctorAuth(), page("/console.html"));
  app.get("/cobros", doctorAuth(), page("/cobros.html"));
  app.get("/cobros.html", doctorAuth(), page("/cobros.html"));
  app.notFound((c) => (c.req.method === "GET" || c.req.method === "HEAD" ? serveAsset(c.env, c.req.raw) : c.text("404 Not Found", 404)));

  app.onError((err, c) => {
    // Middleware-raised responses (e.g. the 401 of basicAuth) are answers, not failures.
    if (err instanceof HTTPException) return err.getResponse();
    // routePath, never the concrete path: /r/:token and /t/:token carry secrets.
    console.log(JSON.stringify({ event: "unhandled_error", error: err.name, route: c.req.routePath }));
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
