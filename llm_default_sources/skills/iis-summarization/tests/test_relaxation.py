"""
test_relaxation.py
──────────────────
End-to-end tests for iis_summarization.relaxation. Requires Gurobi.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from _helpers import requires_gurobi

from iis_summarization.relaxation import Relaxer, compute_relaxations

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


@requires_gurobi
class TestComputeRelaxations:
    def test_tiny_requires_five_unit_relaxation(self) -> None:
        # tiny_infeasible.lp: x+y >= 10 AND x+y <= 5 → need Δ of 5 on either side.
        result = compute_relaxations(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            constraint_names=["demand_min", "capacity_max"],
            timeout=15,
        )
        assert result.success is True
        # Minimum total L1 violation is exactly 5.
        assert result.total_violation == pytest.approx(5.0, abs=1e-4)
        assert len(result.constraint_relaxations) >= 1

    def test_relaxation_contains_suggested_new_rhs(self) -> None:
        result = compute_relaxations(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            constraint_names=["demand_min", "capacity_max"],
            timeout=15,
        )
        assert result.success is True
        for r in result.constraint_relaxations:
            assert isinstance(r.suggested_new_rhs, float)
            assert r.violation > 0.0

    def test_factory_interface(self) -> None:
        relaxer = Relaxer.create()
        result = relaxer.compute(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            constraint_names=None,
            timeout=15,
        )
        assert result.success is True

    def test_fix_is_verified_against_a_model_copy(self) -> None:
        """Production guarantee: the suggested RHS/bound changes are
        applied to a fresh copy of the model and re-solved — fix_verified
        certifies that the recommendation actually restores feasibility."""
        result = compute_relaxations(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            constraint_names=["demand_min", "capacity_max"],
            timeout=15,
        )
        assert result.success is True
        assert result.fix_verified is True

    def test_equality_direction_follows_documented_artp_convention(
        self, tmp_path: Path
    ) -> None:
        """Gurobi docs: ArtP > 0 means the RHS must DECREASE by that
        amount (LHS cannot reach the RHS from below); ArtN > 0 means
        increase. For x + y = 10 with x, y <= 3 the only fix is
        RHS -> 6 — an inverted convention would suggest 14 and fail
        verification."""
        lp = tmp_path / "eq_unreachable.lp"
        lp.write_text(
            "Minimize\n obj: x\nSubject To\n sum_eq: x + y = 10\n"
            "Bounds\n 0 <= x <= 3\n 0 <= y <= 3\nEnd\n"
        )
        result = compute_relaxations(
            lp_file=lp, constraint_names=["sum_eq"], timeout=15
        )
        assert result.success is True
        assert len(result.constraint_relaxations) == 1
        r = result.constraint_relaxations[0]
        assert r.violation == pytest.approx(4.0, abs=1e-4)
        assert r.direction.startswith("decrease")
        assert r.suggested_new_rhs == pytest.approx(6.0, abs=1e-4)
        assert result.fix_verified is True

    def test_bound_relaxation_reports_original_bounds(self, tmp_path: Path) -> None:
        """feasRelax replaces relaxable bounds with artificial variables,
        so v.LB/v.UB read AFTER the call show ±inf. The report must show
        the ORIGINAL bounds (captured before feasRelax)."""
        lp = tmp_path / "eq_unreachable.lp"
        lp.write_text(
            "Minimize\n obj: x\nSubject To\n sum_eq: x + y = 10\n"
            "Bounds\n 0 <= x <= 3\n 0 <= y <= 3\nEnd\n"
        )
        result = compute_relaxations(
            lp_file=lp,
            # Target a name that matches nothing so sum_eq is hard
            # (GRB.INFINITY) and only the bounds can move.
            constraint_names=["nonexistent"],
            bound_variable_names=["x", "y"],
            timeout=15,
        )
        assert result.success is True
        assert result.variable_bound_relaxations
        for br in result.variable_bound_relaxations:
            assert br.current_ub == pytest.approx(3.0)
            assert br.current_lb == pytest.approx(0.0)

    def test_multiobjective_model_relaxes_safely(self, tmp_path: Path) -> None:
        """feasRelax raises 'Multi-objective problem and minrelax != 0'
        unless the objectives are discarded first. Per Gurobi's
        documented pattern, NumObj=0 turns the model into a pure
        feasibility problem and is safe in all versions."""
        import gurobipy as gp

        m = gp.Model()
        m.setParam("OutputFlag", 0)
        x = m.addVar(ub=100, name="x")
        y = m.addVar(ub=100, name="y")
        m.addConstr(x + y >= 10, "demand_min")
        m.addConstr(x + y <= 5, "capacity_max")
        m.setObjectiveN(x, 0, priority=1)
        m.setObjectiveN(y, 1, priority=0)
        lp = tmp_path / "multiobj.lp"
        m.write(str(lp))
        m.dispose()

        result = compute_relaxations(
            lp_file=lp,
            constraint_names=["demand_min", "capacity_max"],
            timeout=15,
        )
        assert result.success is True
        assert result.total_violation == pytest.approx(5.0, abs=1e-4)
        assert result.fix_verified is True

    def test_range_slack_bound_relaxation_flags_range_widening(
        self, tmp_path: Path
    ) -> None:
        """When feasRelax loosens the UB of an internal range slack
        (Rg<name>), the result must say it WIDENS the ranged constraint
        rather than presenting a fix on a variable the user never made."""
        import gurobipy as gp

        m = gp.Model()
        m.setParam("OutputFlag", 0)
        x = m.addVar(ub=100, name="x")
        m.addRange(x, 20, 30, "range_c")
        m.addConstr(x <= 5, "cap")
        lp = tmp_path / "ranged.lp"
        m.write(str(lp))
        m.dispose()

        result = compute_relaxations(
            lp_file=lp,
            constraint_names=["nonexistent"],  # constraints held hard
            bound_variable_names=["Rgrange_c"],
            timeout=15,
        )
        assert result.success is True
        assert result.variable_bound_relaxations
        br = result.variable_bound_relaxations[0]
        assert br.variable_name == "Rgrange_c"
        assert br.range_of == "range_c"
        assert result.fix_verified is True

    def test_fix_verified_for_integer_infeasible_mip(self) -> None:
        """The verification must hold integrality too: for the
        integer-only-infeasible MIP the suggested relaxation must make
        the INTEGER model feasible, not just its LP relaxation."""
        result = compute_relaxations(
            lp_file=FIXTURES / "integer_infeasible.lp",
            constraint_names=["half"],
            timeout=15,
        )
        assert result.success is True
        assert result.fix_verified is True
