# sokoban-solver-01

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/tothimai196xx-lgtm/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/tothimai196xx-lgtm/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver,
21 November 2026" bounty ($100 in USDC). One program, `main.ts`, answers all
5 instances of a set in a single run.

## Practice results

| instance | boxes | P\* pushes | solver pushes | points |
|----------|-------|-----------|---------------|--------|
| i001 | 3 | 13 | 13 | 1,000 |
| i002 | 4 | 16 | 16 | 1,000 |
| i003 | 8 | 29 | 29 | 1,000 |
| i004 | 12 | 47 | 47 | 1,000 |
| i005 | 16 | 60 | 60 | 1,000 |

Practice score **1,000,000 / 1,000,000** in ~0.6 s for the whole set (limit
60 s). The house baseline, plain-astar 1.0.0, scores 200,000 on the same set
(it only solves i001). The solver also scored 1,000,000 on three further
held-out sets drawn with the kit's generator from other drand rounds.

## How it works

The generator builds every level as a 1-wide hallway plus 1–4 rooms, each
room holding 3–4 boxes and as many goals behind a single door, and a box
pushed out of a room can never come back — so a level's push-optimal count
is the sum of its rooms' optima, and each room can be solved on its own.

1. **Decompose.** The hallway row is found from the player's start square;
   each door (the one floor square in the wall row above/below the hallway)
   flood-fills one room. A room is its cells, its boxes/goals, its door, and
   the hallway square outside the door, where the player stands to enter.
2. **Solve each room push-optimally** with A\* over pushes (macro moves): a
   state is the sorted box positions plus the player's reachable region
   (canonicalised to its lowest reachable square). Successors are the pushes
   the player can actually reach. The heuristic is the minimum-cost
   assignment of boxes to goals under BFS distances through walls — one push
   moves one box one square, so it is admissible, and the first goal state
   popped is push-optimal.
3. **Prune dead states:** frozen boxes (no push direction open against
   walls), boxes stuck against a wall stretch that holds no goal, and 2×2
   wall/box blocks with no box on a goal. The hallway square outside a door
   counts as standable for the player (it can push a door box inward) even
   though a box can never be pushed onto it.
4. **Stitch rooms together** with plain walks through the hallway (walks cost
   no pushes). If a room's optimal finish traps the player inside, that room
   is visited last, or re-solved with the exit requirement. The whole answer
   is replay-verified before it is written; anything that fails verification
   falls back to an empty answer rather than an illegal one.

Determinism: every budget is a count of node expansions, never the wall
clock; no randomness, no clock reads. Two runs write byte-identical outputs.

## Run it

```sh
node main.ts
```

Node 22, standard library only, no network, no install. `main.ts` reads the
levels from `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`), creating the output
directories itself.
