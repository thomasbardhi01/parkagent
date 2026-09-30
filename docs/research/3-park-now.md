# Park Now: street, garage, lot, no-pay — research, design and build plan

Sep 26, 2026 · @Thomas Bardhi

## How to read this

Every claim is tagged. **\[S\]** = a source says it (linked in Sources). **\[R\]** = read from the ParkAgent repo today (CLAUDE.md, `ios/ParkAgent/Detection/`, `server/API.md`, `server/src/services/zoneLookup.ts`, the FR suite). **\[I\]** = my inference or design judgment; treat it as an opinion to test in the field, not a fact. Apple API behavior I state from training knowledge (VisionKit, CoreMotion, ActivityKit) is marked **\[K\]** and should be checked against current docs before you rely on a threshold.

This is not legal advice; section 6 says where a lawyer is needed.

**Brutal-honesty preface.** Three things in the brief are harder than they read:

1. Garage detection is not one problem. "Did they park in a garage" is easy (GPS goes dark after a drive; you already emit `park_unlocated`). "Which garage" is usually easy from the last good fix. "Is this a paid, ticketed garage" is not knowable from sensors; it comes from data or the user. Don't spend sensor effort on the wrong sub-problem.
2. Paying a paper ticket by driving an operator's pay-by-web page is a different legal and product posture from driving ParkBoston with the user's own linked session. On the street the user has an account, has accepted terms, and has a saved card; the operator's scan-to-pay page usually has no account at all. That is *lower* CFAA risk (no gate) but the payment is card-not-present on a third-party checkout with no partner relationship, and the ticket only lifts the gate if the PARCS back end learns of the payment. Most of what you want here is a partnership, not code.
3. The thing you can ship in weeks with zero partner risk is: detect the garage, identify it, read the ticket, keep a running estimate, and hand the user a one-tap route to the operator's own pay page (or the pay station) with the caps enforced on your Issuing card. The fully automatic "we paid your ticket" needs either a partner or the user's own operator account. The plan below is sequenced that way on purpose.

## 1. Executive summary

**Decision:** extend the existing fusion engine with a *place classifier* that runs after `park_fired` / `park_unlocated`, not a second detector. Add one new outcome (`garage`) and one new server-side action (`garage_ticket`). Ship the garage ticket flow as *assisted* (read ticket, identify garage, estimate fee, cap the card, hand off to the operator's own pay page) before any *automatic* payment, and pursue one Boston PARCS partner in parallel.

What the research supports:

- **Detection \[R\]\[S\].** Your engine already does what Apple Maps does (drop a pin on Bluetooth/CarPlay disconnect) plus motion and visits. Apple's own docs say Parked Car is triggered by the audio disconnect and needs Significant Locations; it is known to be imprecise indoors and underground. Nobody has a sensor trick for "inside a garage"; every published approach is GPS-loss + barometer + map footprint. The barometer is good for *relative* level changes (about 0.12 hPa/m) and bad for absolute floors (2 hPa drift between phones). Use it to say "climbed 6 m after GPS died", never "level 3".
- **Classification \[I\].** Four classes: `street`, `garage`, `lot`, `nopay`. The single most valuable input is a per-user *place memory* (home, work, a garage they used before): after two visits, the answer is known before the car stops. The second is a footprint index of garages and lots (OSM `amenity=parking` with `parking=multi-storey|underground|surface`, plus Apple/Google POI as a cross-check). Sensors only break ties.
- **Ticket capture \[K\]\[I\].** VisionKit `DataScannerViewController` reads barcodes and text live; Vision `VNRecognizeTextRequest` on a still frame is more accurate for structured fields. Tickets carry a Code 128 / ITF / QR / PDF417 barcode encoding a ticket id (sometimes the entry timestamp), plus printed garage name, entry time, rate line, and increasingly a scan-to-pay QR URL. A VLM is a fallback with a strict schema; the ticket id must come from the barcode, never from OCR.
- **Paying \[S\]\[I\].** In Boston, the realistic near-term paths are (a) the operator's own scan-to-pay page printed on the ticket (Flash/ParkWhiz, HUB J4Pay, TIBA, Parkonect), driven only with user consent, with your card; (b) ParkMobile/ParkBoston's own gated-garage integration where the user already has a linked account; (c) Metropolis, which is ticketless and account-based and needs a partnership. Payment lifts the gate only when the PARCS learns of it; that is the partner's system, and the exit flow varies by vendor (insert paper ticket, scan phone QR, or LPR).
- **Guardrails \[S\].** Card networks and Stripe Issuing already model unknown-final-amount purchases: real-time authorization decisions, partial authorization when `is_amount_controllable`, incremental authorizations as further `.request` events. Your webhook already decides in \~2 s. The gap is a *stay-level* budget (estimate × 1.25 + lost-ticket fee) that the per-authorization decision consults.
- **Legal \[S\].** After *Van Buren* and *hiQ*, automated access is a CFAA problem when it passes an authentication gate it was not authorized to pass; a ticket's public pay page has no gate. Terms-of-service and card-network rules, plus the user's own fraud exposure, are the live risks. Any path that logs in to an operator account, or that submits a card on a checkout that prohibits automation, needs counsel before it runs outside the founders' own cars.

What to build now (4 weeks, 6 PRs, all under `DRY_RUN` and existing caps): place classifier + place memory + garage/lot footprints; `garage` outcome with the confirm prompt; ticket capture + parser + `garage_tickets` table; fee estimator with rate cards; stay budget on the Issuing webhook; Activity receipts. What needs a partner: automatic payment that lifts a gate.

What I'd stop doing: treating the garage as a street meter with a different UI. It is a different payment relationship, and the product should say so to the user.

## 2. Research: detection and place classification

**Bottom line \[I\]:** "truly parked" you already have; the new work is *classifying the place*, and the strongest classifier inputs are memory and map data, not new sensors.

### What others do

- **Apple Maps Parked Car \[S\].** Apple's support page says Maps drops a parked-car marker when the iPhone disconnects from the car's Bluetooth or CarPlay and the user exits the vehicle; it requires Location Services and Significant Locations ([Apple](https://support.apple.com/en-au/101587)). A developer-forum thread confirms there is no public API to receive that event; the closest public analogue is `CLVisit` ([Apple Developer Forums](https://developer.apple.com/forums/thread/49288)). Third-party write-ups note the marker is less precise indoors and in underground garages ([iGeeksBlog](https://www.igeeksblog.com/?p=581824)). *Inference:* Apple fuses the audio disconnect with the last good fix and Significant Locations; you do the same plus motion history, which is strictly more evidence.
- **Google Maps \[K\].** On Android, parking location is saved automatically from the Bluetooth disconnect plus activity recognition (in-vehicle → on-foot); on iOS it is manual. Same signal family. Not sourced in this session; treat as approximate.
- **Rideshare / fleet \[I\].** Driver apps do not detect parking; they know trip state from the dispatch server. Telematics (EverDrive-style) detect trip end from speed and a stationary timeout, which is your `sustainedStop` rule. Nothing to borrow beyond what you have.
- **Research on garages \[S\].** Vehicle-in-garage localization work uses gyro + odometer + a 3D map with particle filters, and uses an altimeter only for floor height ([Bojja et al.](https://www.researchgate.net/publication/261203418_Indoor_3D_navigation_and_positioning_of_vehicles_in_multi-storey_parking_garages)). Smartphone floor-localization work states the barometric relation as about 0.12 hPa per metre and reports up to 2 hPa drift *between phones on the same floor*, i.e. errors of several storeys for absolute floors ([Sensors 2019](https://doi.org/10.3390/s19163622)); a 2024 paper combines GPS for the entering event with barometer for movement between floors ([Sci. Reports 2024](https://www.nature.com/articles/s41598-024-64824-9)). *Inference:* relative pressure change over a 3-minute window is a reliable "went up/down a ramp" cue; absolute level is not.

### Signals, in order of value \[I\]

| Signal | What it tells you | Cost | Notes |
| --- | --- | --- | --- |
| Place memory (per user) | The whole answer at home, work, a repeat garage | none | Match last settled fix or last-good-fix-before-loss to a saved place within 60 m. Two confirmed visits create a place; the user can name it. |
| Footprint index (OSM + POI) | garage vs lot vs street, name, operator hint | none at runtime | OSM `amenity=parking` + `parking=multi-storey`/`underground`/`surface`/`street_side`, `fee`, `access`, `operator`, `name`. Cross-check with MapKit POI category `.parking` \[K\]. Build offline into PostGIS next to zones. |
| Last good fix before GPS loss | Which footprint the car entered | already collected (burst) | Keep the last fix with accuracy ≤ 30 m and speed > 1 m/s as `entryFix`; the garage is the footprint whose entrance is within 40 m of it along the heading. |
| GPS loss pattern | garage (esp. underground) | already collected | Accuracy climbs from <20 m to >65 m within 30 s, or fixes stop entirely, while motion still says automotive. Surface lots do not do this. |
| Barometer (`CMAltimeter.startRelativeAltitudeUpdates`) \[K\] | Ramps: ≥ 2.5 m net change after GPS degraded; spiral: repeated ±3 m steps | low (event-driven); only run during the stop window | Use `relativeAltitude` deltas only. Ignore if a window opened (pressure spike > 0.5 hPa in < 2 s). |
| Turn profile (CMMotion rotation rate, or fix headings) | spiral ramp: sustained yaw > 20°/s for > 8 s at < 4 m/s | low | Rare enough that it should only add confidence, never be required. |
| Speed profile | lot/garage: 2–4 m/s crawl for > 30 s before stop; street: decel from > 8 m/s to stop in < 15 s | already collected | Weak alone. |
| Motion stop → walking | truly parked | already collected | Garage: walking is often delayed (elevator) and indoors; do not require it for `garage`. |
| CLVisit | arrival confirmed by iOS | already collected | Visits arrive late; useful for the offline/unlocated case. |
| Wi-Fi SSID \[K\] | garage identity | not available to third-party apps without special entitlement; skip |  |

### Classification rules (first version, tune in the field) \[I\]

Score each class 0–1; act on the top class if it beats the runner-up by ≥ 0.3, otherwise confirm.

- `nopay` = 0.95 if inside a saved `nopay` place; 0.8 if the footprint index says `access=private` or a residential driveway (Apple POI has none; OSM `parking=surface` + `access=private`); 0.7 if no metered zone within 60 m and no paid footprint within 60 m and the enforcement profile is free.
- `street` = your existing `zoneLookup` result: 0.9 when candidates agree, 0.6 when they disagree, 0 when `unknown_zone`. Streets never lose GPS.
- `garage` = 0.9 if `entryFix` is within a `multi-storey|underground` footprint entrance and GPS was lost or degraded; +0.05 for a barometer delta ≥ 2.5 m; +0.05 for a crawl profile; 0.6 if GPS was lost with no footprint match (unknown garage: ask).
- `lot` = 0.85 if the settled fix lies inside a `surface` footprint with `fee=yes`; 0.6 if `fee` unknown.

### Thresholds carried from the repo \[R\]

Keep the engine's `agreementWindow` 90 s, `sustainedStop` 150 s, `debounce` 180 s, `settleRadiusM` 20 m, `burstTimeout` 90 s. Add: `gpsLossWindow` 45 s (no fix or accuracy > 65 m while automotive), `entryFixMaxAge` 120 s, `baroWindow` 180 s.

### Battery \[I\]

The classifier adds nothing while idle. `CMAltimeter` runs only from the first stop signal to `burstTimeout`, so under 3 minutes per park. Footprint lookups are one PostGIS query in `/parked`, or an on-device R-tree of Boston/NYC footprints (about 3,000 polygons per city, a few hundred KB). Budget target: no measurable change over today's burst cost; verify with the field protocol.

### Failure cases and what the machine does

| Case | What happens | Mitigation \[I\] |
| --- | --- | --- |
| Passenger in someone else's car | Park fires for the passenger | Existing: notification only, no auto-pay for `garage`; for `street`, keep the existing confirm rules. Add a "Not my car" action that suppresses parks at that spot for 2 h and teaches place memory nothing. |
| Rideshare / taxi drop-off | Audio never connected; motion stop + walking | Requires two kinds; with no audio and no settled fix it stays pending, then expires. With a settled fix on a metered block it *will* fire: the confirm prompt catches it. Never auto-pay when the audio kind is absent *and* the drive was under 3 minutes. |
| Bus / train | automotive can read true on transit | Speed > 25 m/s or a rail corridor footprint → drop the stop. Transit stops rarely settle within 20 m on a metered block. |
| Drive-through, red light | Already handled: driving resumes, stop cleared | none |
| Valet | User stops in a lane, walks; car moves later | Footprint with `valet` hint or a hotel POI → class `valet_or_lot` → always confirm; no ticket flow. |
| Underground, no signal at all | No fix after entry; `park_unlocated` | Classify from `entryFix`; queue the park offline; deliver the garage prompt from the last good fix; fee clock starts at `stopAt`. |
| Garage with GPS leaking on top level | Looks like street | Footprint containment wins over GPS presence; a fix inside a garage polygon is `garage`. |
| Precise Location off | Fixes are km-wide | Already surfaced (`preciseOff`); classifier answers `unknown`, asks. |
| Same place twice in a day (mall) | Debounce swallows the second | Fine; the garage session is still open. |
| Stop-and-go street search | Several stops before the real one | Each is cleared by driving; only the last fires. Ticket capture is user-initiated so a false garage prompt costs one dismiss. |

## 3. Research: confirmation UX

**Rule \[I\]:** act automatically only when three things are true at once: the *place* is certain (classifier margin ≥ 0.3 or a saved place), the *price* is known before you commit, and the *money* is the user's own linked account under your caps. Street meters pass all three. A garage ticket fails the second (price is known only at exit) and often the third (no account with the operator), so a garage is always a *prompt*, never silent, until a partner or account exists.

### What best-in-class prompts look like \[I, from observed practice\]

- ParkMobile's gated flow makes the user do three explicit things: pull a ticket, scan the barcode in the app, tap "Ready to leave" to show a QR at the exit \[S\] ([ParkMobile support](https://support.parkmobile.io/hc/en-us/articles/203299160-How-do-I-use-Parkmobile-in-Gated-Garage-Facilities-)). No inference; every step is user-initiated. That is the bar for anything that touches a gate.
- Metropolis removes the prompt entirely by making the user register the plate once and charging on exit \[S\] ([Metropolis](https://app.metropolis.io/)). That only works because they own the camera and the ledger.
- Your existing `ParkedNotice` \[R\] already has the right instincts: time-sensitive, silent for no-pay, says what is in the way instead of inviting a payment the server will refuse. Extend it, don't replace it.

### Prompt ladder for the new outcomes

| Outcome | Interruption | Copy (title / body) | Actions |
| --- | --- | --- | --- |
| `street`, agree, under caps | none (auto-pay), then a passive notice | "Paid zone 81234" / "$4.10 for 1 h 05 m on Boylston St. Ends 3:05 PM." | Extend · Wrong spot |
| `street`, disagree | time-sensitive | "Parked on Boylston St" / "Which side are you on? North ($3.75/h) or South ($2.00/h)." | North · South · Not parked |
| `garage`, known | time-sensitive | "Looks like the Seaport Hotel Garage" / "Took a ticket? Scan it and ParkAgent will track the cost and pay when you leave." | Scan ticket · Not here · No ticket (plate/app) |
| `garage`, unknown | time-sensitive | "Parked in a garage?" / "ParkAgent lost GPS near Congress St. Scan your ticket to track the cost." | Scan ticket · Not a garage |
| `lot`, fee | time-sensitive | "Parked at Central Wharf lot" / "This lot charges. Scan the pay sign or your ticket." | Scan · Not here |
| `nopay` | none | (no notification; Activity gets a quiet row) |  |
| confidence < 0.3 | passive (not time-sensitive) | "Parked?" / "Tell ParkAgent what this place is and it won't ask again." | Street · Garage · Lot · No payment |

Notification actions: register a `UNNotificationCategory` per outcome with the actions above; "Scan ticket" deep-links straight into the scanner with the `parkedEventId`. Every tap writes a `decisions` row (`kind: place_confirmation`) with the classifier's inputs, which is the training data for section 8.

### Live Activity for a garage stay \[K\]\[I\]

Start an ActivityKit Live Activity at ticket capture: garage name, entry time, running estimate (updated at rate-card boundaries via push or local update, not per minute), cap remaining, and a "Leaving" button (App Intent, iOS 17+) that opens the pay handoff. Lock-screen and Dynamic Island give the user the running cost without unlocking. End the activity on receipt. Do not put the pay action itself on the lock screen; the handoff opens the app because it needs consent for an amount.

### When not to ask \[I\]

Never ask twice for the same place in a day. Never ask when the user is driving (motion automotive within the last 60 s). If no answer within 30 minutes, keep the park in Activity as "unconfirmed" and stop; a late "Scan ticket" from Activity still works because the entry time is the `stopAt` you already have.

## 4. Research: ticket capture on iOS

**Bottom line \[K\]\[I\]:** two passes. Pass 1 is live `DataScannerViewController` for the barcode alone, because a barcode read is exact and the ticket id is the only field that must be exact. Pass 2 is one still photo through `VNRecognizeTextRequest` (accurate level, language correction off for numbers) plus a rules parser for name, entry time, rate line and any URL. A vision-language model runs only when the rules parser reports low confidence, and only against a strict JSON schema whose fields it may *fill*, never *override* the barcode.

### Apple APIs \[K\] (verify against current docs)

- `DataScannerViewController` (VisionKit, iOS 16+): `recognizedDataTypes: [.barcode(symbologies:), .text(languages:textContentType:)]`, `isHighlightingEnabled`, `recognizesMultipleItems`, guidance labels. Requires a real device and `NSCameraUsageDescription`. Good for the live "find the barcode" step and for tapping a highlighted item.
- `VNRecognizeTextRequest` (Vision): `recognitionLevel = .accurate`, `usesLanguageCorrection = false` for the numeric pass and `true` for the name pass; `customWords` seeded with Boston garage names and vendor words ("ENTRY", "ENTERED", "LOST TICKET"). Returns bounding boxes, which you need for layout rules.
- `VNDetectBarcodesRequest` (Vision) on the still frame as a second chance if the live scanner missed the barcode (crumpled tickets).
- `VNDetectDocumentSegmentationRequest` (iOS 15+) to crop and deskew the ticket before OCR.
- `VNDocumentCameraViewController` is the wrong tool: it is a multi-page document scanner with its own UI and no barcode output.

### Symbologies to enable

Parking tickets in North America carry, in rough order of frequency \[I, from vendor material and observed tickets\]: **Code 128** (most magstripe-era PARCS printed a Code 128 backup), **Interleaved 2 of 5 / ITF** (Amano, some SKIDATA), **QR** (Flash, HUB J4Pay, TIBA scan-to-pay, ParkMobile gated), **PDF417** (SKIDATA, some TIBA), **Code 39** (older), **Data Matrix** (rare). Enable all six; the cost of extra symbologies in VisionKit is negligible. HUB's J4Pay and Flash's Scan to Pay both put a QR with a URL on the ticket or signage \[S\] ([HUB](https://www.hubparking.com/j4pay-smooth-payments-with-just-one-tap/), [Flash](https://www.flashparking.com/blog/six-benefits-of-digital-payments-for-parking-operations/)).

### What the barcode encodes \[I\]

Usually a ticket serial (8–20 digits), sometimes prefixed with a facility id, sometimes a packed entry timestamp (SKIDATA and TIBA formats vary and are not public). Treat the payload as opaque: store it verbatim, use it for dedup and for the pay page, and never parse a time out of it unless a facility rule says how.

### Field extraction rules \[I\]

1. Deskew and crop with document segmentation; reject the frame if the crop is under 30% of the frame or the aspect ratio is outside 1.4–3.5 (tickets are narrow strips).
2. OCR twice (numeric pass, text pass). Merge by bounding box.
3. Entry time: regex over the numeric pass for `MM/DD/YY HH:MM`, `MM/DD/YYYY HH:MM AM/PM`, `DD-MON-YY HH:MM`, `HH:MM MM/DD`; anchor to lines containing ENTRY, ENTERED, IN, TIME IN, ARRIVAL. Prefer the candidate closest to `stopAt`; reject any more than 30 min in the future or 12 h in the past relative to `stopAt`.
4. Garage name: the largest-font line in the top third, matched by fuzzy string (Jaro-Winkler ≥ 0.85) against the footprint index within 1 km of `entryFix`; otherwise the top line verbatim with `nameSource: ocr_unmatched`.
5. Pay URL: any `http`, `www`, or QR payload that parses as a URL; keep the host and compare it to a vendor allowlist (`flashos.com`, `parkwhiz.com`, `hubparking`, `tibaparking`, `parkonect`, `skidata`, `amano`, `parkmobile.io`, `paybyphone`). An unknown host is stored but never opened automatically.
6. Rate line: `$X.XX per HOUR`, `DAILY MAX $X`, `LOST TICKET $X`; store as hints, not as the rate card.

### Glare, crumples, fading \[I\]

- Ask for the photo on a flat surface with the flash off; enable the torch only when the exposure is under a threshold.
- Take three frames 200 ms apart and keep the one with the highest barcode confidence, then the highest OCR mean confidence.
- Thermal tickets fade from the edges: if the numeric pass finds no date, prompt "Type the entry time from the ticket" with `stopAt` prefilled. The barcode survives fading better than text.
- A crumpled ticket that yields no barcode after 5 s falls to Vision's still-frame detector; after that, manual ticket-number entry with a checksum-free warning.

### VLM fallback \[I\]

Run on the server (you already have `ANTHROPIC_MODEL` and strict JSON in the zone importer \[R\]). Input: the deskewed image and the parser's partial result. Schema: `{garage_name, entry_time_iso, ticket_number, pay_url, rate_hints[], confidence}`; every field nullable; `ticket_number` is *dropped* if it disagrees with the barcode. Log the model call in `decisions` like everything else. Never run it in the payment path; run it when the user is confirming.

### Validation before anything is paid

- Barcode present, or a manually typed number the user confirmed twice.
- Entry time within (`stopAt` − 15 min, `stopAt` + 30 min); otherwise the user confirms the time explicitly.
- Garage resolved to a footprint with a rate card, or the user picked one from the three nearest.
- Pay URL host on the allowlist, or the flow ends at "pay at the station".

## 5. Research: garage identity, rate cards, fee estimation

**Bottom line \[I\]:** build a `garages` table you own (like `zones`), seeded from OSM and POI, enriched from rate-board photos and ticket reads, and versioned. SpotHero and ParkWhiz facility pages are a *reservation* price, not the drive-up rate, and your adapters already return typed `blocked` on 401/403/429 \[R\]; do not scrape them for drive-up rates.

### Identity

- Seed: OSM `amenity=parking` polygons with `name`, `operator`, `parking`, `capacity`, `fee`, `access`, `website`; MapKit `.parking` POI names and coordinates as a cross-check \[K\]. Boston Common Garage, Government Center Garage, Prudential, Seaport Hotel, Boston Harbor Garage, Post Office Square, and Pilgrim/Central Parking style lots are all in OSM with names; operator tags are patchy. Give each a stable `garageId` and store `entrances[]` (OSM `entrance=*` nodes or the polygon edge nearest the road).
- Match order for a park: place memory → ticket name fuzzy match within 1 km → footprint containing `entryFix` → nearest entrance within 40 m of `entryFix` heading → ask (three nearest).
- Learning: every confirmed `(ticketName, garageId)` pair is stored; the second confirmation from a different user promotes it to an alias, mirroring your verified-zone-number rule \[R\].

### Rate cards

A rate card is a list of rules evaluated against `(entryAt, exitAt, dayOfWeek, eventFlag)`. First version \[I\]:

```json
{
  "garageId": "bos-seaport-hotel",
  "version": 3,
  "source": "rate_board_photo:2026-09-20",
  "currency": "USD",
  "graceMinutes": 15,
  "lostTicketUsd": 45,
  "rules": [
    {"kind": "tiered", "tiers": [[60, 12], [120, 24], [180, 32]], "thenPerHour": 4, "dailyMaxUsd": 42},
    {"kind": "early_bird", "inBefore": "09:00", "outBefore": "19:00", "days": ["Mon","Tue","Wed","Thu","Fri"], "flatUsd": 20},
    {"kind": "evening", "inAfter": "17:00", "outBefore": "02:00", "flatUsd": 18},
    {"kind": "event", "flatUsd": 50, "appliesWhen": "event_flag"}
  ]
}
```

Estimate = min over applicable rules, unless a rule is marked `overrides` (event rates usually are). The running estimate the user sees is `(low, likely, high)`: low = cheapest applicable rule now, high = daily max or the event rate if an event flag is possible today. Show a range, not a number, whenever the rules disagree by more than 20%.

Sources of rate cards, in order of trust: operator website (fetch by hand, store the URL and date), rate-board photo OCR confirmed by a founder, ticket rate hints, user report. A card older than 90 days shows "rates may have changed".

### Where the numbers come from today \[I\]

For the Boston field test, photograph the rate board at every garage you use and type the card by hand; 20 garages is a day's work and beats any data vendor for accuracy. Do not build a scraper for rate boards; build the `PUT /garages/:id/rate-card` admin route and a `data/garages/*.json` folder with a loader, the same shape as zones.

## 6. Research: paying a garage ticket legitimately

**Bottom line \[I\]:** there are four payment shapes in Boston garages, and only one of them can be fully automated by you without a partner. Not legal advice.

### The four shapes

1. **Ticket + pay station / pay at exit (legacy PARCS: SKIDATA, Amano, TIBA, HUB, Parkonect, Flash gated).** The gate lifts when the ticket is inserted and the PARCS sees it as paid. Payment can happen at the station, at the exit lane, or through a mobile channel the PARCS vendor integrated. ParkMobile's brochure describes exactly this: pull a ticket, enter the zone, scan the ticket barcode in the app, insert the ticket at exit and the app charges and the gate lifts \[S\] ([ParkMobile](https://parkmobile.io/resource-center/brochures/mobile-pay-gated-parking)); TIBA and ParkMobile announced that integration for TIBA equipment in 2021 \[S\] ([ParkMobile/TIBA](https://parkmobile.io/newsroom/parkmobile-and-tiba-parking-systems-partner-to-provide-contactless-parking-payments-in-gated-garages/)). In ParkMobile's own-QR variant the app generates a QR the gate scanner reads on entry and exit, and the charge posts on exit \[S\] ([ParkMobile support](https://support.parkmobile.io/hc/en-us/articles/203299160-How-do-I-use-Parkmobile-in-Gated-Garage-Facilities-)).
2. **Ticket + scan-to-pay web page.** The ticket or signage carries a QR to a vendor-hosted page; the user enters the ticket number or plate and pays by card; the PARCS marks the ticket paid and the exit reads it. HUB's J4Pay describes this flow (scan QR from signage or ticket, enter ticket number/plate/phone, pay by card, PayPal, Google Pay or card on file, exit) \[S\] ([HUB](https://www.hubparking.com/j4pay-smooth-payments-with-just-one-tap/)). Flash's Scan to Pay is powered by ParkWhiz, collects payment up front for a chosen duration, keys on the plate, and offers an "Extend End Time" link \[S\] ([Flash](https://help.flashos.com/support/solutions/articles/60001131935-scan-to-pay-stp-), [ParkWhiz](https://help.parkwhiz.com/support/solutions/articles/60001010608-scan-to-pay-how-to-use)). Text-to-Pay is the same with an SMS link \[S\] ([Flash blog](https://www.flashparking.com/blog/six-benefits-of-digital-payments-for-parking-operations/)).
3. **Ticketless LPR, account-based (Metropolis, incl. SP+ sites).** The user registers a plate once; cameras read it; the charge posts on exit to the member's payment method \[S\] ([Metropolis](https://app.metropolis.io/), [Metropolis pricing](https://www.metropolis.io/pricing)). Non-members get a notice to pay online \[S\] ([Metropolis Payments](https://payments.metropolis.io/)). Their terms name only Metropolis and the user as parties and disclaim any third-party beneficiaries \[S\] ([Metropolis terms](https://www.metropolis.io/terms)). No public developer API was found this session \[S\] ([API Evangelist stub](https://github.com/api-evangelist/metropolis-technologies)).
4. **Reservation marketplaces (SpotHero, ParkWhiz).** Pre-paid pass, scanned or LPR at the gate. Your adapters already hand off to their checkout and have no partner key \[R\]. SpotHero's acquisition by Uber was reported in Feb 2026 \[S\] ([Wikipedia, citing CNBC](https://en.wikipedia.org/wiki/SpotHero)); assume their partner program is in flux.

### What happens at the exit after a mobile payment \[S\]\[I\]

- Paper-ticket PARCS: the ticket is the token; the reader looks it up and opens if paid. Grace periods after payment are typically 10–20 minutes and are the operator's setting, not a standard; the ParkMobile/TIBA and HUB flows both end with "insert or scan the ticket at exit". If the grace period lapses, the reader asks for the difference.
- App-QR PARCS: the phone shows a QR; the reader validates it against the vendor's session. Requires the vendor's app or the vendor's integration; a third party cannot mint that QR.
- LPR: nothing to do at exit; the account is charged. A third party has no exit action to automate.
- Scan-to-pay pages: whether the gate honours the web payment depends on whether the page is the PARCS vendor's own (HUB, TIBA, Parkonect: yes) or a marketplace overlay keyed on plate (Flash/ParkWhiz STP: plate is the proof, so a wrong plate means a stuck gate).

### Paths ranked (Boston, next 6 months)

| # | Path | Automatable now | Needs | Risk |
| --- | --- | --- | --- | --- |
| 1 | Read ticket, identify garage, estimate, remind, hand off to the ticket's own pay URL in an in-app browser; user taps pay; your Issuing card fills via Apple Pay or autofill | Yes, assisted | nothing | Low: no automation of the checkout; card is yours with caps |
| 2 | Same, but the executor drives the vendor pay page (no login) with the user's explicit per-stay consent and your Issuing card | Technically yes | counsel review of each vendor's page terms; PCI SAQ-A-EP scope if the card number ever transits your server | Medium: no gate, so CFAA exposure is low post-*Van Buren*; ToS and card-network rules on automated card entry are the exposure; the operator can block you |
| 3 | ParkMobile/ParkBoston gated payment with the user's own linked ParkBoston session (only at garages ParkMobile has integrated) | Partly: the app flow is scan + exit; the executor could drive the web app if the garage appears there | confirm whether Passport's ParkBoston web app exposes gated garages at all (ParkBoston is Passport-run in your repo \[R\]; the ParkMobile brochure is ParkMobile-run) | Same posture as your street meters; likely zero Boston coverage until verified |
| 4 | Operator account link (user signs in to a Metropolis / LAZ / SP+ account in-app, like ParkBoston) | Only with a partner | partnership; the user's plate is the token, not a ticket | High without a partner: account terms, ToS, and an LPR system you cannot observe |
| 5 | PARCS vendor partner API (TIBA SPARK, Flash platform, HUB J4M/J4Pay validations) | No | commercial agreement, cert, likely a per-facility enable | The real product; 3–9 months |

### Risk matrix per path (not legal advice)

| Risk | Path 1 assisted | Path 2 driven checkout | Path 3 own linked account | Path 4/5 partner |
| --- | --- | --- | --- | --- |
| CFAA after *Van Buren* / *hiQ* | none: user acts | low: public page, no gate; the Ninth Circuit reads the CFAA as gates-up-or-down \[S\] ([hiQ 2022](https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf)) | low–medium: authorized user, but automated use of a login area is where *Nosal II*-type arguments live \[S\] ([Fenwick](https://www.fenwick.com/insights/publications/hiq-labs-scrapes-by-again-the-ninth-circuit-reaffirms-that-data-scraping-does-not-violate-the-cfaa-1)) | none |
| Terms of service / contract | none | medium: vendor pages usually ban automation; breach-of-contract is what sank hiQ despite winning on the CFAA \[S\] ([apiserpent summary](https://apiserpent.com/blog/is-scraping-linkedin-legal-2026)) | medium: same as your street executor today | contract governs |
| User account / fraud | none | medium: a card-not-present charge from a server IP on a consumer checkout can trip the operator's fraud rules; a declined or reversed payment means a stuck gate | low | low |
| PCI scope | SAQ-A (Apple Pay / hosted) | SAQ-A-EP or worse if the executor types a PAN; keep the PAN in Stripe (Issuing card details via ephemeral key on device, never on your server) | none for the card (provider holds it) | depends |
| Operator blocking / IP bans | none | medium; must stop on 401/403/429 like your adapters \[R\] | low | none |
| Lawyer needed before | no | yes, before any car but the founders' | before scaling beyond friends (already noted in #37 \[R\]) | yes, to negotiate |

What a PARCS or operator partner will want to see: liability for gate faults and stuck vehicles; a settlement model (who is merchant of record); PCI attestation; your caps and audit ledger (the `decisions` table is a real asset here); a support path for the driver at the exit; and evidence of demand (detection precision from the field test). Lead with the ledger and the caps; it is what differentiates an agent from a scraper.

Not proposed, on purpose: CAPTCHA solving, bot-detection evasion, minting a vendor's QR, or anything that defeats an operator's access controls.

## 7. Research: unknown-final-amount guardrails

**Bottom line \[S\]\[I\]:** the card networks already have a vocabulary for "we don't know the total yet" (authorization hold, partial authorization, incremental authorization, extended authorization), and Stripe Issuing exposes it to you as the issuer. Your webhook already answers `issuing_authorization.request` in real time with the decision persisted first \[R\]. What is missing is a *stay-level* budget object that the per-authorization decision reads.

### What the rails do

- Stripe Issuing sends `issuing_authorization.request`; if you approve, the amount is deducted from the Issuing balance and held until captured, voided or expired, and the `amount` is not final until capture \[S\] ([Stripe Issuing authorizations](https://docs.stripe.com/issuing/purchases/authorizations)).
- Some merchant categories request an unknown-amount authorization (fuel is the canonical case; the network default hold is $100); when the merchant sets `is_amount_controllable`, the issuer can approve a *lower* amount, otherwise it must approve the default or decline \[S\] ([Stripe](https://docs.stripe.com/issuing/purchases/authorizations)). Parking garages (MCC 7523) behave like this at some exit lanes: a pre-auth of a fixed amount, then capture of the real fee. *Inference:* expect $1–$50 pre-auths and later captures; write tests for both.
- Incremental authorizations arrive as another `.request` event on the same `Authorization`; declining the increment leaves the original approved \[S\] ([Stripe](https://docs.stripe.com/issuing/authorizations)). This is your lever when a stay runs past its budget.
- On the acquiring side (your own funding hold on the user's card), Stripe supports incremental authorization on a manual-capture PaymentIntent \[S\] ([Stripe](https://docs.stripe.com/payments/incremental-authorization)) and extended authorization windows, which networks reserve for cases where the final amount is unknown at authorization \[S\] ([Stripe](https://docs.stripe.com/payments/extended-authorization)). Card-not-present holds generally last 7 days on most networks and about 4 days 18 hours on Visa for merchant-initiated \[S\] ([Acodei summary of Stripe docs](https://www.acodei.com/glossary/stripe-authorization-hold)).
- Ramp and Brex \[K, not sourced this session\]: both put the policy in the card (per-card and per-merchant limits, category restrictions, receipt-matching rules, manager approval above a threshold) and treat the authorization as the enforcement point; over-limit spend is declined at the terminal, and every decision is an audit event with the rule that fired. That is the same shape as your `decisions` table.

### What it means for your caps

1. Keep the per-authorization cap (`session_cap_usd`) as the hard ceiling on the Issuing card \[R\].
2. Add a **stay budget**: `budgetUsd = min(session_cap_usd, ceil(estimate.high × 1.25 + rateCard.lostTicketUsd) )` set at ticket capture, stored on `garage_stays`, and consulted by the webhook when the merchant MCC is `parking_lots_garages` and the merchant name or location matches the stay. An authorization above the budget is declined with `decision: stay_budget_exceeded`, and the user is pushed "The garage asked for $X; your limit for this stay is $Y. Raise it?"
3. Daily cap keeps binding everything, including garages approved in Link \[R\].
4. A pre-auth that is later captured for less releases budget; a capture above the pre-auth (overcapture) is possible on some networks, so the budget check must run on `issuing_transaction.created` too and raise an alert, not a decline, since the money has moved.

## 8. Research: the street side

**Bottom line \[R\]\[I\]:** your `zoneLookup` already encodes the right policy (nearest wins when all candidates in radius agree on terms; otherwise surface the nearest and the closest disagreeing one and ask). PR #42 found 94% of opposite-side pairs overlap under GPS error, so side-of-street from GPS alone is a coin flip, and the *agreement* test is what makes it mostly moot. What is missing is a side prior and a correction loop.

### Side prior from the approach \[I\]

In US cities you park on the side you were driving on. Keep the last 5 burst fixes with speed > 2 m/s before the stop; their heading, projected onto the block's centerline direction, says which curb (right-hand traffic: the right curb relative to the heading). Use it only to *order* candidates, never to skip the prompt when terms disagree. Expected effect: correct side on the first try in roughly 80–90% of one-way and two-way blocks; that is a guess to measure in the field, not a sourced number.

### When to ask

- Candidates disagree on terms (existing rule). Show the prior's side first.
- Fix accuracy > 40 m and two blocks of different streets are within radius: ask "Boylston St or Newbury St?" before side.
- The user has corrected this exact zone pair before: show their last answer first, with the other as one tap.

### Learning from corrections

Write each confirmation or correction as a `decisions` row (`kind: side_choice`) with: fix, accuracy, heading prior, offered order, chosen zone. Per zone pair, keep a running count. After 3 corrections that agree, and no disagreement, the pair gets a `preferred_side` used to pre-select. This is the same verified-by-agreement pattern you use for zone numbers \[R\]. Never let a learned preference skip a *terms-disagree* prompt; it only reorders.

Do not build a per-user ML model here. The data volume from two founders in Boston will not support it, and the rule above captures most of the value.

## 9. Deliverable: the unified park-now state machine

The detector's existing states stay exactly as they are \[R\]; classification is a new stage after `park_fired`/`park_unlocated`, and the garage chain is a new server-side session type beside street sessions.

&#91;embedded content: park-now state machine · 4 outcomes, garage chain of 4 states\]

A stop that never confirms returns to idle; a confirmed park is classified once, and only the garage and paid-lot outcomes enter the ticket chain.

### Transitions in detail

| From | Event | Guard | To | Side effects |
| --- | --- | --- | --- | --- |
| Idle | motion leaves automotive, or car audio drops after a drive \[R\] |  | Stop pending | burst starts; `CMAltimeter` relative updates start; `entryFix` = last fix with acc ≤ 30 m and speed > 1 m/s |
| Stop pending | driving resumes |  | Idle | stop cleared (existing) |
| Stop pending | 2 of 3 kinds + a confirmer + located fix \[R\] | debounce | Classify | `park_fired`; altimeter stops |
| Stop pending | park-like but no fix (GPS gone) \[R\] | `fixesSeen > 0` or `entryFix` set | Classify | `park_unlocated` carries `entryFix`, `gpsLossAt`, `baroDeltaM` |
| Classify | saved place within 60 m |  | that place's class, conf 0.95 | no prompt except `garage` |
| Classify | footprint match / zone lookup / rules of section 2 | margin ≥ 0.3 | top class | `/parked` gets `placeHint` |
| Classify | margin < 0.3 |  | Ask | passive notification with four choices |
| street | `/parked` answers pay / confirm / ignore \[R\] |  | existing flow | unchanged |
| nopay |  |  | done | Activity row `kind: park_nopay`, no notification |
| garage or paid lot | user taps Scan ticket |  | Ticket captured | scanner opens with `parkedEventId`; `POST /garage-stays` with entry = min(ticket time, `stopAt`) |
| garage | user taps No ticket |  | Stay open (plate) | LPR garage: estimate only, pay handled by the operator's account |
| Ticket captured | validation passes (section 4) |  | Stay open | rate card resolved; Live Activity started; stay budget set |
| Stay open | motion automotive near the garage, or user taps Leaving |  | Leaving | estimate frozen as `expectedUsd`; handoff or partner payment |
| Leaving | Issuing capture / partner receipt / user says paid at station |  | Receipt | Activity row; Live Activity ends; place memory +1 |
| Leaving | 20 min with no payment event |  | Stay open | one reminder, then quiet |
| Any garage state | user taps Not here / Not a garage |  | done | `decisions` row; suppress prompts at that spot for 2 h |

### Offline behavior

The detector already persists the pending stop and re-arms on relaunch \[R\]. Add: (1) the classifier runs on device with the footprint index, so the prompt never waits for `/parked`; (2) `park_unlocated` parks queue with `entryFix` and are posted when reachable, with `ts` = `stopAt` (inside the server's 24 h clamp \[R\]); (3) ticket capture works offline and posts the stay when signal returns; the running estimate uses the cached rate card; (4) the Leaving handoff needs signal by definition, so the prompt says so.

### Confidence bookkeeping

`placeClassification` is one JSON on the parked event: `{class, confidence, runnerUp, inputs: {memoryHit, footprintId, gpsLoss, baroDeltaM, crawl, entryFix}}`. It goes into the `decisions` row and is what the field test scores.

## 10. Deliverable: ticket-capture design

### Capture UI

1. Entry from the garage notification action, the Parked sheet, or Activity ("Add ticket"). The screen shows the garage name it thinks you're in with a one-tap "Not this garage".
2. Live scanner (`DataScannerViewController`, barcode-only) with a narrow guide box shaped like a ticket. The first stable barcode read (same payload on 3 consecutive frames) locks and haptics.
3. Still capture automatically after the lock, or on "Take photo" if no barcode after 5 s.
4. Review card: name, entry time, ticket number (from the barcode, greyed as read-only), pay link host if any. Each field has "Edit". The entry time shows a hint "ParkAgent noticed you stop at 2:41 PM".
5. Confirm → stay opens, Live Activity starts. The ticket image is kept on device only (Documents, file-protected), never uploaded unless the user taps "Send to ParkAgent to improve reading"; the server gets fields.

### Extraction pipeline (on device unless noted)

`ScanSession` → `BarcodeLock` → `StillCapture` → `DocumentCrop` (VNDetectDocumentSegmentationRequest) → `OCR` (two VNRecognizeTextRequest passes) → `TicketParser` (rules, pure Swift, unit-tested on text fixtures) → `TicketValidator` (section 4 rules, needs `stopAt` and nearby garages) → optional `VLMFallback` (server, strict schema, only when parser confidence < 0.6) → `ReviewCard`.

The parser and validator are pure functions over `OCRLines` (text + normalized bounding box + confidence), so the 20-ticket set below is a fixture suite of synthetic OCR line sets, exercised in CI without a camera, and real photos are added as they're collected.

### Schema

```json
{
  "ticketId": "tk_…",
  "parkedEventId": "pe_…",
  "garageId": "bos-seaport-hotel | null",
  "garageNameRead": "SEAPORT HOTEL GARAGE",
  "barcode": {"symbology": "code128", "payload": "0012345678", "source": "scanner|vision_still|manual"},
  "entryAt": "2026-09-26T14:41:00-04:00",
  "entryAtSource": "ocr|manual|stopAt",
  "payUrl": "https://…", "payUrlHost": "…", "payUrlAllowlisted": true,
  "rateHints": [{"text": "$4/hr", "perHourUsd": 4}],
  "ocr": {"meanConfidence": 0.82, "lines": 14, "parserConfidence": 0.74, "vlmUsed": false},
  "validation": {"entryTimePlausible": true, "garageResolved": true, "barcodePresent": true},
  "imageKeptOnDevice": true
}
```

### Validation

A ticket is `usable` only when `barcodePresent || manualConfirmedTwice`, `entryTimePlausible`, and `garageResolved`. Anything else is `draft`, still shown in Activity, never used for a payment.

### Test set (20+ ticket types, described; collect real photos to match)

| # | Type | Layout traits | Expected fields | Trap |
| --- | --- | --- | --- | --- |
| 1 | Amano magstripe stub, ITF barcode | narrow 54 mm thermal, name top, `ENTRY 09/26/26 14:41`, barcode bottom | name, entryAt, ITF payload | ITF vs Code 128 confusion |
| 2 | SKIDATA ticket, PDF417 | wider card, small caps text, PDF417 top | PDF417 payload, name | OCR reads PDF417 noise as text |
| 3 | TIBA ticket with scan-to-pay QR | `SCAN TO PAY` + QR + ticket number printed twice | QR URL (allowlisted), ticket number, entryAt | QR payload is a URL with the id inside |
| 4 | HUB J4Pay ticket | QR + `Ticket #` + `Plate` field blank | QR URL, ticket number | two barcodes: pick QR for pay, Code 128 for id |
| 5 | Flash gated ticket | Flash logo, Code 128, `Lost ticket pays daily max $45` | Code 128, lostTicket hint | rate hint is a lost-ticket rule, not a rate |
| 6 | Parkonect ticket | QR to `parkonect` host, entry time as `IN: 2:41 PM 9/26` | QR, entryAt with AM/PM parse | 12-hour clock without year |
| 7 | Older Code 39 ticket, faded | thermal fade on the right third | Code 39 payload; entryAt null → manual | must not invent a time |
| 8 | Crumpled Code 128 ticket | barcode bent, live scanner fails | Vision still-frame barcode or manual | fallback order |
| 9 | Glare over the barcode | specular highlight | retake prompt, torch off | no false lock |
| 10 | Ticket with date in `DD-SEP-26` | European-style month word | entryAt | month word parse |
| 11 | Ticket with entry time 8 h before `stopAt` | user found an old ticket | `entryTimePlausible=false`, ask | plausibility window |
| 12 | Ticket with future time (garage clock wrong) | +25 min vs `stopAt` | accept within +30 min, flag `clockSkewMin` | tolerance |
| 13 | Two-language ticket (EN/ES) | duplicated lines | dedupe by bounding box | double name |
| 14 | Event-rate ticket ("EVENT $50 FLAT") | large rate text | rateHints flat 50; estimate high = 50 | override rule |
| 15 | Early-bird stamp | `EARLY BIRD IN BY 9AM` | rateHint early\_bird | do not apply after 9 |
| 16 | Validation sticker on ticket | `VALIDATED 2 HRS` sticker | validationHint minutes=120 | estimate reduces |
| 17 | Hotel valet claim check | no barcode, big number | class `valet`; no pay flow | not a garage ticket |
| 18 | Surface-lot pay-and-display receipt | `EXPIRES 16:41`, plate printed | class `lot_paid`; already paid | no double payment |
| 19 | ParkMobile gated-garage sign photo | zone number, no ticket | `zoneNumber`, route to provider flow | not a ticket |
| 20 | Metropolis welcome sign | plate-based, no ticket | class `lpr`; estimate only | no pay flow |
| 21 | Ticket with printed pay URL but unknown host | `pay.example-parking.com` | payUrl stored, `payUrlAllowlisted=false` | never open automatically |
| 22 | Ticket number printed with a check digit differing from barcode | OCR `00123456-7` vs barcode `001234567` | barcode wins | OCR never overrides barcode |
| 23 | Photo of a NYC ticket while in Boston | garage 300 km away | `garageResolved=false`, ask | distance sanity |
| 24 | Blank thermal (printer out) | no text, no barcode | draft, manual entry | empty input |

CI asserts, per fixture: the expected `usable/draft` verdict, the exact barcode payload, the entry time within 1 minute, and which source each field came from.

## 11. Deliverable: garage payment plan

**Plan:** ship Path 1 (assisted) for every garage now; verify Path 3 (ParkBoston gated coverage) in one afternoon; open partner conversations for Path 5 with the ledger and field data; do not build Path 2 (driven checkout) until counsel has read the specific vendor pages, and then only for the founders' cars.

### Ranked by feasibility × risk (Boston)

1. **Assisted handoff, all vendors** — build now. The app opens the ticket's pay URL (allowlisted host) in `SFSafariViewController`, prefilling nothing; the user pays with Apple Pay or their ParkAgent Issuing card via autofill. The stay budget caps the card. Receipt: the Issuing transaction webhook, or "I paid at the station" with the amount typed. Coverage: any ticket with a QR/URL (HUB, TIBA, Parkonect, Flash STP) and any pay station.
2. **ParkBoston gated garages** — verify. Your ParkBoston link is Passport's web app \[R\]; ParkMobile's gated-garage product is a different company's app. Field task: check whether any Boston garage shows a Passport zone for gated payment. If none, this path has zero coverage and is closed; if some, the executor path is the same shape as street meters and inherits their legal posture.
3. **LPR garages (Metropolis / SP+)** — estimate only. Detect, identify, show the estimate and the fact that the plate account will be charged; no payment action. Offer "Open Metropolis" as a deep link. A partnership would let you register the plate and read the session; without it, nothing to automate.
4. **PARCS vendor API** — pursue. Targets in order: TIBA (SPARK platform advertises integration partners \[S\] ([NPA 2026 coverage](https://kioskindustry.org/npa-2026-parking-infrastructure-evolves-to-tech-hubs-10-takeaways/))), Flash (platform partners connect directly \[S\] ([Flash](https://www.flashparking.com/blog/six-benefits-of-digital-payments-for-parking-operations/))), HUB (J4Pay/J4M validations \[S\]). Ask for: ticket lookup by barcode, fee quote, pay, and exit-token status; a sandbox facility; settlement as the vendor's merchant of record.
5. **Driven checkout (executor on vendor pay page)** — hold. Lowest CFAA exposure of the automated paths (public page, no gate), highest contract and fraud exposure; PCI scope expands if a PAN transits your server. Only after counsel, and only with the Issuing card revealed on device (ephemeral key) rather than on the server.

### What we can build now with user consent

- Everything in the state machine through Leaving.
- The handoff with amount confirmation: "Pay $24 to Seaport Hotel Garage? Opens their pay page; your ParkAgent card is capped at $32 for this stay."
- The Issuing webhook's stay-budget check, wrong-MCC decline, and a receipt that names the garage.
- Activity rows for garage stays, including "paid at station" and "unpaid, left".

### What needs a partner

Anything that lifts a gate without the user touching the ticket or the vendor page; any plate-based session; validations.

### Partner pitch (one paragraph, for TIBA/Flash/HUB or a Boston operator)

ParkAgent detects a parked car within about a minute, knows which facility it is in, and can read the ticket the moment it is taken. For you that is a paid, receipt-in-hand driver before they reach the exit lane, with zero new hardware. Every payment ParkAgent makes is decided server-side against per-stop and per-day caps and written to an audit ledger with its inputs; the card is a Stripe Issuing virtual card restricted to MCC 7523, so a mis-read can never buy anything but parking. We want a read-only ticket lookup and fee quote first, then a pay call, in one sandbox facility in Boston, with you as merchant of record. We bring field data on detection precision and time-to-detect from our Boston pilot, and a support path for the exit lane.

## 12. Deliverable: guardrails for unknown-price stays

**Design:** one `garage_stays` row owns a `budgetUsd`; the Issuing webhook consults it; every decision is a `decisions` row; the user can raise the budget from the push, never the server.

### Budget rule

```latex
\text{budget} = \min\big(\text{session\_cap},\ \lceil 1.25 \times \text{estimate}_{high} + \text{lostTicket} \rceil,\ \text{daily\_cap} - \text{spentToday} - \text{pending}\big)
```

`estimate_high` is the rate card's daily max, or the event rate when an event flag is possible today. A garage with no rate card gets `budget = min(session_cap, 40)` and a prompt that says so.

### Webhook decision order (extends the existing handler \[R\])

1. Unknown card → decline `unknown_card` (existing).
2. MCC not `parking_lots_garages` → decline `wrong_mcc` (existing; keep the fuel-style categories out).
3. Match an open stay: merchant name fuzzy-matches the garage or its operator, or the merchant city is the stay's city and the stay opened < 24 h ago. No match → decline `no_open_stay` (this is new and important: an Issuing card that can pay any garage any time is a liability).
4. `amount > budget` → if `is_amount_controllable`, approve `budget` and record `partial_approved`; else decline `stay_budget_exceeded` and push "Raise limit to $X?" (one tap re-sets the budget and asks the user to retry at the reader).
5. Incremental `.request` on the same authorization → same rule against the remaining budget.
6. Per-authorization and daily caps last, as today.

### Holds

When `payment_source = parkagent_card`, the funding hold on the user's own card is placed at ticket capture for `budget` (manual capture, existing `holds.ts` \[R\]); captured for the real amount on the Issuing transaction; released on `Not here`, on a `paid_at_station` receipt, or after 24 h. Extended authorization is not needed for a same-day stay; if multi-day stays appear, use Stripe's extended authorization on the funding hold, which networks allow when the final amount is unknown \[S\] ([Stripe](https://docs.stripe.com/payments/extended-authorization)).

### Approval thresholds

- Under `auto_pay_max_rate_per_hour × 2` and under budget: auto-approve, notify after.
- Between that and budget: approve, but the push says the amount.
- Over budget: the user decides; default deny.

### Audit trail

Every step writes `decisions` with `kind ∈ {stay_budget_set, stay_budget_raised, garage_auth, garage_capture, stay_closed}` and the full inputs, including the estimate at the time and the rate card version. `GET /wallet/activity` shows the garage row with estimate, budget, charged, and the merchant string the network sent.

## 13. Deliverable: field-test protocol

**Protocol:** two phones per drive (one founder driving, one passenger with the same build), the Diagnostics signal log on \[R\], a paper log of ground truth, 60 parks over 3 weeks across the five place types, then a replay of every trace through the engine and classifier in CI.

### Ground truth log (per park)

Time stopped (watch), place type (street / garage / lot / home / other), garage name and level, ticket taken (y/n), ticket photo, side of street, whether the prompt was right, what the user had to tap, battery % at start and end of the drive.

### Mix (minimum counts)

| Place type | Parks | Notes |
| --- | --- | --- |
| Street metered, one-way | 8 | Newbury, Boylston |
| Street metered, two-way | 8 | Congress, Seaport Blvd |
| Garage, above ground | 10 | Prudential, Seaport Hotel, Post Office Sq. entrance |
| Garage, underground | 8 | Boston Common, Government Center |
| Surface lot, paid | 6 | Central Wharf, Charlestown Navy Yard |
| Home / driveway / private | 10 | both founders' homes, a friend's driveway |
| Negatives | 10 | drive-through, long light on Storrow, passenger in a friend's car, Red Line ride |

### Metrics and targets (first pass; revise after week 1)

| Metric | Definition | Target |
| --- | --- | --- |
| Park recall | parks fired ÷ true parks, per place type | ≥ 0.95 street, ≥ 0.85 garage, ≥ 0.9 lot |
| Park precision | true parks ÷ parks fired | ≥ 0.95 overall; negatives fire ≤ 1 in 10 |
| Time to detect | `park_fired` − true stop | median ≤ 60 s street, ≤ 120 s garage |
| Classification accuracy | top class = truth | ≥ 0.9 with memory, ≥ 0.75 cold |
| Ask rate | prompts with four choices ÷ parks | ≤ 0.2 cold, ≤ 0.05 after 2 visits |
| Garage identity | `garageId` correct when class = garage | ≥ 0.9 |
| Side accuracy | prior's first choice correct, disagreeing blocks only | measure; hope ≥ 0.8 |
| Ticket read | barcode payload exact; entry time within 2 min; name matched | ≥ 0.95 barcode, ≥ 0.85 time, ≥ 0.8 name |
| Estimate error | estimate at Leaving vs receipt | within 20% on 80% of stays |
| Battery | % per hour of driving with the app armed, vs the same drive with the app off | ≤ 2 points/h difference |

### Replay

Every field trace goes into `ios/Fixtures/Traces/` (already the pattern \[R\]) with a sidecar `truth.json`. A CI test replays all traces and prints the table above; a regression in any target fails the `ios` job. The classifier's inputs come from the same trace format, extended with `altitude` and `entry_fix` lines.

## 14. Deliverable: implementation in six PRs

Order matters: PR 1 and 2 are pure data and pure functions with no UI; PR 3 gives the field test its classifier; PR 4–6 are the garage chain. Each prompt below is ready to paste into Claude Code from the repo root. Every prompt shares this preamble; it is repeated in full in PR 1 and referenced after.

**Shared preamble (paste at the top of every prompt):**

```markdown
Read CLAUDE.md first and follow it exactly: feat/* branch off main, small PR, squash merge, no direct pushes, city-neutral sources (names via CityCatalog / provider registry), every automated decision writes a decisions row, any money path checks DRY_RUN and policy.json, never touch a provider site outside executor/. Then read ios/ParkAgent/Detection/ (ParkDetector.swift, ParkFusionEngine.swift, DetectionCapabilities.swift), executor/README.md, server/API.md, and docs/functional-requirements.md. Do not start coding until you can state, in one paragraph, which existing invariants your change must preserve.

Working rules for this task:
- Write the failing tests first and show me they fail on main before you implement.
- Keep additions additive: new tables and columns only, no destructive migrations.
- Run `pnpm -r lint && pnpm -r test`, then `cd ios && xcodegen generate` and the ios unit tests, before proposing.
- Boot the API locally (`pnpm -C server dev` against a migrated PostGIS) and run the FR suite against it in dry run (`FR_API_BASE=http://localhost:3000` with the FR user's key); every FR must still pass. Add FR cases for the new behavior to docs/functional-requirements.md and server/fr/.
- Before saying "ready", do a skeptical self-review as a hostile reviewer: list three ways this change could pay the wrong thing, fire a wrong prompt, or leak data, and show the test or guard for each. If you can't, say so.
- CI must be green (server, executor, ios, boot, city-neutral). Do not say ready until it is.
- Ask before adding any dependency over ~50 KB or any native module, and before any new entitlement.
```

### PR 1 — garage and lot footprints (server + data)

`feat/garage-footprints`

```markdown
[shared preamble]

Goal: a `garages` table beside `zones`, loaded from OSM for Boston and NYC, queryable by point.

Behavior:
- data/fetch_parking_footprints.py: fetch OSM `amenity=parking` ways/relations for each city's bbox (Overpass, cached to data/raw/, polite User-Agent, retries), keep `name, operator, parking, fee, access, capacity, website`, and compute `entrances` from `entrance=*` member nodes or, failing that, the polygon vertex nearest a road centerline. Output data/out/<city>_garages.geojson. Skip `parking=street_side|lane` (those are our zones).
- server: Prisma model `Garage` (id = `<city>-<slug>-<hash6>`, city, name, operator, kind ∈ {multi_storey, underground, surface, rooftop, unknown}, fee (bool|null), access, capacity, website, geom polygon, entrances multipoint, source, sourceVersion, createdAt/updatedAt) + `pnpm -C server load:garages [--file]`, additive migration only.
- `GET /garages/near?lat&lng&radius` → up to 10 garages with `containsPoint`, `distanceM` (to polygon), `nearestEntranceM`; and `GET /garages/:id`. Auth as the other read routes.
- services/garageLookup.ts: pure function `classifyByFootprint(point, accuracyM, garages)` → `{kind, garageId, containsPoint, nearestEntranceM}` with the rule: containment wins; else nearest entrance within max(40, accuracyM).

Tests that must fail without the change: server/test/garageLookup.test.ts (containment beats proximity; entrance radius scales with accuracy; street_side never returned), server/test/garagesRoute.test.ts (near + by-id, 404 unknown), data/test_fetch_parking_footprints.py (kind mapping, entrance fallback, street_side exclusion) on a small fixture.

Do not touch the iOS target in this PR.
```

### PR 2 — place classifier and place memory (iOS, pure Swift)

`feat/place-classifier`

```markdown
[shared preamble]

Goal: a pure `PlaceClassifier` in ios/ParkAgent/Detection/ that turns the engine's park (or unlocated park) plus context into `PlaceClassification {class: street|garage|lot|nopay|unknown, confidence, runnerUp, inputs}`; plus an on-device `PlaceMemory` store.

Behavior:
- Extend ParkFusionEngine.State.Stop with `entryFix` (last fix with accuracy ≤ 30 m and speed > 1 m/s before the stop), `gpsLossAt` (first time accuracy > 65 m or fixes stop for 45 s while automotive), and `baroDeltaM` (net relative altitude over the stop window, fed by a new `AltimeterSource` protocol; CoreMotion impl behind `CMAltimeter.isRelativeAltitudeAvailable()`, started at beginStop, stopped with the burst). Add raw signals `altitude` and `entry_fix` to RawDetectorSignal and to the SignalTrace replay parser so traces round-trip.
- `PlaceClassifier.classify(park: ParkOutcome, memory: PlaceMemory, footprints: FootprintIndex, zones: ZoneHint)` implements the scoring in section 2 of the design doc: memory hit ≥ footprint containment ≥ sensors; act if margin ≥ 0.3 else `.unknown`. FootprintIndex is a protocol; ship a JSON-backed R-tree-free linear scan over the city's garages fetched from GET /garages/near and cached per 2 km cell (keep it simple; a few hundred polygons).
- `PlaceMemory`: saved places (center, radius 60 m, class, name, visits, lastAt) in the app's Documents, updated only on user confirmation; two confirmations promote a place; a `Not my car` marks a 2 h suppression, not a place.
- Wire the classifier into ParkDetector after onPark/onUnlocatedPark; send `placeHint` in the /parked body (server ignores unknown fields today; PR 3 reads it). No UI change beyond a Diagnostics line showing the last classification.

Tests that must fail without the change: ParkFusionEngineTests: entryFix is the last moving good fix, not the settled one; gpsLossAt set on accuracy blow-up and on silence; baroDelta ignores a 0.6 hPa spike in 1 s. PlaceClassifierTests: memory beats footprint; containment beats proximity; unlocated park with entryFix inside a multi_storey polygon → garage ≥ 0.9; lot with fee=nil → lot 0.6 and runnerUp nopay; margin < 0.3 → unknown. Trace replay: add two recorded traces (one garage, one home) with truth sidecars and assert the class.

Battery: the altimeter must never run outside a stop window; add an assertion in DetectorSelfTest.
```

### PR 3 — `/parked` place outcomes and the confirm prompt (server + iOS)

`feat/parked-place-outcomes`

```markdown
[shared preamble]

Goal: /parked understands `placeHint` and answers new actions; the app prompts per the ladder in section 3.

Behavior:
- server: /parked accepts `placeHint {class, confidence, garageId?, entryFix?}`; runs its own footprint classification from garageLookup when the hint is absent or unknown; response gains `place {class, confidence, garageId, garageName, source}` and two new actions: `garage_ticket` (class garage or paid lot) and `nopay` (class nopay). Existing street actions unchanged. Rule names: `place_garage`, `place_lot_fee`, `place_nopay`, `place_unknown`. Every /parked decision row includes the classification inputs.
- `POST /parked/:id/place` lets the user correct the class (street/garage/lot/nopay) and optionally name it; writes decisions `place_confirmation`; the app updates PlaceMemory only on this call's success.
- iOS: ParkedNotice gains the garage/lot/unknown variants with the copy from section 3 and UNNotificationCategory actions (Scan ticket, Not here, Not a garage, No payment). `nopay` stays silent and writes an Activity row. Never prompt while motion was automotive in the last 60 s; never twice for the same place in a day.

Tests that must fail without the change: server/test/parkedPlace.test.ts (hint garage → garage_ticket with garage name; nopay silent; unknown → place_unknown and no candidates lost; correction writes the decision and is idempotent per user); FR: add FR-41 (garage hint at a known garage → garage_ticket) and FR-42 (nopay → no quote, action nopay) to docs/functional-requirements.md and server/fr/. iOS ParkedNoticeTests for each variant and the no-double-prompt rule.
```

### PR 4 — ticket capture and parser (iOS)

`feat/ticket-capture`

```markdown
[shared preamble]

Goal: the scanner and the pure parser/validator from section 10, no payment.

Behavior:
- ios/ParkAgent/Tickets/: ScanSession (DataScannerViewController, barcode-only, symbologies code128, itf14/i2of5, qr, pdf417, code39, dataMatrix; lock after 3 identical frames; haptic), StillCapture (three frames, best by barcode then OCR confidence), DocumentCrop, OCR (two VNRecognizeTextRequest passes), TicketParser and TicketValidator as pure functions over [OCRLine], ReviewCard SwiftUI. Camera permission string added in project.yml only. Image stays on device under file protection.
- Parser rules exactly as section 4 (entry-time regexes and anchors, name fuzzy match ≥ 0.85 against /garages/near, pay URL host allowlist as a constant list in one file, rate hints). Barcode always wins for ticketNumber.
- Validator produces `usable|draft` per section 10.
- Fixtures: ios/Fixtures/Tickets/*.json holding synthetic OCRLine sets + expected output for all 24 cases in the design doc's test set; a test iterates them. Real photos get added later under the same names.
- No VLM call in this PR; leave a `TicketFallback` protocol with a no-op implementation.

Tests that must fail without the change: TicketParserTests (24 fixtures), TicketValidatorTests (plausibility window, distance sanity, barcode-overrides-OCR), ScanSession lock test with a fake frame source.
```

### PR 5 — garage stays, rate cards, estimate, Live Activity (server + iOS)

`feat/garage-stays`

```markdown
[shared preamble]

Goal: a stay object with a running estimate and a Live Activity; still no money moves.

Behavior:
- server: Prisma `GarageRateCard` (garageId, version, json, source, effectiveAt) and `GarageStay` (id, userId, parkedEventId, garageId, entryAt, entryAtSource, ticket fields from the schema in section 10 minus the image, status ∈ {open, leaving, paid, paid_at_station, unpaid_left, cancelled}, estimate {low, likely, high}, budgetUsd, chargedUsd, receipt json). Routes: POST /garage-stays, GET /garage-stays/:id, POST /garage-stays/:id/leaving, POST /garage-stays/:id/close {outcome, amountUsd?}. Admin PUT /garages/:id/rate-card and `pnpm -C server load:rate-cards` from data/garages/*.json. services/garageEstimate.ts: pure evaluator for tiered, early_bird, evening, event, daily max, lost ticket, validation minutes; returns (low, likely, high).
- Every stay transition writes a decisions row. Wallet activity lists stays (kind garage_stay) with estimate/budget/charged; a plan row for the same garage gives way to the stay like street plans do today.
- iOS: ticket confirm → POST /garage-stays; ActivityKit Live Activity (name, entry time, estimate range, budget) updated at rule boundaries, ended on close; a Leaving button (App Intent) that opens the app's handoff screen (PR 6). Works offline: stay is queued and posted later; estimate uses the cached card.

Tests that must fail without the change: garageEstimate.test.ts (each rule kind, early-bird cutoff, event override, daily max cap, validation reduction, no card → null estimate); garageStays.test.ts (lifecycle, decisions rows, cap on open stays per user = 2, activity row shape, plan-gives-way); FR-43 (create a stay in dry run against a seeded garage and read it back).
```

### PR 6 — stay budget on the Issuing webhook and the assisted handoff

`feat/garage-stay-budget`

```markdown
[shared preamble]

Goal: the guardrails in section 12 and the assisted pay handoff. Money moves only with DRY_RUN=false, ISSUING_LIVE, and an open stay.

Behavior:
- Webhook: decision order from section 12 (unknown card → wrong MCC → no open stay → over budget with partial approval when is_amount_controllable → incremental against remaining → existing caps). New decline codes `no_open_stay`, `stay_budget_exceeded`, decision `partial_approved`. `issuing_transaction.created` closes the stay as paid with chargedUsd and pushes the receipt; an overcapture above budget alerts, never declines.
- Budget = min(session_cap, ceil(1.25 × estimate.high + lostTicket), daily headroom incl. Link pending); set at stay creation, raised only by POST /garage-stays/:id/budget from the push action (max 2 raises, each ≤ session_cap).
- Funding hold (parkagent_card only): place for budget at stay creation via holds.ts; capture on transaction; release on close/cancel/24 h.
- iOS handoff screen: shows the frozen estimate, the budget, and opens the ticket's allowlisted pay URL in SFSafariViewController with no prefill; "I paid at the station" closes with an amount; "Couldn't pay" leaves the stay open with one reminder. No executor involvement anywhere in this PR.

Tests that must fail without the change: issuingWebhook tests for each new branch using the existing test helpers (seedHold etc.) and stripe:trigger categories; budget math table test; raise-limit twice max; handoff never opens a non-allowlisted host (unit test on the URL gate); FR-44 (webhook decline `no_open_stay` in dry run with the test helper card).

Self-review must specifically answer: what happens when the garage pre-auths $1 then captures $60; when two garages match by name; when the user raises the limit after the reader already declined.
```

## 15. Open questions for the founders

- [ ] Is the ParkBoston web app (Passport) exposing any gated garages in Boston? One afternoon with the recorded Find Parking feed answers it and decides whether Path 3 exists.
- [ ] Which Boston garages will the field test use, and who photographs each rate board and entry equipment (vendor logo on the ticket dispenser)? That photo set is the vendor map for the partner outreach.
- [ ] Do you want the Issuing card to be usable at *any* parking merchant, or only during an open stay (`no_open_stay` decline)? The design says only during a stay; it is stricter than today's card controls.
- [ ] Has counsel looked at the executor at all yet (#37)? The garage work does not add executor exposure, but the partner pitch will get asked about it.
- [ ] Ticket images: on-device only by default, upload only on opt-in. Agree, or do you want a founder-only always-upload switch for the pilot to build the OCR set faster?
- [ ] Live Activity push updates need an APNs token per activity; are you willing to add that to PushManager in PR 5, or is local-only updating acceptable for the pilot?
- [ ] Which vendor do you approach first: TIBA (platform partners), Flash (platform partners), or a single Boston operator with several garages? Operators move faster; vendors scale.
- [ ] Repo visibility (#37) before any of this reaches friends: the garage code makes the executor's existence more visible, not less.
- [ ] Budget default when a garage has no rate card ($40 in the design): too high, too low?
- [ ] Will Stripe's Issuing live application cover MCC 7523 card-present at exit lanes, or only card-not-present? Ask Stripe; it changes whether the pay-station path is even possible with the ParkAgent card.

## Sources

Pages read this session. Repo facts came from the project's own files.

- [Apple Support: find your parked car's location](https://support.apple.com/en-au/101587)
- [Apple Developer Forums: how Parked Car is triggered](https://developer.apple.com/forums/thread/49288)
- [iGeeksBlog: parked car feature limits indoors](https://www.igeeksblog.com/?p=581824)
- [Bojja et al., indoor 3D navigation of vehicles in multi-storey garages](https://www.researchgate.net/publication/261203418_Indoor_3D_navigation_and_positioning_of_vehicles_in_multi-storey_parking_garages)
- [Sensors 2019: pressure-pair floor localization, 0.12 hPa/m and 2 hPa drift](https://doi.org/10.3390/s19163622)
- [Scientific Reports 2024: GPS entry + barometer floor tracking](https://www.nature.com/articles/s41598-024-64824-9)
- [HUB Parking J4Pay scan-to-pay](https://www.hubparking.com/j4pay-smooth-payments-with-just-one-tap/)
- [Flash: digital payments, Scan to Pay and Text-to-Pay](https://www.flashparking.com/blog/six-benefits-of-digital-payments-for-parking-operations/)
- [Flash/ParkWhiz Scan To Pay support](https://help.flashos.com/support/solutions/articles/60001131935-scan-to-pay-stp-)
- [ParkWhiz Scan to Pay: how to use](https://help.parkwhiz.com/support/solutions/articles/60001010608-scan-to-pay-how-to-use)
- [ParkMobile mobile pay in gated parking (brochure)](https://parkmobile.io/resource-center/brochures/mobile-pay-gated-parking)
- [ParkMobile support: gated/garage facilities](https://support.parkmobile.io/hc/en-us/articles/203299160-How-do-I-use-Parkmobile-in-Gated-Garage-Facilities-)
- [ParkMobile and TIBA partnership](https://parkmobile.io/newsroom/parkmobile-and-tiba-parking-systems-partner-to-provide-contactless-parking-payments-in-gated-garages/)
- [NPA 2026 takeaways: TIBA SPARK and integration partners](https://kioskindustry.org/npa-2026-parking-infrastructure-evolves-to-tech-hubs-10-takeaways/)
- [Metropolis app](https://app.metropolis.io/) · [Metropolis pricing](https://www.metropolis.io/pricing) · [Metropolis payments notice page](https://payments.metropolis.io/) · [Metropolis terms](https://www.metropolis.io/terms) · [API Evangelist stub for Metropolis](https://github.com/api-evangelist/metropolis-technologies)
- [Wikipedia: SpotHero (Uber acquisition, Feb 2026)](https://en.wikipedia.org/wiki/SpotHero)
- [Stripe: Issuing authorizations](https://docs.stripe.com/issuing/purchases/authorizations) · [Stripe: Issuing authorizations (incremental)](https://docs.stripe.com/issuing/authorizations)
- [Stripe: incremental authorization](https://docs.stripe.com/payments/incremental-authorization) · [Stripe: extended authorization](https://docs.stripe.com/payments/extended-authorization) · [Acodei: Stripe authorization holds](https://www.acodei.com/glossary/stripe-authorization-hold)
- [hiQ Labs v. LinkedIn, Ninth Circuit 2022 opinion](https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf) · [Fenwick summary](https://www.fenwick.com/insights/publications/hiq-labs-scrapes-by-again-the-ninth-circuit-reaffirms-that-data-scraping-does-not-violate-the-cfaa-1) · [apiserpent: hiQ settlement and contract outcome](https://apiserpent.com/blog/is-scraping-linkedin-legal-2026)

Not sourced this session, stated from training knowledge and marked \[K\] in the text: Google Maps parking detection, Ramp/Brex card-policy mechanics, Apple VisionKit/Vision/ActivityKit API details, OSM tag conventions.
