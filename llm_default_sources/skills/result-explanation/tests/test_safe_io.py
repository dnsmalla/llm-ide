"""Unit tests for the encoding-safe, failure-tolerant I/O layer."""

from pathlib import Path

from openpyxl import Workbook

from result_explanation.safe_io import open_workbook, read_text_safe


def test_read_text_utf8(tmp_path: Path):
    p = tmp_path / "u.txt"
    p.write_text("発電量 = 123\n", encoding="utf-8")
    assert read_text_safe(p) == "発電量 = 123\n"


def test_read_text_cp932(tmp_path: Path):
    """A Shift-JIS / CP932 file (common on Japanese Windows) decodes, not crashes."""
    p = tmp_path / "s.txt"
    p.write_bytes("発電量 = 123\n".encode("cp932"))
    text = read_text_safe(p)
    assert text is not None
    assert "発電量" in text


def test_read_text_missing(tmp_path: Path):
    assert read_text_safe(tmp_path / "nope.txt") is None


def test_open_workbook_bad_file(tmp_path: Path):
    """A non-XLSX file yields None instead of raising."""
    bad = tmp_path / "not_a_workbook.xlsx"
    bad.write_text("this is not a zip/xlsx")
    with open_workbook(bad) as wb:
        assert wb is None


def test_open_workbook_missing(tmp_path: Path):
    with open_workbook(tmp_path / "ghost.xlsx") as wb:
        assert wb is None


def test_open_workbook_good(tmp_path: Path):
    wb_path = tmp_path / "ok.xlsx"
    wb = Workbook()
    wb.active.append(["a", 1])
    wb.save(wb_path)
    with open_workbook(wb_path) as got:
        assert got is not None
        assert got.worksheets[0]["A1"].value == "a"
