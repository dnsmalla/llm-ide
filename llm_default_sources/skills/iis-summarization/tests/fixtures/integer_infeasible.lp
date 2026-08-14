\ Synthetic MIP that is infeasible ONLY because of integrality:
\ 2x = 1 forces x = 0.5, which is feasible for the LP relaxation
\ but impossible for integer x.
Minimize
  obj: x
Subject To
  half: 2 x = 1
Bounds
  0 <= x <= 1
Generals
  x
End
