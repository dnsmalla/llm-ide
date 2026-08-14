# Diagnostic Questioning Framework

Most optimization projects fail from the **wrong problem framing**, not the wrong solver. The highest-leverage thing an advisor does is ask the right question at the right moment. This file is the generic question bank: what to ask, *why* it matters, and where each answer routes. **Once you recognize the problem family** (routing, scheduling, rostering, lot-sizing, location, blending, packing, …), switch to the tailored battery in `domain-interviews.md`.

## How to Question Well

- **Ask 2-4 questions at a time**, ordered by how much the answer changes your advice. An interrogation kills momentum — surface the decision-critical unknowns first.
- **Prefer concrete or multiple-choice phrasing** over open-ended. "Are the quantities you decide divisible (liters, hours) or indivisible (whole trucks, yes/no)?" beats "what are your variables?"
- **Explain why you're asking.** Users answer better and trust more when they see the fork in the road each question opens.
- **Offer a default.** "If you don't know the instance size yet, I'll assume ~10⁴ variables and revisit." Keeps things moving.
- **Stop when you can act.** Once you can name the problem class, scale band, and goal, start advising and refine later. See [§ When to Stop Asking](#when-to-stop-asking).

When the host environment supports structured/multiple-choice questions (e.g., Claude Code's question UI), use it for the classification questions below — they are naturally multiple-choice.

---

## Tier 0 — Problem Identification (Plain Language → Model)

Use when the user describes a *business situation* rather than a model ("we need to plan deliveries better", "schedule our staff", "decide which plants to open"). Goal: extract the three components of any optimization model.

| Ask | Why it matters | Extracts |
|---|---|---|
| "What decisions can you actually control?" | Anything not controllable is data, not a variable. Mixing them up is the #1 modeling error. | **Decision variables** |
| "How would you rank two valid plans — what makes one *better*?" | Pins the objective; reveals if it's single- or multi-objective, cost vs service vs risk. | **Objective(s)** |
| "What rules must never be broken, and which are just preferences?" | Separates hard from soft up front (see [Tier 5](#tier-5--requirements-elicitation-hard-vs-soft-implicit)). | **Constraints** |
| "What's fixed input you're given vs. what you choose?" | Draws the data/decision boundary. | Parameters vs variables |
| "Is there a time or sequence dimension (days, shifts, stages)?" | Flags multi-period / scheduling / rolling-horizon structure. | Index sets, dynamics |
| "Is any input uncertain or forecasted?" | Flags robust/stochastic need early (cheap now, expensive to retrofit). | Uncertainty |
| "What does the current (manual or legacy) process do, and what's wrong with it?" | Gives a baseline, an acceptance bar, and often the real implicit constraints. | Baseline + scope |

Once you have decisions + objective + constraints, restate the model back to the user in one paragraph and **ask them to confirm or correct it** before formalizing. Restating is itself an elicitation tool — errors surface fastest when people see their problem written down.

---

## Tier 1 — Mathematical Structure Classification

These determine the problem class and therefore everything downstream. Each is naturally multiple-choice.

1. **Divisibility** — "Are the quantities you decide divisible (e.g., liters, hours, fractions) or must some be whole numbers / yes-no choices?" → continuous (LP/QP/conic) vs integer (MIP/CP).
2. **Objective shape** — "Is the objective a plain weighted sum, or does it contain squares, products of two variables, ratios, or max/min/absolute-value terms?" → LP vs QP/QCP vs needs linearization (`modeling-techniques.md` §6).
3. **Constraint shape** — same question for constraints. Products of variables → bilinear/QCQP/MINLP; norms → SOCP; matrix PSD → SDP.
4. **Logical conditions** — "Are there 'if this then that', 'at most k of these', 'either-or' rules?" → indicator/Big-M/CP (`modeling-techniques.md` §3, §8).
5. **Combinatorial signature** — "Does the problem involve routing, sequencing, packing, assignment, covering, or no-overlap of tasks?" → maps to a named problem in `problem-catalog.md`; no-overlap/cumulative → consider CP-SAT first.
6. **Convexity (if nonlinear)** — "For the squared/product terms, are you minimizing a bowl-shaped (convex) cost, or could it be a maximize / indefinite quadratic?" → convex (tractable) vs non-convex (spatial B&B / global). Watch the epigraph trap (`antipatterns.md` §18).
7. **Black-box** — "Can you write the objective as a formula, or does evaluating a plan require running a simulation / external model?" → if black-box, metaheuristics or Bayesian optimization, not MIP (`practice-wisdom.md` §7).

Route the answers through `method-selection.md` §1 (problem-class decision tree).

---

## Tier 2 — Scale, Performance, and Goal

1. "Order of magnitude of decisions and constraints — hundreds, tens of thousands, millions?" → sets the exact-vs-heuristic and decomposition thresholds (`method-selection.md` §4-5).
2. "How many of those are integer/binary?" → integers, not raw size, drive MIP difficulty.
3. "What's the time budget for a solve — seconds (interactive), minutes, hours, overnight batch?"
4. "Solve once, or re-solve repeatedly with changing data?" → re-solve favors simplex warm starts, persistent models, possibly learned tuning (`modern-advances.md` §2).
5. "Do you need a *provably optimal* answer, or a *good enough* one fast?" → exact MIP vs heuristic/metaheuristic. For most operations problems, "matches or beats the planner within the time budget" is the real bar (`practice-wisdom.md` §3).
6. "Is partial progress useful — would an anytime solver that improves a feasible solution over time fit your workflow?"

---

## Tier 3 — Data and Uncertainty

1. "How clean and complete is the input data? Any missing/estimated fields?" → data work often dominates; dirty data masquerades as infeasibility.
2. "Which parameters are uncertain, and how much could they swing?" → robust optimization for bounded worst-case, stochastic programming for distributional (`problem-catalog.md` §11).
3. "Is the cost of a constraint violation symmetric, or is one direction catastrophic?" → shapes soft-constraint penalties and risk measures (CVaR).
4. "Do you have historical scenarios/forecasts, or just point estimates?" → enables (or rules out) scenario-based stochastic models.

---

## Tier 4 — Deployment, Licensing, and Maintenance

1. "Commercial use, or research/teaching?" → Gurobi/COPT academic licenses forbid commercial use; OSS path is HiGHS/SCIP/CBC/OR-Tools (`solvers.md`, `antipatterns.md` §12).
2. "What language/stack will host this — Python, Julia, a service, an embedded device?"
3. "Who maintains it after delivery — a modeler, or a software team unfamiliar with optimization?" → favors readable modeling layers (Pyomo/OR-Tools) and guardrails.
4. "Does the output need to be *explainable* to operators or auditors?" → affects formulation (avoid opaque penalties), and argues for sensitivity/binding-constraint reporting (route to `result-explanation` skill).
5. "Is there an existing solver license or vendor preference to respect?"

---

## Symptom-Driven Interview Sets

When the user reports trouble, ask the matching set *before* prescribing. (For an attached log/model file, route to the executable sibling skill first — see SKILL.md Step 0.)

### "The solver is slow"
- "Have you looked at the log? What are the root LP relaxation value and the first incumbent?"
- "What's the MIP gap over time — stuck high, or creeping down?"
- "How much does presolve reduce the model?"
- "Is the node count exploding, or is each node slow?"
- "Did you set any parameters, or is it all defaults?"
→ `parameter-tuning.md`; if a Gurobi log exists, the `solve-tuning` skill.

### "No feasible solution / infeasible"
- "Infeasible (proven), or just no feasible solution found yet within the time limit?" — these are completely different problems.
- "Have you run an IIS / conflict refiner?" → if a model file exists, the `iis-summarization` skill.
- "Which of the conflicting constraints are *truly* hard (physics/regulation) vs business preference?" (`practice-wisdom.md` §1)
- "Did this break after adding a constraint or changing data?"
- "Are units and Big-M values sane?" → run `scripts/lp_scan.py`.
→ Order is *feasible → good → fast* (`antipatterns.md` §21).

### "The gap won't close / bound is stuck"
- "Is the *primal* bound (incumbent) stuck, or the *dual* bound (relaxation)?"
- "How tight is the LP relaxation vs the best incumbent?" → loose relaxation = strengthen the formulation, not tune parameters.
- "Is there obvious symmetry (identical machines/bins/periods)?" (`modeling-techniques.md` §5)

### "The LP relaxation is loose"
- "Are you using an aggregated (`Σx ≤ M·y`) or disaggregated (`x ≤ y`) formulation?" (`modeling-techniques.md` §1)
- "Are there known valid inequalities / cuts for this structure?"

### "Out of memory"
- "Is it the model size, the search tree, or storing all columns/cuts?"
- "Could the problem decompose (time / block structure)?" (`decomposition.md`)

### "The solution is technically optimal but operationally wrong/unrealistic"
- "What about it would a human planner immediately reject?" → this is a hidden constraint; the most valuable elicitation question there is. (`practice-wisdom.md` §2)
- "Is the objective actually capturing what you care about, or a proxy?"

### "Results change a lot run-to-run"
- "Is the model genuinely multi-optimal (many equally-good plans), or is there randomness/parallelism nondeterminism?"
- "Do you need solution *stability* between runs (operators dislike churn)?" → add an anchor/proximity term to the previous plan.

---

## Tier 5 — Requirements Elicitation (Hard vs Soft, Implicit)

The questions that surface the constraints nobody wrote down. (Full treatment: `practice-wisdom.md` §1, §2.)

- "For each rule, what *actually* happens if we break it — illegal, unsafe, just frowned upon, or fine occasionally?" → the hard/soft test. Reserve hard for physics, law, ethics, data integrity.
- "Has anyone on the **operations floor** confirmed this, or only management?" — the two often disagree, and operations holds the real constraints.
- "Walk me through a plan you rejected recently — why?" → mines implicit constraints.
- "Are there rules so obvious to you that you wouldn't think to mention them?" → fights the curse of knowledge.
- "If two preferences conflict, which wins?" → builds the soft-constraint priority order / penalty weights (`metaheuristics.md` §11 weighted local search).

---

## When to Stop Asking

Stop and start advising once you can state: **(a)** the problem class, **(b)** the scale band, and **(c)** whether the goal is proven-optimal or good-enough. Everything else can be refined after a first rough solution — and showing a rough solution is itself the best way to surface what's still missing (`practice-wisdom.md` §2, Principle 12). Don't trade a useful first answer for a perfect interview. If the user is clearly expert and has already supplied the essentials, skip straight to advice.
