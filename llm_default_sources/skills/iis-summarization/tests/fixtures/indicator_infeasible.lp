\ Infeasible ONLY through an indicator (general) constraint:
\ b is forced to 1, the indicator then forces x >= 10, but cap says x <= 5.
\ feasRelax cannot relax the indicator — the tool must still report it.
Minimize
  obj: x
Subject To
  fix_b: b = 1
  ind: b = 1 -> x >= 10
  cap: x <= 5
Bounds
  0 <= x <= 100
Binaries
  b
End
