// Grid pathfinding so avatars route around desks instead of walking straight
// over them. Pure geometry — obstacle rectangles in, world-space waypoints out
// — so it unit-tests like the rest of ./office/ with no canvas or DOM.

// Grid resolution: small enough to thread the ~38px aisles between desk
// columns, large enough that a whole-room search stays cheap.
export const PATH_CELL = 16;

// A cell counts as blocked when its center falls inside an obstacle grown by
// this margin, keeping an avatar's body clear of the desk it walks past.
const OBSTACLE_MARGIN = 4;

const SQRT2 = Math.SQRT2;

// The blocked box a desk occupies, mirroring drawDeskFurniture: from the
// monitor top (anchor - 84) down to the desk legs (anchor + 10), spanning the
// 112px desktop. The chair (anchor + 18) sits just below the box, so an avatar
// can still walk up and take its seat.
export function deskFootprint(anchor) {
  return { x: anchor.x - 56, y: anchor.y - 84, width: 112, height: 94 };
}

function pointBlocked(x, y, obstacles) {
  for (const rect of obstacles) {
    if (
      x >= rect.x - OBSTACLE_MARGIN &&
      x <= rect.x + rect.width + OBSTACLE_MARGIN &&
      y >= rect.y - OBSTACLE_MARGIN &&
      y <= rect.y + rect.height + OBSTACLE_MARGIN
    ) {
      return true;
    }
  }
  return false;
}

// Is the straight segment a->b free of every obstacle? Sampled at half-cell
// steps, which is dense enough that no obstacle (all far wider than a cell)
// slips between samples. Used to straighten the grid path into natural walks.
function segmentClear(a, b, obstacles) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(distance / (PATH_CELL / 2)));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    if (pointBlocked(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, obstacles)) {
      return false;
    }
  }
  return true;
}

// String-pulling: keep a waypoint only when the straight line from the last
// kept point to the one past it would clip an obstacle, collapsing the grid's
// stair-steps into long diagonals.
function straighten(points, obstacles) {
  if (points.length <= 2) return points;
  const kept = [points[0]];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let next = points.length - 1;
    while (next > anchor + 1 && !segmentClear(points[anchor], points[next], obstacles)) {
      next -= 1;
    }
    kept.push(points[next]);
    anchor = next;
  }
  return kept;
}

function nearestFreeCell(column, row, blocked, columns, rows) {
  if (!blocked[row * columns + column]) return { column, row };
  const maxRadius = Math.max(columns, rows);
  for (let radius = 1; radius < maxRadius; radius += 1) {
    for (let deltaRow = -radius; deltaRow <= radius; deltaRow += 1) {
      for (let deltaColumn = -radius; deltaColumn <= radius; deltaColumn += 1) {
        if (Math.max(Math.abs(deltaRow), Math.abs(deltaColumn)) !== radius) continue;
        const nextColumn = column + deltaColumn;
        const nextRow = row + deltaRow;
        if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= rows) continue;
        if (!blocked[nextRow * columns + nextColumn]) return { column: nextColumn, row: nextRow };
      }
    }
  }
  return { column, row };
}

// A binary min-heap keyed by f-score, keeping the A* frontier scan-free.
function createHeap() {
  const items = [];
  return {
    get size() {
      return items.length;
    },
    push(node) {
      items.push(node);
      let index = items.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (items[parent].f <= items[index].f) break;
        [items[parent], items[index]] = [items[index], items[parent]];
        index = parent;
      }
    },
    pop() {
      const top = items[0];
      const last = items.pop();
      if (items.length > 0) {
        items[0] = last;
        let index = 0;
        for (;;) {
          const left = index * 2 + 1;
          const right = left + 1;
          let smallest = index;
          if (left < items.length && items[left].f < items[smallest].f) smallest = left;
          if (right < items.length && items[right].f < items[smallest].f) smallest = right;
          if (smallest === index) break;
          [items[smallest], items[index]] = [items[index], items[smallest]];
          index = smallest;
        }
      }
      return top;
    },
  };
}

const NEIGHBORS = [
  { column: 1, row: 0, cost: 1 },
  { column: -1, row: 0, cost: 1 },
  { column: 0, row: 1, cost: 1 },
  { column: 0, row: -1, cost: 1 },
  { column: 1, row: 1, cost: SQRT2 },
  { column: 1, row: -1, cost: SQRT2 },
  { column: -1, row: 1, cost: SQRT2 },
  { column: -1, row: -1, cost: SQRT2 },
];

// A* over a uniform grid, returning the world-space waypoints an avatar should
// walk (start excluded, goal included). Diagonal moves may not cut a blocked
// corner. Falls back to a straight [goal] hop when no route exists, so the
// caller degrades to the old walk-straight behavior rather than freezing.
export function findPath(start, goal, obstacles, bounds) {
  const columns = Math.max(1, Math.ceil(bounds.width / PATH_CELL));
  const rows = Math.max(1, Math.ceil(bounds.height / PATH_CELL));
  const half = PATH_CELL / 2;
  const centerX = (column) => column * PATH_CELL + half;
  const centerY = (row) => row * PATH_CELL + half;
  const clamp = (value, max) => Math.min(Math.max(value, 0), max);

  const blocked = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      blocked[row * columns + column] = pointBlocked(centerX(column), centerY(row), obstacles)
        ? 1
        : 0;
    }
  }

  const startCell = nearestFreeCell(
    clamp(Math.floor(start.x / PATH_CELL), columns - 1),
    clamp(Math.floor(start.y / PATH_CELL), rows - 1),
    blocked,
    columns,
    rows
  );
  const goalCell = nearestFreeCell(
    clamp(Math.floor(goal.x / PATH_CELL), columns - 1),
    clamp(Math.floor(goal.y / PATH_CELL), rows - 1),
    blocked,
    columns,
    rows
  );

  const startIndex = startCell.row * columns + startCell.column;
  const goalIndex = goalCell.row * columns + goalCell.column;
  const gScore = new Float64Array(columns * rows).fill(Infinity);
  const cameFrom = new Int32Array(columns * rows).fill(-1);
  const closed = new Uint8Array(columns * rows);
  const heuristic = (column, row) => {
    const dx = Math.abs(column - goalCell.column);
    const dy = Math.abs(row - goalCell.row);
    return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
  };

  const heap = createHeap();
  gScore[startIndex] = 0;
  heap.push({ index: startIndex, column: startCell.column, row: startCell.row, f: heuristic(startCell.column, startCell.row) });

  let reached = false;
  while (heap.size > 0) {
    const current = heap.pop();
    if (closed[current.index]) continue;
    if (current.index === goalIndex) {
      reached = true;
      break;
    }
    closed[current.index] = 1;
    for (const step of NEIGHBORS) {
      const nextColumn = current.column + step.column;
      const nextRow = current.row + step.row;
      if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= rows) continue;
      const nextIndex = nextRow * columns + nextColumn;
      if (blocked[nextIndex] || closed[nextIndex]) continue;
      // No corner cutting: a diagonal step needs both shared orthogonals free.
      if (step.column !== 0 && step.row !== 0) {
        if (blocked[current.row * columns + nextColumn]) continue;
        if (blocked[nextRow * columns + current.column]) continue;
      }
      const tentative = gScore[current.index] + step.cost;
      if (tentative >= gScore[nextIndex]) continue;
      gScore[nextIndex] = tentative;
      cameFrom[nextIndex] = current.index;
      heap.push({
        index: nextIndex,
        column: nextColumn,
        row: nextRow,
        f: tentative + heuristic(nextColumn, nextRow),
      });
    }
  }

  if (!reached) return [{ x: goal.x, y: goal.y }];

  const cells = [];
  for (let index = goalIndex; index !== -1; index = cameFrom[index]) {
    cells.push(index);
    if (index === startIndex) break;
  }
  cells.reverse();

  const points = [{ x: start.x, y: start.y }];
  for (const index of cells) {
    points.push({ x: centerX(index % columns), y: centerY(Math.floor(index / columns)) });
  }
  points.push({ x: goal.x, y: goal.y });

  const waypoints = straighten(points, obstacles).slice(1);
  return waypoints.length > 0 ? waypoints : [{ x: goal.x, y: goal.y }];
}
