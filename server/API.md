# ParkAgent API

Contract for the Phase 3 server. This file is the source of truth for the
HTTP surface; change it in the same PR as the code it describes.

Base URL: `https://parkagent-api.fly.dev` (prod) · `http://localhost:3000` (dev).
All bodies are JSON. All timestamps are ISO 8601 with offset. All money is
USD as a decimal number of dollars (e.g. `7.28`).

## Authentication

Every endpoint except `GET /health` requires the header:

    x-api-key: <users.api_key>

Unknown or missing key → `401 {"error": "unauthorized"}`. Keys are created
with `pnpm -C server create:user -- --name <name>` and live only in the
`users` table.

## Dry run

`DRY_RUN` (env) and `dry_run` (policy.json) are independent switches; money
can move only when **both** are false. `/parked` itself never moves money —
it only quotes — but every response and every `decisions` row records the
effective `dryRun` so the week-one dry run is auditable.

---

## POST /parked

Phone-detected park. Runs zone lookup → policy check, writes a
`parked_events` row and **always** writes a `decisions` row, then returns
what the app should do.

Request:

```json
{
  "lat": 40.7784,            // WGS84
  "lng": -73.9818,
  "accuracy": 12.5,          // horizontal accuracy, meters
  "ts": "2026-09-20T14:03:22-04:00",   // when the phone detected the park
  "signals": ["motion_stop", "bt_disconnect"]   // free-form detector evidence
}
```

Response `200`:

```json
{
  "action": "pay",           // "pay" | "confirm" | "ignore" | "unknown_zone"
  "candidates": [ Candidate, ... ],
  "quote": Quote | null,     // null only for unknown_zone
  "rule": "auto_pay_ok",     // which rule produced the action (see below)
  "dryRun": true,
  "parkedEventId": "…",
  "decisionId": "…"
}
```

### Candidate

One plausible block face for the fix, ranked by distance to the face's
centerline:

```json
{
  "zoneId": "nyc-110436",
  "parknycZoneNumber": "110436",
  "distanceM": 9.3,            // meters, point → centerline
  "containsPoint": true,       // fix landed inside the buffered lane polygon
  "rateFirstHourUsd": 5.0,
  "rateAdditionalHourUsd": 8.25,   // 2nd-hour price (see data/build_zones.py)
  "maxStayMinutes": 120,
  "hours": [{ "days": ["Mon", "..."], "start": "08:00", "end": "19:00" }],
  "quote": Quote               // what this candidate would cost
}
```

### Quote

Cost of the default stay in a zone, priced only over enforced minutes:

```json
{
  "zoneId": "nyc-110436",
  "parknycZoneNumber": "110436",
  "stayMinutes": 90,        // min(policy.default_stay_minutes, zone max stay)
  "chargedMinutes": 90,     // minutes of the stay inside enforcement hours
  "meterUsd": 7.13,         // rate ladder applied to chargedMinutes
  "feeUsd": 0.15,           // policy.parknyc_fee_usd; 0 when meterUsd is 0
  "totalUsd": 7.28
}
```

Pricing: charged minutes consume the ladder in order — the first 60 at
`rateFirstHourUsd` (prorated), everything after at `rateAdditionalHourUsd`
(prorated). Minutes of the stay outside the zone's posted hours cost
nothing. A zone with `hours: []` (nothing posted) is treated as always
enforced. `respect_enforcement_hours: false` in policy also treats every
zone as always enforced. Rounding: half-up to the cent, once, on each of
`meterUsd`/`feeUsd`/`totalUsd`.

### How the action is chosen

Lookup returns every zone whose centerline is within
`max(accuracy, 25) meters` of the fix, ranked by centerline distance.

Two candidates **agree** when their rate ladder (both values), max stay, and
minute-by-minute enforcement status over the next 60 minutes all match.
Differing posted hours that behave identically for the next hour still
agree.

| Rule (in order) | Condition | Action | candidates[] |
|---|---|---|---|
| `unknown_zone` | no candidate in radius | `unknown_zone` | `[]`, quote `null` |
| `candidates_disagree` | some candidate disagrees with the nearest | `confirm` | nearest + nearest disagreeing, each with its own quote; top-level quote is the nearest's |
| `free_period` | all agree, `totalUsd` is 0 | `ignore` | nearest only |
| `rate_above_ceiling` | ladder max > `auto_pay_max_rate_per_hour` | `confirm` | nearest only |
| `session_cap_exceeded` | `totalUsd` > `session_cap_usd` | `confirm` | nearest only |
| `daily_cap_exceeded` | today's session spend + `totalUsd` > `daily_cap_usd` | `confirm` | nearest only |
| `auto_pay_ok` | none of the above | `pay` | nearest only |

Every `/parked` call writes a `decisions` row: `inputs` (request body, radius,
candidate zone ids, effective dry run, policy hash), `rule`, `outcome`
(action + quote).

Errors: `400` invalid body (zod details in `error`), `401` bad key.

---

## POST /session/start · /session/stop · /session/extend

**Not implemented yet — return `501 {"error": "not_implemented"}`.**
(Phase 5 wires these to the executor; they are the money-moving paths and
will check `DRY_RUN` + policy before anything else.)

Planned shapes, so the app can stub against them:

- `POST /session/start` `{parkedEventId, zoneId, minutes}` → `{sessionId, expiresAt, amountUsd}`
- `POST /session/stop` `{sessionId}` → `{sessionId, stoppedAt}`
- `POST /session/extend` `{sessionId, minutes}` → `{sessionId, expiresAt, amountUsd}`

## POST /location

**Not implemented yet — returns `501`.** (Phase 7's extender consumes it;
there is no table for fixes yet.) Planned: `{lat, lng, accuracy, ts}` while
a session is active, every 60 s.

---

## GET /policy

Returns the active policy plus bookkeeping:

```json
{
  "policy": { …policy.json… },
  "hash": "sha256:…",        // canonical-JSON hash, matches policy_snapshots
  "dryRun": true             // effective: env DRY_RUN || policy.dry_run
}
```

## PUT /policy

Full replacement of the policy document. Body is the entire policy object
(same schema as `policy.json`; unknown keys rejected). On success the file
is rewritten, a `policy_snapshots` row is recorded (`source: "put"`), and
the new `GET /policy` payload is returned. `400` on validation failure with
zod details.

Note: on Fly the filesystem is ephemeral — a `PUT` there lasts until the
next deploy. The repo's `policy.json` stays the source of truth; snapshots
give the audit trail either way.

### policy.json schema

```json
{
  "dry_run": true,
  "session_cap_usd": 45,
  "daily_cap_usd": 60,
  "auto_pay_max_rate_per_hour": 8.0,
  "default_stay_minutes": 90,
  "parknyc_fee_usd": 0.15,
  "auto_extend": {
    "enabled": true,
    "max_count": 2,
    "max_minutes_each": 60,
    "no_extend_within_minutes_of_max_stay": 15
  },
  "respect_enforcement_hours": true,
  "ticket_cost_usd": 65
}
```

The server validates and snapshots (`source: "boot"`) at boot, and refuses
to start on an invalid file.

---

## GET /health

No auth. `{ok, dryRun, commit, builtAt}`.
