// Declared by hand on purpose: `wrangler types` is run with --include-env=false so the
// type never depends on a developer's local .dev.vars (secrets must stay optional —
// every consumer fails closed when one is absent). Keep in sync with wrangler.toml.
export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  // [vars] in wrangler.toml
  PAYPAL_ENV: string;
  CURRENCY: string;
  MAX_CHARGE_CENTS: string;
  BOT_ENABLED: string;
  SIM_DAILY_MESSAGE_CAP: string;
  CLINIC_NAME: string;
  MAX_AUDIO_BYTES: string;
  AUDIO_DAILY_SECONDS_CAP: string;
  DOCTOR_DISPLAY_NAME: string;
  DOCTOR_LICENSE_LABEL: string;
  // secrets (wrangler secret put)
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
