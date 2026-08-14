"""Unit tests for the solver-health assessment layer."""

from pathlib import Path

from solve_tuning import assessment, log_parser

FIXTURES = Path(__file__).parent / "fixtures"


def _assess(name: str) -> dict:
    return assessment.assess(log_parser.parse_log((FIXTURES / name).read_text()))


def _ids(result: dict) -> set[str]:
    return {f["id"] for f in result["findings"]}


def test_ratio_severity_thresholds():
    assert assessment._ratio_severity(1e5) is None
    assert assessment._ratio_severity(1e7) == "info"      # monitor band
    assert assessment._ratio_severity(1e10) == "warning"  # numerical risk
    assert assessment._ratio_severity(1e13) == "critical"  # high risk


def test_clean_optimal_is_healthy():
    """Matrix ratio exactly 1e6 is the 'ideal' boundary → no numerical finding."""
    result = _assess("optimal_presolved.log")
    assert _ids(result) == {"optimal"}
    assert result["healthy"] is True


def test_optimal_but_numerically_risky():
    """Solved to optimality, yet a 2e11 matrix ratio + Markowitz warning fire."""
    result = _assess("optimal_nodelog.log")
    ids = _ids(result)
    assert "numerical" in ids
    assert "solver_warnings" in ids
    assert "optimal" in ids
    assert result["healthy"] is False
    numerical = next(f for f in result["findings"] if f["id"] == "numerical")
    assert numerical["severity"] == "warning"
    assert any(lev["parameter"] == "NumericFocus" for lev in numerical["levers"])


def test_timelimit_high_risk():
    result = _assess("timelimit_warned.log")
    ids = _ids(result)
    assert "numerical" in ids
    assert "time_limit" in ids
    numerical = next(f for f in result["findings"] if f["id"] == "numerical")
    assert numerical["severity"] == "critical"  # ratio 8e12 > 1e12
    # warnings inherit the critical numerical severity
    sw = next(f for f in result["findings"] if f["id"] == "solver_warnings")
    assert sw["severity"] == "critical"
    tl = next(f for f in result["findings"] if f["id"] == "time_limit")
    assert any(lev["parameter"] == "MIPGap" for lev in tl["levers"])
    assert result["healthy"] is False
