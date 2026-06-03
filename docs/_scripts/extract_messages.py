"""Extract the Chrome runtime message protocol from extension/src/lib/messages.ts.

Run from repo root:  python docs/_scripts/extract_messages.py
Writes:               docs/reference/message-protocol.md

Extraction approach: REGEX on the TypeScript source file.

The file has two relevant sections:

1. The `MsgType` enum — each member is either:
     a) preceded by a direction comment like `// Side panel → content script`
     b) a bare assignment:  MEMBER_NAME = 'MEMBER_NAME',

2. The `Message` discriminated union — each variant is one of:
     a) payload-less:   `| { type: MsgType.FOO }`
     b) with payload:   `| { type: MsgType.FOO; field: type; field2: type }`

Direction comments in the enum apply to all subsequent members until the
next direction comment or the end of the enum.  We map each MsgType member
to its direction string.

The `Message` union gives us the payload field names for each type.

We do NOT need Node or tsc because:
  - all enum values are plain string assignments (no computed values)
  - all union variants are inline interface literals (no mapped/conditional types)

Output columns: Type | Direction | Payload fields
Direction is derived from enum comments; it's present in the source.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SOURCE_REL = Path("extension/src/lib/messages.ts")
OUTPUT_REL = Path("docs/reference/message-protocol.md")

# ---- Enum extraction -------------------------------------------------------
# Matches a MsgType enum member:  SOME_NAME = 'SOME_NAME',
ENUM_MEMBER_RE = re.compile(
    r"^\s*(?P<name>[A-Z][A-Z0-9_]+)\s*=\s*['\"](?P<value>[A-Z][A-Z0-9_]*)['\"],?\s*$"
)

# Matches a direction comment inside the enum, e.g.:
#   // Side panel → content script
DIRECTION_COMMENT_RE = re.compile(r"^\s*//\s*(?P<dir>.+?)\s*$")


def _extract_enum_section(text: str) -> str:
    """Return the text between `export enum MsgType {` and its closing `}`."""
    start = text.find("export enum MsgType {")
    if start == -1:
        return ""
    depth = 0
    i = text.index("{", start)
    begin = i + 1
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[begin:i]
        i += 1
    return ""


def extract_enum_members(text: str) -> dict[str, str]:
    """Return {member_name: direction_label} for all MsgType members."""
    enum_body = _extract_enum_section(text)
    current_direction = ""
    result: dict[str, str] = {}
    for line in enum_body.splitlines():
        # Check for direction comment first
        cm = DIRECTION_COMMENT_RE.match(line)
        if cm:
            current_direction = cm.group("dir")
            continue
        mm = ENUM_MEMBER_RE.match(line)
        if mm:
            result[mm.group("name")] = current_direction
    return result


# ---- Union extraction ------------------------------------------------------
# Matches one variant line of the Message union:
#   | { type: MsgType.FOO }
#   | { type: MsgType.FOO; field1: string; field2: number }
VARIANT_RE = re.compile(
    r"^\s*\|\s*\{\s*type\s*:\s*MsgType\.(?P<name>[A-Z][A-Z0-9_]+)"
    r"(?P<rest>[^}]*)\}\s*;?\s*$",
    re.MULTILINE,
)

# Matches a payload field like `field: type` (stops at `;` or end)
FIELD_RE = re.compile(r";\s*(?P<field>[a-zA-Z_][a-zA-Z0-9_]*)\s*:")


def extract_union_variants(text: str) -> dict[str, list[str]]:
    """Return {member_name: [payload_field_names]} for each Message variant."""
    result: dict[str, list[str]] = {}
    for m in VARIANT_RE.finditer(text):
        name = m.group("name")
        rest = m.group("rest") or ""
        fields = FIELD_RE.findall(rest)
        result[name] = fields
    return result


# ---- Combined extraction ---------------------------------------------------

def extract(path: Path) -> list[dict]:
    """Parse *path* and return a list of message-type rows.

    Each dict has keys: name, direction, payload_fields.
    Rows are ordered as they appear in the MsgType enum.
    """
    text = path.read_text()
    enum_members = extract_enum_members(text)
    union_variants = extract_union_variants(text)

    rows: list[dict] = []
    for name, direction in enum_members.items():
        payload_fields = union_variants.get(name, [])
        rows.append({
            "name": name,
            "direction": direction,
            "payload_fields": payload_fields,
        })
    return rows


# ---- Renderer --------------------------------------------------------------

def render(rows: list[dict], source_rel: Path) -> str:
    lines = [
        "---",
        "title: Chrome runtime message protocol",
        f"source: {source_rel.as_posix()}",
        "---",
        "",
        f"<!-- generated from {source_rel.as_posix()} - do not edit by hand -->",
        "",
        "# Chrome runtime message protocol",
        "",
        "Messages flow between the content script, the service worker, the side panel, "
        "and the floating popup. All messages share the `Message` discriminated union "
        "and the `MsgType` enum.",
        "",
        "## Types",
        "",
        "| Type | Direction | Payload fields |",
        "|---|---|---|",
    ]
    for r in rows:
        name = r["name"]
        direction = r["direction"] if r["direction"] else "-"
        fields = r["payload_fields"]
        payload = ", ".join(f"`{f}`" for f in fields) if fields else "-"
        # Escape pipes inside cells
        direction = direction.replace("|", "\\|")
        lines.append(f"| `{name}` | {direction} | {payload} |")
    lines.append("")
    return "\n".join(lines)


# ---- Entry point -----------------------------------------------------------

def main() -> int:
    root = Path(__file__).resolve().parents[2]
    source = root / SOURCE_REL
    output = root / OUTPUT_REL

    if not source.exists():
        print(f"error: source not found: {source}", file=sys.stderr)
        return 1

    rows = extract(source)
    if len(rows) == 0:
        print("error: extracted zero message types — check regex against source",
              file=sys.stderr)
        return 1

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render(rows, SOURCE_REL))
    print(f"wrote {output} ({len(rows)} message types)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
