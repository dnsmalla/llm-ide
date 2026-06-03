"""Extract the SQLite schema from extension/kb/migrations/*.sql.

Run from repo root:  python docs/_scripts/extract_schema.py
Writes:               docs/reference/database-schema.md
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

MIGRATIONS_REL = Path("extension/kb/migrations")
OUTPUT_REL = Path("docs/reference/database-schema.md")

CREATE_RE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<name>\w+)\s*\((?P<body>.*?)\)\s*;",
    re.IGNORECASE | re.DOTALL,
)
ALTER_RE = re.compile(
    r"ALTER\s+TABLE\s+(?P<name>\w+)\s+ADD\s+COLUMN\s+(?P<col>.*?);",
    re.IGNORECASE | re.DOTALL,
)
CONSTRAINT_KEYWORDS = ("PRIMARY KEY", "FOREIGN KEY", "UNIQUE", "CHECK", "CONSTRAINT")


def _strip_sql_comments(text: str) -> str:
    """Remove -- line comments from SQL text, preserving line count."""
    result = []
    for line in text.splitlines(keepends=True):
        # Remove everything from -- onward (ignoring -- inside string literals
        # is unnecessary here — migration files don't have string literals
        # containing --).
        cleaned = re.sub(r"--.*", "", line)
        result.append(cleaned)
    return "".join(result)


def _parse_columns(body: str) -> list[dict]:
    cols: list[dict] = []
    depth = 0
    cur: list[str] = []
    items: list[str] = []
    for ch in body:
        if ch == "(":
            depth += 1
            cur.append(ch)
        elif ch == ")":
            depth -= 1
            cur.append(ch)
        elif ch == "," and depth == 0:
            items.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if cur:
        items.append("".join(cur).strip())
    for item in items:
        # Normalise whitespace (multi-line column defs).
        item = " ".join(item.split())
        if not item:
            continue
        upper = item.upper()
        if any(upper.lstrip().startswith(k) for k in CONSTRAINT_KEYWORDS):
            continue
        parts = item.split(None, 1)
        if not parts:
            continue
        name = parts[0].strip('"`')
        rest = parts[1] if len(parts) > 1 else ""
        cols.append({"name": name, "type_and_constraints": rest.strip()})
    return cols


def extract_tables(files: list[Path]) -> list[dict]:
    tables: dict[str, dict] = {}
    for f in sorted(files):
        text = _strip_sql_comments(f.read_text())
        for m in CREATE_RE.finditer(text):
            tname = m.group("name")
            # Skip FTS5 virtual tables and triggers — not real columns.
            # A simple heuristic: if the body contains UNINDEXED or USING fts5
            # it is a virtual table.
            body = m.group("body")
            if re.search(r"\bUSING\b", body, re.IGNORECASE):
                continue
            tables[tname] = {
                "name": tname,
                "columns": _parse_columns(body),
                "source": f.name,
            }
        for m in ALTER_RE.finditer(text):
            t = tables.get(m.group("name"))
            if not t:
                continue
            col_def = " ".join(m.group("col").split())
            parts = col_def.split(None, 1)
            t["columns"].append({
                "name": parts[0].strip('"`'),
                "type_and_constraints": parts[1].strip() if len(parts) > 1 else "",
            })
    return list(tables.values())


def render(tables: list[dict], source_rel: Path) -> str:
    out = [
        "---",
        "title: Database schema",
        f"source: {source_rel.as_posix()}/*.sql",
        "---",
        "",
        f"<!-- generated from {source_rel.as_posix()}/*.sql - do not edit by hand -->",
        "",
        "# Database schema",
        "",
        f"SQLite, WAL + FTS5. Source: `{source_rel.as_posix()}/*.sql`.",
        "",
    ]
    for t in sorted(tables, key=lambda x: x["name"]):
        out.append(f"## `{t['name']}`")
        out.append("")
        out.append(f"_From `{t['source']}`._")
        out.append("")
        out.append("| Column | Type / constraints |")
        out.append("|---|---|")
        for c in t["columns"]:
            type_str = c["type_and_constraints"].replace("|", "\\|").replace("\n", " ")
            out.append(f"| `{c['name']}` | {type_str} |")
        out.append("")
    return "\n".join(out)


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    files = sorted((root / MIGRATIONS_REL).glob("*.sql"))
    tables = extract_tables(files)
    out = root / OUTPUT_REL
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(tables, MIGRATIONS_REL))
    print(f"wrote {out} ({len(tables)} tables)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
