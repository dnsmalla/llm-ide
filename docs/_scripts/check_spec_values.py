"""Verify that specific VALUES documented in docs/spec/*.md match their source.

Run from repo root:  python3 docs/_scripts/check_spec_values.py
Exit 0 if every documented value matches source; exit 1 + the mismatches.

Why: `check_spec_citations.py` guards that cited *files* exist — but not that the
*values* in the prose are current. Hand-maintained spec prose drifts (a migration
head, an API version, a default limit) while every cited file still resolves, so
the drift sails through CI. This guard parses a small set of high-value, specific
claims and asserts each equals its source of truth.

Each check (a) reads the live value from source and (b) finds the value the spec
documents via a precise regex. A mismatch fails — and so does a *missing* spec
claim (reworded or deleted), because that is also drift. Keep the set small and
high-signal; this is a backstop for the values that have actually rotted, not an
attempt to machine-check every number in the prose.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path


def first_int(text: str, pattern: str) -> int | None:
    """First capture group of `pattern` in `text`, as int, or None if no match."""
    m = re.search(pattern, text)
    return int(m.group(1)) if m else None


def migration_head(migrations_dir: Path) -> int | None:
    """Highest NNNN prefix among NNNN_*.sql files in the dir, or None if none."""
    heads = [
        int(m.group(1))
        for p in migrations_dir.glob("*.sql")
        if (m := re.match(r"^(\d{4})_", p.name))
    ]
    return max(heads) if heads else None


def _read(path: str) -> str:
    return Path(path).read_text()


def build_checks() -> list[tuple[str, int | None, int | None, str]]:
    """Return (label, source_value, documented_value, spec_page) tuples."""
    cross = _read("docs/spec/cross-cutting.md")
    kb = _read("docs/spec/knowledge-base.md")
    server = _read("extension/server.mjs")
    config = _read("extension/core/config.mjs")

    head = migration_head(Path("extension/kb/migrations"))
    api = first_int(server, r"SERVER_API_VERSION\s*=\s*(\d+)")
    body = first_int(config, r"LLMIDE_BODY_LIMIT_MB',\s*(\d+)")

    return [
        ("migration head — cross-cutting.md 'head migration is `NNNN`'",
         head, first_int(cross, r"head migration is `0*(\d+)`"),
         "docs/spec/cross-cutting.md"),
        ("migration head — knowledge-base.md 'through `NNNN_….sql`'",
         head, first_int(kb, r"through `0*(\d+)_[a-z0-9_]+\.sql`"),
         "docs/spec/knowledge-base.md"),
        ("SERVER_API_VERSION — cross-cutting.md",
         api, first_int(cross, r"SERVER_API_VERSION = (\d+)"),
         "docs/spec/cross-cutting.md"),
        ("body-limit default MB — cross-cutting.md",
         body, first_int(cross, r"\*\*(\d+) MB\*\* default"),
         "docs/spec/cross-cutting.md"),
    ]


def main() -> int:
    problems: list[str] = []
    checks = build_checks()
    for label, source_val, doc_val, where in checks:
        if source_val is None:
            problems.append(f"{label}: could not read the SOURCE value (extractor returned None)")
        elif doc_val is None:
            problems.append(f"{label}: no documented value found in {where} (reworded or removed?)")
        elif source_val != doc_val:
            problems.append(f"{label}: spec says {doc_val} but source is {source_val} ({where})")
    if problems:
        print("Spec value drift (documented value does not match source):")
        for p in problems:
            print(f"  {p}")
        return 1
    print(f"OK: all {len(checks)} documented spec values match source.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
