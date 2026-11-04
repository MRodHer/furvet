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

# V21 — nothing from the private origin repos leaks (README may mention prior work). The forbidden
# terms live here only as SHA-256 fingerprints of lowercase words, word pairs and dotted-number
# prefixes, so this file can be public. To add one: printf '%s' 'term' | sha256sum, then update the pin.
# Identifiers are split at camelCase and letter/digit boundaries. Not caught by design: a term glued
# in lower case inside another word, or a number prefix inside a longer number; the grader's hostile
# sweep covers those before each publication.
V21_FINGERPRINTS="3df4356caeae62bb197dfeffe83c6e219db6de5507c5419349738ca1858475e4 1fdeb7040756e50a7eb088611126a2f66dc31f06b8e5c1528b54d80e74dd5aa0 4d7594e57f7d03f35ede2d316cda4cdb7df66b28963738e836a2f16d9fc9eb4d 4c36874573e347d9dbe8a461bac894b7ef86be12596d82aee7df113c5003bbcf 17b18454d46abc2a169b360972c6dc75d1dab520db5c8cb307081e7b46ca6cb1 a3e690053061793bb12ad4c32aace5856f57f1694d3608df1379d240ce1bbc5b 6b17b8fcc411a533c822a5117e33cf73fa6766739d7d36ac86dc4bea883af4fe"
[ "$(printf '%s' "$V21_FINGERPRINTS" | sha256sum | cut -c1-64)" = "120cbe0e960650333b579a90e73b076460423f47c68199e67828fd08c9d9151f" ] || { echo "FAIL: V21 fingerprint list changed without updating its pin"; exit 1; }
v21_guard() { # fingerprints, paths... → fails loud, with the offending lines, when a scanned token's fingerprint is listed
  local fp=$1 hits; shift
  hits=$(grep -rhoE '[0-9]+(\.[0-9]+)+|[A-Za-z]+|[0-9]+' "$@" | sed -E 's/([a-z])([A-Z])/\1\n\2/g' | tr '[:upper:]' '[:lower:]' | awk '
    { print; if (prev != "") print prev " " $0; prev = $0
      n = split($0, p, "."); s = p[1]; for (i = 2; i < n; i++) { s = s "." p[i]; print s } }' | sort -u |
    node -e 'const { createHash } = require("node:crypto"); const bad = new Set(process.argv.slice(1));
      for (const t of require("node:fs").readFileSync(0, "utf8").split("\n"))
        if (t && bad.has(createHash("sha256").update(t).digest("hex"))) console.log(t);' $fp)
  [ -z "$hits" ] || { echo "FAIL: forbidden term found"; grep -rniF "$hits" "$@"; return 1; }
}
# The guard proves itself alive on every run: a random token planted (in upper case) in a file outside
# the repo must be caught as a word, as a word pair, as a dotted-number prefix, inside a camelCase
# identifier and glued between digits; a clean file must pass.
probe=$(mktemp); trap 'rm -f "$probe"' EXIT
a=$(tr 0-9 a-j <<<"$RANDOM$RANDOM"); b=$(tr 0-9 k-t <<<"$RANDOM$RANDOM"); c=$(tr 0-9 q-z <<<"$RANDOM$RANDOM"); d=$(tr 0-9 c-l <<<"$RANDOM$RANDOM"); n=$RANDOM.$RANDOM
printf 'Foo %s bar\n%s-%s\nip %s.7.9\nfoo%sBar 7%s9\n' "${a^^}" "${a^^}" "${b^^}" "$n" "${c^}" "$d" >"$probe"
for t in "$a" "$a $b" "$n" "$c" "$d"; do
  v21_guard "$(printf '%s' "$t" | sha256sum | cut -c1-64)" "$probe" >/dev/null && { echo "FAIL: V21 self-test did not catch a planted term"; exit 1; }
done
v21_guard "$V21_FINGERPRINTS" "$probe" || { echo "FAIL: V21 self-test flagged a clean file"; exit 1; }
v21_guard "$V21_FINGERPRINTS" src public migrations test seed.sql wrangler.toml || exit 1
echo "checks: ok"
