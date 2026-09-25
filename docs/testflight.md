# TestFlight

How a build of the iOS app gets from this repo to testers' phones. The
pipeline is manual: someone runs the `testflight` workflow
(`.github/workflows/testflight.yml`) and it archives the app, signs it for
App Store Connect, uploads it, and sets the build's What to Test.

- [Secrets and variables](#secrets-and-variables)
- [One-time setup](#one-time-setup)
- [Running it](#running-it)
- [If it fails](#if-it-fails)
- [Tester notes (What to Test)](#tester-notes-what-to-test)
- [Beta App Review notes](#beta-app-review-notes)

## What the workflow does

Job `upload` (macOS, 15 to 25 minutes):

1. Checks that the secrets and variables below are set and well-formed, and
   stops with a named error if one is missing.
2. Writes `ios/Config.xcconfig` (team, API URL, Stripe publishable key) and
   runs `xcodegen generate`.
3. Archives the Release configuration for `generic/platform=iOS` with the
   build number set to the run number (or the `build_number` input).
4. Checks the archived app: bundle id, that the build number took, the
   `processing` background mode without task ids (ITMS-90771), and whether
   `ITSAppUsesNonExemptEncryption` is present.
5. Runs `ios/Tools/check-release-binary.sh` on the archived `.app`, which
   fails on development or debug strings in the Release binary.
6. Exports with `ios/ExportOptions.plist` (method `app-store-connect`,
   destination `upload`), which signs with the team's cloud-managed
   distribution certificate and uploads to App Store Connect in the same
   step.
7. Saves the archive's dSYMs, the archive and export logs, and Xcode's
   distribution logs as the run artifact `testflight-<version>-<build>`.
8. Revokes the Apple Development certificate the archive step created (see
   "Signing" below).
9. Writes a summary with version, build, commit, API, and Xcode version.

Job `what-to-test` (Linux): waits for App Store Connect to finish
processing the build (usually 5 to 30 minutes), then sets What to Test from
the `what_to_test` input, or from the tester notes further down this page
when the input is empty. If processing takes longer than an hour it gives up
with a warning, and you paste the notes by hand.

### Signing

No certificates or provisioning profiles are stored anywhere. xcodebuild
signs through the App Store Connect API key (`-allowProvisioningUpdates`
with `-authenticationKeyPath`, `-authenticationKeyID`,
`-authenticationKeyIssuerID`):

- **Archive** signs with a development identity. A hosted runner starts
  with an empty keychain, so Xcode creates a new "Apple Development: Created
  via API" certificate on every run. Apple limits how many a team can hold,
  so the workflow's last step revokes that certificate again. It revokes only
  a certificate that is new in the runner's keychain and matches a
  development certificate in the account byte for byte, so nobody's own
  certificate is ever touched.
- **Export** signs with the cloud-managed Apple Distribution certificate,
  which Apple keeps and reuses. It needs no cleanup.
- **Push**: `ios/project.yml` declares `aps-environment: development`. The
  App Store export re-signs with a distribution profile, and Xcode sets
  `aps-environment` to `production` in the uploaded binary. The run log
  prints the value when Xcode reports it. The app reads its environment
  from its signing, not its build configuration (`APNsEnvironment.swift`).
  TestFlight and App Store builds carry no embedded profile and register as
  `production`. Anything installed from Xcode, Release included, registers
  as `development`. The server sends each token to its own host.

## Secrets and variables

Set these under the repository's Settings → Secrets and variables → Actions,
or with `gh` as shown.

| Name | Kind | Required | What it is | Where to get it |
|---|---|---|---|---|
| `APP_STORE_CONNECT_API_KEY_BASE64` | secret | yes | The App Store Connect API key file (`AuthKey_XXXXXXXXXX.p8`), base64-encoded. xcodebuild signs and uploads with it; the helper script uses it to revoke the run's development certificate and to set What to Test. | App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → Generate API Key, with Access **Admin** (see below). Apple lets you download the file once. |
| `APP_STORE_CONNECT_KEY_ID` | secret | yes | The key's Key ID, 10 characters. | The Key ID column next to the key. |
| `APP_STORE_CONNECT_ISSUER_ID` | secret | yes | The team's Issuer ID, a UUID. | Shown above the Team Keys table. |
| `APPLE_TEAM_ID` | variable | yes | The 10-character Apple Developer Team ID. It becomes `DEVELOPMENT_TEAM` and the export's `teamID`. Also accepted as a secret. | developer.apple.com/account → Membership details → Team ID. It is the same value as `DEVELOPMENT_TEAM` in your own `ios/Config.xcconfig`. |
| `STRIPE_PUBLISHABLE_KEY` | variable | no | The Stripe publishable key the Wallet uses to save a card. Empty is fine for a dry-run beta: the app works, and only saving a card for the ParkAgent card is unavailable. The workflow refuses anything that is not `pk_live_…` or `pk_test_…`. Also accepted as a secret. | Stripe Dashboard → Developers → API keys. Use the same mode (test or live) as the server's Stripe secret key. |

```sh
base64 -i AuthKey_ABCDE12345.p8 | gh secret set APP_STORE_CONNECT_API_KEY_BASE64
gh secret set APP_STORE_CONNECT_KEY_ID --body ABCDE12345
gh secret set APP_STORE_CONNECT_ISSUER_ID --body 00000000-0000-0000-0000-000000000000
gh variable set APPLE_TEAM_ID --body XXXXXXXXXX
gh variable set STRIPE_PUBLISHABLE_KEY --body pk_test_...   # optional
```

After setting the key secret, delete the downloaded `.p8` or move it to the
password vault. Never commit it.

**Why the key needs the Admin role.** xcodebuild's cloud-managed
distribution signing refuses any API key below Admin. An App Manager or
Developer key can upload a build, but the export fails with "Cloud signing
permission error". The key also creates the development certificate and
profiles the archive step needs, and revokes the certificate afterwards. It
must be a **Team** key; an Individual key does not work with xcodebuild.
An Admin key can do a lot, so it lives only in GitHub secrets. If it leaks,
revoke it on the same page and generate a new one.

Workflow inputs, all optional:

| Input | Default | What it does |
|---|---|---|
| `api_base_url` | `https://parkagent-api.fly.dev` | The API the build talks to. Must be https. |
| `build_number` | the workflow's run number | `CFBundleVersion`. Set it when a number is already taken. |
| `what_to_test` | the tester notes below | Text for TestFlight's What to Test. The web form takes one line; use `gh` for more. |

## One-time setup

Done by hand, once, by the account holder or an admin.

### 1. App ID capabilities

developer.apple.com → Certificates, Identifiers & Profiles → Identifiers →
`com.thomasbardhi.parkagent`. The App ID already exists if the app has been
run on a phone from Xcode; otherwise create it with + → App IDs → App, with
an explicit bundle ID.

Every entitlement in `ios/project.yml` has to be enabled here, or signing
fails with "Provisioning profile doesn't include the … entitlement":

- **Sign In with Apple**: enable it and choose "Enable as a primary App ID".
- **Push Notifications**: enable it. No push certificate is needed; the
  server sends with a token-based APNs key (`APNS_KEY`). That key must be
  allowed to send to **Production** (a key created as sandbox-only cannot
  reach TestFlight builds). Check it under Keys.
- **Apple Pay Payment Processing**: first create the merchant ID under
  Identifiers → + → Merchant IDs → `merchant.com.thomasbardhi.parkagent`,
  then enable the capability on the App ID and select that merchant ID. The
  Stripe payment processing certificate for the merchant ID is described in
  `server/API.md` under "Apple Pay setup".
- **Time Sensitive Notifications**: enable it.

The one background mode (location) needs nothing on the App ID. Save. Existing profiles become invalid; the next run regenerates them.

### 2. A registered device

The archive step signs with a development profile, and Apple will not issue
one to a team with no registered devices. Your phone is registered if you
have ever run the app on it from Xcode.

### 3. The App Store Connect app record

appstoreconnect.apple.com → Apps → + → New App:

- Platform: iOS
- Name: ParkAgent. Store names are unique across the whole store; if it is
  taken, pick a variant. The name on the home screen still comes from
  `CFBundleDisplayName`.
- Primary language: English (U.S.)
- Bundle ID: `com.thomasbardhi.parkagent` (listed once the App ID exists)
- SKU: `parkagent-ios`
- User access: Full Access

### 4. The API key

App Store Connect → Users and Access → Integrations → App Store Connect API.
The first time, the account holder has to request access and accept the
terms. Then Team Keys → + → name it "GitHub TestFlight", Access **Admin** →
Generate. Download the `.p8` (only possible once), note the Key ID and the
Issuer ID, and set the secrets above.

### 5. Internal testers

Internal testers must be App Store Connect users on the team, up to 100, and
their builds need no review.

1. Users and Access → + → name, email, a role such as Developer or
   Marketing, and access to ParkAgent. They accept the email invitation.
2. Apps → ParkAgent → TestFlight → Internal Testing → + → create a group
   (for example "Team"), turn on **Automatic Distribution**, and add the
   testers.
3. Each tester installs TestFlight from the App Store and accepts the
   invitation on their iPhone.

External testers (anyone with an email address or a public link) need Beta
App Review for the first build of each version. Under TestFlight → Test
Information fill in the beta app description, feedback email, and contact
details, paste the [Beta App Review notes](#beta-app-review-notes), and
leave "Sign-in required" unchecked: reviewers sign in with their own Apple
ID.

### 6. App Privacy

App Store Connect → Apps → ParkAgent → App Privacy asks what the app
collects; the answers must match `ios/ParkAgent/PrivacyInfo.xcprivacy`.
Data is **not used for tracking**, and every type is **linked to the
user** and used for **App Functionality** only:

- Location → Precise Location (where you parked, to find the meter zone;
  where you are while a session runs, to decide whether to extend)
- Contact Info → Name, Email Address (from Sign in with Apple), Phone
  Number (optional, typed into the profile)
- Identifiers → User ID, Device ID (the sign-in session's device id)
- Purchases → Purchase History (parking sessions and garage bookings)
- Financial Info → Payment Info (a saved card's brand and last four; the
  number itself goes to Stripe)
- User Content → Other User Content (what you ask the assistant)
- Other Data → the car's license plate

The assistant's garage search sends the searched location, without the
user's name or account, to the garage services it queries (ParkWhiz,
SpotHero). Keep this list and the manifest in step when either changes.

### 7. Export compliance

`ios/project.yml` sets `ITSAppUsesNonExemptEncryption = NO`: the app uses
only the encryption built into iOS (HTTPS and the Keychain), which is
exempt. With that key in Info.plist, builds arrive ready to test and nobody
has to answer a question per build. If a build ever shows **Missing
Compliance**, the key did not make it into that build (the workflow warns
about this). Answer the question in App Store Connect on the build: the app
uses none of the listed encryption algorithms beyond what Apple's operating
system provides.

### 8. Sign in with Apple key (server)

Beta App Review exercises Delete account, and App Review guideline
5.1.1(v) requires it to revoke the user's Apple tokens. The server does
that only when `APPLE_SIGNIN_KEY`, `APPLE_SIGNIN_KEY_ID`, and
`APPLE_SIGNIN_TEAM_ID` are set (a key from Keys with Sign in with Apple
enabled). They are set on prod. `fly secrets list -a parkagent-api` shows
all three. The on-device check that deletion removes the app from the
Apple ID's Sign in with Apple list is #142.

## Running it

From GitHub: Actions → testflight → Run workflow, pick the branch or tag
(normally `main`, or a release tag such as `v1.0.0-rc3`), fill in any
inputs, Run.

From a terminal:

```sh
gh workflow run testflight.yml --ref main
gh workflow run testflight.yml --ref v1.0.0-rc3 \
  -f build_number=12 -f what_to_test="$(cat notes.txt)"
gh run watch
```

**Where the build shows up.** App Store Connect → Apps → ParkAgent →
TestFlight → iOS → Builds → 1.0.0 → build *N*. It says Processing for 5 to
30 minutes, and Apple emails when it is done. Testers in a group with
Automatic Distribution get it then, with a notification from the TestFlight
app. The run summary on GitHub has the version, build, and commit, and the
run's artifact has the dSYMs (they are also uploaded to Apple for crash
reports) and the logs.

**Build numbers.** The version (1.0.0) comes from `MARKETING_VERSION` in
`ios/project.yml`. The build number is the workflow's run number, so each
dispatch gets a new one. "Re-run jobs" keeps the old number, and App Store
Connect rejects a number it already has, so dispatch a new run instead, or
pass `build_number`. If builds were uploaded by hand before, set
`build_number` above the highest of them once; later runs must stay above it
too.

**Dry run.** The build talks to `api_base_url`. Whether money moves is the
server's setting, not the build's: check `curl
https://parkagent-api.fly.dev/health` shows `"dryRun": true` before handing
the build to testers.

## If it fails

| Message | Cause and fix |
|---|---|
| `APPLE_TEAM_ID … is not set` (or another secret) | Set it; see [Secrets and variables](#secrets-and-variables). |
| `Cloud signing permission error` | The API key is not Admin. Generate an Admin team key and replace the three secrets. |
| `Your account has reached the maximum number of certificates` | Development certificates left behind by runs that died before cleanup. Revoke the "Apple Development: Created via API" certificates under Certificates, Identifiers & Profiles → Certificates. Leave Apple Distribution certificates alone. |
| `No profiles for 'com.thomasbardhi.parkagent' were found` or `Provisioning profile doesn't include the … entitlement` | An App ID capability is missing (step 1), or the team has no registered device (step 2). |
| `The archived build number is '1', not …` | Info.plist does not read `$(CURRENT_PROJECT_VERSION)`; fix `ios/project.yml`. |
| `ITMS-90771` / `processing` without `BGTaskSchedulerPermittedIdentifiers` | Drop `processing` from `UIBackgroundModes` in `ios/project.yml`, or list the task identifiers. |
| `ITMS-90717: Invalid large app icon` | The 1024 px app icon has an alpha channel. Regenerate it without one (`ios/Tools/make_app_icon.py`). |
| `ITMS-90189` or "bundle version must be higher" | The build number is taken. Dispatch again or pass `build_number`. |
| `check-release-binary.sh is missing` or a hit from it | The Release binary gate. Fix what it reports; never skip it. |

## Tester notes (What to Test)

The workflow sets this text on each build when the `what_to_test` input is
empty. It is plain text in TestFlight, so keep it free of Markdown, and
under 4,000 characters. Preview it with
`python3 ios/Tools/testflight_asc.py notes`.

<!-- what-to-test:begin -->
```text
ParkAgent notices when you have parked at a street meter, shows the zone and what it will cost, and pays through your city's parking account when you confirm, within spending limits.

Getting set up
1. Sign in with Apple.
2. When asked, allow Location "Always", Motion & Fitness, and notifications. With "While Using" only, ParkAgent cannot notice that you parked while it is in the background. You can check these later in iOS Settings > ParkAgent.
3. Add your car's plate.
4. Choose your city and connect your city's parking account (ParkNYC or ParkBoston). You sign in on the provider's own page inside the app; ParkAgent never sees or keeps your password. By default it pays with the card already saved in that account.
5. Review the spending limits (during the beta they are the same for everyone).

Try it
- Drive to a metered block, park, and walk away from the car. Within a few minutes you should get a notification: "Parked in zone …" with the price. Tap it, check the zone and price against the sign at the meter, and tap Pay.
- The session then shows on the Park tab and in Activity. Near the end of the time, if you're still far from the car, ParkAgent extends it within your limits and tells you.
- In Boston, some blocks' zone numbers aren't known yet: the notification says so, and you type the number from the meter once. After that the block is known for everyone.

Dry run
While the server is in dry run, ParkAgent does everything except pay: the notification and the Pay screen say "Dry run", and the session and Activity show what it would have paid. Nothing is charged, and the meter is not paid either, so pay it yourself as usual.

Reporting problems
- Take a screenshot in the app and tap Share Beta Feedback, or open TestFlight, choose ParkAgent, and tap Send Beta Feedback.
- For a missed or wrong park, say when and where you parked and what you expected to happen.
- Crashes are reported automatically.
```
<!-- what-to-test:end -->

## Beta App Review notes

Paste into TestFlight → Test Information → Beta App Review Information →
Review Notes before the first external build of a version.

```text
What the app does
ParkAgent notices when the user has parked in a metered street-parking zone, shows the zone and what parking will cost, and, when the user confirms, pays the meter through the user's own account with the city's official parking app (ParkNYC in New York City, ParkBoston in Boston). It pays only within spending limits, and it can extend a session automatically before the meter runs out, within the same limits.

Sign-in
Sign in with Apple is the only sign-in method. Please use your own Apple ID; no demo account is needed.

Location (Always)
Noticing that the car has parked is the core feature, and it has to work without the app open. iOS only lets the app notice that the car has stopped and the driver has walked away if it can receive location changes in the background, so the app asks for Always. Location is sent to our server to find the meter zone the car is in. If the user asks the in-app parking assistant to find a garage, the server sends that search location, without the user's name or account, to the garage-search services it uses. Location is never used for advertising or tracking and is never sold.

Motion & Fitness
Used to tell driving from walking, so the app only treats a stop as parking once the driver has left the car.

Microphone and Speech Recognition
Requested only when the user taps the parking assistant's microphone button, to transcribe the question.

Paying
Paying requires linking a real ParkNYC or ParkBoston account. The user signs in on the provider's own web page inside the app, and the app never sees or stores that password. For this beta the server runs in dry run: no payment is made and no money moves. The app detects the stop, finds the zone, quotes the price, and records what it would have paid, marked "Dry run". Without a provider account you can still sign in, grant permissions, add a car, choose a city, choose how to pay, and at the connect step tap "Skip for now" to reach the app; outside those two cities choose "Somewhere else".

Deleting an account
Park tab > the avatar at the top right (it opens the Account sheet) > Delete account, near the bottom. Type DELETE to confirm.
```
