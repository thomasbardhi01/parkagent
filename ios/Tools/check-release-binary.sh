#!/usr/bin/env bash
# Fails if a Release build of the app carries debug-only code or dev strings.
#
#   ios/Tools/check-release-binary.sh path/to/ParkAgent.app
#
# Runs `strings` over the app's executable and checks it against
# ios/Tools/release-denylist.txt (the same list ParkAgentReleaseTests reads
# from inside the Release build): every forbidden marker absent, every
# required marker present — the required ones prove the scan read the real
# app, so an empty result can't come from scanning the wrong file. Also
# checks the shipped bundle for the privacy manifest and the App Store
# Info.plist keys. See the denylist's header for what `strings` can't see.
#
# Used by CI (a Release simulator build) and by the TestFlight workflow on
# the archived app before it uploads.

set -euo pipefail

APP="${1:?usage: $0 path/to/ParkAgent.app}"
HERE="$(cd "$(dirname "$0")" && pwd)"
LIST="$HERE/release-denylist.txt"
BIN="$APP/ParkAgent"

[ -f "$BIN" ] || { echo "No executable at $BIN"; exit 1; }
if [ -f "$APP/ParkAgent.debug.dylib" ]; then
  echo "$APP is a Debug build (it has ParkAgent.debug.dylib) — build Release."
  exit 1
fi

STRINGS=$(mktemp)
trap 'rm -f "$STRINGS"' EXIT
strings -a "$BIN" > "$STRINGS"

failed=0
while IFS= read -r line || [ -n "$line" ]; do
  # Trim like the Swift parser (ReleaseDenylist.swift) so both read the
  # same entries: CR, then leading and trailing whitespace.
  line="${line%$'\r'}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  case "$line" in
    ''|'#'*) continue ;;
    # Type entries are checked by ParkAgentReleaseTests in the Swift
    # runtime; the plain names are also listed as strings above.
    'type '*|'+ type '*) continue ;;
    '+ '*)
      marker="${line#+ }"
      if ! grep -qF -- "$marker" "$STRINGS"; then
        echo "MISSING required marker: $marker (is this the right binary?)"
        failed=1
      fi
      ;;
    *)
      if grep -qF -- "$line" "$STRINGS"; then
        echo "FORBIDDEN in Release binary: $line"
        grep -F -- "$line" "$STRINGS" | sort -u | head -3 | sed 's/^/    /'
        failed=1
      fi
      ;;
  esac
done < "$LIST"

[ -f "$APP/PrivacyInfo.xcprivacy" ] || { echo "MISSING PrivacyInfo.xcprivacy in the app bundle"; failed=1; }
plist="$APP/Info.plist"
enc=$(/usr/libexec/PlistBuddy -c 'Print :ITSAppUsesNonExemptEncryption' "$plist" 2>/dev/null || echo missing)
[ "$enc" = "false" ] || { echo "ITSAppUsesNonExemptEncryption is '$enc', want false"; failed=1; }
modes=$(/usr/libexec/PlistBuddy -c 'Print :UIBackgroundModes' "$plist" 2>/dev/null | tr -d ' \n' || true)
[ "$modes" = "Array{location}" ] || { echo "UIBackgroundModes is '$modes', want only location"; failed=1; }

if [ "$failed" -ne 0 ]; then
  echo "Release binary check FAILED for $APP"
  exit 1
fi
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")
build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")
echo "Release binary check passed: $APP ($version build $build) — no dev strings, required markers present."
