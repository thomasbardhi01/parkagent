#!/usr/bin/env bash
# Boots the real server (node server/dist/index.js) and fails unless it comes
# up and stays up.
#
#   scripts/boot-check.sh off   # every optional feature off (required env only)
#   scripts/boot-check.sh on    # every optional feature on, dummy but
#                               # well-formed values
#
# Needs: a built server (pnpm -C executor run build && pnpm -C server build),
# DATABASE_URL pointing at a migrated database (prisma migrate deploy), curl,
# and openssl. CI runs both modes before deploy (.github/workflows/ci.yml).
#
# Unit tests build the app through buildApp() with fakes, so they never run
# index.ts. That's how #130 shipped a boot that threw before listen: a logger
# reached `app` before it existed, which only `node dist/index.js` shows.
#
# Every optional env var in server/src/env.ts belongs in both lists below:
# unset in "off", set in "on". A new optional feature gets a line in each.
#
# Asserts, per mode:
#   1. /health answers 200 with ok:true (the process got to listen)
#   2. /auth/methods reports exactly this mode's sign-in methods, so the "on"
#      boot really had the features on and isn't the "off" boot twice
#   3. the process is still alive and /health still answers a few seconds
#      later, after the background jobs' first ticks have run

set -euo pipefail

MODE="${1:-}"
if [[ "$MODE" != "off" && "$MODE" != "on" ]]; then
  echo "usage: $0 off|on" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$ROOT/server/dist/index.js"
PORT="${BOOT_CHECK_PORT:-3999}"
SETTLE_SECONDS="${BOOT_CHECK_SETTLE_SECONDS:-8}"

if [[ ! -f "$ENTRY" ]]; then
  echo "boot-check: $ENTRY missing; build first (pnpm -C executor run build && pnpm -C server build)" >&2
  exit 2
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "boot-check: DATABASE_URL must point at a migrated database" >&2
  exit 2
fi
# The server loads the repo-root .env, and dotenv fills in whatever is unset.
# That would quietly switch features on in the "off" run.
if [[ -f "$ROOT/.env" ]]; then
  echo "boot-check: $ROOT/.env exists and would leak into the boot; run from a checkout without one" >&2
  exit 2
fi

OPTIONAL_VARS=(
  STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_FINANCIAL_ACCOUNT STRIPE_PAYOUT_RECIPIENT
  APNS_KEY APNS_KEY_ID APNS_TEAM_ID APNS_BUNDLE_ID
  ISSUING_LIVE
  PROVIDER_STATE_KEY
  APPLE_AUDIENCE APPLE_SIGNIN_KEY APPLE_SIGNIN_KEY_ID APPLE_SIGNIN_TEAM_ID
  EMAIL_SIGNIN_ENABLED RESEND_API_KEY RESEND_FROM
  GOOGLE_SIGNIN_ENABLED GOOGLE_CLIENT_ID
  PARKNYC_PLATE
  ANTHROPIC_API_KEY ASSISTANT_MODEL ANTHROPIC_MODEL EXPLAIN_MODEL ASSISTANT_DAILY_SPEND_CAP_USD
  PARKWHIZ_ENABLED
  LINK_CLIENT_ID LINK_CLIENT_SECRET LINK_PUBLISHABLE_KEY LINK_REDIRECT_URI LINK_TEST_MODE
)
for var in "${OPTIONAL_VARS[@]}"; do unset "$var"; done

# Required in both modes.
export API_KEY_PEPPER="boot-check-pepper-0123456789"
export SOCRATA_APP_TOKEN="boot-check-socrata"
export AUTH_JWT_SECRET="boot-check-jwt-secret-0123456789abcdef"
export PORT

# A throwaway P-256 key in PKCS#8 PEM, the shape of an Apple .p8.
p8_key() {
  openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt
}

if [[ "$MODE" == "off" ]]; then
  export DRY_RUN=true
  export ISSUING_LIVE=false
  export EMAIL_SIGNIN_ENABLED=false
  export GOOGLE_SIGNIN_ENABLED=false
  export PARKWHIZ_ENABLED=false
  EXPECTED_METHODS='{"apple":true,"email":false,"google":false}'
else
  # Live mode against an empty database: no users, sessions, or linked
  # accounts, and keys no real service accepts, so nothing can pay.
  export DRY_RUN=false
  export STRIPE_SECRET_KEY="sk_test_bootcheck0000000000000000"
  export STRIPE_WEBHOOK_SECRET="whsec_bootcheck0000000000000000"
  export STRIPE_FINANCIAL_ACCOUNT="fa_bootcheck0000000000"
  export STRIPE_PAYOUT_RECIPIENT="acct_bootcheck0000000000"
  APNS_KEY="$(p8_key)"
  export APNS_KEY
  export APNS_KEY_ID="BOOTCHECK1"
  export APNS_TEAM_ID="BOOTCHECK2"
  export APNS_BUNDLE_ID="com.thomasbardhi.parkagent"
  export ISSUING_LIVE=true
  PROVIDER_STATE_KEY="$(openssl rand -base64 32)"
  export PROVIDER_STATE_KEY
  export APPLE_AUDIENCE="com.thomasbardhi.parkagent"
  APPLE_SIGNIN_KEY="$(p8_key)"
  export APPLE_SIGNIN_KEY
  export APPLE_SIGNIN_KEY_ID="BOOTCHECK3"
  export APPLE_SIGNIN_TEAM_ID="BOOTCHECK2"
  export EMAIL_SIGNIN_ENABLED=true
  export RESEND_API_KEY="re_bootcheck_0000000000000000"
  export RESEND_FROM="ParkAgent <sign-in@example.com>"
  export GOOGLE_SIGNIN_ENABLED=true
  export GOOGLE_CLIENT_ID="000000000000-bootcheck.apps.googleusercontent.com"
  export PARKNYC_PLATE="BOOT123"
  export ANTHROPIC_API_KEY="sk-ant-bootcheck-0000000000000000"
  export ASSISTANT_MODEL="claude-sonnet-5"
  export ANTHROPIC_MODEL="claude-sonnet-5"
  export EXPLAIN_MODEL="claude-haiku-4-5-20251001"
  export ASSISTANT_DAILY_SPEND_CAP_USD=5
  export PARKWHIZ_ENABLED=true
  export LINK_CLIENT_ID="link_bootcheck"
  export LINK_CLIENT_SECRET="link_bootcheck_secret"
  export LINK_PUBLISHABLE_KEY="pk_test_bootcheck0000000000000000"
  export LINK_REDIRECT_URI="https://example.com/link/callback"
  export LINK_TEST_MODE=true
  EXPECTED_METHODS='{"apple":true,"email":true,"google":true}'
fi

LOG="$(mktemp -t boot-check.XXXXXX)"
# From server/, as in the image (WORKDIR /app/server).
(cd "$ROOT/server" && exec node dist/index.js) >"$LOG" 2>&1 &
PID=$!

stop_server() {
  if kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "$PID" 2>/dev/null || true
  fi
  wait "$PID" 2>/dev/null || true
}

fail() {
  echo "boot-check ($MODE): FAIL — $1" >&2
  stop_server
  echo "---- server output ----" >&2
  cat "$LOG" >&2
  rm -f "$LOG"
  exit 1
}

get() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT$1"; }

health=""
for _ in $(seq 1 60); do
  kill -0 "$PID" 2>/dev/null || fail "server exited during startup"
  if health="$(get /health 2>/dev/null)"; then break; fi
  sleep 1
done
[[ -n "$health" ]] || fail "/health did not answer within 60s"
[[ "$health" == *'"ok":true'* ]] || fail "/health answered without ok:true: $health"

methods="$(get /auth/methods)" || fail "/auth/methods did not answer"
[[ "$methods" == "$EXPECTED_METHODS" ]] ||
  fail "/auth/methods is $methods, expected $EXPECTED_METHODS"

sleep "$SETTLE_SECONDS"
kill -0 "$PID" 2>/dev/null || fail "server exited within ${SETTLE_SECONDS}s of answering /health"
get /health >/dev/null || fail "/health stopped answering after ${SETTLE_SECONDS}s"

stop_server
echo "boot-check ($MODE): OK — /health $health; /auth/methods $methods"
rm -f "$LOG"
