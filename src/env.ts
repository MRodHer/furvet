// Bindings and vars come from `wrangler types` (worker-configuration.d.ts, generated
// from wrangler.toml). Secrets are declared here because they never live in the toml.
export interface Env extends Cloudflare.Env {
  // secrets (wrangler secret put) — optional on purpose: every consumer fails closed when absent
  ANTHROPIC_API_KEY?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  DOCTOR_DEMO_USER?: string;
  DOCTOR_DEMO_PASSWORD?: string;
  PUBLIC_BASE_URL?: string;
}

/** External I/O the app depends on; tests inject fakes (no network, no mocking framework). */
export interface Deps {
  fetch: typeof fetch;
  now: () => Date;
}

export const DEFAULT_DEPS: Deps = { fetch: (...a) => fetch(...a), now: () => new Date() };

export function intVar(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}
