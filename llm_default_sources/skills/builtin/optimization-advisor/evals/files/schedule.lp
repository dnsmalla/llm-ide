\ Single-machine scheduling — deliberately INFEASIBLE.
\ Job A must finish by 8 (proc time 6 => start <= 2), but a forced setup
\ window requires start >= 4. finA and setupA directly conflict; an IIS
\ should surface {finA, setupA} (and the analogous B pair).
Minimize
 obj: tardiness
Subject To
 finA:   sA <= 2
 finB:   sB <= 3
 noov1:  sB - sA + 1000 yAB >= 6
 noov2:  sA - sB + 1000 yBA >= 5
 order:  yAB + yBA = 1
 setupA: sA >= 4
 setupB: sB >= 4
 tdef:   tardiness >= 0
Bounds
 0 <= sA <= 8
 0 <= sB <= 8
Binaries
 yAB yBA
End
