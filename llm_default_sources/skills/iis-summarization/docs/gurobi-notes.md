# Gurobi Best Practices & Deployment Notes

Reference material for developers and direct-CLI users. Moved out of
`SKILL.md` so the skill orchestrator does not pay these tokens on every
invocation — nothing here is needed to *run* the skill.

---

## Gurobi Best Practices (from official docs)

The skill incorporates these Gurobi-recommended practices:

- **IIS attribute querying:** After `computeIIS()`, Step 1 queries
  `IISConstr`, `IISLB`, `IISUB`, and `IISMinimal` attributes to capture
  which variable bounds participate in the IIS — not just constraints.
- **Default LB=0 detection:** Gurobi defaults all variable lower bounds
  to 0. The pipeline flags any variables with LB=0 in the IIS, since
  this is a common source of unintentional infeasibility when a variable
  should allow negative values.
- **LP-relaxation-first for MIPs:** When the model is a MIP, Step 1
  solves its LP relaxation first. If the relaxation is already
  infeasible, the IIS is computed on the relaxation — every sub-solve
  becomes an LP (much faster) and the result is a valid infeasible
  subsystem of the MIP. Only when the relaxation is feasible
  (infeasibility caused by integrality) does the IIS run on the MIP.
  The report's `used_lp_relaxation` flag records which path ran.
- **IIS tuning knobs:** `--iis-method 0|1|2|3`, `--numeric-focus
  0|1|2|3`, and `--threads N` are exposed on the CLI. Per Gurobi's
  guidance: `IISMethod=1` is the first thing to try on large LPs,
  `0` is often fastest for MIPs, `2` ignores bound constraints (fast
  when bounds aren't the issue), `3` returns the IIS of a MIP's LP
  relaxation. The IIS outer loop is inherently sequential —
  `ConcurrentMethod` does NOT apply — but `Threads` speeds up each
  subproblem solve on large models.
- **Timeout salvage:** if `computeIIS()` hits the time limit, Gurobi
  still leaves a usable **non-minimal** IIS. Step 1 salvages it
  (`iis_is_minimal=False`) instead of failing — the downstream
  reduction steps minimize it anyway.
- **Elastic-filter re-penalization:** a single L1 FeasRelax has
  alternative optima, so one pass can relax a different constraint
  subset than the true IIS and miss members. Per Gurobi's
  recommendation, the fast pipeline's elastic phase re-solves up to 3
  times, multiplying penalties on already-violated constraints each
  round, and unions the rounds — covering the IIS across alternative
  optima.
- **Force-attribute caveat:** `IISConstrForce`-style pre-screening
  (`0` = exclude, `1` = force in, `-1` = automatic) is **ignored for
  LP models** per Gurobi's docs, which is why this pipeline narrows
  candidates with QuickXplain instead. Excluding a needed constraint
  also raises `IIS_NOT_INFEASIBLE` — any candidate narrowing must
  verify the subset is still infeasible (Phase 5 does exactly this).
- **Fix verification (production guarantee):** Step 7 applies the
  suggested RHS/bound changes to a fresh copy of the model and
  re-solves. The report's Remediation plan is marked **Fix verified**
  only when the re-solve reached feasibility — integrality included,
  so for MIPs the certified fix holds for the integer model.
- **Non-linear coverage guard:** feasRelax relaxes **only linear
  constraints and variable bounds** (documented limitation) — on
  models with quadratic / SOS / indicator constraints it can silently
  report zero violations. Step 1 detects these constraint types,
  captures their IIS membership via `IISQConstr` / `IISSOS` /
  `IISGenConstr`, skips the LP-relaxation routing (`Model.relax()` is
  not a proper relaxation in their presence), and the report states
  the coverage caveat explicitly.
- **Proactive numerics screen:** before solving, Step 1 checks
  Gurobi's published scaling guidelines (matrix coefficient ratio
  ≤ 1e9 hard / 1e6 ideal; RHS and bounds ≤ 1e6). Above the 1e9 hard
  limit the diagnosis is marked **LOW CONFIDENCE** and Gurobi's cheap
  mitigation (`ScaleFlag=2` + `NumericFocus=3`) is applied to make the
  feasibility *verdict* more trustworthy — per Gurobi, internal
  scaling cannot make the IIS itself reliable (computeIIS works on
  unscaled data); only user-side rescaling can.
- **feasRelax penalty semantics (do not regress):** a penalty of `0`
  means violation is FREE, not forbidden — `GRB.INFINITY` is the
  documented way to forbid relaxing an element. Both Step 7 and the
  elastic filter use INFINITY for non-targets. Likewise the documented
  ArtP/ArtN convention: `ArtP > 0` → decrease RHS, `ArtN > 0` →
  increase RHS, for every constraint sense.
- **Never IIS a presolved model (deliberate non-feature):** Gurobi's
  docs confirm the presolve uncrush mapping is NOT exposed to users —
  constraints in `model.presolve()` output may be aggregates of
  several originals or have no counterpart at all, so an IIS computed
  there cannot be reliably mapped back to original constraint names.
  The pipeline always computes the IIS on the original model;
  `--iis-method 1` is the sanctioned speed compensation. Do not "add
  presolve-first" as an optimization.
- **Overlapping-IIS enumeration:** `--enumerate-iises
  --relax-instead-of-remove` loosens each found IIS's RHS values
  (epsilon first; one member removed if the same IIS recurs) instead
  of deleting whole IISes. Removal hides every IIS that shares a
  constraint with an already-found one; relax mode reveals them.
- **Numerical recovery:** If `optimize()` says INFEASIBLE but
  `computeIIS()` raises "Cannot compute IIS on a feasible model", the
  model sits at the edge of feasibility. Step 1 automatically retries
  once with `NumericFocus=3` and `Presolve=0`, per Gurobi's guidance.
- **feasRelax objective choice:** Step 7 uses `relaxobjtype=0`
  (minimize the L1 sum of violations) — the fastest and most
  interpretable of the three relaxation objectives. Note Gurobi's
  guidance: `relaxobjtype=2` (count of violations) is itself a MIP and
  the *slowest*; avoid it on large models. For large MIPs where IIS is
  expensive, FeasRelax is the faster alternative — run the full
  pipeline (without `--agent-mode`) and Step 7 provides the numeric
  relaxation amounts.

---

## Deployment notes (license / remote contexts)

- **WLS cloud license:** computation is local — everything behaves as
  with a local license. For long `computeIIS` runs on unreliable
  egress, raise `WLSTokenDuration` (up to 60 min) so token renewal has
  retry headroom; parallel short-lived diagnosis workers each hold a
  token for the full duration and can exhaust the session baseline.
- **Compute Server (interactive):** works, but every IIS sub-solve and
  callback crosses the network — the deletion-filter/QuickXplain loops
  in this pipeline make many sub-solves, so run the diagnosis locally
  or on the server itself when possible. Models sharing one `gp.Env`
  share one TCP connection: never parallelize diagnoses from a shared
  environment.
- **Compute Server batch mode (`CSBatchMode=1`):** callbacks are
  disabled entirely — `--iis-target` (callback early exit) silently
  cannot fire; rely on `--iis-timeout` instead.

---

## Fast pipeline flags (for large models)

```bash
# Auto-activate when |IIS| > 200 (default threshold)
iis-analyze model.lp

# Force fast pipeline on any model size (recommended for 10k+ constraint models)
iis-analyze model.lp --fast-mode

# Custom auto-routing threshold
iis-analyze model.lp --large-model-threshold 50

# Combined with agent-mode
iis-analyze model.lp --agent-mode --fast-mode

# IIS is slow or numerically delicate (Gurobi tuning knobs)
iis-analyze model.lp --iis-method 1 --numeric-focus 2 --threads 4

# Daily warm-start: verify yesterday's IIS against today's data and,
# if still conflicting, skip computeIIS entirely (stale seeds fall
# back to a normal run automatically)
iis-analyze today.lp --seed-ilp yesterday_iis.ilp --agent-mode

# Reveal IISes that OVERLAP already-found ones (removal hides them)
iis-analyze model.lp --enumerate-iises --relax-instead-of-remove
```

The `--fast-mode` pipeline runs: rule-based pre-filter (0 solves) →
Farkas dual filter (0 extra solves) → elastic filter/FeasRelax (1 solve)
→ QuickXplain divide-and-conquer (O(k·log n) solves) → verification.
Reduces ~10,000 solver calls to ~50 for any model size.
