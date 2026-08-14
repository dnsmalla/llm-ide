"""
test_classifier.py
──────────────────
Tests for iis_summarization.classifier. Also covers the private
``_decide`` helper without requiring Gurobi.
"""

from __future__ import annotations

from pathlib import Path

from _helpers import requires_gurobi

from iis_summarization.classifier import Classifier, _decide, classify_iis_constraints

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


class TestDecide:
    """Pure-Python tests for the _decide logic."""

    def test_leq_unreachable_is_data(self) -> None:
        # sum(x) <= 5 but lhs_min = 10
        ptype, _ = _decide(sense="<=", rhs=5.0, lhs_min=10.0, lhs_max=20.0)
        assert ptype == "data"

    def test_leq_reachable_is_structure(self) -> None:
        ptype, _ = _decide(sense="<=", rhs=5.0, lhs_min=0.0, lhs_max=10.0)
        assert ptype == "structure"

    def test_geq_unreachable_is_data(self) -> None:
        ptype, _ = _decide(sense=">=", rhs=100.0, lhs_min=0.0, lhs_max=10.0)
        assert ptype == "data"

    def test_geq_reachable_is_structure(self) -> None:
        ptype, _ = _decide(sense=">=", rhs=5.0, lhs_min=0.0, lhs_max=10.0)
        assert ptype == "structure"

    def test_equality_outside_range_is_data(self) -> None:
        ptype, _ = _decide(sense="=", rhs=50.0, lhs_min=0.0, lhs_max=10.0)
        assert ptype == "data"

    def test_equality_inside_range_is_structure(self) -> None:
        ptype, _ = _decide(sense="=", rhs=5.0, lhs_min=0.0, lhs_max=10.0)
        assert ptype == "structure"

    def test_unrecognized_sense_is_unknown(self) -> None:
        ptype, _ = _decide(sense="??", rhs=0.0, lhs_min=0.0, lhs_max=0.0)
        assert ptype == "unknown"


@requires_gurobi
class TestClassifyLPFile:
    def test_tiny_both_structure(self) -> None:
        result = classify_iis_constraints(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            iis_constraint_names=["demand_min", "capacity_max"],
        )
        assert result.success is True
        # For x, y in [0, 100]: both constraints are reachable in isolation.
        for c in result.classifications:
            assert c.problem_type == "structure"

    def test_factory_interface(self) -> None:
        clf = Classifier.create()
        result = clf.classify(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            iis_constraint_names=["demand_min"],
        )
        assert result.success is True


@requires_gurobi
class TestSharedModel:
    def test_classify_accepts_preloaded_model(self) -> None:
        """classify(model=...) reuses the shared model and must not dispose it."""
        import gurobipy as gp

        shared = gp.read(str(FIXTURES / "tiny_infeasible.lp"))
        try:
            clf = Classifier.create()
            result = clf.classify(
                lp_file=FIXTURES / "tiny_infeasible.lp",
                iis_constraint_names=["demand_min", "capacity_max"],
                model=shared,
            )
            assert result.success is True
            assert {c.constraint_name for c in result.classifications} == {
                "demand_min",
                "capacity_max",
            }
            # The shared model must still be usable after classify().
            assert shared.NumConstrs == 4
        finally:
            shared.dispose()
