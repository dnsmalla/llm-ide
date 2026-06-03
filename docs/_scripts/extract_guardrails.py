"""Extract guardrail rules from extension/guardrails/rules.mjs.

Run from repo root:  python docs/_scripts/extract_guardrails.py
Writes:               docs/reference/guardrail-rules.md

Extraction approach: REGEX on the source file.

The source file uses a pure-data pattern with per-category pattern arrays
(SECRET_PATTERNS, PII_PATTERNS, DESTRUCTIVE_PATTERNS) plus check() factory
calls inside checkDispatch() / checkCodegenApply().  The document-worthy
"rules" are the check() invocations, each of which has:
  - severity: first arg ('blocking' | 'warning' | 'info')
  - ruleId:   second arg (e.g. 'dispatch.secret', 'codegen.path-escape')
  - message:  third arg (a string literal or template literal)

Because ruleId encodes the category (prefix before the dot), we can derive
category from the ruleId.  The canonical categories and their display order
are: dispatch, codegen, guardrail.  Anything else falls under "Other".

The regex is applied to the raw .mjs text — no Node shellout required
because there are no dynamically computed rule IDs.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SOURCE_REL = Path("extension/guardrails/rules.mjs")
OUTPUT_REL = Path("docs/reference/guardrail-rules.md")

# Matches:  check('blocking', 'dispatch.secret', 'some message...')
# or multi-line:  check('warning', 'codegen.bulk',\n  `Bulk ... ${items.length} ...`)
#
# Captures:
#   severity  — first string arg
#   rule_id   — second string arg
#   message   — third arg, which may be:
#               • a plain string literal: '...' or "..."
#               • a template literal: `...`  (possibly containing ${...})
#
# Strategy: match the opening of the call, then capture the message arg
# up to the next unescaped closing delimiter.  Template literals with
# ${...} expressions are captured as-is and cleaned up later.

_CHECK_OPEN_RE = re.compile(
    r"check\(\s*"
    r"['\"](?P<severity>blocking|warning|info)['\"]\s*,\s*"
    r"['\"](?P<rule_id>[A-Za-z0-9._-]+)['\"]\s*,\s*",
    re.MULTILINE,
)


def _extract_string_arg(text: str, pos: int) -> str:
    """Extract a string/template-literal argument starting at *pos* in *text*.

    Returns the content between the opening and closing delimiter, with any
    ${...} expressions replaced by a short placeholder so the rendered message
    stays readable.
    """
    if pos >= len(text):
        return ""
    delim = text[pos]
    if delim not in ("'", '"', "`"):
        return ""
    end_delim = delim
    i = pos + 1
    buf: list[str] = []
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            # escaped char — include the literal character
            buf.append(text[i + 1])
            i += 2
            continue
        if delim == "`" and ch == "$" and i + 1 < len(text) and text[i + 1] == "{":
            # Template expression — skip to matching '}'
            depth = 1
            i += 2
            buf.append("…")
            while i < len(text) and depth > 0:
                if text[i] == "{":
                    depth += 1
                elif text[i] == "}":
                    depth -= 1
                i += 1
            continue
        if ch == end_delim:
            break
        buf.append(ch)
        i += 1
    return "".join(buf).strip()


def extract(path: Path) -> list[dict]:
    """Parse *path* and return a list of rule dicts.

    Each dict has keys: rule_id, severity, category, message.
    Rules with the same rule_id are deduplicated (first occurrence kept).
    Results are sorted by category then rule_id.
    """
    text = path.read_text()
    rows: list[dict] = []
    seen: set[str] = set()

    for m in _CHECK_OPEN_RE.finditer(text):
        rule_id = m.group("rule_id")
        # Skip the function definition line itself
        # (check() is defined as:  function check(severity, ruleId, ...)
        # so ruleId won't match the pattern — no special case needed)

        # Dedup: for dispatch.creds there are three identical IDs with
        # different messages; keep only the first one.
        if rule_id in seen:
            continue
        seen.add(rule_id)

        severity = m.group("severity")
        msg_start = m.end()
        message = _extract_string_arg(text, msg_start)
        if not message:
            continue

        # Category is the prefix before the first dot
        category = rule_id.split(".")[0] if "." in rule_id else "other"

        rows.append({
            "rule_id": rule_id,
            "severity": severity,
            "category": category,
            "message": message,
        })

    # Sort: by category order then rule_id
    category_order = {"dispatch": 0, "codegen": 1, "guardrail": 2}
    rows.sort(key=lambda r: (
        category_order.get(r["category"], 99),
        r["rule_id"],
    ))
    return rows


# Human-readable category titles
_CATEGORY_TITLES: dict[str, str] = {
    "dispatch": "Dispatch",
    "codegen": "Codegen apply",
    "guardrail": "Guardrail engine",
}

# Severity descriptions for preamble
_SEVERITY_DESC = (
    "Severities: `blocking` rejects the action; "
    "`warning` requires explicit override; "
    "`info` annotates only."
)


def render(rows: list[dict], source_rel: Path) -> str:
    from itertools import groupby

    lines = [
        "---",
        "title: Guardrail rules",
        f"source: {source_rel.as_posix()}",
        "---",
        "",
        f"<!-- generated from {source_rel.as_posix()} - do not edit by hand -->",
        "",
        "# Guardrail rules",
        "",
        f"Rules are evaluated at submit AND at approval. {_SEVERITY_DESC}",
        "",
    ]

    # Group by category
    for category, group_iter in groupby(rows, key=lambda r: r["category"]):
        group = list(group_iter)
        title = _CATEGORY_TITLES.get(category, category.capitalize())
        lines += [
            f"## {title}",
            "",
            "| ID | Severity | Message |",
            "|---|---|---|",
        ]
        for r in group:
            msg = r["message"].replace("|", "\\|")
            lines.append(f"| `{r['rule_id']}` | `{r['severity']}` | {msg} |")
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
    if len(rows) <= 1:
        print(
            f"error: extracted only {len(rows)} rule(s) — check regex against source",
            file=sys.stderr,
        )
        return 1

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render(rows, SOURCE_REL))
    print(f"wrote {output} ({len(rows)} rules)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
