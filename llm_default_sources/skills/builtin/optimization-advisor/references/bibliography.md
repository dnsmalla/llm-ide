# Important References and Article List

## Table of Contents

1. [Textbooks (English)](#1-textbooks-english)
2. [Textbooks (Japanese)](#2-textbooks-japanese)
3. [Major Papers (Formulation & Modeling)](#3-major-papers-formulation--modeling)
4. [Major Papers (Algorithms)](#4-major-papers-algorithms)
5. [Online Official Documentation](#5-online-official-documentation)
6. [Blogs & Explanations](#6-blogs--explanations)
7. [Domestic Communities](#7-domestic-communities)

---

## 1. Textbooks (English)

### Integer Programming and Combinatorial Optimization
- L. A. Wolsey, *Integer Programming*, 2nd ed., Wiley, 2020.
- G. L. Nemhauser, L. A. Wolsey, *Integer and Combinatorial Optimization*, Wiley, 1988. (Classic)
- M. Conforti, G. Cornuéjols, G. Zambelli, *Integer Programming*, Springer GTM 271, 2014.
- A. Schrijver, *Theory of Linear and Integer Programming*, Wiley, 1986. (Theory)
- A. Schrijver, *Combinatorial Optimization: Polyhedra and Efficiency*, Springer, 2003. (3 volumes, reference-like)

### Linear Programming
- D. Bertsimas, J. N. Tsitsiklis, *Introduction to Linear Optimization*, Athena Scientific, 1997.
- V. Chvátal, *Linear Programming*, W. H. Freeman, 1983. (Classic & readable)
- R. J. Vanderbei, *Linear Programming: Foundations and Extensions*, 5th ed., Springer, 2020.

### Modeling
- **H. P. Williams, *Model Building in Mathematical Programming*, 5th ed., Wiley, 2013.** (Standard reference for formulation)
- A. M. Geoffrion, "Lagrangean Relaxation for Integer Programming," *Mathematical Programming Study* 2, 1974.

### Convex Optimization
- S. Boyd, L. Vandenberghe, *Convex Optimization*, Cambridge UP, 2004. (Free PDF: https://web.stanford.edu/~boyd/cvxbook/)
- Y. Nesterov, *Introductory Lectures on Convex Optimization*, Kluwer, 2004.

### VRP
- P. Toth, D. Vigo (eds.), *Vehicle Routing: Problems, Methods, and Applications*, 2nd ed., SIAM, 2014.
- B. Golden, S. Raghavan, E. Wasil (eds.), *The Vehicle Routing Problem: Latest Advances and New Challenges*, Springer, 2008.

### Metaheuristics
- M. Gendreau, J.-Y. Potvin (eds.), *Handbook of Metaheuristics*, 3rd ed., Springer, 2019.
- E.-G. Talbi, *Metaheuristics: From Design to Implementation*, Wiley, 2009.
- F. Glover, M. Laguna, *Tabu Search*, Kluwer, 1997.

### Constraint Programming
- F. Rossi, P. van Beek, T. Walsh (eds.), *Handbook of Constraint Programming*, Elsevier, 2006.

### Scheduling
- M. L. Pinedo, *Scheduling: Theory, Algorithms, and Systems*, 6th ed., Springer, 2022.

### Stochastic Programming & Robust Optimization
- A. Shapiro, D. Dentcheva, A. Ruszczyński, *Lectures on Stochastic Programming*, 3rd ed., SIAM, 2021.
- A. Ben-Tal, L. El Ghaoui, A. Nemirovski, *Robust Optimization*, Princeton UP, 2009.
- D. Bertsimas, D. den Hertog, *Robust and Adaptive Optimization*, Dynamic Ideas, 2022.

---

## 2. Textbooks (Japanese)

### Introductory to Intermediate
- **Toshiharu Umetani, *Solidly Learning Mathematical Optimization: From Models to Algorithms* (しっかり学ぶ数理最適化 モデルからアルゴリズムまで), Kodansha KS Information Science Specialized Series, 2020, ISBN 978-4-06-521270-7.** (Comprehensive single-volume treatment covering LP/simplex method/duality/nonlinear/integer programming/branch-and-bound/cutting planes/local search/metaheuristics. The most recent and authoritative Japanese textbook)
- **Mikio Kubo, J. P. Pedroso, Masakazu Muramatsu, A. Rais, *New Mathematical Optimization: Solving with Python and Gurobi* (あたらしい数理最適化 Python言語とGurobiで解く), Kindai Science Publishing, 2012, ISBN 9784764904330.**
- Mikio Kubo, J. P. Pedroso, *Mathematics of Metaheuristics* (メタヒューリスティクスの数理), Kyoritsu Shuppan.
- Akihisa Tamura, Masakazu Muramatsu, *Optimization Methods* (最適化法), Kyoritsu Shuppan.
- Masao Fukushima, *Introduction to Mathematical Programming (New Edition)* (新版 数理計画入門), Asakura Shoten.

### Implementation-Oriented
- **Genji Ito, *How to Think About Mathematical Optimization in Practice: Learning Formulation from Basics* (実務で使える数理最適化の考え方: 基礎から学ぶモデリング), Ohmsha, 2025, ISBN 978-4-274-23390-3.** (Modern textbook written from a practical perspective covering real project modeling, requirements organization, implicit constraints, problem decomposition, and anti-patterns in project management. Previously used in GRID company internal reading group)
- Jiro Iwanaga, Kyota Ishihara, Naoki Nishimura, Kazuki Tanaka, *Beginning Mathematical Optimization with Python (2nd Edition)* (Pythonではじめる数理最適化 (第2版)), Ohmsha, 2024.
- Shunmin Nakayama et al., *Mathematical Optimization Understood Through Manga* (マンガでわかる数理最適化), Ohmsha, 2024.
- Daigo Miyoshi, *Learning Mathematical Optimization by Hands-On Practice with Excel* (Excelで手を動かしながら学ぶ数理最適化), Impress, 2023.

### Applications & Specialization
- Katsuki Fujisawa, Junya Goto, Yuichiro Yasui, *50 Optimization Problems Useful for Applications* (応用に役立つ50の最適化問題), Asakura Shoten, 2009.
- Mikio Kubo, *Combinatorial Optimization and Algorithms* (組合せ最適化とアルゴリズム), *Logistics Engineering* (ロジスティクス工学), *Supply Chain Optimization Handbook* (サプライ・チェイン最適化ハンドブック), Asakura Shoten and others.
- Masatoshi Sekiya, Toshihide Ibaraki, *Combinatorial Optimization Short Stories* (組合せ最適化短編集), Asakura Shoten.
- Toshihide Ibaraki, *Mathematics of Optimization* (最適化の数学), Kyoritsu Shuppan.

---

## 3. Major Papers (Formulation & Modeling)

### TSP
- G. B. Dantzig, R. Fulkerson, S. Johnson, "Solution of a large-scale traveling-salesman problem," *J. ORSA* 2:393-410, 1954.
- C. E. Miller, A. W. Tucker, R. A. Zemlin, "Integer programming formulation of traveling salesman problems," *J. ACM* 7(4):326-329, 1960.
- M. Padberg, G. Rinaldi, "A branch-and-cut algorithm for the resolution of large-scale symmetric traveling salesman problems," *SIAM Review* 33(1):60-100, 1991.

### VRP
- I. Kara, G. Laporte, T. Bektas, "A note on the lifted Miller-Tucker-Zemlin SEC formulation for the CVRP," 2004.
- E. Uchoa, D. Pecin, A. Pessoa, M. Poggi, T. Vidal, A. Subramanian, "New benchmark instances for the CVRP," *EJOR* 257(3):845-858, 2017.
- T. Vidal, G. Laporte, P. Matl, "A concise guide to existing and emerging vehicle routing problem variants," *EJOR* 286(2):401-416, 2020.

### JSP
- A. S. Manne, "On the job-shop scheduling problem," *Operations Research* 8(2):219-223, 1960.
- W.-Y. Ku, J. C. Beck, "Mixed Integer Programming models for job shop scheduling: A computational analysis," *Computers & OR* 73:165-173, 2016.

### PWL
- J. P. Vielma, S. Ahmed, G. Nemhauser, "Mixed-integer models for nonseparable piecewise-linear optimization: unifying framework and extensions," *Operations Research* 58(2):303-315, 2010.
- J. P. Vielma, G. L. Nemhauser, "Modeling disjunctive constraints with a logarithmic number of binary variables and constraints," *Mathematical Programming* 128(1):49-72, 2011.
- M.-H. Lin, J. G. Carlsson, D. Ge, J. Shi, J.-F. Tsai, "A review of piecewise linearization methods," *Mathematical Problems in Engineering*, 2013, Article ID 101376.

### Symmetry Breaking
- F. Margot, "Symmetry in integer linear programming," in M. Jünger et al. (eds.), *50 Years of Integer Programming 1958-2008*, Springer, 2010, DOI 10.1007/978-3-540-68279-0_17.
- J. Ostrowski, J. Linderoth, F. Rossi, S. Smriglio, "Orbital branching," *Mathematical Programming* 126(1):147-178, 2011.
- V. Kaibel, M. Peinhardt, M. E. Pfetsch, "Orbitopal fixing," *Mathematical Programming* 126(1):29-65, 2011.

---

## 4. Major Papers (Algorithms)

### Branch-and-Cut/Price
- C. Barnhart, E. L. Johnson, G. L. Nemhauser, M. W. P. Savelsbergh, P. H. Vance, "Branch-and-price: Column generation for solving huge integer programs," *Operations Research* 46(3):316-329, 1998.
- M. E. Lübbecke, J. Desrosiers, "Selected topics in column generation," *Operations Research* 53(6):1007-1023, 2005.
- D. Feillet, "A tutorial on column generation and branch-and-price for vehicle routing problems," *4OR* 8(4):407-424, 2010, DOI 10.1007/s10288-010-0130-z.

### Benders
- J. F. Benders, "Partitioning procedures for solving mixed-variables programming problems," *Numerische Mathematik* 4:238-252, 1962.
- R. M. Van Slyke, R. Wets, "L-shaped linear programs with applications to optimal control and stochastic programming," *SIAM J. Applied Mathematics* 17(4):638-663, 1969.
- R. Rahmaniani, T. G. Crainic, M. Gendreau, W. Rei, "The Benders decomposition algorithm: A literature review," *EJOR* 259(3):801-817, 2017.
- T. L. Magnanti, R. T. Wong, "Accelerating Benders decomposition: Algorithmic enhancement and model selection criteria," *Operations Research* 29(3):464-484, 1981.
- M. Fischetti, I. Ljubić, M. Sinnl, "Redesigning Benders decomposition for large-scale facility location," *Management Science* 63(7):2146-2162, 2017. (modern single-tree branch-and-Benders-cut)

### Lagrangian / Duality
- M. Held, R. M. Karp, "The traveling salesman problem and minimum spanning trees," *Operations Research* 18:1138-1162, 1970.
- A. M. Geoffrion, "Lagrangean relaxation for integer programming," *Mathematical Programming Study* 2:82-114, 1974.

### Metaheuristics
- S. Kirkpatrick, C. D. Gelatt, M. P. Vecchi, "Optimization by simulated annealing," *Science* 220(4598):671-680, 1983.
- F. Glover, "Future paths for integer programming and links to artificial intelligence," *Computers & OR* 13(5):533-549, 1986. (Origin of Tabu search)
- N. Mladenović, P. Hansen, "Variable neighborhood search," *Computers & OR* 24(11):1097-1100, 1997.
- S. Ropke, D. Pisinger, "An adaptive large neighborhood search heuristic for the pickup and delivery problem with time windows," *Transportation Science* 40(4):455-472, 2006.
- D. Pisinger, S. Ropke, "A general heuristic for vehicle routing problems," *Computers & OR* 34(8):2403-2435, 2007.
- T. Vidal, T. G. Crainic, M. Gendreau, C. Prins, "A hybrid genetic algorithm with adaptive diversity management for a large class of vehicle routing problems with time-windows," *Computers & OR* 40(1):475-489, 2013.

### Solvers
- T. Achterberg, "SCIP: solving constraint integer programs," *Math. Prog. Computation* 1(1):1-41, 2009.
- Q. Huangfu, J. A. J. Hall, "Parallelizing the dual revised simplex method," *Math. Prog. Computation* 10(1):119-142, 2018, DOI 10.1007/s12532-017-0130-5. (HiGHS)
- A. Gleixner et al., "MIPLIB 2017: data-driven compilation of the 6th mixed-integer programming library," *Math. Prog. Computation* 13:443-490, 2021, DOI 10.1007/s12532-020-00194-3.

### ADMM
- S. Boyd, N. Parikh, E. Chu, B. Peleato, J. Eckstein, "Distributed optimization and statistical learning via the alternating direction method of multipliers," *Foundations and Trends in Machine Learning* 3(1):1-122, 2011.

### Modern Methods (GPU LP, ML-for-Optimization) — see `modern-advances.md`
- D. Applegate, M. Díaz, O. Hinder, H. Lu, M. Lubin, B. O'Donoghue, W. Schudy, "Practical large-scale linear programming using primal-dual hybrid gradient," *NeurIPS* 2021, arXiv:2106.04756. (PDLP)
- H. Lu, J. Yang, "cuPDLP-C: A strengthened implementation of cuPDLP for LP using C," arXiv:2312.14832, 2024. (GPU LP)
- M. Gasse, D. Chételat, N. Ferroni, L. Charlin, A. Lodi, "Exact combinatorial optimization with graph convolutional neural networks," *NeurIPS* 2019, arXiv:1906.01629. (learning to branch)
- Y. Bengio, A. Lodi, A. Prouvost, "Machine learning for combinatorial optimization: a methodological tour d'horizon," *EJOR* 290(2):405-421, 2021. (survey)
- W. Kool, H. van Hoof, M. Welling, "Attention, learn to solve routing problems!", *ICLR* 2019, arXiv:1803.08475. (neural combinatorial optimization)
- A. N. Elmachtoub, P. Grigas, "Smart 'Predict, then Optimize'," *Management Science* 68(1):9-26, 2022. (decision-focused learning)
- L. Accorsi, D. Vigo, "A fast and scalable heuristic for the solution of large-scale capacitated vehicle routing problems," *Transportation Science* 55(4):832-856, 2021. (FILO)

---

## 5. Online Official Documentation

### Solvers
- Gurobi: https://docs.gurobi.com/
- Gurobi Modeling Examples: https://github.com/Gurobi/modeling-examples
- Gurobi Knowledge Base: https://support.gurobi.com/
- IBM CPLEX: https://www.ibm.com/docs/en/icos
- Google OR-Tools: https://developers.google.com/optimization
- OR-Tools CP-SAT docs: https://github.com/google/or-tools/blob/stable/ortools/sat/docs/
- **CP-SAT Primer** (Krupke): https://d-krupke.github.io/cpsat-primer/
- SCIP: https://www.scipopt.org/
- PySCIPOpt: https://github.com/scipopt/PySCIPOpt
- HiGHS: https://highs.dev/ ; https://ergo-code.github.io/HiGHS/
- Mosek: https://docs.mosek.com/
- COPT: https://shanshu.ai/copt

### Python Libraries
- Pyomo: https://pyomo.readthedocs.io/
- PuLP: https://coin-or.github.io/pulp/
- python-mip: https://python-mip.readthedocs.io/
- CVXPY: https://www.cvxpy.org/
- JuMP (Julia): https://jump.dev/

### Benchmarks
- MIPLIB 2017: https://miplib.zib.de/
- TSPLIB95: http://comopt.ifi.uni-heidelberg.de/software/TSPLIB95/
- CVRPLIB: http://vrp.atd-lab.inf.puc-rio.br/
- OR-Library: http://people.brunel.ac.uk/~mastjjb/jeb/info.html
- Mittelmann Benchmarks: https://plato.asu.edu/bench.html
- MiniZinc Challenge: https://www.minizinc.org/challenge.html

---

## 6. Blogs & Explanations

### Japanese
- **Toshiharu Umetani "Introduction to Optimization Modeling @Onboarding Training"** Recruit Data Blog: https://blog.recruit.co.jp/data/articles/optimization_modeling/ (Shift scheduling with Python-MIP)
- **Toshiharu Umetani Zenn Scrap "Reference Books for Mathematical Optimization"**: https://zenn.dev/umepon/scraps/e94d092c1158768a26f2
- **Toshiharu Umetani Zenn "Implementation of Weighted Local Search for the Generalized Assignment Problem"** (Mathematical Optimization Advent Calendar 2024 Day 25): https://zenn.dev/umepon/articles/4f1e77a4722906 (Generic framework for weighted local search, weight design for hard/soft constraints, detailed in `practice-wisdom.md` §5)
- Toshiharu Umetani Zenn Article "Behind-the-Scenes Story of 'Solidly Learning Mathematical Optimization' Part 2": https://zenn.dev/umepon/articles/18bb262a258f98 (Mathematical Optimization Advent Calendar 2024 Day 24)
- **Mikio Kubo Presentation Materials**: https://www.logopt.com/kubomikio/presen/
- Mikio Kubo Speaker Deck "Fusion of Mathematical Optimization and Machine Learning": https://speakerdeck.com/mickey_kubo/shu-li-zui-shi-hua-toji-jie-xue-xi-norong-he
- ALGO ARTIS Zenn publication: https://zenn.dev/p/algoartis
- ALGO ARTIS note tech magazine: https://note.com/algoartis/m/m37d890aa994f
- NTT Data Mathematical Systems msiism.jp: https://www.msiism.jp/

### English
- "Yet Another Math Programming Consultant" (E. Kalvelagen): http://yetanothermathprogrammingconsultant.blogspot.com/
- "OR in an OB World" (P. Rubin): https://orinanobworld.blogspot.com/
- INFORMS Connect: https://connect.informs.org/

---

## 7. Domestic Communities

- Mathematical Optimization Advent Calendar (Qiita): https://qiita.com/advent-calendar/2024/mathematical-optimization (held annually)
- Casual Optimization (https://opt-casual.connpass.com/)
- ORSJ (Operations Research Society of Japan): https://orsj.org/

---

## Citation Style

When presenting references to users from this skill:
- **Books**: Author, *Book Title*, Publisher, Year, ISBN
- **Papers**: Author, "Title," *Journal Name* vol(no):pp, year, DOI or URL
- **Online**: URL + Access date

Write as "Wolsey's *Integer Programming*, 2nd ed., Wiley, 2020" rather than "Wolsey's book."
