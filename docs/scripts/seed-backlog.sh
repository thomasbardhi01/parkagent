#!/usr/bin/env bash
# Seeds the ParkAgent backlog into GitHub Issues and adds each one to your project board.
#
# Usage:
#   ./seed-backlog.sh <owner>/<repo> <project-number>
# Example:
#   ./seed-backlog.sh yourname/parkagent 1
#
# Find the project number in the board URL: github.com/users/<you>/projects/<NUMBER>
#
# Prereqs (run once):
#   gh auth login
#   gh auth refresh -s project
#   gh label create ios --color 1D76DB 2>/dev/null; gh label create server --color 5319E7 2>/dev/null
#   gh label create data --color 0E8A16 2>/dev/null; gh label create executor --color D93F0B 2>/dev/null
#   gh label create infra --color 6E6E6E 2>/dev/null

set -euo pipefail

REPO="${1:?repo required, e.g. yourname/parkagent}"
PROJECT="${2:?project number required}"
OWNER="${REPO%%/*}"

create() {
  local label="$1" title="$2" body="$3"
  local url
  url=$(gh issue create --repo "$REPO" --label "$label" --title "$title" --body "$body")
  gh project item-add "$PROJECT" --owner "$OWNER" --url "$url" >/dev/null
  echo "created  [$label]  $title"
}

# ---------- Phase 2: zone data ----------
create data "Fetch ParkNYC block faces and rate zones from NYC Open Data" \
"Write data/fetch_nyc.py. Pull the ParkNYC block-face dataset and the citywide rate-zone dataset as GeoJSON via the Socrata API using SOCRATA_APP_TOKEN. Save raw files to data/raw/."

create data "Build zones.geojson from block faces" \
"Write data/build_zones.py. For each block face produce {zone_id, parknyc_zone_number, rate_first_hour, rate_additional_hour, max_stay_minutes, hours_json, geometry}. Buffer each block-face line ~12 m into a polygon. Output data/out/zones.geojson."

create data "Load zones into Postgres with PostGIS" \
"Prisma migration for a zones table with a geometry column and GiST index. Loader script that upserts from zones.geojson into the Neon dev database."

create data "Verify zone lookup on 10 known blocks" \
"Pick 10 blocks we park on. Query point-in-polygon for each and compare to the ParkNYC app and the posted sign. Record mismatches in a table in the issue. This is the accuracy baseline."

# ---------- Phase 3: server ----------
create server "Prisma schema: users, vehicles, zones, parked_events, sessions, decisions, policy_snapshots" \
"Define the core tables. Every automated decision must be recordable with its inputs in decisions."

create server "Policy service that loads and enforces policy.json" \
"Implement session cap, daily cap, rate ceiling, enforcement-hours check, default stay, and the auto-extend rules. Expose GET/PUT /policy. Everything money-related checks DRY_RUN first."

create server "POST /parked endpoint with zone lookup and quote" \
"Accept {lat, lng, accuracy, ts, signals[]}. Run zone lookup, apply policy, return {action: pay|confirm|ignore|unknown_zone, zone, quote}. Write a decisions row."

create server "Session endpoints: start, stop, extend" \
"POST /session/start, /session/stop, /session/extend. Call the executor. In DRY_RUN, log the would-be action instead of executing."

create server "POST /location for in-session phone location" \
"Store periodic phone fixes during an active session. Feeds the extension worker."

create server "APNs push notifications" \
"Send pushes using the APNs key. Four templates: session started, extension applied, needs confirmation, max-stay warning."

create infra "Fly.io deploy pipeline" \
"fly launch, attach Fly Postgres with PostGIS, set secrets, add a deploy job to CI that runs on merge to main using FLY_API_TOKEN."

create infra "API contract doc for iOS" \
"Write server/API.md with request/response shapes for /parked, /session/*, /location, /policy so the iOS app can be built against a stub."

# ---------- Phase 4: iOS ----------
create ios "Project setup: capabilities, plist strings, xcconfig" \
"Enable Push Notifications, Background Modes (location, remote-notification, processing), Time Sensitive Notifications. Add location and motion usage strings. Add Config.xcconfig for API_BASE_URL."

create ios "ParkDetector: motion + location + Bluetooth signals" \
"CMMotionActivityManager for automotive-to-stationary transition, CLLocationManager burst for resting coordinate, AVAudioSession route change for car audio disconnect. Fire parked when two of three agree within ~60s. Debounce 3 minutes."

create ios "Store car location and report parked events to the server" \
"Persist the resting coordinate locally. POST /parked with signals. Handle pay / confirm / ignore / unknown_zone responses."

create ios "Background location reporter during active sessions" \
"Send phone location to POST /location every 60s while a session is active. Stop when it ends."

create ios "Main screen: current session, confirm card, stop button, decision log" \
"Single SwiftUI screen showing zone, expiry countdown, spend, a confirm/decline card when required, and the last 20 decisions."

create ios "Policy editor screen" \
"Read and edit policy.json values via GET/PUT /policy."

create ios "Push notification handling" \
"Register for APNs, send device token to server, display the four notification types, deep-link into the session screen."

# ---------- Phase 5: executor ----------
create executor "Capture the ParkNYC web flow" \
"Manually walk sign-in, zone entry, vehicle selection, duration, confirm. Save selectors and screenshots as the spec."

create executor "Playwright: startSession, extendSession, stopSession" \
"Implement the three functions returning {ok, sessionId, expiresAt, amount} or a typed error. Screenshot on failure and attach to the decisions row."

create executor "Persist browser auth state as a Fly secret" \
"Store storageState.json outside the repo and load it at runtime so we don't log in every call."

create executor "Fallback: tap-to-pay notification when executor fails" \
"If the executor errors, send a push with the zone number and a deep link so the user pays manually."

# ---------- Phase 6: Stripe ----------
create server "Stripe Issuing test mode: cardholder, virtual card, spend controls" \
"Create cardholder and card. Allowed MCC parking_lots_garages. Per-authorization and daily limits from policy.json."

create server "Real-time authorization webhook" \
"Handle issuing_authorization.request at /webhooks/stripe. Approve only if amount fits remaining daily budget and a session is pending. Exercise with stripe listen and the Stripe CLI."

# ---------- Phase 7: extension worker ----------
create server "Extension tick worker (60s) with cost-based rule" \
"For each active session compute remaining time, walking ETA, heading, P(return in time), and compare expected ticket cost vs extension cost. Extend to P80 of predicted dwell, capped by max stay and budget. 5-minute hysteresis."

create server "Dwell model v1: median of past sessions per location" \
"Fallback to default_stay_minutes when no history. Store predictions vs actuals for later learning."

# ---------- Phase 8: testing ----------
create infra "Dry-run week: track detection precision, recall, zone accuracy" \
"Run with dry_run=true for 7 days. Review the decisions table nightly. Log false parks, missed parks, zone mismatches, quote vs actual."

create infra "Assisted week: real executor, confirm-only, one extension max" \
"dry_run=false, auto_pay=false. Every session needs a tap. Extension worker live but capped."

create infra "Autonomous milestone: five clean days" \
"Auto-pay under the rate ceiling, confirm above it. Ship milestone is five consecutive days with zero tickets and no manual intervention."

echo
echo "Done. Open the board and set the Area field on each card (or group by label)."
