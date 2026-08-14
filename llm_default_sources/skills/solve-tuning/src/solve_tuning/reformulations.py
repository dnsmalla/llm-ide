"""Linearization / reformulation advice keyed by what makes a model nonlinear.

Encoded from Gurobi's documented guidance (verified via the Gurobi knowledge
base). For each general-constraint type and for quadratic terms, we record
whether an exact linear/MILP reformulation exists and the practical advice on
whether to hand-linearize or keep Gurobi's native handling.
"""

from __future__ import annotations

from typing import TypedDict


class Reform(TypedDict):
    linearizable: str  # "LP exact" | "MILP exact" | "convex (native)" | "approx only"
    advice: str


# Keyed by Gurobi general-constraint type name (without the GENCONSTR_ prefix).
GEN_CONSTR: dict[str, Reform] = {
    "AND": {"linearizable": "LP exact",
            "advice": "Replace with r ≤ x_i for all i and r ≥ Σx_i − (k−1) — pure linear, "
                      "no extra binaries. Hand-linearize."},
    "OR": {"linearizable": "LP exact",
           "advice": "Replace with r ≥ x_i for all i and r ≤ Σx_i — pure linear, no extra "
                     "binaries. Hand-linearize."},
    "ABS": {"linearizable": "LP exact",
            "advice": "If the objective pushes r down, r ≥ x, r ≥ −x, r ≥ 0 is exact (pure LP). "
                      "Otherwise an exact MILP form needs one binary."},
    "MAX": {"linearizable": "MILP exact",
            "advice": "Exact via big-M with one binary per operand (Σz=1). Hand-linearize only "
                      "when operand bounds are tight (small M); for many loose operands keep native."},
    "MIN": {"linearizable": "MILP exact",
            "advice": "Symmetric to MAX. Hand-linearize only with tight bounds (small M)."},
    "NORM": {"linearizable": "depends on p",
             "advice": "1-norm → LP/MILP via ABS; ∞-norm → MAX+ABS (MILP); 2-norm → a convex "
                       "second-order-cone constraint Gurobi solves natively — keep it."},
    "INDICATOR": {"linearizable": "MILP exact (big-M)",
                  "advice": "KEEP as an indicator unless you have a TIGHT big-M (≲10). Never "
                            "hand-linearize with M ≥ 1e5 — it injects numerical error; indicators "
                            "give Gurobi stronger propagation and cuts."},
    "PWL": {"linearizable": "LP/MILP exact",
            "advice": "Modeled with SOS2 internally; a convex piecewise-linear function needs no "
                      "SOS2 and can be a pure LP (n half-planes)."},
}

# Transcendental / polynomial function constraints — no exact linearization.
_NONLINEAR_FUNCS = (
    "POLY", "EXP", "EXPA", "LOG", "LOGA", "LOGISTIC", "POW", "SIN", "COS", "TAN", "NL",
)
for _t in _NONLINEAR_FUNCS:
    GEN_CONSTR[_t] = {
        "linearizable": "approx only",
        "advice": "No exact linear reformulation. On a tight variable domain a piecewise-linear "
                  "approximation (≈5–20 breakpoints) turns it into a MILP that Gurobi often "
                  "solves faster than the native nonlinear solver; on wide domains keep native.",
    }

# Quadratic objective / constraint advice (not a general constraint).
QUADRATIC = {
    "objective": "Quadratic objective: if convex, Gurobi handles it efficiently; if non-convex, "
                 "it triggers spatial branch-and-bound — consider a linear/PWL surrogate.",
    "constraint": "Quadratic (bilinear) constraints: give the tightest finite variable bounds you "
                  "can (improves the McCormick envelope). binary×binary and binary×continuous "
                  "products linearize EXACTLY — prefer those over a raw quadratic term.",
}

# Product-term linearizations (for the narrative / reference).
PRODUCTS = {
    "binary_binary": "w = x·y with x,y binary → w ≥ x+y−1, w ≤ x, w ≤ y, w ≥ 0 (exact LP). "
                     "Always linearize.",
    "binary_continuous": "w = x·y with x binary, y∈[L,U] → 4 linear constraints giving the convex "
                         "hull (exact MILP, no new binary).",
    "continuous_continuous": "w = x·y (both continuous) → McCormick envelope is only a relaxation; "
                             "tighten bounds and let Gurobi's spatial B&B refine it.",
}
