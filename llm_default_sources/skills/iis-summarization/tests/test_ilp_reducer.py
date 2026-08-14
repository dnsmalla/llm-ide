"""Tests for ilp_reducer.verify_subset_infeasible."""
from __future__ import annotations

from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


def test_verify_subset_infeasible_true_for_conflicting_pair():
    """demand_min + capacity_max alone are infeasible → True."""
    pytest.importorskip("gurobipy")
    from iis_summarization.ilp_reducer import verify_subset_infeasible

    lp_file = FIXTURES / "tiny_infeasible.lp"
    assert verify_subset_infeasible(
        lp_file, ["demand_min", "capacity_max"], timeout=30
    ) is True


def test_verify_subset_infeasible_false_for_single_constraint():
    """demand_min alone is satisfiable → False."""
    pytest.importorskip("gurobipy")
    from iis_summarization.ilp_reducer import verify_subset_infeasible

    lp_file = FIXTURES / "tiny_infeasible.lp"
    assert verify_subset_infeasible(lp_file, ["demand_min"], timeout=30) is False


def test_verify_subset_infeasible_false_for_empty_subset():
    """No constraints at all cannot prove infeasibility → False."""
    pytest.importorskip("gurobipy")
    from iis_summarization.ilp_reducer import verify_subset_infeasible

    lp_file = FIXTURES / "tiny_infeasible.lp"
    assert verify_subset_infeasible(lp_file, [], timeout=30) is False
