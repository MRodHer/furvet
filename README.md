# FurVet — the AI assistant for the vet visit

*Because every patient is someone's fur bestie.* Vets subscribe with PayPal; families pay with PayPal.

> Built for the PayPal AI Hackathon 2026. Runs 100% in PayPal **sandbox**.
> Status (Nov 4): **step 1 built and tested** — booking agent, deposit via PayPal Orders, verified + idempotent webhook, append-only ledger, chat simulator and AG Grid board. Steps 2–6 are in progress; everything below marked *planned* is not yet in the code.

**Live demo:** `<URL>` · **Video:** `<YouTube URL>`

## What it does

1. **Booking + deposit** *(built)*. A pet owner chats with an AI agent (WhatsApp in production; a web chat simulator in the demo), books a consult and pays a deposit with PayPal. The agent's tools carry **no money fields**: the deposit amount is read from the clinic catalog on the server.
2. **Consult capture** *(in progress)*. With the owner's on-screen consent, the assistant records the consult, transcribes it (Workers AI Whisper) and labels the vet's and the owner's turns. Audio is never stored.
3. **Clinical draft** *(in progress)*. Claude fills a SOAP note, vital signs, exam by body system, prescription and vaccines. Every AI-filled field is flagged and linked to the transcript sentence that supports it; a deterministic validator discards any number or dose the transcript does not literally contain. The vet reviews and approves.
4. **Balance payment** *(planned)*. Billable items are detected from the consult; **prices come from the server catalog, never from the model**. Same verified webhook and ledger as the deposit.
5. **Delivery** *(planned)*. Prescription and urgent instructions are delivered immediately, always. The full report (plain-language explanation + images chosen by the vet) is released as a PDF once payment is confirmed.
6. **Vet as customer** *(planned)*. The clinic pays for the assistant with PayPal Subscriptions.

## Architecture

Cloudflare Workers (TypeScript, Hono) · D1 (money as integer cents) · R2 (images and PDFs) · Workers AI (transcription) · Anthropic Claude · PayPal REST API (sandbox).

_Diagram TBD._

## What was built during the hackathon vs. pre-existing code

Devpost requires this disclosure. The git tag `pre-hackathon` marks the copied code; everything after it is dated hackathon work.

**Pre-existing (copied verbatim from the author's earlier, private projects):**
- `src/prior/hmac.ts` — HMAC-SHA256 and constant-time comparison helpers from a payment-webhook function.
- `src/prior/text.ts` — `normalize`, `sniffMediaType` (byte-signature media detection), base64 helpers and `wrapText` for pdf-lib, from edge-function helpers. (Both `prior` files are consumed by the consult/report steps; in step 1 they are only present.)
- The *pattern* in `src/agent/claude.ts` (forced `tool_choice` + strict schema on the tool input) and the *rules* of `src/agent/run.ts` (fail-closed guards, one place talks to Claude, silence instead of invented replies) come from the author's earlier Python WhatsApp sales agent; the TypeScript is new.
- The clinical field names and enums (SOAP sections, vitals, prescription, vaccines) follow the author's earlier vet-clinic app; no component code was copied.

**Built during the hackathon (Nov 4 onward):** everything else — the Worker, D1 schema and migrations, money/ledger modules, PayPal client, webhook, booking tools, chat simulator, board, tests and scripts.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars          # fill sandbox values locally; never commit
npx wrangler d1 migrations apply furvet --local
npx wrangler d1 execute furvet --local --file=seed.sql
# set the clinic's prices (cents, tax included); the app refuses to charge a 0-priced item:
npx wrangler d1 execute furvet --local --command "UPDATE catalog_items SET price_cents = 20000 WHERE sku = 'ANTICIPO-CONSULTA'"
npm run dev                              # http://localhost:8787/sim.html and /cobros.html
npm test                                 # static checks + 54 Vitest tests on a real local D1
```

Deploy: `npx wrangler d1 create furvet` (paste the id into `wrangler.toml`), `npx wrangler secret put` for each secret listed in `wrangler.toml`, `npm run db:migrate:remote`, `npm run deploy`. Register the webhook URL `https://<worker>/api/v1/paypal/webhook` in the PayPal sandbox app with `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`.

## Security — what is verified and why

- **Sandbox only.** The PayPal host is a constant; `PAYPAL_ENV` must be `sandbox` or every request is 503.
- **Webhook, fail-closed.** Raw body read once → size cap → all five PayPal headers required → `verify-webhook-signature` must answer `SUCCESS` (any error = reject) → only then parse. No webhook id configured = 503.
- **Idempotent, append-only ledger.** `paypal_event_id` is UNIQUE; a replay is a 200 no-op. A transient capture failure is recorded without sealing the event id and answered with 503, so PayPal retries the same event. The charge id equals the appointment id, so a retried order (same `PayPal-Request-Id`) always carries a `custom_id` that matches our row. `charges`/`charge_events` have `BEFORE UPDATE/DELETE` triggers that abort. State changes (appointment confirmed) happen in the same D1 batch as the event, only when a `captured` row landed.
- **Money.** Integer cents everywhere; PayPal values are strict two-decimal text. We capture ourselves and compare cents + currency against our own charge row: a mismatch is recorded as `amount_mismatch` and never confirms anything.
- **The model never sets a price.** Tool schemas have no money fields and reject extra keys; the deposit amount is read from the catalog; a 0-priced catalog refuses to charge and `/health` reports it.
- **Agent guards.** The bot stays silent (never invents) when a person has the chat, when state is unreadable, when the key is missing, or when the model did not finish its turn. Owner text is data, not instructions.
- **No PII in logs or on the board.** Logs carry ids, enums and error names; webhook payloads are stored without `payer`/`payment_source`; the board API never returns raw payloads.
- **Mutation control.** `scripts/mutants.sh` injects nine money/validation defects (amount, currency on both paths, signature verdict, idempotent claim, strict tool schema, consent evidence, post-model human re-check) and requires the tests to go red.
- Rate limiting per IP is configured at the Cloudflare edge (WAF rules), not in code; the app enforces a daily demo cap and a per-conversation cap.

## AI tools used

- **Anthropic Claude** — booking agent (tool use) and clinical note drafting at runtime.
- **Cloudflare Workers AI (Whisper)** — consult transcription.
- **AG Grid Community** — the ledger board (sponsor tool).
- **Claude Code** — coding assistant during development. All generated code is reviewed and tested by the author.

## License

MIT — see [LICENSE](LICENSE).
