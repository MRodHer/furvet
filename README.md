# FurVet — the AI assistant for the vet visit

*Because every patient is someone's fur bestie.* Vets subscribe with PayPal; families pay with PayPal.

> Built for the PayPal AI Hackathon 2026. Runs 100% in PayPal **sandbox**.
> Status: early skeleton — features below are the plan, not yet implemented.

**Live demo:** `<URL>` · **Video:** `<YouTube URL>`

## What it does

1. **Booking + deposit.** A pet owner chats with an AI agent (WhatsApp; a web chat simulator in the demo), books a consult and pays a deposit with PayPal.
2. **Consult capture.** With the owner's on-screen consent, the assistant records the consult, transcribes it and separates the vet's and the owner's voices. Audio is deleted right after transcription.
3. **Clinical draft.** Claude fills a SOAP note, vital signs, exam by body system, prescription and vaccines. Every AI-filled field is flagged and linked to the transcript sentence that supports it. The AI never invents numbers or doses; the vet reviews and approves.
4. **Balance payment.** Billable items are detected from the consult; **prices come from the server catalog, never from the model**. Payment through PayPal with a verified, idempotent webhook and an append-only ledger.
5. **Delivery.** Prescription and urgent instructions are delivered immediately, always. The full report (plain-language explanation + images chosen by the vet) is released as a PDF once payment is confirmed.
6. **Vet as customer.** The clinic pays for the assistant with PayPal Subscriptions.

## Architecture

Cloudflare Workers (TypeScript, Hono) · D1 (money as integer cents) · R2 (images and PDFs) · Workers AI (transcription) · Anthropic Claude · PayPal REST API (sandbox).

_Diagram TBD._

## What was built during the hackathon vs. pre-existing code

_To be completed. Devpost requires this disclosure; it will match the git history file by file._

**Pre-existing:**

**Built during the hackathon:**

## Setup

_TBD — step-by-step run instructions, `.env.example` and sandbox test accounts._

## Security — what is verified and why

_TBD._ Design principles: fail-closed webhook verification, idempotent payments,
server-side prices, decimal money, append-only ledger, sandbox credentials only,
no real patient or owner data, no PII in logs, recording consent and audio deletion.

## AI tools used

- **Anthropic Claude** — clinical note drafting at runtime.
- **Cloudflare Workers AI (Whisper)** — consult transcription.
- **Claude Code** — coding assistant during development. All generated code is reviewed and tested by the author.

## License

MIT — see [LICENSE](LICENSE).
