"""
_utils.py
─────────
Small helpers shared across step modules. Kept private to the package.
"""

from __future__ import annotations

_SENSE_MAP: dict[str, str] = {"<": "<=", ">": ">=", "=": "="}


def sense_symbol(sense_char: str) -> str:
    """Translate Gurobi's single-character sense into a readable operator.

    Gurobi returns '<', '>', or '=' for Constr.Sense; the reports and
    classifier need the familiar '<=', '>=', '=' strings.
    """
    return _SENSE_MAP.get(sense_char, sense_char)


def range_slack_map(model: object) -> dict[str, str]:
    """Map internal range-slack variable names to their ranged constraint.

    ``Model.addRange`` stores ``L <= a'x <= U`` internally as an equality
    ``a'x + s = U`` with a slack ``s`` named ``Rg<constrname>`` and bounds
    ``[0, U - L]`` (documented Gurobi behavior; Sense is always '=').
    An IIS or feasRelax hit on that slack's bound is really about the
    ranged constraint — reports must never surface a variable the user
    did not create. Best-effort: returns ``{}`` on any failure.
    """
    out: dict[str, str] = {}
    try:
        for c in model.getConstrs():  # type: ignore[attr-defined]
            if c.Sense != "=":
                continue
            expected = f"Rg{c.ConstrName}"
            row = model.getRow(c)  # type: ignore[attr-defined]
            for i in range(row.size()):
                v = row.getVar(i)
                if v.VarName == expected and row.getCoeff(i) == 1.0:
                    out[expected] = c.ConstrName
                    break
    except Exception:  # noqa: BLE001 — purely advisory metadata
        return {}
    return out
