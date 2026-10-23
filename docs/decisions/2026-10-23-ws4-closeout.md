# 2026-10-23: WS-4 close-out

Status: **decided** by Thomas in the WS-4 review rounds (2026-10-22/23).
Only what [D0 and its addendum](2026-10-21-inputs-and-systems.md) don't
already say. Code as of `e56df7d`; flows in
[architecture.md](../architecture.md), code and tests in
[feature-map.md](../feature-map.md).

## Agents and arrival

1. **An agent's street confirm writes no park row** (#262 in #259; departs from D0 §4). It answers
   `pending_arrival`; the phone's next `/parked` is the only arrival, and E3 binds the plan to it once.
2. **Consent is read again at the bind** (#262): `agents_may_act` switched off between the confirm and
   the arrival means nothing binds.
3. **Only a `park_now` plan binds** (#304): refused, not held to its window, because the 10-minute
   mandate expires before a `park_later` window (over 15 minutes out) opens.
   *Open:* whether a bind notifies the driver (today: a decision row only).

## Money

4. **Receipt bound, beyond D0 §5 Q3** (#286): a receipt within $0.25 but above the amount shown is
   trimmed to it (flagged, the rest counted on top); a malformed receipt with a readable total counts
   total − price as `receipt_excess_usd`. Extensions don't read receipts yet (#294).
5. **An extension needs a usable provider account** (#296), as a start does (`providerStatusUsable`:
   `expiring` pays). The worker holds and pushes "Reconnect <provider>" with the link deep link.

## Where the car and the phone are

6. **Car moved** (#285): `movePark` is the one way a park moves on, and the newer-park check runs after
   its ledger row; a belt re-reads in the worker and in the gate under the lock. *Accepted:* `/parked`
   takes no extension lock, so a newer park during the provider's charge still buys that one extension, within the caps.
7. **Door rule** (#287, for #264): `left_car` is refused when distance − accuracy ≤ 10 m or accuracy >
   65 m; the walk is stored, the next off-door, not-fast fix asks again (`fix_away`), and only a second
   tap pays. It's forgotten on a usable fix within 30 m since, a pace > 3 m/s since, or `returned_to_car`.
   *Accepted residuals:* a walk with every fix worse than 65 m waits for a usable fix; an indoor errand
   within ~30 m on blurry fixes never prompts and expires.
8. **One position reader** (#301): `phonePosition` for the worker and the gate. Still reporting = report
   time (`ts`) within 5 min; the walking-back trend reads 10 min; a fix > 5 min in the future isn't
   stored; a usable fix within 30 m is `at_car`.

## Signs

9. **Sign accept** (#292, #302): never lengthens a stay, floors at what's paid, and every extension is
   judged against the accepted stay (`withAcceptedStay`) at all three judgment points. Minutes that
   aren't a positive integer are refused (`minutes_invalid`).

## Inputs

10. **Path ids** (#289, #299): one rule (letters, digits, `_`, `-`) on every path param but `:provider`,
    ≤ 64 for our ids (`recordId`), ≤ 100 for a zone's or Stripe's. A NUL that reaches Postgres is a 400,
    unless the provider was already asked (then 500, logged). Agents get our codes, never provider text.
11. **MCP annotations** (#303, for #280): reads `readOnlyHint: true`; `propose_plan`
    `destructiveHint: false`; `confirm_plan` left at the spec's default (destructive).

## Process (2026-10-23)

12. Thomas approved `server-pg` as a required check (not yet in branch protection, which requires
    `server`, `ios`, `executor`) and `ajv` as a test-only devDependency (#298).
13. Thomas overrode the working agreement to merge the last money PRs back to back without the other
    founder's read first. Nate reads #285, #286, #287, #292, #296, #301 and #302 after the fact, before `DRY_RUN=false`.
