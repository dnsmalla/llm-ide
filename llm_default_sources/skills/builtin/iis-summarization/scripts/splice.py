#!/usr/bin/env python3
"""Splice the summarizer narrative into the report.

Usage: python scripts/splice.py <report.md> <narrative.md>

Replaces the single-line narrative placeholder written by
report_generator.py with the contents of <narrative.md>. Exists so the
skill orchestrator never has to load the full report into its context
just to perform an Edit (the Edit tool requires reading the file first).
"""

from __future__ import annotations

import sys
from pathlib import Path

# Stable substring of report_generator._NARRATIVE_PLACEHOLDER.
MARKER = "produced by the summarizer subagent"


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    report = Path(sys.argv[1])
    narrative = Path(sys.argv[2])
    lines = report.read_text(encoding="utf-8").splitlines(keepends=True)
    hits = [
        i for i, line in enumerate(lines)
        if line.lstrip().startswith(">") and MARKER in line
    ]
    if len(hits) != 1:
        print(
            f"error: expected exactly 1 placeholder line in {report}, "
            f"found {len(hits)} (already spliced?)",
            file=sys.stderr,
        )
        return 1
    body = narrative.read_text(encoding="utf-8").strip() + "\n"
    lines[hits[0]] = body
    report.write_text("".join(lines), encoding="utf-8")
    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
