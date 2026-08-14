"""Tests for farkas_filter.py — unit tests using the tiny_infeasible fixture."""
from __future__ import annotations

import pytest
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"


def test_extract_farkas_candidates_returns_subset(tmp_path):
    """Farkas filter on tiny_infeasible.lp must return a subset of IIS names."""
    pytest.importorskip("gurobipy")
    from iis_summarization.farkas_filter import extract_farkas_candidates
    import gurobipy as gp

    lp_file = FIXTURES / "tiny_infeasible.lp"
    model = gp.read(str(lp_file))
    model.setParam("OutputFlag", 0)
    model.optimize()

    iis_names = ["demand_min", "capacity_max", "non_negative_x", "non_negative_y"]
    result = extract_farkas_candidates(model, iis_names)
    model.dispose()

    assert isinstance(result, list)
    assert len(result) >= 1
    assert all(n in iis_names for n in result)


def test_extract_farkas_candidates_fallback_when_no_duals(tmp_path):
    """If FarkasDual is unavailable, returns all names unchanged."""
    from iis_summarization.farkas_filter import extract_farkas_candidates

    class FakeModel:
        def getConstrs(self):
            return [_FakeConstr("c1"), _FakeConstr("c2")]

    class _FakeConstr:
        def __init__(self, name):
            self.ConstrName = name
        @property
        def FarkasDual(self):
            raise AttributeError("not available")

    names = ["c1", "c2", "c3"]
    result = extract_farkas_candidates(FakeModel(), names, tolerance=1e-8)
    assert result == names  # fallback: return all


def test_extract_farkas_candidates_filters_zero_duals():
    """Constraints with |FarkasDual| <= tolerance are dropped."""
    from iis_summarization.farkas_filter import extract_farkas_candidates

    class _FakeConstr:
        def __init__(self, name, dual):
            self.ConstrName = name
            self.FarkasDual = dual

    class FakeModel:
        def getConstrs(self):
            return [
                _FakeConstr("keep_pos", 0.5),
                _FakeConstr("keep_neg", -0.3),
                _FakeConstr("drop_zero", 0.0),
                _FakeConstr("drop_tiny", 1e-10),
                _FakeConstr("not_in_iis", 99.0),  # not in iis_names
            ]

    names = ["keep_pos", "keep_neg", "drop_zero", "drop_tiny"]
    result = extract_farkas_candidates(FakeModel(), names, tolerance=1e-8)
    assert "keep_pos" in result
    assert "keep_neg" in result
    assert "drop_zero" not in result
    assert "drop_tiny" not in result
    assert "not_in_iis" not in result
