#!/usr/bin/env bash
# Fails if a city or provider name is hardcoded in user-facing strings.
#
#   ./scripts/check-city-neutral.sh
#
# The app runs in more than one city, and copy that names one of them is a
# bug wherever it isn't derived from the provider registry or the user's
# detected/chosen city. So: no "NYC", "New York", or "ParkNYC" in app or
# server source, EXCEPT in
#
#   - the registries themselves (server/src/providers/registry.ts is the one
#     source of city and provider display names; ios CityCatalog mirrors it),
#   - fixtures, mocks, and tests (fixtures describe a specific city on
#     purpose),
#   - comments (they explain the code, users never read them),
#   - identifiers and data that happen to contain the string: zone-id
#     prefixes ("nyc-…"), the parknyc provider id, timezone names
#     ("America/New_York"), Stripe billing addresses and test-mode merchant
#     descriptors, env var names, and file names.
#
# When a legitimate new case appears, add it to ALLOWED_PATTERNS with a
# reason — never widen the file list to make a real hit go away.

set -uo pipefail
cd "$(dirname "$0")/.."

# Source trees that ship user-facing copy.
FILES=$(
  git ls-files \
    'ios/ParkAgent/**/*.swift' \
    'server/src/**/*.ts' \
  | grep -v -E '^ios/ParkAgent/Networking/Mock' \
  | grep -v -E '^ios/ParkAgent/Models/AppModels\.swift$' \
  | grep -v -E '^server/src/providers/registry\.ts$' \
  | grep -v -E '^server/src/scripts/' \
  | grep -v -E '\.test\.ts$'
)

# Substrings that are identifiers or data, not copy. Matched against the
# whole line; a line that contains one is exempt.
ALLOWED_PATTERNS=(
  'America/New_York'        # IANA timezone; both cities are Eastern
  'NYC_TZ'                  # …and its constant
  'nycStartOf'              # helpers named for that timezone
  'nycWeekday'
  'parknyc'                 # provider id / executor module / env names
  'PARKNYC'
  'parknycExecutor'
  'parknycConfirmation'     # DB column
  '"nyc"'                   # city key (zone-id prefix)
  "'nyc'"
  'nyc:'                    # city-keyed map literals
  'nyc-'                    # zone-id prefix
  'city: "New York"'        # Stripe cardholder billing address
  'PARKAGENT SHADOW'        # Stripe test-mode merchant descriptor
  'state: "NY"'
)

pattern_args=()
for allowed in "${ALLOWED_PATTERNS[@]}"; do
  pattern_args+=(-e "$allowed")
done

hits=$(
  # -n for line numbers; strip // and * comment lines before matching so an
  # explanatory comment never fails the build.
  grep -n -E 'NYC|New York|ParkNYC' $FILES 2>/dev/null \
    | grep -v -E '^[^:]+:[0-9]+: *(//|/\*|\*)' \
    | grep -v -F "${pattern_args[@]}" \
    || true
)

if [ -n "$hits" ]; then
  echo "City-neutral check FAILED — hardcoded city/provider names in user-facing strings:"
  echo
  echo "$hits"
  echo
  echo "Take the name from the provider registry (server: providerForCity/coveredCitiesSentence;"
  echo "iOS: CityCatalog / the provider block on the API response) or use neutral copy"
  echo "(\"your city\", \"your parking account\"). If this hit is an identifier rather than"
  echo "copy, add it to ALLOWED_PATTERNS in scripts/check-city-neutral.sh with a reason."
  exit 1
fi

echo "City-neutral check passed: no hardcoded city or provider names in user-facing strings."
