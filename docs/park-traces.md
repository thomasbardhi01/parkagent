# Park traces: turning a field-test park into a regression test

Every park the server holds keeps its evidence. Each `POST /location` fix
the park read, or refused and why, goes in `park_fixes` (kept 30 days).
Its decisions, its session, and that session's events live where they
always have. A **trace** is all of that for one park, as one document. A
**fixture** is a trace with nothing that names the driver, which the
lifecycle can replay.

## 1. Find the park

From the driver's report ("it asked me to pay at a red light, 2:40 PM"),
find the park in `pnpm -C server decisions:recent --user <name>`. A
`street_pending` or `street_prompt` row carries its `parkedEventId`.

## 2. Look at it

    curl -s -H "x-api-key: $ADMIN_KEY" \
      https://parkagent-api.fly.dev/admin/parks/<parkedEventId>/trace | jq

`fixes` shows what the phone sent. `rejected` on a fix says the park
didn't read it (`before_park`, `stale_measurement`, `clock_skew`,
`park_starting`). `decisions` shows what the server did with the rest,
and `timeline` when the park moved.

## 3. Export it

    pnpm -C server trace:export <parkedEventId> --name red-light-steinway \
      --out server/test/traces/red-light-steinway.json

This reads `DATABASE_URL` (repo-root `.env`, or export one pointed at
prod through the Fly proxy; see `server/README.md`). The fixture has
coordinates in metres north and east of the car, times in seconds after
the park, the start as a weekday and a New York time, the candidate zones'
terms, and the taps. It has no user id, no latitude or longitude, and no
date.

It **does** keep the zone and its number (`417371`), on purpose: the
replay re-quotes the park from those terms. With a weekday and a time,
that can still say "someone parked on this block on Mondays at 2 PM",
and at field-test scale "someone" is one of a few people. So **a fixture
made from a real park is reviewed before it is committed**: by the
person whose park it is, or with their say-so. A fixture goes into a
public repo.

## 4. Replay it

    pnpm -C server trace:replay server/test/traces/red-light-steinway.json

The replay drives the real `/parked`, `/location` and tap routes over the
test fake DB, on a clock it moves, with the car at a fixed point and the
park on that weekday and time in the week of 2026-01-05. It prints every
step with the park's status after it, then the outcome: the statuses the
park passed through, where it ended, its session's status, and how many
starts reached the executor.

## 5. Say what it should have done

Add `expected` to the fixture: what the park **should** have done, not
what it did. For a bug, that is the outcome the fix must produce:

    "expected": { "statuses": ["at_car", "confirmed", "prompted"],
                  "park": "prompted", "session": null, "starts": 0 }

`server/test/traces/golden.test.ts` replays every fixture in that
directory against its `expected`. A fixture for a bug fails until the
fix lands; that is the test that fails before the fix. Commit it with the
fix.

## The seeds

| Fixture | What it holds |
|---|---|
| `normal-walk-away` | in the seat, two fixes clear of the car at a walk, Pay: one session |
| `red-light` | Pay at the car, then a red light a block away: asked again, nothing paid |
| `get-in-and-drive` | back in the car and driving without ever leaving: cancelled |
| `heartbeat-resend` | one seat measurement re-sent by the heartbeat for 90 s is no return; only `measuredAt` says so |

## Limits

- A fixture replays the server's rules over what the phone **sent**. It
  can't show what the phone sensed but never sent, or sent and lost.
- `timeline` comes from the park row, which keeps the latest of each
  timestamp; the replay's `statuses` and the decisions are the full path.
- Motion and car-audio fields (`motionActivity`, `motionConfidence`,
  `btHint`) are kept and replayed, but no server rule reads them yet.
- The park row doesn't keep the `outcomes` the phone sent with `/parked`.
  An export writes the list a build that waits for the walk-away sends
  (`garage`, `nopay`, `walk_away`): every held park came from one.
- A fix the server never read against the park isn't on its trace. That
  is the fix whose request found the park already closed, for example the
  one on which it ran out of time, or one answered 409. The decisions
  still say when it closed.
