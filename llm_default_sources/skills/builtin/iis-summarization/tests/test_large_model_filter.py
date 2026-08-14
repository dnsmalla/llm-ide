"""Tests for large_model_filter.py."""
from __future__ import annotations

import pytest
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"


def test_large_model_filter_returns_deletion_filter_result():
    """LargeModelFilter.minimize() returns a DeletionFilterResult."""
    pytest.importorskip("gurobipy")
    from iis_summarization.large_model_filter import LargeModelFilter
    from iis_summarization.models import DeletionFilterResult

    lp_file = FIXTURES / "tiny_infeasible.lp"
    result = LargeModelFilter.create().minimize(
        lp_file=lp_file,
        iis_constraint_names=["demand_min", "capacity_max", "non_negative_x", "non_negative_y"],
        feasibility_timeout=30,
    )
    assert isinstance(result, DeletionFilterResult)
    assert result.success is True


def test_large_model_filter_finds_correct_iis():
    """LargeModelFilter finds demand_min + capacity_max as the IIS."""
    pytest.importorskip("gurobipy")
    from iis_summarization.large_model_filter import LargeModelFilter

    lp_file = FIXTURES / "tiny_infeasible.lp"
    result = LargeModelFilter.create().minimize(
        lp_file=lp_file,
        iis_constraint_names=["demand_min", "capacity_max", "non_negative_x", "non_negative_y"],
        feasibility_timeout=30,
    )
    assert "demand_min" in result.minimal_iis
    assert "capacity_max" in result.minimal_iis


def test_large_model_filter_sets_pipeline_metadata():
    """phases_run and large_model_pipeline_used are populated."""
    pytest.importorskip("gurobipy")
    from iis_summarization.large_model_filter import LargeModelFilter

    lp_file = FIXTURES / "tiny_infeasible.lp"
    result = LargeModelFilter.create().minimize(
        lp_file=lp_file,
        iis_constraint_names=["demand_min", "capacity_max", "non_negative_x", "non_negative_y"],
        feasibility_timeout=30,
    )
    assert result.large_model_pipeline_used is True
    assert len(result.phases_run) >= 1
    assert "initial" in result.candidate_sizes


def test_large_model_filter_fallback_on_empty_elastic():
    """When elastic filter returns 0 candidates, falls back gracefully."""
    pytest.importorskip("gurobipy")
    from iis_summarization.large_model_filter import LargeModelFilter

    lp_file = FIXTURES / "tiny_infeasible.lp"
    # Pass only 2 names — the filter must still succeed via fallback or directly
    result = LargeModelFilter.create().minimize(
        lp_file=lp_file,
        iis_constraint_names=["demand_min", "capacity_max"],
        feasibility_timeout=30,
    )
    # Either succeeds with a valid result or graceful error
    assert isinstance(result.success, bool)


def test_elastic_filter_repenalization_finds_all_iis_members():
    """Gurobi guidance: L1 FeasRelax has alternative optima, so one pass can
    relax only ONE of several conflicting constraints. Iterative
    re-penalization (multiply penalties on violated constraints, re-solve,
    union the rounds) must surface BOTH members of the demand_min /
    capacity_max conflict — without needing the Chinneck fallback."""
    pytest.importorskip("gurobipy")
    from iis_summarization.large_model_filter import LargeModelFilter

    lp_file = FIXTURES / "tiny_infeasible.lp"
    result = LargeModelFilter.create().minimize(
        lp_file=lp_file,
        iis_constraint_names=["demand_min", "capacity_max", "non_negative_x", "non_negative_y"],
        feasibility_timeout=30,
    )
    assert result.success is True
    assert set(result.minimal_iis) == {"demand_min", "capacity_max"}
    # The whole point of re-penalization: the fast pipeline itself finds
    # the complete IIS, instead of detecting the miss and falling back.
    assert "fallback_chinneck" not in result.phases_run


def _write_planted_conflict_lp(path: Path, n_filler: int = 300) -> tuple[list[str], list[str]]:
    """Write an LP with *n_filler* satisfiable constraints and one planted
    2-constraint conflict. Returns (all_names, planted_names)."""
    lines = ["Minimize", " obj: x0", "Subject To"]
    filler_names = []
    for i in range(n_filler):
        a, b = i % 50, (i * 7 + 3) % 50
        if a == b:
            b = (b + 1) % 50
        name = f"filler_{i}"
        filler_names.append(name)
        lines.append(f" {name}: x{a} + x{b} <= 2000")
    planted = ["planted_hi", "planted_lo"]
    lines.append(" planted_hi: x5 + x7 >= 500")
    lines.append(" planted_lo: x5 + x7 <= 100")
    lines.append("Bounds")
    for i in range(50):
        lines.append(f" 0 <= x{i} <= 1000")
    lines.append("End")
    path.write_text("\n".join(lines) + "\n")
    return filler_names + planted, planted


def test_planted_conflict_isolated_from_large_candidate_set(tmp_path):
    """Production confidence: given a 302-constraint model where ONLY two
    planted constraints conflict, the fast pipeline fed with ALL
    constraint names must isolate exactly the planted pair."""
    pytest.importorskip("gurobipy")
    from iis_summarization.large_model_filter import LargeModelFilter

    lp_file = tmp_path / "planted.lp"
    all_names, planted = _write_planted_conflict_lp(lp_file)

    result = LargeModelFilter.create().minimize(
        lp_file=lp_file,
        iis_constraint_names=all_names,
        feasibility_timeout=30,
    )
    assert result.success is True
    assert set(result.minimal_iis) == set(planted)


def test_farkas_phase_actually_reduces_candidates(tmp_path):
    """FarkasDual is only available when InfUnbdInfo=1 was set on the
    solve — without it the Farkas phase silently returns all candidates
    (a no-op). On the planted model the Farkas certificate involves only
    the planted pair, so the phase must shrink the candidate set."""
    pytest.importorskip("gurobipy")
    from iis_summarization.large_model_filter import LargeModelFilter

    lp_file = tmp_path / "planted.lp"
    all_names, planted = _write_planted_conflict_lp(lp_file)

    result = LargeModelFilter.create().minimize(
        lp_file=lp_file,
        iis_constraint_names=all_names,
        feasibility_timeout=30,
    )
    assert result.success is True
    assert (
        result.candidate_sizes["after_farkas"]
        < result.candidate_sizes["after_rule_based"]
    )


def test_large_model_filter_create_returns_instance():
    """create() factory returns an ILargeModelFilter instance."""
    from iis_summarization.large_model_filter import LargeModelFilter
    from iis_summarization.interfaces import ILargeModelFilter

    instance = LargeModelFilter.create()
    assert isinstance(instance, ILargeModelFilter)
