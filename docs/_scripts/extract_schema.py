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
# Detect DROP TABLE so staging tables can be excluded.
DROP_RE = re.compile(
    r"DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?P<name>\w+)\s*;",
    re.IGNORECASE,
)
# Detect ALTER TABLE ... RENAME TO (used after staging-table swaps).
RENAME_RE = re.compile(
    r"ALTER\s+TABLE\s+(?P<old>\w+)\s+RENAME\s+TO\s+(?P<new>\w+)\s*;",
    re.IGNORECASE,
)
# CREATE VIRTUAL TABLE [IF NOT EXISTS] <name> USING <module>(<body>);
VIRTUAL_RE = re.compile(
    r"CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<name>\w+)\s+"
    r"USING\s+(?P<module>\w+)\s*\((?P<body>.*?)\)\s*;",
    re.IGNORECASE | re.DOTALL,
)
# CREATE TRIGGER [IF NOT EXISTS] <name> <timing> <event> ON <table> BEGIN ... END;
TRIGGER_RE = re.compile(
    r"CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<trg_name>\w+)"
    r"\s+(?P<timing>BEFORE|AFTER|INSTEAD\s+OF)"
    r"\s+(?P<event>INSERT|UPDATE|DELETE)"
    r"\s+ON\s+(?P<table>\w+)\s+BEGIN"
    r"(?P<body>.*?)"
    r"END\s*;",
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


def _parse_index_cols(text: str, start: int) -> tuple[str, int]:
    """Parse a balanced-paren column list starting at text[start] (which must be '(').
    Returns (cols_content, end_pos) where end_pos is the position after the closing ')'.
    """
    assert text[start] == "("
    depth = 0
    buf: list[str] = []
    i = start
    while i < len(text):
        ch = text[i]
        if ch == "(":
            depth += 1
            if depth > 1:
                buf.append(ch)
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return "".join(buf), i + 1
            else:
                buf.append(ch)
        else:
            buf.append(ch)
        i += 1
    return "".join(buf), len(text)


# Matches up to the ON <table>( portion; column list and WHERE clause parsed separately.
INDEX_HEADER_RE = re.compile(
    r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<idx_name>\w+)"
    r"\s+ON\s+(?P<table>\w+)\s*(?P<rest_start>\()",
    re.IGNORECASE | re.DOTALL,
)


def extract_tables(files: list[Path]) -> list[dict]:
    tables: dict[str, dict] = {}
    for f in sorted(files):
        text = _strip_sql_comments(f.read_text())
        # Collect all relevant statements with their positions and process in order.
        events: list[tuple[int, str, re.Match]] = []
        for m in CREATE_RE.finditer(text):
            events.append((m.start(), "create", m))
        for m in ALTER_RE.finditer(text):
            events.append((m.start(), "alter", m))
        for m in DROP_RE.finditer(text):
            events.append((m.start(), "drop", m))
        for m in RENAME_RE.finditer(text):
            events.append((m.start(), "rename", m))
        events.sort(key=lambda e: e[0])

        for _pos, kind, m in events:
            if kind == "create":
                tname = m.group("name")
                body = m.group("body")
                # Skip FTS5 virtual tables — not real columns.
                if re.search(r"\bUSING\b", body, re.IGNORECASE):
                    continue
                tables[tname] = {
                    "name": tname,
                    "columns": _parse_columns(body),
                    "source": f.name,
                }
            elif kind == "alter":
                t = tables.get(m.group("name"))
                if not t:
                    continue
                col_def = " ".join(m.group("col").split())
                parts = col_def.split(None, 1)
                col_name = parts[0].strip('"`')
                col_rest = parts[1].strip() if len(parts) > 1 else ""
                # Skip if this column is already present (idempotent ALTER re-runs).
                if any(c["name"] == col_name for c in t["columns"]):
                    continue
                t["columns"].append({
                    "name": col_name,
                    "type_and_constraints": col_rest,
                })
            elif kind == "drop":
                tables.pop(m.group("name"), None)
            elif kind == "rename":
                old, new = m.group("old"), m.group("new")
                if old in tables:
                    entry = tables.pop(old)
                    entry["name"] = new
                    # Update source to the file that did the rename (reflects final state).
                    entry["source"] = f.name
                    tables[new] = entry
    return list(tables.values())


def extract_indexes(files: list[Path]) -> list[dict]:
    """Return the final set of indexes (last-write-wins by name, reflecting migration order)."""
    indexes: dict[str, dict] = {}
    for f in sorted(files):
        raw_text = f.read_text()
        text = _strip_sql_comments(raw_text)
        for m in INDEX_HEADER_RE.finditer(text):
            idx_name = m.group("idx_name")
            table = m.group("table")
            paren_start = m.end() - 1  # position of the '('
            cols_raw, after_paren = _parse_index_cols(text, paren_start)
            cols = " ".join(cols_raw.split())
            # Everything after the closing ')' up to ';' may include WHERE clause.
            rest = text[after_paren:]
            semi_pos = rest.find(";")
            after_cols = rest[:semi_pos].strip() if semi_pos != -1 else rest.strip()
            # Normalise whitespace in the trailing clause.
            after_cols = " ".join(after_cols.split())
            indexes[idx_name] = {
                "name": idx_name,
                "table": table,
                "cols": cols,
                "where": after_cols,
                "source": f.name,
            }
    return list(indexes.values())


def extract_virtual_tables(files: list[Path]) -> list[dict]:
    """Return FTS5 (and other) virtual tables from migrations."""
    vtables: dict[str, dict] = {}
    for f in sorted(files):
        text = _strip_sql_comments(f.read_text())
        for m in VIRTUAL_RE.finditer(text):
            vname = m.group("name")
            module = m.group("module")
            body = " ".join(m.group("body").split())
            vtables[vname] = {
                "name": vname,
                "module": module,
                "body": body,
                "source": f.name,
            }
    return list(vtables.values())


def extract_triggers(files: list[Path]) -> list[dict]:
    """Return the final set of triggers (last-write-wins by name)."""
    triggers: dict[str, dict] = {}
    for f in sorted(files):
        text = _strip_sql_comments(f.read_text())
        for m in TRIGGER_RE.finditer(text):
            trg_name = m.group("trg_name")
            body = " ".join(m.group("body").split())
            triggers[trg_name] = {
                "name": trg_name,
                "timing": m.group("timing").upper(),
                "event": m.group("event").upper(),
                "table": m.group("table"),
                "body": body,
                "source": f.name,
            }
    return list(triggers.values())


def render(
    tables: list[dict],
    indexes: list[dict],
    vtables: list[dict],
    triggers: list[dict],
    source_rel: Path,
) -> str:
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

    # ── Tables ──────────────────────────────────────────────────────────────
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

    # ── Full-text search (FTS5 virtual tables) ───────────────────────────────
    if vtables:
        out.append("## Full-text search")
        out.append("")
        out.append(
            "FTS5 virtual tables power keyword search. They are maintained by "
            "triggers (see below) and are not directly writable by application code."
        )
        out.append("")
        for vt in sorted(vtables, key=lambda x: x["name"]):
            out.append(f"### `{vt['name']}` (USING {vt['module']})")
            out.append("")
            out.append(f"_From `{vt['source']}`._")
            out.append("")
            out.append("```sql")
            out.append(
                f"CREATE VIRTUAL TABLE {vt['name']} USING {vt['module']}({vt['body']});"
            )
            out.append("```")
            out.append("")

    # ── Indexes ──────────────────────────────────────────────────────────────
    if indexes:
        out.append("## Indexes")
        out.append("")
        out.append("| Index | Table | Columns | WHERE clause | Source |")
        out.append("|---|---|---|---|---|")
        for idx in sorted(indexes, key=lambda x: (x["table"], x["name"])):
            where = idx["where"] if idx["where"] else ""
            source = idx["source"]
            out.append(
                f"| `{idx['name']}` | `{idx['table']}` | `{idx['cols']}` | {where} | `{source}` |"
            )
        out.append("")

    # ── Triggers ─────────────────────────────────────────────────────────────
    if triggers:
        out.append("## Triggers")
        out.append("")
        out.append(
            "All triggers keep the `search` FTS5 table in sync with their owning tables."
        )
        out.append("")
        out.append("| Trigger | Timing | Event | Table | Source |")
        out.append("|---|---|---|---|---|")
        for trg in sorted(triggers, key=lambda x: (x["table"], x["name"])):
            out.append(
                f"| `{trg['name']}` | {trg['timing']} | {trg['event']} "
                f"| `{trg['table']}` | `{trg['source']}` |"
            )
        out.append("")

    return "\n".join(out)


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    files = sorted((root / MIGRATIONS_REL).glob("*.sql"))
    tables = extract_tables(files)
    indexes = extract_indexes(files)
    vtables = extract_virtual_tables(files)
    triggers = extract_triggers(files)
    out = root / OUTPUT_REL
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(tables, indexes, vtables, triggers, MIGRATIONS_REL))
    print(
        f"wrote {out} "
        f"({len(tables)} tables, {len(indexes)} indexes, "
        f"{len(vtables)} virtual tables, {len(triggers)} triggers)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
