# Practical Knowledge for Real-World Projects (GRID + Prof. Umetani Supervised)

Knowledge accumulated from GRID's internal reading group (Practical Thinking About Mathematical Optimization) and internal consultation channel `#intrpj-umetani-opt` (2023–2026) with Prof. Toshiharu Umetani (Osaka University). Practical know-how that is not found in textbooks but proves decisive in real projects.

## Table of Contents

1. [Distinguishing Constraints (Hard vs Soft)](#1-distinguishing-constraints-hard-vs-soft)
2. [How to Extract Implicit Constraints](#2-how-to-extract-implicit-constraints)
3. [Conducting Customer Agreement on Solution Quality](#3-conducting-customer-agreement-on-solution-quality)
4. [Points of Caution for Project Progress](#4-points-of-caution-for-project-progress)
5. [Weighted Local Search](#5-weighted-local-search)
6. [Practical Judgment on Problem Decomposition](#6-practical-judgment-on-problem-decomposition)
7. [Simulation Optimization and Black-Box Optimization](#7-simulation-optimization-and-black-box-optimization)
8. [Case Patterns Within GRID](#8-case-patterns-within-grid)

---

## 1. Distinguishing Constraints (Hard vs Soft)

### 1.1 Use "Hard Constraints" Carefully

Constraints tend to be written vaguely as "must always be satisfied," but hardness should be limited to:

- **Physically impossible situations** (exceeding capacity, reversing time)
- **Risk of serious injury or accident**
- **Legally or ethically unacceptable**
- **Essential for data consistency** (flow conservation, etc.)

Using hard constraints simply because "**it's standard practice**" or "**the management department says so**" leads to breakdown in the field after implementation.

### 1.2 Real Example: Truck Load Limit 1000kg

Even when the specification states "load limit: 1000kg," the field routinely handles 1000kg + α. Implementation as a hard constraint triggers "no feasible solution found," and investigation reveals divergence between operations and specifications.

→ Lesson: When "no feasible solution" appears, **first suspect the hard/soft classification of constraints**.

### 1.3 Management Department vs Operations Department Perception Gap

- **Management / Business Improvement Division**: Prefer hardening ("a rule is a rule")
- **Operations Division (field staff)**: Often say "the work won't run like that"
- When the contact is on the management side, the result is an **"optimal solution that doesn't work in practice"** — the worst possible outcome.

Countermeasure: **Always interview the field side as well** in business requirements gathering. Don't design based solely on information from the contact person.

### 1.4 Multi-Layer Constraints

In practice, it's realistic to have "an absolute line that cannot be exceeded (hard)" + "a regulatory line (soft)" + "a desirable line (lower priority within soft)." About 3 layers are manageable; beyond that, weight adjustment becomes hell.

### 1.5 Work Through Constraint Priority via Business Logic

- Hard: Physical/legal/data consistency
- Soft (high): Directly affecting business KPI
- Soft (medium): Affecting operational staff's perceived quality
- Soft (low): "Nice to have" level

Separate each layer's weights by **orders of magnitude** (example: hard violation penalty 10⁹, high soft 10⁵, medium 10³, low 10¹). Eliminates concern that neighboring layers' solutions will be compared.

---

## 2. How to Extract Implicit Constraints

### 2.1 The "Pointed Out After Seeing Results" Phenomenon

This occurs at "common occurrence" frequency. Customers become aware of constraints they don't consciously think about only upon seeing the optimal solution, when they first explain "this is wrong, because ○○."

→ Lesson: **Showing results is the most powerful means of extracting implicit constraints**. An approach that produces coarse solutions early, without fearing rework, is effective.

### 2.2 Questions for Extraction

Questions to use during interviews:
- "In the current plan, what is the absolute line that never changes?" (hard constraint candidate)
- "Conversely, are there times when you violate this?" (cases where softening is needed)
- "Could you show us past plans that were marked NG?" (implicit prohibition patterns)
- "Are there keystone constraints that absolutely must not be removed?"
- "If you see the result and think 'this is wrong,' what might catch?" 

### 2.3 Curse of Knowledge

Experienced personnel on the customer side treat their business knowledge as "obvious." With vague questions, you get "nothing in particular," and only after showing results do they say "this is wrong."
→ Lesson: **Present concrete constraint candidates from your side and have them answer YES/NO** — this extracts them better.

### 2.4 Planner's Data Correction

In real projects, planners **post-hoc modify input data** to make "high-quality feasible solutions easier to obtain" (loosening parameters slightly, etc.). This adjustment itself embodies implicit constraints and operational knowledge.
→ Lesson: Assume input data is not in final form; include data adjustment interfaces in the design.

---

## 3. Conducting Customer Agreement on Solution Quality

### 3.1 Avoid Quantitative Commitments Upfront

Numerical commitments like "KPI x will be y% better than actual performance data" are **dangerous**.

Reasons (Prof. Umetani, 2024-05-23):
1. Most real combinatorial optimization problems are NP-hard; without actually working through them, you can't gauge the improvement margin
2. Additional constraints that arise can suddenly degrade solution performance

### 3.2 Recommended Acceptance Criteria Wording

Instead, write:

> "Achieving solution performance comparable to the current planner" (Prof. Umetani's recommendation)

Or

> "State where all requirements listed in the previous phase (constraints, additional features, etc.) are fully implemented"
> "Under the preconditions defined by non-functional requirements, the plan is output in approximately X–Y minutes"

Computation time constraints are explicit (e.g., a 10–15 minute upper limit), but avoid numerical commitments on solution quality.

### 3.3 When Customers Ask "How Much Will This Improve?"

Tell them honestly:
> "The outlook is roughly this much, but the uncertainty is so extremely high that I must sincerely apologize, but I cannot make a promise. I'll do my best within the timeframe, so I appreciate your understanding."

Expectation adjustment takes priority over the risk of later failing to meet excessive promises.

### 3.4 Planners Post-Hoc Modify Data

On the client side, planners often **modify input data post-hoc** to make it easier to obtain high-quality feasible solutions. For the development side, which assumes input data is fixed and absolute, it is rare for client-side requests to be excessive (Prof. Umetani, 2024-05-23).

---

## 4. Points of Caution for Project Progress

### 4.1 "Don't Discuss Computation Time Before a Solution Exists"

Prof. Umetani (2024-05-08):
> "It's better not to discuss computation time before a solution has been found"

Discussing "how to reduce computation time" before even a feasible solution exists causes you to miss the root cause. **First produce a feasible solution**, next "a reasonably good solution," finally "reduce computation time."

### 4.2 Handling Infeasibility in Large-Scale Problems

In order:
1. **Model decomposition** (time / granularity / structure / constraint strength) — see section 6
2. **Reduce binary variables** (rule-based, metaheuristics, machine learning to fix values)
3. **Provide initial solution via warm start** (Solomon insertion, simple dispatching rule, etc.)
4. **Large-scale MIP heuristics** (`NoRelHeurTime`, RINS, feasibility pump enhancement)
5. **Switch to CP-SAT** (especially effective for scheduling problems)
6. **Metaheuristics** (Weighted Local Search, ALNS, HGS, etc.)

### 4.3 Keystone Confirmation Before Project Start

From Itoh's "Practical Thinking About Mathematical Optimization" 8.3:
- Identify 1–several keystone elements that structure the problem
- Confirm early that they are correctly incorporated into the formulation
- Data "conceptual strength" (reliability, missing values, anomalies, consistency with business meaning)

### 4.4 Anti-Patterns (Project Progress)

- **Fine-tuning optimization algorithm details before requirements are fixed**: Requirements change, rebuild required
- **Over-explaining optimization to customers**: Using explainability as a shield delays decision-making
- **Not showing solutions early**: Miss opportunity to extract implicit constraints
- **Talking about "improvement" without a baseline**: Unclear what you're comparing to
- **Making computation time an optimization target from early implementation**: Often sacrifices solution quality pursuit

---

## 5. Weighted Local Search

### 5.1 Source

Toshiharu Umetani, "Implementation of Weighted Local Search for Generalized Assignment Problems," Zenn (Mathematical Optimization Advent Calendar 2024, Day 25):
https://zenn.dev/umepon/articles/4f1e77a4722906

Textbook: Umetani, "Solid Learning of Mathematical Optimization," Kodansha, 2020, ISBN 978-4-06-521270-7.

### 5.2 Overview

A general-purpose metaheuristic for constrained combinatorial optimization. Apply **variable penalty weights** to each constraint's violation degree, minimize the sum of objective + penalties via local search. Upon reaching local optimum, increase penalty weights of violated constraints and re-search.

### 5.3 Weight Design for Hard and Soft Constraints

Prof. Umetani (2025-12-25):

- **Soft constraints**: During formulation, set **fixed penalty weights**. The **internal variable penalty weights** of weighted local search are controlled not to exceed these (often actually do not exceed).
- **Hard constraints**: No limit. Increase the variable penalty weights to **sufficiently large values** (keep raising until convergence).

This makes the business distinction — soft constraints are "may break but high cost," hard constraints are "never break" — reflected in the metaheuristic's internal operation.

### 5.4 Timing of Weight Updates

- The instant local search terminates = the moment a local optimum is reached
- Update penalty weights and restart
- For algorithms like simulated annealing (SA) with ambiguous boundaries, determining weight update timing becomes difficult
- Empirical rule: weight update frequency is around the number of variables (Prof. Umetani). Trial and error is necessary.

### 5.5 Comparison with Lagrangian Heuristics

Lagrangian heuristics assume "a feasible solution can be easily obtained from Lagrangian relaxation solutions." Applicable problems are limited.

Weighted local search is a **more general framework**.
→ Usage: Use Lagrangian Heuristic if a feasible solution is easily obtained from Lagrangian relaxation; use Weighted Local Search if not.

### 5.6 Application to Generalized Assignment Problem (from zenn article)

```
min  Σᵢⱼ cᵢⱼ xᵢⱼ
s.t. Σⱼ xᵢⱼ = 1            ∀i (assign each job to 1 agent)
     Σᵢ aᵢⱼ xᵢⱼ ≤ bⱼ        ∀j (capacity of each agent)
     xᵢⱼ ∈ {0, 1}
```

Neighborhood: shift (move 1 job to different agent), swap (exchange agents for 2 jobs).
Penalty: capacity excess (Σᵢ aᵢⱼ xᵢⱼ − bⱼ)+ multiplied by variable weight wⱼ.

```
min Σᵢⱼ cᵢⱼ xᵢⱼ + Σⱼ wⱼ · max(0, Σᵢ aᵢⱼ xᵢⱼ − bⱼ)
```

Each wⱼ is updated upon reaching local optimum according to violation amount.

---

## 6. Practical Judgment on Problem Decomposition

### 6.1 "Nearly Essential" in Practice

From Itoh's "Practical Thinking About Mathematical Optimization," chapter 7, p. 221:
> "(In practice) problem decomposition is a nearly essential concept"

Naive MIPs from textbooks don't solve real-world sizes. Decomposition is not technical debt but **a first-class design decision**.

### 6.2 Four Decomposition Axes

#### a. Time-Based Decomposition (Rolling Horizon)
- Advance 1-month plan 1 day at a time, offset by half-day increments to solve 1 month
- Standard in Unit Commitment (generator startup/shutdown planning)
- Proven example: `ucgrb` made with Prof. Yamaguchi, running 1-month operation by offsetting daily plans every half-day (Manabe), 1-week planning in previous employment (Iida)
- Also used in AtCoder Heuristic Contest Writer solutions (Takaya)

Points to note:
- Correctly handle state inheritance across period boundaries (initial state)
- Taking periods too long makes each step heavy; too short narrows perspective
- Consider approaches holding information from later periods as "expected value" or "forecast" (stochastic / multistage)

#### b. Granularity-Based Decomposition
- Coarse granularity for overview, fine granularity for detail
- Example: coarse by area → fine within each area
- Example: by power plant → load distribution per generator

Points to note:
- Even if good at coarse granularity, may be infeasible at fine granularity
- Design feedback loops (going back and forth between coarse ↔ fine)

#### c. Structure-Based Decomposition
- Leverage block-diagonal structure in constraint matrices
- Benders decomposition / column generation / Lagrangian relaxation apply
- If global constraints exist, use Benders or dual decomposition (Nakao: "dual decomposition is Lagrangian decomposition of global constraints")

#### d. Constraint-Strength-Based Decomposition
- Solve first with only strong (must-observe) constraints
- Progressively add weaker constraints
- Advantage: can visualize which constraints cause solution changes

### 6.3 Power Supply-Demand Planning Problem Decomposition (Concrete Example)

A 24-system × 10-thermal-plant generation planning problem verified at GRID (Hironaka, 2024-08-08):

1. Divide 24 water systems into 3 groups
2. Of these, 2 are solved **independently with generation maximization** as objective
3. Remaining water systems and all thermal generators are solved at 30-minute granularity with **thermal generation cost minimization** as objective
4. Transform 30-minute water generation plan to accommodate 5-minute granularity information
5. Due to demand ≠ supply imbalance arising from transformation, recalculate thermal generation plan

Result: Through problem decomposition, successfully obtained high-quality solutions in short time.

### 6.4 Rolling Horizon Cautions

- **Propagate initial state carefully**. The previous step's final state becomes the next step's initial state.
- **Myopic decisions at boundaries**: The terminal effect is invisible; output at the terminus becomes extreme. Mitigate via "peek-ahead" or "phantom periods."
- **Long-term constraints** (annual emissions limit, etc.) require separate adjustment via an upper-level loop.

---

## 7. Simulation Optimization and Black-Box Optimization

### 7.1 Applicable Situations

- System is described by differential equations or discrete simulation; optimization targets are control parameters
- Difficult to write as a mathematical program explicitly (function not obtainable, gradient unavailable)
- Example: control parameter optimization for wastewater treatment plant, operating plan for chemical plant

### 7.2 Recommended Approach (Prof. Umetani, 2024-03-14)

- **When variables are few**: Bayesian optimization
- **When variables are many**: CMA-ES, particle swarm optimization (evolutionary computation)
- **Optuna** (by Preferred Networks) to try multiple algorithms:
  - https://optuna.org/
  - Bayesian, CMA-ES, NSGA-II, partial dependence etc. already implemented
  - Starting from benchmarks is recommended

### 7.3 Solution Stability in Metaheuristics

When a real project encounters "results change with each run" (Naoki, 2024-03-14):
- Repeat until solution candidate population variance is below a certain threshold
- Among multiple runs, adopt based on both solution quality and variance
- Fix random seed for reproducibility (for debugging)

### 7.4 Option to Incorporate Machine Learning

- Approach using reinforcement learning to make it black-box
- However, in situations where "solution method using formulas with understandable transitions" is preferred, prioritize explicit algorithms

---

## 8. Case Patterns Within GRID

### 8.1 Ship Planning Optimization (Maritime VRP)

- **Maritime Pickup And Delivery Problem (Maritime PDP)** — distinct from Berth Allocation (Prof. Umetani, 2024-08-02)
- Pickup → delivery sequence, precedence + capacity + time window
- Set cover / set partition format adapted to ship scheduling
- Large scale with combinatorial explosion; use time-axis partial decomposition
- Multiple flavors: coastal vessels, ocean-going vessels, chip ships (paper mills), etc.
- Related projects: Mitsui O.S.K. Lines, Brainpad, ExaWizards, Toyota Motor — conflict-of-interest verification essential

### 8.2 Power Supply-Demand Planning

- Thermal generators (10 units) + hydroelectric (24 systems, 72 sites)
- Minimize thermal fuel cost
- Demand for resolution improvement: 30-minute → 5-minute granularity
- Customer misattribution issue ("mathematical optimization is the cause" when actually input data correction burden is the cause) → cases where non-optimization methods are requested

### 8.3 Shift Planning

- Nurse shifts, call centers, teacher timetables, etc.
- Hard constraints (legal, contractual) + soft constraints (fairness, preferences)
- Penalty weight design is key; hard violation 10⁹, soft 10³, etc. with order-of-magnitude separation

### 8.4 Vehicle Routing and Delivery

- CVRPTW, PDPTW, Multi-Depot
- Vehicle routing project (Koshimoto) — parking avoidance, driving time constraints
- Combination of OR-Tools Routing + ALNS + metaheuristics

### 8.5 Facility Location

- Warehouse placement, service area positioning
- Usually standard UFL / CFLP models
- Multi-objective (cost, coverage, risk) with Pareto front exploration more realistic

### 8.6 Automotive Manufacturing Spot Allocation Optimization

- Spot allocation optimization for welding robots
- Combinatorial explosion; CP-SAT or specialized heuristics as candidates

### 8.7 Facility Location + Transportation (Honda Automotive Logistics Example)

- Assign completed vehicles to regional distribution networks
- 17 regional distribution groups, car carrier operations
- Monthly planning linked to PSI, simulated
- Hybrid problem mixing VRP + facility location + carrier operations

---

## References

- Itoh Motoharu, "Practical Thinking About Mathematical Optimization: Learning Modeling from Fundamentals," O'Reilly Japan, 2025, ISBN 978-4-274-23390-3.
- Umetani Toshiharu, "Solid Learning of Mathematical Optimization: From Models to Algorithms," Kodansha, 2020, ISBN 978-4-06-521270-7.
- Umetani Toshiharu, Zenn, "Implementation of Weighted Local Search for Generalized Assignment Problems": https://zenn.dev/umepon/articles/4f1e77a4722906
- GRID internal Slack `#intrpj-umetani-opt` consultation archive with Prof. Umetani (2023–ongoing).
- GRID Knowledge Portal (Slack canvas F0AUGKX3D42).
- GRID Box "Mathematical Optimization Modeling Reading Group for Practical Use" (folder 358277027856), contributors (Koshimoto, Sakata, Asai, Kurasina, Kaneda, Manabe, Nakao) discussions.
- GRID Box "Prof. Umetani Lectures and Seminar Materials" (folder 187473552152), all 14 sessions.
- GRID Box "Mathematical Optimization Seminar" (folder 309913621925), all 17 sessions.
