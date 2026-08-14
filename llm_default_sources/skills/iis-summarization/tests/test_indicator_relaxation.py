"""
test_indicator_relaxation.py
────────────────────────────
Tests for the indicator-constraint slack-injection remediation
(Gurobi-recommended pattern: feasRelax cannot relax general
constraints, so inject an explicit minimized slack into the
triggered linear part instead).

Fixture ``indicator_infeasible.lp``:
    fix_b: b = 1
    ind:   b = 1 -> x >= 10
    cap:   x <= 5
With cap holding, x can reach at most 5, so the indicator's linear
part needs a slack of 5 — the minimum data change on `ind` alone is
RHS 10 -> 5.
"""

from __future__ import annotations

from pathlib import Path

from _helpers import requires_gurobi

from iis_summarization.indicator_relaxation import compute_indicator_relaxations

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


@requires_gurobi
class TestIndicatorSlackInjection:
    def test_minimum_delta_computed_for_indicator(self) -> None:
        result = compute_indicator_relaxations(
            lp_file=FIXTURES / "indicator_infeasible.lp",
            gen_constr_names=["ind"],
            timeout=15,
        )
        assert result.success is True
        assert len(result.constraint_relaxations) == 1
        r = result.constraint_relaxations[0]
        assert r.constraint_name == "ind"
        assert r.violation == 5.0 or abs(r.violation - 5.0) < 1e-4
        assert r.direction.startswith("decrease")
        assert r.suggested_new_rhs == 5.0 or abs(r.suggested_new_rhs - 5.0) < 1e-4

    def test_fix_is_verified(self) -> None:
        """Applying the suggested indicator RHS change to a copy must
        restore feasibility (certified, like the linear remediation)."""
        result = compute_indicator_relaxations(
            lp_file=FIXTURES / "indicator_infeasible.lp",
            gen_constr_names=["ind"],
            timeout=15,
        )
        assert result.success is True
        assert result.fix_verified is True

    def test_unknown_name_is_graceful(self) -> None:
        result = compute_indicator_relaxations(
            lp_file=FIXTURES / "indicator_infeasible.lp",
            gen_constr_names=["does_not_exist"],
            timeout=15,
        )
        # No matching indicator: nothing to relax, not an error.
        assert result.success is True
        assert result.constraint_relaxations == []
