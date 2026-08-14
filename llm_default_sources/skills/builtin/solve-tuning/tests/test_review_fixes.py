"""Regression tests for the issues found in the production review:
infeasible/unbounded detection, LP runtime, stall flat-tail, warning handling."""

from pathlib import Path

from solve_tuning import assessment, log_parser

FIXTURES = Path(__file__).parent / "fixtures"


def _parse(name: str) -> dict:
    return log_parser.parse_log((FIXTURES / name).read_text())


# ── C1: real Gurobi prints "Infeasible model" / "Unbounded model" ──

def test_infeasible_detected_not_healthy():
    parsed = _parse("infeasible.log")
    assert parsed["termination"]["status"] == "INFEASIBLE"
    result = assessment.assess(parsed)
    assert result["healthy"] is False
    ids = {f["id"] for f in result["findings"]}
    assert "infeasible" in ids
    crit = next(f for f in result["findings"] if f["id"] == "infeasible")
    assert crit["severity"] == "critical"


def test_unbounded_detected_not_healthy():
    parsed = _parse("unbounded.log")
    assert parsed["termination"]["status"] == "UNBOUNDED"
    result = assessment.assess(parsed)
    assert result["healthy"] is False
    assert any(f["id"] == "unbounded" for f in result["findings"])


# ── C2: substring ordering — "infeasible or unbounded" must not match INFEASIBLE ──

def test_inf_or_unbd_not_mislabeled():
    for phrase in ("Infeasible or unbounded model", "Model is infeasible or unbounded"):
        parsed = log_parser.parse_log(f"Optimize a model with 1 rows, 1 columns and 1 nonzeros\n{phrase}\n")
        assert parsed["termination"]["status"] == "INF_OR_UNBD"


# ── I2: LP/barrier runtime comes from the "Solved in …" line ──

def test_lp_runtime_captured():
    parsed = _parse("lp_barrier.log")
    assert parsed["termination"]["status"] == "OPTIMAL"
    assert parsed["termination"]["runtime_sec"] == 0.02
    assert parsed["termination"]["work_units"] == 0.01


# ── I1: a metric that improves early then flatlines is a STALL, not "progressing" ──

def test_stall_all_zero_timestamps_not_falsely_both_stalled():
    """REGRESSION: a fast MIP prints every node row at 0s. Both metrics clearly
    improve, so the verdict must be 'progressing', NOT a self-comparison 'both'."""
    nl = [
        {"time_sec": 0.0, "incumbent": 304.0, "best_bound": 820.56, "gap_pct": 170},
        {"time_sec": 0.0, "incumbent": 503.0, "best_bound": 820.56, "gap_pct": 63},
        {"time_sec": 0.0, "incumbent": 676.0, "best_bound": 810.0, "gap_pct": 21},
        {"time_sec": 0.0, "incumbent": 697.0, "best_bound": 804.46, "gap_pct": 15},
    ]
    stall = assessment._analyze_stall(nl)
    assert stall["type"] == "progressing"


def test_stall_flat_tail_is_primal_not_progressing():
    # incumbent improves once at the start of the run then freezes; bound keeps moving.
    nl = [
        {"time_sec": 5, "incumbent": 200.0, "best_bound": 100.0, "gap_pct": 50},
        {"time_sec": 10, "incumbent": 150.0, "best_bound": 110.0, "gap_pct": 27},  # last incumbent move
        {"time_sec": 40, "incumbent": 150.0, "best_bound": 130.0, "gap_pct": 13},
        {"time_sec": 80, "incumbent": 150.0, "best_bound": 145.0, "gap_pct": 3},
    ]
    stall = assessment._analyze_stall(nl)
    assert stall["type"] == "primal"  # incumbent frozen in the tail
    assert stall["type"] != "progressing"


# ── I5: warnings de-duplicated; coefficient-range warning is critical on its own ──

def test_warnings_deduped_and_escalated():
    log = (
        "Optimize a model with 3 rows, 3 columns and 9 nonzeros\n"
        "Coefficient statistics:\n"
        "  Matrix range     [1e+00, 1e+02]\n"   # ratio 1e2 → no numerical finding
        "Warning: Markowitz tolerance tightened to 0.5\n"
        "Warning: Markowitz tolerance tightened to 0.5\n"   # duplicate
        "Warning: Model contains large matrix coefficient range\n"
        "Optimal solution found (tolerance 1.00e-04)\n"
        "Best objective 1.0, best bound 1.0, gap 0.0000%\n"
    )
    parsed = log_parser.parse_log(log)
    assert len(parsed["warnings"]) == 2  # the duplicate Markowitz collapsed
    sw = next(f for f in assessment.assess(parsed)["findings"] if f["id"] == "solver_warnings")
    assert sw["severity"] == "critical"  # large-coefficient-range warning escalates


# ── I3: explicit multi-objective marker is recognized ──

# ── M2: node-log parser ignores non-node lines that merely contain "%" and "Ns" ──

def test_node_log_ignores_non_node_lines():
    from solve_tuning.log_parser import _parse_node_log_row
    # A line that has a percentage and a trailing "Ns" but is NOT a node-log row.
    assert _parse_node_log_row("Presolve reduced density by 12.5% in 0.3s") is None
    # A real node-log row (starts with the explored-node count) still parses.
    row = _parse_node_log_row("   500   320 118000.000   25  110 101500.000 121000.000  19.2%   210   35s")
    assert row is not None and row["incumbent"] == 101500.0 and row["best_bound"] == 121000.0
    # Heuristic-incumbent prefix row parses too.
    h = _parse_node_log_row("H    0     0                    1972.0000000 1995.24529  1.18%     -    0s")
    assert h is not None and h["incumbent"] == 1972.0


# ── M1: canonical "Gurobi Optimizer version" wins over the banner ──

def test_canonical_version_preferred():
    log = (
        "Gurobi 12.0.0 (mac64[arm], Python) logging started ...\n"
        "Gurobi Optimizer version 12.0.1 build v12.0.1rc0 (mac64[arm] - Darwin)\n"
        "Optimize a model with 1 rows, 1 columns and 1 nonzeros\n"
        "Optimal objective  1.0\n"
    )
    parsed = log_parser.parse_log(log)
    assert parsed["version"] == "12.0.1"  # canonical, not the 12.0.0 banner


def test_multi_objective_marker_detected():
    log = (
        "Optimize a model with 5 rows, 5 columns and 25 nonzeros\n"
        "Multi-objectives: 2 objectives (1 combined) ...\n"
        "Optimal solution found (tolerance 1.00e-04)\n"
        "Best objective 1.0, best bound 1.0, gap 0.0000%\n"
    )
    parsed = log_parser.parse_log(log)
    assert parsed["multiple_solves"] is True
    assert parsed["multi_objective_marker"] is True
    assert any(f["id"] == "multi_objective" for f in assessment.assess(parsed)["findings"])
