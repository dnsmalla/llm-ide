# Problem Type Standard Modeling Catalog

This document summarizes the "minimum essential formulation", "how to choose strong formulations", "implementation pitfalls", and "recommended solvers" for each problem type. For detailed decomposition techniques, symmetry breaking, and piecewise-linear (PWL) approaches, refer to `modeling-techniques.md` and `decomposition.md`.

## Table of Contents

1. [Linear Programming (LP)](#1-linear-programming-lp)
2. [Integer and Mixed-Integer Programming (IP/MIP)](#2-integer-and-mixed-integer-programming-ipmip)
3. [Traveling Salesman Problem (TSP)](#3-traveling-salesman-problem-tsp)
4. [Vehicle Routing Problem (VRP / CVRP / VRPTW / PDPTW)](#4-vehicle-routing-problem-vrp)
5. [Job Shop Scheduling (JSP)](#5-job-shop-scheduling-jsp)
6. [Facility Location Problem](#6-facility-location-problem)
7. [Set Covering and Set Partitioning](#7-set-covering-and-set-partitioning)
8. [Knapsack and Bin Packing](#8-knapsack-and-bin-packing)
9. [Quadratic Programming, SOCP, SDP](#9-quadratic-programming-socp-sdp)
10. [Network Optimization](#10-network-optimization)
11. [Stochastic Programming and Robust Optimization](#11-stochastic-programming-and-robust-optimization)

---

## 1. Linear Programming (LP)

Continuous variables only, with linear objective and linear constraints. Polynomial-time solvable (interior point method, ellipsoid method).

### Standard Form
```
min  cᵀx
s.t. Ax = b
     x ≥ 0
```

### Choice of Solution Method
- **Large sparse matrices**: Primal-dual interior point method (IPM). Mosek / COPT / Gurobi / CPLEX are fast.
- **Warm-start important (re-solving later)**: Simplex method (primal or dual simplex).
- **Open source**: HiGHS (default `linprog` in MATLAB R2024a and later), CLP.
- HiGHS uses parallelized dual revised simplex, which is advanced: Huangfu & Hall, *Math. Prog. Computation* 10(1):119-142, 2018, DOI 10.1007/s12532-017-0130-5.

### Pitfalls
- Coefficient scaling beyond 10⁻⁶ to 10⁶ causes numerical instability. Prescale beforehand.
- Splitting `Ax = b` into `Ax ≤ b, Ax ≥ b` can worsen the condition number.

---

## 2. Integer and Mixed-Integer Programming (IP/MIP)

Some or all variables are integer. NP-hard. Branch-and-Cut plus Heuristics is the modern standard approach.

### Three Pillars of Solution Methods
1. **LP relaxation** for lower bounds
2. **Cutting planes** (Chvátal-Gomory, MIR, Cover, Flow Cover, Clique, GMI, Lift-and-Project)
3. **Branching** (variable / pseudo-cost / strong branching) and **Heuristics** (RINS, feasibility pump, large neighborhood search)

### Indicators of Model Quality
- **Tightness of LP relaxation**: ratio to integer optimal (relaxation gap).
- **Symmetry**: if symmetric sub-problems inflate K! or K^n-fold, symmetry breaking is required (see `modeling-techniques.md`).
- **Block structure**: if the constraint matrix is block-diagonal, Benders decomposition or column generation are candidates.

### Major Solvers (as of 2025)
| Solver | Strengths | License |
|---|---|---|
| Gurobi | Fastest-class MIP, standard `gurobipy`, Lazy/User cut callbacks | Commercial, Academic free |
| CPLEX | Established MIP/QP/CP, docplex | IBM Academic Initiative |
| COPT | Leading in many categories in Mittelmann 2024-25 | Commercial, Academic free |
| Xpress | Large-scale sparse, FICO | Commercial |
| HiGHS | OSS LP/MIP, active development | MIT |
| SCIP | OSS CIP, rich plug-in ecosystem, PySCIPOpt | Non-commercial free, commercial paid |
| CBC | COIN-OR, default solver for PuLP | EPL |
| GLPK | Lightweight, educational | GPL |

### Benchmarks
- **MIPLIB 2017** (https://miplib.zib.de/): Benchmark Set with 240 instances, Collection with 1,065 instances. Gleixner et al., *Math. Prog. Computation* 13:443-490, 2021, DOI 10.1007/s12532-020-00194-3.

---

## 3. Traveling Salesman Problem (TSP)

### 3.1 DFJ (Dantzig–Fulkerson–Johnson 1954)
```
min  Σᵢⱼ cᵢⱼ xᵢⱼ
s.t. Σⱼ xᵢⱼ = 1                ∀i    (out-degree=1)
     Σᵢ xᵢⱼ = 1                ∀j    (in-degree=1)
     Σᵢ∈S, j∉S xᵢⱼ ≥ 1         ∀S⊊V, |S|≥2  (SEC)
     xᵢⱼ ∈ {0,1}
```
- Subtour elimination constraints (SEC) are exponential. Add dynamically via Lazy cut.
- Strong LP relaxation; core of Concorde solver.
- Padberg & Rinaldi, *SIAM Review* 33(1):60-100, 1991 → classic work on branch-and-cut.

### 3.2 MTZ (Miller–Tucker–Zemlin 1960)
Represent ordering via auxiliary variables uᵢ:
```
uᵢ − uⱼ + n·xᵢⱼ ≤ n − 1       ∀i≠j, i,j ≥ 2
1 ≤ uᵢ ≤ n − 1                ∀i ≥ 2
```
- Polynomial size but weaker LP relaxation than DFJ.
- Convenient for educational use and small instances. DFJ+lazy SEC overwhelmingly dominates in practice.

### 3.3 Concorde
- Proven optimal solutions for cities exceeding 50,000 (pla85900: 85,900 cities).
- TSPLIB95 (http://comopt.ifi.uni-heidelberg.de/software/TSPLIB95/) is the standard benchmark.
- Implementation access and trials are academic-use only.

### 3.4 Implementation with OR-Tools
```python
from ortools.constraint_solver import pywrapcp, routing_enums_pb2
# OR-Tools Routing solver
manager = pywrapcp.RoutingIndexManager(n, 1, depot)
routing = pywrapcp.RoutingModel(manager)
routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)
search_parameters = pywrapcp.DefaultRoutingSearchParameters()
search_parameters.local_search_metaheuristic = (
    routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
)
solution = routing.SolveWithParameters(search_parameters)
```

---

## 4. Vehicle Routing Problem (VRP)

### 4.1 CVRP (Capacitated VRP)

#### 3-Index Formulation (Vehicle Explicit)
```
xᵢⱼₖ = 1 if vehicle k traverses i→j
min  Σᵢⱼₖ cᵢⱼ xᵢⱼₖ
s.t. Σⱼₖ xᵢⱼₖ = 1                              ∀i ∈ V\{0}  (each customer once)
     Σⱼ xⱼᵢₖ = Σⱼ xᵢⱼₖ                        ∀i, k       (flow conservation)
     Σᵢⱼ dᵢ xᵢⱼₖ ≤ Q                          ∀k          (capacity)
     Σⱼ x₀ⱼₖ ≤ 1                              ∀k          (depot departure at most once)
     Subtour elimination                                     (SEC or MTZ-like)
```

#### 2-Index + Rounded Capacity Inequalities (RCI)
- Extension of DFJ's SEC incorporating capacity.
- Strong separation algorithm (CVRPSEP, Lysgaard et al. 2004) has public implementation.

#### Set-Partitioning Master
```
min Σᵣ cᵣ yᵣ
s.t. Σᵣ aᵢᵣ yᵣ = 1   ∀i ∈ V\{0}
     yᵣ ∈ {0,1}
```
yᵣ = use route r. a_iᵣ ∈ {0,1} indicates whether route r visits i. Columns are exponential, so **column generation** is used. Pricing is ESPPRC (Elementary SPP with Resource Constraints).

### 4.2 Benchmarks
- **CVRPLIB** (http://vrp.atd-lab.inf.puc-rio.br/): Classical instances (Christofides-Eilon 1969, Golden-Wasil 1998) + X-instances (Uchoa et al., *EJOR* 257(3):845-858, 2017, 100 instances, 100-1000 customers) + XL-instances (1000-10000 customers, available 2026).
- **Solomon VRPTW** (1987): 56 instances, 100 customers. C/R/RC × 1/2 series.
- **Gehring-Homberger**: Extension to 200-1000 customers.

### 4.3 Practical Solution Methods
| Size | Recommended Method |
|---|---|
| ~50 customers | Branch-and-Price (exact), Set-Partitioning + CG |
| 50~500 | OR-Tools Routing, ALNS, HGS-CVRP |
| 500~ | HGS-CVRP, FILO, AILS-II, LKH-3 (TSP-specialized but VRP applications exist), VROOM (fast heuristics) |

- **HGS-CVRP** (Vidal): Hybrid Genetic Search, updates best-known on many instances. https://github.com/vidalt/HGS-CVRP
- **OR-Tools Routing**: Google-produced, commercial-quality metaheuristics built-in (GLS, Tabu, SA).
- **VROOM** (https://github.com/VROOM-Project/vroom): Fast OSS, suited for real-time routing.

### 4.4 VRPTW (Time Window Variant)
Time window [aᵢ, bᵢ] and arrival time variable tᵢ:
```
tⱼ ≥ tᵢ + sᵢ + τᵢⱼ − M(1 − xᵢⱼ)    (M ≈ bⱼ + sᵢ + τᵢⱼ − aᵢ)
aᵢ ≤ tᵢ ≤ bᵢ
```
- Tight Big-M values (`max(0, bᵢ + sᵢ + τᵢⱼ − aⱼ)` etc.).
- Exact: Desrochers-Desrosiers-Solomon, *OR* 40(2):342-354, 1992 — origin of branch-and-price.
- ALNS: Ropke & Pisinger, *Transportation Science* 40(4):455-472, 2006.

### 4.5 PDPTW (Pickup and Delivery)
Pairs (p, d) where pickup → delivery must be same vehicle with p before d. Precedence constraints plus capacity plus time windows.

### 4.6 Variants
- MDVRP (Multi-Depot), HFVRP (Heterogeneous Fleet), SDVRP (Split Delivery), PVRP (Periodic), Inventory Routing, Dial-a-Ride, Electric VRP, Green VRP (CO2 objective).
- Survey: Vidal, Laporte, Matl, "A concise guide to existing and emerging vehicle routing problem variants," *EJOR* 286(2):401-416, 2020.

---

## 5. Job Shop Scheduling (JSP)

n jobs × m machines. Each job is a sequence of operations, each operation is processed on a specific machine. Makespan minimization is the representative objective.

### 5.1 Manne's Disjunctive Formulation (1960)
Variables: sᵢⱼ = start time of operation of job i on machine j, zᵢⱼₖ ∈ {0,1} = ordering of i vs j on machine k.
```
sᵢₖ + pᵢₖ ≤ sⱼₖ + M(1 − zᵢⱼₖ)     (zᵢⱼₖ=1 means i goes first)
sⱼₖ + pⱼₖ ≤ sᵢₖ + M·zᵢⱼₖ          (z=0 means j goes first)
Cmax ≥ sᵢ,last + pᵢ,last           ∀i
```
- M is an upper bound on makespan (e.g., Σpᵢⱼ).
- Computational experiments in Ku & Beck, *Computers & OR* 73:165-173, 2016 show **Manne disjunctive is best for CPLEX/Gurobi/SCIP** (faster than time-indexed or rank-based). Multi-threading plus parameter tuning achieves up to 4.5x speedup.

### 5.2 Time-Indexed Formulation (Bowman 1959 / Kondili 1993)
xᵢⱼₜ = 1 iff operation (i,j) starts at time t.
- Fewer constraints but binary variables explode as O(n·m·T), problematic for large T.
- Avoid if fine time grid is needed.

### 5.3 Rank-Based (Wagner 1959)
Assign the "k-th to be processed job" on each machine. Proxy for ordering.

### 5.4 Solution via CP / CP-SAT (Recommended)
OR-Tools CP-SAT is concise with `IntervalVar` and `AddNoOverlap`:
```python
from ortools.sat.python import cp_model

model = cp_model.CpModel()
all_tasks = {}
machine_to_intervals = collections.defaultdict(list)
for job_id, job in enumerate(jobs_data):
    for task_id, (machine, duration) in enumerate(job):
        suffix = f'_{job_id}_{task_id}'
        start_var = model.NewIntVar(0, horizon, 'start' + suffix)
        end_var = model.NewIntVar(0, horizon, 'end' + suffix)
        interval_var = model.NewIntervalVar(
            start_var, duration, end_var, 'interval' + suffix)
        all_tasks[job_id, task_id] = (start_var, end_var, interval_var)
        machine_to_intervals[machine].append(interval_var)

for machine in machines:
    model.AddNoOverlap(machine_to_intervals[machine])

# precedence within job
for job_id, job in enumerate(jobs_data):
    for task_id in range(len(job) - 1):
        model.Add(all_tasks[job_id, task_id + 1][0]
                  >= all_tasks[job_id, task_id][1])

# objective
obj_var = model.NewIntVar(0, horizon, 'makespan')
model.AddMaxEquality(obj_var, [all_tasks[i, len(jobs_data[i])-1][1]
                                for i in range(len(jobs_data))])
model.Minimize(obj_var)

solver = cp_model.CpSolver()
solver.parameters.num_search_workers = 8
status = solver.Solve(model)
```
- Often orders of magnitude faster than MIP on practical instances.
- Official example: https://developers.google.com/optimization/scheduling/job_shop

### 5.5 Benchmarks
- OR-Library JSSP: ft06, ft10, ft20, la01-la40, abz5-abz9, orb01-orb10.
- **Taillard** (1993): Ta01-Ta80, 15×15 to 100×20. Released 1993, many remain open to date.
- PSPLIB: RCPSP (J30/J60/J90/J120).

### 5.6 Variants
- Flow shop (operation order identical across jobs), Open shop (order arbitrary), Flexible JSP (multiple candidate machines per operation), Job Shop with Setup Times, Energy-aware Scheduling, Nurse Rostering, University Timetabling.
- Pinedo, *Scheduling: Theory, Algorithms, and Systems*, 6th ed., Springer 2022 is the encyclopedic textbook.

---

## 6. Facility Location Problem

### 6.1 Uncapacitated Facility Location (UFL)
yⱼ = open facility j, xᵢⱼ = ratio (or binary) of assigning customer i to j.

#### Weak Formulation (Not Recommended)
```
Σᵢ xᵢⱼ ≤ M · yⱼ      ∀j
```
M = |I| is large. LP relaxation is loose; for |J|=100, root gap can reach tens of percent.

#### Strong Formulation (Recommended)
```
xᵢⱼ ≤ yⱼ              ∀i, j
```
- Constraint count is |I|·|J| but LP relaxation **often yields integer optimal solutions**.
- The polytope of UFL is well-studied with known facets; LP-based heuristics suffice in many cases.

### 6.2 Capacitated Facility Location (CFLP)
Add facility capacity Qⱼ:
```
Σᵢ dᵢ xᵢⱼ ≤ Qⱼ · yⱼ   ∀j
```
- LP relaxation loosens, so submodular cuts (Aardal et al.), flow cover cuts, and Benders decomposition are effective.
- Cornuéjols, Sridharan, Thizy, "A comparison of heuristics and relaxations for the capacitated plant location problem," *EJOR* 50(3):280-297, 1991.

### 6.3 k-median / p-median
Fix facility count to p:
```
Σⱼ yⱼ = p
```
- Benchmark problem for Lagrangian relaxation.

### 6.4 Maximum Coverage Location (MCLP)
```
max  Σᵢ wᵢ zᵢ
s.t. zᵢ ≤ Σⱼ∈Nᵢ yⱼ    ∀i
     Σⱼ yⱼ ≤ p
     zᵢ ∈ {0,1}, yⱼ ∈ {0,1}
```
- Nᵢ = set of facilities that can cover customer i.
- Classic application in emergency service location (Church & ReVelle 1974).

### 6.5 Hub Location
Hub-and-spoke network design. p-hub median, hub location with fixed costs. See Alumur & Kara, *EJOR* 190(1):1-21, 2008 survey.

### 6.6 Benchmarks and References
- OR-Library: capinfo, capinfo2 (UFL/CFLP).
- Gurobi Modeling Examples: facility_location.ipynb (https://github.com/Gurobi/modeling-examples).
- Kubo, "An Introduction to New Mathematical Optimization" (Atarashii Suri Saikuha), Chapter 7.

---

## 7. Set Covering and Set Partitioning

### 7.1 Set Covering Problem (SCP)
```
min  Σⱼ cⱼ xⱼ
s.t. Σⱼ aᵢⱼ xⱼ ≥ 1     ∀i ∈ I
     xⱼ ∈ {0,1}
```
- Large-scale applications in crew scheduling, sensor placement, content delivery, code optimization.
- Strong LP relaxation. Caprara, Fischetti, Toth, *OR* 47(5):730-743, 1999 Lagrangian heuristic is classical.

### 7.2 Set Partitioning Problem (SPP)
```
Σⱼ aᵢⱼ xⱼ = 1          ∀i
```
- Crew pairing (airline), VRPTW set-partitioning master, cutting stock framework.
- Large column count (exponential) ⇒ column generation.

### 7.3 Cutting Stock (Gilmore-Gomory 1961)
For each pattern j, roll yⱼ:
```
min Σⱼ yⱼ
s.t. Σⱼ aᵢⱼ yⱼ ≥ dᵢ     ∀i ∈ I (demand for each size)
     yⱼ ≥ 0, integer
```
Patterns a are generated by subproblem (knapsack). Textbook example of column generation.

---

## 8. Knapsack and Bin Packing

### 8.1 0/1 Knapsack
```
max Σⱼ vⱼ xⱼ s.t. Σⱼ wⱼ xⱼ ≤ W, xⱼ ∈ {0,1}
```
- Dynamic programming solves in pseudo-polynomial O(nW). Martello-Toth branch-and-bound is classical.
- LP relaxation is continuous relaxation (item ratio).
- For "Gurobi knapsack with millions of items" inquiries, recommend specialized algorithms: **DP + greedy + branch-and-bound** (e.g., Martello-Pisinger-Toth `minknap`).

### 8.2 Bin Packing
xᵢⱼ = item i in bin j, yⱼ = bin j used:
```
min  Σⱼ yⱼ
s.t. Σⱼ xᵢⱼ = 1                ∀i
     Σᵢ wᵢ xᵢⱼ ≤ W · yⱼ         ∀j
     xᵢⱼ, yⱼ ∈ {0,1}
```
- **Strong symmetry**: swapping bins yields equivalent solutions. Symmetry breaking essential:
  - `yⱼ ≥ yⱼ₊₁` (lexicographic order)
  - Fix item 1 to bin 1 (`x₁₁ = 1`)
- Strong solver: Set-covering formulation + column generation (pattern enumeration). Vance et al. (1994).

### 8.3 Bin Packing Benchmarks
- OR-Library bin packing: bin1, bin2 (Falkenauer 1996, Schwerin-Wäscher 1997).
- 2D Strip Packing: NTT Data Numeca Systems Nuorium Optimizer V26 (2024) uses weighted local search; msiism.jp has explanation.

---

## 9. Quadratic Programming, SOCP, SDP

### 9.1 Convex QP
```
min ½ xᵀQx + cᵀx s.t. Ax ≤ b
```
Q ⪰ 0 (positive semidefinite) is polynomial-time solvable (interior point method).
- Recommended solvers: Mosek, Gurobi 11+ (major speedup), COPT, CPLEX.

### 9.2 Non-Convex QP / Bilinear / Quadratic Constraints
Q indefinite or contains xᵀMy terms.
- Gurobi 9+ with `NonConvex=2` parameter uses spatial branch-and-bound. Practical performance improvements are significant.
- BARON, Couenne (COIN-OR) also support spatial B&B.
- Bilinear x·y relaxed via McCormick envelopes to convex relaxation:
  ```
  z ≥ xᴸy + xyᴸ - xᴸyᴸ
  z ≥ xᵁy + xyᵁ - xᵁyᵁ
  z ≤ xᴸy + xyᵁ - xᴸyᵁ
  z ≤ xᵁy + xyᴸ - xᵁyᴸ
  ```

### 9.3 SOCP (Second-Order Cone Programming)
```
‖Ax + b‖₂ ≤ cᵀx + d
```
- Portfolio optimization (variance constraint), robust LP (Ben-Tal-Nemirovski), least-squares + L2 constraint.
- Recommended: Mosek, COPT, Gurobi, ECOS (OSS, CVXPY backend).

### 9.4 SDP (Semidefinite Programming)
```
min  ⟨C, X⟩  s.t. ⟨Aᵢ, X⟩ = bᵢ ∀i, X ⪰ 0
```
- Goemans-Williamson 0.878 approximation for MAX-CUT, structural design, quantum information, machine learning (kernel learning).
- Recommended: Mosek, COPT-SDP, SDPA, SCS, COSMO (Julia/Python).
- In Mittelmann INFORMS 2025 talk, COPT reported as leading in SDP.

---

## 10. Network Optimization

### 10.1 Shortest Path
- Dijkstra: non-negative weights, O((V+E) log V) with heap.
- Bellman-Ford: negative weights allowed, O(VE).
- Bidirectional / A* / Contraction Hierarchies (practical road networks) — OSRM, Valhalla.

### 10.2 Maximum Flow / Minimum Cut
- Ford-Fulkerson, Dinic (O(V²E)), Push-Relabel.
- Image segmentation, project selection, bipartite matching.

### 10.3 Minimum Cost Flow (MCF)
- Network Simplex (CPLEX, Gurobi `netflow` family).
- Successive Shortest Path, SSP+capacity scaling.

### 10.4 Matching
- Bipartite: Hungarian (Kuhn 1955), Hopcroft-Karp.
- General: Edmonds blossom.
- Weighted: LEMON library, networkx.

### 10.5 Assignment Problem
n×n cost matrix, minimum-cost perfect matching:
```
min Σᵢⱼ cᵢⱼ xᵢⱼ s.t. Σⱼ xᵢⱼ = 1, Σᵢ xᵢⱼ = 1, xᵢⱼ ∈ {0,1}
```
LP relaxation yields integer optimal (totally unimodular).

---

## 11. Stochastic Programming and Robust Optimization

### 11.1 Two-Stage Stochastic Programming
```
min  cᵀx + E_ξ[Q(x, ξ)]
s.t. Ax = b, x ∈ X
     Q(x, ξ) = min { qᵀy : Wy = h(ξ) − T(ξ)x, y ∈ Y }
```
- **L-shaped method** (Van Slyke-Wets 1969) = Benders decomposition applied to stochastic programming.
- Reference: Murphy "Benders, Nested Benders and Stochastic Programming: An Intuitive Introduction" arXiv:1312.3158.

### 11.2 Multistage Stochastic Programming
- **SDDP** (Stochastic Dual Dynamic Programming, Pereira-Pinto 1991): Standard in hydroelectric power planning. SDDP.jl (Julia).

### 11.3 Robust Optimization
- **Soyster (1973)**: Worst-case, overly conservative.
- **Ben-Tal-Nemirovski (1999)**: Ellipsoidal uncertainty set, reduces to SOCP.
- **Bertsimas-Sim (2004)**: Budget Γ adjusts conservatism, remains LP.

### 11.4 DRO (Distributionally Robust Optimization)
```
min_x max_{P ∈ 𝒫} E_P [f(x, ξ)]
```
- 𝒫 as Wasserstein ball: Esfahani-Kuhn (2018) framework, convertible to SOCP.
- 𝒫 moment-based: reduces to SDP.
- Textbook: Shapiro, Dentcheva, Ruszczyński, *Lectures on Stochastic Programming*, 3rd ed., SIAM 2021.
