# Decomposition Techniques (Benders / Column Generation / Lagrangian)

A collection of methods for solving large-scale / structured optimization by decomposing the problem.

## Table of Contents

1. [Benders Decomposition](#1-benders-decomposition)
2. [Column Generation / Branch-and-Price](#2-column-generation--branch-and-price)
3. [Lagrangian Relaxation](#3-lagrangian-relaxation)
4. [Branch-and-Cut](#4-branch-and-cut)
5. [Method Selection Guide](#5-method-selection-guide)

---

## 1. Benders Decomposition

### 1.1 Principle
Split variables into a complicating y and an easy x. When y is fixed, the subproblem for x (LP) is solvable:
```
min  c^T x + f^T y
s.t. A x + B y = b
     x ≥ 0, y ∈ Y (e.g., integer)
```
The master problem involves y only. From the dual of the subproblem (LP), add **optimality cuts** / **feasibility cuts** to the master. Benders, *Numerische Mathematik* 4:238-252, 1962.

### 1.2 Algorithm
1. Solve master with initial cuts only → obtain y*
2. Fix y* and solve the dual of the subproblem
3. If unbounded, add feasibility cut; if finite optimal, add optimality cut to master
4. Resolve master with added cuts
5. Repeat until upper and lower bounds match

### 1.3 Applications
- **Facility location (Capacitated)**: y = facility opening, x = shipment quantities
- **Network design**: y = edge addition, x = flow
- **Two-stage stochastic programming (L-shaped method)**: y = first-stage, x = recourse. Van Slyke-Wets 1969.
- **Combinatorial Benders** (Codato-Fischetti 2006, *OR* 54(4):756-766): if subproblem is LP but feasibility is the only concern, use no-good cut.

### 1.4 Acceleration Techniques
- **Pareto-optimal (non-dominated) cuts**: Magnanti & Wong, "Accelerating Benders decomposition: Algorithmic enhancement and model selection criteria," *Operations Research* 29(3):464-484, 1981.
- **Multi-cut** (generate separate cuts from each scenario): Birge & Louveaux, "A multicut algorithm for two-stage stochastic linear programs," *EJOR* 34(3):384-392, 1988.
- **In-out / level stabilization** of the master to damp oscillation.
- **Branch-and-Benders-cut (single search tree)**: instead of re-solving the master to optimality each round, add Benders cuts as lazy constraints inside one B&B tree. Modern, large-scale treatment: Fischetti, Ljubić, Sinnl, "Redesigning Benders decomposition for large-scale facility location," *Management Science* 63(7):2146-2162, 2017; cut-selection guidance in Fischetti, Salvagnin, Zanette, "A note on the selection of Benders' cuts," *Mathematical Programming* 124(1-2):175-182, 2010.
- **Benders + heuristic warm start**: the master is the bottleneck — maintain an incumbent via a primal heuristic.

### 1.5 Textbooks and Surveys
- A. M. Costa, "A survey on benders decomposition applied to fixed-charge network design problems," *Computers & OR* 32(6):1429-1450, 2005.
- Murphy "Benders, Nested Benders and Stochastic Programming: An Intuitive Introduction" arXiv:1312.3158 — readable in stochastic programming context.
- Rahmaniani et al., "The Benders decomposition algorithm: A literature review," *EJOR* 259(3):801-817, 2017.

---

## 2. Column Generation / Branch-and-Price

### 2.1 Motivation
MIPs with exponentially many variables (e.g., VRPTW set-partitioning, cutting stock). **Generate variables dynamically rather than all at once—add only those needed**.

### 2.2 Algorithm (LP relaxation case)
1. **Restricted Master Problem (RMP)**: solve LP with initial columns only
2. Obtain dual π
3. **Pricing subproblem**: solve "is there a column with reduced cost < 0?"
4. If yes, add it; if no, LP is optimal
5. For integer solution, use **Branch-and-Price** (B&B on RMP with CG at each node). Barnhart et al., *OR* 46(3):316-329, 1998.

### 2.3 Representative Applications
| Problem | Master | Pricing |
|---|---|---|
| Cutting stock | set covering of demand | Knapsack (Gilmore-Gomory 1961) |
| VRPTW | set partitioning of customers | ESPPRC (Elementary SPP with Resource Constraints) |
| Crew scheduling | set partitioning of flights | Resource-constrained shortest path |
| Vehicle scheduling | set partitioning of trips | Shortest path on time-space network |

### 2.4 Stabilization Techniques
- **Du Merle stabilization**: penalty to suppress oscillation of dual variables
- **Marsten boxstep**: trust region for duals
- **Smoothing** (Wentges 1997): smoothing of dual variables

### 2.5 Survey Papers
- Lübbecke & Desrosiers, "Selected topics in column generation," *OR* 53(6):1007-1023, 2005.
- Feillet, "A tutorial on column generation and branch-and-price for vehicle routing problems," *4OR* 8(4):407-424, 2010, DOI 10.1007/s10288-010-0130-z — best introduction in VRP context.

### 2.6 Implementation Libraries
- **SCIP-Coin**: GCG (Generic Column Generation) framework.
- Custom implementation + commercial LP solver (Gurobi/CPLEX) also common.
- VRPSolver (https://vrpsolver.math.u-bordeaux.fr/) — general-purpose BCP (Branch-Cut-and-Price) framework.

---

## 3. Lagrangian Relaxation

### 3.1 Principle
Incorporate difficult constraint Ax ≤ b as a penalty λ(Ax - b) into the objective:
```
L(λ) = min_{x ∈ X} c^T x + λ^T (A x − b)
```
If λ ≥ 0 (for ≤), then **L(λ) ≤ z*** (lower bound).

### 3.2 Lagrangian Dual
```
max_{λ ≥ 0} L(λ)
```
- **Subgradient method**: λ ← λ + α_k · (Ax_k - b)+
- **Bundle method**: maintain past subgradients for stabilization
- **Volume algorithm** (Barahona-Anbil 2000)

### 3.3 Representative Applications
- **TSP Held-Karp 1-tree relaxation** (Held-Karp 1970, 1971): relax "degree = 2" constraint to minimum 1-tree. Very tight bound.
- **Generalized Assignment**: relax agent capacity constraint; each job becomes independent knapsack.
- **Multi-commodity flow**: relax shared capacity constraint; each commodity becomes independent shortest path.
- **Set covering**: relax rows; columns become independent.

### 3.4 Lagrangian Heuristic
- From LR bound and subproblem solution, construct feasible solution via heuristic.
- Caprara-Fischetti-Toth set covering heuristic (1999) is representative.

### 3.5 Augmented Lagrangian / ADMM
- Add quadratic penalty term to improve dual convergence: L_ρ(x, λ) = c^T x + λ^T(Ax-b) + (ρ/2)‖Ax-b‖²
- Revived in large-scale distributed optimization (Boyd et al., *Foundations and Trends in ML* 3(1):1-122, 2011).

---

## 4. Branch-and-Cut

### 4.1 Principle
Branch-and-bound combined with dynamic addition of cuts (to tighten LP relaxation).

### 4.2 Cut Types
- **General-purpose**: Chvátal-Gomory, MIR, GMI, Cover, Flow Cover, Clique, Zero-half, {0, ½}, BCC (Boolean Constraint Class)
- **Problem-specific**: subtour, comb, blossom for TSP; RCI, capacity cuts for VRP; lifted cover for bin packing

### 4.3 Implementation Patterns
1. **Lazy constraint callback** (Gurobi `Model.optimize(callback)`): when integer solution is candidate, separate violating cuts and add them (TSP SEC is typical).
2. **User cut callback**: separate violating cuts at LP optimum (even before reaching integer solution).

### 4.4 TSP Example (Gurobi callback)
```python
def subtourelim(model, where):
    if where == GRB.Callback.MIPSOL:
        vals = model.cbGetSolution(model._vars)
        selected = gp.tuplelist((i, j) for i, j in model._vars.keys()
                                 if vals[i, j] > 0.5)
        tour = subtour(selected, n)  # shortest subtour
        if len(tour) < n:
            # SEC: Σ x_ij ≤ |S| - 1 for i,j in S
            model.cbLazy(gp.quicksum(model._vars[i, j]
                                      for i, j in itertools.combinations(tour, 2))
                          <= len(tour) - 1)

model._vars = x
model.Params.LazyConstraints = 1
model.optimize(subtourelim)
```

### 4.5 Concorde
TSP-dedicated B&C implementation. Proven optimal solutions for 50,000+ cities. Academic use only.

---

## 5. Method Selection Guide

### Organize by Structure
| Model Structure | Recommended Method |
|---|---|
| Large first stage + many independent scenarios | **Benders / L-shaped** |
| Capital investment + flow / distribution | **Benders** (y = facilities, x = flow) |
| Set partitioning + exponentially many columns | **Column Generation / Branch-and-Price** |
| Independent subproblems linked by shared constraints | **Lagrangian relaxation** |
| Known strong valid inequalities | **Branch-and-Cut** (Lazy/User cut) |
| Exponentially many constraints like subtour elimination | **Branch-and-Cut** (Lazy SEC) |

### Organize by Scale
- **Hundreds of variables**: direct MIP solver is fine. Decomposition not needed.
- **Thousands to tens of thousands**: consider decomposition. Benders / CG can help if structure aligns.
- **Hundreds of thousands+**: decomposition essential. Or specialized metaheuristics.

### Hybrid
- **Branch-Cut-and-Price (BCP)**: add cuts to B&P. VRPSolver, SCIP GCG. SOTA for VRP.
- **Combinatorial Benders + Cut**: cuts in master + cuts in subproblem.
- **Lagrangian + Column Generation**: equivalent relationship (Geoffrion 1974).

---

## 6. Practical Problem Decomposition (Time / Granularity / Structure / Constraint Strength)

Beyond textbook Benders / column generation / Lagrangian, **in real projects, "decomposition itself" becomes a first-class design decision**. Ito's *Practical Approaches to Mathematical Optimization* §7.1 states explicitly: "in practice, problem decomposition is an almost essential idea." This is a standard approach in GRID internal projects.

### 6.1 Decomposition by Time Period (Rolling Horizon)

Solve long-horizon planning problems by repeating "short period + advance":

```
[----------30 days----------]
[--1 day--][next state as initial]
        [--1 day--][next state as initial]
                ...
```

#### Application Examples
- **Unit Commitment (generator start-stop planning)**: 1-day plan rolled forward by half-day increments to operate a month (GRID `ucgrb` demonstration, supervised by Prof. Yamaguchi)
- **Production planning**: 1-month plan rolled forward by week increments
- **AtCoder Heuristic Contest**: writer solutions decompose full horizon into time windows and roll (e.g., molecular matching problem)

#### Considerations
1. **State inheritance at boundaries**: final state of previous step → initial state of next step. Propagate inventory, machine state, remaining resources correctly.
2. **Horizon length**: too long and each step is heavy; too short and decisions are myopic. Hybrid of "step length + preview horizon" is practical.
3. **Long-term constraints** (annual emission cap, etc.): assign in upper loop → local optimization at each rolling step.
4. **Due-date violations**: be careful with due dates that cross period boundaries.

#### Implementation Pattern (Python pseudocode)
```python
state = initial_state
horizon_length = 24  # hours
step_length = 12     # hours

for t in range(0, total_horizon, step_length):
    sub_problem = build_model(
        start=t,
        end=t + horizon_length,
        initial_state=state,
    )
    solution = solve(sub_problem)
    # adopt only the first step_length portion
    apply_solution(solution[:step_length])
    state = compute_state_at(t + step_length)
```

### 6.2 Decomposition by Granularity (Coarse-to-Fine)

Solve with coarse granularity for big picture, fine granularity for detail:

#### Application Examples
- **Power supply-demand planning**: solve entire country at coarse region level → solve each region at fine node level
- **Generation planning**: assign output at plant level → handle startup/shutdown by generator
- **Logistics network**: by region → by facility

#### Considerations
- Even if coarse granularity is feasible, fine granularity can become infeasible (information loss from aggregation)
- Feedback loop (coarse ↔ fine iteration) may be necessary

### 6.3 Decomposition by Problem Structure (block-diagonal)

When constraint matrix has block structure:
```
| A11        | | x1 |   | b1 |
|     A22    | | x2 | = | b2 |
|         A33| | x3 |   | b3 |
| C1 C2 C3   | | x  |   | b0 |   ← global constraints
```

- Without global constraints, blocks are independent (separable)
- With global constraints, use **Benders decomposition** (send variables related to global constraints to master) or **Lagrangian relaxation** (incorporate global constraints as penalties in objective)

As Nakao (GRID) notes: "dual decomposition = globally linking constraints decomposed via Lagrangian" and "Benders decomposition applies when variables are linked through constraints."

### 6.4 Decomposition by Constraint Strength

Add constraints in order of priority: priority 1 (absolute) → priority 2 (high) → priority 3 (medium) ...:

#### Procedure
1. Solve with strongest constraints only → base solution
2. Add next set of constraints → observe solution changes
3. If conflicts arise, relax or renegotiate that constraint
4. Proceed to final solution satisfying all constraints

#### Benefits
- Visualize which constraints cause "dramatic solution changes" (can become explanation material for clients)
- Business boundary between hard and soft constraints becomes visible
- Implicit constraints easier to discover

### 6.5 Real Example: Power Supply-Demand Planning Problem Decomposition (GRID Hironaka 2024)

A generation planning problem with 24 hydro systems × 10 thermal generators, decomposed into 4 steps:

1. Group 24 hydro systems into 3 hydro system clusters
2. Solve 2 of them independently with **generation maximization** as objective
3. Solve remaining hydro clusters and all thermal generators at 30-minute granularity with **thermal generation cost minimization** as objective
4. Convert 30-minute hydro plan to 5-minute plan, recalculate thermal to fix supply-demand mismatches

Result: problem unsolvable in time within single MIP now solved in practical time with good solution quality via decomposition.

### 6.6 Decomposition Decision Flowchart

```
Can naive MIP solve with problem size and time budget?
├── YES → naive MIP OK
└── NO
    ├── Time axis present? → decompose by time period (rolling horizon)
    ├── Hierarchical structure? → decompose by granularity
    ├── Block-diagonal? → decompose by problem structure (Benders/column generation/Lagrangian)
    └── Multi-layer constraints? → decompose by constraint strength
```

Combining multiple approaches is also effective (e.g., rolling horizon + granularity decomposition at each step).

### References
- Ito Genji, *Practical Approaches to Mathematical Optimization* Chapter 7 (Ohmsha 2025).
- GRID internal Knowledge Portal "decomposition_methods" (Gurobi Training): https://gitlab.com/grid-devs/reading-circle/decomposition_methods
- `practice-wisdom.md` §6 (practical judgment in problem decomposition)
