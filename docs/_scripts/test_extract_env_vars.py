"""Tests for the env-vars extractor."""
from pathlib import Path

import pytest

from extract_env_vars import extract


def write(tmp_path: Path, name: str, body: str) -> Path:
    p = tmp_path / name
    p.write_text(body)
    return p


def test_extract_finds_known_envs(tmp_path: Path) -> None:
    src = write(
        tmp_path,
        "config.mjs",
        """
        // PORT - the listen port
        const PORT = envInt('PORT', 3456);
        // MEETNOTES_JWT_SECRET - signs access + refresh tokens.
        const JWT = envStr('MEETNOTES_JWT_SECRET', 'devsecret');
        const FLAG = envBool('MEETNOTES_LOG_JSON', false);
        """,
    )
    rows = extract(src)
    names = {r["name"] for r in rows}
    assert names == {"PORT", "MEETNOTES_JWT_SECRET", "MEETNOTES_LOG_JSON"}
    by_name = {r["name"]: r for r in rows}
    assert by_name["PORT"]["type"] == "int"
    assert by_name["PORT"]["default"] == "3456"
    assert by_name["MEETNOTES_LOG_JSON"]["type"] == "bool"


def test_comment_block_attached_to_call(tmp_path: Path) -> None:
    src = write(
        tmp_path,
        "config.mjs",
        """
        // First line of description.
        // Second line.
        const X = envStr('FOO', 'bar');
        """,
    )
    rows = extract(src)
    assert len(rows) == 1
    desc = rows[0]["description"]
    assert "First line" in desc
    assert "Second line" in desc


def test_no_comment_block_yields_empty_description(tmp_path: Path) -> None:
    src = write(tmp_path, "config.mjs", "const X = envInt('Y', 7);\n")
    rows = extract(src)
    assert rows == [{"name": "Y", "type": "int", "default": "7", "description": ""}]


def test_no_fallback_argument(tmp_path: Path) -> None:
    """envStr('NAME') with no second arg should still be extracted."""
    src = write(tmp_path, "config.mjs", "let x = envStr('MEETNOTES_JWT_SECRET');\n")
    rows = extract(src)
    assert len(rows) == 1
    assert rows[0]["name"] == "MEETNOTES_JWT_SECRET"
    assert rows[0]["default"] == ""


def test_arithmetic_default_preserved(tmp_path: Path) -> None:
    """Arithmetic defaults like '15 * 60' are kept as-is."""
    src = write(
        tmp_path,
        "config.mjs",
        "const X = envInt('MEETNOTES_ACCESS_TTL_SEC', 15 * 60);\n",
    )
    rows = extract(src)
    assert rows[0]["default"] == "15 * 60"


def test_expression_default_preserved(tmp_path: Path) -> None:
    """Variable/expression defaults like 'isProd' are kept as-is."""
    src = write(
        tmp_path,
        "config.mjs",
        "const X = envBool('MEETNOTES_LOG_JSON', isProd);\n",
    )
    rows = extract(src)
    assert rows[0]["default"] == "isProd"


def test_sorted_by_name(tmp_path: Path) -> None:
    src = write(
        tmp_path,
        "config.mjs",
        """
        const Z = envStr('ZZZ', 'z');
        const A = envStr('AAA', 'a');
        """,
    )
    rows = extract(src)
    assert [r["name"] for r in rows] == ["AAA", "ZZZ"]
