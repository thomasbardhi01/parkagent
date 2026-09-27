#!/usr/bin/env bash
# Fails when a workflow uses a third-party GitHub Action by anything but a
# full commit SHA with a version comment:
#
#   uses: owner/repo@<40-hex sha> # v1.2.3
#
# A tag or branch can be moved under us, and a workflow step runs with
# whatever token its job holds (the deploy and the nightly hold
# FLY_API_TOKEN). GitHub's own actions (actions/*) and local ones (./…)
# are exempt. Dependabot's github-actions updates move the SHA and the
# comment together (.github/dependabot.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bad=0
while IFS= read -r hit; do
  file="${hit%%:*}"
  rest="${hit#*:}"
  line="${rest%%:*}"
  text="${rest#*:}"
  ref="$(printf '%s' "$text" | sed -E 's/^[[:space:]-]*uses:[[:space:]]*//; s/[[:space:]]+#.*$//; s/[[:space:]]*$//')"
  case "$ref" in
    actions/* | ./*) continue ;;
  esac
  if ! printf '%s' "$ref" | grep -Eq '^[^@[:space:]]+@[0-9a-f]{40}$' ||
    ! printf '%s' "$text" | grep -Eq '@[0-9a-f]{40}[[:space:]]+#[[:space:]]*[^[:space:]]'; then
    echo "${file#"$ROOT"/}:$line: pin '$ref' to a full commit SHA with a version comment (uses: owner/repo@<sha> # vX.Y.Z)" >&2
    bad=1
  fi
done < <(grep -nE '^[[:space:]-]*uses:' "$ROOT"/.github/workflows/*.yml "$ROOT"/.github/workflows/*.yaml 2>/dev/null || true)

if [ "$bad" -ne 0 ]; then exit 1; fi
echo "check-action-pins: every third-party action is pinned to a commit SHA"
