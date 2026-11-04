# Privacy — what FurVet keeps, what it does not

Demo for the PayPal AI Hackathon 2026. Everything runs on Cloudflare (Workers, D1, R2, Workers AI) and PayPal **sandbox**. The pet owner in the demo is fictitious.

## Consult audio
- The consult is recorded in the doctor's browser only after **two** consents: the owner's (chat button, versioned text, stored on the conversation and snapshotted on the consult) and the doctor's (console checkbox, versioned text). Without both the server refuses the audio (`409`).
- The audio travels once, from the browser to the Worker, and from the Worker to Workers AI for transcription. It is **never written** to D1, R2, logs or disk: there is no blob column in the schema, and the test suite (`test/audio.test.ts`, "V2") searches every table for the uploaded bytes after a transcription.
- Logs carry only ids, counts, the provider name and error class names.

## Transcription provider (Cloudflare Workers AI, `@cf/openai/whisper-large-v3-turbo`)
Per Cloudflare's Workers AI data-usage documentation (read 2026-11-04): "Cloudflare does not retain inputs or outputs after they are no longer needed to process the request and deliver the response" and "Cloudflare does not use Customer Content processed by Workers AI to train AI models". Cloudflare may keep operational metadata (timestamps, request sizes) that "does not include Customer Content". This project does not enable AI Gateway logging or caching.

## Transcript and AI draft
- The transcript (text segments with timestamps and a speaker label) and every AI draft are stored in D1 as the clinical record and as evidence of what the AI proposed versus what the doctor approved (`consult_versions` is append-only).
- The draft request to Claude (Anthropic) contains the numbered transcript, the species/breed and the clinic's catalog **names** — never prices, never the owner's name, phone or email. Anthropic's API retention applies to that text; see Anthropic's commercial terms.
- Retention of transcripts for the demo: purge after the judging period (the D1 database is dropped). A production deployment should document a purge schedule.

## Doctor console
HTTP Basic over HTTPS with a single demo credential (rotated after judging). The account can read consults and approve records; it cannot edit the catalog or prices. See `SECURITY.md` / README.
