"""Tests for .lp/.mps model inspection and the log+model combined flow."""

import json
from pathlib import Path

import pytest

gp = pytest.importorskip("gurobipy")

from solve_tuning import assessment, log_parser, model_inspect
from solve_tuning.analyzer import AnalysisOptions, run_analysis

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture()
def wide_model(tmp_path: Path) -> Path:
    """A model whose worst coefficient is a known 1e7 term, for extreme-location checks."""
    env = gp.Env(empty=True)
    env.setParam("OutputFlag", 0)
    env.start()
    m = gp.Model("wide", env=env)
    x = m.addVar(name="x", lb=0, ub=1e5)
    y = m.addVar(name="y", lb=0, ub=10)
    m.addConstr(1e-6 * x + 1e7 * y <= 5e6, name="cap")
    m.addConstr(x + y >= 3, name="mincount")
    m.setObjective(2 * x + 3 * y, gp.GRB.MAXIMIZE)
    p = tmp_path / "wide.lp"
    m.write(str(p))
    return p


def test_inspect_reports_structure_and_extremes(wide_model: Path):
    info = model_inspect.inspect_model(wide_model)
    assert info is not None
    assert info["obj_sense"] == "maximize"
    assert info["coefficient_stats"]["matrix"] == [1e-6, 1e7]
    hi = info["matrix_extremes"]["max"]
    lo = info["matrix_extremes"]["min"]
    assert hi["value"] == 1e7 and hi["variable"] == "y" and hi["constraint"] == "cap"
    assert lo["value"] == 1e-6 and lo["variable"] == "x" and lo["constraint"] == "cap"


def test_inspect_missing_file_returns_none(tmp_path: Path):
    assert model_inspect.inspect_model(tmp_path / "nope.lp") is None


def test_model_ranges_override_log_and_name_offender(wide_model: Path):
    """When a model is supplied, the numerical finding names the offending term."""
    parsed = log_parser.parse_log((FIXTURES / "optimal_presolved.log").read_text())
    info = model_inspect.inspect_model(wide_model)
    result = assessment.assess(parsed, info)
    numerical = next(f for f in result["findings"] if f["id"] == "numerical")
    assert numerical["severity"] == "critical"  # 1e7/1e-6 = 1e13 > 1e12
    assert "`y`" in numerical["detail"] and "`cap`" in numerical["detail"]
    # log (1e-2..1e4) vs model (1e-6..1e7) differ → mismatch finding
    assert any(f["id"] == "log_model_mismatch" for f in result["findings"])


def _write(m: "gp.Model", tmp_path: Path, name: str) -> Path:
    p = tmp_path / name
    m.write(str(p))
    return p


def _new_model(name: str = "m") -> "gp.Model":
    env = gp.Env(empty=True)
    env.setParam("OutputFlag", 0)
    env.start()
    return gp.Model(name, env=env)


def test_classify_lp(tmp_path: Path):
    m = _new_model()
    x = m.addVar(name="x")
    y = m.addVar(name="y")
    m.addConstr(x + y <= 4, name="c")
    m.setObjective(x + y, gp.GRB.MAXIMIZE)
    info = model_inspect.inspect_model(_write(m, tmp_path, "lp.lp"))
    assert info["model_class"] == "LP"
    assert info["is_linear"] is True


def test_classify_milp(tmp_path: Path):
    m = _new_model()
    x = m.addVar(vtype=gp.GRB.BINARY, name="x")
    y = m.addVar(name="y")
    m.addConstr(x + y <= 4, name="c")
    m.setObjective(x + y, gp.GRB.MAXIMIZE)
    info = model_inspect.inspect_model(_write(m, tmp_path, "milp.lp"))
    assert info["model_class"] == "MILP"
    assert info["is_linear"] is False


def test_classify_general_constraint_abs(tmp_path: Path):
    m = _new_model()
    x = m.addVar(lb=-5, ub=5, name="x")
    r = m.addVar(name="r")
    m.addGenConstrAbs(r, x, name="absx")
    m.setObjective(r, gp.GRB.MINIMIZE)
    info = model_inspect.inspect_model(_write(m, tmp_path, "abs.lp"))
    assert "general constraints" in info["model_class"]
    assert info["is_linear"] is False
    assert info["gen_constraints"] == {"ABS": 1}


def test_structure_findings_linearization_and_class(tmp_path: Path):
    m = _new_model()
    x = m.addVar(lb=-5, ub=5, name="x")
    r = m.addVar(name="r")
    m.addGenConstrAbs(r, x, name="absx")
    m.setObjective(r, gp.GRB.MINIMIZE)
    info = model_inspect.inspect_model(_write(m, tmp_path, "abs.lp"))
    parsed = log_parser.parse_log((FIXTURES / "optimal_presolved.log").read_text())
    findings = assessment.assess(parsed, info)["findings"]
    ids = {f["id"] for f in findings}
    assert "model_class" in ids
    assert "gen_abs" in ids
    gen = next(f for f in findings if f["id"] == "gen_abs")
    assert gen["levers"] and gen["levers"][0]["parameter"] is None  # formulation change
    assert "LP exact" in gen["title"]


def test_big_m_reports_reachable_activity_not_prescriptive(tmp_path: Path):
    """Deactivation form x <= M*y: reachable activity of x is its ub, never 0."""
    m = _new_model()
    x = m.addVar(lb=0, ub=100, name="x")
    y = m.addVar(vtype=gp.GRB.BINARY, name="y")
    m.addConstr(x - 1e6 * y <= 0, name="link")  # x <= 1e6*y
    m.setObjective(x, gp.GRB.MAXIMIZE)
    info = model_inspect.inspect_model(_write(m, tmp_path, "bigm.lp"))
    bm = info["big_m_constraints"]
    assert len(bm) == 1
    assert bm[0]["constraint"] == "link" and bm[0]["variable"] == "y"
    assert bm[0]["current_M"] == 1e6
    assert bm[0]["reachable_activity"] == 100.0  # x's ub, not 0
    assert "suggested_M" not in bm[0]


def test_big_m_activation_form_never_suggests_zero(tmp_path: Path):
    """REGRESSION (review C1): activation form x + M*y <= M with a large RHS must
    NOT yield a degenerate suggestion that could cut off the optimum. We only
    ever report reachable_activity (> 0), never a prescriptive M, and never 0."""
    m = _new_model()
    x = m.addVar(lb=0, ub=100, name="x")
    y = m.addVar(vtype=gp.GRB.BINARY, name="y")
    m.addConstr(x + 1e6 * y <= 1e6, name="act")  # x <= 1e6(1-y)
    m.setObjective(x, gp.GRB.MAXIMIZE)
    info = model_inspect.inspect_model(_write(m, tmp_path, "act.lp"))
    for b in info["big_m_constraints"]:
        assert b["reachable_activity"] > 0.0   # never the dangerous 0
        assert "suggested_M" not in b           # never a prescriptive value


def test_structure_findings_dense_and_big_m(tmp_path: Path):
    m = _new_model()
    xs = [m.addVar(ub=1e8, name=f"x{i}") for i in range(6)]  # ub 1e8 → loose big-M signal
    m.addConstr(gp.quicksum(xs) <= 1e8, name="dense")  # single dense row
    m.setObjective(gp.quicksum(xs), gp.GRB.MAXIMIZE)
    info = model_inspect.inspect_model(_write(m, tmp_path, "dense.lp"))
    assert info["density"] is not None and info["density"] > 0.10
    parsed = log_parser.parse_log((FIXTURES / "optimal_presolved.log").read_text())
    ids = {f["id"] for f in assessment.assess(parsed, info)["findings"]}
    assert "dense_model" in ids
    assert "loose_big_m" in ids


def test_end_to_end_with_lp(wide_model: Path, tmp_path: Path):
    out = tmp_path / "out"
    report = run_analysis(
        FIXTURES / "optimal_presolved.log",
        AnalysisOptions(output_dir=out, language="en", lp_file=wide_model),
    )
    text = report.read_text()
    assert "Model structure (from the model file)" in text
    assert "Extreme matrix coefficients" in text
    facts = json.loads((out / "optimal_presolved_log_facts.json").read_text())
    assert facts["coefficient_stats"]["source"] == "model file"
    assert facts["meta"]["obj_sense"] == "maximize"
