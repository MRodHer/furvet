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
  's/const PII_KEYS = new Set(\["payer", "payment_source", "payee", "shipping"\]);/const PII_KEYS = new Set(["payer", "payment_source", "payee"]);/' test/hardening.test.ts || status=1
exit $status
