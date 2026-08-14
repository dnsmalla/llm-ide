# Method Selection Logic & Extended Method Catalog

The decision logic that turns the answers from `diagnostic-questions.md` into a concrete recommendation, plus a catalog of methods that go beyond the basics in `problem-catalog.md`, `decomposition.md`, and `metaheuristics.md`. Use it as a reasoning scaffold, not a rigid script — real problems blend categories.

## Table of Contents

1. [Problem-Class Decision Tree](#1-problem-class-decision-tree)
2. [Formulation-Strength Ladder](#2-formulation-strength-ladder)
3. [Solver Selection Logic](#3-solver-selection-logic)
4. [Exact vs Heuristic Decision](#4-exact-vs-heuristic-decision)
5. [Decomposition Trigger Logic](#5-decomposition-trigger-logic)
6. [The Acceleration Ladder (Slow MIP)](#6-the-acceleration-ladder-slow-mip)
7. [Matheuristics (MIP-Based Heuristics)](#7-matheuristics-mip-based-heuristics)
8. [Multi-Objective Optimization](#8-multi-objective-optimization)
9. [Black-Box & Surrogate Optimization](#9-black-box--surrogate-optimization)
10. [Method Glossary (Quick Pointers)](#10-method-glossary-quick-pointers)

---

## 1. Problem-Class Decision Tree

```
Can you evaluate the objective with a formula?
├── NO (need a simulation / external model) ──► black-box: metaheuristics or
│                                               Bayesian/surrogate optimization (§9)
└── YES
    ├── All variables continuous?
    │   ├── Objective & constraints linear ───────────────► LP
    │   ├── Convex quadratic objective, linear constr. ───► QP (epigraph if written as =, antipatterns §18)
    │   ├── Norm / second-order cone constraints ─────────► SOCP
    │   ├── PSD matrix variable ──────────────────────────► SDP
    │   └── Non-convex / products / general nonlinear ────► NLP / global (BARON, Couenne)
    └── Some variables integer/binary?
        ├── Linear ──────────────────────────────────────► MIP / MILP
        ├── + convex quadratic ───────────────────────────► MIQP / MISOCP
        ├── + non-convex nonlinear ───────────────────────► MINLP (spatial B&B / global)
        └── Heavy logic / scheduling / no-overlap /
            all-different / cumulative ───────────────────► CP-SAT (consider FIRST, solvers §4)
```

Cross-checks: combinatorial signature (routing, packing, covering, sequencing) → jump to the named model in `problem-catalog.md`. Logical conditions in an otherwise-MIP model → keep MIP but model them well (`modeling-techniques.md` §3, §8). Real coefficients headed to CP-SAT → scale to integers (`antipatterns.md` §7).

## 2. Formulation-Strength Ladder

When the LP relaxation is loose, climb this ladder before touching solver parameters — a tighter formulation usually beats any amount of tuning.

1. **Disaggregate** weak aggregate constraints (`Σx ≤ M·y` → `x ≤ y`). (`modeling-techniques.md` §1)
2. **Tighten Big-M / switch to indicators or SOS1.** (`modeling-techniques.md` §2, §8, §9)
3. **Add known valid inequalities / cuts** for the structure (cover, flow-cover, comb, RCI, clique). (`decomposition.md` §4.2)
4. **Break symmetry** (lex ordering, fix-first, orbital). (`modeling-techniques.md` §5)
5. **Use an extended / reformulated model** (set-partitioning, time-indexed, flow-based, convex hull of a substructure) when the compact one is inherently weak. (`modeling-techniques.md` §7)

Invest where it pays: a strong formulation matters most when the relaxation gap is what's driving the search-tree size.

## 3. Solver Selection Logic

```
Problem class → license? → scale → pick
  LP large/sparse        : Gurobi/COPT/Mosek (IPM) | OSS: HiGHS
  MIP general            : Gurobi/COPT | OSS: HiGHS, SCIP
  Scheduling/CP/logic    : OR-Tools CP-SAT (integer coeffs!) | CP Optimizer
  Convex QP/SOCP         : Mosek/Gurobi/COPT | OSS: ECOS/SCS/Clarabel (via CVXPY)
  SDP                    : Mosek/COPT-SDP/SDPA | OSS: SCS/COSMO
  Non-convex (MI)NLP     : Gurobi (NonConvex=2)/BARON | OSS: SCIP/Couenne
  Large routing          : OR-Tools Routing | HGS-CVRP/FILO2/LKH-3 | VROOM (real-time)
  Black-box/business VRP : Hexaly | OptaPlanner/Timefold | custom ALNS
```
Then filter by: **commercial use** (→ HiGHS/SCIP/CBC/OR-Tools only), **stack** (Julia → JuMP; convex DSL → CVXPY), **re-solve frequency** (warm-startable simplex), and **team maintainability**. Full detail and licensing in `solvers.md`. Never assert a single "fastest" solver — it's instance-dependent (`benchmarks.md` §10).

## 4. Exact vs Heuristic Decision

Rough thresholds (problem-dependent — validate on your instances):

| Problem | Exact is realistic up to | Beyond that, use |
|---|---|---|
| TSP | thousands (Concorde/LKH near-exact much larger) | LKH-3, OR-Tools |
| CVRP/VRPTW | ~50-100 customers (branch-and-price) | OR-Tools Routing, HGS-CVRP, FILO2, ALNS |
| Job-shop | small-medium (CP-SAT pushes this far) | CP-SAT, then metaheuristics |
| Generic MIP | until the gap stalls in your time budget | matheuristics (§7), decomposition (§5) |
| Black-box | never (no model) | metaheuristics, Bayesian opt (§9) |

Decision rule: **need a proof of optimality?** exact. **Need a good plan inside a hard time budget at scale?** heuristic/matheuristic. When unsure, run exact for a fixed budget to get a bound, then a heuristic to get quality, and report both.

## 5. Decomposition Trigger Logic

Decompose when a single monolithic solve won't fit the size/time budget. Pick the axis from the structure (full treatment: `decomposition.md` §6):

```
Time/stage structure?            → rolling horizon (carry state across windows)
Hierarchy (region→site, etc.)?   → granularity decomposition (coarse → fine)
Block-diagonal + linking?
   linked by constraints         → Benders / logic-based Benders
   linked by columns/variables   → Dantzig-Wolfe / column generation
   linked by shared resources    → Lagrangian relaxation
Many layered priorities?         → constraint-strength decomposition (add by priority)
```
Decomposition is a design choice, not technical debt (Principle 11). Combine axes freely (e.g., rolling horizon with a Benders subproblem per window).

## 6. The Acceleration Ladder (Slow MIP)

Apply in order — earlier rungs dominate later ones. *Don't discuss speed before a feasible solution exists* (`antipatterns.md` §21).

1. **Get any feasible solution**: `MIPFocus=1`, warm start / MIP start, primal heuristics, `NoRelHeurTime`.
2. **Read the log** (presolve reduction, root gap, nodes, cuts) before changing anything (`parameter-tuning.md` §2).
3. **Strengthen the formulation** (§2 ladder) — usually the biggest win.
4. **Tune deliberately**: `MIPFocus`, `Cuts`, `Heuristics`, `Presolve`, `Threads`, numerical focus. `grbtune` last.
5. **Add a matheuristic** (§7) to drive the primal side.
6. **Decompose** (§5) if it still won't fit.
7. **Switch paradigm** (MIP → CP-SAT for scheduling; exact → metaheuristic for routing).

## 7. Matheuristics (MIP-Based Heuristics)

Heuristics that call a MIP solver on restricted subproblems — they bridge "exact but too slow" and "heuristic but ad hoc". Powerful when you have a good model that just won't solve to optimality at scale.

- **Fix-and-optimize**: fix most variables to incumbent values, re-optimize a small free subset; rotate the subset. Great for scheduling/lot-sizing.
- **Relax-and-fix**: solve in chunks (e.g., by time period), fixing earlier chunks before solving later ones. Natural for multi-period MIPs.
- **Local branching** (Fischetti & Lodi 2003, *Math. Prog.* 98:23-47): add a constraint bounding the Hamming distance from the incumbent to define a MIP-solvable neighborhood.
- **RINS / RENS** (Danna et al. 2005): explore the neighborhood where the incumbent and the LP relaxation agree; built into Gurobi/CPLEX heuristics.
- **Proximity search** (Fischetti & Monaci 2014): replace the objective with a proximity term to the incumbent and re-solve — strong for feasibility-hard models.
- **Feasibility pump** (Fischetti, Glover, Lodi 2005): alternately round and project to chase a first feasible solution.
- **Kernel search** (Angelelli, Mansini, Speranza 2010): build a "kernel" of promising variables, add buckets of others incrementally.
- **MIP-based large neighborhood search**: destroy part of a solution, re-optimize the hole with the exact solver (ALNS where the repair operator is a MIP).

Many of these are partly automated inside commercial solvers — but hand-built versions exploiting your structure routinely beat the generic ones.

## 8. Multi-Objective Optimization

When "best" has several dimensions (cost vs service vs risk):

- **Weighted sum**: combine into one objective with weights. Simple; only finds supported (convex-hull) solutions; weight choice is delicate (watch scaling — see numerical conditioning).
- **Lexicographic / preemptive**: optimize objective 1, fix it (or bound it), then objective 2, etc. Gurobi/CPLEX support hierarchical objectives natively. Use when priorities are strict.
- **ε-constraint**: optimize one objective, move the others to constraints with bounds ε; sweep ε to trace the Pareto front. Finds non-supported solutions too.
- **Goal programming**: minimize weighted deviations from target levels for each goal — natural when stakeholders state targets rather than weights.
- **Pareto / evolutionary**: NSGA-II/III, MOEA/D, SMS-EMOA (pymoo, jMetal) when you want the whole front and the model is heuristic-friendly.

Decision: strict priorities → lexicographic; want the trade-off curve → ε-constraint or evolutionary; stakeholders give targets → goal programming; quick single answer → weighted sum (and sanity-check the weights).

## 9. Black-Box & Surrogate Optimization

When evaluating a candidate requires a simulation or an external model (no algebraic objective):

- **Metaheuristics** (SA/TS/GA/ALNS) over the decision encoding — robust, parallelizable (`metaheuristics.md`).
- **Bayesian / surrogate optimization** (Gaussian-process or TPE surrogates; Optuna, BoTorch, scikit-optimize): sample-efficient for expensive evaluations and modest dimensionality — ideal for hyperparameter-style tuning and simulation knobs.
- **Derivative-free / direct search** (Nelder-Mead, pattern search, CMA-ES) for continuous black boxes.
- **Hybrid**: use a cheap surrogate model to screen candidates, then evaluate survivors with the true simulation. (`practice-wisdom.md` §7)

Decision: very expensive evaluations + few variables → Bayesian; cheap evaluations + combinatorial structure → metaheuristics; smooth continuous black box → CMA-ES / direct search.

## 10. Method Glossary (Quick Pointers)

- **Branch-and-cut / -price / Branch-Cut-and-Price (BCP)** — exact MIP backbone; BCP is SOTA for VRP. (`decomposition.md`)
- **Dantzig-Wolfe decomposition** — the column-generation dual of Lagrangian; reformulate via extreme points of a substructure.
- **Logic-based Benders** (Hooker) — Benders where the subproblem is a feasibility/inference problem (e.g., scheduling) rather than an LP.
- **Constraint propagation / global constraints** — the engine behind CP-SAT's strength (`all_different`, `cumulative`, `circuit`, `table`).
- **Column generation stabilization** — dual smoothing, in-out, boxstep (`decomposition.md` §2.4).
- **Cutting planes** — Gomory/MIR/cover/flow-cover/clique/{0,½}; usually leave to the solver, add problem-specific ones by hand.
- **Lagrangian heuristic** — derive a feasible solution from the relaxed subproblem solution (`decomposition.md` §3.4).
- **Rolling horizon / receding horizon** — solve a window, commit the head, advance (`decomposition.md` §6.1).
- **Warm starting** — reuse a basis (simplex) or an incumbent (MIP start) across re-solves; large speedups for repeated solves.
- **Learned methods** — learning-to-branch, neural diving, NCO — niche, for many-similar-instance regimes (`modern-advances.md` §2-3).
