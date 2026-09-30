# ParkAgent: place resolution, Boston curb data, garage inventory, ranking & map UX

Sep 26, 2026 · @Thomas Bardhi

## 1. Executive summary

The four problems have four different shapes, and the biggest lever is one you don't control yet: Boston is building an authoritative, CDS-formatted curb-zone layer right now (Boston Curb Lab, launched Feb 2026, funded by a 2024 USDOT SMART grant, connected to the Passport payment system and updated nightly). Getting on its early-access list closes your zone gap faster than any amount of crowdsourcing. Everything below is graded **\[S\]** = what a source says, **\[I\]** = my inference from the sources plus your repo.

**Brutal version of where you stand**

- Place resolution: your `placeMatch.ts` is already doing the right three things (name match, area filter, distinct-place choices). What is missing is autocomplete-style *sessioned* resolution and a confidence score the model can't override. \[I\]
- Boston zones: the 35% import rate is a matching problem, not a data problem. Passport's feed has every zone; your matcher can only claim zones whose block names parse and whose geometry agrees. The rest is fixable with a second matching pass (corner geocoding through the City's SAM layer, which you already have) and a small field survey, not with more drivers. \[I\]
- Garages: both of your sources are partner-gated read-only public endpoints you are not licensed to read. SpotHero is being acquired by Uber (announced 2026-02-23, expected to close H1 2026; I could not confirm closing as of 2026-09-26) \[S\], which makes a SpotHero partner API the least likely door to open this year. Arrive (ParkWhiz) still runs a documented v4 partner API with a sandbox, gated by an email to partnerships. \[S\]
- Map: your PlanMiniMap is already the right idea (non-interactive, pins select). The gap is a shared selection model between list and map, and a handoff sheet. \[I\]

**How the best teams do it (sources)**

- Google's parking difficulty (2017) is a historical, crowdsourced ML estimate shown as Limited/Medium/Easy on the directions card; the follow-up "find parking" view lists streets and facilities with an address and walk time under a small map, and switches to walking directions after you park ([Google AI blog](https://ai.googleblog.com/2017/02/using-machine-learning-to-predict.html), [Engadget](https://www.engadget.com/2017-08-29-google-maps-parking-difficulty-25-more-cities.html)). \[S\] Lesson: parking is a *card on the trip*, not a separate app, and walk time is the headline number. \[I\]
- Apple Maps shows parking information from Parkopedia on destination search ([Parkopedia](https://business.parkopedia.com/solutions/mobile-navigation)). \[S\] Apple does not license that on-street layer to third parties through MapKit; you'd license it from Parkopedia directly. \[I\]
- Apple Maps Server API `/v1/search` takes `searchLocation`, `searchRegion`, `userLocation`, `resultTypeFilter=Poi|Address`, `includePoiCategories`, and returns `structuredAddress` with `dependentLocalities` and `areasOfInterest`; `/v1/searchAutocomplete` returns completions you resolve with one more call each ([SDK reference](https://github.com/JS00001/apple-maps-server-sdk), [apple-maps-java guide](https://www.mintlify.com/WilliamAGH/apple-maps-java/guides/search-autocomplete)). Quota is 25,000 service calls/day per team, shared with MapKit JS, 429 past that, increases by request only ([WWDC22 notes](https://wwdcnotes.com/notes/wwdc22/10006), [forum](https://developer.apple.com/forums/thread/807656)). Schedule 6 restricts caching map data beyond temporary use. \[S\]
- Google Places (New) Text Search takes `locationBias` *or* `locationRestriction` (never both), `rankPreference` DISTANCE/RELEVANCE, `includedType`; Autocomplete takes `sessionToken` and `origin` so predictions carry a distance ([searchText](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/searchText), [autocomplete](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/autocomplete)). \[S\]
- Uber: suggested pickup points came from past stop data (where drivers actually stopped), shown as green dots while the user drags the pin ([TechCrunch 2015](https://techcrunch.com/2015/07/08/uber-suggested-pickup-points)); location accuracy is fused GNSS+IMU because GNSS alone fails in urban canyons ([Uber blog](https://www.uber.com/blog/beacon-improving-pickups-with-better-location-accuracy)). \[S\] Lesson for you: snap the *option* pin to the curb line, not the GPS dot, and treat overlapping curbs as a question for the user. \[I\] (Your data/README already says this.)
- OMF Curb Data Specification: Curbs API (zones, policies, spaces, areas), Events API, Metrics API; 1.1.0 released 2025-10-27 and adds linestring geometry on curb zones, rate currency, and payment channel on events ([OMF release page](https://github.com/openmobilityfoundation/curb-data-specification/wiki/Release-1.1.0)). INRIX has curb data in 125+ cities and a CDS API; Passport told the working group it is working to be CDS compliant; Coord produced linear curb data for Boston in the past and was absorbed via Sidewalk Labs into Google in 2022 ([OMF minutes 2023-05-30](https://github.com/openmobilityfoundation/curb-data-specification/wiki/Web-Conference-2023.05.30-Curb), [2021-06-01](https://github.com/openmobilityfoundation/curb-data-specification/wiki/Web-Conference-2021.06.01-Curb), [Dealroom](https://app.dealroom.co/companies/coord)). \[S\]
- Boston: ParkBoston returned to Passport in August 2025 under a system-wide upgrade covering enforcement, permitting, payments and data ([boston.gov](https://www.boston.gov/departments/parking-clerk/parkboston), [Passport PR](https://www.prnewswire.com/news-releases/city-of-boston-modernizes-parking-with-passports-unified-platform-302577584.html)). The Curb Lab's CD-Engine builds the city's authoritative curb-zone layer from street imagery, CD-Live connects it to parking payment systems, and CD-Gate publishes open feeds for navigation and delivery apps; code and data are to be open-sourced ([boston.gov](https://www.boston.gov/departments/emerging-technology/boston-curb-lab-using-ai-and-open-data-improve-curb-management), [Stamen](https://stamen.com/mapping-bostons-curbs/), [Apolitical](https://apolitical.co/en/articles/digitizing-the-curb-in-boston-using-ai-to-create-a-smarter-more-transparent-system-for-parking-and-curb-use)). \[S\]

**Comparison of approaches and providers**

| Provider / approach | What it gives you | Boston coverage | Cost | Access requirement | Verdict \[I\] |
| --- | --- | --- | --- | --- | --- |
| [Apple Maps Server API](https://developer.apple.com/documentation/applemapsserverapi) | POI + address search, autocomplete, ETA (walking) | Full | $99/yr membership; 25k calls/day free, 429 after | Maps ID + key (you have it) | Keep as primary. Add autocomplete + ETA. |
| [Google Places (New)](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/searchText) | Text search, autocomplete w/ session tokens, place details | Full | Per-call SKU billing (public price sheet; approximate: tens of $/1k for Text Search Pro) | API key, billing account | Fallback only when Apple returns nothing name-matched. |
| Nominatim (OSM) | Streets, neighborhoods, some POIs | Streets good, businesses poor (your 2026-09-25 test) | Free, 1 req/s, must identify UA | None | Keep as last fallback for cross-streets only. |
| [Boston Curb Lab / CD-Gate](https://www.boston.gov/departments/emerging-technology/boston-curb-lab-using-ai-and-open-data-improve-curb-management) | Authoritative CDS curb zones + regulations, nightly refresh, tied to Passport; public Curbs API live at cds-curb-api.boston.gov (see 2b) | Citywide (rolling out) | Free / open | None per CDS spec; verify on the live OpenAPI | Primary zone source now (PR 2). |
| Analyze Boston Parking Meters | Meter points, hours, max stay | \~7k meters | Free | None | Keep; it's your geometry until CDS lands. |
| Passport Find Parking feed (sweep) | Zone number + block name | Every ParkBoston zone | Free, but not licensed | Your own signed-in session | Bridge only; replace with CDS/Passport data or a records request. |
| [Parkopedia](https://business.parkopedia.com/parking-data) | On/off-street static + availability, 90M spaces, 90 countries | Full | Unpublished; enterprise license | Sales contact | Too expensive pre-revenue; revisit at Series A. |
| INRIX Curb (CDS API) | Curb sections in 125+ cities, ground-truthed | Likely (unverified) | Unpublished; enterprise | Sales contact | Same as Parkopedia. |
| SpotAngels | Crowdsourced rules + street cleaning | Boston listed in app (unverified depth) | Unpublished | Sales contact | Not worth the outreach until you have volume. |
| Coord | Curb regulations API | Historical Boston data | n/a | Company absorbed into Google (2022) | Dead end. |
| [Arrive / ParkWhiz v4](https://developer.arrive.com) | Search, quotes, booking, passes, webhooks, sandbox, POI data feed | Good | Rev share (unpublished) | Email partnerships@arrive.com; OAuth client credentials | First partner to approach. |
| [SpotHero API](https://supergood.ai/api-report-card/spothero) | Search, booking, branded passes (api.spothero.com/v2) | Good | Unpublished | Email partner.support@spothero.com with volume; no sandbox | Approach, but expect a freeze during the Uber integration. |
| ParkMobile Reservations (Arrive/EasyPark) | Garage reservations | Boston garages ([ParkMobile](https://parkmobile.io/parking/locations/ma/boston-parking)) | Unpublished | Partner sales | Third; overlaps Arrive inventory. |
| Direct operators (LAZ, Metropolis/SP+, Propark, Pilgrim) | Their own garages, sometimes their own APIs | LAZ is Boston-HQ'd, largest local operator (approximate) | Negotiated | Sales | Long game; one operator can unblock Seaport. |

**What to do in the next 30 days \[I\]**

1. Email the Boston Curb Lab (Office of Emerging Technology) and BTD's New Mobility team asking for early access to CD-Gate and for the Passport zone list; file a public records request for the ParkBoston zone table as a parallel track.
2. Probe the City's CDS Curbs API (section 2b) and ingest it as the primary Boston zone source; re-run the Passport matcher only for uncovered curb; target 80% before any field survey.
3. Ship the place-resolution changes in section 3 (autocomplete + confidence + walking ETA) behind the existing `GeocoderProvider` interface.
4. Send the two partner emails in section 4 this week; the adapter seam already exists.
5. Ship the map/list sync and the navigation handoff sheet (section 5).

## 2. Boston data plan

Target: **95% of metered curb length in Boston carries a payable zone number with confidence ≥ 0.8 within 90 days**, and 100% of zones a user has parked in twice. Today you have 393 zones and about 35% import-matched (your figure). The plan below gets there in three passes and then hands maintenance to the City's feed.

**Sources, in the order to use them**

| Source | What it closes | Status | How to get it |
| --- | --- | --- | --- |
| Passport `getnearzoneswithoccupancy` sweep (have) | Every zone's number and block name | Working, unlicensed \[S: your README\] | Keep for now; retire when either of the next two lands. |
| Boston Curb Lab CD-Gate (CDS Curbs API) | Authoritative curb zones + regulations; the City says CD-Live connects to parking payment systems, so zone ids should ride along \[S: [boston.gov](https://www.boston.gov/departments/emerging-technology/boston-curb-lab-using-ai-and-open-data-improve-curb-management)\] | In build; pilots since Feb 2026 \[S\] | Email the Office of Emerging Technology; offer to be a design partner (you are exactly the "navigation provider" they name). |
| BTD / Passport zone table via public records request (M.G.L. c.66 §10) | Zone number ↔ block ↔ meter ids | Not attempted \[I\] | One-page request to the Records Access Officer; ask for the Passport zone export as CSV/GeoJSON. Turnaround is typically 10 business days. |
| Analyze Boston Parking Meters (have) | Geometry, hours, max stay | Live | Already in `data/fetch_boston.py`. Check for a post-Passport refresh: the City's `G_PASSPORT_ZONES` per-meter id may now have a companion zone field. |
| City street-segment (SAM) layer (have) | Corner coordinates for block names | Live | Already used for corner resolution. |
| Driver reports (have) | Anything the above miss | Live, 2-user verification | Keep; add photo-of-meter capture (section 6, PR 2) so a single report can verify by OCR. |
| Your own field survey | The stubborn 5–10% | Not started | One founder, one afternoon per district, iOS Diagnostics "report zone" mode. |
| Street imagery (Cyclomedia is what the City uses; Mapillary/Street View for you) | Sign and sticker OCR | n/a | Only for spot checks; the City is doing this at scale, don't duplicate. \[I\] |

**Why the import stalls at 35% \[I, from reading `import_parkboston_zones.py`\]**

1. Name parse failures: feed names truncate at \~45 chars and use shorthand ("Comm Ave", "West Mass Ave"); anything the regex misses goes to the LLM at lower confidence, and unparseable names are dropped.
2. Corner resolution failures when one cross street isn't in the SAM layer under that spelling.
3. Side disagreement on diagonal streets (you compare curb normals, good) and on streets where the meter `DIR` majority is wrong.
4. Your zone splitting (250 m cap, 80 m gap) vs Passport blocks (\~85 m): one of your zones spans two Passport blocks and gets marked *ambiguous* instead of split.

**Pipeline (three passes)**

1. Pass A, matcher v2: (a) add a second name grammar for "\<street> \<from>-\<to>" and "\<street> @ \<cross>" forms; (b) resolve corners against SAM with fuzzy street matching (token ratio ≥ 0.9, suffix-free); (c) when a zone is claimed by two numbers with disjoint overlap ranges along the centerline, **split the zone at the boundary** and assign each half; (d) log every non-match with a reason code. Expected: 35% → 70–80%. \[I\]
2. Pass B, records + Curb Lab: join the City's zone table on meter id or block name; anything that agrees with Pass A becomes confidence 0.95; disagreements go to a review queue.
3. Pass C, field: export the remaining zones as a GeoJSON checklist; walk them; report through the app.

**Verification and freshness**

- Every zone carries `zone_number_source` (import|records|cds|report|survey), `confidence`, and `verified_at`. Precedence stays as today (verified report > import > single report) with `cds` slotted above `import`. \[I\]
- Nightly: re-run the Passport sweep for 20 random probe points and diff numbers against stored; any change flips the zone to `stale` and pushes a Diagnostics alert. Weekly: re-fetch Analyze Boston and diff meter counts per zone; a zone whose meter count drops to 0 is retired, not deleted.
- Every paid session is a verification event: the executor already returns provider-observed zone terms; record `session_confirmed_zone_number` and count successes per zone. Two paid sessions on a zone = verified, same rule as two user reports.
- Coverage metric, computed in CI from `data/out`: `covered_length_m / metered_length_m` and `zones_known / zones_total`, printed in the build summary and asserted ≥ the last committed value so coverage can't regress silently.

**Storage: adopt CDS shapes, not the CDS server**

The Curb Data Specification defines curb zones (with linestring geometry since 1.1.0), policies (rules with days/hours/rates/user classes), spaces, and areas ([OMF 1.1.0](https://github.com/openmobilityfoundation/curb-data-specification/wiki/Release-1.1.0)). \[S\] Keep your `zones` table but add a `cds_zone_id` column and a `policies` JSONB that mirrors CDS Policy/Rule so that when CD-Gate ships you ingest it with a mapper, not a migration. Do not expose a CDS API yourself; you are a consumer. \[I\] Store the payable number as a provider attribute (`provider_zone_number`, keyed by provider id) exactly as you do, because CDS deliberately does not model pay-by-app zone numbers. \[I\]

## 2b. Boston's live CDS Curbs API and how to integrate it

The City already runs a public CDS server at `https://cds-curb-api.boston.gov` (FastAPI; the docs route you found, `fetch_curb_zone_curbs_zones__id__get`, is FastAPI's generated name for `GET /curbs/zones/{id}`). This changes the plan: **the City's zone layer is a fetch, not a request.** Honest caveat: the host refuses automated readers and the sandbox can't reach it, so I could not read Boston's own OpenAPI document. Everything below is what the [CDS Curbs API spec](https://github.com/openmobilityfoundation/curb-data-specification/blob/main/curbs/README.md) requires or permits \[S\]; which optional fields Boston actually populates is the first thing PR 2 checks.

**What the spec says the API gives you \[S\]**

| Endpoint | Required? | Params | Returns |
| --- | --- | --- | --- |
| `GET /curbs/zones` | Required | `min_lat,min_lng,max_lat,max_lng` (bbox) or `lat,lng,radius` (radius in **centimeters**, sorted by distance), `area`, `include_geometry`, `time` | `{ zones: [Curb Zone] }` plus a `policies` list referenced by the zones |
| `GET /curbs/zones/{id}` | Optional | `time`, `show_historic` | One Curb Zone, 404 outside its validity |
| `GET /curbs/policies` | Required if zones reference policies | `ids` | `{ policies: [Policy] }` |
| `GET /curbs/areas`, `/curbs/spaces`, `/curbs/objects` | Optional | bbox/radius | Areas (neighborhood groupings), demarcated spaces, objects such as pay stations |

No authorization is required for Curbs endpoints (the spec says the data should be public; agencies may issue free keys to track usage). Responses carry `version`, `time_zone`, `last_updated`, `currency`; the server sets `Content-Type: application/vnd.cds+json;version=1.x` and clients should send a matching `Accept` header or risk `406`.

**The fields that matter to ParkAgent \[S, mapping I\]**

| CDS field | Meaning | Where it lands in your schema |
| --- | --- | --- |
| `curb_zone_id` (UUID, stable while geometry is substantially the same) | The City's zone identity | `zones.cds_zone_id` (new); keep your `zone_id` as the app key |
| `geometry` (Polygon or LineString, `width` cm) | The curb extent | Replace your buffered meter-line polygon when present; keep `centerline` for distance ranking |
| `user_zone_id` | "An identifier used on signage and in mobile applications, typically for payment" | **This is the ParkBoston zone number.** Source `cds`, confidence 0.95 if it agrees with an import/report, review queue if it conflicts |
| `street_name`, `cross_street_start_name`, `cross_street_end_name`, `street_side` (N/NE/…), `length` cm | Block identity | Joins directly to your Passport block-name parse; replaces most of the corner geocoding |
| `curb_policy_ids` → Policy (`priority`, `rules[]`, `time_spans[]`) | Regulations | `zones.policies` JSONB; hours and max stay derived from rules with `activity: parking`; `no parking`/`no stopping`/`travel` rules give you street-sweeping and rush-hour windows you have never had |
| `rules[].rate[]` (`rate` in cents per `rate_unit`, `start_duration`/`end_duration`, `maximum_fee`) | Price | Replaces the hand-drawn rate areas in `build_boston_zones.py` |
| `rules[].user_classes`, `purposes` | Who may park | Exclude `bus`, `truck`, permit-only, and loading-only zones from passenger options |
| `available`, `available_spaces`, `availability_time` | Occupancy, if the City ever feeds sensor data through CD-Live | The `A_avail` term in section 5 |
| `published_date`, `last_updated_date`, `start_date`, `end_date`, `prev_curb_zone_ids` | Freshness and lineage | Nightly diff; a retired zone maps to its successor instead of being dropped |
| `curb_object_ids` → Objects | Pay stations / meters | Cross-check against Analyze Boston meter ids |

**Integration design \[I\]**

1. `data/fetch_boston_cds.py`: tile the Boston bbox into \~2 km squares, call `/curbs/zones` per tile with `include_geometry=true`, collect referenced policies once via `/curbs/policies?ids=`, write `data/raw/boston_cds_zones.geojson` and `boston_cds_policies.json`, record `last_updated`. Polite: 2 req/s, identifying User-Agent, retry on 429/5xx.
2. `data/build_boston_zones.py` gains a `--cds` mode that builds zones **from CDS first** and falls back to the meter-point assembly only for curb the CDS layer doesn't cover yet (the Curb Lab is still rolling out). Each output feature records `geometry_source: cds|meters` and `regulation_source: cds|pay_policy|default`.
3. Matching CDS zones to your existing meter-derived zones (needed once, to carry reports and sessions across): same normalized street, `street_side` agrees with your `side_of_street`, and either ≥ 50% centerline overlap or both cross streets match. Write the crosswalk to `data/out/boston_zone_crosswalk.json`; the loader uses it to remap `zone_number_reports` and `zone_terms_observed` instead of orphaning them.
4. Regulation compiler: `policies_to_windows(policies, tz)` turns CDS policies into your existing `hours_json` shape for the enforced window plus a new `restrictions_json` (no-parking spans with their reason). Precedence is the CDS rule: overlapping time spans for the same user class, lowest `priority` wins. Pin the compiler with fixtures: metered Mon–Sat 8–20 with a Tuesday 8–12 street-sweeping `no parking`, resident-permit-except, and a 2-hour max with a $3.75/h rate.
5. Quoting: `zone_terms_observed` (provider UI) > CDS rate > dataset rate. Log every disagreement between CDS and the provider's posted terms; that log is what you send the Curb Lab, and it is the fastest way to become a partner they answer.
6. Nightly job (`jobs/cdsRefreshTick.ts` or a GitHub Action running the Python fetch): fetch, diff by `curb_zone_id` + `last_updated_date`, flag zones whose `user_zone_id` changed as `stale` until a session confirms, and post a summary to Diagnostics. If `/curbs/zones` starts returning `end_date` on a zone you have sessions in, retire it and point it at its successor.

**What this makes better, concretely \[I\]**: (a) zone numbers for every block the City has digitized, without a personal Passport session; (b) no-parking windows (street sweeping, rush hour, snow emergency `designated_period`) so a "free now" curb line on the map is actually legal; (c) correct rates per block instead of three hand-drawn boxes; (d) permit-only and loading zones excluded from options; (e) City ids to cite in a dispute.

**What to verify against the live spec on day one (probe checklist, goes in PR 2)**: the `version` the server reports and the `Accept` header it needs; whether `user_zone_id` is populated and whether it equals the ParkBoston number for three zones you have paid at (#112/#113); whether geometry is Polygon or LineString; whether `/curbs/policies` is implemented or `501`; whether `rate` arrays are present; whether any zones carry `available`; total zone count and bbox coverage vs your 393; rate limits (look for `429` and `Retry-After`); any key requirement in the OpenAPI `securitySchemes`.

## 3. Place-resolution design

Decision: keep `GeocoderProvider` + `FallbackGeocoder` + `classifyPlaceMatches` as the spine, and add three things: a **two-call Apple strategy** (search, then autocomplete when search is weak), a **numeric confidence** that the model cannot override, and **walking ETA** from Apple's `/v1/etas` so options are ranked by real walk time, not straight line. Google Places becomes an optional third provider behind the same interface; Nominatim stays last for cross-streets.

**Resolution ladder \[I\]**

1. Normalize the query: strip "near/at/in", pull an area word if any result later carries it (your current logic), keep the raw string for the provider.
2. Apple `/v1/search` with `searchLocation` = phone if inside the metro else metro center, `searchRegion` = the metro bbox (Apple treats it as a hint, so keep your post-filter), `resultTypeFilter=Poi,Address`, `userLocation` = phone. \[S: parameter list per the [SDK reference](https://github.com/JS00001/apple-maps-server-sdk)\]
3. Score each result (0–1): name-token match (0–0.5, all tokens matched = 0.5, partial by ratio), area agreement (+0.2 if the user named an area and the result's `subLocality`/`dependentLocalities` carry it, −0.2 if they named one and it doesn't), distance prior (+0.15 within 3 km of the bias point decaying to 0 at 15 km), POI vs address (+0.1 if the query has a business-like token and the result is a Poi), provider rank (+0.05 for rank 1).
4. If the best score < 0.55 or no result has any name token, call `/v1/searchAutocomplete` with the same bias and resolve the top 3 completions (1 call each); rescore. This is what catches "Lola 42" typed as "lola42" or "lola forty two". \[I\]
5. If still nothing name-matched and `GOOGLE_PLACES_API_KEY` is set, Google Text Search with `locationBias` circle (radius 15 km) and `rankPreference=RELEVANCE`; rescore with the same function. \[S: parameters per [searchText](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/searchText)\]
6. Nominatim only for queries that look like "X and Y" or "X St" (cross-streets and bare streets).

**Thresholds \[I\]**

| Outcome | Rule | What the model is told |
| --- | --- | --- |
| `found` | best ≥ 0.75 and second-best < best − 0.2 or > 250 m away | Use it. Card shows name + neighborhood. |
| `ambiguous` | two or more ≥ 0.6 within 0.2 of each other, > 250 m apart | Must call `ask_user` with chips; never pick. (Your current rule; keep.) |
| `closest_only` | best < 0.6 but something is within 2 km of the bias | "Only found \<area>; say so and ask for an address." (Your `nameMatched:false`.) |
| `none` | nothing ≥ 0.3 | "Couldn't find X." Never substitute phone location. |

The confidence, the winning provider, and the raw candidate list go into the `decisions` row for the tool call so a bad resolution is auditable. The threshold constants live in one exported object so tests pin them.

**Disambiguation chips**

Chip label = `name · neighborhood` ("Mooo · Beacon Hill", "Mooo · Seaport"); chip reply = `name, street address` (your `choiceReply`). Cap at 3 chips plus "None of these". A tapped chip is resolved by exact-address match, not by re-search, so the second turn cannot produce a different place. Show the chips with a mini-map of the candidates (section 5) so the user can pick by looking. \[I\]

**Walking ETA**

Apple `/v1/etas` takes one origin and up to 10 destinations with `transportType=Walking` and returns `expectedTravelTimeSeconds` and `distanceMeters` ([SDK reference](https://github.com/JS00001/apple-maps-server-sdk)). \[S\] Call it once per plan (origin = destination pin, destinations = every option's pin) and replace `walkMinutes = distanceM / 80` with the ETA when present; keep the straight-line estimate as fallback and mark it `walkEstimate: true`. That is 1 call per plan, so quota is not a concern. \[I\]

**Test cases (offline fixtures + one live FR)**

Coordinates below are approximate (rounded from public map data); the FR test asserts ≤ 150 m, the unit tests use fixture results with these exact values.

| Query | Phone | Expected | Expected pin (lat, lng) |
| --- | --- | --- | --- |
| "Lola 42 in Seaport" | Braintree | found: LoLa 42, 22 Liberty Dr | 42.3532, −71.0437 |
| "lola42" | Boston | found via autocomplete | same |
| "Moo steakhouse" | Braintree | ambiguous: 15 Beacon St vs 49 Melcher St | 42.3578, −71.0621 and 42.3502, −71.0509 |
| "Moo steakhouse in Seaport" | Braintree | found: 49 Melcher St | 42.3502, −71.0509 |
| "Seaport" | Boston | found: the neighborhood, not Seaport Hotel | \~42.3510, −71.0440 |
| "Newbury St" | Boston | found: Newbury Street, Back Bay | 42.3503, −71.0811 |
| "Fenway" | Boston | found: neighborhood, best rank, no question | 42.3429, −71.1003 |
| "Fenway Park" | Boston | found: the venue | 42.3467, −71.0972 |
| "MFA" | Boston | found: Museum of Fine Arts, 465 Huntington Ave | 42.3394, −71.0940 |
| "TD Garden" | NYC phone, no city said | ambiguous by city? No: name is unique; found, Boston | 42.3662, −71.0621 |
| "Boylston and Dartmouth" | Boston | found via Nominatim cross-street path | 42.3497, −71.0778 |
| "Starbucks" | Boston | ambiguous, ≤ 3 chips nearest the phone + "None of these" | n/a |
| "xyzzy restaurant" | Boston | none; no substitution | n/a |
| "Lola 42" with Apple 429 | Boston | fallback provider runs; decision row records `apple_maps: quota` | same as row 1 |

**What not to build \[I\]**: your own POI database, fuzzy matching against OSM names, or an LLM "which one did they mean" step. The provider's ranking plus a deterministic score is more debuggable than any of those, and the decisions table gives you the failure cases to tune against.

## 4. Garage-inventory plan

Decision: approach Arrive (ParkWhiz) first, SpotHero second, ParkMobile Reservations third, and one Boston operator (LAZ) in parallel as a long game. Until a key arrives, keep the read-only readers but put them behind a **legal kill switch** and a per-provider budget, because "low volume with honest headers" is a courtesy you are extending to yourself, not a license. \[I\]

**Partners, in order**

| # | Partner | Why this order | What to ask for | What they'll require (source) |
| --- | --- | --- | --- | --- |
| 1 | [Arrive / ParkWhiz](https://developer.arrive.com) (Flash) | Documented v4 transactional API, sandbox, webhooks, POI data feed, JS widget and native SDKs; access by email, OAuth client credentials with `scope=partner` \[S: [Arrive portal](https://developer.arrive.com), [walkthrough](https://partners.arrive.com/docs/walkthroughs/api/transactional-api)\] | Sandbox client id/secret; `partner` scope; Boston search + quotes + bookings; webhook on booking create/cancel; the POI data feed for Boston so you can pre-geocode entrances | Company details, projected volume, a rev-share or referral agreement; the API Report Card notes no self-serve, no published rate limits, 50 sq mi search cap, and a separate license for the full POI dataset \[S: [report card](https://supergood.ai/api-report-card/parkwhiz)\] |
| 2 | [SpotHero](https://spothero.com/developers) | Largest inventory (13,000+ facilities, 400+ cities) \[S: [Uber PR](https://investor.uber.com/news-events/news/press-release-details/2026/Uber-to-Acquire-Parking-App-SpotHero/default.aspx)\]; partner-gated REST at api.spothero.com/v2 with public docs, credentials by emailing partner support with volume \[S: [report card](https://supergood.ai/api-report-card/spothero)\] | Read-only search first (a "link-routing" tier exists), then booking | Expect slow answers while the Uber deal integrates; ask for the affiliate/link tier as the fallback so today's deep links become sanctioned |
| 3 | ParkMobile Reservations (EasyPark/Arrive) | Sells Boston garage reservations \[S: [ParkMobile Boston](https://parkmobile.io/parking/locations/ma/boston-parking)\]; overlaps Arrive inventory since both are EasyPark-owned names now \[I\] | Reservations search API for Boston | Partner sales; likely routed to the same Arrive team \[I\] |
| 4 | LAZ Parking (Boston HQ), Metropolis (ex-SP+), Propark, Pilgrim | Operators own the inventory the marketplaces resell; one operator agreement can cover Seaport/Back Bay garages the marketplaces price poorly \[I\] | Rate card + real-time availability feed for 10–20 named garages; a validation/QR flow | A pilot agreement; expect them to ask for volume or an exclusive \[I\] |

One email template covers 1–3: who you are (two founders, Boston field test, pays via the city's own app for street, hands off garages), what you need (sandbox + Boston read access + a booking scope later), volume (say honestly: hundreds of searches/day, tens of bookings/month), and what you offer (a Boston-first consumer surface that ranks street vs garage on total cost; you will send them the garage demand you cannot serve on-street). Ask for the referral/affiliate tier explicitly as the floor.

**Adapter layer: what already exists and what to change \[I\]**

`GarageProvider` (id, canReserve, search, optionById, book) is the right seam; `makeMultiGarageProvider` merges and dedupes by normalized address; option ids are `{provider}-{facility}-{windowTag}`; API.md already says a Partner API provider flips `canReserve`, returns `{kind:"reserved"}`, and changes one sentence. Keep all of that. Add:

1. `ProviderCapabilities` on the interface: `{ search: "public_read"|"partner", book: "deeplink"|"reserve", availability: "none"|"snapshot"|"live", entrances: boolean, cancel: boolean }`. The assistant's `search_garages` tool reports capabilities to the model so the phrasing ("pass lives in ParkWhiz") comes from data, not from a provider-name switch.
2. `GarageOption` gains `entrance?: {lat,lng}` (Arrive returns `entrances[0].coordinates`), `availability?: "available"|"limited"|"unknown"`, `heightLimitCm?`, `amenities?: string[]`, `cancellable?: boolean`, and `provenance: { provider, fetchedAt, mode }`. All optional so today's readers keep compiling.
3. A `ProviderRegistry` for garages (mirror the city/provider registry you already have for street): `garageProviders()` reads env and returns the configured list; `PARKWHIZ_MODE=public|partner|off`, `SPOTHERO_MODE=public|partner|off`. `off` removes the provider; `public` keeps the reader with a daily request budget (`GARAGE_PUBLIC_READ_BUDGET`, default 500) and a `blocked` outcome once exceeded; `partner` requires the OAuth env and instantiates the partner adapter.
4. Partner adapters live beside the readers (`parkwhizPartner.ts`, `spotheroPartner.ts`) and share parsers: the Arrive v4 quote shape is the same for public and partner reads (the walkthrough shows the same `_embedded["pw:location"]` and `purchase_options` structure), so `parseParkWhizQuote` moves to a shared module and both adapters import it.
5. Booking becomes a two-phase call in the interface: `quote(optionId) → { holdToken, expiresAt, priceUsd }` then `book(holdToken)`; the deep-link providers implement `quote` as a no-op that returns the cached price. This is what makes "confirm" idempotent when a partner key lands; without it you will retrofit confirm tokens under pressure.
6. Contract tests: one vitest file per adapter runs the *same* suite (`garageProviderContract.test.ts` exports `describeGarageProvider(makeProvider, fixtures)`): search returns typed outcomes, optionById round-trips, book on unknown id throws, a 401/403/429 maps to `blocked`, prices are numbers with fees included.

No iOS change is required for any of this: the app reads `kind`, `deepLink`/`confirmationId`, and the provider display name from the confirm response. The one iOS change worth making now is rendering `availability` and `entrance` when present (section 5).

**Coverage and quality metrics to track from day one \[I\]**: per search, providers answered / degraded; options returned; options with coordinates; options with entrance; median price delta between providers for deduped facilities; share of confirms that became a booking (you can't see this for deep links, so ask Arrive for the booking webhook first).

## 5. Ranking model and map/list UX

Decision: rank every option (street or garage) by one **generalized cost in dollars**, computed server-side, stored on the option, and used identically by the list order, the "recommended" pin, and the assistant's reason sentence. No learned model yet; a transparent formula with per-user weights beats a black box while you have tens of users. \[I\]

**Generalized cost**

```latex
C = P + w_t \cdot \frac{T_{walk}}{60} + w_r \cdot R_{ticket} + w_e \cdot E_{entry} + w_a \cdot A_{avail}
```

- `P`: price for the requested window in USD, fees included (ParkBoston $0.35/session; garage fees are already in the partner price).
- `T_walk`: walking seconds from Apple ETA (fallback 80 m/min); `w_t` = value of time, default $18/h (≈ Boston's 2026 minimum wage plus a bit; user-adjustable as "I'd rather walk" / "drop me close" = $8/h vs $30/h). \[I\]
- `R_ticket`: expected ticket cost = P(ticket) × $40 (your policy.json) where P(ticket) is 0 for a garage, 0.02 for a verified street zone, 0.15 for an unverified zone number, 1.0 (option excluded) for a zone with no number. \[I\]
- `E_entry`: valet +$4, unknown +$2, self 0 (people avoid valet uncertainty; treat as a small penalty, user-adjustable). \[I\]
- `A_avail`: street option after 9 am on a weekday in Back Bay/Seaport +$3 (proxy for search time until you have occupancy data); garage `limited` +$2. \[I\]

Hard filters before scoring: over budget (`session_cap_usd`), max stay < requested, height limit < user's vehicle, street zone not payable (no number) unless the user asked for free street. Tie-break by price. The "recommended" flag is `argmin C`; the reason sentence is generated from the two terms that dominate the difference to the runner-up ("$6 cheaper, 4 minutes farther").

What the big apps do that you should copy: Google lists parking options with address and walk time under a small map and hands off to walking directions after you park \[S: [Engadget](https://www.engadget.com/2017-08-29-google-maps-parking-difficulty-25-more-cities.html)\]; Uber's suggested points are shown as tappable dots and explained in one line ("save time at these locations") \[S: [TechCrunch](https://techcrunch.com/2015/07/08/uber-suggested-pickup-points)\]. Walk time is the headline number in both. \[I\]

**Map/list spec**

One `PlanSelection` state object owns `selectedOptionID`, `hoveredOptionID`, and `visibleOptionIDs`; the map and the list are two views of it. Selection is symmetric: tapping a pin scrolls the list row into view and expands it; tapping a row recenters the map and grows the pin. Your `PlanMiniMap` already recenters and draws the walking route on selection; the missing half is the list reacting to the pin. \[I\]

| Layer | Rendering | Notes |
| --- | --- | --- |
| Destination | Dark pin with the place name | Never moves; long-press does nothing (not a nav app). |
| Curb zones within the walk radius | Thin polylines along the curb centerline, colored by state *now*: paid (coral), free now (green), no-parking now (grey, dashed) | Uses `/zones/near` geometry; show at most 40 lines; the state comes from `streetState` for the requested window. |
| Street options | Pin at the nearest curb point of the zone | Selected = coral, others sky; the recommended one gets the star. |
| Garage options | Square pins at the entrance when known, else the facility point | Availability badge (`limited`) as a small dot. |
| Walking route | Dashed line destination → selected option | MapKit walking directions, straight-line fallback (as today). |
| List | One card per option, ordered by C | Headline: price · walk minutes; second line: street summary or garage name + entry type; third line: reason (only on the recommended card). |

Interaction rules: the map stays non-pannable inside the transcript (your reason: it steals the drag); a "Expand" affordance opens a full-screen, pannable copy bound to the same `PlanSelection`. Filters ("Street only", "Garages only", "Cheapest", "Closest") are chips above the list and just change the sort/`visibleOptionIDs`; the map dims hidden pins rather than removing them so the user keeps context.

**Navigation handoff**

A "Directions" button on the selected card opens a sheet listing the apps that are installed, in the user's preferred order (stored in `UserDefaults` after first pick, changeable in Account). Each is one tap; the target is the option pin (garage entrance when known), never the destination, and the mode is driving. After a paid session starts, a second "Walk to \<destination>" button hands off with walking mode.

| App | Launch | Query check |
| --- | --- | --- |
| Apple Maps | `MKMapItem.openMaps(with:launchOptions:)` with `MKLaunchOptionsDirectionsModeKey` driving/walking, or `maps://?daddr=lat,lng&dirflg=d` | Always present. |
| Google Maps | `comgooglemaps://?daddr=lat,lng&directionsmode=driving` (walking for the second button) \[S: [Google URL scheme](https://developers.google.com/maps/documentation/urls/ios-urlscheme)\] | `canOpenURL("comgooglemaps://")`; add `comgooglemaps` to `LSApplicationQueriesSchemes` in `project.yml`. |
| Waze | `waze://?ll=lat,lng&navigate=yes` with the universal-link fallback `https://waze.com/ul?ll=lat,lng&navigate=yes&utm_source=parkagent` \[S: [Waze deep links](https://developers.google.cn/waze/deeplinks)\] | `canOpenURL("waze://")`; add `waze` to the schemes list. Waze has no walking mode; hide it on the walk button. |

Keep the handoff in one file (`Support/NavigationHandoff.swift`) with a pure `NavigationTarget → [NavigationApp: URL]` function so it is unit-testable without MapKit, consistent with your "nothing outside the map views depends on MapKit types" rule.

## 6. Implementation: four PR-sized chunks

Order: PR 1 (place resolution) and PR 3 (garage seam) are independent and can run in two worktrees; PR 2 (CDS ingest + matcher) touches data/ and the server's zone tables, not the app; it starts with a probe of the live City API and stops if \`user\_zone\_id\` isn't what the spec promises; PR 4 (ranking + map) depends on PR 1's walking ETA and PR 3's optional fields. Each prompt below is written to be pasted whole into Claude Code at the repo root. All four end with the same gate: unit tests that fail without the change, `pnpm -r lint && pnpm -r test`, a local API boot with the FR suite pointed at it, a skeptical self-review, and CI green before saying ready.

**PR 1 — place resolution with confidence, autocomplete, and walking ETA**

```markdown
Branch: feat/place-resolution-confidence (branch from main; check `git branch --show-current` first).

Read first, in this order: CLAUDE.md, server/API.md (the "Assistant" section), server/src/services/assistant/geocoder.ts, appleMaps.ts, placeMatch.ts, tools.ts (geocode_place and propose_plan), server/test/assistantPlaces.test.ts, assistantGeocode.test.ts, docs/apple-maps-setup.md, and server/fr/40-assistant.fr.test.ts. Do not touch executor/ or ios/.

Goal: geocode_place stops returning a bare match kind and returns a scored resolution the model cannot override, using Apple search, then Apple autocomplete when search is weak, then Nominatim for cross-streets; and propose_plan replaces straight-line walk minutes with Apple walking ETAs when available.

Exact behavior:
1. New module server/src/services/assistant/placeScore.ts exporting `scoreCandidates(query, results, bias) -> Scored[]` and `RESOLUTION_THRESHOLDS = { found: 0.75, ambiguousFloor: 0.6, ambiguousGap: 0.2, closestFloor: 0.3, distinctM: 250 }`. Score = name-token match (0–0.5, ratio of query name tokens matched using placeMatch.nameTokens/tokenMatches) + area agreement (+0.2 if the user named an area and the result's area tokens carry it, −0.2 if named and absent, 0 if no area named) + distance prior (+0.15 within 3 km of bias, linear to 0 at 15 km) + POI bonus (+0.1 when the query has a non-generic token and result.kind === "poi") + rank bonus (+0.05 for the provider's first result). Clamp to [0,1]. Pure, no I/O.
2. `classifyPlaceMatches` keeps its signature and semantics but is reimplemented on top of scoreCandidates so existing tests still pass; add `confidence` to the `found` and `closest_only` shapes and `scores` to `ambiguous`.
3. AppleMapsGeocoder gains `autocomplete(q, limit)`: GET /v1/searchAutocomplete with the same bias params, then GET each completionUrl (max 3) through the existing authorized fetch; results are parsed by the existing row parser. Cache like search. `geocode()` calls autocomplete only when search's best score < 0.55 or no result carries a name token; record which path won in the returned `source` ("apple_search" | "apple_autocomplete" | "nominatim").
4. AppleMapsGeocoder gains `walkingEtas(origin, destinations[]) -> {seconds, meters}[] | null`: GET /v1/etas?origin=&destinations=a|b|c&transportType=Walking, ≤10 destinations per call, never throws, null on any failure or 429. `GeocoderProvider` gets an optional `walkingEtas`; FallbackGeocoder forwards to the first provider that implements it.
5. propose_plan: after grounding options, if deps.geocoder?.walkingEtas exists and the plan has a destination, call it once with every option pin; set option.walkMinutes = ceil(seconds/60) and option.walkEstimate = false; otherwise keep the 80 m/min estimate and set walkEstimate = true. Add `walkEstimate?: boolean` to the plan option schema in plans.ts and to server/API.md.
6. geocode_place's decisions row (kind "assistant_tool") records `{ query, source, confidence, candidates: [{name, lat, lng, score}] }` (max 5 candidates).
7. A 429 from Apple is a typed reason "quota" in the {ok:false} result and the decisions row; FallbackGeocoder proceeds to the next provider on it.

Tests that must FAIL before the change and PASS after (add to server/test/assistantPlaces.test.ts or a new placeScore.test.ts):
- "lola42" with a search fixture that returns only the Seaport neighborhood and an autocomplete fixture that returns LoLa 42 → found, name matched, source apple_autocomplete, exactly 1 search + 1 autocomplete + 1 completion fetch recorded.
- "Moo steakhouse" with the two Mooo fixtures → ambiguous with two scores within 0.2 of each other; "Moo steakhouse in Seaport" → found Melcher St with confidence ≥ 0.75.
- "Starbucks" with 6 fixture results → ambiguous with at most 3 choices, nearest to the bias first.
- "xyzzy restaurant" with an unrelated fixture → none; the tool result must not contain the phone's coordinates.
- Apple fixture answering 429 → geocode returns {ok:false, reason:"quota"} and FallbackGeocoder's Nominatim fixture is consulted; the decisions row records reason "quota".
- propose_plan with a walkingEtas fixture returning 420 s for one option → that option has walkMinutes 7 and walkEstimate false; the option with no ETA has walkEstimate true.
- Thresholds are imported from RESOLUTION_THRESHOLDS in the tests, not retyped.

Then: `pnpm -r lint && pnpm -r test`. Boot the API locally against a migrated PostGIS with dry run on (`pnpm -C server dev`), create an FR user if needed (`pnpm -C server create:fr-user`), and run the FR suite against it with FR_API_BASE=http://localhost:<port> and FR_API_KEY set; FR-35/36/40 in 40-assistant must still pass with APPLE_MAPS_* configured. Update server/API.md and docs/apple-maps-setup.md (the /v1/etas and /v1/searchAutocomplete endpoints, the quota note).

Skeptical self-review before you say ready: re-read the diff as a reviewer who believes the score function is overfitted to the four test names. List three real Boston queries you have not tested and reason about their scores. Check that no code path substitutes the phone location for a failed geocode. Confirm no city or provider names were added outside the registries (city-neutral check). Push, open the PR, and do not report ready until `server`, `city-neutral`, `boot`, `ios`, and `executor` are green in CI.
```

**PR 2 — Boston CDS ingest, zone matcher v2, and a coverage gate**

```markdown
Branch: feat/boston-cds-ingest-and-matcher-v2 (branch from main).

Read first: CLAUDE.md, data/README.md (all of it), data/fetch_boston.py, data/build_boston_zones.py, data/build_zones.py, data/import_parkboston_zones.py, data/test_import_parkboston_zones.py, server/src/scripts/load-zones.ts and load-zone-numbers.ts, server/src/services/zoneLookup.ts, server/test/zoneNumber.test.ts, server/prisma/schema.prisma (Zone, ZoneNumberImport, ZoneNumberReport, ZoneTermsObserved), and the CDS Curbs API spec at https://github.com/openmobilityfoundation/curb-data-specification/blob/main/curbs/README.md. Do not run the Passport sweep; use data/raw/parkboston_zones.json as-is. Do not touch ios/ or executor/.

Context: the City of Boston runs a public CDS Curbs API at https://cds-curb-api.boston.gov (docs at /docs, OpenAPI at /openapi.json). It is the authoritative curb-zone layer and its `user_zone_id` field is, per the CDS spec, the identifier used on signage and in payment apps — i.e. the ParkBoston zone number we currently scrape from Passport. This PR makes CDS the primary Boston zone source and keeps the meter-derived build as fallback for uncovered curb.

Step 0 — probe, before writing code. Fetch /openapi.json and one /curbs/zones bbox query around Newbury St (42.348,-71.090,42.353,-71.075) and one /curbs/policies call. Write data/notes/boston_cds_probe.md recording: spec version and required Accept header; whether user_zone_id is populated and whether it matches the ParkBoston numbers for zones we have paid at (see PRs #112/#113 and zone_terms_observed); geometry type; whether /curbs/policies is implemented; whether rate arrays exist; whether any zone has `available`; total zones and bbox extent; any 429/Retry-After; any securitySchemes. If user_zone_id is absent or does not match, STOP and report — the rest of this PR changes shape.

Exact behavior:
1. data/fetch_boston_cds.py: tile the Boston bbox (BOSTON_BBOX in import_parkboston_zones.py) into 2 km squares; GET /curbs/zones per tile with include_geometry=true and the correct Accept header; dedupe by curb_zone_id; fetch every referenced policy via /curbs/policies?ids= in batches of 50; write data/raw/boston_cds_zones.geojson (FeatureCollection, properties = the CDS zone fields) and data/raw/boston_cds_policies.json; record the envelope's last_updated in a metadata block. 2 req/s, identifying User-Agent, exponential backoff on 429/5xx, never partial-write.
2. data/cds_policies.py: `policies_to_windows(policy_ids, policies, tz) -> {hours_json, restrictions_json, rate_first_hour, rate_additional_hour, max_stay_minutes, passenger_allowed}`. Apply the CDS precedence rule (overlapping time spans, same user class → lowest priority wins). Rates are cents per rate_unit; convert to dollars per hour; use start_duration/end_duration for the second-hour ladder; maximum_fee when present. `no parking`/`no stopping`/`travel` rules become restrictions_json entries {days, start, end, reason, designated_period}. passenger_allowed is false when every `parking` rule's user_classes exclude `car`, or purposes are loading-only.
3. data/build_boston_zones.py gains `--cds`: zones built from CDS first (geometry from CDS; if LineString, buffer with the existing one-sided rule using street_side), regulation fields from policies_to_windows, `provider_zone_number` = user_zone_id with `zone_number_known` true, plus properties geometry_source ("cds"|"meters"), regulation_source ("cds"|"pay_policy"|"default"), cds_zone_id, cds_last_updated. Meter-derived zones are emitted only where no CDS zone overlaps ≥ 50% of their centerline. Output stays data/out/boston_zones.geojson with the same required properties so load:zones is unchanged.
4. Crosswalk: data/out/boston_zone_crosswalk.json maps old meter-derived zone ids to CDS-derived ids (same normalized street, side agrees, and ≥ 50% centerline overlap or both cross streets match). server/src/scripts/load-zones.ts reads it and remaps zone_number_reports.zone_id and zone_terms_observed.zone_id in the same transaction so no report or session evidence is orphaned; log counts.
5. Server: Prisma migration adding zones.cds_zone_id (text, nullable, indexed), zones.restrictions_json (jsonb), zones.geometry_source, zones.regulation_source; ZoneNumberImport/ZoneNumberReport gain `source` ("import"|"records"|"cds"|"report"|"survey"|"session") and `verified_at`. One function `resolveZoneNumber(claims[])` in services/zoneNumber.ts implements precedence: verified report ≥ session-confirmed ≥ cds ≥ records ≥ import ≥ single report; load-zone-numbers.ts and the report route both call it. A paid session whose executor result carries provider-observed zone terms writes a `session` claim (two = verified). Any CDS number that conflicts with a verified report is written to a `zone_number_conflicts` table, never applied silently.
6. zoneLookup/streetOptions: a street option whose zone has a restrictions_json span covering the requested window is marked streetState "restricted" with the reason, and is excluded from quoting; /zones/near returns restrictions_json.
7. Matcher v2 for the Passport import (still needed for zones CDS hasn't digitized): add grammar for "<street> <a>-<b>", "<street> from <a> to <b>", side-as-suffix; fuzzy SAM street lookup (token ratio ≥ 0.9); split-on-disjoint-claims into `<id>-a`/`-b`; one reason code per zone (matched|ambiguous|unparseable|corner_unresolved|side_mismatch|no_feed_zone_nearby|covered_by_cds).
8. Coverage: data/coverage.py writes data/out/coverage.json with zones_known/zones_total, known_metered_length_m/metered_length_m, and cds_share; data/test_coverage.py asserts the first two are ≥ data/coverage.baseline.json (commit the baseline from this run). Add to the CI job that runs data tests (or add a `data` job; < 2 min, no network — the test reads committed outputs, never fetches).

Tests that must FAIL before and PASS after:
- data/test_cds_policies.py: fixtures for (a) metered Mon–Sat 08–20, 120 min max, 375 cents/hour → hours_json + rate 3.75; (b) the same plus a Tue 08–12 `no parking` street-sweeping rule at higher precedence → restrictions_json entry and hours unchanged; (c) resident-permit-except rule → passenger_allowed true only outside the permit span; (d) loading-only zone → passenger_allowed false; (e) two-tier rate via start_duration/end_duration → rate_first_hour ≠ rate_additional_hour; (f) maximum_fee respected.
- data/test_build_boston_zones.py: a CDS LineString zone is buffered one-sided using street_side; a meter-derived zone overlapping a CDS zone ≥ 50% is dropped; a crosswalk row is written for it.
- data/test_import_parkboston_zones.py: new grammar forms parse; fuzzy corner resolves; disjoint claims split; overlapping claims stay ambiguous; every zone has exactly one reason code.
- data/test_coverage.py fails below baseline.
- server/test/zoneNumber.test.ts: table-driven precedence for resolveZoneNumber including the cds tier; a CDS number conflicting with a verified report goes to zone_number_conflicts and the zone keeps the verified number; a second paid session verifies; withdrawn import reverts to reports.
- server/test/zoneLookup.test.ts (or streetOptions): a zone with a restriction covering the window is "restricted" and not quoted; /zones/near carries restrictions_json.
- server/test/loadZones.test.ts: the crosswalk remaps a report's zone_id in the same transaction.

Then: run `uv run data/fetch_boston_cds.py`, `uv run data/build_boston_zones.py --cds`, `uv run data/import_parkboston_zones.py --skip-sweep --no-llm`, `uv run data/coverage.py`; paste before/after coverage and the reason-code counts into the PR description. Load dev with `pnpm -C server load:zones` then `load:zone-numbers`. `pnpm -r lint && pnpm -r test`. Boot the API locally in dry run (`pnpm -C server dev` against a migrated PostGIS; `pnpm -C server create:fr-user` if needed) and run the FR suite with FR_API_BASE=http://localhost:<port>; FR-36's /zones/near checks must pass with CDS-derived zones and restrictions present. Update data/README.md (CDS source, probe notes, `--cds` build, crosswalk, restrictions, coverage gate) and server/API.md (/zones/near restrictions_json, streetState "restricted").

Skeptical self-review: (1) find one zone where CDS user_zone_id disagrees with a Passport import or a session-observed number and explain which is right and why the precedence handles it; (2) find a CDS zone with a `travel` or `no stopping` rule during business hours and confirm it never appears as a street option; (3) check that a zone retired by CDS (end_date set) with existing sessions is remapped, not deleted; (4) confirm the prod load path in the README still holds and that load:zones on prod is idempotent with the crosswalk; (5) confirm no network access happens in CI tests. Push, open the PR, CI green before ready.
```

**PR 3 — garage provider capabilities, modes, two-phase booking, contract tests**

```markdown
Branch: feat/garage-provider-capabilities (branch from main).

Read first: CLAUDE.md, server/API.md ("Garage providers"), server/src/services/garage/garageProvider.ts, multiProvider.ts, spotheroDeepLink.ts, parkwhiz.ts, server/src/services/assistant/tools.ts (search_garages, propose_plan, confirm), server/src/index.ts (provider wiring), server/test/parkwhizAdapter.test.ts, assistantGrounding.test.ts, docs/assistant-verification.md, scripts/boot-check.sh. Do not touch ios/; the app must keep working unchanged.

Goal: the partner APIs can replace today's public-search readers without app changes, and the readers are governed by explicit modes and a daily budget.

Exact behavior:
1. GarageProvider gains `readonly capabilities: ProviderCapabilities` = { search: "public_read"|"partner", book: "deeplink"|"reserve", availability: "none"|"snapshot"|"live", entrances: boolean, cancel: boolean }. `canReserve` becomes a derived getter (book === "reserve") kept for compatibility.
2. GarageOption gains optional `entrance?: {lat,lng}`, `availability?: "available"|"limited"|"unknown"`, `heightLimitCm?`, `amenities?: string[]`, `cancellable?: boolean`, `provenance: { provider, fetchedAt, mode: "public_read"|"partner" }` (provenance required; fill it in both readers). ParkWhiz reader fills `entrance` from entrances[0].coordinates.
3. Two-phase booking: `quote(optionId) -> { holdToken, priceUsd, expiresAt }` and `book(holdToken)`. Deep-link providers implement quote by minting a signed, 10-minute token over (optionId, priceUsd) using the existing state crypto (services/crypto.ts) and book() verifies it and returns the deeplink_handoff as today. POST /assistant/confirm calls quote then book; the confirm response gains `priceUsd` from the quote so a price that moved between search and confirm is what the user actually sees. Keep the existing confirmation-token gate untouched.
4. Modes and budget: new services/garage/registry.ts with `garageProvidersFromEnv(env)`. PARKWHIZ_MODE and SPOTHERO_MODE ∈ public|partner|off (default public to preserve today's behavior; PARKWHIZ_ENABLED=false maps to off for backward compatibility with a deprecation warning at boot). GARAGE_PUBLIC_READ_BUDGET (default 500) is a per-provider, per-UTC-day cap on outbound public reads; past it search returns {ok:false, error:"blocked", detail:"daily public-read budget"} and a decisions row of kind "garage_budget" is written once per day per provider. Add the new env vars to both lists in scripts/boot-check.sh and boot logging goes through the app logger.
5. Partner adapter skeletons: parkwhizPartner.ts implementing OAuth client_credentials with scope=partner against a configurable base URL (sandbox by default), search via /v4/quotes with the same parser as the reader (move parseParkWhizQuote into parkwhizShared.ts), quote via the bookings preview endpoint, book via bookings create, capabilities { search:"partner", book:"reserve", availability:"snapshot", entrances:true, cancel:true }. Instantiated only when PARKWHIZ_MODE=partner and PARKWHIZ_CLIENT_ID/SECRET are set; no live calls in tests. spotheroPartner.ts: interface-complete stub that throws "not configured" from search until credentials exist, so wiring is proven.
6. Contract test: server/test/garageProviderContract.ts exports `describeGarageProvider(name, make, fixtures)` and runs: typed search outcomes; optionById round-trip; book on unknown id throws; 401/403/429 → blocked; prices numeric with fees; provenance present; quote→book succeeds and book with an expired or tampered hold token is refused. Run it for SpotHero reader, ParkWhiz reader, ParkWhiz partner (fixtured), and the multi provider.
7. search_garages reports `capabilities` per provider in its tool result and propose_plan's provenance carries `mode`; the confirm note text is chosen from capabilities.book, not from the provider id.

Tests that must FAIL before and PASS after: the contract suite for all four; registry tests (PARKWHIZ_ENABLED=false → off with warning; budget exhaustion → blocked and exactly one decisions row); confirm returns the quote's priceUsd and refuses a tampered holdToken; the ParkWhiz partner adapter with a fixture booking returns {kind:"reserved", confirmationId}.

Then: `pnpm -r lint && pnpm -r test`. `scripts/boot-check.sh off` and `on` must pass with the new vars. Boot the API locally in dry run and run the FR suite against it; the assistant FR tests must pass with both readers in public mode. Update server/API.md (capabilities, modes, budget, two-phase confirm) and .env.example.

Skeptical self-review: assume a partner key arrives tomorrow; walk through index.ts and list every line that would still need to change. If it is more than the env wiring, the seam is leaking; fix it. Check that no reader can exceed the budget through the cache-miss path. Confirm the executor is still the only module touching a street provider's site. Push, open the PR, CI green before ready.
```

**PR 4 — generalized-cost ranking, map/list sync, navigation handoff**

```markdown
Branch: feat/plan-ranking-map-handoff (branch from main after PR 1 and PR 3 merge).

Read first: CLAUDE.md (iOS project and release-denylist rules), server/API.md ("Assistant", plan shapes), server/src/services/assistant/plans.ts (recommendationReason, planSchema), tools.ts (propose_plan), services/assistant/streetOptions.ts, ios/ParkAgent/Views/Assistant/PlanCards.swift (PlanMiniMap, SingleSpotPlanCards, PlanSelection), AssistantSheetView.swift, ios/project.yml, ios/Tools/release-denylist.txt, and the iOS unit test target layout. Run `cd ios && xcodegen generate` after any project.yml change; never edit the .xcodeproj.

Goal: one ranking function on the server orders options and picks "recommended"; the iOS list and mini-map share one selection model; a Directions sheet hands off to Apple Maps, Google Maps, or Waze in one tap.

Exact behavior (server):
1. services/assistant/ranking.ts exports `generalizedCostUsd(option, prefs, ctx)` and `rankOptions(options, prefs, ctx)`. C = price + valueOfTimeUsdPerHour × walkMinutes/60 + expectedTicketUsd + entryPenaltyUsd + availabilityPenaltyUsd, with defaults { valueOfTime: 18, ticket: from policy city_overrides, pTicket: {garage:0, verifiedStreet:0.02, unverifiedStreet:0.15}, entry: {valet:4, unknown:2, self:0}, availability: {limited:2} } exported as RANKING_DEFAULTS. Hard filters: over session cap, max stay < requested, missing zone number unless free street, height limit. propose_plan orders options by C, sets `recommended` on argmin, stores `costUsd`, `rankCost`, and `rankReason` (two dominant terms vs runner-up) on each option; the model's `recommended` flag is overwritten and the model's reason is replaced by rankReason. Per-user prefs come from a new nullable users.ranking_prefs JSONB (valueOfTime, entryPenaltyValet) with a PUT /me/ranking-prefs route; API.md documents both.
2. GET /zones/near gains `?state_at=<ISO>&duration_minutes=<n>` and returns each zone's `streetState` for that window (reuse streetOptions' state logic) so the map can color curbs.

Exact behavior (iOS):
3. `PlanSelection` becomes an @Observable model owning selectedOptionID, hoveredOptionID, visibleOptionIDs, sort; PlanMiniMap and the cards list both bind to it. Tapping a pin selects and scrolls the list (ScrollViewReader) to that card and expands it; tapping a card selects and recenters the map (existing behavior). Filter chips above the list: All, Street, Garages, Cheapest, Closest; they change sort/visibleOptionIDs and the map dims hidden pins (opacity 0.35), never removes them.
4. Curb lines: PlanMiniMap draws polylines for zones within the plan's walk radius from /zones/near (state_at = the plan's start, duration = the stay), colored paid/free/no-parking using existing semantic colors; cap 40; hidden when the map is smaller than 180 pt tall.
5. Garage pins use `entrance` when present; an `availability == "limited"` option shows a small badge; `walkEstimate == true` renders "~7 min" instead of "7 min".
6. `Support/NavigationHandoff.swift`: `enum NavigationApp { appleMaps, googleMaps, waze }`, `struct NavigationTarget { lat, lng, name, mode: .driving|.walking }`, pure `func urls(for target) -> [NavigationApp: URL]` (Apple: maps:// with daddr and dirflg d/w; Google: comgooglemaps://?daddr=lat,lng&directionsmode=driving|walking; Waze: waze://?ll=lat,lng&navigate=yes, omitted for walking), `func installedApps() -> [NavigationApp]` via canOpenURL, `func open(_ app, target)` using MKMapItem for Apple. Add `comgooglemaps` and `waze` to LSApplicationQueriesSchemes in project.yml. A "Directions" button on the selected card presents a sheet listing installed apps in the user's remembered order (UserDefaults key `navigationAppOrder`, updated on each pick); the target is the option pin (entrance if known), mode driving. After a street session starts, a "Walk to <destination>" button on the session card does the same with mode walking and no Waze.
7. Nothing new outside Views/ imports MapKit except NavigationHandoff's Apple branch; nothing new is debug-only, so no denylist changes; if you add a preview-only helper, wrap it in #if DEBUG and add its marker to the denylist.

Tests that must FAIL before and PASS after:
- server/test/ranking.test.ts: a $6-cheaper option 4 minutes farther wins at valueOfTime 18 and loses at 30; a street zone with no number is excluded; the model's recommended flag is overwritten; rankReason names the two dominant terms; /zones/near returns streetState for a window.
- iOS unit tests: NavigationHandoff urls for driving contain all three apps and for walking exactly two, with correctly formatted coordinates; PlanSelection: selecting via pin sets selectedOptionID and the list's target id; filter "Garages" hides street ids but keeps them in the plan.
- iOS UI test (continue-on-error job): with -useMockAPI YES, tapping a map pin expands the matching card (accessibility identifiers assistant.option.<id>).

Then: `pnpm -r lint && pnpm -r test`; `xcodebuild -scheme ParkAgentRelease test` and ios/Tools/check-release-binary.sh on the Release build. Boot the API locally in dry run and run the FR suite against it; FR-35/36 must pass and the plan must carry rankCost/rankReason. Update server/API.md and the iOS README section for the handoff.

Skeptical self-review: assume the ranking makes a garage recommended over a free street spot in a case a human would never pick; construct that case from the defaults and decide whether the weights or the filters are wrong. Check the map never becomes pannable inside the transcript. Check the handoff never targets the destination for the driving leg. Confirm the Release binary strings check is clean. Push, open the PR, CI green (server, ios, executor, city-neutral, boot) before ready.
```

## 7. Open questions for the founders

- [ ] **Public-read exposure.** You are reading SpotHero's and ParkWhiz's site endpoints without a license and sweeping Passport's feed with a personal session. Which of these are you willing to keep running the day a partner email goes out? My recommendation: send the emails first, keep PARKWHIZ/SPOTHERO in `public` mode with the budget until you get a written no, and stop the Passport sweep the moment the records request or CD-Gate lands.
- [ ] **Apple terms.** Schedule 6 restricts caching and storing map data beyond temporary use ([forum thread quoting it](https://developer.apple.com/forums/thread/807656)). Stored plans keep the geocoded destination pin and label indefinitely. Is that acceptable to you, or do you re-geocode on read and store only the query? Ask Apple through the Maps dashboard; don't guess.
- [ ] **Who sends the City email, and as what?** The Curb Lab wants navigation and delivery partners. Do you present as a startup asking for early access, or as a resident-built tool willing to contribute the driver-reported zone numbers back? The second gets a faster reply. \[I\]
- [ ] **SpotHero after Uber.** If the deal has closed (I couldn't confirm as of 2026-09-26), SpotHero inventory may become Uber-exclusive over time. Is a ParkWhiz-only garage layer acceptable for the TestFlight milestone?
- [ ] **Ranking weights.** $18/h value of time and a $4 valet penalty are guesses. Do you want a two-option onboarding question ("closer or cheaper?") or leave defaults and tune from `decisions`?
- [ ] **Free-street options.** Should the ranker ever recommend an unmetered curb (no payment, no ticket risk modeled, no availability data)? Today's `metered_then_free` state suggests yes; the ticket model says only with an explicit user preference.
- [ ] **Zone splitting changes ids.** PR 2's split rule creates `<id>-a/-b` zones; existing `zone_number_reports` keyed on the old id need a migration rule (assign to both halves? drop?). Decide before running it on prod.
- [ ] **Google Places as a paid fallback.** It adds a billing account and a second key. Worth it now, or only if the Apple autocomplete path leaves measurable gaps in `decisions`? I'd wait for the data.
- [ ] **Field survey.** Are either of you willing to spend two afternoons walking the unmatched blocks with the app in report mode? It is the cheapest path to 95% and no one else will do it for you.

## Sources

Pages opened for this doc (as of 2026-09-26). Repo facts come from CLAUDE.md, data/README.md, server/API.md, and the named source files in the ParkAgent project.

- [Apple Maps Server SDK reference (search/geocode/etas parameters)](https://github.com/JS00001/apple-maps-server-sdk)
- [apple-maps-java: search vs autocomplete](https://www.mintlify.com/WilliamAGH/apple-maps-java/guides/search-autocomplete)
- [WWDC22 Meet Apple Maps Server APIs (25k/day quota)](https://wwdcnotes.com/notes/wwdc22/10006)
- [Apple forum thread on quota and Schedule 6 caching](https://developer.apple.com/forums/thread/807656)
- [Google Places API: places.searchText](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/searchText)
- [Google Places API: places.autocomplete](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/autocomplete)
- [Google AI blog: predicting parking difficulty](https://ai.googleblog.com/2017/02/using-machine-learning-to-predict.html)
- [Engadget: Google Maps find-parking UI](https://www.engadget.com/2017-08-29-google-maps-parking-difficulty-25-more-cities.html)
- [Google Maps URL scheme for iOS](https://developers.google.com/maps/documentation/urls/ios-urlscheme)
- [Waze deep links](https://developers.google.cn/waze/deeplinks)
- [Uber: improving pickups with better location accuracy](https://www.uber.com/blog/beacon-improving-pickups-with-better-location-accuracy)
- [TechCrunch: Uber suggested pickup points](https://techcrunch.com/2015/07/08/uber-suggested-pickup-points)
- [Parkopedia: mobile navigation (Apple Maps integration)](https://business.parkopedia.com/solutions/mobile-navigation) and [parking data](https://business.parkopedia.com/parking-data)
- [OMF CDS release 1.1.0](https://github.com/openmobilityfoundation/curb-data-specification/wiki/Release-1.1.0)
- [OMF minutes 2023-05-30 (INRIX curb data, CDS API)](https://github.com/openmobilityfoundation/curb-data-specification/wiki/Web-Conference-2023.05.30-Curb)
- [OMF minutes 2021-06-01 (Coord Boston data)](https://github.com/openmobilityfoundation/curb-data-specification/wiki/Web-Conference-2021.06.01-Curb)
- [Dealroom: Coord (acquired by Sidewalk Labs, 2022)](https://app.dealroom.co/companies/coord)
- [boston.gov: ParkBoston (Passport since August 2025)](https://www.boston.gov/departments/parking-clerk/parkboston)
- [PR Newswire: Boston modernizes parking with Passport](https://www.prnewswire.com/news-releases/city-of-boston-modernizes-parking-with-passports-unified-platform-302577584.html)
- [boston.gov: Boston Curb Lab](https://www.boston.gov/departments/emerging-technology/boston-curb-lab-using-ai-and-open-data-improve-curb-management)
- [Stamen: Mapping Boston's curbs](https://stamen.com/mapping-bostons-curbs/)
- [Apolitical: digitizing the curb in Boston (CDS, Cyclomedia, Cartegraph)](https://apolitical.co/en/articles/digitizing-the-curb-in-boston-using-ai-to-create-a-smarter-more-transparent-system-for-parking-and-curb-use)
- [Uber investor release: acquiring SpotHero](https://investor.uber.com/news-events/news/press-release-details/2026/Uber-to-Acquire-Parking-App-SpotHero/default.aspx)
- [API Report Card: SpotHero](https://supergood.ai/api-report-card/spothero) and [ParkWhiz](https://supergood.ai/api-report-card/parkwhiz)
- [Arrive developer portal](https://developer.arrive.com) and [transactional API walkthrough](https://partners.arrive.com/docs/walkthroughs/api/transactional-api)
- [ParkMobile Boston parking page](https://parkmobile.io/parking/locations/ma/boston-parking)
