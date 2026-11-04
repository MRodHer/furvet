#!/usr/bin/env bash
# Static guards that run before the test suite. Each one fails loud.
set -euo pipefail
cd "$(dirname "$0")/.."

# E12 — exactly one module talks to the Claude API.
callers=$(grep -rl "api.anthropic.com" src | wc -l)
if [ "$callers" != "1" ]; then
  echo "FAIL: expected 1 file calling api.anthropic.com, found $callers"; grep -rl "api.anthropic.com" src; exit 1
fi

# Only the sandbox host may appear anywhere in the source.
if grep -rnE "api-m\.paypal\.com|https://www\.paypal\.com" src public; then
  echo "FAIL: live PayPal host found in source"; exit 1
fi

# V19 — no silent catches.
if grep -rnE "catch *(\([a-zA-Z_]*\))? *\{ *\}" src; then
  echo "FAIL: empty catch block"; exit 1
fi

# V21 — nothing from the private origin repos leaks (README may mention prior work).
if grep -rniE "REDACTED" src public migrations test seed.sql wrangler.toml; then
  echo "FAIL: forbidden term found"; exit 1
fi
echo "checks: ok"
