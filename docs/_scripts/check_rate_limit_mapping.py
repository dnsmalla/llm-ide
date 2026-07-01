"""Guard the rate-limit URL->profile table in docs/spec/api-server.md against
the authoritative `rateLimitProfile()` in extension/server.mjs.

Run from repo root:  python3 docs/_scripts/check_rate_limit_mapping.py
Exit 0 if every URL that rateLimitProfile() maps is listed under the correct
profile in the spec's §6 table; exit 1 + the violations otherwise.

Scope: this guards the URLs that `rateLimitProfile()` actually dispatches.
The `authPublic`/`authRegister`/`liveAppend` profiles are applied inside their
own handlers (not via rateLimitProfile) and are intentionally out of scope.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SERVER = Path("extension/server.mjs")
SPEC = Path("docs/spec/api-server.md")

PROFILE_FN_RE = re.compile(
    r"function\s+rateLimitProfile\s*\([^)]*\)\s*\{(?P<body>.*?)\n\}",
    re.DOTALL,
)
RETURN_RE = re.compile(r"return\s+'(?P<profile>\w+)'")
URL_LITERAL_RE = re.compile(r"'(?P<url>/[^']*)'")
# A markdown table row whose first cell is a backtick-wrapped profile name.
DOC_ROW_RE = re.compile(r"^\|\s*`(?P<profile>\w+)`\s*\|(?P<rest>.*)$", re.MULTILINE)


def source_pairs(server_text: str) -> set[tuple[str, str]]:
    """Every (url, profile) the rateLimitProfile() body maps.

    Handles `=== 'url'`, `path === 'url'`, the `'a' || 'b'` OR form, and
    `.startsWith('prefix')` — each url/prefix literal on a line is paired
    with that line's `return 'profile'`.
    """
    m = PROFILE_FN_RE.search(server_text)
    if not m:
        raise SystemExit("could not find rateLimitProfile() in server.mjs")
    pairs: set[tuple[str, str]] = set()
    for line in m.group("body").splitlines():
        ret = RETURN_RE.search(line)
        if not ret:
            continue
        profile = ret.group("profile")
        for um in URL_LITERAL_RE.finditer(line):
            pairs.add((um.group("url"), profile))
    return pairs


def doc_profile_rows(spec_text: str) -> dict[str, str]:
    """Map each profile name to the text of its §6 table row."""
    return {m.group("profile"): m.group("rest") for m in DOC_ROW_RE.finditer(spec_text)}


def _mentions(url: str, row: str) -> bool:
    # Boundary match so '/kb/email/test' doesn't match inside '/kb/email/seen'
    # and a prefix like '/kb/connect-' matches '/kb/connect-*'.
    return re.search(r"(?<![\w/-])" + re.escape(url) + r"(?![\w/-])", row) is not None


def find_violations(pairs: set[tuple[str, str]], rows: dict[str, str]) -> list[str]:
    out: list[str] = []
    for url, profile in sorted(pairs):
        if profile not in rows:
            out.append(f"profile '{profile}' (maps {url}) is missing from the §6 table")
            continue
        if not _mentions(url, rows[profile]):
            out.append(f"{url} should be listed under '{profile}' but is not")
        for other, row in rows.items():
            if other != profile and _mentions(url, row):
                out.append(f"{url} is wrongly listed under '{other}' (real profile: '{profile}')")
    return out


def main() -> int:
    pairs = source_pairs(SERVER.read_text())
    rows = doc_profile_rows(SPEC.read_text())
    violations = find_violations(pairs, rows)
    if violations:
        print("Rate-limit mapping drift between server.mjs and api-server.md §6:")
        for v in violations:
            print(f"  {v}")
        return 1
    print(f"OK: all {len(pairs)} rateLimitProfile() mappings match the §6 table.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
