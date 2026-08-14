\ Infeasible model with a pathological coefficient range (1e-7 .. 1e+8,
\ ratio 1e15 — far beyond Gurobi's recommended 1e9 maximum).
\ Used to test the proactive numerics screen.
Minimize
  obj: x
Subject To
  tiny_coef: 0.0000001 x + y >= 10
  big_coef: 100000000 x + y <= 5
Bounds
  0 <= x <= 100
  0 <= y <= 100
End
