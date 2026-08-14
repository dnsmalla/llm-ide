# Domain-Specific Interview Library

Tailored diagnostic question batteries for the problem families that show up most in practice. The generic framework lives in `diagnostic-questions.md`; this file is what to ask *once you recognize the domain*. Each section gives a **signature** (how to spot it), the **questions that matter for that domain** (with what each reveals), and the **likely model / pitfalls / route**.

Use 3-5 of the most decision-relevant questions per domain — don't read the whole battery aloud. Stop once you can pick the formulation and solver.

## Table of Contents

1. [Routing & Delivery (VRP family)](#1-routing--delivery-vrp-family)
2. [Machine & Project Scheduling](#2-machine--project-scheduling)
3. [Workforce / Shift Rostering](#3-workforce--shift-rostering)
4. [Production Planning & Lot-Sizing](#4-production-planning--lot-sizing)
5. [Facility Location & Network Design](#5-facility-location--network-design)
6. [Inventory & Supply Chain](#6-inventory--supply-chain)
7. [Blending & Process Optimization](#7-blending--process-optimization)
8. [Cutting Stock & Packing](#8-cutting-stock--packing)
9. [Assignment & Matching](#9-assignment--matching)
10. [Portfolio & Financial](#10-portfolio--financial)
11. [Energy & Unit Commitment](#11-energy--unit-commitment)

---

## 1. Routing & Delivery (VRP family)

**Signature**: vehicles/drivers visiting locations; "routes", "deliveries", "fleet", "depot", drive times.

**Ask:**
- "How many stops per day, and how many vehicles/drivers?" → sets exact-vs-heuristic (>~100 stops ⇒ heuristic; `method-selection.md` §4).
- "One depot or several? Do vehicles return to the depot?" → CVRP vs multi-depot vs open VRP.
- "Are there **time windows**, and are they hard or soft?" → VRPTW; soft windows change the objective.
- "Capacity limits — weight, volume, or both? Multiple compartments?" → CVRP / multi-dimensional capacity.
- "Pickups and deliveries paired (same vehicle, pickup before drop)?" → PDPTW (precedence + coupling).
- "Where do travel times come from — Euclidean, a matrix, or live traffic? Symmetric?" → data quality; asymmetric → ATSP-like.
- "Driver shift limits, breaks, skills, or vehicle-stop compatibility?" → rich real-world side constraints.
- "Re-optimize through the day (dynamic) or plan once overnight?" → real-time (VROOM/OR-Tools) vs batch.

**Likely model / route**: small & exact → set-partitioning + branch-and-price; practical scale → OR-Tools Routing, HGS-CVRP, FILO2, ALNS. **Pitfalls**: trying exact 3-index MIP at 300 stops (`antipatterns.md` §13); ignoring asymmetric times. Refs: `problem-catalog.md` §4, `solvers.md`, `modern-advances.md` §5.

## 2. Machine & Project Scheduling

**Signature**: tasks/operations on machines/resources over time; "makespan", "due dates", "no two jobs at once", "setup times".

**Ask:**
- "Does each job follow a fixed machine sequence (job-shop), the same sequence (flow-shop), or any order (open-shop)?"
- "Objective — minimize makespan, total tardiness, weighted completion, or number of late jobs?" → drives formulation choice.
- "Can a task run on one machine only, or pick among several (flexible)?" → FJSP.
- "Sequence-dependent **setup times**? Release dates, deadlines, precedences?" → these dominate real instances.
- "Are durations integer (or can they be scaled to integers)?" → gate for CP-SAT.
- "Renewable resources with capacity (people, cranes) shared across tasks?" → RCPSP (cumulative).
- "Preemption allowed, or must a task run start-to-finish?"

**Likely model / route**: **consider CP-SAT first** (`IntervalVar` + `AddNoOverlap`/`AddCumulative`) — it dominates MIP on most practical scheduling (`solvers.md` §4, Principle 3). MIP via Manne disjunctive only for small/learning cases. **Pitfalls**: time-indexed MIP with a fine grid (variable blow-up); loose disjunctive Big-M (`antipatterns.md` §1). Refs: `problem-catalog.md` §5.

## 3. Workforce / Shift Rostering

**Signature**: assigning people to shifts/days; "coverage", "rest rules", "fairness", "preferences", "skills".

**Ask:**
- "What's the planning horizon and shift granularity (days, 8h shifts, 30-min slots)?"
- "Coverage requirements — exact headcount per shift, or a minimum?" → hard demand vs soft.
- "Legal/contractual rules: max hours/week, minimum rest between shifts, max consecutive days?" → mostly hard (regulation).
- "Skills/qualifications — can anyone cover any shift, or must certain roles be present?"
- "Preferences and fairness — are these soft goals, and how do we weigh them against each other?" → soft-constraint weights (`gurobi-gurobipy-guide.md` §5-6).
- "Is there an existing roster to stay close to (operators dislike churn)?" → add a proximity/anchor term.
- "Self-scheduling/bidding, or fully solver-assigned?"

**Likely model / route**: MIP with binary assign[employee, shift]; or set-covering of pre-generated feasible shift patterns + column generation at scale. CP-SAT also strong. **Pitfalls**: treating soft preferences as hard → infeasibility (`practice-wisdom.md` §1); symmetry among identical employees (`modeling-techniques.md` §5). Refs: `problem-catalog.md` §7, `benchmarks.md` (nurse rostering).

## 4. Production Planning & Lot-Sizing

**Signature**: how much to make/when; "lot sizes", "setups", "inventory holding", "backorders", multi-period.

**Ask:**
- "What's the time bucket (shift, day, week) and horizon length?" → multi-period; rolling horizon at scale.
- "Is there a **setup** cost/time when switching products, and does setup state carry across periods?" → CLSP/CLSP-SC (the hard part).
- "Single machine/line or several in parallel? Capacity per period?"
- "Are backorders/lost sales allowed, or must demand be met every period?" → soft vs hard demand.
- "Minimum lot sizes, batch multiples, shelf-life/perishability?"
- "Deterministic demand or forecast with uncertainty?" → stochastic/robust (`problem-catalog.md` §11).

**Likely model / route**: lot-sizing MIP (facility-location-style "shortest-path" reformulation is much tighter than the natural one — a classic strong-formulation win); rolling horizon for long horizons (`decomposition.md` §6.1); relax-and-fix matheuristic (`method-selection.md` §7). **Pitfalls**: weak natural formulation with loose setup Big-M; ignoring setup carryover. Refs: `modeling-techniques.md` §1, `decomposition.md`.

## 5. Facility Location & Network Design

**Signature**: which sites to open / links to build, and how to serve demand; "open warehouses", "coverage", "fixed cost vs transport cost".

**Ask:**
- "Are facilities capacitated, or can an open facility serve unlimited demand?" → CFLP vs UFL (changes formulation strength a lot).
- "Fixed number of facilities (p-median/p-center) or pay a fixed cost per open one?"
- "Is the goal min total cost, max coverage within a distance, or worst-case distance (center)?"
- "Single-sourcing (each customer one facility) or split allowed?" → binary vs continuous assignment.
- "Multi-echelon (plants → DCs → customers)? Multi-commodity?"
- "Strategic one-off study, or re-run as data changes?"

**Likely model / route**: **use the disaggregated (strong) formulation** `x_ij ≤ y_j` — for UFL the LP relaxation is often integer-optimal (`modeling-techniques.md` §1, `problem-catalog.md` §6). Capacitated → flow-cover cuts or Benders (`decomposition.md`). **Pitfalls**: the aggregated `Σx ≤ M·y` weak formulation (`antipatterns.md` §2). 

## 6. Inventory & Supply Chain

**Signature**: stock levels, reorder timing, multi-location flow; "safety stock", "service level", "replenishment", "echelons".

**Ask:**
- "Deterministic or stochastic demand? What service level / fill rate is required?" → drives safety-stock and whether it's an optimization or an inventory-policy question.
- "Review policy — continuous (s,S)/(Q,r) or periodic?"
- "Single location or a network with transshipment between sites?"
- "Lead times — fixed or variable? Capacity on replenishment?"
- "Is this a planning model (flows/quantities) or a policy-parameter model (set s, S)?" → MIP/LP vs simulation-optimization.
- "Perishability, multi-echelon coupling, joint replenishment?"

**Likely model / route**: deterministic multi-echelon flow → LP/MIP min-cost-flow style; stochastic policy tuning → simulation + Bayesian/metaheuristic optimization (`practice-wisdom.md` §7, `method-selection.md` §9). **Pitfalls**: forcing a stochastic policy problem into a deterministic MIP. Refs: `problem-catalog.md` §10-11.

## 7. Blending & Process Optimization

**Signature**: mixing raw materials to hit spec at min cost; "blend", "grades", "quality constraints", "refinery", "feed".

**Ask:**
- "Are quality specs **linear in the blend fractions** (simple blending) or do properties combine nonlinearly (e.g., octane, viscosity)?" → LP vs nonlinear/bilinear.
- "Pooling — do streams mix in intermediate tanks before final blends?" → **pooling problem = bilinear, non-convex** (the key red flag).
- "Min/max bounds on each component and on each output property?"
- "Discrete decisions (which tanks/units active) on top of continuous flows?" → MINLP.
- "Is a globally optimal blend required, or is a good feasible blend fine?"

**Likely model / route**: pure linear blending → LP. Pooling/quality nonlinearity → bilinear; McCormick relaxation + spatial B&B (Gurobi `NonConvex=2`, BARON) for global, or good local solutions otherwise (`problem-catalog.md` §9, `modeling-techniques.md` §6.6). **Pitfalls**: writing a non-convex pooling model and trusting a local optimum as global; equality-quality constraints that are numerically fragile.

## 8. Cutting Stock & Packing

**Signature**: cut/pack items into stock/bins minimizing waste or bins; "rolls", "boards", "bins", "2D/3D packing", "trim loss".

**Ask:**
- "1D (lengths), 2D (rectangles/shapes), or 3D (bin/container) packing?" → wildly different difficulty.
- "Minimize number of bins/stock used, or minimize trim/waste?"
- "How many distinct item sizes, and how many of each?" → few sizes ⇒ pattern-based column generation shines.
- "Rotation allowed? Guillotine cuts only, or free placement?"
- "Stability/weight/loading-order constraints (3D containers)?"

**Likely model / route**: 1D cutting stock → Gilmore-Gomory pattern formulation + column generation (`problem-catalog.md` §8, `decomposition.md` §2). Bin packing → strong symmetry-breaking is essential (`modeling-techniques.md` §5). 2D/3D → heuristics/CP often beat MIP. **Pitfalls**: the symmetric assignment formulation without symmetry breaking (`antipatterns.md` §3).

## 9. Assignment & Matching

**Signature**: pair items one-to-one or one-to-many at min cost / max value; "assign", "match", "allocate".

**Ask:**
- "Is it a clean one-to-one assignment, or are there capacities (one agent → many tasks)?" → assignment (totally unimodular, LP-solvable) vs generalized assignment (NP-hard).
- "Any side constraints — budgets, skills, conflicts, fairness?" → these break the easy structure.
- "Bipartite (two groups) or general matching within one group?"
- "Static, or repeated/online as items arrive?"

**Likely model / route**: pure assignment → LP relaxation is integral (Hungarian / network simplex), don't over-engineer (`problem-catalog.md` §10.5). Generalized assignment → MIP, or Lagrangian relaxation of the capacity constraint (`decomposition.md` §3.3). **Pitfalls**: reaching for a heavy MIP when the problem is totally unimodular and an LP/Hungarian solves it instantly.

## 10. Portfolio & Financial

**Signature**: allocate capital across assets balancing return and risk; "portfolio", "variance", "risk", "weights sum to 1".

**Ask:**
- "Is risk measured as variance/covariance (quadratic), or CVaR / drawdown (often linear)?" → QP/SOCP vs LP.
- "Cardinality limits (hold at most k assets) or min position sizes?" → adds binaries + SOS1 → MIQP.
- "Long-only or short allowed? Sector/turnover/transaction-cost limits?"
- "Single-period mean-variance, or multi-period / scenario-based?" → stochastic.

**Likely model / route**: mean-variance → convex QP/SOCP (Mosek/Gurobi/COPT); cardinality → MIQP with SOS1 or indicators (`gurobi-gurobipy-guide.md` §2); CVaR → LP with scenario constraints. **Pitfalls**: a near-singular / poorly scaled covariance matrix (numerical conditioning — `parameter-tuning.md` §8). Note: provide modeling help, **not** personalized investment advice.

## 11. Energy & Unit Commitment

**Signature**: which generators to run and at what output over time; "commitment", "ramp rates", "startup cost", "supply-demand balance".

**Ask:**
- "Time resolution and horizon (5-min, hourly; a day, a week)?" → rolling horizon almost always (`decomposition.md` §6.1).
- "On/off **commitment** decisions with startup/shutdown costs and **minimum up/down times**?" → the binary core of UC.
- "Ramp-rate limits between periods? Reserve requirements?"
- "Renewables/load uncertainty — deterministic, scenarios, or robust?" → stochastic UC.
- "Network/transmission constraints, or single-bus balance?"
- "Hydro/storage with state carried across periods?"

**Likely model / route**: MILP unit commitment; rolling horizon for long spans; decompose by region (granularity) and/or Lagrangian relaxation of the demand-balance coupling (`decomposition.md` §6.2-6.3, `practice-wisdom.md` §6, §8.2). **Pitfalls**: monolithic full-horizon MILP that won't solve; mishandled state carryover at rolling boundaries.

---

> After identifying the domain and the key answers, restate the model back to the user (Mode A in SKILL.md Step 1) and confirm before formalizing. Cross-references: `diagnostic-questions.md` (generic framework), `problem-catalog.md` (formulations), `method-selection.md` (method choice).
