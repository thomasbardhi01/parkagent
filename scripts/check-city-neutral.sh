#!/usr/bin/env bash
# Fails if a city or provider name is hardcoded in user-facing strings.
#
#   ./scripts/check-city-neutral.sh
#
# The app runs in more than one city, and copy that names one of them is a
# bug wherever it isn't derived from the provider registry or the user's
# detected/chosen city. So: no "NYC", "New York", "ParkNYC", "Boston", or
# "ParkBoston" in app or server source, EXCEPT in
#
#   - the registries themselves (server/src/providers/registry.ts is the one
#     source of city and provider display names; ios CityCatalog mirrors it),
#   - fixtures, mocks, and tests (fixtures describe a specific city on
#     purpose),
#   - comments (they explain the code, users never read them),
#   - identifiers and data that happen to contain the string, listed in
#     ALLOWED_PATTERNS below.
#
# The allowlist is applied per TOKEN, not per line: an allowed substring is
# cut out of the line and the rest is checked again, so a line that carries
# an identifier AND hardcoded copy still fails.
#
# When a legitimate new case appears, add it to ALLOWED_PATTERNS with a
# reason — never widen the file list to make a real hit go away.

set -uo pipefail
cd "$(dirname "$0")/.."

FORBIDDEN='NYC|New York|ParkNYC|Boston|ParkBoston'

# Source trees that ship user-facing copy — every Swift/TS file under them,
# top-level files included (a `dir/**/*.ext` pathspec silently skipped
# server/src/app.ts, index.ts, env.ts and ios/ParkAgent/ParkAgentApp.swift).
FILES=$(
  git ls-files -- ios/ParkAgent server/src \
  | grep -E '\.(swift|ts)$' \
  | grep -v -E '^ios/ParkAgent/Networking/Mock' \
  | grep -v -E '^ios/ParkAgent/Models/AppModels\.swift$' \
  | grep -v -E '^server/src/providers/registry\.ts$' \
  | grep -v -E '^server/src/scripts/' \
  | grep -v -E '\.test\.ts$'
)

# An empty list would make grep read stdin and "pass" — fail loudly instead.
if [ -z "$FILES" ]; then
  echo "City-neutral check found no source files to scan — is the pathspec broken?"
  exit 1
fi

# Identifiers and data that happen to contain a forbidden string. Cut out of
# a line before it is re-checked.
ALLOWED_PATTERNS=(
  'NYC_TZ'                  # the Eastern timezone constant (both cities are Eastern)
  'PARKNYC'                 # env var names (PARKNYC_PLATE) and the Stripe test descriptor
  'city: "New York"'        # Stripe cardholder billing address / shadow descriptor data
  'city: "Boston"'          # …and Boston's
)

hits=""
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  code=${hit#*:*:} # drop the "file:line:" prefix
  for allowed in "${ALLOWED_PATTERNS[@]}"; do
    code=${code//"$allowed"/}
  done
  if [[ $code =~ $FORBIDDEN ]]; then
    hits+="$hit"$'\n'
  fi
done < <(
  # -H so the prefix is there even for a single file; strip // and *
  # comment lines before matching so an explanatory comment never fails
  # the build.
  # shellcheck disable=SC2086
  grep -Hn -E "$FORBIDDEN" $FILES 2>/dev/null \
    | grep -v -E '^[^:]+:[0-9]+: *(//|/\*|\*)' \
    || true
)

if [ -n "$hits" ]; then
  echo "City-neutral check FAILED — hardcoded city/provider names in user-facing strings:"
  echo
  printf '%s' "$hits"
  echo
  echo "Take the name from the provider registry (server: providerForCity/coveredCitiesSentence;"
  echo "iOS: CityCatalog / the provider block on the API response) or use neutral copy"
  echo "(\"your city\", \"your parking account\"). If this hit is an identifier rather than"
  echo "copy, add it to ALLOWED_PATTERNS in scripts/check-city-neutral.sh with a reason."
  exit 1
fi

echo "City-neutral check passed: no hardcoded city or provider names in user-facing strings."
