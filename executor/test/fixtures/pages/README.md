# Recorded fixture pages

Sanitized HTML snapshots of real ParkNYC screens, used by
`test/fixtures.test.ts`. Produce them with `pnpm -C executor run record` (the
per-step `NN-<step>.html` files land in `executor/fixtures/<run>/`), then:

1. **Sanitize**: remove your email, plate, card hints, cookies/tokens in
   inline scripts, and any account identifiers.
2. Name the file for what the test should assert:
   - `auth_expired--signin-wall.html`
   - `zone_not_found--bad-zone.html`
   - `payment_declined--card-refused.html`
   - `confirmation--start-receipt.html` (must fully parse)
   - `neutral--zone-entry.html` (must trip NO error classification)
3. Drop it here and run `pnpm -C executor run test`.

With no `.html` files present the fixture suite skips — the rest of the
unit tests still run.
