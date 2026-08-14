# Modern Advances (≈2021–2025)

Recent developments that the classical textbooks predate. The goal here is to keep advice *current* without overselling: most production optimization in 2025 is still classical branch-and-cut, simplex/IPM, and well-engineered metaheuristics. The methods below are powerful in specific regimes — know when they actually help and when they are research-stage.

## Table of Contents

1. [GPU and First-Order Methods for LP (PDLP / cuPDLP)](#1-gpu-and-first-order-methods-for-lp)
2. [Machine Learning Inside the Solver](#2-machine-learning-inside-the-solver)
3. [Neural Combinatorial Optimization](#3-neural-combinatorial-optimization)
4. [Decision-Focused / End-to-End Learning](#4-decision-focused--end-to-end-learning)
5. [Current Routing & Metaheuristic SOTA](#5-current-routing--metaheuristic-sota)
6. [Quantum / QUBO (Reality Check)](#6-quantum--qubo)
7. [Recent Solver Versions (verify against live docs)](#7-recent-solver-versions)

---

## 1. GPU and First-Order Methods for LP

For decades, LP meant simplex or interior-point. First-order primal–dual methods now solve **very large** LPs where the IPM's factorization runs out of memory.

- **PDLP** (Primal-Dual Hybrid Gradient for LP): a restarted PDHG method that is matrix-free (only needs `Ax` and `Aᵀy` products), so it scales to LPs with hundreds of millions of nonzeros. Applegate, Díaz, Hinder, Lu, Lubin, O'Donoghue, Schudy, "Practical large-scale linear programming using primal-dual hybrid gradient," *NeurIPS* 2021, arXiv:2106.04756. Shipped in OR-Tools (`PDLP`) and Google's internal stack.
- **cuPDLP / cuPDLP-C**: GPU implementations that report order-of-magnitude speedups on large LPs vs CPU. Lu & Yang, "cuPDLP.jl" and "cuPDLP-C," arXiv:2311.12180 / 2312.14832, 2023–2024.

**When to recommend**: LPs too large for IPM memory, or LP relaxations inside a larger loop where a fast *approximate* solve suffices. **Caveats**: first-order methods converge to moderate accuracy quickly but high accuracy slowly; warm-starting is weaker than simplex; for MIP nodes where exactness matters, simplex/IPM still rule. Commercial solvers have begun integrating PDLP-style options — check the current docs rather than assuming.

## 2. Machine Learning Inside the Solver

ML is used to *guide* exact solvers, not replace them. The branch-and-cut framework stays; learned policies replace hand-tuned heuristics.

- **Learning to branch**: Gasse, Chételat, Ferroni, Charlin, Lodi, "Exact combinatorial optimization with graph convolutional neural networks," *NeurIPS* 2019, arXiv:1906.01629 — imitates strong branching with a GCNN on the variable-constraint bipartite graph.
- **Neural diving & neural branching**: Nair et al. (DeepMind), "Solving mixed integer programs using neural networks," arXiv:2012.13349, 2020.
- **Survey / framing**: Bengio, Lodi, Prouvost, "Machine learning for combinatorial optimization: a methodological tour d'horizon," *EJOR* 290(2):405-421, 2021 — the standard reference for *how* ML and CO compose (learn-to-configure / learn-to-augment / end-to-end).

**When to recommend**: you re-solve **structurally similar** instances many times (same model, changing data) and can afford an offline training phase. **Caveats**: generalization across instance distributions is fragile; the engineering cost is high; for one-off models it is rarely worth it. Modern commercial solvers already apply learned tuning internally — often the practical "ML win" is just running the solver's built-in tuning, not building a custom model.

## 3. Neural Combinatorial Optimization

End-to-end neural models that *construct* solutions (mainly studied on TSP/VRP).

- **Pointer Networks**: Vinyals, Fortunato, Jaitly, *NeurIPS* 2015, arXiv:1506.03134.
- **Attention Model**: Kool, van Hoof, Welling, "Attention, learn to solve routing problems!", *ICLR* 2019, arXiv:1803.08475.
- **POMO**: Kwon et al., "POMO: Policy Optimization with Multiple Optima," *NeurIPS* 2020, arXiv:2010.16011.

**Reality check**: on classical benchmarks, hand-engineered solvers (LKH-3, HGS-CVRP) still produce **better** solutions than pure neural constructors. NCO's value is *amortized speed* — once trained, near-instant solutions for many small/medium instances — and as a component inside hybrid (learn-to-improve) schemes. Don't recommend NCO where solution quality on large instances is the priority; recommend HGS/LKH/ALNS instead (see `metaheuristics.md`, `solvers.md`).

## 4. Decision-Focused / End-to-End Learning

When optimization sits downstream of a prediction (predict demand → optimize), training the predictor on **decision regret** rather than prediction error can help.

- **Smart Predict-then-Optimize (SPO+)**: Elmachtoub & Grigas, "Smart 'Predict, then Optimize'," *Management Science* 68(1):9-26, 2022.
- **Differentiable optimization layers**: Amos & Kolter, "OptNet," *ICML* 2017, arXiv:1703.00443; Agrawal et al., "Differentiable convex optimization layers," *NeurIPS* 2019 (`cvxpylayers`).

**When to recommend**: a two-stage predict-then-optimize pipeline where prediction error and decision cost are misaligned. **Caveats**: needs the optimization layer to be (sub)differentiable or suitably relaxed; for MILP this is an active research area, not turnkey.

## 5. Current Routing & Metaheuristic SOTA

- **HGS-CVRP** (Vidal): still the reference quality bar for CVRP/VRPTW; updates many CVRPLIB best-known solutions. https://github.com/vidalt/HGS-CVRP
- **FILO / FILO2**: Accorsi & Vigo, "A fast and scalable heuristic for the solution of large-scale capacitated vehicle routing problems," *Transportation Science* 55(4):832-856, 2021 — scales to tens of thousands of customers with strong quality; FILO2 extends it further.
- **AILS-II**: adaptive iterated local search, competitive on large CVRP.
- **LKH-3** (Helsgaun): near-exact for TSP and many constrained routing variants.

Default practical recommendation for large routing stays: OR-Tools Routing for fast integration and constraint richness; HGS-CVRP / FILO2 / LKH-3 when squeezing out quality matters. (Cross-ref `problem-catalog.md` §4, `benchmarks.md` §3.)

## 6. Quantum / QUBO

Reformulating combinatorial problems as QUBO/Ising for quantum annealers (D-Wave) or gate-model QAOA attracts attention, but **as of 2025 there is no demonstrated practical advantage over classical solvers** for general industrial MIP. Big-M penalty reformulation into QUBO also reintroduces exactly the numerical-conditioning problems this skill warns about (Principle 2). Treat as research/marketing-adjacent; if a user asks, be honest that classical solvers win today, while noting QUBO can be a useful *modeling* exercise.

## 7. Recent Solver Versions

Version facts move fast — **state them as version-tagged and tell the user to confirm against the live docs** (https://docs.gurobi.com/, https://developers.google.com/optimization, https://www.scipopt.org/, https://highs.dev/).

- **Gurobi**: 9+ added non-convex spatial B&B (`NonConvex=2`); 11+ delivered large convex QP/QCP speedups; 12 (Dec 2024) added exact nonlinear constraints via `addGenConstrNL`, superseding the older piecewise-approximation function-constraint API. Confirm the exact release for any version-specific claim.
- **First-order / GPU LP availability**: PDLP ships in **OR-Tools**; GPU PDLP exists as **cuPDLP / cuPDLP-C**; some commercial solvers (e.g., COPT) and research builds expose first-order LP options. Don't assume any particular commercial solver has a first-order method — check that solver's current docs.
- **OR-Tools CP-SAT**: continues to win every MiniZinc Challenge division (2019–2024); active releases keep improving the LP/SAT/CP hybrid and parallel portfolio. Still integer-coefficient only.
- **HiGHS**: default LP/MIP backend for MATLAB `linprog`/`intlinprog` since R2024a; the leading open-source LP/MIP solver.
- **SCIP**: Optimization Suite 10.0 (2025); CIP framework with the richest plugin ecosystem for custom cuts/branching/pricing.
- **COPT**: reported leading in several Mittelmann categories (LP/MILP/SDP/SOCP/NLP) per the 2025 INFORMS talk — instance-dependent, so caveat accordingly (`benchmarks.md` §10).

### References
- See `bibliography.md` §4 (Algorithms) for the foundational papers and §5 for live documentation links.
