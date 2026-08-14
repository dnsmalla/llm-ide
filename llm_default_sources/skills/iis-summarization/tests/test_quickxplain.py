"""Tests for quickxplain.py — Junker divide-and-conquer IIS isolation."""
from __future__ import annotations

import pytest
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"


def test_quickxplain_finds_exact_iis():
    """QuickXplain on tiny_infeasible.lp must return demand_min + capacity_max."""
    pytest.importorskip("gurobipy")
    import gurobipy as gp
    from iis_summarization.quickxplain import QuickXplain

    lp_file = FIXTURES / "tiny_infeasible.lp"

    # The true IIS is demand_min + capacity_max (x+y>=10 and x+y<=5).
    candidates = ["demand_min", "capacity_max", "non_negative_x", "non_negative_y"]
    result = QuickXplain.find_iis(
        lp_file=lp_file,
        candidates=candidates,
        timeout=30,
        gp=gp,
        GRB=gp.GRB,
    )
    assert "demand_min" in result
    assert "capacity_max" in result
    # Result must be a subset of candidates
    assert all(n in candidates for n in result)


def test_quickxplain_single_element_infeasible(tmp_path):
    """When a single-element set is already infeasible, return it."""
    pytest.importorskip("gurobipy")
    import gurobipy as gp
    from iis_summarization.quickxplain import QuickXplain

    # Create a single-constraint infeasible LP: x >= 10, bounds 0 <= x <= 5
    lp_content = (
        "Minimize\n obj:\nSubject To\n c1: x >= 10\nBounds\n 0 <= x <= 5\nEnd\n"
    )
    lp_file = tmp_path / "single_infeasible.lp"
    lp_file.write_text(lp_content)

    result = QuickXplain.find_iis(
        lp_file=lp_file,
        candidates=["c1"],
        timeout=30,
        gp=gp,
        GRB=gp.GRB,
    )
    assert result == ["c1"]


def test_quickxplain_returns_empty_when_feasible():
    """When all candidates are removed model is feasible, return empty list."""
    pytest.importorskip("gurobipy")
    import gurobipy as gp
    from iis_summarization.quickxplain import QuickXplain

    lp_file = FIXTURES / "tiny_infeasible.lp"
    # Pass only non-conflicting candidates
    result = QuickXplain.find_iis(
        lp_file=lp_file,
        candidates=["non_negative_x"],  # feasible alone
        timeout=30,
        gp=gp,
        GRB=gp.GRB,
    )
    assert result == []
