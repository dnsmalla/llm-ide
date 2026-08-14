"""Unit tests for value→input-cell provenance tracing."""

from pathlib import Path

from openpyxl import Workbook

from result_explanation import provenance


def _wb(tmp_path: Path) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "容量"  # Japanese sheet name
    ws.append(["設備", "最大出力"])  # Japanese headers
    ws.append(["新冠", 123.5])
    p = tmp_path / "in.xlsx"
    wb.save(p)
    return p


def test_provenance_passes_japanese_labels_through(tmp_path: Path):
    """Japanese sheet/row/column labels are reported verbatim, not dropped."""
    idx = provenance.build_value_index([_wb(tmp_path)])
    hit = provenance.trace(123.5, idx)
    assert hit["found"]
    cell = hit["cells"][0]
    assert cell["sheet"] == "容量"
    assert cell["row_label"] == "新冠"
    assert cell["col_header"] == "最大出力"
    assert cell["cell"] == "B2"


def test_provenance_skips_common_values(tmp_path: Path):
    wb = Workbook()
    ws = wb.active
    ws.append(["x", 1])
    ws.append(["y", 0])
    p = tmp_path / "c.xlsx"
    wb.save(p)
    idx = provenance.build_value_index([p])
    assert not provenance.trace(1.0, idx)["found"]
    assert not provenance.trace(0.0, idx)["found"]


def test_provenance_value_not_found(tmp_path: Path):
    idx = provenance.build_value_index([_wb(tmp_path)])
    assert provenance.trace(999.9, idx) == {"found": False, "cells": []}
