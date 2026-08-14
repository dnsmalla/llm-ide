# Modeling Failure Patterns & Antipatterns

A checklist of "usual failures." When reviewing a user's model, always check against this first.

## Table of Contents

1. [Big-M Misuse](#1-big-m-misuse)
2. [Writing Weak Formulations Carelessly](#2-writing-weak-formulations-carelessly)
3. [Ignoring Symmetry](#3-ignoring-symmetry)
4. [Confusing Continuous / Integer Variables](#4-confusing-continuous--integer-variables)
5. [Inappropriate PWL Formulation](#5-inappropriate-pwl-formulation)
6. [Unnecessary Precision & Excess Variables](#6-unnecessary-precision--excess-variables)
7. [Real Coefficients in CP-SAT](#7-real-coefficients-in-cp-sat)
8. [Timeout Without Providing Initial Solution](#8-timeout-without-providing-initial-solution)
9. [Parameter Guessing Without Reading Logs](#9-parameter-guessing-without-reading-logs)
10. ["Gurobi Can Solve Anything" Illusion](#10-gurobi-can-solve-anything-illusion)
11. [Indicator Constraint vs. Big-M Selection Error](#11-indicator-constraint-vs-big-m-selection-error)
12. [Commercial License Issues](#12-commercial-license-issues)
13. [Obsessing Over Exact Solutions](#13-obsessing-over-exact-solutions)
14. [Implementing Neighborhood Evaluation as Full Evaluation](#14-implementing-neighborhood-evaluation-as-full-evaluation)
15. [Unit System Mixing](#15-unit-system-mixing)
16. [Neglecting Preprocessing](#16-neglecting-preprocessing)

---

## 1. Big-M Misuse

### Symptoms
- "Just set M = 1e6" written somewhere
- LP relaxation is abnormally loose
- "trickle flow" (should be 0 but becomes a tiny value)
- Numerical warnings appear

### Root Causes
- M set too large → LP relaxation becomes nearly unconstrained
- Variable bounds are not tight

### Countermeasures
- Calculate variable bounds and set M to just barely above that range
- Gurobi official: "Setting M equal to the largest of the absolute values of the lower and upper bounds of x and y often works well"
- Consider switching to Indicator constraints (`addGenConstrIndicator`) or SOS1
- If numerics are unstable, use `NumericFocus=2 or 3`

### References
- `modeling-techniques.md` §2 (Big-M Design)

---

## 2. Writing Weak Formulations Carelessly

### Symptoms
- Aggregated form (Σᵢ xᵢⱼ ≤ M·yⱼ)
- Root LP gap is 10% or more
- Node count explodes

### Root Causes
- "Reduce constraint count" leads to aggregation
- Unaware of strong formulations

### Countermeasures
- Try disaggregated form (xᵢⱼ ≤ yⱼ ∀i,j)
- In UFL, LP-optimal often equals integer-optimal
- Even if constraints increase, presolve will reduce them

### Example: UFL
- Weak: `Σᵢ xᵢⱼ ≤ |I| · yⱼ`
- Strong: `xᵢⱼ ≤ yⱼ ∀i,j`

### References
- `modeling-techniques.md` §1 (Strong Formulations)
- `problem-catalog.md` §6 (Facility Location)

---

## 3. Ignoring Symmetry

### Symptoms
- Parallel identical machines, bin packing, graph coloring, network design problems
- Solution time deteriorates exponentially with problem size
- Node count becomes massive

### Root Causes
- K! symmetric solutions with identical objective value → redundant search tree

### Countermeasures
- **Lex order**: `y_1 ≥ y_2 ≥ ... ≥ y_K`
- **Fix first element**: `x_11 = 1`
- Solver's automatic symmetry detection (`Symmetry=2` for Gurobi) is powerful but don't over-rely on it
- If static breaking is insufficient, use orbital branching

### Verification
- Always verify small cases match brute force results
- Confirm no contradiction with business constraints

### References
- `modeling-techniques.md` §5 (Symmetry Breaking)
- Margot, "Symmetry in integer linear programming," in *50 Years of Integer Programming*, Springer 2010

---

## 4. Confusing Continuous / Integer Variables

### Symptom A: Should be discrete but written as continuous
- Solution doesn't round to integer, breaking feasibility
- "Rounding would work" fails for business constraints

### Symptom B: Should be continuous but written as integer
- Unnecessarily large MIP
- Variable explosion if time grid T is large

### Countermeasures
- Verify business meaning: "Does it truly only take integer values?" "What precision is sufficient?"
- For scheduling, prioritize CP-SAT's `IntervalVar` (far more compact than time indexing)
- Adjust time discretization to business precision (if second-level accuracy isn't needed, use coarser minutes or hours)

---

## 5. Inappropriate PWL Formulation

### Symptoms
- Many binaries + loose Big-M
- Loose LP relaxation
- Numerical errors

### Root Causes
- Naive implementation of BIGM_BIN style (each segment as independent binary)
- Using binaries for convex PWL

### Countermeasures
- **Convex PWL → epigraph with linear constraints only** (no binaries needed)
- **Non-convex → Incremental (Markowitz-Manne) or Logarithmic (Vielma-Nemhauser 2011)**
- Use Gurobi's `addGenConstrPWL` (internally makes the right choice) for stability
- Gurobi 12 (Dec 2024) added exact nonlinear constraints via `addGenConstrNL`, superseding the older piecewise-approximation function-constraint API (`addGenConstrExp`/`Poly`/… with `FuncPieces`). Version-check before relying on either.

### References
- `modeling-techniques.md` §4 (PWL)
- Vielma-Ahmed-Nemhauser, *OR* 58(2):303-315, 2010

---

## 6. Unnecessary Precision & Excess Variables

### Symptoms
- Variables scaled ×10⁶ used as-is, coefficient ratio 10¹² creating ill-conditioning
- "Just in case" auxiliary variables blow up the matrix
- All KPIs turned into variables even if never used

### Root Causes
- Insufficient scaling
- Adding variables during design thinking "we might need this later"

### Countermeasures
- Keep scaling in range 10⁻⁶ ~ 10⁶
- Compute secondary KPI metrics in post-processing (don't turn them into variables)
- Unnecessary auxiliary variables = unnecessary constraints = unnecessary search space

---

## 7. Real Coefficients in CP-SAT

### Symptoms
- OR-Tools CP-SAT `solver.Solve(model)` returns `MODEL_INVALID`
- Or silently produces wrong solutions

### Root Causes
- **CP-SAT accepts integers only**. Constraints with real coefficients are not allowed

### Countermeasures
- Integerize all coefficients (e.g., cost to `int(cost * 10000)`)
- Convert back to reals in post-processing
- Precision loss can be evaluated with `absolute_gap_limit`

---

## 8. Timeout Without Providing Initial Solution

### Symptoms
- "Gurobi hasn't found a feasible solution after 1 hour"
- Existing business operations have a feasible solution (manual solution) but it's not being used

### Countermeasures
- Use `var.Start = value` for warm start
- Build initial feasible solution with construction heuristics (greedy, insertion)
- Having MIP start dramatically improves pruning

### Example
```python
# Pass existing operational solution as warm start
for i, j in existing_solution:
    x[i, j].Start = 1
model.optimize()
```

---

## 9. Parameter Guessing Without Reading Logs

### Symptoms
- Changing `MIPFocus`, `Cuts`, `Heuristics` left and right but no improvement
- Don't understand what's causing slowness

### Root Causes
- Not reading the logs

### Countermeasures (in order)
1. Is the model shrinking during Presolve?
2. What is the Root LP gap?
3. Is the node count exploding or are incumbents not improving?
4. Which cuts are effective?
5. Adjust parameters only after this analysis

Use `MIPFocus=1` (feasibility) vs `MIPFocus=2 or 3` (bound) based on symptoms.

### References
- `parameter-tuning.md` §1, §2

---

## 10. "Gurobi Can Solve Anything" Illusion

### Symptoms
- Naive MIP encoding of scheduling is slow
- Attempting 500-customer VRP with branch-and-bound alone
- Solving convex QP with MIP solver

### Countermeasures
- **Structurally CP-suited (no-overlap, all-different, cumulative)** → OR-Tools CP-SAT is orders of magnitude faster
- **Practical-size VRP** → OR-Tools Routing, HGS-CVRP, VROOM
- **Convex QP / SOCP** → Mosek / Gurobi IPM (not B&C)
- "Choosing the right tool first" is the first optimization

### References
- `solvers.md` §1 (Recommendation Map)

---

## 11. Indicator Constraint vs. Big-M Selection Error

### Symptom A: Indicator is slow
- Overusing `addGenConstrIndicator` in Gurobi causes slowdown

### Symptom B: Wrong solution with Big-M
- Incorrect M leads to inconsistent solutions

### Countermeasures
- M is tight and clear → use Big-M
- M is unknown / large → use Indicator
- Mixed approach is OK (some Big-M, some Indicator)
- See Gurobi Help Center post: "Why is using Indicator Constraints in Gurobi significantly slower than the Big-M method"

---

## 12. Commercial License Issues

### Symptoms
- Works with Gurobi Academic in development but fails on commercial deployment
- Thought it worked with HiGHS but unknowingly bundled GPL libraries

### Countermeasures
- **Gurobi**: Academic cannot be used commercially. NamedUser / Cluster Manager requirements must be checked beforehand
- **HiGHS**: MIT, free
- **CBC**: EPL
- **GLPK**: GPL (care with embedding)
- **SCIP**: Free for non-commercial, commercial requires paid license from ZIB
- **OR-Tools**: Apache 2.0 (free)

### Verification
- For intended solver + modeling libraries + distribution model (SaaS / on-premise), clarify license requirements upfront

---

## 13. Obsessing Over Exact Solutions

### Symptoms
- Business budget is 10 minutes but trying exact MIP for 24 hours
- "If it's not optimal, it's meaningless" — can't explain to stakeholders

### Countermeasures
- Business perspective: Is 5% gap sufficient? Is +10% vs. baseline valuable?
- Set gap tolerance (`MIPGap=0.01` etc.)
- Often getting approximate solutions within time budget using metaheuristics has higher business value
- Distinguish "provably optimal" (regulatory, contractual) from "best feasible" (operations)

---

## 14. Implementing Neighborhood Evaluation as Full Evaluation

### Symptoms
- ALNS / SA is slow
- Single neighborhood evaluation takes O(n) or O(n²)

### Countermeasures
- **Implement delta evaluation (difference calculation)** always
- TSP 2-opt: reference only 4 edge costs, O(1)
- VRP relocate: recompute only affected range

---

## 15. Unit System Mixing

### Symptoms
- Time and distance, yen and thousand-yen, kg and tons mixed
- Coefficient ratio exceeds 10⁸

### Countermeasures
- Unify units across the model (time = minutes, cost = thousand-yen, distance = km, etc.)
- Declare units at the start of specification

---

## 16. Neglecting Preprocessing

### Symptoms
- Infeasibility caused by data anomalies
- Duplicates and missing values confuse modeler
- Large bounds create ill-conditioning

### Countermeasures
- Always do data cleaning first (NaN, anomalies, duplicates)
- Pre-compute tight variable bounds
- Pre-fix variables unlikely to be used
- Gurobi / CPLEX presolve is powerful, but manually reduce beforehand too

---

---

## 17. Confusing Hard and Soft Constraints

### Symptoms
- "No feasible solution found"
- During user interviews: "Actually, we break that constraint sometimes"
- "Implementation works but field personnel won't use it"

### Root Causes
- Taking specification wording at face value and hardening all constraints
- Only hearing from management, not confirming field operations practice
- Words like "absolute" and "required" are ambiguous

### Countermeasures
- Hard constraints only for: "physically impossible," "serious injury risk," "law/ethics," "data integrity"
- Business requirements as soft constraints + penalties
- Interview field personnel too
- When "no feasible solution" appears, first reclassify hard/soft constraints

### Real Example: Truck Payload
Spec says 1000 kg, but field operates 1000 kg + α. Hard constraint → infeasible, soft constraint → workable.

### References
`practice-wisdom.md` §1 (Constraint Assessment)

---

## 18. Cost = x² Written Directly in Constraint

### Symptoms
- Even with Gurobi `NonConvex=2`, still slow
- "Q matrix not positive semi-definite" warning
- Spatial branch-and-bound node explosion

### Root Causes
- Constraint `cost == α·x²` is **non-convex** (feasible region is a parabolic curve)
- Gurobi's default QP solver handles only convex QP

### Countermeasure: Rewrite as Epigraph (Upper-Bounding Variable)
For cost objectives, introduce new variable `y` and write as a **convex inequality**:

```
y >= α·x² + β·x + γ   (α > 0)
min y
```

This `y >= ax² + bx + c` is convex (feasible region is above the parabola = epigraph) and Gurobi solves it by default.

Reverse (non-convex):
```
y <= α·x² + β·x + γ   ← non-convex, requires NonConvex=2
```

### GRID Experience (Hokkaido Electric Project)
- 4900 rows × 9500 columns: quadratic model ~1.5× linear
- 45000 rows × 30000 columns: quadratic causes severe slowdown (impractical)
- Larger problems benefit more from linearization or epigraph conversion

---

## 19. Over-Relying on Gurobi Automatic Big-M

### Symptoms
- Model binary × continuous as `bin * cont` and submit
- Gurobi linearizes automatically and it works, but performance is poor

### Root Causes
- Gurobi auto-linearizes binary × continuous with Big-M (smart), but **manual linearization often yields tighter formulations**
- Automatic conversion applies generic templates; problem-specific bounds knowledge is lost

### Countermeasures
- Linearize binary × continuous by hand (`modeling-techniques.md` §6.2):
  ```
  z ≤ U · y
  z ≤ x
  z ≥ x − U(1 − y)
  z ≥ 0
  ```
- Compute U (upper bound of continuous variable) from context tightly

### GRID Experience (Kansai Electric PoC)
Asai: "Explicit manual linearization shortened computation time"
Takahashi: Better formulation made the difference (not overhead from conversion)

---

## 20. Pre-Committing Solution Quality Numerically with Customer

### Symptoms
- Contract states "improve objective by x% vs. actual"
- Later in dev, can't hit that number, becomes contractual issue
- New constraint (requirement added post-fix) degraded solver performance

### Root Causes
- Pre-committing improvement % on NP-hard problem is reckless
- Adding constraints frequently causes sudden performance collapse

### Countermeasure (Prof. Umetani's Recommendation)
Write acceptance conditions as:

> "Achieve planning performance comparable to current human planners"
> "All requirements (constraints, features) enumerated in prior phase are implemented"
> "Under non-functional prerequisites, plan outputs in approximately X to Y minutes"

Time constraints are OK; numerical solution quality commitments should be avoided.

### When Customer Asks "How Much Will This Improve?"
> "We estimate this much improvement, but uncertainty is very high, so we sincerely apologize that we cannot make a firm commitment. We'll do our best within the time frame, and we appreciate your understanding."

### References
`practice-wisdom.md` §3 (Customer Agreement on Solution Quality)

---

## 21. Discussing Computation Time Before Solutions Exist

### Symptoms
- "Gurobi is slow" / "Implementation is slow" debated first
- Actually no feasible solution exists yet (root LP hasn't even solved)

### Root Causes
- Wrong order: feasible solution → good solution → speed, is skipped

### Countermeasure (Prof. Umetani 2024-05-08)
> "Do not discuss computation time when no solution exists yet"

Proper sequence:
1. First, produce a feasible solution (`MIPFocus=1`, stronger heuristics, warm start)
2. Next, aim for "reasonably good solution" (`MIPFocus=2`, enhanced cuts, symmetry breaking)
3. Finally, "reduce computation time" (simplify model, `Threads`, decomposition)

### References
`practice-wisdom.md` §4 (Project Progress), `parameter-tuning.md`

---

## 22. "Seeking Perfection Before Showing Results"

### Symptoms
- Six months pass without running on real data
- Customer never sees results, so implicit constraints aren't surfaced
- End-of-period solution gets "that's wrong" repeatedly

### Root Causes
- Mindset: "show perfect solution first"
- Implicit constraints customers don't realize until they see results

### Countermeasures
- **Show rough solutions early** (even Big-M = 1e6 is fine)
- Showing results is the strongest way to surface implicit constraints
- Iterate: rough solution → customer feedback → model fix → rough solution → …

### References
`practice-wisdom.md` §2 (Implicit Constraints)

---

## 23. Postponing Problem Decomposition Consideration

### Symptoms
- Attempt single model, can't even find feasible solution
- "Get a stronger PC" / "allocate more time"

### Root Causes
- Fixated on textbook single MIP
- Thought "decomposition = advanced technique," postponed

### Countermeasures
- **Practical-size problems almost always require decomposition** (Itoh, *Practical Optimization Thinking*, 7.1)
- Explore 4 decomposition axes early:
  - Time (rolling horizon): proven in UC literature
  - Granularity (coarse → fine): by area, generator
  - Structure (block-diagonal): Benders / column generation / Lagrangian
  - Constraint strength (strong → weak): add in priority order
- Switch from "single MIP" to "decomposed" is a **design decision**, not technical debt

### References
`decomposition.md`, `practice-wisdom.md` §6

---

## Quick Checklist for Review

When user presents a model, start by asking:

```
1. Does Big-M appear? What value? Why that value?
2. Aggregated form (M·y)? Can it be rewritten disaggregated?
3. Symmetric elements (identical machines, bins, colors)? Breaking them?
4. All variables in integer/continuous? CP-SAT considered?
5. PWL convex? If non-convex, which formulation? Epigraph conversion possible?
6. Warm-started with baseline (human / heuristic) initial solution?
7. Logs reviewed? Is Presolve effective?
8. Permissible gap acceptable for business?
9. Hard / soft constraint classification appropriate? Field interview done?
10. Have solution quality metrics been numerically promised to customer?
11. Problem decomposition considered? (time / granularity / structure / constraint strength)
```
