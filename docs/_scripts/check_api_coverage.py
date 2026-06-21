"""Diff the live ENDPOINTS array in extension/server.mjs against the
paths documented in docs/reference/api/openapi.yaml.

Run from repo root:  python docs/_scripts/check_api_coverage.py
Exit 0 if every live endpoint has an OpenAPI path; exit 1 + list otherwise.
"""
from __future__ import annotations
import re, sys
from pathlib import Path

SERVER = Path("extension/server.mjs")
OPENAPI = Path("docs/reference/api/openapi.yaml")

def _normalize_path(p: str) -> str:
    """Convert Express :param segments to OpenAPI {param} so paths compare cleanly."""
    return re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", p)

def live_endpoints(text: str) -> set[str]:
    # ENDPOINTS = [ '/health', '/kb/search', ... ]
    m = re.search(r"ENDPOINTS\s*=\s*\[(?P<body>.*?)\]", text, re.DOTALL)
    if not m:
        raise SystemExit("could not find ENDPOINTS array in server.mjs")
    raw = re.findall(r"['\"](/[^'\"]+)['\"]", m.group("body"))
    return {_normalize_path(p) for p in raw}

def documented_paths(text: str) -> set[str]:
    # top-level "  /path:" entries under the paths: block
    return set(re.findall(r"^\s{2}(/[A-Za-z0-9_{}/-]+):", text, re.MULTILINE))

def main() -> int:
    live = live_endpoints(SERVER.read_text())
    documented = documented_paths(OPENAPI.read_text())
    missing = sorted(live - documented)
    if missing:
        print("Endpoints missing from openapi.yaml:")
        for p in missing:
            print(f"  {p}")
        return 1
    print(f"OK: all {len(live)} live endpoints documented.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
