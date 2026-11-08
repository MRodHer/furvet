# FurVet — the AI assistant for the vet visit

*Because every patient is someone's fur bestie.* Families pay with PayPal; the clinic keeps the clinical record and the money honest.

> Built for the PayPal AI Hackathon 2026. Runs 100% in PayPal **sandbox**: no real money moves.
> Everything described below as *built* is in this repository, covered by the test suite (262 tests) and deployed at the live URL. The one item marked *not built* (a real WhatsApp channel) is the only part of the vision that is not in the code.

**Live demo:** <https://furvet.mauricio-rodher.workers.dev> · **Video:** <https://youtu.be/QzQe276LBy8>

## Try it (for judges)

The chat and the PayPal flow are public. The doctor's console and the ledger board require a credential, which we provide in the private testing-instructions field on Devpost (never in this repository).

1. **Chat and book** — open `/sim` (the web chat stands in for WhatsApp). Write in Spanish, for example «Hola, quiero una cita para mi perro». The bot lists the clinic's open slots in Mexico City time, asks for the pet's name, species and, in one question, breed, sex and age (it books without them if you don't know), then books the appointment and offers the deposit.
2. **Pay the deposit** — click «Pagar con PayPal (sandbox)». Log in with a **PayPal sandbox buyer account** (create one for free at <https://developer.paypal.com> → Sandbox → Accounts → Create account → Personal). Approve the payment. You are sent back to the clinic page; return to the chat tab and you will see the bot's confirmation («¡Pago recibido! {mascota} queda agendado el {fecha} a las {hora} 🐾») without reloading. The confirmation is written by the verified webhook, not by the browser.
3. **Give recording consent** — in the chat, tick the consent box and press «Registrar consentimiento». This is the owner's layer; the doctor adds the second one in the console.
4. **Ledger board** — open `/cobros` with the credential. Each row is a charge; its status is the last event verified by the PayPal webhook; select a row for its history. No payer data is shown.
5. **Doctor console** — open `/console` with the credential. Only appointments whose deposit was captured appear. Open the consult, tick the doctor's consent, record a short mock consultation (speak as the vet: weight, temperature, a diagnosis, a medication with a dose like «amoxicilina 250 miligramos, una tableta cada 12 horas por 7 días»), then stop. The audio is transcribed with Workers AI Whisper and the speaker of each line is labelled by content (click a label to flip it). The audio itself is never stored.
6. **AI draft** — it is requested automatically when the transcription finishes («Regenerar borrador con IA» asks again). Every AI-filled field carries an «IA» badge and a link to the transcript sentence that supports it. Anything the validator could not ground appears under «Descartado», never pre-filled. Press «Calcular cobro» to see the bill: consultation, medications sold and vaccines, with editable quantities and prices from the clinic's catalog. A medication can be marked «El dueño lo consigue por su cuenta»: it is prescribed but never billed.
7. **Approve** — press «Aprobar consulta». The owner's chat immediately receives the urgent instructions (and, when the deposit covered everything, the account and the report link). The prescription is **not** sent through the chat: the doctor prints it with «Imprimir receta» (PDF behind the doctor's credential) and signs it by hand.
8. **Plain-language explanation** — the console shows an explanation written for the owner from the approved values only. Nothing written by the AI reaches the owner until the doctor presses «Enviar al dueño».
9. **Balance** — press «Generar cobro». The chat receives the itemized account and a PayPal link for the balance (total minus the captured deposit). Pay it with the same sandbox buyer. The report link (`/r/<token>`) reaches the chat only when the webhook confirms the capture («¡Pago recibido! Aquí está tu informe completo: …»); before that the console's copy of the link answers «Informe pendiente».

If the demo cap is reached (300 chat messages a day, 60 per conversation) the chat answers «Límite de la demo alcanzado por hoy». `/health` reports whether PayPal is configured and whether every catalog item has a price.

## What it does

1. **Booking + deposit** *(built)*. A pet owner chats with an AI agent (a web chat simulator in the demo; a real WhatsApp channel is *not built*), books a consult and pays a deposit with PayPal Checkout. The agent's tools carry **no money fields**: the deposit amount is read from the clinic catalog on the server.
2. **Consult capture** *(built)*. With the owner's consent (chat button) **and** the vet's (console checkbox), the console records the consult, the Worker transcribes it with Workers AI Whisper and Claude labels the vet's and the owner's turns by content (editable). The audio is never stored: no blob column exists, and a test searches every table for the uploaded bytes.
3. **Clinical draft and approval** *(built)*. Claude fills a SOAP note, vital signs, exam by body system, prescription and vaccines through a forced tool whose strict schema has **no price field**. Every AI-filled field is flagged and linked to the transcript sentence that supports it; a deterministic validator discards any quote that is not literally in the transcript, any number not present in its quote, any value outside physiological ranges, and marks a prescription incomplete until dose, frequency and duration carry a quoted number and unit. The vet reviews, edits and approves once.
4. **Bill and balance payment** *(built)*. The approved body carries catalog ids and quantities only; **prices come from the server catalog, never from the model**. Total − captured deposit = balance, paid through a second PayPal order with the same verified webhook and the same append-only ledger.
5. **Delivery** *(built)*. Urgent instructions and the itemized account go to the owner the moment the vet approves, never waiting on PayPal. The prescription is printed and signed by the doctor only. The full report (with the plain-language explanation the doctor chose to release, and images chosen by the vet) is released as a PDF once the balance is captured.
6. **Vet as customer** *(built)*. The clinic pays for the AI assistant with a **PayPal Subscription** (sandbox plan, $999.00 MXN/month): the AI draft is gated on an active subscription, activated and kept current only by verified webhook events (`BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.COMPLETED`) whose amount **and** currency match the plan. Console card 0 shows the state and starts the subscription.

## Architecture

Cloudflare Workers (TypeScript, Hono, Zod) · D1 (money as integer cents, append-only tables with triggers) · R2 (report, ticket and prescription PDFs, images) · Workers AI (transcription) · Anthropic Claude (booking agent, speaker roles, clinical draft, plain-language explanation; one module talks to the API) · PayPal REST API (sandbox Orders + webhook verification).

```
owner ──chat──▶ Worker (Hono) ──tools──▶ D1 (slots, appointments, charges, ledger)
                 │   └── PayPal Orders (deposit, balance) ──▶ webhook ──verify──▶ ledger + chat message
doctor ──Basic──▶ /console ──audio──▶ Workers AI Whisper ──▶ Claude draft ──▶ validator ──▶ approve ──▶ PDFs in R2
owner ◀── /t/<token> ticket (always) · /r/<token> report (after balance captured)
```

Coding rules live in [ARCHITECTURE.md](ARCHITECTURE.md); what is kept and what is not in [PRIVACY.md](PRIVACY.md).

## What was built during the hackathon vs. pre-existing code

Devpost requires this disclosure. The git tag `pre-hackathon` marks the copied code; everything after it is dated hackathon work.

**Pre-existing (copied verbatim from the author's earlier, private projects):**
- `src/prior/hmac.ts` — HMAC-SHA256 and constant-time comparison helpers from a payment-webhook function.
- `src/prior/text.ts` — `normalize`, `sniffMediaType` (byte-signature media detection), base64 helpers and `wrapText` for PDF text, from edge-function helpers. Both `prior` files are consumed by the consult and report steps.
- The *pattern* in `src/agent/claude.ts` (forced `tool_choice` + strict schema on the tool input) and the *rules* of `src/agent/run.ts` (fail-closed guards, one place talks to Claude, silence instead of invented replies) come from the author's earlier Python WhatsApp sales agent; the TypeScript is new.
- The clinical field names and enums (SOAP sections, vitals, prescription, vaccines) follow the author's earlier vet-clinic app; no component code was copied.

**Built during the hackathon (Nov 3 onward):** everything else — the Worker, D1 schema and migrations, money/ledger modules, PayPal client, webhook, booking tools, chat simulator, board, doctor auth and console, transcription, speaker roles, clinical schema, grounding validator, bill, delivery (tokens, PDFs, report gate), plain-language explanation, clinic subscription (PayPal Subscriptions + webhook state machine), hardening, tests and scripts.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars          # fill sandbox values locally; never commit
npx wrangler d1 migrations apply furvet --local
npx wrangler d1 execute furvet --local --file=seed.sql
# seed prices are 0 on purpose: the app refuses to charge a 0-priced item and /health answers 503
# until the clinic sets its prices (cents, tax included):
npx wrangler d1 execute furvet --local --command "UPDATE catalog_items SET price_cents = 20000 WHERE sku = 'ANTICIPO-CONSULTA'; UPDATE catalog_items SET price_cents = 45000 WHERE sku = 'CONSULTA-GENERAL'"
npm run dev                              # http://localhost:8787/sim · /console and /cobros behind the doctor credential
npm test                                 # static checks (scripts/checks.sh) + 199 Vitest tests on a real local D1
bash scripts/mutants.sh                  # 143 injected defects; each must turn the suite red
```

Deploy: `npx wrangler d1 create furvet` (paste the id into `wrangler.toml`), `npx wrangler r2 bucket create furvet-files`, `npx wrangler secret put` for each secret listed in `wrangler.toml`, `npm run db:migrate:remote`, seed and price the remote catalog the same way with `--remote`, `npm run deploy`. Register the webhook URL `https://<worker>/api/v1/paypal/webhook` in the PayPal sandbox app with `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, and for the clinic subscription `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED`. Clinic subscription (the AI draft is gated on it): create the plan once with `PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… bash scripts/paypal-plan.sh` ($999.00 MXN/month, sandbox) and deploy with `--var PAYPAL_PLAN_ID:P-…`; `--var SUBSCRIPTION_REQUIRED:false` switches the gate off in an emergency (default on).

## Security — what is verified and why

- **Sandbox only.** The PayPal host is a constant; `PAYPAL_ENV` must be `sandbox` or every request is 503.
- **Webhook, fail-closed.** Raw body read once → byte-size cap → all five PayPal headers required → `verify-webhook-signature` must answer `SUCCESS` (any error = reject) → only then parse. No webhook id configured = 503.
- **Idempotent, append-only ledger.** `paypal_event_id` is UNIQUE; a replay is a 200 no-op. A transient capture failure is recorded without sealing the event id and answered with 503, so PayPal retries the same event. The charge id equals the appointment id, so a retried order (same `PayPal-Request-Id`) always carries a `custom_id` that matches our row. `charges`/`charge_events` have `BEFORE UPDATE/DELETE` triggers that abort, and a unique index allows one `captured` row per charge whatever the capture id. State changes (appointment confirmed, confirmation message to the chat) happen in the same D1 batch as the event, only when a `captured` row landed.
- **Money.** Integer cents everywhere; PayPal values are strict two-decimal text. We capture ourselves and compare cents + currency against our own charge row: a mismatch is recorded as `amount_mismatch` and never confirms anything. A capture that names a foreign order is ignored.
- **The model never sets a price.** Tool schemas have no money fields and reject extra keys; the deposit amount is read from the catalog; a 0-priced catalog refuses to charge and `/health` reports it. The deposit concept can never be a bill line.
- **Agent guards.** The bot stays silent (never invents) when a person has the chat, when state is unreadable, when the key is missing, or when the model did not finish its turn. Owner text is data, not instructions. Model `thinking` blocks are echoed back untouched and never shown to the owner.
- **No PII in logs or on the board.** Logs carry ids, enums and error names; webhook payloads are stored without `payer`/`payment_source`/`payee`/`shipping` at any depth; the board API never returns raw payloads.
- **Treatment is never withheld for payment, and never waits on PayPal.** Approving a consult writes the bill snapshot and sends the urgent instructions to the owner's chat in ONE D1 batch, without calling PayPal. The itemized account (a 32-column ticket, same strings in the chat and in `ticket.pdf`) reaches the chat ONCE: with the pay link, or at approval when the deposit covered everything. The balance order is created afterwards by the doctor's «Generar cobro» button (`POST /:id/charge`, idempotent: one `balance` charge per consult, deterministic `PayPal-Request-Id` = `custom_id` = `balance-<consult_id>`, the pay link goes to the chat only when THIS request created the charge). A PayPal outage can delay the link, never the approval. The prescription is never sent to the owner: the doctor prints and signs it from the console (`GET /:id/rx.pdf`, doctor credential). `/t/<token>` (the itemized account ticket) is never gated. `/r/<token>` (full report) answers 402 until the ledger view shows the balance `captured` (or the deposit covered everything) — the gate reads `charges_current`, not a flag.
- **Nothing written by the AI reaches the owner without a second click.** The plain-language explanation is stored with the bill at approval and shown to the doctor; «Enviar al dueño» (`POST /:id/send-explanation`) releases it once (append-only `explanation_releases`, PK = consult; the chat message is chained on `changes() = 1`) and only then the report PDF gains its «En palabras sencillas» section. The doctor cannot edit it through this endpoint: what was reviewed is what goes out.
- **Prices come from the server.** The approved body carries catalog ids and quantities only (strict schema: a `precio`/`amount` key is a 422). Unit prices are copied from `catalog_items` at approval into append-only `bill_lines`; total − captured deposit = balance, in integer cents; the PayPal order lists the items with `item_total` and the deposit as `discount`. An owner-sourced medication is validated against the catalog but never priced.
- **Owner links.** 256-bit tokens, only their SHA-256 in D1, 30-day expiry, append-only rows, uniform 404, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`; tokens never appear in logs (errors log the route pattern, not the path).
- **PDFs without decoding.** Reports are plain-text PDFs written by the Worker (Helvetica/WinAnsi, images embedded as-is) to fit the CPU budget of the Workers free plan. Images are accepted by byte signature only (JPEG/PNG), capped at 2 MB and 4 per consult, and their metadata segments (EXIF/GPS, text chunks) are dropped structurally before the R2 put.
- **Plain-language explanation.** Claude receives only the approved values (no transcript, no prices); a validator rejects any number or dose absent from the approved JSON; one retry, then a fixed template without AI.
- **Audio never persists; consent in two layers.** The audio route refuses in a fixed order — no provider → 503, missing owner or vet consent → 409, over size (header **and** stream) → 413, bytes that are not webm/ogg/mp4 → 415, daily budget (reserved atomically before the provider call; an over-cap upload burns no budget) → 429. Bytes stay in request memory; `PRIVACY.md` documents the provider's retention.
- **The AI can only cite, not invent.** Each proposed field carries segment ids and an exact quote; the server validator (no model) drops anything that is not a literal substring, any number absent from its quote, out-of-range vitals, and unknown catalog ids. A dose counts as grounded only with a number and a unit, in digits or in words («250 miligramos»). Drafts and approvals are append-only rows.
- **Doctor console.** HTTP Basic (constant-time compare, 503 when unconfigured) in front of `/console`, `/cobros` and every `/api/v1/consults/*` and `/api/v1/charges/*` route; progressive per-origin lockout after 5 failed logins (IPv6 counted by /64, no global counter so a stranger cannot lock the doctor out, fail-closed when the counter is unreadable); CSP `default-src 'self'`; all transcript text rendered with `textContent`. Doctor writes carry a CSRF guard (`sameOriginWrite` in `src/auth.ts`): a request whose `Sec-Fetch-Site` is not `same-origin`/`none` or whose `Origin` differs from the request origin is refused (403), and the body must be JSON, `audio/*` or `multipart/form-data` (415 otherwise).
- **One clinic time zone.** Every hour shown to a person (slots in the chat, the console) is formatted in `America/Mexico_City`; a static check forbids browser-zone formatting.
- **Mutation control.** `scripts/mutants.sh` injects 73 money/validation/guard defects (console auto-draft: gate check, default-closed client, no retry, one in flight; clinic subscription: amount and currency gate, own-subscription match, no resurrection by a sale, default-on switch, fail-closed gate, strict start body, approve-link origin, replay check; webhook amount and currency on both paths, signature verification, ledger claim, money parser, deposit schema, consent timestamp, post-model human re-check, grounding numbers and units, draft schema strictness, bill arithmetic, report gate, explanation validator, image metadata, inactive catalog items, deposit confirmation message, login lockout) and requires the tests to go red.
- Rate limiting per IP (webhook, `/r/`, `/t/`) is configured at the Cloudflare edge (WAF rules), not in code; the app enforces a daily demo cap and a per-conversation cap. A PayPal order is not a CFDI (Mexican tax invoice); prices are tax-included amounts set by the clinic.

## AI tools used

- **Anthropic Claude** (`claude-sonnet-5`) — booking agent (tool use), speaker labelling, clinical draft and plain-language explanation at runtime. Only `src/agent/claude.ts` calls the API; a static check enforces it.
- **Cloudflare Workers AI (`@cf/openai/whisper-large-v3-turbo`)** — consult transcription.
- **AG Grid Community** — the ledger board (sponsor tool).
- **Claude Code** — coding assistant during development. All generated code is reviewed and tested by the author.

## License

MIT — see [LICENSE](LICENSE).
