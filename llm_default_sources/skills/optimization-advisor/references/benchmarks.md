# Benchmark Problem Sets

## Table of Contents

1. [MIPLIB 2017](#1-miplib-2017)
2. [TSPLIB](#2-tsplib)
3. [CVRPLIB](#3-cvrplib)
4. [OR-Library](#4-or-library)
5. [DIMACS Implementation Challenges](#5-dimacs-implementation-challenges)
6. [Scheduling](#6-scheduling)
7. [SAT / CSP](#7-sat--csp)
8. [ROADEF/EURO Challenge](#8-roadefeuro-challenge)
9. [ICAPS Planning Competition](#9-icaps-planning-competition)
10. [Mittelmann Benchmarks](#10-mittelmann-benchmarks)
11. [Usage Guidelines](#11-usage-guidelines)

---

## 1. MIPLIB 2017

### Overview
Official: https://miplib.zib.de/

Gleixner et al. "MIPLIB 2017: data-driven compilation of the 6th mixed-integer programming library," *Math. Prog. Computation* 13:443-490, 2021, DOI 10.1007/s12532-020-00194-3.

### Composition
- Initial candidates: 5,721 instances
- **Collection Set: 1,065 instances**
- **Benchmark Set: 240 instances**
- Each instance tagged with: supply chain, scheduling, indicator, decomposition, infeasible, fixed-charge, etc.
- Status: open / optimal / infeasible
- Best record, submission source, computation statistics

### Selection Method
**Itself is a MIP** that maximizes diversity (covering problem of instance characteristics).

### Applications
- Benchmarking custom solvers and tuning scripts
- Verification of new cut / heuristic ideas
- Standard testbed for academic papers

---

## 2. TSPLIB

### Overview
Official: http://comopt.ifi.uni-heidelberg.de/software/TSPLIB95/
Maintained by Reinelt.

### Included Problem Types
- **Symmetric TSP**
- **Asymmetric TSP (ATSP)**
- **CVRP** (classical sets from Christofides-Mingozzi-Toth 1979, etc.)
- **Hamiltonian Cycle Problem (HCP)**
- **Sequential Ordering Problem (SOP)**
- **TSP with Time Windows**

### Representative Instances
| Instance | Number of Cities | Best Known | Status |
|---|---|---|---|
| pr1002 | 1,002 | 259,045 | optimal (Concorde) |
| pr2392 | 2,392 | 378,032 | optimal |
| pcb3038 | 3,038 | 137,694 | optimal |
| fnl4461 | 4,461 | 182,566 | optimal |
| rl5915 | 5,915 | 565,530 | optimal |
| usa13509 | 13,509 | 19,982,859 | optimal |
| pla7397 | 7,397 | 23,260,728 | optimal |
| pla85900 | 85,900 | 142,382,641 | optimal (Concorde 2006) |

---

## 3. CVRPLIB

### Overview
Official: http://vrp.atd-lab.inf.puc-rio.br/

### Main Instance Sets
- **Classical**: Augerat (A, B, P), Christofides-Eilon (E), Golden, Li, Taillard
- **X-instances** (Uchoa et al., *EJOR* 257(3):845-858, 2017):
  - 100 instances, 100-1000 customers
  - Optimality verified for 61/100 (on CVRPLIB page)
- **XL-instances** (Queiroga et al. 2026):
  - 1000-10000 customers
  - Released January 2026, CVRPLib BKS Challenge underway
- **VRPTW Solomon** (1987): 56 instances, 100 customers
  - C1, C2 (clustered), R1, R2 (random), RC1, RC2 (mixed)
- **Gehring-Homberger** (1999): Extensions to 200, 400, 600, 800, 1000 customers

### BKS Challenge
Announced on INFORMS Open Forum (https://connect.informs.org/discussion/cvrplib-best-known-solution-bks-challenge). Competing to update Best Known Solutions for X / XL instances.

### Related Methods (Currently Top-tier)
- HGS-CVRP (Vidal)
- FILO
- AILS-II
- LKH-3
- POMO (neural)

---

## 4. OR-Library

### Overview
Official: http://people.brunel.ac.uk/~mastjjb/jeb/info.html
Maintained by J. E. Beasley.

### Included Categories
- Bin packing
- Capacitated warehouse location (CFLP)
- Crew scheduling
- Generalized assignment
- Graph coloring
- Job shop scheduling
- Multi-dimensional knapsack
- p-median, p-center
- QAP (Quadratic Assignment Problem)
- Set covering, set partitioning
- Steiner tree
- TSP

### Applications
- Standard benchmarks for classical problems (legacy but still used as reference points for latest methods)
- Educational purposes, initial verification of new algorithms

---

## 5. DIMACS Implementation Challenges

### Overview
DIMACS Center periodically hosts implementation competitions. Large-scale collaborative benchmarks for the academic community.

### Past / Ongoing
- 11th: Steiner Tree Problems (2014)
- 12th: Vehicle Routing Problem (2021-2022)
- Earlier: SAT, Graph Coloring, TSP, Shortest Path, etc.

### Applications
- Modern instances of specific problems + unified evaluation rules
- Post-competition, papers from top methods emerge (high quality)

---

## 6. Scheduling

### 6.1 JSSP (Job Shop)
**OR-Library**:
- ft06 (6×6), ft10 (10×10), ft20 (20×5): Fisher-Thompson 1963
- la01-la40: Lawrence 1984
- abz5-abz9: Adams-Balas-Zawack 1988
- orb01-orb10: Applegate-Cook 1991

**Taillard** (1993):
- Ta01-Ta80
- 15×15 / 20×15 / 20×20 / 30×15 / 30×20 / 50×15 / 50×20 / 100×20
- Many remain open to this day

### 6.2 RCPSP (Resource-Constrained Project Scheduling)
**PSPLIB** (Kolisch-Sprecher 1997): https://www.om-db.wi.tum.de/psplib/
- J30 (30 activities), J60, J90, J120
- 480 instances each (parameter combinations)

### 6.3 Nurse Rostering
- INRC-I (2010 Competition)
- INRC-II (2014-2015 Competition, multi-stage)

### 6.4 University Timetabling
- ITC2007 (International Timetabling Competition)
- ITC2019 (multi-objective)

---

## 7. SAT / CSP

### 7.1 SAT Competition
- Annual: http://www.satcompetition.org/
- Main / Random / Crafted / Industrial / Parallel / Cloud tracks

### 7.2 MiniZinc Challenge
- Annual: https://www.minizinc.org/challenge.html
- Fixed / Free / Parallel / Open Class
- OR-Tools CP-SAT achieved gold medals in all divisions consecutively 2019-2024 (2024 official results)

### 7.3 XCSP Competition
- CSP / COP in XCSP3 format
- http://xcsp.org/competitions/

---

## 8. ROADEF/EURO Challenge

### Overview
Held by ROADEF (French OR Society) + EURO. Real-world problem benchmark competition.

### Past Competitions
- 2018: Renault (cutting stock)
- 2020: SNCF (train routing)
- 2022: RTE (grid maintenance scheduling)
- 2024: Recent problem

### Characteristics
- **Realistic business problems** provided by actual enterprises
- Detailed evaluation rules; top methods made public
- Bridge between academia and industry

---

## 9. ICAPS Planning Competition

### Overview
International Planning Competition (IPC), held biennially.
- PDDL (Planning Domain Definition Language) based
- Classical, Numeric, Temporal, Probabilistic tracks

### Applications
- Connection to AI planning (deep ties with CP / SAT)

---

## 10. Mittelmann Benchmarks

### Overview
Official: https://plato.asu.edu/bench.html

Hans D. Mittelmann (Arizona State University) independently maintains a comparison of commercial and OSS solvers.

### Coverage
- LP (continuous, large-scale)
- MILP
- SDP
- SOCP
- NLP
- QP

### Status (As of 2025)
- Official page verbatim: "In August 2024 Gurobi decided to withdraw from the benchmarks as well and their results have been removed."
- MindOpt withdrew 2024/12/24
- INFORMS 2025 talk (Mittelmann) reported COPT ranked first in many divisions

### Applications
- Trusted third-party comparison of commercial and OSS solver relative performance
- However, rankings vary depending on the instance set

---

## 11. Usage Guidelines

### 11.1 Choose the Instance Set Closest to Your Problem
- Pure MIP → MIPLIB 2017, refer to structure tags (supply chain / scheduling / decomposition)
- VRP → CVRPLIB X-instances or XL
- Scheduling → Taillard JSSP, PSPLIB RCPSP

### 11.2 Match the Problem Size
- If your business problem has 500 customers, try CVRPLIB X-instances with 500 customers
- Get a feel for solver settings and method behavior

### 11.3 Usage During Development
- First: functionality verification on 3-5 instances (smoke test)
- Next: performance evaluation on 20-30 instances
- Finally: full set benchmarking (for papers / reports)

### 11.4 Important Notes
- **Best-known solutions** are constantly updated. When comparing with numbers from older papers, always cross-reference with current BKS
- Benchmark performance and real-world performance **may differ** (real problems have unique constraints and data distributions)
- Tuning specialized to benchmark instances does not generalize

### 11.5 Publishing Your Own Problem
- Sanitized versions of business problems can be submitted to MIPLIB (https://miplib.zib.de/submit.html)
- Having the academic community solve them can improve baselines for your own methods
