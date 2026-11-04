// PayPal REST client — sandbox host hard-coded; there is no way to point this at live.
// Endpoints [verified against developer.paypal.com, Orders v2 + Webhooks v1]:
//   POST /v1/oauth2/token
//   POST /v2/checkout/orders            (header PayPal-Request-Id = idempotency key)
//   POST /v2/checkout/orders/{id}/capture
//   POST /v1/notifications/verify-webhook-signature
import { z } from "zod";
import { centsToValue, valueToCents } from "./money";
import { errName, log } from "./log";

export const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";
const TIMEOUT_MS = 15_000;

export class PayPalError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "PayPalError";
  }
}

const TokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number() });
const OrderSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  links: z.array(z.object({ rel: z.string(), href: z.string().url() })),
});
const CaptureSchema = z.object({
  id: z.string(),
  status: z.string(),
  purchase_units: z.array(
    z.object({
      payments: z.object({
        captures: z.array(
          z.object({
            id: z.string().min(1),
            status: z.string(),
            custom_id: z.string().optional(),
            amount: z.object({ currency_code: z.string().length(3), value: z.string() }),
          }),
        ),
      }),
    }),
  ),
});
const VerifySchema = z.object({ verification_status: z.string() });

export interface OrderLine {
  name: string;
  quantity: number;
  unitCents: number;
}

export interface CreateOrderInput {
  amountCents: number;
  currency: string;
  customId: string;
  requestId: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  items?: OrderLine[];
}

export interface PayPalClient {
  createOrder(input: CreateOrderInput): Promise<{ orderId: string; approveUrl: string; raw: unknown }>;
  captureOrder(orderId: string): Promise<{
    captureId: string;
    status: string;
    customId: string | null;
    amountCents: number;
    currency: string;
    raw: unknown;
  }>;
  /** false on ANY failure: missing header, HTTP error, timeout, non-SUCCESS. */
  verifyWebhookSignature(headers: Headers, rawBody: string, webhookId: string): Promise<boolean>;
}

export const WEBHOOK_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
] as const;

export function makePayPal(
  fetchImpl: typeof fetch,
  creds: { clientId: string; clientSecret: string },
): PayPalClient {
  let cached: { token: string; expiresAt: number } | null = null;

  async function token(): Promise<string> {
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const res = await fetchImpl(`${PAYPAL_BASE}/v1/oauth2/token`, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalError("oauth failed", res.status);
    const t = TokenSchema.parse(await res.json());
    cached = { token: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
    return t.access_token;
  }

  async function call(path: string, body: unknown, requestId?: string): Promise<unknown> {
    const res = await fetchImpl(`${PAYPAL_BASE}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${await token()}`,
        "Content-Type": "application/json",
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new PayPalError(`paypal ${path} failed`, res.status);
    return res.json();
  }

  return {
    async createOrder(input) {
      const value = centsToValue(input.amountCents);
      const unit = { reference_id: "default", custom_id: input.customId, description: input.description.slice(0, 127) };
      const amount: Record<string, unknown> = { currency_code: input.currency, value };
      let items: unknown;
      if (input.items && input.items.length > 0) {
        const itemTotal = input.items.reduce((s, i) => s + i.quantity * i.unitCents, 0);
        if (itemTotal !== input.amountCents) throw new PayPalError("item_total != amount");
        amount.breakdown = { item_total: { currency_code: input.currency, value: centsToValue(itemTotal) } };
        items = input.items.map((i) => ({
          name: i.name.slice(0, 127),
          quantity: String(i.quantity),
          unit_amount: { currency_code: input.currency, value: centsToValue(i.unitCents) },
        }));
      }
      const raw = await call(
        "/v2/checkout/orders",
        {
          intent: "CAPTURE",
          purchase_units: [{ ...unit, amount, ...(items ? { items } : {}) }],
          application_context: {
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
          },
        },
        input.requestId,
      );
      const order = OrderSchema.parse(raw);
      const approve = order.links.find((l) => l.rel === "approve" || l.rel === "payer-action");
      if (!approve) throw new PayPalError("order has no approve link");
      return { orderId: order.id, approveUrl: approve.href, raw };
    },

    async captureOrder(orderId) {
      const raw = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, `capture-${orderId}`);
      const cap = CaptureSchema.parse(raw).purchase_units[0]?.payments.captures[0];
      if (!cap) throw new PayPalError("capture response has no capture");
      return {
        captureId: cap.id,
        status: cap.status,
        customId: cap.custom_id ?? null,
        amountCents: valueToCents(cap.amount.value),
        currency: cap.amount.currency_code,
        raw,
      };
    },

    async verifyWebhookSignature(headers, rawBody, webhookId) {
      try {
        const h = Object.fromEntries(WEBHOOK_HEADERS.map((k) => [k, headers.get(k)]));
        if (WEBHOOK_HEADERS.some((k) => !h[k])) return false;
        const raw = await call("/v1/notifications/verify-webhook-signature", {
          auth_algo: h["paypal-auth-algo"],
          cert_url: h["paypal-cert-url"],
          transmission_id: h["paypal-transmission-id"],
          transmission_sig: h["paypal-transmission-sig"],
          transmission_time: h["paypal-transmission-time"],
          webhook_id: webhookId,
          webhook_event: JSON.parse(rawBody),
        });
        return VerifySchema.parse(raw).verification_status === "SUCCESS";
      } catch (e) {
        log("paypal_verify_error", { error: errName(e) });
        return false;
      }
    },
  };
}
