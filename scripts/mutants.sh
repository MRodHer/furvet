#!/usr/bin/env bash
# V20 — red/green control: each mutant must turn its suite RED; the tree is restored afterwards.
# Usage: bash scripts/mutants.sh   (requires a clean git tree for src/)
set -uo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain src)" ]; then echo "src/ has uncommitted changes; commit or stash first"; exit 2; fi

# pass | fail | broken — "broken" is a suite that did not run (pool start failure, no test
# files, missing summary) and must never be read as a dead mutant.
suite() {
  local out; out=$(npx vitest run "$@" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
  if grep -qE "Failed to start|Unhandled Error|No test files found" <<<"$out"; then echo broken; return; fi
  grep -qE "^ *Tests +[1-9]" <<<"$out" || { echo broken; return; } # summary with >=1 test (not "no tests")
  if grep -qE "Tests +[1-9][0-9]* failed" <<<"$out"; then echo fail; else echo pass; fi
}

run_mutant() { # name, file, sed-expr, test-file
  local name=$1 file=$2 expr=$3 tests=$4
  sed -i "$expr" "$file"
  if git diff --quiet -- "$file"; then echo "FAIL  $name: mutation did not apply (pattern drifted)"; return 1; fi
  local r; r=$(suite "$tests"); git checkout -- "$file"
  case $r in
    fail) echo "ok    $name: tests went red" ;;
    pass) echo "FAIL  $name: tests stayed GREEN with the defect"; return 1 ;;
    *) echo "FAIL  $name: suite did not run ($r), not a dead mutant"; return 1 ;;
  esac
}

# Baseline: the unmutated suite must run and pass; otherwise every "red" below would be noise.
base=$(suite)
if [ "$base" != pass ]; then echo "ABORT: baseline suite is $base; fix the suite before measuring mutants"; exit 2; fi
echo "ok    baseline: suite runs and passes"

status=0
run_mutant "webhook ignores capture amount" src/routes/webhook.ts \
  's/status = cap.amountCents === charge.amount_cents \&\& cap.currency === charge.currency \&\& cap.status === "COMPLETED"/status = cap.currency === charge.currency \&\& cap.status === "COMPLETED"/' \
  test/webhook.test.ts || status=1
run_mutant "ledger event inserted without the claim guard" src/ledger.ts \
  's/WHERE changes() = 1`,/WHERE 1 = 1`,/' test/ledger_immutable.test.ts || status=1
run_mutant "money parser accepts loose decimals" src/money.ts \
  's#/^(\\d{1,10})\\.(\\d{2})$/#/^(\\d{1,10})\\.?(\\d{0,2})$/#' test/money.test.ts || status=1
run_mutant "deposit tool trusts an extra amount key" src/agent/tools.ts \
  's/const CreateDeposit = z.object({ appointment_id: z.string().uuid() }).strict();/const CreateDeposit = z.object({ appointment_id: z.string().uuid() });/' \
  test/booking.test.ts || status=1
run_mutant "claude client sends temperature again (prod 400: deprecated)" src/agent/claude.ts \
  's/max_tokens: input.maxTokens,/max_tokens: input.maxTokens, temperature: 0.5,/' test/sim.test.ts || status=1
run_mutant "claude response schema rejects thinking blocks again (prod: ZodError, bot mute)" src/agent/claude.ts \
  '/}).passthrough(),/d' test/sim.test.ts || status=1
run_mutant "claude catch-all swallows a malformed text block as opaque" src/agent/claude.ts \
  's/z.string().refine((t) => t !== "text" \&\& t !== "tool_use")/z.string()/' test/sim.test.ts || status=1
run_mutant "deposit confirmation message sent without the this-batch guard (replay/concurrent duplicate speaks twice)" src/routes/webhook.ts \
  's/DEPOSIT_CONFIRMED_TEXT, "changes() = 1", \[\], 1)/DEPOSIT_CONFIRMED_TEXT, "1 = 1", [], 1)/' test/webhook.test.ts || status=1
run_mutant "deposit confirmation inserted as a human message (is_bot 0 mutes the agent, E13)" src/routes/webhook.ts \
  's/DEPOSIT_CONFIRMED_TEXT, "changes() = 1", \[\], 1)/DEPOSIT_CONFIRMED_TEXT, "changes() = 1", [], 0)/' test/webhook.test.ts || status=1
run_mutant "clinic time shown in UTC (chat says 4:00 am for a 10:00 am slot)" src/time.ts \
  's/timeZone: CLINIC_TZ/timeZone: "UTC"/' test/time.test.ts || status=1
run_mutant "fill prompt loses the dosis rule (model writes «una tableta», receta stays incomplete)" src/clinical/fill.ts \
  '/En dosis copia LITERALMENTE/d' test/fill.test.ts || status=1
run_mutant "claude catch-all excludes only text (malformed tool_use passes as opaque)" src/agent/claude.ts \
  's/t !== "text" \&\& t !== "tool_use"/t !== "text"/' test/sim.test.ts || status=1
run_mutant "messageInserts default is_bot 1 (doctor-approved rx read as the bot: agent keeps talking over the doctor)" src/delivery.ts \
  's/isBot: 0 | 1 = 0/isBot: 0 | 1 = 1/' test/approve.test.ts || status=1
run_mutant "deposit message guarded by the event INSERT instead of the appointment UPDATE" src/routes/webhook.ts \
  "/UPDATE appointments SET status = 'confirmed'/{h;d}; /DEPOSIT_CONFIRMED_TEXT, \"changes() = 1\"/G" test/webhook.test.ts || status=1
run_mutant "approximate birth date ignores the months" src/agent/tools.ts \
  's/const totalMonths = (years ?? 0) \* 12 + (months ?? 0);/const totalMonths = (years ?? 0) * 12;/' test/booking.test.ts || status=1
run_mutant "book_appointment accepts any sex string" src/agent/tools.ts \
  's/sex: z.enum(\["macho", "hembra"\]).optional(),/sex: z.string().optional(),/' test/booking.test.ts || status=1
run_mutant "dose unit regex back to abbreviations only («250 miligramos» blocks approval)" src/clinical/grounding.ts \
  's/|miligramos?|mililitros?|microgramos?|gramos?|unidad(?:es)? internacional(?:es)?//' test/grounding.test.ts || status=1
# ---- delivery (Constructora C, V20-C) ----
run_mutant "bill ignores the captured deposit" src/billing.ts \
  's/balanceCents: Math.max(totalCents - depositCents, 0)/balanceCents: Math.max(totalCents, 0)/' test/billing.test.ts || status=1
run_mutant "bill balance may go negative" src/billing.ts \
  's/balanceCents: Math.max(totalCents - depositCents, 0)/balanceCents: totalCents - depositCents/' test/billing.test.ts || status=1
run_mutant "report gate accepts any charge status" src/routes/report.ts \
  's/if (charge?.status !== "captured") {/if (!charge) {/' test/report.test.ts || status=1
# Two barriers assert the same fact (JS status check + "this batch inserted the event" guard): each
# alone is an equivalent mutant, so the control removes BOTH and must still go red (V12).
run_mutant "webhook releases the report on a mismatch (both barriers removed)" src/routes/webhook.ts \
  's/if (status === "captured" \&\& charge.kind === "balance"/if (charge.kind === "balance"/; s/tokenInsert(env.DB, hash, charge.consult_id, "report", new Date(), "changes() = 1")/tokenInsert(env.DB, hash, charge.consult_id, "report", new Date())/' test/report.test.ts || status=1
run_mutant "explanation dose tokens matched as substrings" src/reports/explain.ts \
  's/(?<!\[\\\\d.,\])\${esc(squash(tok))}(?!\[a-z\/\])/${esc(squash(tok))}/' test/explain.test.ts || status=1
run_mutant "explanation validator ignores numbers" src/reports/explain.ts \
  's/const bad = numbersIn(text).filter((n) => !allowedNumbers.has(n));/const bad: string[] = [];/' test/explain.test.ts || status=1
run_mutant "jpeg metadata kept" src/images.ts \
  's/if (!isApp \&\& !isComment) out.push(segment);/out.push(segment);/' test/images.test.ts || status=1
run_mutant "inactive catalog items can be billed" src/billing.ts \
  's/if (!item || item.active !== 1) throw/if (!item) throw/' test/billing.test.ts || status=1
# V20 (clinical): the grounding number rule and the strict schema are behavior-critical.
run_mutant "grounding ignores numbers not present in the quote" src/clinical/grounding.ts \
  's/for (const n of numbersIn(valueText)) if (!quoted.has(n)) return "number_not_quoted";/for (const n of numbersIn(valueText)) if (!quoted.has(n) \&\& false) return "number_not_quoted";/' \
  test/grounding.test.ts || status=1
run_mutant "draft schema accepts extra keys (a price) at the root" src/clinical/schema.ts \
  '/^      billable: z.array/{n;n;s/\.strict();/.passthrough();/}' \
  test/fill.test.ts || status=1
run_mutant "webhook ignores capture currency (APPROVED path)" src/routes/webhook.ts \
  's/status = cap.amountCents === charge.amount_cents \&\& cap.currency === charge.currency \&\& cap.status === "COMPLETED"/status = cap.amountCents === charge.amount_cents \&\& cap.status === "COMPLETED"/' \
  test/webhook.test.ts || status=1
run_mutant "webhook ignores currency (CAPTURE.COMPLETED path)" src/routes/webhook.ts \
  's/status = amountCents === charge.amount_cents \&\& r.data.amount.currency_code === charge.currency ? "captured" : "amount_mismatch";/status = amountCents === charge.amount_cents ? "captured" : "amount_mismatch";/' \
  test/webhook.test.ts || status=1
run_mutant "verify accepts anything but FAILURE" src/paypal.ts \
  's/return VerifySchema.parse(raw).verification_status === "SUCCESS";/return VerifySchema.parse(raw).verification_status !== "FAILURE";/' \
  test/webhook.test.ts || status=1
run_mutant "consent timestamp overwritable" src/routes/sim.ts \
  's/WHERE id = ?3 AND owner_consent_at IS NULL/WHERE id = ?3/' test/sim.test.ts || status=1
run_mutant "post-model human re-check removed" src/agent/run.ts \
  's/if (await humanHasChat(ctx, await recentHistory(env, conversationId))) return null;/if (false) return null;/' test/sim.test.ts || status=1
# ---- delivery C.6b: deferred balance order + one-shot explanation release ----
run_mutant "pay-link message sent without the claim guard" src/routes/approve.ts \
  's/...messageInserts(env.DB, consult.conversation_id, text, "changes() = 1"),/...messageInserts(env.DB, consult.conversation_id, text),/' test/approve.test.ts || status=1
run_mutant "explanation release guard removed (second click sends again)" src/routes/approve.ts \
  's/(revisada por el médico):\\n${bill.explanation}`, "changes() = 1"),/(revisada por el médico):\\n${bill.explanation}`),/; s/if (await env.DB.prepare("SELECT 1 AS x FROM explanation_releases WHERE consult_id = ?1").bind(consult.id).first()) return c.json({ error: "already sent" }, 409);//' test/approve.test.ts || status=1
run_mutant "template explanation no longer shortened (column CHECK would 500 the approval)" src/reports/explain.ts \
  's/if (text.length > MAX_EXPLANATION_CHARS) text = \[...parts, closing\].join(" ");/if (false) text = [...parts, closing].join(" ");/; s/if (text.length > MAX_EXPLANATION_CHARS) {/if (false) {/' test/explain.test.ts || status=1
run_mutant "ledger board served without the doctor credential (H1)" src/routes/charges.ts \
  's/app.use("\*", doctorAuth());//' test/csrf_board.test.ts || status=1
run_mutant "cross-site guard removed (H2)" src/auth.ts \
  's/if (crossSite || originMismatch) {/if (false) {/' test/csrf_board.test.ts || status=1
run_mutant "body type guard removed (H2)" src/auth.ts \
  's/if (type ? !BODY_TYPES.test(type) : !bodyless) return c.json({ error: "unsupported content type" }, 415);/if (false) return c.json({ error: "unsupported content type" }, 415);/' test/csrf_board.test.ts || status=1

# ---- hardening (audit H3-H9): each barrier alone, red with the defect ----
run_mutant "lockout check removed (H3)" src/auth.ts \
  's/if (waitMs > 0) {/if (false) {/' test/hardening.test.ts || status=1
run_mutant "lockout store failure lets the right credential in (H3 fail-closed)" src/auth.ts \
  's|return false; // store down ⇒ deny, even with the right credential|return ok;|' test/hardening.test.ts || status=1
run_mutant "IPv6 counted per full address instead of /64 (H3)" src/auth.ts \
  's/return `ip:${full.slice(0, 4)/return `ip:${full.slice(0, 8)/' test/hardening.test.ts || status=1
run_mutant "deposit concept billable as a line (H4)" src/routes/approve.ts \
  "s/WHERE category <> 'anticipo' AND id IN/WHERE id IN/" test/hardening.test.ts || status=1
run_mutant "over-cap audio upload reserves budget (H5)" src/routes/consults.ts \
  's/if (estSeconds > cap) {/if (false) {/' test/hardening.test.ts || status=1
run_mutant "webhook cap counts characters after reading everything (H6)" src/routes/webhook.ts \
  's/const bytes = await readCapped(c.req.raw.body, MAX_BODY_BYTES);/const bytes = new TextEncoder().encode(await c.req.text());/' test/hardening.test.ts || status=1
run_mutant "second capture re-settles (H7, code barrier)" src/routes/webhook.ts \
  's/if (charge.status === "captured") {$/if (false) {/' test/hardening.test.ts || status=1
run_mutant "capture naming a foreign order accepted (H8 cross-check removed)" src/routes/webhook.ts \
  's/if (!charge || (relatedOrder !== undefined \&\& relatedOrder !== charge.paypal_order_id)) {/if (!charge) {/' test/hardening.test.ts || status=1
run_mutant "nested shipping kept in webhook evidence (H9)" src/ledger.ts \
  's/const PII_KEYS = new Set(\["payer", "payment_source", "payee", "shipping", "subscriber"\]);/const PII_KEYS = new Set(["payer", "payment_source", "payee", "subscriber"]);/' test/hardening.test.ts || status=1
run_mutant "owner-sourced medication still billed (BB3 flag ignored)" src/routes/approve.ts \
  's/if (m.catalog_item_id \&\& !m.owner_sourced \&\& !billed.has(m.catalog_item_id))/if (m.catalog_item_id \&\& !billed.has(m.catalog_item_id))/' test/approve.test.ts || status=1
run_mutant "quantity above 100 accepted (BB4)" src/billing.ts \
  's/w.quantity < 1 || w.quantity > 100/w.quantity < 1/' test/approve.test.ts || status=1
run_mutant "billable row for an owner-sourced medication no longer refused (BB3 variant)" src/routes/approve.ts \
  's/if (body.prescription.some((m) => m.owner_sourced \&\& m.catalog_item_id/if (false \&\& body.prescription.some((m) => m.owner_sourced \&\& m.catalog_item_id/' test/approve.test.ts || status=1
run_mutant "bill messages priced from today's catalog instead of the snapshot (TK4)" src/routes/approve.ts \
  's/SELECT catalog_item_id AS catalogItemId, name, quantity, unit_price_cents AS unitPriceCents,/SELECT catalog_item_id AS catalogItemId, name, quantity, (SELECT price_cents FROM catalog_items ci WHERE ci.id = bill_lines.catalog_item_id) AS unitPriceCents,/' test/approve.test.ts || status=1
run_mutant "rx link back in the owner's chat (ADENDA 2)" src/routes/approve.ts \
  's|"La receta te la entrega la doctora impresa y firmada.",|"La receta te la entrega la doctora impresa y firmada.", `Receta en PDF: ${base}/rx/${ticket.token}`,|' test/approve.test.ts || status=1
run_mutant "rx section back in the owner's report (ADENDA 2)" src/reports/render.ts \
  's|  // No rx section here: the prescription is printed and signed by the doctor, never delivered to the owner (ADENDA 2).|  out.push({ kind: "h2", text: "Receta" }, ...prescriptionLines(body).map((text) => ({ kind: "p" as const, text })));|' test/report.test.ts || status=1
run_mutant "static assets bypass secureHeaders (pentest M1)" src/app.ts \
  's|app.notFound((c) => (c.req.method === "GET" \|\| c.req.method === "HEAD" ? serveAsset(c.env, c.req.raw) : c.text("404 Not Found", 404)));|app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));|' test/app.test.ts || status=1
run_mutant "CSP header without frame-ancestors (pentest M2)" src/app.ts \
  "s|        frameAncestors: \[\"'none'\"\],||" test/app.test.ts || status=1
# ---- clinic subscription (Constructora C, feat-clinic-subscription) ----
run_mutant "subscription money gate ignores the amount (998.00 activates)" src/subscription.ts \
  's/const amountOk = paid !== null \&\& paid.amountCents === sub.amount_cents \&\& paid.currency === sub.currency;/const amountOk = paid !== null \&\& paid.currency === sub.currency;/' test/subscription.test.ts || status=1
run_mutant "subscription money gate ignores the currency (999.00 USD activates)" src/subscription.ts \
  's/const amountOk = paid !== null \&\& paid.amountCents === sub.amount_cents \&\& paid.currency === sub.currency;/const amountOk = paid !== null \&\& paid.amountCents === sub.amount_cents;/' test/subscription.test.ts || status=1
run_mutant "subscription webhook stops matching OUR paypal_subscription_id (any row)" src/subscription.ts \
  's/const sub = await currentSubscription(env.DB, "paypal_subscription_id = ?1", subId);/const sub = await currentSubscription(env.DB);/' test/subscription.test.ts || status=1
run_mutant "a sale resurrects a cancelled subscription" src/subscription.ts \
  's/state = amountOk \&\& sub.state === "approval_pending" ? "active" : null;/state = amountOk \&\& sub.state !== "active" ? "active" : null;/' test/subscription.test.ts || status=1
run_mutant "SUBSCRIPTION_REQUIRED default flips to OFF" src/subscription.ts \
  's/return env.SUBSCRIPTION_REQUIRED !== "false";/return env.SUBSCRIPTION_REQUIRED === "true";/' test/subscription.test.ts || status=1
run_mutant "AI gate removed from /fill" src/routes/consults.ts \
  's/if (subscriptionRequired(env)) {/if (false) {/' test/subscription.test.ts || status=1
run_mutant "AI gate passes when the subscription store fails" src/routes/consults.ts \
  's/return c.json({ error: "subscription check unavailable" }, 503);/active = true;/' test/subscription.test.ts || status=1
run_mutant "/start body accepts extra keys (plan_id from the client)" src/routes/subscription.ts \
  's/const StartBody = z.object({}).strict();/const StartBody = z.object({});/' test/subscription.test.ts || status=1
run_mutant "approve link checked by protocol only (look-alike host passes)" src/routes/subscription.ts \
  's/if (new URL(sub.approveUrl).origin !== APPROVE_ORIGIN) {/if (new URL(sub.approveUrl).protocol !== "https:") {/' test/subscription.test.ts || status=1
run_mutant "webhook seen-check ignores subscription_events (replay re-processed)" src/routes/webhook.ts \
  's/ UNION ALL SELECT 1 FROM subscription_events WHERE paypal_event_id = ?1//' test/subscription.test.ts || status=1
run_mutant "a late ACTIVATED reopens a cancelled or expired subscription" src/subscription.ts \
  's/if (sub.state === "cancelled" || sub.state === "expired") {/if (false) {/' test/subscription.test.ts || status=1
run_mutant "ACTIVATED stops checking the plan id" src/subscription.ts \
  's/if (planId !== sub.plan_id) {/if (false) {/' test/subscription.test.ts || status=1
run_mutant "a sale activates whatever its amount" src/subscription.ts \
  's/state = amountOk \&\& sub.state === "approval_pending" ? "active" : null;/state = sub.state === "approval_pending" ? "active" : null;/' test/subscription.test.ts || status=1
exit $status
