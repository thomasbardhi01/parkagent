# Apple Maps place search: one-time setup

The assistant finds the places people name — restaurants, bars, venues,
shops, hotels, landmarks — with the **Apple Maps Server API**
(`maps-api.apple.com`, the same search the Maps app runs), and gets its
walking times from it. Without it the server falls back to Nominatim
(OpenStreetMap), which knows streets and neighborhoods but few
businesses: on the 2026-09-25 device test, "Lola 42" and "Moo steakhouse"
both came back empty that way. Walks are then straight-line estimates,
and the card marks them.

**Why Apple Maps** over Google Places or Mapbox: it comes with the Apple
Developer membership we already pay for (a daily quota of 25,000 service
calls, shared across Maps Server API endpoints; ask Apple for more if it's
ever hit), needs no billing account, has good US POI coverage, and signs
with the same kind of `.p8` key as Sign in with Apple and APNs. Google Places
(New) has the best POI data, but it is pay-per-call with a billing account
and its terms restrict how results may be stored and shown. Mapbox Search
has thinner POI coverage.

## What you do by hand (about 10 minutes)

1. **Create a Maps ID.** Go to
   [developer.apple.com/account](https://developer.apple.com/account), then
   Certificates, Identifiers & Profiles → **Identifiers** → **+** → choose
   **Maps IDs** → Continue. Description: `ParkAgent server`. Identifier:
   `maps.com.thomasbardhi.parkagent`. Continue, then Register.
2. **Create a Maps key, or add Maps to the existing key.** Prod uses one
   key for push, Sign in with Apple, and Maps (CLAUDE.md, "Apple key"): open
   that key under **Keys**, tick **MapKit JS**, configure it with the Maps
   ID from step 1, and save; then the three `APPLE_MAPS_*` values are the
   same `.p8`, key id, and team as `APNS_*`. For a separate key instead:
   Certificates, Identifiers & Profiles → **Keys** → **+**. Key name: `ParkAgent Maps Server`. Tick **MapKit JS**. The box
   stays greyed out until step 1 exists; the same key signs Maps Server API
   tokens. Click **Configure** next to it, pick the Maps ID from step 1, and
   Save. Continue, then Register.
3. **Download the key** (`AuthKey_XXXXXXXXXX.p8`). Apple lets you download
   it **once**. Note the **Key ID** (10 characters, shown on the key's
   page) and your **Team ID** (Membership details, 10 characters). If you
   added Maps to the existing key in step 2, there's nothing to download:
   use the `.p8` you already keep for `APNS_KEY` (password manager), since
   Apple won't let you download it again.
4. **Check, then set, the three secrets on Fly.** All three or none: with
   one missing or malformed, Maps is off and `/health` lists `apple_maps`
   under `degraded`. The server still boots; until 2026-09-27 it refused
   to, which is the outage in docs/incidents.md. Check first. It catches a misspelled
   name, a `.p8` that isn't a key, and a `.p8` whose file name says a
   different key id. `--live` also asks Apple whether the key works:

   ```sh
   pnpm -C server check-secrets --live \
     APPLE_MAPS_KEY=@~/Downloads/AuthKey_XXXXXXXXXX.p8 \
     APPLE_MAPS_KEY_ID=XXXXXXXXXX \
     APPLE_MAPS_TEAM_ID=YYYYYYYYYY
   ```

   It prints the `fly secrets set` command when everything passes:

   ```sh
   fly secrets set -a parkagent-api \
     APPLE_MAPS_KEY="$(cat ~/Downloads/AuthKey_XXXXXXXXXX.p8)" \
     APPLE_MAPS_KEY_ID=XXXXXXXXXX \
     APPLE_MAPS_TEAM_ID=YYYYYYYYYY
   ```

   `fly secrets set` restarts the machines. Per CLAUDE.md, a restart
   reloads `policy.json` from the image, so check the dry-run and caps
   state afterwards, and that `curl -s https://parkagent-api.fly.dev/health`
   shows `"degraded":[]`.

   One Apple key can carry several services. On prod, one key with push,
   Sign in with Apple, and MapKit JS enabled fills the `APNS_*`,
   `APPLE_SIGNIN_*`, and `APPLE_MAPS_*` slots. The server logs a warning
   when two slots hold the same key; that's fine when the key has every
   service those slots need, and wrong when the key ids differ.
5. **For local runs**, add the same three lines to the repo-root `.env`.
   Literal newlines or `\n` escapes both work for the key.
6. **Check it:** `pnpm -C server verify:places` should resolve "Lola 42" to
   22 Liberty Dr, Seaport by `apple_search`, and "lola42" to the same
   place by `apple_autocomplete`; with `DATABASE_URL` set, the street
   options under each place show a walking time with no "~" (Apple's)
   rather than "~4 min" (the estimate). The same key and token serve all
   three endpoints, so there is nothing more to enable. Then delete the
   downloaded `.p8`, or store it in your password manager. Never commit it.

## How the server uses it

`services/assistant/appleMaps.ts` signs a Maps auth token (ES256 JWT:
header `{alg: ES256, kid: <key id>, typ: JWT}`, claims `{iss: <team id>,
iat, exp, scope: "server_api"}`). It trades that token at `GET /v1/token`
for a 30-minute access token, caches it, and refreshes once on a 401. The
access token authorizes three endpoints:

| Endpoint | When | Calls |
|---|---|---|
| `GET /v1/search` | Every place lookup: `limitToCountries=US`, `resultTypeFilter=Poi,Address`, ONE of `searchLocation` (the phone when it's in the city) or the city's `searchRegion` (Apple answers 400 when both are sent, which broke every search until #152), and the phone as `userLocation`. | 1, or 2 when the biased city has no match and the other is tried |
| `GET /v1/searchAutocomplete` | Only when the search is weak: nothing found, nothing carrying a word of the name, or a best score under 0.55 (`placeScore.ts` `searchIsWeak`). Same parameters as the search. Each completion is then one `GET` of its `completionUrl` (Apple's own relative `/v1/search?q=…&metadata=…`, with `lang=en-US` added). | 1, plus at most 3 completions, per city tried |
| `GET /v1/etas` | Per search of a named place, for the walk from the place to the options the search shows, then the nearest: `origin`, `destinations` (up to ten `lat,lng` pairs joined with `\|`), `transportType=Walking`. | 1 per search, and a second only when the real walks bring an untimed option into view |

- Results outside the covered metros are dropped. A biased search that
  finds nothing in its city tries the other cities, so the bias orders the
  search but never blinds it. A completion that says it is outside every
  covered city isn't fetched.
- Searches and their autocomplete results are cached for 10 minutes in
  memory. Walking times aren't cached.
- `FallbackGeocoder` tries Apple first and Nominatim second. A source that
  fails (network, quota, a revoked key) falls through to the next one.
  Only every source failing is a failure.
- `geocode_place` records on its decision row which source answered
  (`outcome.source`: `apple_search`, `apple_autocomplete`, or
  `nominatim`), the confidence, the scored candidates, and any source that
  failed (`outcome.failures`), so a quiet fallback to Nominatim shows up
  in the ledger with its reason.

## The quota

Apple allows **25,000 service calls a day per team**, shared by every Maps
Server API endpoint and MapKit JS, and answers **HTTP 429** past it. The
one key on prod is also the push and Sign in with Apple key, but those
services don't draw on this quota. A turn that names a place usually
costs 3 calls (a search and two walking-time requests); a weak search
adds an autocomplete request and up to three completions, and a city with
no match adds a pass over the other. A request that names no place calls
nothing.

A 429 is handled, not fatal:

- On a search it is the typed reason `"quota"`: Nominatim answers
  instead, and the decision row records `failures: [{provider:
  "apple_maps", reason: "quota"}]`.
- On autocomplete, the search's own answer stands
  (`{provider: "apple_autocomplete", reason: "quota"}`).
- On walking times, the options keep their straight-line estimates,
  marked `walkEstimate: true`.

To see whether it is happening: `pnpm -C server decisions:recent` and look
for `quota` on `assistant_tool` rows. A larger quota is a request to Apple
through the developer account.

Rotating the key: create a new one (step 2), set the secrets, then revoke
the old key in the portal.
