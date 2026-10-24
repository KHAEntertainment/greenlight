#!/usr/bin/env python3
"""Ask npm whether this job's OIDC identity is a usable trusted publisher.

npm CLI collapses every trusted-publishing failure into a misleading
`ENEEDAUTH`/"please log in" message (npm/cli#9088), so a publish attempt cannot
tell a missing trusted publisher from a mismatch. This does the exchange by hand
and prints the registry's own answer, without printing either token.

Run inside a GitHub Actions job that has `id-token: write`.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

AUDIENCE = "npm:registry.npmjs.org"
# Mirrors lib/utils/oidc.js in the npm CLI: the GitHub OIDC token is presented
# as the Authorization bearer to the per-package exchange endpoint.
EXCHANGE = "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/{}"
PACKAGE = "@khaentertainment/pi-jev2"
# A JWT (the GitHub OIDC token) or an npm token, wherever it sits in a reply.
TOKEN_SHAPES = re.compile(r"eyJ[\w-]+\.[\w-]+\.[\w-]+|npm_[A-Za-z0-9]{20,}")


def redact(value, secret: str):
    """Mask credentials in a registry reply before it is printed.

    Values under a key naming a token are blanked at any depth, and
    token-shaped strings are masked everywhere else: in keys, in values, and
    in a raw non-JSON error body.
    """
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            key = redact(str(k), secret)
            while key in out:  # two keys masked to the same text
                key += "'"
            out[key] = "<redacted>" if "token" in str(k).lower() else redact(v, secret)
        return out
    if isinstance(value, list):
        return [redact(v, secret) for v in value]
    if isinstance(value, str):
        return TOKEN_SHAPES.sub("<redacted>", value.replace(secret, "<redacted>"))
    return value


def mint() -> str:
    url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    bearer = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not url or not bearer:
        sys.exit("id-token: write is not in effect for this job (no OIDC endpoint)")
    req = urllib.request.Request(
        f"{url}&audience={AUDIENCE}",
        headers={"Authorization": f"bearer {bearer}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        token = json.load(resp)["value"]
    # The runner masks it in every later line of this job's log.
    print(f"::add-mask::{token}")
    return token


def exchange(oidc_token: str):
    escaped = urllib.parse.quote(PACKAGE, safe="")
    req = urllib.request.Request(
        EXCHANGE.format(escaped),
        data=b"",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {oidc_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", "replace")
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, raw


def main() -> int:
    token = mint()
    print(f"minted a GitHub OIDC token ({len(token)} bytes) for audience {AUDIENCE}")
    status, payload = exchange(token)
    print(f"exchange HTTP {status}")
    # npm answers 201 Created on success; accept any 2xx.
    if 200 <= status < 300 and isinstance(payload, dict):
        # Do not print the credential itself.
        fields = sorted(redact(str(k), token) for k in payload)
        print("exchange OK; response fields: " + ", ".join(fields))
        print("trusted publisher is configured and usable from this workflow")
        return 0
    print("registry said: " + json.dumps(redact(payload, token), indent=2))
    print(
        "::error::npm rejected the OIDC exchange, so `npm publish` will fall back "
        "to token auth and fail with ENEEDAUTH. A 'package not found' here means no "
        "trusted publisher is configured for this package on npmjs.com, or the one "
        "configured does not match this repository and workflow filename. See "
        "PUBLISHING.md; adding it needs an interactive passkey on npmjs.com."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
