"""Verify that every repo file path cited in docs/spec/*.md actually exists.

Run from repo root:  python3 docs/_scripts/check_spec_citations.py
Exit 0 if every cited path resolves; exit 1 + the dead citations otherwise.

Why: the spec layer is hand-maintained and cites source by `file:line` /
`file:symbol`. Line numbers drift constantly (too noisy to check), but a cited
FILE that gets deleted or renamed is a real, damaging form of doc-rot — and the
Swift/macOS spec has no other automated guard. This checks file existence only.

A "citation" is a backtick-wrapped token that looks like a repo-relative path
into one of the known source trees, with a known extension. Placeholders
(containing <, >, *, {, }, or "...") are skipped.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SPEC_DIR = Path("docs/spec")

# Trees we treat as real repo source. A cited path must start with one of these.
KNOWN_ROOTS = ("extension/", "mac/", "docs/", "kb/", ".github/", "core/")

# Extensions that denote a real file (not a prose word with a dot).
KNOWN_EXTS = (
    ".mjs", ".ts", ".tsx", ".js", ".swift", ".sql", ".py",
    ".yaml", ".yml", ".json", ".sh", ".md", ".entitlements", ".plist",
)

# Inside-backtick tokens. We then post-filter to path-shaped ones.
BACKTICK_RE = re.compile(r"`([^`]+)`")

# A path-shaped token: has a slash and ends in a known extension, optionally
# followed by a :line, :line-range, or :symbol suffix we strip off.
PATH_RE = re.compile(
    r"^(?P<path>[A-Za-z0-9_./-]+(?:" + "|".join(re.escape(e) for e in KNOWN_EXTS) + r"))"
    r"(?::[0-9].*)?$"
)


def is_placeholder(token: str) -> bool:
    return any(c in token for c in "<>*{}") or "..." in token or "NNNN" in token


def extract_citations(text: str) -> set[str]:
    out: set[str] = set()
    for m in BACKTICK_RE.finditer(text):
        token = m.group(1).strip()
        if is_placeholder(token):
            continue
        pm = PATH_RE.match(token)
        if not pm:
            continue
        path = pm.group("path")
        if "/" not in path:
            continue
        if not path.startswith(KNOWN_ROOTS):
            continue
        out.add(path)
    return out


def main() -> int:
    spec_files = sorted(SPEC_DIR.glob("*.md"))
    if not spec_files:
        raise SystemExit(f"no spec files found under {SPEC_DIR}")
    dead: list[tuple[str, str]] = []
    total = 0
    for f in spec_files:
        cites = extract_citations(f.read_text())
        for path in sorted(cites):
            total += 1
            if not Path(path).exists():
                dead.append((f.name, path))
    if dead:
        print("Dead file citations in docs/spec (cited path does not exist):")
        for src, path in dead:
            print(f"  {src}: {path}")
        return 1
    print(f"OK: all {total} repo-path citations across {len(spec_files)} spec pages resolve.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
