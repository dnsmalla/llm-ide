#!/usr/bin/env python3
"""lp_scan.py — pre-solve health check for an optimization model file.

A dependency-free *linter* for LP-format (CPLEX/Gurobi `.lp`) and MPS-format
(`.mps`) models. It does NOT solve anything; it reads the model text and reports
the structural and numerical signals that the optimization-advisor skill cares
about, so the advice that follows is grounded in evidence rather than guesswork.

What it reports
---------------
* Model size and composition: rows, variables split into continuous / general
  integer / binary, and a nonzero count.
* Coefficient-magnitude range: smallest and largest |coefficient|, and their
  ratio (a numerical-conditioning proxy). Gurobi/CPLEX prefer coefficients
  inside roughly [1e-6, 1e6]; a ratio above ~1e9 invites instability.
* Suspicious Big-M constants: large, round explicit coefficients (1e5, 1e6,
  999999, ...) that usually signal an un-tightened Big-M.
* RHS magnitude range.
* A prioritized list of flags, each pointing at the reference section that
  explains the fix.

Usage
-----
    python lp_scan.py model.lp
    python lp_scan.py model.mps
    python lp_scan.py model.lp --json     # machine-readable output

This is a heuristic text scanner, not a parser with full grammar coverage; treat
its numbers as indicative. For log-based performance tuning use the
`solve-tuning` skill; for infeasibility use `iis-summarization`.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass, field

# Conditioning thresholds (see references/parameter-tuning.md §8).
COEFF_LOW = 1e-6
COEFF_HIGH = 1e6
RATIO_WARN = 1e9
BIGM_MIN = 1e4  # explicit coefficients at/above this are candidate Big-M values

_NUM = r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?"
# A coefficient is a number immediately followed by a variable name (LP format
# writes terms as "<coeff> <var>"). This deliberately ignores implicit-1 terms
# and bare variable names — only explicit magnitudes matter for the scan.
_COEFF_VAR = re.compile(rf"({_NUM})\s+([A-Za-z_][A-Za-z0-9_.\[\]\(\)#]*)")
_RHS = re.compile(rf"(<=|>=|=<|=>|<|>|=)\s*({_NUM})")
_OBJ_HDR = re.compile(r"^\s*(minimize|maximize|minimise|maximise|min|max)\b", re.I)
_VAR_TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_.\[\]\(\)#]*")
# A leading "name:" label at the start of an objective/constraint line.
_LABEL = re.compile(r"^\s*[A-Za-z_][A-Za-z0-9_.\[\]\(\)#]*\s*:")


@dataclass
class ScanResult:
    fmt: str = "unknown"
    n_rows: int = 0
    n_vars: int = 0
    n_binary: int = 0
    n_integer: int = 0      # general integer (excludes binary)
    n_continuous: int = 0
    n_nonzeros: int = 0
    coeff_min: float = math.inf
    coeff_max: float = 0.0
    rhs_min: float = math.inf
    rhs_max: float = 0.0
    bigm_values: list = field(default_factory=list)  # (value, context)
    flags: list = field(default_factory=list)        # (severity, text, ref)

    @property
    def coeff_ratio(self) -> float:
        if self.coeff_max <= 0 or not math.isfinite(self.coeff_min) or self.coeff_min <= 0:
            return 0.0
        return self.coeff_max / self.coeff_min


# --------------------------------------------------------------------------- #
# LP-format scanning
# --------------------------------------------------------------------------- #
def _strip_lp_comment(line: str) -> str:
    # LP comments start with a backslash and run to end of line.
    idx = line.find("\\")
    return line[:idx] if idx >= 0 else line


def scan_lp(text: str) -> ScanResult:
    r = ScanResult(fmt="LP")
    lines = [_strip_lp_comment(ln) for ln in text.splitlines()]

    section = "preamble"
    binary_vars: set[str] = set()
    integer_vars: set[str] = set()
    all_vars: set[str] = set()
    constraint_lines: list[str] = []
    objective_lines: list[str] = []

    section_kw = {
        "subject to": "constraints", "subject to:": "constraints",
        "such that": "constraints", "st": "constraints", "st.": "constraints",
        "s.t.": "constraints", "bounds": "bounds", "bound": "bounds",
        "binary": "binary", "binaries": "binary", "bin": "binary",
        "general": "integer", "generals": "integer", "gen": "integer",
        "integer": "integer", "integers": "integer",
        "semi-continuous": "semi", "semis": "semi", "semi": "semi",
        "sos": "sos", "end": "end",
    }

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        low = line.lower().rstrip(":")
        if low in section_kw:
            section = section_kw[low]
            continue
        if _OBJ_HDR.match(line):
            section = "objective"
            # keep any inline objective after the keyword
            rest = _OBJ_HDR.sub("", line, count=1).strip()
            if rest:
                objective_lines.append(rest)
            continue

        if section == "end":
            break
        elif section == "objective":
            objective_lines.append(line)
        elif section == "preamble":
            # Content before any Minimize/Maximize header is not part of a valid
            # LP model (stray comments / junk) — ignore it so it isn't miscounted
            # as variables. A real LP always opens with an objective sense keyword.
            continue
        elif section == "constraints":
            constraint_lines.append(line)
        elif section in ("binary", "integer"):
            target = binary_vars if section == "binary" else integer_vars
            for tok in _VAR_TOKEN.findall(line):
                target.add(tok)
        # bounds / semi / sos lines contribute coefficients too but are scanned
        # below for magnitudes via the generic pass.

    # Count constraints: each constraint line that contains a relational op.
    body_for_constraints = constraint_lines
    r.n_rows = sum(1 for ln in body_for_constraints if re.search(r"(<=|>=|=<|=>|<|>|=)", ln))

    # Scan per-line (never on a joined string) so an RHS number on one line
    # can't bind to the next line's "label:" and masquerade as a coefficient.
    # Drop the leading "label:" first for the same reason.
    for ln in objective_lines + constraint_lines:
        body = _LABEL.sub("", ln, count=1)
        for num, var in _COEFF_VAR.findall(body):
            try:
                _collect_one_coeff(float(num), r)
            except ValueError:
                continue
            all_vars.add(var)
        for tok in _VAR_TOKEN.findall(body):
            if tok.lower() not in section_kw and not _looks_like_keyword(tok):
                all_vars.add(tok)

    # RHS from constraint lines only.
    for ln in constraint_lines:
        for _op, val in _RHS.findall(ln):
            _record_rhs(float(val), r)

    all_vars |= binary_vars | integer_vars

    r.n_binary = len(binary_vars)
    r.n_integer = len(integer_vars - binary_vars)
    r.n_vars = len(all_vars)
    r.n_continuous = max(0, r.n_vars - r.n_binary - r.n_integer)
    return r


def _looks_like_keyword(tok: str) -> bool:
    return tok.lower() in {
        "free", "inf", "infinity", "minimize", "maximize", "min", "max",
        "subject", "to", "such", "that", "bounds", "end",
    }


# --------------------------------------------------------------------------- #
# MPS-format scanning
# --------------------------------------------------------------------------- #
def scan_mps(text: str) -> ScanResult:
    r = ScanResult(fmt="MPS")
    section = None
    rows: set[str] = set()
    obj_row: str | None = None
    cols: set[str] = set()
    int_cols: set[str] = set()
    binary_cols: set[str] = set()
    in_int_marker = False

    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("*"):
            continue
        if not raw[0].isspace():
            section = raw.split()[0].upper()
            continue
        fields = raw.split()
        if section == "ROWS":
            if len(fields) >= 2:
                rtype, rname = fields[0].upper(), fields[1]
                if rtype == "N" and obj_row is None:
                    obj_row = rname
                elif rtype in ("L", "G", "E"):
                    rows.add(rname)
        elif section == "COLUMNS":
            if "'MARKER'" in raw:
                if "'INTORG'" in raw:
                    in_int_marker = True
                elif "'INTEND'" in raw:
                    in_int_marker = False
                continue
            if len(fields) >= 3:
                col = fields[0]
                cols.add(col)
                if in_int_marker:
                    int_cols.add(col)
                # pairs of (rowname, value)
                rest = fields[1:]
                for i in range(0, len(rest) - 1, 2):
                    try:
                        _collect_one_coeff(float(rest[i + 1]), r)
                    except ValueError:
                        pass
        elif section == "RHS":
            rest = fields[1:] if len(fields) % 2 == 1 else fields
            for i in range(0, len(rest) - 1, 2):
                try:
                    _record_rhs(float(rest[i + 1]), r)
                except ValueError:
                    pass
        elif section == "BOUNDS":
            if len(fields) >= 3:
                btype = fields[0].upper()
                col = fields[2]
                if btype == "BV":
                    binary_cols.add(col)
                elif btype in ("UI", "LI"):
                    int_cols.add(col)
                if len(fields) >= 4:
                    try:
                        _collect_one_coeff(float(fields[3]), r)
                    except ValueError:
                        pass

    r.n_rows = len(rows)
    r.n_vars = len(cols)
    r.n_binary = len(binary_cols)
    r.n_integer = len((int_cols - binary_cols) & cols)
    r.n_continuous = max(0, r.n_vars - r.n_binary - r.n_integer)
    return r


# --------------------------------------------------------------------------- #
# Shared coefficient bookkeeping
# --------------------------------------------------------------------------- #
def _collect_one_coeff(val: float, r: ScanResult) -> None:
    a = abs(val)
    if a == 0.0:
        return
    r.n_nonzeros += 1
    r.coeff_min = min(r.coeff_min, a)
    r.coeff_max = max(r.coeff_max, a)
    if a >= BIGM_MIN and _is_round_bigm(a):
        if len(r.bigm_values) < 50:
            r.bigm_values.append(a)


def _record_rhs(val: float, r: ScanResult) -> None:
    a = abs(val)
    if a == 0.0 or not math.isfinite(a):
        return
    r.rhs_min = min(r.rhs_min, a)
    r.rhs_max = max(r.rhs_max, a)
    if a >= BIGM_MIN and _is_round_bigm(a):
        if len(r.bigm_values) < 50:
            r.bigm_values.append(a)


def _is_round_bigm(a: float) -> bool:
    """Heuristic: powers of ten (1e4, 1e5, ...), or all-9s / leading-digit-round
    values like 999999, 100000, 50000 — the fingerprints of a hand-picked M."""
    if a < BIGM_MIN:
        return False
    # power of ten
    lg = math.log10(a)
    if abs(lg - round(lg)) < 1e-9:
        return True
    # round multiple of a power of ten with a single significant digit (e.g. 5e5)
    exp = math.floor(lg)
    mant = a / (10 ** exp)
    if abs(mant - round(mant)) < 1e-9 and round(mant) in (1, 2, 5):
        return True
    # all-nines (999..., 99999...)
    s = f"{a:.0f}"
    if set(s) == {"9"} and len(s) >= 5:
        return True
    return False


# --------------------------------------------------------------------------- #
# Analysis → flags
# --------------------------------------------------------------------------- #
def analyze(r: ScanResult) -> None:
    ratio = r.coeff_ratio
    if ratio > RATIO_WARN:
        r.flags.append((
            "HIGH",
            f"Coefficient range spans {ratio:.1e} (|coef| from {r.coeff_min:.3g} "
            f"to {r.coeff_max:.3g}). Above ~1e9 this risks numerical instability; "
            f"rescale units so coefficients sit within [1e-6, 1e6].",
            "parameter-tuning.md §8 (Numerical Stability)",
        ))
    elif r.coeff_max > COEFF_HIGH or (math.isfinite(r.coeff_min) and 0 < r.coeff_min < COEFF_LOW):
        r.flags.append((
            "MED",
            f"Some coefficients fall outside the comfortable [1e-6, 1e6] band "
            f"(min {r.coeff_min:.3g}, max {r.coeff_max:.3g}). Consider rescaling.",
            "parameter-tuning.md §8.2 (Scaling)",
        ))

    if r.bigm_values:
        biggest = max(r.bigm_values)
        n = len(r.bigm_values)
        more = " (showing first 50)" if n >= 50 else ""
        r.flags.append((
            "HIGH",
            f"{n} large round constant(s){more}, up to {biggest:.3g}. These are "
            f"often un-tightened Big-M values — but can also be legitimate budgets "
            f"or capacities, so check each. For any that ARE Big-M: derive M from "
            f"tightened variable bounds, or switch to indicator constraints / SOS1.",
            "modeling-techniques.md §2 (Big-M Design) + antipatterns.md §1, §19",
        ))

    if r.n_binary + r.n_integer > 0 and r.n_vars > 0:
        # Symmetry hint: many binaries relative to rows often means identical
        # objects (machines/bins/colors) → symmetric subproblems.
        if r.n_binary >= 50 and r.n_rows > 0 and r.n_binary >= 2 * r.n_rows:
            r.flags.append((
                "LOW",
                f"{r.n_binary} binary variables vs {r.n_rows} constraints — if these "
                f"index interchangeable objects (machines, bins, colors, periods), "
                f"the model is likely symmetric. Add lexicographic / fix-first "
                f"symmetry-breaking before blaming the solver.",
                "modeling-techniques.md §5 + antipatterns.md §3",
            ))

    if r.fmt == "LP" and r.n_nonzeros == 0:
        r.flags.append((
            "MED",
            "No explicit coefficients were detected — the file may use an unusual "
            "layout or be mostly implicit-1 terms. Numbers below are approximate.",
            "—",
        ))

    if not r.flags:
        r.flags.append((
            "OK",
            "No obvious numerical or Big-M red flags from a static scan. Proceed to "
            "solving; if it's slow, capture the log and use the solve-tuning skill.",
            "—",
        ))


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #
def to_dict(r: ScanResult) -> dict:
    return {
        "format": r.fmt,
        "rows": r.n_rows,
        "variables": {
            "total": r.n_vars,
            "continuous": r.n_continuous,
            "general_integer": r.n_integer,
            "binary": r.n_binary,
        },
        "nonzeros": r.n_nonzeros,
        "coefficients": {
            "min_abs": None if not math.isfinite(r.coeff_min) else r.coeff_min,
            "max_abs": r.coeff_max,
            "ratio": r.coeff_ratio,
        },
        "rhs": {
            "min_abs": None if not math.isfinite(r.rhs_min) else r.rhs_min,
            "max_abs": r.rhs_max,
        },
        "suspicious_bigm": sorted(set(r.bigm_values), reverse=True),
        "flags": [
            {"severity": sev, "message": msg, "reference": ref}
            for sev, msg, ref in r.flags
        ],
    }


def render_text(r: ScanResult) -> str:
    cmin = "n/a" if not math.isfinite(r.coeff_min) else f"{r.coeff_min:.3g}"
    rmin = "n/a" if not math.isfinite(r.rhs_min) else f"{r.rhs_min:.3g}"
    ratio = "n/a" if r.coeff_ratio == 0 else f"{r.coeff_ratio:.2e}"
    out = []
    out.append("=" * 64)
    out.append(f" lp_scan — {r.fmt} model")
    out.append("=" * 64)
    out.append(f" Rows (constraints) : {r.n_rows}")
    out.append(f" Variables          : {r.n_vars}  "
               f"(continuous {r.n_continuous}, integer {r.n_integer}, binary {r.n_binary})")
    out.append(f" Nonzero coeffs      : {r.n_nonzeros}")
    out.append(f" |Coefficient| range : {cmin} … {r.coeff_max:.3g}   (ratio {ratio})")
    out.append(f" |RHS| range         : {rmin} … {r.rhs_max:.3g}")
    if r.bigm_values:
        vals = ", ".join(f"{v:.3g}" for v in sorted(set(r.bigm_values), reverse=True)[:10])
        out.append(f" Big-M candidates    : {vals}")
    out.append("-" * 64)
    order = {"HIGH": 0, "MED": 1, "LOW": 2, "OK": 3}
    for sev, msg, ref in sorted(r.flags, key=lambda f: order.get(f[0], 9)):
        marker = {"HIGH": "‼", "MED": "▲", "LOW": "•", "OK": "✓"}.get(sev, "-")
        out.append(f" [{sev:<4}] {marker} {msg}")
        if ref and ref != "—":
            out.append(f"          → see {ref}")
        out.append("")
    return "\n".join(out).rstrip()


def detect_and_scan(path: str, text: str) -> ScanResult:
    lower = path.lower()
    if lower.endswith(".mps") or _looks_like_mps(text):
        return scan_mps(text)
    return scan_lp(text)


def _looks_like_mps(text: str) -> bool:
    head = text[:4000].upper()
    return "ROWS" in head and "COLUMNS" in head and "NAME" in head.split("\n")[0]


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Pre-solve health check for an LP/MPS model file.")
    p.add_argument("model", help="path to a .lp or .mps file")
    p.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = p.parse_args(argv)

    try:
        with open(args.model, "r", errors="replace") as fh:
            text = fh.read()
    except OSError as exc:
        print(f"error: cannot read {args.model}: {exc}", file=sys.stderr)
        return 2

    r = detect_and_scan(args.model, text)
    analyze(r)

    if args.json:
        print(json.dumps(to_dict(r), indent=2))
    else:
        print(render_text(r))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
