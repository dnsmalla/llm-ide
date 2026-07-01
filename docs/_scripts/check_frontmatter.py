"""Lint frontmatter completeness and unresolved TODOs across docs/.

Exits non-zero if any error is found. The set of intentionally-incomplete
pages is read from `docs/_stubs.txt` (one path per line, relative to docs/).
"""
from __future__ import annotations

import enum
import re
import sys
from pathlib import Path
from typing import Iterable

import yaml


class DocType(enum.Enum):
    TUTORIAL = "tutorial"
    HOW_TO = "how-to"
    REFERENCE = "reference"
    EXPLANATION = "explanation"
    ADR = "adr"


REQUIRED_KEYS: dict[DocType, set[str]] = {
    DocType.TUTORIAL: {"title", "audience", "time"},
    DocType.HOW_TO: {"title", "applies_to"},
    DocType.REFERENCE: {"title"},
    DocType.EXPLANATION: {"title", "status"},
    DocType.ADR: {"title", "status", "date"},
}

FOLDER_TO_TYPE: dict[str, DocType] = {
    "tutorials": DocType.TUTORIAL,
    "how-to": DocType.HOW_TO,
    "reference": DocType.REFERENCE,
    "explanation": DocType.EXPLANATION,
    "decisions": DocType.ADR,
}

FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
TODO_RE = re.compile(r"\bTODO\b|\bTBD\b")


def classify(path: Path, docs_root: Path) -> DocType | None:
    try:
        rel = path.relative_to(docs_root)
    except ValueError:
        return None
    if not rel.parts:
        return None
    top = rel.parts[0]
    return FOLDER_TO_TYPE.get(top)


def _parse_frontmatter(text: str) -> dict | None:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return None
    try:
        data = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        return None
    return data if isinstance(data, dict) else None


def check_file(path: Path, docs_root: Path, stubs: set[str]) -> list[str]:
    errors: list[str] = []
    doc_type = classify(path, docs_root)
    if doc_type is None:
        return errors  # not in a managed folder

    text = path.read_text()
    fm = _parse_frontmatter(text)
    rel = str(path.relative_to(docs_root))

    if fm is None:
        errors.append(f"{rel}: missing or unparseable frontmatter")
        return errors

    required = REQUIRED_KEYS[doc_type]
    missing = sorted(required - fm.keys())
    for key in missing:
        errors.append(f"{rel}: missing required frontmatter key '{key}'")

    if rel not in stubs and TODO_RE.search(text):
        errors.append(
            f"{rel}: contains TODO/TBD but is not in docs/_stubs.txt"
        )

    return errors


def iter_markdown(docs_root: Path) -> Iterable[Path]:
    excluded = {"_templates", "_scripts", "superpowers"}
    for path in docs_root.rglob("*.md"):
        if any(part in excluded for part in path.relative_to(docs_root).parts):
            continue
        yield path


def main(argv: list[str]) -> int:
    docs_root = Path(argv[1]) if len(argv) > 1 else Path("docs")
    docs_root = docs_root.resolve()

    stubs_file = docs_root / "_stubs.txt"
    stubs: set[str] = set()
    if stubs_file.exists():
        for line in stubs_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                stubs.add(line)

    all_errors: list[str] = []
    for path in iter_markdown(docs_root):
        all_errors.extend(check_file(path, docs_root, stubs))

    for err in all_errors:
        print(err, file=sys.stderr)
    return 1 if all_errors else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
