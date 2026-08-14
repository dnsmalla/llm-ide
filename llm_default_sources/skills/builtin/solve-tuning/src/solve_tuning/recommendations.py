"""Symptom → parameter/formulation lever catalog.

Encoded from Gurobi's documented parameter guidelines (verified via the Gurobi
knowledge base). Each lever names a real gurobipy parameter, the direction to
move it, and why. ``parameter=None`` marks a formulation-level action.

A lever may carry ``set_value`` — a single concrete value safe to drop straight
into a ``.prm`` / ``setParam``. Situational levers (e.g. "relax MIPGap *if*
acceptable", "give it more time") deliberately omit ``set_value`` so the
generated settings file only contains confident, universal recommendations.
"""

from __future__ import annotations

from typing import TypedDict


class Lever(TypedDict, total=False):
    parameter: str | None
    change: str
    rationale: str
    set_value: str  # concrete value for the .prm artifact (omitted if situational)


# ── Numerical conditioning (wide coefficient range / numeric warnings) ──
NUMERICAL: list[Lever] = [
    {"parameter": None,
     "change": "Rescale the formulation (choose units so coefficients sit in ~[1e-3, 1e6])",
     "rationale": "The root cause of a wide coefficient range is almost always units; "
                  "fixing it at the model level beats any solver workaround."},
    {"parameter": "NumericFocus", "change": "0 → 2 (try 3 if it persists)", "set_value": "2",
     "rationale": "Makes the solver spend more effort on numerically careful pivoting "
                  "and higher-precision arithmetic."},
    {"parameter": "ScaleFlag", "change": "try 2 (aggressive) or 3 (Curtis-Reid)", "set_value": "2",
     "rationale": "Stronger internal scaling can absorb a wide coefficient range; "
                  "ScaleFlag=0 disables scaling to isolate whether it is the cause."},
    {"parameter": "ObjScale", "change": "set -1 (auto) when objective coefficients span orders of magnitude",
     "rationale": "Rescales the objective internally."},
    {"parameter": "Cuts", "change": "reduce to 1 or 0 if numeric warnings persist",
     "rationale": "Cuts generated at ill-conditioned nodes can inject further round-off."},
    {"parameter": "IntegralityFocus", "change": "set 1 (MIP)", "set_value": "1",
     "rationale": "Enforces integrality more strictly so near-integer round-off is not "
                  "treated as integer."},
]

# ── Slow MIP, incumbent (primal bound) not improving ──
SLOW_MIP_PRIMAL: list[Lever] = [
    {"parameter": "MIPFocus", "change": "0 → 1", "set_value": "1",
     "rationale": "Prioritises finding better feasible solutions over proving optimality."},
    {"parameter": "Heuristics", "change": "0.05 → 0.2–0.5", "set_value": "0.2",
     "rationale": "Spends more time on RINS / diving heuristics that find incumbents."},
    {"parameter": None, "change": "Provide a warm start (Start attribute / MIP start)",
     "rationale": "A good initial solution accelerates the feasibility search."},
]

# ── Slow MIP, dual bound (BestBd) stalling ──
SLOW_MIP_DUAL: list[Lever] = [
    {"parameter": "MIPFocus", "change": "0 → 3", "set_value": "3",
     "rationale": "Focuses effort on tightening the dual bound."},
    {"parameter": "Cuts", "change": "→ 2 (aggressive) or 3", "set_value": "2",
     "rationale": "More cuts tighten the LP relaxation, directly strengthening the bound."},
    {"parameter": "Symmetry", "change": "-1 → 2 (aggressive)", "set_value": "2",
     "rationale": "Breaks symmetric subtrees so the search is not repeated."},
    {"parameter": "Presolve", "change": "→ 2 (aggressive)", "set_value": "2",
     "rationale": "May tighten bounds and remove variables, improving the relaxation."},
]

# ── Hitting the time limit with a meaningful gap (all situational) ──
TIME_LIMIT: list[Lever] = [
    {"parameter": "MIPGap", "change": "1e-4 → 1e-2 or 5e-2 if a near-optimal answer is acceptable",
     "rationale": "Stops once the proven gap is small enough for the application, saving time."},
    {"parameter": "TimeLimit", "change": "increase if proving optimality is required",
     "rationale": "The run simply needs more time to close the gap."},
    {"parameter": "WorkLimit", "change": "use instead of TimeLimit for reproducible stopping",
     "rationale": "Work units are hardware-independent and deterministic."},
]

# ── Slow LP / barrier root ──
SLOW_LP: list[Lever] = [
    {"parameter": "Method", "change": "try 2 (barrier) or 3 (concurrent)",
     "rationale": "Barrier is faster on large/dense LPs; concurrent races primal, dual and barrier."},
    {"parameter": "Presolve", "change": "→ 2 (aggressive)", "set_value": "2",
     "rationale": "Aggressive presolve can dramatically shrink the LP."},
    {"parameter": "Crossover", "change": "0 for a pure LP when a basic solution is not needed",
     "rationale": "Skips the post-barrier crossover, saving significant time."},
    {"parameter": "Threads", "change": "set to the physical core count (do not exceed it)",
     "rationale": "Concurrent LP and barrier factorisation parallelise well."},
]

CATALOG: dict[str, list[Lever]] = {
    "numerical": NUMERICAL,
    "slow_mip_primal": SLOW_MIP_PRIMAL,
    "slow_mip_dual": SLOW_MIP_DUAL,
    "time_limit": TIME_LIMIT,
    "slow_lp": SLOW_LP,
}


def collect_settings(findings: list[dict]) -> dict[str, str]:
    """Gather concrete parameter values (those with ``set_value``) from the
    findings' levers, de-duplicated by parameter. On a value conflict the first
    occurrence wins (findings are ordered most-severe first)."""
    settings: dict[str, str] = {}
    for f in findings:
        for lev in f.get("levers", []):
            param = lev.get("parameter")
            value = lev.get("set_value")
            if param and value is not None and param not in settings:
                settings[param] = value
    return settings
