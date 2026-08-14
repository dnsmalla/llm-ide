"""Unit tests for the Gurobi log parser, run against real log fixtures."""

from pathlib import Path

from solve_tuning import log_parser

FIXTURES = Path(__file__).parent / "fixtures"


def _parse(name: str) -> dict:
    return log_parser.parse_log((FIXTURES / name).read_text())


def test_parse_optimal_presolved():
    p = _parse("optimal_presolved.log")
    assert p["version"] == "12.0.1"
    assert p["sizes"] == {"rows": 42, "columns": 80, "nonzeros": 160}
    assert p["variable_types"] == {"continuous": 40, "integer": 40, "binary": 40}
    assert p["is_mip"] is True
    assert p["coefficient_stats"]["matrix"] == [1e-2, 1e4]
    assert p["coefficient_stats"]["rhs"] == [5.0, 5e6]
    assert p["heuristic_objective"] == 90120.0
    assert p["termination"]["status"] == "OPTIMAL"
    assert p["termination"]["best_objective"] == 90120.0
    assert p["termination"]["gap_pct"] == 0.0
    assert p["termination"]["work_units"] == 0.0
    assert p["warnings"] == []


def test_parse_nodelog_with_warning():
    p = _parse("optimal_nodelog.log")
    assert p["set_parameters"]["TimeLimit"] == "2"
    assert p["set_parameters"]["MIPGap"] == "1e-09"
    assert p["coefficient_stats"]["matrix"] == [5e-5, 1e7]
    assert any("Markowitz" in w for w in p["warnings"])
    assert p["root_relaxation"]["objective"] == 1995.245
    assert p["root_relaxation"]["iterations"] == 6
    assert p["cutting_planes"] == {"Cover": 1}
    assert p["termination"]["status"] == "OPTIMAL"
    assert p["termination"]["nodes"] == 1
    assert p["termination"]["solution_count"] == 2


def test_parse_timelimit_warned():
    p = _parse("timelimit_warned.log")
    assert p["sizes"] == {"rows": 5000, "columns": 8000, "nonzeros": 240000}
    assert p["coefficient_stats"]["matrix"] == [1e-6, 8e6]
    # Two 'Warning:' lines captured; the 'Consider reformulating' line is not a Warning.
    assert any("large matrix coefficient range" in w for w in p["warnings"])
    assert any("large rhs" in w for w in p["warnings"])
    assert all("Consider reformulating" not in w for w in p["warnings"])
    assert p["presolve"]["rows"] == 4200
    assert p["root_relaxation"]["seconds"] == 3.5
    assert p["termination"]["status"] == "TIME_LIMIT"
    assert p["termination"]["gap_pct"] == 17.2414
    assert p["termination"]["best_objective"] == 1.015e5
    assert p["termination"]["best_bound"] == 1.19e5
    assert p["termination"]["work_units"] == 95.40


def test_parse_garbage_is_empty_not_error():
    p = log_parser.parse_log("this is not a gurobi log\njust some text\n")
    assert p["sizes"] is None
    assert p["termination"] == {}
    assert p["warnings"] == []
