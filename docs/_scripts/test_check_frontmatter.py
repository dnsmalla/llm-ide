"""Tests for the frontmatter checker."""
from pathlib import Path

import pytest

from check_frontmatter import (
    check_file,
    REQUIRED_KEYS,
    DocType,
    classify,
)


def write(tmp_path: Path, rel: str, body: str) -> Path:
    p = tmp_path / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body)
    return p


def test_classify_by_top_folder(tmp_path: Path) -> None:
    p = write(tmp_path, "docs/tutorials/foo.md", "")
    assert classify(p, tmp_path / "docs") == DocType.TUTORIAL


def test_classify_unknown_returns_none(tmp_path: Path) -> None:
    p = write(tmp_path, "docs/random/foo.md", "")
    assert classify(p, tmp_path / "docs") is None


def test_check_passes_with_required_keys(tmp_path: Path) -> None:
    p = write(
        tmp_path,
        "docs/tutorials/foo.md",
        "---\ntitle: T\naudience: A\ntime: 5 minutes\n---\n# T\n",
    )
    errors = check_file(p, tmp_path / "docs", stubs=set())
    assert errors == []


def test_check_fails_when_required_key_missing(tmp_path: Path) -> None:
    p = write(
        tmp_path,
        "docs/tutorials/foo.md",
        "---\ntitle: T\n---\n# T\n",
    )
    errors = check_file(p, tmp_path / "docs", stubs=set())
    assert any("audience" in e for e in errors)
    assert any("time" in e for e in errors)


def test_check_fails_when_frontmatter_missing(tmp_path: Path) -> None:
    p = write(tmp_path, "docs/tutorials/foo.md", "# No frontmatter\n")
    errors = check_file(p, tmp_path / "docs", stubs=set())
    assert any("frontmatter" in e.lower() for e in errors)


def test_unresolved_todo_fails_for_non_stub(tmp_path: Path) -> None:
    p = write(
        tmp_path,
        "docs/how-to/foo.md",
        "---\ntitle: T\napplies_to: server\n---\n\nTODO: write this\n",
    )
    errors = check_file(p, tmp_path / "docs", stubs=set())
    assert any("TODO" in e for e in errors)


def test_unresolved_todo_allowed_for_stub(tmp_path: Path) -> None:
    p = write(
        tmp_path,
        "docs/how-to/foo.md",
        "---\ntitle: T\napplies_to: server\n---\n\nTODO: write this\n",
    )
    errors = check_file(p, tmp_path / "docs", stubs={"how-to/foo.md"})
    assert errors == []


def test_required_keys_cover_every_doctype() -> None:
    for t in DocType:
        assert t in REQUIRED_KEYS, f"missing REQUIRED_KEYS for {t}"
