#!/usr/bin/env bash
# One-time, GATED (Mau runs it with his sandbox secrets in the shell; nothing is read from the repo):
#   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… bash scripts/paypal-plan.sh
# Creates the catalog product and the monthly plan ($999.00 MXN, infinite cycles) in the PayPal
# SANDBOX and prints the plan id (P-…). Fixed PayPal-Request-Id values make a re-run idempotent.
# Expected output: two "HTTP 201" lines and `PAYPAL_PLAN_ID=P-...`. Any other status fails loud:
# a 4xx on the plan with MXN means the sandbox refused the currency — report it, do not guess another.
set -euo pipefail
: "${PAYPAL_CLIENT_ID:?set PAYPAL_CLIENT_ID in the shell}" "${PAYPAL_CLIENT_SECRET:?set PAYPAL_CLIENT_SECRET in the shell}"
BASE="https://api-m.sandbox.paypal.com"
PRICE_VALUE="999.00"; CURRENCY="MXN" # mirrors SUBSCRIPTION_PRICE_CENTS / wrangler.toml CURRENCY; change both or neither
TOKEN=$(curl -sS -f -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials "$BASE/v1/oauth2/token" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
post() { # path request-id json → prints "HTTP <code>" to stderr and the body to stdout
  local out code
  out=$(curl -sS -w '\n%{http_code}' -X POST "$BASE$1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "PayPal-Request-Id: $2" -d "$3")
  code=${out##*$'\n'}; echo "HTTP $code $1" >&2
  [[ $code == 2* ]] || { echo "${out%$'\n'*}" >&2; exit 1; }
  echo "${out%$'\n'*}"
}
PRODUCT_ID=$(post /v1/catalogs/products furvet-product-1 '{"name":"FurVet — suscripción de clínica","type":"SERVICE","category":"SOFTWARE"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
PLAN=$(post /v1/billing/plans furvet-plan-mxn-999-1 "{\"product_id\":\"$PRODUCT_ID\",\"name\":\"FurVet mensual\",\"status\":\"ACTIVE\",\"billing_cycles\":[{\"tenure_type\":\"REGULAR\",\"sequence\":1,\"total_cycles\":0,\"frequency\":{\"interval_unit\":\"MONTH\",\"interval_count\":1},\"pricing_scheme\":{\"fixed_price\":{\"currency_code\":\"$CURRENCY\",\"value\":\"$PRICE_VALUE\"}}}],\"payment_preferences\":{\"auto_bill_outstanding\":true,\"payment_failure_threshold\":1}}")
python3 -c 'import json,sys; p=json.load(sys.stdin); print(f"PAYPAL_PLAN_ID={p[\"id\"]}  status={p[\"status\"]}")' <<<"$PLAN"
echo "Next: npx wrangler deploy --var PAYPAL_PLAN_ID:<P-…> --var SUBSCRIPTION_REQUIRED:true ; register the 6 subscription events on the webhook (README)." >&2
