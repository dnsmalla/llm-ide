"""Extract rate-limit profile definitions from extension/server/rate-limit.mjs.

Run from repo root:  python docs/_scripts/extract_rate_limit.py
Writes:               docs/reference/rate-limit-profiles.md

The source file defines profiles in two ways:

  const PROFILES = {
    // comment
    llm:  { capacity: 3, refillRate: 1 / 30 }, // inline note
    ...
  };

  PROFILES.authPublic = { capacity: 10, refillRate: 1 };

Both patterns are captured.  Notes come from the inline end-of-line comment
or the preceding block of // comment lines (whichever is available; inline
takes priority).  If neither exists, notes is left empty and the table cell
renders as "—".
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SOURCE_REL = Path("extension/server/rate-limit.mjs")
OUTPUT_REL = Path("docs/reference/rate-limit-profiles.md")

# Matches an object-literal entry inside the PROFILES block:
#   llm:        { capacity: 3, refillRate: 1 / 30 },  // optional note
#   llmFast:    { capacity: 6, refillRate: 1 / 5 },
ENTRY_RE = re.compile(
    r"""
    ^\s*
    (?P<name>[A-Za-z][A-Za-z0-9]*)   # profile name
    \s*:\s*\{
    [^}]*?
    capacity\s*:\s*(?P<capacity>\d+)
    [^}]*?
    refillRate\s*:\s*(?P<refill>[^},]+?)
    \s*\}
    (?:[^/\n]*)(?://\s*(?P<inline>.*))?  # optional inline comment
    """,
    re.VERBOSE,
)

# Matches a standalone assignment: PROFILES.name = { capacity: N, refillRate: X };
ASSIGN_RE = re.compile(
    r"""
    ^PROFILES\.(?P<name>[A-Za-z][A-Za-z0-9]*)\s*=\s*\{
    [^}]*?
    capacity\s*:\s*(?P<capacity>\d+)
    [^}]*?
    refillRate\s*:\s*(?P<refill>[^};]+?)
    \s*\}
    (?:[^/\n]*)(?://\s*(?P<inline>.*))?  # optional inline comment
    """,
    re.VERBOSE,
)

COMMENT_RE = re.compile(r"^\s*//\s?(.*)$")


def _preceding_comment(lines: list[str], idx: int) -> str:
    """Collect consecutive // comment lines immediately above line *idx*."""
    parts: list[str] = []
    j = idx - 1
    while j >= 0:
        m = COMMENT_RE.match(lines[j])
        if not m:
            break
        text = m.group(1).strip()
        if text:
            parts.insert(0, text)
        j -= 1
    return " ".join(parts)


def _refill_window(refill_raw: str) -> str:
    """Convert a raw refillRate expression to a human-readable window string.

    Examples:
      "1 / 30"  -> "30 s / token"
      "1 / 5"   -> "5 s / token"
      "5"       -> "0.2 s / token (5/s)"
      "1"       -> "1 s / token"
    """
    raw = refill_raw.strip()
    # Pattern: 1 / N  -> N seconds per token
    m = re.match(r"1\s*/\s*(\d+)", raw)
    if m:
        return f"{m.group(1)} s / token"
    # Plain integer or float rate (tokens per second)
    try:
        rate = float(raw)
        if rate >= 1:
            window = 1 / rate
            if window < 1:
                return f"{window:.2f} s / token ({raw}/s)"
            return f"{window:.0f} s / token"
        # fractional rate, unusual
        return f"{1/rate:.0f} s / token"
    except ValueError:
        return raw


def extract(path: Path) -> list[dict]:
    """Parse *path* and return a list of profile dicts sorted by name.

    Each dict has keys: name, capacity, refill_raw, refill_window, notes.
    """
    text = path.read_text()
    lines = text.splitlines()
    rows: list[dict] = []
    seen: set[str] = set()

    for i, line in enumerate(lines):
        for pattern in (ENTRY_RE, ASSIGN_RE):
            m = pattern.match(line)
            if not m:
                continue
            name = m.group("name")
            if name in seen:
                continue
            seen.add(name)

            refill_raw = m.group("refill").strip().rstrip(",")
            inline = (m.group("inline") or "").strip()
            preceding = _preceding_comment(lines, i)

            # Inline comment takes priority; fall back to preceding block.
            notes = inline if inline else preceding

            rows.append({
                "name": name,
                "capacity": int(m.group("capacity")),
                "refill_raw": refill_raw,
                "refill_window": _refill_window(refill_raw),
                "notes": notes,
            })
            break  # don't try second pattern once matched

    rows.sort(key=lambda r: r["name"])
    return rows


def render(rows: list[dict], source_rel: Path) -> str:
    lines = [
        "---",
        "title: Rate-limit profiles",
        f"source: {source_rel.as_posix()}",
        "---",
        "",
        f"<!-- generated from {source_rel.as_posix()} - do not edit by hand -->",
        "",
        "# Rate-limit profiles",
        "",
        "Token-bucket per `(profile, scope)`. Scope is `userId` for authenticated "
        "routes, the remote IP for unauthenticated ones. `429` responses include a "
        "`Retry-After` header.",
        "",
        "| Profile | Burst | Refill window | Notes |",
        "|---|---|---|---|",
    ]
    for r in rows:
        notes = r["notes"] if r["notes"] else "—"
        # Escape any pipes inside cells
        notes = notes.replace("|", "\\|")
        lines.append(
            f"| `{r['name']}` | {r['capacity']} | {r['refill_window']} | {notes} |"
        )
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
    print(f"wrote {output} ({len(rows)} profiles)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
