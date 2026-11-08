"""Fail on a live `mac/` reference outside the pages that record the retired Swift app (C8, F18).

The Mac app was removed on 2026-11-06. Its ADRs, the kit pages that document the Mac-era implementation, the
CHANGELOG and the superpowers plan archive are history and are NOT scanned. Everywhere else a `mac/` path or
command would send a reader to a folder that no longer exists; a line that explains that it was removed/retired
is allowed.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
# History: decisions, kit close-outs, the plan archive. Everything else is a live page.
EXEMPT_DIRS = ("decisions", "kits", "superpowers")
ALLOWED = re.compile(r"\b(removed|retired|deleted|history)\b", re.IGNORECASE)
REF = re.compile(r"mac/")


def bad_lines(paths: list[Path]) -> list[str]:
    out: list[str] = []
    for path in paths:
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if REF.search(line) and not ALLOWED.search(line):
                try:
                    where = path.relative_to(ROOT)
                except ValueError:  # a caller's temp file
                    where = path
                out.append(f"{where}:{n}: {line.strip()[:160]}")
    return out


def live_docs() -> list[Path]:
    out: list[Path] = []
    for path in sorted(DOCS.rglob("*.md")):
        rel = path.relative_to(DOCS)
        if rel.parts and rel.parts[0] in EXEMPT_DIRS:
            continue
        out.append(path)
    return out


def main() -> int:
    problems = bad_lines(live_docs())
    if problems:
        print(f"{len(problems)} live `mac/` reference(s); point at the desktop app or say it was removed:")
        for p in problems:
            print("  " + p)
        return 1
    print("mac refs: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
