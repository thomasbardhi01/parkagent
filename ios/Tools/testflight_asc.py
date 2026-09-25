#!/usr/bin/env python3
"""App Store Connect helpers for the testflight workflow.

Used by .github/workflows/testflight.yml (see docs/testflight.md). Standard
library plus the `openssl` and, on macOS, `security` command-line tools, so a
hosted runner needs nothing installed. Every call authenticates with the same
team API key the xcodebuild steps use:

    ASC_KEY_PATH    the .p8 file (written by `write-key`)
    ASC_KEY_ID      its key id
    ASC_ISSUER_ID   the team's issuer id

Subcommands:

    write-key --out PATH
        Decode ASC_KEY_BASE64 (base64 of the .p8, or the PEM itself) to PATH
        with mode 600, masking every line of it in the GitHub log first.

    dev-certs --out PATH
        Record the Apple Development certificates in this Mac's keychains.
        Run it before `xcodebuild archive`.

    revoke-new-dev-certs --before PATH
        Revoke the Apple Development certificates that appeared since
        `dev-certs`. Archiving signs with a development identity, and on a
        runner with an empty keychain -allowProvisioningUpdates mints a new
        one every run; Apple caps how many a team can hold, so without this
        the pipeline stops after a few builds with "Your account has reached
        the maximum number of certificates". Only a certificate that is both
        new in this keychain and a DEVELOPMENT certificate in the account
        (matched on its exact bytes) is touched. Never fails the job.

    what-to-test --bundle-id ID --version V --build N [--text T] [--doc PATH]
        Wait until the uploaded build finishes processing, then set its
        "What to Test" (TestFlight's betaBuildLocalizations.whatsNew). An
        empty --text falls back to the block between the what-to-test markers
        in --doc.

    notes --doc PATH
        Print the What to Test block from the doc, to preview it locally.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.appstoreconnect.apple.com"
WHATS_NEW_LIMIT = 4000  # App Store Connect's limit for What to Test
NOTES_BEGIN = "<!-- what-to-test:begin -->"
NOTES_END = "<!-- what-to-test:end -->"


class ASCError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(f"HTTP {status}: {detail}")
        self.status = status


# ---------------------------------------------------------------- output


def _escape(message: str) -> str:
    # Workflow commands end at a newline; escape so an API error body can't
    # start a command line of its own.
    return str(message).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def warning(message: str) -> None:
    print(f"::warning::{_escape(message)}", flush=True)


def error(message: str) -> None:
    print(f"::error::{_escape(message)}", flush=True)


def summary(markdown: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(markdown + "\n")


# ---------------------------------------------------------------- auth


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _der_to_raw(der: bytes) -> bytes:
    """ECDSA signature: DER SEQUENCE{INTEGER r, INTEGER s} -> r||s, 32 bytes each (ES256)."""
    if len(der) < 8 or der[0] != 0x30:
        raise ValueError("openssl did not return a DER ECDSA signature")
    index = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    parts = []
    for _ in range(2):
        if der[index] != 0x02:
            raise ValueError("malformed ECDSA signature")
        length = der[index + 1]
        value = der[index + 2 : index + 2 + length].lstrip(b"\x00")
        if len(value) > 32:
            raise ValueError("ECDSA signature component longer than 32 bytes")
        parts.append(value.rjust(32, b"\x00"))
        index += 2 + length
    return parts[0] + parts[1]


def _required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"{name} is not set")
    return value


def bearer_token() -> str:
    """A fresh ES256 JWT (App Store Connect allows at most 20 minutes; this uses 15)."""
    key_path = _required_env("ASC_KEY_PATH")
    now = int(time.time())
    header = {"alg": "ES256", "kid": _required_env("ASC_KEY_ID"), "typ": "JWT"}
    payload = {
        "iss": _required_env("ASC_ISSUER_ID"),
        "iat": now,
        "exp": now + 15 * 60,
        "aud": "appstoreconnect-v1",
    }
    signing_input = ".".join(_b64url(json.dumps(part, separators=(",", ":")).encode()) for part in (header, payload))
    signed = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", key_path],
        input=signing_input.encode(),
        capture_output=True,
        check=False,
    )
    if signed.returncode != 0:
        raise SystemExit("openssl could not sign with the API key (is ASC_KEY_PATH a .p8?)")
    return f"{signing_input}.{_b64url(_der_to_raw(signed.stdout))}"


# ---------------------------------------------------------------- http


def _detail(raw: bytes) -> str:
    try:
        errors = json.loads(raw).get("errors") or []
        return "; ".join(f"{e.get('title', '')}: {e.get('detail', '')}".strip() for e in errors)[:500]
    except (ValueError, AttributeError):
        return raw.decode("utf-8", "replace")[:500]


def request(method: str, path: str, body: dict | None = None, attempts: int = 3) -> dict | None:
    # A path, or a pagination link the API returned. The bearer token only
    # ever goes to the API's own host.
    if path.startswith("/"):
        url = API + path
    elif path.startswith(API + "/"):
        url = path
    else:
        raise ASCError(0, f"refusing to send the API token to {path}")
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {bearer_token()}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            retryable = exc.code == 429 or exc.code >= 500
            if not retryable or attempt == attempts:
                raise ASCError(exc.code, _detail(exc.read())) from None
        except OSError as exc:  # URLError, timeouts, resets
            if attempt == attempts:
                raise ASCError(0, f"{method} {url} did not get an answer: {exc}") from None
        time.sleep(5 * attempt)
    return None


def list_all(path: str) -> list[dict]:
    items: list[dict] = []
    next_url: str | None = path
    while next_url:
        page = request("GET", next_url) or {}
        items.extend(page.get("data") or [])
        next_url = (page.get("links") or {}).get("next")
    return items


def query(path: str, **params: str) -> str:
    return f"{path}?{urllib.parse.urlencode(params)}"


# ---------------------------------------------------------------- write-key


def cmd_write_key(args: argparse.Namespace) -> int:
    raw = os.environ.get("ASC_KEY_BASE64", "").strip()
    if not raw:
        error("ASC_KEY_BASE64 is empty: set the APP_STORE_CONNECT_API_KEY_BASE64 secret (docs/testflight.md).")
        return 1
    if "-----BEGIN" in raw:
        pem = raw
    else:
        try:
            pem = base64.b64decode("".join(raw.split()), validate=True).decode("ascii")
        except (ValueError, UnicodeDecodeError):
            error("APP_STORE_CONNECT_API_KEY_BASE64 is not valid base64 of a .p8 file.")
            return 1
    # Mask before anything could print it. Only on Actions: anywhere else the
    # mask command would itself print the key.
    if os.environ.get("GITHUB_ACTIONS") == "true":
        for line in pem.splitlines():
            if line.strip() and not line.startswith("-----"):
                print(f"::add-mask::{line.strip()}", flush=True)
    if "-----BEGIN PRIVATE KEY-----" not in pem:
        error("APP_STORE_CONNECT_API_KEY_BASE64 does not decode to a .p8 private key (expected a PEM 'PRIVATE KEY').")
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), mode=0o700, exist_ok=True)
    old_umask = os.umask(0o077)
    try:
        with open(args.out, "w", encoding="ascii") as handle:
            handle.write(pem.strip() + "\n")
    finally:
        os.umask(old_umask)
    os.chmod(args.out, 0o600)

    check = subprocess.run(["openssl", "pkey", "-in", args.out, "-noout"], capture_output=True, check=False)
    if check.returncode != 0:
        os.remove(args.out)
        error("The decoded API key does not load as a private key; re-export the .p8 (docs/testflight.md).")
        return 1
    print(f"Wrote the App Store Connect API key to {args.out}")
    return 0


# ---------------------------------------------------------------- certificates


def keychain_dev_certs() -> dict[str, bytes]:
    """SHA-1 (hex) -> DER of every Apple Development certificate in the keychain search list."""
    found = subprocess.run(
        ["security", "find-certificate", "-a", "-c", "Apple Development", "-p"],
        capture_output=True,
        text=True,
        check=False,
    )
    # Exit status 44 means "none found"; anything else is just an empty result for us.
    certs: dict[str, bytes] = {}
    for body in re.findall(r"-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", found.stdout, re.DOTALL):
        der = base64.b64decode("".join(body.split()))
        certs[hashlib.sha1(der).hexdigest().upper()] = der
    return certs


def cmd_dev_certs(args: argparse.Namespace) -> int:
    certs = keychain_dev_certs()
    with open(args.out, "w", encoding="ascii") as handle:
        handle.write("".join(f"{sha}\n" for sha in sorted(certs)))
    print(f"{len(certs)} Apple Development certificate(s) in the keychain before archiving.")
    return 0


def cmd_revoke_new_dev_certs(args: argparse.Namespace) -> int:
    # Cleanup never fails the job: by now the build is archived (and maybe
    # uploaded), and a certificate left behind costs a later run at worst.
    try:
        return _revoke_new_dev_certs(args)
    except (Exception, SystemExit) as exc:  # noqa: BLE001 - cleanup must not fail the job
        warning(
            f"Development certificate cleanup failed: {exc}. Revoke stray 'Created via API' "
            "development certificates by hand if a later archive hits the certificate limit."
        )
        return 0


def _revoke_new_dev_certs(args: argparse.Namespace) -> int:
    if os.environ.get("GITHUB_ACTIONS") != "true" and os.environ.get("ALLOW_LOCAL_REVOKE") != "1":
        print("Not on GitHub Actions; refusing to revoke certificates (ALLOW_LOCAL_REVOKE=1 overrides).")
        return 0
    try:
        with open(args.before, encoding="ascii") as handle:
            before = {line.strip() for line in handle if line.strip()}
    except FileNotFoundError:
        print(f"No snapshot at {args.before}; nothing to compare, nothing revoked.")
        return 0

    new = {sha: der for sha, der in keychain_dev_certs().items() if sha not in before}
    if not new:
        print("This run added no Apple Development certificate to the keychain; nothing to revoke.")
        return 0

    account = list_all(query("/v1/certificates", limit="200"))
    revoked = 0
    for sha, der in new.items():
        match = None
        for cert in account:
            attrs = cert.get("attributes") or {}
            if "DEVELOPMENT" not in str(attrs.get("certificateType", "")):
                continue
            content = attrs.get("certificateContent") or ""
            if content and base64.b64decode(content) == der:
                match = cert
                break
        if match is None:
            print(f"Certificate {sha[:12]}… is not in the account (already revoked?); skipping.")
            continue
        request("DELETE", f"/v1/certificates/{match['id']}")
        revoked += 1
        name = (match.get("attributes") or {}).get("name", "Apple Development")
        print(f"Revoked the development certificate this run created: {name} ({sha[:12]}…).")
    print(f"Revoked {revoked} of {len(new)} new development certificate(s).")
    return 0


# ---------------------------------------------------------------- what to test


def notes_from_doc(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    if NOTES_BEGIN not in text or NOTES_END not in text:
        raise SystemExit(f"{path} has no {NOTES_BEGIN} … {NOTES_END} block")
    block = text.split(NOTES_BEGIN, 1)[1].split(NOTES_END, 1)[0]
    lines = [line for line in block.splitlines() if not line.strip().startswith("```")]
    return "\n".join(lines).strip()


def cmd_notes(args: argparse.Namespace) -> int:
    notes = notes_from_doc(args.doc)
    print(notes)
    print(f"\n({len(notes)} of {WHATS_NEW_LIMIT} characters)", file=sys.stderr)
    return 0


def find_app_id(bundle_id: str) -> str:
    apps = request("GET", query("/v1/apps", **{"filter[bundleId]": bundle_id})) or {}
    for app in apps.get("data") or []:
        if (app.get("attributes") or {}).get("bundleId") == bundle_id:
            return app["id"]
    raise SystemExit(f"No App Store Connect app with bundle id {bundle_id} (create the app record first).")


def find_build(app_id: str, version: str, build: str) -> dict | None:
    builds = (
        request(
            "GET",
            query(
                "/v1/builds",
                **{
                    "filter[app]": app_id,
                    "filter[version]": build,
                    "filter[preReleaseVersion.version]": version,
                    "limit": "5",
                },
            ),
        )
        or {}
    )
    data = builds.get("data") or []
    return data[0] if data else None


def set_whats_new(build_id: str, locale: str, text: str) -> None:
    existing = list_all(f"/v1/builds/{build_id}/betaBuildLocalizations")
    for loc in existing:
        if (loc.get("attributes") or {}).get("locale") == locale:
            request(
                "PATCH",
                f"/v1/betaBuildLocalizations/{loc['id']}",
                {"data": {"type": "betaBuildLocalizations", "id": loc["id"], "attributes": {"whatsNew": text}}},
            )
            return
    request(
        "POST",
        "/v1/betaBuildLocalizations",
        {
            "data": {
                "type": "betaBuildLocalizations",
                "attributes": {"locale": locale, "whatsNew": text},
                "relationships": {"build": {"data": {"type": "builds", "id": build_id}}},
            }
        },
    )


def cmd_what_to_test(args: argparse.Namespace) -> int:
    text = (args.text or "").strip()
    source = "the workflow input"
    if not text:
        text = notes_from_doc(args.doc)
        source = args.doc
    if not text:
        error("What to Test is empty.")
        return 1
    if len(text) > WHATS_NEW_LIMIT:
        error(f"What to Test is {len(text)} characters; App Store Connect allows {WHATS_NEW_LIMIT}.")
        return 1

    label = f"{args.version} ({args.build})"
    app_id = find_app_id(args.bundle_id)
    deadline = time.monotonic() + args.timeout_minutes * 60
    last_state = None
    build = None
    while True:
        build = find_build(app_id, args.version, args.build)
        state = ((build or {}).get("attributes") or {}).get("processingState") if build else "NOT_LISTED_YET"
        if state != last_state:
            print(f"{time.strftime('%H:%M:%S')} build {label}: {state}", flush=True)
            last_state = state
        if state == "VALID":
            break
        if state in ("FAILED", "INVALID"):
            error(
                f"App Store Connect finished processing build {label} as {state}. "
                "Apple emails the reason to the account holder; the build cannot be tested."
            )
            summary(f"- Processing: **{state}**; see Apple's email for the reason.")
            return 1
        if time.monotonic() > deadline:
            warning(
                f"Build {label} was still {state} after {args.timeout_minutes} minutes; "
                "What to Test was not set. Paste it in App Store Connect → TestFlight when processing ends."
            )
            summary(f"- Processing: still {state} after {args.timeout_minutes} min; What to Test **not set**.")
            return 0
        time.sleep(30)

    set_whats_new(build["id"], args.locale, text)
    print(f"Set What to Test ({args.locale}, {len(text)} characters, from {source}) on build {label}.")
    summary(f"- Processing: **VALID**. What to Test set from {source}.")

    compliance = (build.get("attributes") or {}).get("usesNonExemptEncryption")
    if compliance is None:
        warning(
            f"Build {label} shows Missing Compliance: Info.plist lacks ITSAppUsesNonExemptEncryption. "
            "Answer the export-compliance question in App Store Connect before testers can install it."
        )
        summary("- Export compliance: **missing**; answer it in App Store Connect → TestFlight.")
    return 0


# ---------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("write-key")
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_write_key)

    p = sub.add_parser("dev-certs")
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_dev_certs)

    p = sub.add_parser("revoke-new-dev-certs")
    p.add_argument("--before", required=True)
    p.set_defaults(func=cmd_revoke_new_dev_certs)

    p = sub.add_parser("what-to-test")
    p.add_argument("--bundle-id", required=True)
    p.add_argument("--version", required=True, help="CFBundleShortVersionString, e.g. 1.0.0")
    p.add_argument("--build", required=True, help="CFBundleVersion, e.g. 42")
    p.add_argument("--text", default="")
    p.add_argument("--doc", default="docs/testflight.md")
    p.add_argument("--locale", default="en-US")
    p.add_argument("--timeout-minutes", type=int, default=60)
    p.set_defaults(func=cmd_what_to_test)

    p = sub.add_parser("notes")
    p.add_argument("--doc", default="docs/testflight.md")
    p.set_defaults(func=cmd_notes)

    args = parser.parse_args()
    try:
        return args.func(args)
    except ASCError as exc:
        error(f"App Store Connect: {exc}")
        return 1
    except SystemExit as exc:
        if isinstance(exc.code, str):  # a message from this script, not argparse
            error(exc.code)
            return 1
        raise


if __name__ == "__main__":
    sys.exit(main())
