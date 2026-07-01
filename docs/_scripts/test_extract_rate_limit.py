"""Tests for the rate-limit profiles extractor."""
from pathlib import Path

import pytest

from extract_rate_limit import extract, render


SOURCE_REL = Path("extension/server/rate-limit.mjs")


def write(tmp_path: Path, name: str, body: str) -> Path:
    p = tmp_path / name
    p.write_text(body)
    return p


FIXTURE_SRC = """\
const PROFILES = {
  // Cheap LLM jobs — chat, questions.
  llmFast:    { capacity: 6, refillRate: 1 / 5 },  // ~1 every 5s, burst 6

  // Big LLM jobs — plan, code, analyze.
  llm:        { capacity: 3, refillRate: 1 / 30 }, // ~1 every 30s, burst 3

  // External-API write paths.
  dispatch:   { capacity: 4, refillRate: 1 / 10 }, // ~1 every 10s, burst 4
};

// Shared bucket for login + refresh — keyed by remote IP.
PROFILES.authPublic = { capacity: 10, refillRate: 1 };
"""


def test_extract_finds_all_profiles(tmp_path: Path) -> None:
    f = write(tmp_path, "rate-limit.mjs", FIXTURE_SRC)
    rows = extract(f)
    names = {r["name"] for r in rows}
    assert names == {"llm", "llmFast", "dispatch", "authPublic"}


def test_extract_capacity_and_refill(tmp_path: Path) -> None:
    f = write(tmp_path, "rate-limit.mjs", FIXTURE_SRC)
    rows = extract(f)
    by_name = {r["name"]: r for r in rows}
    assert by_name["llm"]["capacity"] == 3
    assert by_name["llm"]["refill_raw"] == "1 / 30"
    assert by_name["dispatch"]["capacity"] == 4
    assert by_name["authPublic"]["capacity"] == 10
    assert by_name["authPublic"]["refill_raw"] == "1"


def test_sorted_alphabetically(tmp_path: Path) -> None:
    f = write(tmp_path, "rate-limit.mjs", FIXTURE_SRC)
    rows = extract(f)
    names = [r["name"] for r in rows]
    assert names == sorted(names)


def test_inline_comment_captured_as_note(tmp_path: Path) -> None:
    src = "const PROFILES = {\n  llm: { capacity: 3, refillRate: 1 / 30 }, // ~1 every 30s, burst 3\n};\n"
    f = write(tmp_path, "rate-limit.mjs", src)
    rows = extract(f)
    assert len(rows) == 1
    # Inline comment after the profile line
    assert "30s" in rows[0]["notes"] or rows[0]["notes"] != ""


def test_preceding_comment_captured_as_note(tmp_path: Path) -> None:
    src = "const PROFILES = {\n  // Big LLM jobs.\n  llm: { capacity: 3, refillRate: 1 / 30 },\n};\n"
    f = write(tmp_path, "rate-limit.mjs", src)
    rows = extract(f)
    assert "Big LLM" in rows[0]["notes"]


def test_no_comment_yields_dash(tmp_path: Path) -> None:
    src = "const PROFILES = {\n  myProfile: { capacity: 5, refillRate: 2 },\n};\n"
    f = write(tmp_path, "rate-limit.mjs", src)
    rows = extract(f)
    assert rows[0]["notes"] == ""


def test_render_starts_with_generated_marker(tmp_path: Path) -> None:
    f = write(tmp_path, "rate-limit.mjs", FIXTURE_SRC)
    rows = extract(f)
    output = render(rows, SOURCE_REL)
    assert "<!-- generated from" in output
    assert "do not edit by hand" in output


def test_render_has_frontmatter(tmp_path: Path) -> None:
    f = write(tmp_path, "rate-limit.mjs", FIXTURE_SRC)
    rows = extract(f)
    output = render(rows, SOURCE_REL)
    assert output.startswith("---\n")
    assert "title: Rate-limit profiles" in output
    assert f"source: {SOURCE_REL.as_posix()}" in output


def test_render_table_has_all_profiles(tmp_path: Path) -> None:
    f = write(tmp_path, "rate-limit.mjs", FIXTURE_SRC)
    rows = extract(f)
    output = render(rows, SOURCE_REL)
    for name in ("llm", "llmFast", "dispatch", "authPublic"):
        assert f"`{name}`" in output


def test_real_source_extracts_all_profiles() -> None:
    """Integration test against the actual source file."""
    real_src = Path(__file__).resolve().parents[2] / "extension/server/rate-limit.mjs"
    if not real_src.exists():
        pytest.skip("real source not found")
    rows = extract(real_src)
    # 7 in PROFILES block + 2 appended (authPublic, authRegister) = 9
    assert len(rows) == 9
    names = {r["name"] for r in rows}
    assert "llm" in names
    assert "llmFast" in names
    assert "dispatch" in names
    assert "outcomePoll" in names
    assert "kbWrite" in names
    assert "liveAppend" in names
    assert "kbExport" in names
    assert "authPublic" in names
    assert "authRegister" in names
