"""Unit tests for facts assembly — esp. the sign-aware shadow-price flag."""

from result_explanation import facts as facts_mod


def _build(
    obj_sense: str,
    pi: float,
    *,
    vtype: str = "C",
    reduced_costs: dict | None = None,
    rhs_ranges: dict | None = None,
) -> dict:
    constr_analysis = {
        "binding": [
            {"name": "cap", "sense": "<=", "rhs": 80.0, "n_vars": 1, "vars": ["x"]}
        ],
        "violated": [],
        "n_slack": 0,
        "n_unknown": 0,
    }
    var_status = {
        "x": {
            "value": 80.0, "lb": 0.0, "ub": None, "at": "interior",
            "obj_coeff": 3.0, "vtype": vtype,
        }
    }
    return facts_mod.build_facts(
        meta={},
        consistency={},
        objective={"computed_objective": 240.0, "families": [], "n_families_total": 0},
        drivers=["x"],
        var_status=var_status,
        constr_analysis=constr_analysis,
        duals={"cap": pi},
        reduced_costs=reduced_costs or {},
        value_index={},
        obj_sense=obj_sense,
        rhs_ranges=rhs_ranges,
    )


def test_shadow_price_direction_minimize():
    """For minimize, a negative Pi means raising the RHS improves (lowers) the objective."""
    facts = _build("minimize", pi=-2.0)
    c = facts["drivers"][0]["binding_constraints"][0]
    assert c["shadow_price"] == -2.0
    assert c["raising_rhs_improves_objective"] is True


def test_shadow_price_direction_maximize():
    """Same negative Pi under maximize means raising the RHS WORSENS the objective."""
    facts = _build("maximize", pi=-2.0)
    c = facts["drivers"][0]["binding_constraints"][0]
    assert c["raising_rhs_improves_objective"] is False


def test_shadow_price_positive_maximize_improves():
    facts = _build("maximize", pi=3.0)
    c = facts["drivers"][0]["binding_constraints"][0]
    assert c["raising_rhs_improves_objective"] is True


def test_no_shadow_price_when_dual_zero():
    facts = _build("minimize", pi=0.0)
    c = facts["drivers"][0]["binding_constraints"][0]
    assert "shadow_price" not in c
    assert "raising_rhs_improves_objective" not in c


def test_reduced_cost_reported_for_continuous():
    facts = _build("minimize", pi=-2.0, vtype="C", reduced_costs={"x": 1.5})
    assert facts["drivers"][0]["reduced_cost"] == 1.5


def test_reduced_cost_suppressed_for_integer_and_binary():
    """Gurobi warns the fixed-model RC of an integer/binary var is meaningless."""
    for vt in ("B", "I"):
        facts = _build("minimize", pi=-2.0, vtype=vt, reduced_costs={"x": 1.5})
        assert "reduced_cost" not in facts["drivers"][0]


def test_rhs_valid_range_attached():
    facts = _build("minimize", pi=-2.0, rhs_ranges={"cap": (60.0, 120.0)})
    c = facts["drivers"][0]["binding_constraints"][0]
    assert c["rhs_valid_range"] == [60.0, 120.0]


def test_rhs_valid_range_absent_without_ranges():
    facts = _build("minimize", pi=-2.0)
    assert "rhs_valid_range" not in facts["drivers"][0]["binding_constraints"][0]
