#!/usr/bin/env bash
# Boots the real server (node server/dist/index.js) and fails unless it comes
# up and stays up.
#
#   scripts/boot-check.sh off     # every optional feature off (core env only)
#   scripts/boot-check.sh on      # every optional feature on, dummy but
#                                 # well-formed values
#   scripts/boot-check.sh broken  # every optional feature misconfigured:
#                                 # partial sets, wrong formats, a misspelled
#                                 # name. The server must still come up.
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
# unset in "off", set in "on". A new optional feature gets a line in each,
# and a broken value in "broken".
#
# Asserts, per mode:
#   1. /health answers 200 with ok:true (the process got to listen), and
#      lists exactly this mode's degraded features: none for off and on,
#      every optional feature for broken. On 2026-09-26 a misnamed Maps
#      secret refused boot and took prod down for four hours
#      (docs/incidents.md); "broken" is that, and every mistake like it.
#   2. /auth/methods reports exactly this mode's sign-in methods, so the "on"
#      boot really had the features on and isn't the "off" boot twice
#   3. the process is still alive and /health still answers a few seconds
#      later, after the background jobs' first ticks have run

set -euo pipefail

MODE="${1:-}"
if [[ "$MODE" != "off" && "$MODE" != "on" && "$MODE" != "broken" ]]; then
  echo "usage: $0 off|on|broken" >&2
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
  SOCRATA_APP_TOKEN
  STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_FINANCIAL_ACCOUNT STRIPE_PAYOUT_RECIPIENT
  APNS_KEY APNS_KEY_ID APNS_TEAM_ID APNS_BUNDLE_ID
  ISSUING_LIVE
  PROVIDER_STATE_KEY EXECUTOR_CONCURRENCY EXECUTOR_WARM_AT_BOOT
  APPLE_AUDIENCE APPLE_SIGNIN_KEY APPLE_SIGNIN_KEY_ID APPLE_SIGNIN_TEAM_ID
  APPLE_MAPS_KEY APPLE_MAPS_KEY_ID APPLE_MAPS_TEAM_ID
  EMAIL_SIGNIN_ENABLED RESEND_API_KEY RESEND_FROM
  GOOGLE_SIGNIN_ENABLED GOOGLE_CLIENT_ID
  PARKNYC_PLATE
  ANTHROPIC_API_KEY ASSISTANT_MODEL ANTHROPIC_MODEL EXPLAIN_MODEL ASSISTANT_DAILY_SPEND_CAP_USD
  ASSISTANT_CONVERSATION_RETENTION_DAYS
  PARKWHIZ_ENABLED
  LINK_CLIENT_ID LINK_CLIENT_SECRET LINK_PUBLISHABLE_KEY LINK_REDIRECT_URI LINK_TEST_MODE
)
for var in "${OPTIONAL_VARS[@]}"; do unset "$var"; done
# The misspelling "broken" sets, in case the caller's shell has it.
unset APPLE_MAPS_PRIVATE_KEY

# The core, in every mode.
export API_KEY_PEPPER="boot-check-pepper-0123456789"
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
  export EXECUTOR_WARM_AT_BOOT=false
  EXPECTED_METHODS='{"apple":true,"email":false,"google":false}'
  EXPECTED_DEGRADED='[]'
elif [[ "$MODE" == "broken" ]]; then
  # One mistake per optional feature. None of them may stop the boot; each
  # switches its feature off and shows in /health's degraded list.
  export DRY_RUN="True"                                     # unreadable → dry run
  PROVIDER_STATE_KEY="$(openssl rand -base64 32)"
  export PROVIDER_STATE_KEY
  export EXECUTOR_WARM_AT_BOOT=false
  export EXECUTOR_CONCURRENCY=99                            # falls back to 2
  export APNS_KEY="AuthKey_BOOTCHECK1.p8"                   # a file name, not its contents
  export APNS_KEY_ID="BOOTCHECK1"
  export APNS_TEAM_ID="BOOTCHECK2"
  export APNS_BUNDLE_ID="com.thomasbardhi.parkagent"
  export STRIPE_SECRET_KEY="sk_test_bootcheck0000000000000000" # no webhook secret
  export ISSUING_LIVE="yes"
  export LINK_CLIENT_ID="link_bootcheck"                    # one of four
  APPLE_SIGNIN_KEY="$(openssl genrsa 2048 2>/dev/null | openssl pkcs8 -topk8 -nocrypt)" # RSA, not EC
  export APPLE_SIGNIN_KEY
  export APPLE_SIGNIN_KEY_ID="BOOTCHECK3"
  export APPLE_SIGNIN_TEAM_ID="BOOTCHECK2"
  # 2026-09-26: the Maps key under a name the server doesn't read.
  APPLE_MAPS_PRIVATE_KEY="$(p8_key)"
  export APPLE_MAPS_PRIVATE_KEY
  export APPLE_MAPS_KEY_ID="BOOTCHECK4"
  export APPLE_MAPS_TEAM_ID="BOOTCHECK2"
  export EMAIL_SIGNIN_ENABLED=true                          # no RESEND_API_KEY
  export GOOGLE_SIGNIN_ENABLED=true
  export GOOGLE_CLIENT_ID="12345"                           # not a client id
  export PARKWHIZ_ENABLED="nope"
  export ANTHROPIC_API_KEY="sk-proj-bootcheck0000"          # not an Anthropic key
  EXPECTED_METHODS='{"apple":true,"email":false,"google":false}'
  EXPECTED_DEGRADED='["live_payments","push","stripe","issuing","link_wallet","apple_signin_revoke","apple_maps","email_signin","google_signin","parkwhiz","assistant"]'
else
  # Live mode against an empty database: no users, sessions, or linked
  # accounts, and keys no real service accepts, so nothing can pay.
  export DRY_RUN=false
  export SOCRATA_APP_TOKEN="boot-check-socrata"
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
  # The warm-up runs (and, with no Chromium on the runner, fails and is
  # logged); the server must stay up either way.
  export EXECUTOR_CONCURRENCY=2
  export EXECUTOR_WARM_AT_BOOT=true
  export APPLE_AUDIENCE="com.thomasbardhi.parkagent"
  APPLE_SIGNIN_KEY="$(p8_key)"
  export APPLE_SIGNIN_KEY
  export APPLE_SIGNIN_KEY_ID="BOOTCHECK3"
  export APPLE_SIGNIN_TEAM_ID="BOOTCHECK2"
  APPLE_MAPS_KEY="$(p8_key)"
  export APPLE_MAPS_KEY
  export APPLE_MAPS_KEY_ID="BOOTCHECK4"
  export APPLE_MAPS_TEAM_ID="BOOTCHECK2"
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
  export ASSISTANT_CONVERSATION_RETENTION_DAYS=90
  export PARKWHIZ_ENABLED=true
  export LINK_CLIENT_ID="link_bootcheck"
  export LINK_CLIENT_SECRET="link_bootcheck_secret"
  export LINK_PUBLISHABLE_KEY="pk_test_bootcheck0000000000000000"
  export LINK_REDIRECT_URI="https://example.com/link/callback"
  export LINK_TEST_MODE=true
  EXPECTED_METHODS='{"apple":true,"email":true,"google":true}'
  EXPECTED_DEGRADED='[]'
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
[[ "$health" == *"\"degraded\":$EXPECTED_DEGRADED"* ]] ||
  fail "/health's degraded list isn't $EXPECTED_DEGRADED: $health"
if [[ "$MODE" == "broken" ]]; then
  # The log names what went wrong, including the misspelling's fix.
  grep -q "did you mean APPLE_MAPS_KEY?" "$LOG" || fail "no 'did you mean APPLE_MAPS_KEY?' in the log"
  grep -q "config: apple_maps is off" "$LOG" || fail "no 'config: apple_maps is off' line in the log"
fi

# Readiness: the server reaches its (migrated) database.
ready="$(get /health/ready)" || fail "/health/ready did not answer 200"
[[ "$ready" == *'"db":"ok"'* ]] || fail "/health/ready answered without db ok: $ready"

methods="$(get /auth/methods)" || fail "/auth/methods did not answer"
[[ "$methods" == "$EXPECTED_METHODS" ]] ||
  fail "/auth/methods is $methods, expected $EXPECTED_METHODS"

sleep "$SETTLE_SECONDS"
kill -0 "$PID" 2>/dev/null || fail "server exited within ${SETTLE_SECONDS}s of answering /health"
get /health >/dev/null || fail "/health stopped answering after ${SETTLE_SECONDS}s"

# Graceful shutdown: SIGTERM must end in a clean exit 0 well inside
# fly.toml's kill_timeout (30 s) — not a hang, not a crash.
kill -TERM "$PID"
exited=""
for _ in $(seq 1 50); do
  if ! kill -0 "$PID" 2>/dev/null; then exited=1; break; fi
  sleep 0.5
done
[[ -n "$exited" ]] || fail "server still running 25s after SIGTERM"
set +e
wait "$PID"
code=$?
set -e
[[ "$code" == "0" ]] || fail "server exited $code after SIGTERM, expected 0"
grep -q "shutdown complete" "$LOG" || fail "no 'shutdown complete' in the log after SIGTERM"

echo "boot-check ($MODE): OK — /health $health; /health/ready $ready; /auth/methods $methods; SIGTERM → exit 0"
# What the server said about its settings (env.ts), for the CI log.
grep -oE '"msg":"config: ([^"\\]|\\.)*' "$LOG" | sed -e 's/^"msg":"/  /' -e 's/\\"/"/g' || true
rm -f "$LOG"
