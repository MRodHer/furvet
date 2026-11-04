#!/usr/bin/env bash
# V20 — red/green control: each mutant must turn its suite RED; the tree is restored afterwards.
# Usage: bash scripts/mutants.sh   (requires a clean git tree for src/)
set -uo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain src)" ]; then echo "src/ has uncommitted changes; commit or stash first"; exit 2; fi

run_mutant() { # name, file, sed-expr, test-file
  local name=$1 file=$2 expr=$3 tests=$4
  sed -i "$expr" "$file"
  if git diff --quiet -- "$file"; then echo "FAIL  $name: mutation did not apply (pattern drifted)"; return 1; fi
  if npx vitest run "$tests" >/dev/null 2>&1; then
    echo "FAIL  $name: tests stayed GREEN with the defect"; git checkout -- "$file"; return 1
  fi
  echo "ok    $name: tests went red"; git checkout -- "$file"
}

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
# V20 (clinical): the grounding number rule and the strict schema are behavior-critical.
run_mutant "grounding ignores numbers not present in the quote" src/clinical/grounding.ts \
  's/for (const n of numbersIn(valueText)) if (!quoted.has(n)) return "number_not_quoted";/for (const n of numbersIn(valueText)) if (!quoted.has(n) \&\& false) return "number_not_quoted";/' \
  test/grounding.test.ts || status=1
run_mutant "draft schema accepts extra keys (a price) at the root" src/clinical/schema.ts \
  '/^      billable: z.array/{n;n;s/\.strict();/.passthrough();/}' \
  test/fill.test.ts || status=1
exit $status
