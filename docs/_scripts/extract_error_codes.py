"""Extract error codes from extension/server/errors.mjs.

Run from repo root:  python docs/_scripts/extract_error_codes.py
Writes:               docs/reference/error-codes.md

The source uses factory-function exports (Pattern C):

    // Comment describing the error
    export const errAuth = (msg = 'Authentication required') =>
      new AppError('AUTH_REQUIRED', msg, { status: 401 });

This extractor matches every `export const err...` block, grabs the
AppError code string and HTTP status, and collects any leading // comment
lines as the description.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SOURCE_REL = Path("extension/core/errors.mjs")
OUTPUT_REL = Path("docs/reference/error-codes.md")

# Matches the start of an error factory export.
FACTORY_RE = re.compile(r"^export\s+const\s+err\w+\s*=", re.MULTILINE)

# Matches new AppError('CODE', ..., { status: NNN })
# The code must be ALL_CAPS with underscores.
APPERROR_RE = re.compile(
    r"new\s+AppError\(\s*['\"](?P<code>[A-Z][A-Z0-9_]+)['\"]"
    r".*?status\s*:\s*(?P<status>\d+)",
    re.DOTALL,
)

COMMENT_RE = re.compile(r"^\s*//\s?(.*)$")


def extract(path: Path) -> list[dict]:
    """Parse *path* and return error-code rows sorted by code name.

    Each dict has keys: code, status, description.
    """
    text = path.read_text()
    lines = text.splitlines()
    rows: list[dict] = []
    seen: set[str] = set()

    for i, line in enumerate(lines):
        if not FACTORY_RE.match(line):
            continue

        # Collect the factory body: from this line until the next blank line
        # or the next export statement, but no more than 10 lines ahead.
        body_lines = []
        for j in range(i, min(i + 10, len(lines))):
            body_lines.append(lines[j])
            if j > i and (lines[j].strip() == "" or lines[j].startswith("export")):
                break
        body = "\n".join(body_lines)

        m = APPERROR_RE.search(body)
        if not m:
            continue
        code = m.group("code")
        if code in seen:
            continue
        seen.add(code)

        status = int(m.group("status"))

        # Walk back collecting consecutive comment lines just above.
        desc_lines: list[str] = []
        j = i - 1
        while j >= 0:
            cm = COMMENT_RE.match(lines[j])
            if not cm:
                break
            desc_lines.insert(0, cm.group(1).strip())
            j -= 1

        rows.append({
            "code": code,
            "status": status,
            "description": " ".join(d for d in desc_lines if d),
        })

    rows.sort(key=lambda r: r["code"])
    return rows


def render(rows: list[dict], source_rel: Path) -> str:
    lines = [
        "---",
        "title: Error codes",
        f"source: {source_rel.as_posix()}",
        "---",
        "",
        f"<!-- generated from {source_rel.as_posix()} - do not edit by hand -->",
        "",
        "# Error codes",
        "",
        "Every error response uses the envelope `{ error: { code, message, details } }`.",
        "",
        "| Code | HTTP status | Description |",
        "|---|---|---|",
    ]
    for r in rows:
        desc = r["description"] if r["description"] else "-"
        desc = desc.replace("|", "\\|")
        lines.append(f"| `{r['code']}` | {r['status']} | {desc} |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    source = root / SOURCE_REL
    output = root / OUTPUT_REL

    if not source.exists():
        print(f"error: source not found: {source}", file=sys.stderr)
        return 1

    rows = extract(source)
    if not rows:
        print("error: extracted zero codes — check regex against source", file=sys.stderr)
        return 1

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render(rows, SOURCE_REL))
    print(f"wrote {output} ({len(rows)} codes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
