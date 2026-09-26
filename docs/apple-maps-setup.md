# Apple Maps place search: one-time setup

The assistant finds the places people name — restaurants, bars, venues,
shops, hotels, landmarks — with the **Apple Maps Server API**
(`maps-api.apple.com`, the same search the Maps app runs). Without it the
server falls back to Nominatim (OpenStreetMap), which knows streets and
neighborhoods but few businesses: on the 2026-09-25 device test, "Lola 42"
and "Moo steakhouse" both came back empty that way.

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
2. **Create a Maps key.** Certificates, Identifiers & Profiles → **Keys** →
   **+**. Key name: `ParkAgent Maps Server`. Tick **MapKit JS**. The box
   stays greyed out until step 1 exists; the same key signs Maps Server API
   tokens. Click **Configure** next to it, pick the Maps ID from step 1, and
   Save. Continue, then Register.
3. **Download the key** (`AuthKey_XXXXXXXXXX.p8`). Apple lets you download
   it **once**. Note the **Key ID** (10 characters, shown on the key's
   page) and your **Team ID** (Membership details, 10 characters).
4. **Set the three secrets on Fly** (all three or none — the server refuses
   to boot half-configured):

   ```sh
   fly secrets set -a parkagent-api \
     APPLE_MAPS_KEY="$(cat ~/Downloads/AuthKey_XXXXXXXXXX.p8)" \
     APPLE_MAPS_KEY_ID=XXXXXXXXXX \
     APPLE_MAPS_TEAM_ID=YYYYYYYYYY
   ```

   `fly secrets set` restarts the machines. Per CLAUDE.md, a restart
   reloads `policy.json` from the image, so check the dry-run and caps
   state afterwards.
5. **For local runs**, add the same three lines to the repo-root `.env`.
   Literal newlines or `\n` escapes both work for the key.
6. **Check it:** `pnpm -C server verify:places` (see below) should resolve
   "Lola 42" to 22 Liberty Dr, Seaport. Then delete the downloaded `.p8`, or
   store it in your password manager. Never commit it.

## How the server uses it

- `services/assistant/appleMaps.ts` signs a Maps auth token (ES256 JWT:
  header `{alg: ES256, kid: <key id>, typ: JWT}`, claims `{iss: <team id>,
  iat, exp, scope: "server_api"}`). It trades that token at `GET /v1/token`
  for a 30-minute access token, caches it, and refreshes once on a 401. It
  then calls `GET /v1/search` with `limitToCountries=US`,
  `resultTypeFilter=Poi,Address`, a `searchLocation` (the phone when it's
  in the city, else the city's center), the city's `searchRegion`, and the
  phone as `userLocation`.
- Results outside the covered metros are dropped. A biased search that
  finds nothing in its city tries the other cities, so the bias orders the
  search but never blinds it.
- `FallbackGeocoder` tries Apple first and Nominatim second. A source that
  fails (network, quota, a revoked key) falls through to the next one.
  Only every source failing is a failure.
- `geocode_place` records which source answered on its decision row
  (`outcome.source`), so a quiet fallback to Nominatim shows up in the
  ledger.

Rotating the key: create a new one (step 2), set the secrets, then revoke
the old key in the portal.
