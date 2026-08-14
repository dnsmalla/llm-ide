# Solver Selection Guide

Recommendations by problem type, licensing, Python APIs, strengths and weaknesses.

## Table of Contents

1. [Problem Type Recommendation Map](#1-problem-type-recommendation-map)
2. [Commercial MIP Solvers](#2-commercial-mip-solvers)
3. [Open Source MIP Solvers](#3-open-source-mip-solvers)
4. [CP / CP-SAT](#4-cp--cp-sat)
5. [Heuristics-Only Libraries](#5-heuristics-only-libraries)
6. [Modeling Languages & Python Libraries](#6-modeling-languages--python-libraries)
7. [Japanese Solvers](#7-japanese-solvers)
8. [Benchmark Landscape](#8-benchmark-landscape)

---

## 1. Problem Type Recommendation Map

| Problem Type | First Recommendation | Alternative |
|---|---|---|
| Pure LP (large sparse matrix) | Gurobi / COPT / Mosek (IPM) | HiGHS, CPLEX |
| General MIP | Gurobi / COPT | CPLEX, Xpress, SCIP (OSS) |
| Pure scheduling (no-overlap, cumulative) | **OR-Tools CP-SAT** | CP Optimizer, Gurobi |
| VRP (practical scale) | OR-Tools Routing, HGS-CVRP, VROOM | Gurobi + branch-and-price |
| Convex QP | Mosek, Gurobi, COPT | CPLEX |
| Non-convex QP / QCQP | Gurobi 11+ (NonConvex=2), BARON | Couenne, SCIP, ANTIGONE |
| SOCP | Mosek, Gurobi, COPT | ECOS, SCS |
| SDP | Mosek, COPT-SDP, SDPA | SCS, COSMO |
| MINLP (non-convex) | BARON, Couenne, Gurobi 11+ | SCIP, ANTIGONE |
| Constraint satisfaction (pure) | OR-Tools CP-SAT, MiniZinc | Choco, Gecode |
| Black-box metaheuristics | Hexaly, OptaPlanner/Timefold | Custom ALNS |
| OSS for MIP | HiGHS / SCIP | CBC, GLPK |

---

## 2. Commercial MIP Solvers

### 2.1 Gurobi
- Official: https://www.gurobi.com/ ; docs: https://docs.gurobi.com/
- Fastest-class MIP. `gurobipy` is the standard Python API.
- Academic license free (no commercial use). Web License has restrictions in commercial environments, NamedUser/Cluster Manager sometimes required.
- Features:
  - **Lazy/User cut callback** (Lazy constraints): standard for TSP SEC, VRP RCI
  - **Multi-Scenario**: multiple scenarios in one model
  - **Multi-Objective**: hierarchical / weighted
  - **Tuning Tool** (`grbtune`): automatic parameter search
  - **Distributed MIP / Compute Server**
- Major version information:
  - Gurobi 9+: non-convex QP / spatial B&B with `NonConvex=2`
  - Gurobi 11+: significant speedup for convex QP/QCP
  - Gurobi 12 (Dec 2024): exact nonlinear constraints via `addGenConstrNL`, superseding the older piecewise-approximation function-constraint API (verify against installed-version docs)

### 2.2 IBM CPLEX
- Long-standing, stable. docplex (Python) and `cplex` API.
- Free access via IBM Academic Initiative.
- Features: indicator constraint, SOS, conflict refiner, CP Optimizer also included.

### 2.3 FICO Xpress
- Centered in North America. `xpress` Python API.
- Highly rated for large sparse problems. Mosel modeling language.

### 2.4 Mosek
- Strong in convex QP / SOCP / SDP / Exponential cone.
- `mosek.fusion` (high-level Python API), `mosek` (low-level).
- Standard for portfolio optimization and machine learning (CVXPY backend).

### 2.5 COPT (Cardinal Optimizer)
- Cardinal Operations (Cardinal Tech).
- Leads in many Mittelmann benchmark categories (LP, MILP, SDP, SOCP, NLP) — reported in INFORMS 2025 talk (Mittelmann).
- Academic free, commercial paid.

### 2.6 Hexaly (formerly LocalSolver)
- Black-box metaheuristics + mathematical programming hybrid.
- Popular for large-scale business-size VRP / scheduling.
- Commercial, French origin.

---

## 3. Open Source MIP Solvers

### 3.1 HiGHS
- Official: https://highs.dev/
- Q. Huangfu, J. A. J. Hall, "Parallelizing the dual revised simplex method," *Math. Prog. Computation* 10(1):119-142, 2018, DOI 10.1007/s12532-017-0130-5.
- Team: Qi Huangfu (dual simplex), Lukas Schork (IPM), Michael Feldmeier (QP), Leona Gottwald (MIP), Julian Hall (project lead).
- License: MIT
- **Default solver for `linprog` and `intlinprog` in MATLAB R2024a and later** (MathWorks official blog 2024-03-26)
- Supports LP, MIP, QP. Leading open-source LP/MIP solver.

### 3.2 SCIP
- Official: https://www.scipopt.org/
- T. Achterberg, "SCIP: solving constraint integer programs," *Math. Prog. Computation* 1(1):1-41, 2009.
- CIP (Constraint Integer Programming) framework. Extensible via plugins for cuts/heuristics/branching.
- Python: `PySCIPOpt` (https://github.com/scipopt/PySCIPOpt)
- License: free for non-commercial, commercial is paid (ZIB).
- Latest: SCIP Optimization Suite 10.0 (2025).

### 3.3 CBC (COIN-OR Branch and Cut)
- COIN-OR project. Default solver for PuLP.
- License: EPL
- Handles medium-scale MIP, slower than commercial solvers.

### 3.4 GLPK
- Lightweight, educational use.
- License: GPL
- Not recommended for large-scale problems.

### 3.5 Bonmin / Couenne (COIN-OR)
- Bonmin: convex MINLP
- Couenne: spatial branch-and-bound for non-convex MINLP

---

## 4. CP / CP-SAT

### 4.1 OR-Tools CP-SAT
- Official: https://developers.google.com/optimization
- Led by Laurent Perron, Google. SAT + CP + LP hybrid.
- **MiniZinc Challenge 2024 official results** (https://www.minizinc.org/challenge/2024/results/): gold medal in all 4 categories (Fixed / Free / Parallel / Open), consecutive gold medals across all categories from 2019-2024.
- Global constraints: `AddNoOverlap`, `AddCumulative`, `AddCircuit`, `AddMultipleCircuit`, `AddAllDifferent`, `AddElement`, `AddInverse`, `AddReservoirConstraint`, `AddAutomaton`, etc.
- **All coefficients must be integers**. For real numbers, scale by ×10⁴ or similar.
- Scheduling (no-overlap, cumulative, disjunctive) is often orders of magnitude faster than MIP.

#### CP-SAT Representative Syntax
```python
from ortools.sat.python import cp_model
model = cp_model.CpModel()

# integer var
x = model.NewIntVar(0, 100, 'x')

# interval var (start, size, end)
start = model.NewIntVar(0, horizon, 'start')
end = model.NewIntVar(0, horizon, 'end')
interval = model.NewIntervalVar(start, duration, end, 'interval')

# global constraints
model.AddNoOverlap([interval1, interval2, interval3])
model.AddCumulative(intervals, demands, capacity)

# logic
model.AddBoolOr([a, b, c])
model.AddImplication(a, b)
model.Add(x + y == 10).OnlyEnforceIf(b)

# objective
model.Minimize(makespan)

solver = cp_model.CpSolver()
solver.parameters.num_search_workers = 8     # portfolio parallel
solver.parameters.max_time_in_seconds = 60
solver.parameters.log_search_progress = True
status = solver.Solve(model)
```

#### CP-SAT Primer (Krupke)
- https://d-krupke.github.io/cpsat-primer/
- Best explanation for practical use. Japanese translation also exists in the community.

### 4.2 IBM CP Optimizer
- Commercial, powerful for scheduling (`IntervalVar`, `SequenceVar`).
- Accessible via docplex (Python).
- Fusion of automated heuristics and CP.

### 4.3 Choco / Gecode / MiniZinc
- Academic CP. Choco is Java, Gecode is C++.
- MiniZinc is a CP modeling language, compilable to multiple solvers. Challenge platform.

### 4.4 OR-Tools Routing
- VRP-specialized API (separate from CP-SAT).
- GLS (Guided Local Search) / Tabu / SA built-in.
- Widely used in real-time dispatch/delivery applications.

---

## 5. Heuristics-Only Libraries

### 5.1 OptaPlanner / Timefold
- Java, Apache 2.0 (Timefold is a fork of OptaPlanner, actively developed).
- Tabu / LNS / SA configurable.
- VRP, employee rostering, school timetabling, conference scheduling.

### 5.2 HGS-CVRP (Vidal)
- C++. Hybrid Genetic Search.
- SOTA solutions for CVRP/VRPTW/MDVRP. Updates many best-known solutions in CVRPLIB.
- https://github.com/vidalt/HGS-CVRP

### 5.3 VROOM
- C++, fast VRP OSS.
- Strong in real-time dispatch. https://github.com/VROOM-Project/vroom

### 5.4 Python ALNS (Wouda)
- `pip install alns`
- ALNS framework for Python. Combinable standard operators + custom operators.

### 5.5 pymoo
- Multi-objective optimization (NSGA-II, NSGA-III, MOEA/D, SMS-EMOA).
- https://pymoo.org/

### 5.6 jMetal / jMetalPy
- Multi-objective evolutionary computation, Java and Python implementations.

### 5.7 ParadisEO
- C++, research framework for metaheuristics.

### 5.8 LKH-3 (Helsgaun)
- Ultra-high-quality heuristics for TSP / VRP / ATSP (TSP is second only to Concorde in strength, exact-like).
- Free for academic use.

---

## 6. Modeling Languages & Python Libraries

### 6.1 Dedicated Modeling Languages
- **AMPL** (https://ampl.com/): established, powerful, Python API available
- **GAMS**: entrenched in economics and energy sectors
- **MPL**: Maximal Software

### 6.2 Python Libraries
| Library | Features | Solvers |
|---|---|---|
| **gurobipy** | Gurobi official, fastest API | Gurobi only |
| **docplex** | CPLEX official | CPLEX |
| **Pyomo** | Multi-featured, general-purpose, research-oriented | Gurobi/CPLEX/GLPK/CBC/HiGHS/SCIP/Bonmin/Couenne, etc. |
| **PuLP** | Simple, educational | CBC (default)/Gurobi/CPLEX/GLPK, etc. |
| **python-mip** | Lighter than Pyomo, CBC included | CBC/Gurobi |
| **CVXPY** | Convex optimization DSL, disciplined convex programming | Mosek/Gurobi/ECOS/SCS/CLARABEL/COPT |
| **OR-Tools** | Google, CP-SAT and Routing | Proprietary engines |

### 6.3 Julia
- **JuMP** (https://jump.dev/): modern and fast, rapidly increasing popularity in optimization research.
- Supports many commercial and open-source solvers.
- Competitor to Pyomo, but powerful when combined with Julia's REPL/macros.

### 6.4 R
- ROI (R Optimization Infrastructure), ompr. Occasionally used in economics and statistics.

### 6.5 Selection Guide
- **Serious business development**: gurobipy directly (speed) or Pyomo (solver portability)
- **Papers / Research**: Pyomo or JuMP
- **Education / Prototyping**: PuLP
- **Convex optimization focused**: CVXPY
- **CP / Scheduling**: OR-Tools CP-SAT

---

## 7. Japanese Solvers

### 7.1 Nuorium Optimizer (NTT DATA Mathematical Systems)
- Official: https://www.msi.co.jp/solution/nuopt/top.html
- Formerly Numerical Optimizer. **Renamed in V24 (2022/3/28)**, **V26 (2024/3/28) is the latest major version**.
- Modeling languages: C++SIMPLE / PySIMPLE / RSIMPLE
- Supports: LP/MILP/CMIQP/CQP/CP/NLP/SDP/NLSDP/WCSP/RCPSP
- Adoption cases: JR East (automatic work schedule creation), Lion (production planning), Azbil U-OPT (thermal source and power plant)
- Technical dissemination: msiism.jp (V26 new features, weighted local search, 2D Strip Packing, etc.)

### 7.2 Other Domestic / Domestic Support Solvers
- **Webcrow / Algorithm Research** various commercial optimization services
- **GRID** (Grid Inc., in-house solutions with Gurobi-based customization)

---

## 8. Benchmark Landscape

### 8.1 Mittelmann Benchmarks
- Official: https://plato.asu.edu/bench.html
- Independent LP/MILP/SDP/SOCP/NLP comparison operated by Hans D. Mittelmann (Arizona State Univ.).
- Official page verbatim: "In August 2024 Gurobi decided to withdraw from the benchmarks as well and their results have been removed."
- MindOpt also withdrew on 2024/12/24.
- In INFORMS 2025 talk (Mittelmann), COPT leads in many LP/MILP/SDP/SOCP/NLP categories.

### 8.2 Caveats
- Benchmark results **vary by instance**, changing rankings. Claims like "Gurobi fastest" or "COPT fastest" apply only to specific benchmarks and specific instance sets.
- Determine relevance based on whether your business problem resembles benchmark instances or not. If possible, **comparing with representative instances on hand** using trial versions of license solvers is optimal.

### 8.3 MIPLIB Submission
- If your problem is "open" (unsolved), submitting to MIPLIB allows many researchers to attempt it.
- Submission: https://miplib.zib.de/submit.html
