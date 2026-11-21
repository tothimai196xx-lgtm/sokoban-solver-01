// Push-optimal Sokoban solver, written from scratch for make.fun sokoban-solver-01.
//
// Idea (from first principles, no copied solver code):
//  - The generator builds a level as a 1-wide hallway plus 1-4 rooms, each room
//    holding 3-4 boxes/goals behind a single door, and a box pushed out of a room
//    can never come back. So a level's push-optimal count is the sum of its rooms'
//    optima, and each room can be solved on its own.
//  - Each room is solved push-optimally with A* over PUSHES (macro moves): a
//    state is the sorted box positions plus the player's reachable region
//    (canonicalised to its lowest cell). Successors are the pushes the player
//    can actually reach. The heuristic is the minimum-cost assignment of boxes
//    to goals under BFS distances through walls (admissible: one push moves one
//    box one square), so the first goal state popped is push-optimal.
//  - Dead states are pruned: frozen boxes (no push direction open against
//    walls), boxes stuck against a wall run that holds no goal, and 2x2
//    wall/box blocks with no box on a goal.
//  - Rooms are then stitched together with plain walks through the hallway
//    (walks cost no pushes). The whole answer is replay-verified before it is
//    written; anything that fails verification falls back to an empty answer
//    rather than an illegal one.
//  - Determinism: every budget is a count of node expansions, never the wall
//    clock; no randomness, no clock reads, no environment reads except the two
//    MAKEFUN directories (as the kit's starter does). Two runs therefore write
//    byte-identical outputs.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: 0 = up, 1 = down, 2 = left, 3 = right. Opposite of d is d ^ 1.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];

// Expansion budgets (counts, not time, so runs are deterministic).
const ROOM_EXPANSIONS = 400_000;
const DIRECT_EXPANSIONS = 800_000;
const TOTAL_EXPANSION_CAP = 8_000_000;
let totalExpansions = 0;

type Level = {
  w: number;
  h: number;
  wall: boolean[];
  goals: Set<number>;
  goalList: number[];
  boxes: number[];
  player: number;
};

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall: boolean[] = new Array(w * h).fill(true);
  const goals = new Set<number>();
  const goalList: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#';
      if (ch === '.' || ch === '*' || ch === '+') {
        goals.add(i);
        goalList.push(i);
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goalList.sort((a, b) => a - b);
  return { w, h, wall, goals, goalList, boxes, player };
}

const idx = (lv: Level, x: number, y: number): number => y * lv.w + x;
const inGrid = (lv: Level, x: number, y: number): boolean => x >= 0 && x < lv.w && y >= 0 && y < lv.h;

/** All permutations of [0..n-1], as arrays of goal indexes (n <= 4, so at most 24). */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a = Array.from({ length: n }, (_, i) => i);
  const gen = (k: number): void => {
    if (k === n) {
      out.push(a.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      [a[k], a[i]] = [a[i]!, a[k]!];
      gen(k + 1);
      [a[k], a[i]] = [a[i]!, a[k]!];
    }
  };
  gen(0);
  return out;
}

/**
 * Push-optimal A* for one enclosed area.
 * cells: squares boxes may occupy. walkExtra: one extra square the player may
 *   stand on but boxes may not (the hallway square outside a room's door), or
 *   null. goals/boxes: inside cells. startPlayer: where the player stands.
 * requireExit: goal states must also let the player reach walkExtra (so the
 *   player can leave the room afterwards).
 * Returns the move string, its push count and the player's final square, or
 * null when the budget runs out or the area is unsolvable.
 */
function solvePush(
  lv: Level,
  cells: Set<number>,
  goals: number[],
  boxes: number[],
  startPlayer: number,
  walkExtra: number | null,
  requireExit: boolean,
  budget: number,
): { moves: string; pushes: number; finalPlayer: number; expansions: number } | null {
  const w = lv.w;
  const n = boxes.length;
  if (n === 0) return { moves: '', pushes: 0, finalPlayer: startPlayer, expansions: 0 };
  const goalSet = new Set(goals);
  const walkSet = new Set<number>(cells);
  if (walkExtra !== null) walkSet.add(walkExtra);

  const isBoxSquare = (c: number): boolean => cells.has(c);
  // A square a box can never be pushed onto: a wall or outside the room.
  const boxBlocked = (c: number): boolean => lv.wall[c] === true || !isBoxSquare(c);
  // A square the player can never stand on: a wall or outside the walk area.
  const standBlocked = (c: number): boolean => lv.wall[c] === true || !walkSet.has(c);
  // A square that is neither a box destination nor a player stance (a real
  // wall, or floor outside the room the player cannot reach either). The
  // hallway square outside a door is NOT solid: a box cannot be pushed onto
  // it, but the player can stand there and push the door box inward.
  const solidAt = (cx: number, cy: number): boolean => {
    if (!inGrid(lv, cx, cy)) return true;
    const c = idx(lv, cx, cy);
    return boxBlocked(c) && standBlocked(c);
  };

  // BFS distances from each goal over box squares only.
  const dist: Int32Array[] = goals.map((g) => {
    const d = new Int32Array(w * lv.h).fill(-1);
    d[g] = 0;
    const q = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi]!;
      const cx = c % w;
      const cy = Math.floor(c / w);
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k]!;
        const ny = cy + DY[k]!;
        if (!inGrid(lv, nx, ny)) continue;
        const nc = idx(lv, nx, ny);
        if (d[nc] !== -1 || !isBoxSquare(nc)) continue;
        d[nc] = d[c]! + 1;
        q.push(nc);
      }
    }
    return d;
  });

  const perms = permutations(n);
  const hCache = new Map<string, number>();
  const heuristic = (bs: number[]): number => {
    const key = bs.join(',');
    const hit = hCache.get(key);
    if (hit !== undefined) return hit;
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = dist[p[i]!]![bs[i]!]!;
        if (d < 0) {
          s = Infinity;
          break;
        }
        s += d;
      }
      if (s < best) best = s;
    }
    hCache.set(key, best);
    return best;
  };

  // Deadlock test on a box set (boxes sorted). True = no solution from here.
  const isDead = (bs: number[], bsSet: Set<number>): boolean => {
    for (const b of bs) {
      if (goalSet.has(b)) continue;
      const bx = b % w;
      const by = Math.floor(b / w);
      // Frozen: every push direction is closed off by walls alone. (A
      // direction closed off by another box may open up later, so it does
      // not count here.)
      let frozen = true;
      for (let d = 0; d < 4; d++) {
        const dest = idx(lv, bx + DX[d]!, by + DY[d]!);
        const behind = idx(lv, bx - DX[d]!, by - DY[d]!);
        const destOk = inGrid(lv, bx + DX[d]!, by + DY[d]!) && !boxBlocked(dest);
        const behindOk = inGrid(lv, bx - DX[d]!, by - DY[d]!) && !standBlocked(behind);
        if (destOk && behindOk) {
          frozen = false;
          break;
        }
      }
      if (frozen) return true;
      // Against a wall: take the whole maximal stretch of box squares the box
      // can slide along (horizontally for a wall above/below, vertically for
      // a wall left/right). If every square of the stretch has a wall on that
      // side, the box can never be pushed away from the wall, so it can only
      // slide inside the stretch; if the stretch holds no goal, it is lost.
      const strips: [number, number, number, number][] = [
        [1, 0, 0, -1], // slide horizontally, wall above
        [1, 0, 0, 1], // slide horizontally, wall below
        [0, 1, -1, 0], // slide vertically, wall left
        [0, 1, 1, 0], // slide vertically, wall right
      ];
      for (const [sx, sy, wx, wy] of strips) {
        const stretch: number[] = [b];
        for (const step of [1, -1]) {
          for (let t = 1; ; t++) {
            const cx = bx + sx * step * t;
            const cy = by + sy * step * t;
            if (!inGrid(lv, cx, cy)) break;
            const c = idx(lv, cx, cy);
            if (!isBoxSquare(c)) break;
            stretch.push(c);
          }
        }
        let allWalled = true;
        let hasGoal = false;
        for (const c of stretch) {
          if (goalSet.has(c)) hasGoal = true;
          const wnx = (c % w) + wx;
          const wny = Math.floor(c / w) + wy;
          if (!solidAt(wnx, wny)) {
            allWalled = false;
            break;
          }
        }
        if (allWalled && !hasGoal) return true;
      }
      // 2x2 block of walls/boxes holding a box but no box on a goal.
      for (const [ox, oy] of [
        [0, 0],
        [-1, 0],
        [0, -1],
        [-1, -1],
      ] as [number, number][]) {
        const coords: [number, number][] = [
          [bx + ox, by + oy],
          [bx + ox + 1, by + oy],
          [bx + ox, by + oy + 1],
          [bx + ox + 1, by + oy + 1],
        ];
        if (coords.some(([cx, cy]) => !inGrid(lv, cx, cy))) continue;
        const cs = coords.map(([cx, cy]) => idx(lv, cx, cy));
        let boxesIn = 0;
        let boxOnGoal = false;
        let closed = true;
        for (const c of cs) {
          if (bsSet.has(c)) {
            boxesIn++;
            if (goalSet.has(c)) boxOnGoal = true;
          } else if (!lv.wall[c]) {
            // Open floor (including the hallway square outside a door):
            // a box in the block can be pushed out through it.
            closed = false;
            break;
          }
        }
        if (closed && boxesIn > 0 && !boxOnGoal) return true;
      }
    }
    return false;
  };

  // Flood fill of the player's reachable region from `from`, boxes as
  // obstacles. Returns visited flags and the BFS parent of every visited
  // square (for rebuilding the walk to a push square).
  const reachable = (
    from: number,
    bsSet: Set<number>,
  ): { seen: Uint8Array; parent: Int32Array; canon: number } => {
    const seen = new Uint8Array(w * lv.h);
    const parent = new Int32Array(w * lv.h).fill(-1);
    const q = [from];
    seen[from] = 1;
    let canon = from;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi]!;
      if (c < canon) canon = c;
      const cx = c % w;
      const cy = Math.floor(c / w);
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k]!;
        const ny = cy + DY[k]!;
        if (!inGrid(lv, nx, ny)) continue;
        const nc = idx(lv, nx, ny);
        if (seen[nc] || standBlocked(nc) || bsSet.has(nc)) continue;
        seen[nc] = 1;
        parent[nc] = c;
        q.push(nc);
      }
    }
    return { seen, parent, canon };
  };

  // Walk string from `from` to `to` along the BFS tree of `parent`.
  const walkString = (from: number, to: number, parent: Int32Array): string => {
    if (from === to) return '';
    const steps: string[] = [];
    let c = to;
    while (c !== from) {
      const p = parent[c]!;
      const dx = (c % w) - (p % w);
      const dy = Math.floor(c / w) - Math.floor(p / w);
      steps.push(dx === 1 ? 'r' : dx === -1 ? 'l' : dy === 1 ? 'd' : 'u');
      c = p;
    }
    steps.reverse();
    return steps.join('');
  };

  const startBoxes = boxes.slice().sort((a, b) => a - b);
  const startSet = new Set(startBoxes);
  if (startBoxes.every((b) => goalSet.has(b))) {
    return { moves: '', pushes: 0, finalPlayer: startPlayer, expansions: 0 };
  }
  if (isDead(startBoxes, startSet)) return null;
  const h0 = heuristic(startBoxes);
  if (!Number.isFinite(h0)) return null;

  // A* state tables.
  const sBoxes: number[][] = [startBoxes];
  const sPlayer: number[] = [startPlayer];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sSeg: string[] = [''];
  const sKey: string[] = [''];
  const best = new Map<string, number>();
  const startCanon = reachable(startPlayer, startSet).canon;
  sKey[0] = startBoxes.join(',') + '|' + startCanon;
  best.set(sKey[0]!, 0);

  // Binary heap of [f, g, state], ordered by f, then deeper g, then older.
  const heap: [number, number, number][] = [[h0, 0, 0]];
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let expansions = 0;
  while (heap.length > 0) {
    if (expansions >= budget || totalExpansions >= TOTAL_EXPANSION_CAP) return null;
    const [, g, s] = heapPop();
    if (best.get(sKey[s]!) !== s) continue; // stale heap entry
    const bs = sBoxes[s]!;
    const player = sPlayer[s]!;
    if (bs.every((b) => goalSet.has(b))) {
      if (!requireExit || walkExtra === null) {
        let moves = '';
        for (let t = s; t > 0; t = sParent[t]!) moves = sSeg[t]! + moves;
        return { moves, pushes: g, finalPlayer: player, expansions };
      }
      const finSet = new Set(bs);
      const finReach = reachable(player, finSet);
      if (finReach.seen[walkExtra]) {
        let moves = '';
        for (let t = s; t > 0; t = sParent[t]!) moves = sSeg[t]! + moves;
        return { moves, pushes: g, finalPlayer: player, expansions };
      }
      // Goal boxes but the player is trapped inside: keep searching.
    }
    expansions++;
    totalExpansions++;
    const bsSet = new Set(bs);
    const { seen, parent } = reachable(player, bsSet);
    for (let bi = 0; bi < n; bi++) {
      const b = bs[bi]!;
      const bx = b % w;
      const by = Math.floor(b / w);
      for (let d = 0; d < 4; d++) {
        const destX = bx + DX[d]!;
        const destY = by + DY[d]!;
        const behindX = bx - DX[d]!;
        const behindY = by - DY[d]!;
        if (!inGrid(lv, destX, destY) || !inGrid(lv, behindX, behindY)) continue;
        const dest = idx(lv, destX, destY);
        const behind = idx(lv, behindX, behindY);
        if (boxBlocked(dest) || bsSet.has(dest)) continue;
        if (!seen[behind]) continue; // player cannot get behind the box
        const nb = bs.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        const nbSet = new Set(nb);
        if (isDead(nb, nbSet)) continue;
        const hh = heuristic(nb);
        if (!Number.isFinite(hh)) continue;
        const key = nb.join(',') + '|' + reachable(b, nbSet).canon;
        // Note: the player's square after the push is b; its reachable
        // region from b with the new boxes gives the canonical square.
        const prev = best.get(key);
        if (prev !== undefined && sG[prev]! <= g + 1) continue;
        const t = sBoxes.length;
        sBoxes.push(nb);
        sPlayer.push(b);
        sG.push(g + 1);
        sParent.push(s);
        sSeg.push(walkString(player, behind, parent) + CH[d]!);
        sKey.push(key);
        best.set(key, t);
        heapPush([g + 1 + hh, g + 1, t]);
      }
    }
  }
  return null;
}

type Room = {
  cells: Set<number>;
  goals: number[];
  boxes: number[];
  door: number;
  entry: number;
};

/** Split a level into hallway + rooms. Null when the shape is unexpected. */
function findRooms(lv: Level): Room[] | null {
  const w = lv.w;
  const hr = Math.floor(lv.player / w);
  const seenSets = new Map<string, Room>();
  for (let x = 0; x < w; x++) {
    if (lv.wall[idx(lv, x, hr)]) continue;
    for (const dy of [-1, 1]) {
      const y = hr + dy;
      if (!inGrid(lv, x, y)) continue;
      const door = idx(lv, x, y);
      if (lv.wall[door]) continue;
      // Flood fill the room: floor squares, never crossing the hallway row.
      const cells = new Set<number>();
      const q = [door];
      cells.add(door);
      for (let qi = 0; qi < q.length; qi++) {
        const c = q[qi]!;
        const cx = c % w;
        const cy = Math.floor(c / w);
        for (let k = 0; k < 4; k++) {
          const nx = cx + DX[k]!;
          const ny = cy + DY[k]!;
          if (!inGrid(lv, nx, ny) || ny === hr) continue;
          const nc = idx(lv, nx, ny);
          if (lv.wall[nc] || cells.has(nc)) continue;
          cells.add(nc);
          q.push(nc);
        }
      }
      const key = [...cells].sort((a, b) => a - b).join(',');
      if (seenSets.has(key)) continue;
      // A real room touches the hallway in exactly one square: its door.
      let touch = 0;
      for (const c of cells) {
        const cy = Math.floor(c / w);
        if (Math.abs(cy - hr) === 1 && !lv.wall[idx(lv, c % w, hr)]) touch++;
      }
      if (touch !== 1) return null;
      const goals = lv.goalList.filter((g) => cells.has(g));
      const boxes = lv.boxes.filter((b) => cells.has(b));
      if (boxes.length === 0 || boxes.length !== goals.length) return null;
      seenSets.set(key, { cells, goals, boxes, door, entry: idx(lv, x, hr) });
    }
  }
  const rooms = [...seenSets.values()].sort((a, b) => a.door - b.door);
  const covered = rooms.reduce((a, r) => a + r.boxes.length, 0);
  if (rooms.length === 0 || covered !== lv.boxes.length) return null;
  return rooms;
}

/** Shortest walk (u/d/l/r) from `from` to `to` over floor squares, avoiding `blocked`. */
function walkPath(lv: Level, from: number, to: number, blocked: Set<number>): string | null {
  if (from === to) return '';
  const w = lv.w;
  const parent = new Int32Array(w * lv.h).fill(-1);
  const seen = new Uint8Array(w * lv.h);
  const q = [from];
  seen[from] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    if (c === to) break;
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (let k = 0; k < 4; k++) {
      const nx = cx + DX[k]!;
      const ny = cy + DY[k]!;
      if (!inGrid(lv, nx, ny)) continue;
      const nc = idx(lv, nx, ny);
      if (seen[nc] || lv.wall[nc] || blocked.has(nc)) continue;
      seen[nc] = 1;
      parent[nc] = c;
      q.push(nc);
    }
  }
  if (!seen[to]) return null;
  const steps: string[] = [];
  let c = to;
  while (c !== from) {
    const p = parent[c]!;
    const dx = (c % w) - (p % w);
    const dy = Math.floor(c / w) - Math.floor(p / w);
    steps.push(dx === 1 ? 'r' : dx === -1 ? 'l' : dy === 1 ? 'd' : 'u');
    c = p;
  }
  steps.reverse();
  return steps.join('');
}

/** Replay `moves` on the level. Returns push count, or -1 when illegal / unsolved. */
function replay(lv: Level, moves: string): number {
  const w = lv.w;
  const boxes = new Set(lv.boxes);
  let player = lv.player;
  let pushes = 0;
  for (const ch of moves) {
    const d = CH.indexOf(ch.toLowerCase());
    if (d < 0) return -1;
    const nx = (player % w) + DX[d]!;
    const ny = Math.floor(player / w) + DY[d]!;
    if (!inGrid(lv, nx, ny)) return -1;
    const nc = idx(lv, nx, ny);
    if (lv.wall[nc]) return -1;
    if (boxes.has(nc)) {
      const bx = nx + DX[d]!;
      const by = ny + DY[d]!;
      if (!inGrid(lv, bx, by)) return -1;
      const bc = idx(lv, bx, by);
      if (lv.wall[bc] || boxes.has(bc)) return -1;
      boxes.delete(nc);
      boxes.add(bc);
      pushes++;
    }
    player = nc;
  }
  for (const b of boxes) if (!lv.goals.has(b)) return -1;
  return pushes;
}

function solveLevel(lv: Level): string {
  const rooms = findRooms(lv);
  if (rooms === null) {
    // Unexpected shape: solve the whole level as one push problem.
    const cells = new Set<number>();
    for (let i = 0; i < lv.w * lv.h; i++) if (!lv.wall[i]) cells.add(i);
    const r = solvePush(lv, cells, lv.goalList, lv.boxes, lv.player, null, false, DIRECT_EXPANSIONS);
    if (r === null) return '';
    return replay(lv, r.moves) >= 0 ? r.moves : '';
  }

  // Solve every room on its own (push-optimally).
  type Solved = { room: Room; moves: string; pushes: number; finalPlayer: number };
  const solved: Solved[] = [];
  for (const room of rooms) {
    const r = solvePush(lv, room.cells, room.goals, room.boxes, room.entry, room.entry, false, ROOM_EXPANSIONS);
    if (r === null) return '';
    solved.push({ room, moves: r.moves, pushes: r.pushes, finalPlayer: r.finalPlayer });
  }

  // The player must be able to leave every room except the one visited last.
  // If a room's optimal finish traps the player inside, re-solve it with the
  // exit requirement; the trapped room (if one stays trapped) goes last.
  const exitReachable = (s: Solved): boolean => {
    const blocked = new Set<number>(s.room.goals);
    const seen = new Uint8Array(lv.w * lv.h);
    const q = [s.finalPlayer];
    seen[s.finalPlayer] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi]!;
      if (c === s.room.entry) return true;
      const cx = c % lv.w;
      const cy = Math.floor(c / lv.w);
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k]!;
        const ny = cy + DY[k]!;
        if (!inGrid(lv, nx, ny)) continue;
        const nc = idx(lv, nx, ny);
        if (seen[nc] || lv.wall[nc] || blocked.has(nc)) continue;
        seen[nc] = 1;
        q.push(nc);
      }
    }
    return false;
  };
  const trappedIdx = solved.map((s, i) => (exitReachable(s) ? -1 : i)).filter((i) => i >= 0);
  if (trappedIdx.length > 1) {
    for (let t = 0; t < trappedIdx.length - 1; t++) {
      const i = trappedIdx[t]!;
      const s = solved[i]!;
      const r = solvePush(lv, s.room.cells, s.room.goals, s.room.boxes, s.room.entry, s.room.entry, true, ROOM_EXPANSIONS);
      if (r !== null) solved[i] = { room: s.room, moves: r.moves, pushes: r.pushes, finalPlayer: r.finalPlayer };
    }
  }
  const order = solved
    .map((s, i) => i)
    .sort((a, b) => {
      const ta = exitReachable(solved[a]!) ? 0 : 1;
      const tb = exitReachable(solved[b]!) ? 0 : 1;
      return ta - tb || a - b;
    });

  // Stitch the rooms together with hallway walks.
  let moves = '';
  let cur = lv.player;
  const boxesNow = new Set<number>(lv.boxes);
  for (const oi of order) {
    const s = solved[oi]!;
    const walk = walkPath(lv, cur, s.room.entry, boxesNow);
    if (walk === null) return '';
    moves += walk;
    cur = s.room.entry;
    moves += s.moves;
    cur = s.finalPlayer;
    for (const b of s.room.boxes) boxesNow.delete(b);
    for (const g of s.room.goals) boxesNow.add(g);
  }
  return replay(lv, moves) >= 0 ? moves : '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8')));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
