# FurVet — the AI assistant for the vet visit

*Because every patient is someone's fur bestie.* Vets subscribe with PayPal; families pay with PayPal.

> Built for the PayPal AI Hackathon 2026. Runs 100% in PayPal **sandbox**.
> Status (Nov 4): **steps 1–3 built and tested** — booking agent, deposit via PayPal Orders, verified + idempotent webhook, append-only ledger, chat simulator, AG Grid board, two-layer recording consent, transcription (Workers AI Whisper) with speaker roles, grounded AI draft and the doctor console. Steps 4–6 are in progress; everything below marked *planned* is not yet in the code.

**Live demo:** `<URL>` · **Video:** `<YouTube URL>`

## What it does

1. **Booking + deposit** *(built)*. A pet owner chats with an AI agent (WhatsApp in production; a web chat simulator in the demo), books a consult and pays a deposit with PayPal. The agent's tools carry **no money fields**: the deposit amount is read from the clinic catalog on the server.
2. **Consult capture** *(built)*. With the owner's consent (chat button) **and** the vet's (console checkbox), the console records the consult, the Worker transcribes it with Workers AI Whisper and Claude labels the vet's and the owner's turns by content (editable). The audio is never stored: no blob column exists, and a test searches every table for the uploaded bytes.
3. **Clinical draft** *(built; approval in progress)*. Claude fills a SOAP note, vital signs, exam by body system, prescription and vaccines through a forced tool whose strict schema has **no price field**. Every AI-filled field is flagged and linked to the transcript sentence that supports it; a deterministic validator discards any quote that is not literally in the transcript, any number not present in its quote, any value outside physiological ranges, and marks a prescription incomplete until dose, frequency and duration carry a quoted number and unit. The vet reviews and approves.
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

**Built during the hackathon (Nov 4 onward):** everything else — the Worker, D1 schema and migrations, money/ledger modules, PayPal client, webhook, booking tools, chat simulator, board, doctor auth and console, transcription, speaker roles, clinical schema, grounding validator, tests and scripts.

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
- **Treatment is never withheld for payment, and never waits on PayPal.** Approving a consult writes the bill snapshot and sends the prescription + urgent instructions to the owner's chat in ONE D1 batch, without calling PayPal. The balance order is created afterwards by the doctor's «Generar cobro» button (`POST /:id/charge`, idempotent: one `balance` charge per consult, deterministic `PayPal-Request-Id` = `custom_id` = `balance-<consult_id>`, the pay link goes to the chat only when THIS request created the charge). A PayPal outage can delay the link, never the approval. The prescription is never sent to the owner: the doctor prints and signs it from the console (`GET /:id/rx.pdf`, doctor credential). `/t/<token>` (the itemized account ticket) is never gated. `/r/<token>` (full report) answers 402 until the ledger view shows the balance `captured` (or the deposit covered everything) — the gate reads `charges_current`, not a flag.
- **Nothing written by the AI reaches the owner without a second click.** The plain-language explanation is stored with the bill at approval and shown to the doctor; «Enviar al dueño» (`POST /:id/send-explanation`) releases it once (append-only `explanation_releases`, PK = consult; the chat message is chained on `changes() = 1`) and only then the report PDF gains its «En palabras sencillas» section. The doctor cannot edit it through this endpoint: what was reviewed is what goes out.
- **Prices come from the server.** The approved body carries catalog ids and quantities only (strict schema: a `precio`/`amount` key is a 422). Unit prices are copied from `catalog_items` at approval into append-only `bill_lines`; total − captured deposit = balance, in integer cents; the PayPal order lists the items with `item_total` and the deposit as `discount`.
- **Owner links.** 256-bit tokens, only their SHA-256 in D1, 30-day expiry, uniform 404, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`; tokens never appear in logs (errors log the route pattern, not the path).
- **PDFs without decoding.** Reports are plain-text PDFs written by the Worker (Helvetica/WinAnsi, images embedded as-is): pdf-lib measured 30–60 ms per report in workerd and the Workers free plan allows 10 ms CPU per request. Images are accepted by byte signature only (JPEG/PNG), capped at 2 MB and 4 per consult, and their metadata segments (EXIF/GPS, text chunks) are dropped structurally before the R2 put.
- **Plain-language explanation.** Claude receives only the approved values (no transcript, no prices); a validator rejects any number or dose absent from the approved JSON; one retry, then a fixed template without AI.
- **Audio never persists; consent in two layers.** The audio route refuses in a fixed order — no provider → 503, missing owner or vet consent → 409, over size (header **and** stream) → 413, bytes that are not webm/ogg/mp4 → 415, daily budget (reserved atomically before the provider call) → 429. Bytes stay in request memory; `PRIVACY.md` documents the provider's retention.
- **The AI can only cite, not invent.** Each proposed field carries segment ids and an exact quote; the server validator (no model) drops anything that is not a literal substring, any number absent from its quote, out-of-range vitals, and unknown catalog ids. Drafts and approvals are append-only rows.
- **Doctor console.** HTTP Basic (constant-time compare, 503 when unconfigured) in front of `/console` and every `/api/v1/consults/*` route; CSP `default-src 'self'`; all transcript text rendered with `textContent`.
- **Mutation control.** `scripts/mutants.sh` injects money/validation defects (webhook amount and currency on both paths, signature verification, ledger claim, money parser, deposit schema, consent timestamp, post-model human re-check, grounding numbers, draft schema strictness, bill arithmetic, report gate, explanation validator, image metadata, inactive catalog items) and requires the tests to go red.
- The ledger board (`/cobros`, `/api/v1/charges`) sits behind the doctor credential, like `/console`. Doctor writes carry a CSRF guard (`sameOriginWrite` in `src/auth.ts`): a request whose `Sec-Fetch-Site` is not `same-origin`/`none` or whose `Origin` differs from the request origin is refused (403), and the body must be JSON, `audio/*` or `multipart/form-data` (415 otherwise; no body needs no type). Browsers always send those headers, so a cross-site form is refused before any route runs; a client that sends neither header (curl, smoke scripts) is not a CSRF vector and only needs a valid `Content-Type`.
- Rate limiting per IP (webhook, `/r/`, `/t/`) is configured at the Cloudflare edge (WAF rules), not in code; the app enforces a daily demo cap and a per-conversation cap. A PayPal order is not a CFDI (Mexican tax invoice); prices are tax-included amounts set by the clinic.

## AI tools used

- **Anthropic Claude** — booking agent (tool use) and clinical note drafting at runtime.
- **Cloudflare Workers AI (`@cf/openai/whisper-large-v3-turbo`)** — consult transcription. Input is the audio as base64 (per Cloudflare's types and tutorial); no documented size limit, so the deploy-day smoke test measures a long recording.
- **AG Grid Community** — the ledger board (sponsor tool).
- **Claude Code** — coding assistant during development. All generated code is reviewed and tested by the author.

## License

MIT — see [LICENSE](LICENSE).
