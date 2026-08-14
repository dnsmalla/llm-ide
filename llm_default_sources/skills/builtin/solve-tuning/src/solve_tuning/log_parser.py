"""Parse a raw Gurobi solver log into a structured dict.

Every field is best-effort and optional: logs vary by version, algorithm
(simplex / barrier / MIP), and verbosity, so a missing field yields ``None``
rather than an error. Regexes are written against real Gurobi 12/13 output.

The parser is intentionally dependency-free (no gurobipy): a log is just text,
and the whole point of the skill is to read a log produced on another machine.
"""

from __future__ import annotations

import logging
import re
from typing import Any

log = logging.getLogger(__name__)

# A signed float in Gurobi's notation, e.g. -1.23e+04 / 5e-05 / 17 / 0.0001.
_NUM = r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?"

_RE = {
    "version": re.compile(r"Gurobi Optimizer version (\d+\.\d+\.\d+)"),
    "version_alt": re.compile(r"Gurobi (\d+\.\d+\.\d+)\s*\("),
    "platform": re.compile(r"Gurobi Optimizer version \S+ build \S+ \(([^)]*)\)"),
    "sizes": re.compile(
        r"Optimize a model with (\d+) rows?, (\d+) columns? and (\d+) nonzeros?"
    ),
    "fingerprint": re.compile(r"Model fingerprint: (0x[0-9a-fA-F]+)"),
    "vartypes": re.compile(
        r"Variable types: (\d+) continuous, (\d+) integer \((\d+) binary\)"
    ),
    "presolve_removed": re.compile(
        r"Presolve removed (\d+) rows? and (\d+) columns?"
    ),
    "presolve_time": re.compile(rf"Presolve time: ({_NUM})s"),
    "presolved": re.compile(
        r"Presolved: (\d+) rows?, (\d+) columns?, (\d+) nonzeros?"
    ),
    "root_relax": re.compile(
        rf"Root relaxation: objective ({_NUM}), (\d+) iterations?, ({_NUM}) seconds"
    ),
    "heuristic": re.compile(rf"Found heuristic solution: objective ({_NUM})"),
    "explored": re.compile(
        rf"Explored (\d+) nodes? \((\d+) simplex iterations?\) in ({_NUM}) seconds"
        rf"(?:\s*\(({_NUM}) work units\))?"
    ),
    # LP / barrier terminal line — carries the runtime when there is no MIP
    # "Explored …" line. Covers "Solved in N iterations and X seconds (Y work
    # units)" and "Stopped in N iterations and X seconds".
    "solved_in": re.compile(
        rf"(?:Solved|Stopped) in (\d+) iterations? and ({_NUM}) seconds"
        rf"(?:\s*\(({_NUM}) work units\))?"
    ),
    "barrier_solved": re.compile(
        rf"Barrier solved model in (\d+) iterations? and ({_NUM}) seconds"
        rf"(?:\s*\(({_NUM}) work units\))?"
    ),
    "threads_used": re.compile(r"Thread count was (\d+) \(of (\d+) available processors\)"),
    "solution_count": re.compile(r"Solution count (\d+):"),
    "best_line": re.compile(
        rf"Best objective ({_NUM}), best bound ({_NUM}), gap ({_NUM})%"
    ),
    "warning": re.compile(r"^\s*Warning:\s*(.+?)\s*$"),
    "set_param": re.compile(r"^Set parameter (\w+) to value (.+?)\s*$"),
    "coeff_header": re.compile(r"^Coefficient statistics:"),
    "coeff_row": re.compile(
        rf"^\s*(Matrix|Objective|Bounds|RHS) range\s*\[({_NUM}),\s*({_NUM})\]"
    ),
}

# Final-status phrases Gurobi prints, mapped to a stable status key. Matched by
# `phrase in line`, FIRST match wins, so MORE-SPECIFIC phrases must come first
# (e.g. "infeasible or unbounded" before "infeasible", else the substring wins).
# Strings verified empirically against Gurobi 12 (e.g. it prints "Infeasible
# model" / "Unbounded model", NOT "Model is infeasible"); both spellings are
# kept for cross-version safety. "Optimal objective" covers continuous LP/QP.
_STATUS_PHRASES: list[tuple[str, str]] = [
    ("Optimal solution found", "OPTIMAL"),
    ("Optimal objective", "OPTIMAL"),
    ("Infeasible or unbounded model", "INF_OR_UNBD"),
    ("Model is infeasible or unbounded", "INF_OR_UNBD"),
    ("Infeasible model", "INFEASIBLE"),
    ("Model is infeasible", "INFEASIBLE"),
    ("Unbounded model", "UNBOUNDED"),
    ("Model is unbounded", "UNBOUNDED"),
    ("Time limit reached", "TIME_LIMIT"),      # simplex / MIP
    ("Time limit exceeded", "TIME_LIMIT"),     # barrier
    ("Work limit reached", "WORK_LIMIT"),
    ("Work limit exceeded", "WORK_LIMIT"),
    ("Solution limit reached", "SOLUTION_LIMIT"),
    ("Iteration limit reached", "ITERATION_LIMIT"),
    ("Iteration limit exceeded", "ITERATION_LIMIT"),
    ("Node limit reached", "NODE_LIMIT"),
    ("Memory limit reached", "MEM_LIMIT"),
    ("Out of memory", "MEM_LIMIT"),
    ("Solve interrupted", "INTERRUPTED"),
    ("Sub-optimal termination", "SUBOPTIMAL"),
    ("Numerical trouble encountered", "NUMERIC"),
]

# Markers that unambiguously identify a multi-objective / multi-scenario run.
_MULTI_MARKERS: tuple[str, ...] = (
    "Multi-objectives:", "Solving multiple scenarios", "Scenario Obj. Bounds",
    "Hierarchical objectives", "Optimize a model with multiple objectives",
)


def _f(s: str) -> float:
    return float(s)


def parse_log(text: str) -> dict[str, Any]:
    """Parse Gurobi log text into a structured dict (all fields optional)."""
    lines = text.splitlines()

    parsed: dict[str, Any] = {
        "version": None,
        "platform": None,
        "sizes": None,
        "fingerprint": None,
        "variable_types": None,
        "coefficient_stats": {},
        "warnings": [],
        "set_parameters": {},
        "presolve": {},
        "root_relaxation": None,
        "heuristic_objective": None,
        "cutting_planes": {},
        "node_log": [],
        "termination": {},
        "is_mip": False,
        "multiple_solves": False,
    }

    in_coeff = False
    in_cuts = False
    best_line_count = 0
    multi_marker_seen = False
    lp_runtime: tuple[float, float | None, int] | None = None  # (sec, work, iters)
    for raw in lines:
        line = raw.rstrip()

        # Prefer the canonical "Gurobi Optimizer version X" line; fall back to
        # the "logging started" banner only if the canonical line is absent.
        if m := _RE["version"].search(line):  # noqa: SIM114 — arms intentionally separate
            parsed["version"] = m.group(1)
        elif (m := _RE["version_alt"].search(line)) and not parsed["version"]:
            parsed["version"] = m.group(1)
        if (m := _RE["platform"].search(line)) and not parsed["platform"]:
            parsed["platform"] = m.group(1)
        if (m := _RE["sizes"].search(line)) and parsed["sizes"] is None:
            parsed["sizes"] = {
                "rows": int(m.group(1)), "columns": int(m.group(2)),
                "nonzeros": int(m.group(3)),
            }
        if (m := _RE["fingerprint"].search(line)) and not parsed["fingerprint"]:
            parsed["fingerprint"] = m.group(1)
        if (m := _RE["vartypes"].search(line)) and parsed["variable_types"] is None:
            cont, integer, binary = int(m.group(1)), int(m.group(2)), int(m.group(3))
            parsed["variable_types"] = {
                "continuous": cont, "integer": integer, "binary": binary
            }
            if integer > 0:
                parsed["is_mip"] = True
        if m := _RE["set_param"].match(line):
            # Strip any trailing annotation like " (default)" / " (user-set)".
            value = re.sub(r"\s*\([^)]*\)\s*$", "", m.group(2)).strip()
            parsed["set_parameters"][m.group(1)] = value
        if m := _RE["warning"].match(line):
            parsed["warnings"].append(m.group(1))

        # Coefficient statistics block.
        if _RE["coeff_header"].search(line):
            in_coeff = True
            continue
        if in_coeff:
            if m := _RE["coeff_row"].match(line):
                key = m.group(1).lower()
                parsed["coefficient_stats"][key] = [_f(m.group(2)), _f(m.group(3))]
                continue
            in_coeff = False  # block ended

        # Cutting planes block (label: count lines until a blank/non-matching line).
        if line.strip() == "Cutting planes:":
            in_cuts = True
            continue
        if in_cuts:
            cm = re.match(r"^\s+([A-Za-z][\w ]*?):\s*(\d+)\s*$", line)
            if cm:
                parsed["cutting_planes"][cm.group(1).strip()] = int(cm.group(2))
                continue
            in_cuts = False

        if m := _RE["presolve_removed"].search(line):
            parsed["presolve"]["removed_rows"] = int(m.group(1))
            parsed["presolve"]["removed_columns"] = int(m.group(2))
        if m := _RE["presolve_time"].search(line):
            parsed["presolve"]["time_sec"] = _f(m.group(1))
        if m := _RE["presolved"].search(line):
            parsed["presolve"]["rows"] = int(m.group(1))
            parsed["presolve"]["columns"] = int(m.group(2))
            parsed["presolve"]["nonzeros"] = int(m.group(3))
        if m := _RE["root_relax"].search(line):
            parsed["root_relaxation"] = {
                "objective": _f(m.group(1)), "iterations": int(m.group(2)),
                "seconds": _f(m.group(3)),
            }
        if (m := _RE["heuristic"].search(line)) and parsed["heuristic_objective"] is None:
            parsed["heuristic_objective"] = _f(m.group(1))

        if m := _RE["explored"].search(line):
            parsed["termination"]["nodes"] = int(m.group(1))
            parsed["termination"]["simplex_iterations"] = int(m.group(2))
            parsed["termination"]["runtime_sec"] = _f(m.group(3))
            parsed["termination"]["work_units"] = _f(m.group(4)) if m.group(4) else None
            parsed["is_mip"] = True
        if (m := _RE["solved_in"].search(line)) or (m := _RE["barrier_solved"].search(line)):
            lp_runtime = (
                _f(m.group(2)),
                _f(m.group(3)) if m.group(3) else None,
                int(m.group(1)),
            )
        if any(marker in line for marker in _MULTI_MARKERS):
            multi_marker_seen = True
        if m := _RE["threads_used"].search(line):
            parsed["termination"]["threads"] = int(m.group(1))
            parsed["termination"]["available_processors"] = int(m.group(2))
        if m := _RE["solution_count"].search(line):
            parsed["termination"]["solution_count"] = int(m.group(1))
        if m := _RE["best_line"].search(line):
            parsed["termination"]["best_objective"] = _f(m.group(1))
            parsed["termination"]["best_bound"] = _f(m.group(2))
            parsed["termination"]["gap_pct"] = _f(m.group(3))
            best_line_count += 1

        entry = _parse_node_log_row(line)
        if entry is not None:
            parsed["node_log"].append(entry)

        for phrase, status in _STATUS_PHRASES:
            if phrase in line:
                parsed["termination"]["status"] = status
                parsed["termination"]["status_phrase"] = phrase
                break

    # LP / barrier: if no MIP "Explored …" line set the runtime, take it from the
    # "Solved/Stopped in …" line so LP solves still report runtime/work units.
    if "runtime_sec" not in parsed["termination"] and lp_runtime is not None:
        parsed["termination"]["runtime_sec"] = lp_runtime[0]
        if lp_runtime[1] is not None:
            parsed["termination"]["work_units"] = lp_runtime[1]
        parsed["termination"].setdefault("simplex_iterations", lp_runtime[2])

    # De-duplicate repeated warnings (e.g. per-node Markowitz tightening) while
    # preserving first-seen order.
    parsed["warnings"] = list(dict.fromkeys(parsed["warnings"]))

    # Multi-objective / multi-scenario: trust explicit markers; fall back to >1
    # 'Best objective' summary lines (which can also mean the model was solved
    # more than once into the same log).
    parsed["multiple_solves"] = multi_marker_seen or best_line_count > 1
    parsed["multi_objective_marker"] = multi_marker_seen
    return parsed


def _parse_node_log_row(line: str) -> dict[str, Any] | None:
    """Extract (time, incumbent, best_bound, gap) from a MIP node-log row.

    A progress row ends with a time token (``\\d+s``) and carries a gap token
    (``X%``); the two columns immediately before the gap are Incumbent and
    BestBd (this holds across standard, concurrent and distributed-MIP layouts,
    where only the trailing It/Node column differs). Token-based parsing is
    robust to the variable-width columns. Rows without an incumbent yet (gap
    shown as ``-``) are skipped."""
    toks = line.split()
    if len(toks) < 5 or not re.fullmatch(r"\d+(?:\.\d+)?s", toks[-1]):
        return None
    # A genuine node-log row starts with the explored-node count, optionally
    # prefixed by H (heuristic incumbent) or * (branching incumbent). Requiring
    # this stops stray lines that merely contain a "%" and a trailing "Ns"
    # (e.g. NoRel/heuristic-phase or presolve progress) from false-matching.
    if toks[0] not in ("H", "*") and not toks[0].isdigit():
        return None
    gap_idx = next((i for i, t in enumerate(toks) if t.endswith("%")), None)
    if gap_idx is None or gap_idx < 2:
        return None
    try:
        gap = float(toks[gap_idx][:-1])
        bestbd = float(toks[gap_idx - 1])
    except ValueError:
        return None
    inc_tok = toks[gap_idx - 2]
    try:
        incumbent = float(inc_tok)
    except ValueError:
        return None  # no incumbent on this row
    return {
        "time_sec": float(toks[-1][:-1]),
        "incumbent": incumbent,
        "best_bound": bestbd,
        "gap_pct": gap,
    }
