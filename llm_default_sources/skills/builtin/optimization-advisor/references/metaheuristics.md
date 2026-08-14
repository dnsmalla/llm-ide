# Metaheuristics Methods Guide

For problems with thousands to millions of variables, or that cannot be solved within time budget using exact MIP.

## Table of Contents

1. [Fundamentals of Local Search](#1-fundamentals-of-local-search)
2. [Simulated Annealing (SA)](#2-simulated-annealing-sa)
3. [Tabu Search (TS)](#3-tabu-search-ts)
4. [Genetic Algorithm (GA) / Evolutionary Computation](#4-genetic-algorithm-ga--evolutionary-computation)
5. [Large Neighborhood Search (LNS) / ALNS](#5-large-neighborhood-search-lns--alns)
6. [Variable Neighborhood Search (VNS)](#6-variable-neighborhood-search-vns)
7. [GRASP / Path Relinking](#7-grasp--path-relinking)
8. [Hyper-heuristics / Parallelization](#8-hyper-heuristics--parallelization)
9. [Method Selection Guide](#9-method-selection-guide)
10. [Industrial Implementation Examples](#10-industrial-implementation-examples)

---

## 1. Fundamentals of Local Search

### 1.1 Basic Concepts
- **Solution x**, neighborhood N(x), objective f(x)
- Iteration: x ← argmin_{x' ∈ N(x)} f(x') continues as long as improvement occurs
- When improvement stops, **local optimum** is reached

### 1.2 Neighborhood Structure Design
- **TSP**: 2-opt (2 edges reversal), 3-opt, Or-opt (moving 1-3 consecutive cities), Lin-Kernighan (LK)
- **VRP**: relocate (move 1 customer to another route), exchange (swap 2 customers), 2-opt* (between routes), CROSS-exchange
- **JSP**: adjacent swap within critical block (Nowicki-Smutnicki 1996 is classical)
- **Bin packing**: shift (move 1 item to another bin), swap

### 1.3 Delta Evaluation (Difference Calculation)
- Must **always** implement a mechanism to calculate f(x') in O(1) or O(neighborhood size) for each neighbor move
- For large-scale problems where N(x) size is O(n²) or larger, without delta evaluation it is meaningless
- Example: TSP 2-opt difference only references 4 edge costs

### 1.4 Powerful Construction Heuristics
- TSP: nearest neighbor, Christofides (3/2-approximation), Lin-Kernighan
- VRP: Clarke-Wright savings, sweep, Solomon insertion (VRPTW)
- Bin packing: First Fit Decreasing (FFD), Best Fit Decreasing (BFD)
- Textbook: Kubo & Pedroso "Metaheuristics Mathematics" Kyoritsu Publishing.

---

## 2. Simulated Annealing (SA)

### 2.1 Algorithm
```
T ← T₀
x ← initial solution
while not stop:
    x' ← random neighbor of x
    Δ ← f(x') − f(x)
    if Δ < 0 or random() < exp(−Δ / T):
        x ← x'
    T ← α·T   (e.g., α = 0.99)
```
Kirkpatrick, Gelatt, Vecchi, *Science* 220:671-680, 1983.

### 2.2 Parameters
| Parameter | Guideline |
|---|---|
| T₀ | Temperature where first 100 moves from initial solution have 50% acceptance rate |
| α | 0.95 ~ 0.999 |
| Number of trials per temperature | Neighborhood size × several |
| Stopping condition | T < ε or no improvement for specified iterations |

### 2.3 Strengths
- Simple to implement
- Robust for problems without good intuition for parameter tuning
- Can escape local optima

### 2.4 Weaknesses
- For large-scale problems, finding good values for T₀ and α is difficult
- Does not utilize improvement direction (purely random)

### 2.5 Variants
- **Threshold Accepting** (Dueck-Scheuer 1990): accept worsening beyond threshold, no probability needed
- **Demon Algorithm**: energy conservation
- **Quantum Annealing**: physical implementation such as D-Wave

---

## 3. Tabu Search (TS)

### 3.1 Algorithm
```
x ← initial solution
TabuList ← []
while not stop:
    x' ← best non-tabu neighbor of x (allow worsening)
    Aspiration: if f(x') < best so far, accept even if tabu
    TabuList ← TabuList + [move from x to x']
    if |TabuList| > tenure: pop oldest
    x ← x'
```
Glover, *Computers & OR* 13(5):533-549, 1986.

### 3.2 Design Elements
- **Tabu list**: recent moves or attributes
- **Tenure**: 7 ~ 50 as rule of thumb
- **Aspiration criterion**: exception to accept tabu
- **Intensification**: return to good region (medium-term memory)
- **Diversification**: deviation from explored region (long-term memory)

### 3.3 Typical Implementation
- "Forbid re-swapping of item pairs visited in last k iterations"
- "Recently swapped arcs (within last 10 swaps) are forbidden"

### 3.4 Strengths
- Deterministic algorithm (reproducibility)
- Strongly utilizes improvement direction

### 3.5 Weaknesses
- Tabu attribute design is problem-dependent
- Tenure tuning required

### 3.6 Implementation Libraries
- OR-Tools Routing (Tabu Search is optional)
- ParadisEO (C++)
- OptaPlanner / Timefold (Java, rule-based)

---

## 4. Genetic Algorithm (GA) / Evolutionary Computation

### 4.1 Standard Algorithm
```
P ← initial population of N solutions
while not stop:
    parents ← select(P)  (e.g., tournament)
    offspring ← crossover(parents) + mutation
    P ← replace(P, offspring)
```

### 4.2 Representation
- **0/1 strings**: knapsack, set covering
- **Permutation**: TSP, JSP
- **VRP**: giant tour + split, or direct route partition representation
- **Tree**: GP, structure design

### 4.3 Crossover (Permutation)
- **OX (Order Crossover)**: preserve partial interval, fill others from partner in order
- **PMX (Partially Mapped Crossover)**: swap intervals + resolve duplicates
- **ER (Edge Recombination)**: preserve adjacent edges
- **CX (Cycle Crossover)**: preserve position information

### 4.4 Powerful Implementations
- **HGS (Hybrid Genetic Search, Vidal 2012)**: SOTA for CVRP/VRPTW/MDVRP in many cases. https://github.com/vidalt/HGS-CVRP
- **memetic algorithm**: GA + local search (improve each offspring with local search)

### 4.5 Multi-objective Evolutionary Computation
- **NSGA-II** (Deb et al. 2002), SPEA2, MOEA/D
- Python: pymoo (https://pymoo.org/)

### 4.6 Notes
- GA alone has slow convergence. **memetic (GA + LS) achieves practical performance**.
- Diversity maintenance (duplicate reduction in population) determines quality.

---

## 5. Large Neighborhood Search (LNS) / ALNS

### 5.1 LNS (Shaw 1998)
```
x ← initial solution
while not stop:
    x_partial ← destroy(x, q)    (remove q items)
    x' ← repair(x_partial)        (greedy / regret / exact solver)
    if accept(x', x):
        x ← x'
```
- One move is large with strong diversification
- Diverse neighborhoods realized through destroy/repair combinations

### 5.2 ALNS (Adaptive LNS)
Ropke & Pisinger, *Transportation Science* 40(4):455-472, 2006.

- **Pool** of multiple destroy operators (D_1, ..., D_m) and repair operators (R_1, ..., R_k)
- Each operator's **weight w_i** adaptively selected by roulette based on success
- Acceptance follows SA-type (Pisinger-Ropke 2007)

### 5.3 Standard Operators (VRP)
**Destroy:**
- Random Removal (randomly remove q items)
- Worst Removal (remove in order of high cost contribution)
- Shaw Removal / Related Removal (remove similar customers together)
- Cluster Removal (by geographic cluster)
- Route Removal (remove 1 entire route)
- Historical Removal (low frequency in past solutions)

**Repair:**
- Greedy Insertion (position with smallest cost increase)
- Regret-2 / Regret-3 (prioritize items with large gap between best and second-best)
- Noise Insertion (greedy + noise)
- 1-Regret with Permutation

### 5.4 Weight Update (Typical)
```
w_i ← λ·w_i + (1−λ)·π_i / θ_i    (per segment period)
π_i = score earned by operator i in this segment
θ_i = number of times operator i was used in this segment
```
Add scores σ_1 (new best), σ_2 (new current improvement), σ_3 (accepted but worsening).

### 5.5 Acceptance Criterion
SA-type: exp((f(x) - f(x'))/T). T is cooled separately within LNS.

### 5.6 Implementation
- **C++ header-only** (Santini): https://github.com/alberto-santini/adaptive-large-neighbourhood-search
- **Python ALNS** (Wouda): https://github.com/N-Wouda/ALNS — `pip install alns`, well-maintained documentation
- OR-Tools Routing also has LNS built-in (specify with `local_search_metaheuristic`)

### 5.7 Application Scope
Strongest for VRP family, but also widely used for scheduling, bin packing, library rostering, kidney exchange. See Pisinger-Ropke review, *Computers & OR* 34(8):2403-2435, 2007.

---

## 6. Variable Neighborhood Search (VNS)

### 6.1 Principle
Sequentially try neighborhoods of different sizes: N_1 ⊂ N_2 ⊂ ... ⊂ N_kmax.
```
x ← initial
k ← 1
while k ≤ kmax:
    x' ← random point in N_k(x)
    x'' ← local search from x'
    if f(x'') < f(x):
        x ← x''; k ← 1
    else:
        k ← k + 1
```
Mladenović & Hansen, *Computers & OR* 24(11):1097-1100, 1997.

### 6.2 Variants
- **VND (Variable Neighborhood Descent)**: improve from smallest N to largest N until no improvement
- **GVNS (General VNS)**: combine VNS + VND
- **Skewed VNS**: accept worsening solutions within certain range
- **Reduced VNS**: shaking only, no local search

### 6.3 Strengths
- Simple to implement
- Knowledge of neighborhood structures directly applicable

---

## 7. GRASP / Path Relinking

### 7.1 GRASP (Greedy Randomized Adaptive Search Procedure)
Feo-Resende 1989.
```
for iter in 1..MaxIter:
    x ← randomized greedy construction (RCL-based)
    x ← local search from x
    update best
```
- RCL (Restricted Candidate List): random selection from top-α% of greedy
- Each iteration is independent ⇒ easy parallelization

### 7.2 Path Relinking
Connect two solutions x_1, x_2 and traverse the "pathway" to generate intermediate solutions.
- Maintain elite solution pool and search for path from current solution to solutions in pool

### 7.3 GRASP + Path Relinking
- Accumulate GRASP outputs to elite pool, intensify with PR
- Standard template by Resende-Ribeiro (Springer 2016)

---

## 8. Hyper-heuristics / Parallelization

### 8.1 Hyper-heuristics
Meta-layer that **selects** heuristics.
- **Selection HH**: dynamically select from existing low-level heuristics
- **Generation HH**: generate new heuristics using GP

### 8.2 Parallel Metaheuristics
- **Island model GA**: multiple populations evolve independently + periodic migration
- **Cooperative search**: heterogeneous algorithms share solutions
- **Master-slave**: master distributes evaluation to slaves
- Textbook: Talbi, *Parallel Metaheuristics: A Cooperative Approach*, Wiley 2011

### 8.3 Machine Learning + Metaheuristics
- Learning to branch / Learning to cut (for MIP)
- Reinforcement learning for VRP (Nazari et al. 2018, Kool et al. 2019 Attention Model)
- Neural Combinatorial Optimization family
- Practical use is limited but research is active

---

## 9. Method Selection Guide

### 9.1 By Problem Type
| Problem | First Choice | Alternative |
|---|---|---|
| TSP (medium-scale) | Lin-Kernighan + 2-opt | LKH-3, Concorde (exact) |
| TSP (large-scale) | LKH-3 | OR-Tools, Concorde |
| CVRP/VRPTW | HGS, ALNS | OR-Tools Routing, VROOM, FILO |
| PDPTW | ALNS (Ropke-Pisinger) | OR-Tools |
| JSP | SA, TS, CP-SAT | shifting bottleneck |
| Bin packing | ALNS, HGS | column generation |
| Business Scheduling | OR-Tools CP-SAT, Timefold | LNS |
| Black-box (simulation etc) | Hexaly (LocalSolver), SA | Bayesian optimization |

### 9.2 By Time Budget
- **Seconds**: greedy + simple local search
- **Minutes**: ALNS / TS, CP-SAT (portfolio with 8 workers)
- **Hours**: HGS, parallel ALNS, column generation + heuristic
- **Overnight batch**: anything

### 9.3 By Implementation Difficulty
- Easiest: SA, greedy + 2-opt
- Medium: TS, VNS, GRASP
- Somewhat difficult: ALNS (operator pool design)
- Difficult: HGS, Branch-and-Price + heuristic

---

## 10. Industrial Implementation Examples

### 10.1 ALGO ARTIS
Official (https://www.algo-artis.com/originality): "Instead of mathematical programming solvers, adopt heuristic optimization" and "repeat trial-and-error of 'if a small change improves it, adopt it' millions to tens of millions of times."
- Methods: greedy / beam search / simulated annealing
- Examples:
  - Sumitomo Osaka Cement domestic ship allocation (note.com/algoartis/n/ne816afb0d9b4)
  - Tohoku Electric, Hokuriku Electric coal ocean transport (www.algo-artis.com/case-post-tohokudenryoku)
  - Cosmo Energy HD (April 15, 2025 press release): Product "Optium" adoption "improves operational efficiency by approximately 20% and is **expected to reduce** fuel consumption by approximately 5%" (expected value as of full operation start April 2025, not yet realized)
- Official technical communications: Zenn (zenn.dev/p/algoartis), note tech mag (note.com/algoartis/m/m37d890aa994f), AHC study group reports

### 10.2 OR-Tools (Google)
- Many major routing companies (Lyft, Uber, Doordash) use or fork it behind the scenes
- CP-SAT is also used in Google's internal fleet operations

### 10.3 OptaPlanner / Timefold
- Red Hat origin → Timefold (fork, actively developed)
- Widely adopted for nurse scheduling, delivery, sports scheduling

### 10.4 Hexaly (formerly LocalSolver)
- Commercial, France-based
- Black-box modeling + internal metaheuristics
- Highly evaluated for large-scale VRP / scheduling

---

## 11. Weighted Local Search

### 11.1 Origin and References
- **Umetani Toshiharu "Solid Learning of Mathematical Optimization" Kodansha 2020, ISBN 978-4-06-521270-7** for detailed explanation.
- Umetani Toshiharu Zenn "Implementation of Weighted Local Search for Generalized Assignment Problem" Mathematical Optimization Advent Calendar 2024 Day 25: https://zenn.dev/umepon/articles/4f1e77a4722906

### 11.2 Overview
**Universal metaheuristic** for constrained combinatorial optimization problems. Attach **variable penalty weights** to constraint violation degrees and minimize the sum of objective function + penalties using local search. Reach local optimum → increase penalty weights → re-search repeatedly.

```
min  f(x) + Σⱼ wⱼ · max(0, gⱼ(x) − bⱼ)
```
- f(x): original objective function
- gⱼ(x) ≤ bⱼ: each constraint
- wⱼ: **variable penalty weight** for constraint j

### 11.3 Algorithm
```
x ← initial solution
w ← initial weights (small)
while not stop:
    # inner local search
    while local search makes progress:
        x ← argmin over neighbors of (f(x) + penalty(x, w))
    # reach local optimum → update weights
    for each violated j:
        wⱼ ← wⱼ + Δⱼ          (increase proportional to violation amount)
    if termination criterion met: break
```

### 11.4 Weight Design for Hard and Soft Constraints (Prof. Umetani)

For practical projects mixing hard/soft constraints:

| Constraint Type | Fixed Weight (formulation) | Variable Weight (within algorithm) |
|---|---|---|
| Soft constraint | Present (upper limit) | Often restricted to below fixed weight |
| Hard constraint | No limit | Increase to sufficiently large value (until convergence) |

Reason: Soft constraints have business meaning of "okay to break but costly" → keep internal weights within that limit. Hard constraints are "never break" → keep increasing weights until violation becomes zero.

### 11.5 Timing of Weight Updates (Prof. Umetani 2025-12-25)

- **When local search stops** = at the moment local optimum is reached, update weights
- **Ambiguous boundaries like simulated annealing** make it difficult to determine weight update timing
- **Rule of thumb for weight update cycle**: around the number of variables (trial-and-error needed)
- Alternative methods to update adaptively

### 11.6 Comparison with Lagrangian Heuristics

| Method | Applicability | Prerequisite |
|---|---|---|
| Lagrangian Heuristic | Limited | Feasible solution obtainable from Lagrangian relaxation solution by **simple procedure** |
| Weighted Local Search | Universal | Only need neighborhood where local search can run |

Prof. Umetani (2025-11-14):
> "Lagrangian heuristics are applicable only to problems where feasible solution is easily obtainable from Lagrangian relaxation solution, so applicable problems are limited. Therefore, weighted local search was proposed as a more universal framework."

### 11.7 Application Example: Generalized Assignment Problem (GAP)

Problem:
```
min  Σᵢⱼ cᵢⱼ xᵢⱼ
s.t. Σⱼ xᵢⱼ = 1            ∀i (assign each job to 1 agent)
     Σᵢ aᵢⱼ xᵢⱼ ≤ bⱼ        ∀j (each agent's capacity, this is hard constraint)
     xᵢⱼ ∈ {0, 1}
```

Weighted objective function:
```
min Σᵢⱼ cᵢⱼ xᵢⱼ + Σⱼ wⱼ · max(0, Σᵢ aᵢⱼ xᵢⱼ − bⱼ)
```

Neighborhood:
- **shift**: move 1 job to different agent
- **swap**: exchange agents of 2 jobs

Update:
- When local optimum reached, increase wⱼ for violated j
- All constraints 0 violation + local optimal = termination

Complete implementation see Zenn article.

### 11.8 Positioning Relative to Other Metaheuristics

- **Tabu Search**: neighborhood history-based, hard constraints maintained in neighborhood generation or penalized
- **SA**: probabilistic acceptance-based, can accept hard violations (probability adjustment separate)
- **ALNS**: destroy/repair, repair maintains feasibility
- **Weighted Local Search**: dynamic adjustment of penalty weights while preserving "business meaning of soft/hard" for exploration

In real projects, "penalize all constraints and run with local search" as a simple framework is very effective for business problems with many constraints.
