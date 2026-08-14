"""
test_iis_runner.py
──────────────────
Tests for iis_summarization.iis_runner — Step 1 of the pipeline,
including the Gurobi-recommended practices:

* IIS attribute capture (IISConstr / IISLB / IISUB / IISMinimal)
* default-LB=0 flagging
* tuning knobs (IISMethod / NumericFocus)
* LP-relaxation-first routing for MIP models
* numerical-recovery retry classification
"""

from __future__ import annotations

from pathlib import Path

from _helpers import requires_gurobi

from iis_summarization.iis_runner import run_iis

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


@requires_gurobi
class TestBasicRun:
    def test_tiny_lp_produces_ilp(self, tmp_path: Path) -> None:
        result = run_iis(FIXTURES / "tiny_infeasible.lp", output_dir=tmp_path)
        assert result.success is True
        assert result.ilp_file is not None and result.ilp_file.exists()

    def test_feasible_model_is_rejected(self, tmp_path: Path) -> None:
        # integer_infeasible.lp IS infeasible; use a trivially feasible
        # model written on the fly instead.
        lp = tmp_path / "feasible.lp"
        lp.write_text(
            "Minimize\n obj: x\nSubject To\n c: x >= 1\nBounds\n"
            " 0 <= x <= 2\nEnd\n"
        )
        result = run_iis(lp, output_dir=tmp_path)
        assert result.success is False
        assert "FEASIBLE" in result.error_message


@requires_gurobi
class TestIISAttributeCapture:
    def test_iis_constraints_populated(self, tmp_path: Path) -> None:
        """After computeIIS, the IISConstr attribute is queried per constraint."""
        result = run_iis(FIXTURES / "tiny_infeasible.lp", output_dir=tmp_path)
        assert result.success is True
        names = {c.name for c in result.iis_constraints}
        assert names == {"demand_min", "capacity_max"}

    def test_iis_minimality_flag_set(self, tmp_path: Path) -> None:
        result = run_iis(FIXTURES / "tiny_infeasible.lp", output_dir=tmp_path)
        assert result.iis_is_minimal in (True, False)


@requires_gurobi
class TestTuningKnobs:
    def test_iis_method_and_numeric_focus_accepted(self, tmp_path: Path) -> None:
        """Gurobi Strategy 2: IISMethod / NumericFocus are tunable."""
        result = run_iis(
            FIXTURES / "tiny_infeasible.lp",
            output_dir=tmp_path,
            iis_method=1,
            numeric_focus=2,
        )
        assert result.success is True
        assert result.ilp_file is not None and result.ilp_file.exists()

    def test_threads_accepted(self, tmp_path: Path) -> None:
        """Per Gurobi: the IIS outer loop is sequential, but Threads
        speeds up the individual subproblem solves on large models."""
        result = run_iis(
            FIXTURES / "tiny_infeasible.lp",
            output_dir=tmp_path,
            threads=2,
        )
        assert result.success is True
        assert result.ilp_file is not None and result.ilp_file.exists()

    def test_iis_target_early_exit_accepted(self, tmp_path: Path) -> None:
        """Callback-based early exit: terminate computeIIS once the
        IIS_CONSTRMAX upper bound drops to the target. The partial
        result is guaranteed infeasible (per Gurobi) and the downstream
        reduction minimizes it."""
        result = run_iis(
            FIXTURES / "scheduling_infeasible.lp",
            output_dir=tmp_path,
            iis_target=50,
        )
        assert result.success is True
        assert result.ilp_file is not None and result.ilp_file.exists()
        assert result.iis_constraints  # something was captured


@requires_gurobi
class TestMIPRouting:
    def test_mip_with_infeasible_relaxation_uses_lp_path(self, tmp_path: Path) -> None:
        """Gurobi Strategy 4: when the LP relaxation of a MIP is already
        infeasible, compute the IIS on the relaxation (much faster)."""
        result = run_iis(FIXTURES / "tiny_infeasible_mip.lp", output_dir=tmp_path)
        assert result.success is True
        assert result.used_lp_relaxation is True
        names = {c.name for c in result.iis_constraints}
        assert names == {"demand_min", "capacity_max"}

    def test_integer_only_infeasibility_falls_back_to_mip_iis(
        self, tmp_path: Path
    ) -> None:
        """When the LP relaxation is feasible, the infeasibility comes from
        integrality — the IIS must be computed on the original MIP."""
        result = run_iis(FIXTURES / "integer_infeasible.lp", output_dir=tmp_path)
        assert result.success is True
        assert result.used_lp_relaxation is False
        assert result.ilp_file is not None and result.ilp_file.exists()


@requires_gurobi
class TestNonlinearCoverage:
    def test_indicator_infeasibility_is_reported(self, tmp_path: Path) -> None:
        """feasRelax silently ignores quadratic/SOS/general constraints
        (documented Gurobi limitation) — so when the IIS involves one,
        the runner must flag it explicitly instead of letting the
        remediation step under-report."""
        result = run_iis(FIXTURES / "indicator_infeasible.lp", output_dir=tmp_path)
        assert result.success is True
        assert result.has_nonlinear_constraints is True
        assert any("ind" in m for m in result.nonlinear_iis_members)

    def test_pure_linear_model_not_flagged(self, tmp_path: Path) -> None:
        result = run_iis(FIXTURES / "tiny_infeasible.lp", output_dir=tmp_path)
        assert result.success is True
        assert result.has_nonlinear_constraints is False
        assert result.nonlinear_iis_members == []

    def test_non_indicator_general_constraint_labeled_general(
        self, tmp_path: Path
    ) -> None:
        """All general-constraint types share IISGenConstr, but only
        indicators get slack-injection remediation — a MAX constraint
        must be labeled 'general:', never 'indicator:' (and per Gurobi,
        function-approximation members have UNRELIABLE IIS membership)."""
        import gurobipy as gp

        m = gp.Model()
        m.setParam("OutputFlag", 0)
        x1 = m.addVar(lb=5, ub=10, name="x1")
        x2 = m.addVar(lb=0, ub=10, name="x2")
        y = m.addVar(lb=0, ub=100, name="y")
        m.addGenConstrMax(y, [x1, x2], name="maxc")
        m.addConstr(y <= 1, "cap_y")
        lp = tmp_path / "max_gc.lp"
        m.write(str(lp))
        m.dispose()

        result = run_iis(lp, output_dir=tmp_path)
        assert result.success is True
        gen_members = [m_ for m_ in result.nonlinear_iis_members if "maxc" in m_]
        assert gen_members, "max constraint expected in IIS members"
        assert gen_members[0].startswith("general:")


@requires_gurobi
class TestNumericsScreen:
    def test_extreme_coefficient_range_flagged(self, tmp_path: Path) -> None:
        """Gurobi guidance: matrix coefficient ratio beyond 1e9 means
        IIS membership may be numerically unreliable — warn proactively."""
        result = run_iis(FIXTURES / "badscale_infeasible.lp", output_dir=tmp_path)
        assert result.success is True
        assert result.numerics_warnings
        assert any("coefficient" in w.lower() for w in result.numerics_warnings)

    def test_extreme_range_marks_low_confidence_and_applies_scaleflag(
        self, tmp_path: Path
    ) -> None:
        """Per Gurobi: ScaleFlag=2 + NumericFocus=3 is the cheap first
        attempt for a >1e9 ratio (improves the optimize() verdict), but
        computeIIS works on UNSCALED data — the diagnosis must be marked
        LOW CONFIDENCE and the applied mitigation must be visible."""
        result = run_iis(FIXTURES / "badscale_infeasible.lp", output_dir=tmp_path)
        assert result.success is True
        assert any("LOW CONFIDENCE" in w for w in result.numerics_warnings)
        assert any("ScaleFlag" in w for w in result.numerics_warnings)

    def test_clean_model_has_no_warnings(self, tmp_path: Path) -> None:
        result = run_iis(FIXTURES / "tiny_infeasible.lp", output_dir=tmp_path)
        assert result.success is True
        assert result.numerics_warnings == []


@requires_gurobi
class TestExoticModelFeatures:
    def test_ranged_constraint_model_diagnosed(self, tmp_path: Path) -> None:
        """addRange constraints participate in the IIS normally and the
        relaxation step produces a verified fix for them."""
        import gurobipy as gp

        m = gp.Model()
        m.setParam("OutputFlag", 0)
        x = m.addVar(ub=100, name="x")
        m.addRange(x, 20, 30, "range_c")
        m.addConstr(x <= 5, "cap")
        lp = tmp_path / "ranged.lp"
        m.write(str(lp))
        m.dispose()

        result = run_iis(lp, output_dir=tmp_path)
        assert result.success is True
        names = {c.name for c in result.iis_constraints}
        assert "cap" in names

        from iis_summarization.relaxation import compute_relaxations

        rel = compute_relaxations(lp, constraint_names=sorted(names), timeout=15)
        assert rel.success is True
        assert rel.fix_verified is True

    def test_range_slack_bound_translated_to_constraint_name(
        self, tmp_path: Path
    ) -> None:
        """addRange stores L <= a'x <= U internally as an equality plus a
        bounded slack named Rg<constrname>. An IISUB hit on that internal
        slack must be mapped back to the originating ranged constraint —
        otherwise the report shows a variable the user never created."""
        import gurobipy as gp

        m = gp.Model()
        m.setParam("OutputFlag", 0)
        x = m.addVar(ub=100, name="x")
        m.addRange(x, 20, 30, "range_c")
        m.addConstr(x <= 5, "cap")
        lp = tmp_path / "ranged.lp"
        m.write(str(lp))
        m.dispose()

        result = run_iis(lp, output_dir=tmp_path)
        assert result.success is True
        slack_hits = [b for b in result.iis_bounds if b.varname == "Rgrange_c"]
        assert slack_hits, "internal range slack expected in IIS bounds"
        assert slack_hits[0].range_of == "range_c"

    def test_pwl_objective_model_diagnosed(self, tmp_path: Path) -> None:
        """A piecewise-linear objective must not break Step 1 or Step 7
        (the objective is discarded before feasRelax anyway)."""
        import gurobipy as gp

        m = gp.Model()
        m.setParam("OutputFlag", 0)
        y = m.addVar(ub=100, name="y")
        z = m.addVar(ub=100, name="z")
        m.addConstr(y + z >= 10, "demand_min")
        m.addConstr(y + z <= 5, "capacity_max")
        m.setPWLObj(y, [0, 50, 100], [0, 10, 50])
        lp = tmp_path / "pwl.lp"
        m.write(str(lp))
        m.dispose()

        result = run_iis(lp, output_dir=tmp_path)
        assert result.success is True
        assert {c.name for c in result.iis_constraints} == {
            "demand_min",
            "capacity_max",
        }

        from iis_summarization.relaxation import compute_relaxations

        rel = compute_relaxations(
            lp, constraint_names=["demand_min", "capacity_max"], timeout=15
        )
        assert rel.success is True
        assert rel.fix_verified is True


class TestNumericalRecovery:
    def test_borderline_feasibility_error_is_retryable(self) -> None:
        """Gurobi Strategy 5: 'Cannot compute IIS on a feasible model'
        signals a numerically borderline model — retry with
        NumericFocus=3 and Presolve=0."""
        from iis_summarization.iis_runner import _is_borderline_iis_error

        assert _is_borderline_iis_error("Cannot compute IIS on a feasible model")
        assert _is_borderline_iis_error(
            "Gurobi error 10005: Cannot compute IIS on a feasible model"
        )
        assert not _is_borderline_iis_error("Out of memory")
        assert not _is_borderline_iis_error("")
