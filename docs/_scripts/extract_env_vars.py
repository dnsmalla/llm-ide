"""Extract env var definitions from extension/server/config.mjs.

Run from repo root:  python docs/_scripts/extract_env_vars.py
Writes:               docs/reference/env-vars.md

The source file uses three helper functions:
  envStr(name[, fallback])
  envInt(name[, fallback])
  envBool(name[, fallback])

The fallback argument is optional (MEETNOTES_JWT_SECRET / MEETNOTES_VAULT_KEY
are called with no fallback).  When present it may be a literal (string,
number, boolean) or an arbitrary JS expression (e.g. `15 * 60`, `isProd`).
The extractor preserves the raw fallback text rather than evaluating it.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SOURCE_REL = Path("extension/core/config.mjs")
OUTPUT_REL = Path("docs/reference/env-vars.md")

# Matches:  envStr('NAME', optional-default)
#           envStr('NAME')          <- no fallback
# The default capture is greedy up to the closing ')' but we stop at
# unbalanced ')' by matching any char that isn't ')'.  For complex defaults
# like `15 * 60` or `path.join(...)` this would fail on nested parens, but
# the actual source file has no nested-paren defaults, so the simple pattern
# is sufficient.
CALL_RE = re.compile(
    r"env(?P<kind>Str|Int|Bool)\(\s*['\"](?P<name>[A-Z][A-Z0-9_]*)['\"]"
    r"(?:\s*,\s*(?P<default>[^)]*?))?\s*\)"
)
COMMENT_RE = re.compile(r"^\s*//\s?(.*)$")


def _raw_default(raw: str | None) -> str:
    """Normalise the raw default token: strip outer quotes for string literals,
    otherwise return the expression as-is (arithmetic, variable, empty)."""
    if raw is None:
        return ""
    raw = raw.strip()
    # Strip surrounding single or double quotes for plain string literals.
    if len(raw) >= 2 and raw[0] in ("'", '"') and raw[-1] == raw[0]:
        return raw[1:-1]
    return raw


def extract(path: Path) -> list[dict]:
    """Parse *path* and return a list of env-var dicts sorted by name.

    Each dict has keys: name, type, default, description.
    """
    text = path.read_text()
    lines = text.splitlines()
    rows: list[dict] = []
    seen: set[str] = set()

    for i, line in enumerate(lines):
        m = CALL_RE.search(line)
        if not m:
            continue
        name = m.group("name")
        if name in seen:
            # e.g. NODE_ENV appears twice; keep first occurrence.
            continue
        seen.add(name)

        # Walk back collecting consecutive comment lines just above.
        desc_lines: list[str] = []
        j = i - 1
        while j >= 0:
            cm = COMMENT_RE.match(lines[j])
            if not cm:
                break
            desc_lines.insert(0, cm.group(1).strip())
            j -= 1

        kind_map = {"Str": "str", "Int": "int", "Bool": "bool"}
        rows.append({
            "name": name,
            "type": kind_map[m.group("kind")],
            "default": _raw_default(m.group("default")),
            "description": " ".join(d for d in desc_lines if d),
        })

    rows.sort(key=lambda r: r["name"])
    return rows


def render(rows: list[dict], source_rel: Path) -> str:
    lines = [
        "---",
        "title: Environment variables",
        f"source: {source_rel.as_posix()}",
        "---",
        "",
        f"<!-- generated from {source_rel.as_posix()} - do not edit by hand -->",
        "",
        "# Environment variables",
        "",
        f"All `process.env` reads in `{source_rel.as_posix()}`.",
        "",
        "| Name | Type | Default | Description |",
        "|---|---|---|---|",
    ]
    for r in rows:
        default = r["default"] if r["default"] != "" else "-"
        desc = r["description"] if r["description"] else "-"
        # Escape pipe characters in cells.
        default = default.replace("|", "\\|")
        desc = desc.replace("|", "\\|")
        lines.append(f"| `{r['name']}` | {r['type']} | `{default}` | {desc} |")
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
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render(rows, SOURCE_REL))
    print(f"wrote {output} ({len(rows)} variables)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
