#!/usr/bin/env python3
"""Self-contained tests for lp_scan.py — run `python scripts/test_lp_scan.py`.

No third-party dependencies; uses only the standard library. Exits non-zero on
the first failed assertion so it can gate changes to the scanner.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lp_scan as L  # noqa: E402

PASS = 0


def check(name, cond):
    global PASS
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        print(f"FAIL  {name}")
        sys.exit(1)


CLEAN_LP = """Maximize
 3 x + 2 y
Subject To
 c1: x + y <= 4
 c2: x + 3 y <= 6
Bounds
 x >= 0
 y >= 0
End
"""

BIGM_LP = """Minimize
 obj: Cmax
Subject To
 c1: s_1 - s_2 + 1000000 z_12 <= 999999
 c3: 0.0000005 x_1 + 250000 y_1 <= 250000
 c4: Cmax - s_1 >= 5
Bounds
 0 <= s_1 <= 100
Binaries
 z_12 y_1 y_2 y_3
General
 Cmax
End
"""

TINY_MPS = """NAME          TEST
ROWS
 N  COST
 L  C1
 G  C2
COLUMNS
    MARKER                 'MARKER'                 'INTORG'
    X1        COST          1.0        C1            1.0
    X1        C2            1.0
    MARKER                 'MARKER'                 'INTEND'
    X2        COST          2.0        C1            1.0
    X2        C2          100000.0
RHS
    RHS       C1            4.0        C2            1.0
BOUNDS
 BV BND       X1
ENDATA
"""

GARBAGE = "this is not a model file at all\n123 456\n"


def run(text, mps=False):
    r = L.scan_mps(text) if mps else L.scan_lp(text)
    L.analyze(r)
    return r


def severities(r):
    return {f[0] for f in r.flags}


print("clean LP:")
r = run(CLEAN_LP)
check("2 variables", r.n_vars == 2)
check("2 rows", r.n_rows == 2)
check("no high/med flags (OK only)", severities(r) == {"OK"})
check("coeff ratio small", r.coeff_ratio < 10)

print("Big-M / wide-range LP:")
r = run(BIGM_LP)
check("8 variables", r.n_vars == 8)
check("4 binaries", r.n_binary == 4)
check("1 general integer", r.n_integer == 1)
check("high-severity flag present", "HIGH" in severities(r))
check("detected a big-M candidate >= 1e6", any(v >= 1e6 for v in r.bigm_values))
check("coeff ratio flagged as huge", r.coeff_ratio > L.RATIO_WARN)

print("MPS with integer marker + binary bound:")
r = run(TINY_MPS, mps=True)
check("2 variables", r.n_vars == 2)
check("1 binary (BV)", r.n_binary == 1)
check("2 rows", r.n_rows == 2)
check("100000 flagged", any(abs(v - 1e5) < 1 for v in r.bigm_values))

print("garbage input degrades gracefully:")
r = run(GARBAGE)
check("no rows", r.n_rows == 0)
check("no variables counted from junk", r.n_vars == 0)
check("did not crash, produced a flag", len(r.flags) >= 1)

print("round-constant heuristic:")
check("1e6 is bigm-like", L._is_round_bigm(1e6))
check("5e5 is bigm-like", L._is_round_bigm(5e5))
check("999999 is bigm-like", L._is_round_bigm(999999))
check("4321 is NOT bigm-like", not L._is_round_bigm(4321))
check("12345 is NOT bigm-like", not L._is_round_bigm(12345))

print(f"\nAll {PASS} checks passed.")
