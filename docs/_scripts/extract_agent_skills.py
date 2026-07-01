"""Extract agent skill catalog from extension/llm_agent/**/*.md frontmatter.

Run from repo root:  python docs/_scripts/extract_agent_skills.py
Writes:               docs/reference/agent-skills.md

A file is a skill if its YAML frontmatter has both a ``name`` and a ``kind``
field.  Prompt files, context files, _base.md, and README.md all lack one or
both fields and are silently skipped.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

SOURCE_GLOB = "extension/llm_agent/**/*.md"
OUTPUT_REL = Path("docs/reference/agent-skills.md")

# Match the leading YAML frontmatter block between --- fences.
_FM_RE = re.compile(r"^---\n([\s\S]*?)\n^---\s*\n", re.MULTILINE)


def parse_skill(text: str, relpath: str) -> dict | None:
    """Parse YAML frontmatter from *text* and return a skill dict, or None.

    A file qualifies as a skill only if its frontmatter contains both
    ``name`` and ``kind`` keys.  Files missing either field (prompts,
    context snippets, _base.md, etc.) are excluded.

    Args:
        text:    Full markdown content of the file.
        relpath: Relative path used as the ``path`` value in the result.

    Returns:
        ``{"name", "kind", "description", "path"}`` or ``None``.
    """
    m = _FM_RE.match(text)
    if not m:
        return None
    try:
        fm = yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return None
    if not fm or not isinstance(fm, dict):
        return None
    name = fm.get("name")
    kind = fm.get("kind")
    if not name or not kind:
        return None
    return {
        "name": name,
        "kind": kind,
        "description": fm.get("description", "") or "",
        "path": relpath,
    }


def discover(root: Path | None = None) -> list[dict]:
    """Walk ``extension/llm_agent/`` and return all skill dicts sorted by name.

    Args:
        root: Repo root directory.  Defaults to the repo root inferred from
              this file's location (two levels above ``docs/_scripts/``).

    Returns:
        List of skill dicts (see :func:`parse_skill`), sorted by ``name``.
    """
    if root is None:
        root = Path(__file__).resolve().parents[2]
    base = root / "extension" / "llm_agent"
    skills: list[dict] = []
    for path in sorted(base.rglob("*.md")):
        # Skip node_modules or hidden/cache directories if ever present.
        parts = path.parts
        if any(p in ("node_modules", ".code-notes") for p in parts):
            continue
        relpath = path.relative_to(root).as_posix()
        text = path.read_text(encoding="utf-8")
        skill = parse_skill(text, relpath)
        if skill is not None:
            skills.append(skill)
    skills.sort(key=lambda s: s["name"])
    return skills


def render(skills: list[dict]) -> str:
    lines = [
        "---",
        "title: Agent skills",
        f"source: {SOURCE_GLOB}",
        "---",
        "",
        f"<!-- generated from {SOURCE_GLOB} — do not edit by hand -->",
        "",
        "# Agent skills",
        "",
        "Every skill available to the Code Assistant and internal agent.",
        "A skill is a Markdown file under `extension/llm_agent/` whose",
        "frontmatter declares both `name` and `kind`.",
        "",
        "| Name | Kind | Description | File |",
        "|---|---|---|---|",
    ]
    for s in skills:
        desc = (s["description"] or "").replace("|", "\\|")
        name = s["name"].replace("|", "\\|")
        kind = s["kind"].replace("|", "\\|")
        path = s["path"].replace("|", "\\|")
        lines.append(f"| `{name}` | `{kind}` | {desc} | `{path}` |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    output = root / OUTPUT_REL

    skills = discover(root)
    if not skills:
        print("error: no skills found — check SOURCE_GLOB", file=sys.stderr)
        return 1

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render(skills), encoding="utf-8")
    print(f"wrote {output} ({len(skills)} skills)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
