/**
 * Sketch operations — pure-function primitives + composite drawing tools.
 *
 * SINGLE SOURCE OF TRUTH for the point-allocate/merge/append logic that
 * builds up an `EditorState`. Both the in-browser sketch editor store
 * (src/sketch/sketchEditorStore.ts) and the MCP-side drawing
 * commands (@tweakcad/core/src/commands/handlers/sketchDrawCommands.ts)
 * delegate here so they can't drift.
 *
 * Design rules:
 *
 *   - **Pure functions only.** Every operation takes `state` and returns
 *     `{ result?, state }`. No closures over a Zustand store, no global
 *     counters, no React. Same function used from a server, the worker,
 *     or a unit test produces the same output.
 *
 *   - **State is immutable.** Each function returns a NEW `EditorState`
 *     (with new Map instances) — never mutates the input. This matches
 *     the editor store's existing setter pattern and lets command
 *     handlers reason about before/after states.
 *
 *   - **IDs are injectable.** Tests pass a deterministic id factory; the
 *     default (`makeUuidIdFactory`) uses `crypto.randomUUID()` for prod.
 *     The editor store's existing counter-based factory keeps working
 *     because it stays inside the store; it just becomes one of many
 *     possible factories.
 *
 *   - **Coincident points are merged structurally.** `findOrCreatePoint`
 *     scans existing points; if any is within `tolerance` mm of the
 *     requested coordinates, its id is reused. Default tolerance is
 *     1e-6 mm (strict — caller must send matching numbers). This is
 *     what produces shared corners → closed loops → extrudable
 *     profiles.
 *
 *   - **Composite drawing tools build on the primitives.** `drawLine`,
 *     `drawRectangle`, `drawCircle` allocate points + append geometries
 *     + add the constraints that lock the shape. `drawRectangle` produces
 *     8 distinct corner points + 4 coincident + 2 horizontal + 2 vertical
 *     — see its docstring for the full rationale.
 *
 *   - **No composite shape entities (invariant #11).**
 *     Rectangle / slot / polygon are decomposed at draw time into their
 *     constituent curves + constraints; they're never stored as a single
 *     `Sketch{Rectangle,Slot,Polygon}Entity`. The serializer
 *     ([./serialization.ts](./serialization.ts)) emits each line / arc /
 *     circle one-for-one, so the rectangle/slot return ids here are
 *     editor-state ids — no naming convention is needed to round-trip
 *     them through the document.
 */

import type {
  SketchPoint,
  SketchPointId,
  SketchGeometry,
  SketchGeometryId,
  SketchGeometryInput,
  SketchConstraint,
  SketchConstraintId,
  SketchConstraintInput,
} from './types.ts';
import { sketchPointId, sketchGeometryId, sketchConstraintId } from './types.ts';
import { generateId } from '../ids.ts';

// ---- Types ------------------------------------------------------------------

/**
 * The shared editor model: a map of points, geometries that reference
 * points by id, and constraints that reference both. This is the shape
 * the in-browser editor store uses internally, and what gets serialized
 * into a sketch feature's `editorModel` for document persistence.
 *
 * Why Maps not Records: lookup is O(1) regardless of size, and the
 * editor store already standardized on Maps for incremental mutation.
 */
export interface EditorState {
  points: ReadonlyMap<SketchPointId, SketchPoint>;
  geometries: ReadonlyMap<SketchGeometryId, SketchGeometry>;
  constraints: ReadonlyMap<SketchConstraintId, SketchConstraint>;
}

/** Empty state for fresh sketches. */
export function emptyEditorState(): EditorState {
  return {
    points: new Map(),
    geometries: new Map(),
    constraints: new Map(),
  };
}

/**
 * Id factory — abstracted so tests can inject deterministic ids without
 * touching the production path. The factory receives a domain hint
 * (`'pt'` / `'geo'` / `'con'`) and must return a unique string.
 */
export type IdFactory = (kind: 'pt' | 'geo' | 'con') => string;

/** Default production factory: crypto-random ids matching `ids.generateId`. */
export const defaultIdFactory: IdFactory = (kind) => generateId(kind);

/**
 * Build a counter-based factory for deterministic test output. The
 * returned function emits `pt_1`, `pt_2`, …, `geo_1`, …, each kind
 * counted independently.
 */
export function makeCounterIdFactory(): IdFactory {
  const counters: Record<string, number> = { pt: 0, geo: 0, con: 0 };
  return (kind) => `${kind}_${++counters[kind]!}`;
}

/** Strict default tolerance for coincident-point merging (mm). */
export const COINCIDENT_TOLERANCE_MM = 1e-6;

// ---- Snapshot conversion ----------------------------------------------------
//
// Document storage uses `SketchEditorSnapshot` which is array-based +
// types each list as `unknown[]` (per its docstring, the document layer
// doesn't validate against the branded id types). Operations work in
// Map form for O(1) lookup, so we convert at the boundary.

/** Array-form snapshot suitable for storing inside the document. */
export interface EditorSnapshot {
  points: SketchPoint[];
  geometries: SketchGeometry[];
  constraints: SketchConstraint[];
}

/**
 * Reconstitute a snapshot into a working `EditorState`. Accepts the
 * widened `unknown[]` form from the document because the document
 * layer doesn't enforce the sketch types — we trust the editor wrote
 * valid data and cast at the boundary.
 */
export function fromSnapshot(snapshot: {
  points?: readonly unknown[];
  geometries?: readonly unknown[];
  constraints?: readonly unknown[];
} | undefined): EditorState {
  if (!snapshot) return emptyEditorState();
  const points = new Map<SketchPointId, SketchPoint>();
  for (const p of (snapshot.points ?? []) as SketchPoint[]) {
    points.set(p.id, p);
  }
  const geometries = new Map<SketchGeometryId, SketchGeometry>();
  for (const g of (snapshot.geometries ?? []) as SketchGeometry[]) {
    geometries.set(g.id, g);
  }
  const constraints = new Map<SketchConstraintId, SketchConstraint>();
  for (const c of (snapshot.constraints ?? []) as SketchConstraint[]) {
    constraints.set(c.id, c);
  }
  return { points, geometries, constraints };
}

/** Flatten an `EditorState` back into a serializable snapshot. */
export function toSnapshot(state: EditorState): EditorSnapshot {
  return {
    points: Array.from(state.points.values()),
    geometries: Array.from(state.geometries.values()),
    constraints: Array.from(state.constraints.values()),
  };
}

// ---- Primitives -------------------------------------------------------------

/**
 * Append a new point. Returns the new id and the new state. The
 * caller is responsible for deduplication if needed — use
 * `findOrCreatePoint` for coincident-merging behavior.
 */
export function addPoint(
  state: EditorState,
  x: number,
  y: number,
  opts: { fixed?: boolean; idFactory?: IdFactory } = {},
): { id: SketchPointId; state: EditorState } {
  const idFactory = opts.idFactory ?? defaultIdFactory;
  const id = sketchPointId(idFactory('pt'));
  const point: SketchPoint = { id, x, y, fixed: opts.fixed ?? false };
  const points = new Map(state.points);
  points.set(id, point);
  return { id, state: { ...state, points } };
}

/**
 * Find an existing point within `tolerance` mm of `(x, y)` or create
 * a new one. Reusing existing point ids is how shared corners (and
 * therefore closed loops) emerge: a rectangle's 4 corners share the
 * same `SketchPointId` between adjacent edges, so the region detector
 * walks them as one polygon instead of seeing 4 unconnected lines.
 *
 * The search is linear in point count. Sketches rarely exceed a few
 * hundred points, so we accept the O(n) cost for code simplicity.
 *
 * `reused: true` indicates an existing point id was returned; the
 * caller may want to log or surface that distinction (e.g. an MCP
 * client might want to know its `to` coordinate snapped to a prior
 * corner).
 */
export function findOrCreatePoint(
  state: EditorState,
  x: number,
  y: number,
  opts: { tolerance?: number; idFactory?: IdFactory } = {},
): { id: SketchPointId; state: EditorState; reused: boolean } {
  const tolerance = opts.tolerance ?? COINCIDENT_TOLERANCE_MM;
  // Compare squared distance to avoid the sqrt. tolerance^2 is the
  // threshold; if a point's |dx|+|dy| even exceeds tolerance on one
  // axis we can early-bail before computing the square.
  const tolSq = tolerance * tolerance;
  for (const point of state.points.values()) {
    const dx = point.x - x;
    if (Math.abs(dx) > tolerance) continue;
    const dy = point.y - y;
    if (Math.abs(dy) > tolerance) continue;
    if (dx * dx + dy * dy <= tolSq) {
      return { id: point.id, state, reused: true };
    }
  }
  const added = addPoint(state, x, y, opts);
  return { ...added, reused: false };
}

/**
 * Append a geometry. The caller passes a partial without `id` — we
 * allocate one. If the caller wants a specific id (e.g. rectangle
 * edges using `makeRectangleEdgeIds`), pass it as `idOverride`.
 *
 * The geometry's point references must already exist in `state.points`
 * — call `findOrCreatePoint` or `addPoint` first.
 *
 * Why `SketchGeometryInput`: `SketchGeometry` is a discriminated union
 * (line / circle / arc / …). A naive `Omit<SketchGeometry, 'id'>`
 * distributes the omit but the result loses per-variant fields like
 * `startId` and `centerId`. The existing `SketchGeometryInput` type
 * distributes the omit correctly across each variant.
 */
export function addGeometry(
  state: EditorState,
  geomInput: SketchGeometryInput,
  opts: { idOverride?: SketchGeometryId; idFactory?: IdFactory } = {},
): { id: SketchGeometryId; state: EditorState } {
  const idFactory = opts.idFactory ?? defaultIdFactory;
  const id = opts.idOverride ?? sketchGeometryId(idFactory('geo'));
  const geom = { ...geomInput, id } as SketchGeometry;
  const geometries = new Map(state.geometries);
  geometries.set(id, geom);
  return { id, state: { ...state, geometries } };
}

/**
 * Append a constraint. The caller passes a partial without `id` — we
 * allocate one. Pure-function counterpart to the bus-side dedupe +
 * tentative-solve flow (`applyConstraintWithSolver` in
 * `applyConstraintPipeline.ts`), minus the solver / conflict-rollback
 * logic — this primitive just records the constraint.
 *
 * Callers needing conflict detection should solve after the append and
 * decide what to do with the result; the editor store handles that flow.
 */
export function addConstraint(
  state: EditorState,
  constraintInput: SketchConstraintInput,
  opts: { idFactory?: IdFactory } = {},
): { id: SketchConstraintId; state: EditorState } {
  const idFactory = opts.idFactory ?? defaultIdFactory;
  const id = (constraintInput.id ?? sketchConstraintId(idFactory('con'))) as SketchConstraintId;
  const constraint = { ...constraintInput, id } as SketchConstraint;
  const constraints = new Map(state.constraints);
  constraints.set(id, constraint);
  return { id, state: { ...state, constraints } };
}

// ---- Composite drawing tools ------------------------------------------------

export interface DrawLineOptions {
  /** Coincident-point merge tolerance in mm. Default 1e-6. */
  tolerance?: number;
  /** Construction geometry (dashed, not used for profiles). */
  construction?: boolean;
  /** Deterministic id factory for tests. Default crypto-random. */
  idFactory?: IdFactory;
  /**
   * Allocate the start endpoint as a fresh `SketchPoint` instead of
   * merging with whatever existing point sits at the `from` coords.
   * Used by the in-app line tool's chain mode: each segment owns its
   * endpoints, and chain adjacency is expressed as an explicit
   * `coincident` constraint between this segment's start and the
   * previous segment's end. Without this flag the
   * default `findOrCreatePoint` would silently merge the two, making
   * the chain a single shared point that can't be torn apart.
   */
  distinctStart?: boolean;
  /** Same as `distinctStart` but for the end endpoint. */
  distinctEnd?: boolean;
}

/**
 * Draw a line from `from` to `to`. Endpoints reuse existing points
 * within tolerance, otherwise allocate fresh ones. This is the
 * behavior that turns 4 sequentially-drawn lines into a closed
 * rectangle: each new line's endpoint snaps to the previous line's
 * endpoint by coordinate, sharing the same `SketchPointId`.
 */
export function drawLine(
  state: EditorState,
  from: readonly [number, number],
  to: readonly [number, number],
  opts: DrawLineOptions = {},
): { state: EditorState; lineId: SketchGeometryId; startId: SketchPointId; endId: SketchPointId } {
  const ptOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};
  const start = opts.distinctStart
    ? addPoint(state, from[0], from[1], ptOpts)
    : findOrCreatePoint(state, from[0], from[1], opts);
  const end = opts.distinctEnd
    ? addPoint(start.state, to[0], to[1], ptOpts)
    : findOrCreatePoint(start.state, to[0], to[1], opts);
  const added = addGeometry(
    end.state,
    {
      type: 'line',
      startId: start.id,
      endId: end.id,
      construction: opts.construction ?? false,
    },
    opts.idFactory ? { idFactory: opts.idFactory } : {},
  );
  return {
    state: added.state,
    lineId: added.id,
    startId: start.id,
    endId: end.id,
  };
}

export interface DrawRectangleOptions {
  /** Coincident-point merge tolerance in mm. Default 1e-6. */
  tolerance?: number;
  /** Construction geometry (all 4 edges). */
  construction?: boolean;
  /** Deterministic id factory for tests. Default crypto-random. */
  idFactory?: IdFactory;
}

/**
 * Draw an axis-aligned rectangle — **8-point canonical model**.
 *
 * Each of the 4 edges owns its 2 distinct endpoints (8 points total).
 * Adjacent edges share corner coordinates but NOT point ids; coincidence
 * at each corner is expressed as a removable `coincident` constraint.
 * Axis-alignment is locked with 2 `horizontal` + 2 `vertical` constraints.
 *
 * This is what `src/sketch/sketchTools.ts handleRectangleClick`
 * already does in the UI. Why this matters:
 *
 *   - Breaking a single coincident lets the user deform the rectangle
 *     into a quadrilateral without touching the orthogonality locks.
 *   - Removing one horizontal lets a single edge tilt — the rectangle
 *     becomes a trapezoid, the other three constraints still hold.
 *   - Every junction = exactly one removable constraint.
 *
 * An earlier 4-shared-point implementation was structurally inconsistent
 * with how the UI editor builds rectangles; it produced unconstrained
 * quads that couldn't survive a corner drag without distorting.
 *
 * `corner` is the lower-left corner (min X, min Y). Width and height
 * extend in the +X / +Y directions. Negative width/height is allowed
 * and produces a rectangle on the other side; the corners get
 * computed by min/max so the entity stays normalized.
 *
 * Returns ids for both the 4 edges and the 8 distinct corner points
 * (one per edge endpoint), plus the 8 constraint ids that lock the
 * rectangle into shape — so MCP callers can reference any of them.
 */
export function drawRectangle(
  state: EditorState,
  args: { corner: readonly [number, number]; width: number; height: number },
  opts: DrawRectangleOptions = {},
): {
  state: EditorState;
  edges: { bottom: SketchGeometryId; right: SketchGeometryId; top: SketchGeometryId; left: SketchGeometryId };
  /**
   * 8 distinct corner points (one pair per edge). Edge naming:
   *   - bottom: bottomStart (xmin, ymin) → bottomEnd (xmax, ymin)
   *   - right:  rightStart  (xmax, ymin) → rightEnd  (xmax, ymax)
   *   - top:    topStart    (xmax, ymax) → topEnd    (xmin, ymax)
   *   - left:   leftStart   (xmin, ymax) → leftEnd   (xmin, ymin)
   * Adjacent endpoints share coordinates but NOT ids.
   */
  points: {
    bottomStart: SketchPointId; bottomEnd: SketchPointId;
    rightStart: SketchPointId;  rightEnd: SketchPointId;
    topStart: SketchPointId;    topEnd: SketchPointId;
    leftStart: SketchPointId;   leftEnd: SketchPointId;
  };
  constraints: {
    /** 4 corner coincidents — bottomEnd⇿rightStart, rightEnd⇿topStart, topEnd⇿leftStart, leftEnd⇿bottomStart. */
    cornerCoincidents: [SketchConstraintId, SketchConstraintId, SketchConstraintId, SketchConstraintId];
    /** horizontal on bottom + top. */
    horizontals: [SketchConstraintId, SketchConstraintId];
    /** vertical on right + left. */
    verticals: [SketchConstraintId, SketchConstraintId];
  };
} {
  // Normalize so negative width/height still produces a valid rectangle.
  const xmin = Math.min(args.corner[0], args.corner[0] + args.width);
  const xmax = Math.max(args.corner[0], args.corner[0] + args.width);
  const ymin = Math.min(args.corner[1], args.corner[1] + args.height);
  const ymax = Math.max(args.corner[1], args.corner[1] + args.height);

  const construction = opts.construction ?? false;
  const ptOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};

  // Allocate 8 distinct corner points — we deliberately do NOT use
  // findOrCreatePoint here because the rectangle owns its corners.
  // Coincidence between this rectangle's adjacent endpoints is expressed
  // as a constraint, not as a shared id.
  const bottomStartPt = addPoint(state, xmin, ymin, ptOpts);
  const bottomEndPt = addPoint(bottomStartPt.state, xmax, ymin, ptOpts);
  const rightStartPt = addPoint(bottomEndPt.state, xmax, ymin, ptOpts);
  const rightEndPt = addPoint(rightStartPt.state, xmax, ymax, ptOpts);
  const topStartPt = addPoint(rightEndPt.state, xmax, ymax, ptOpts);
  const topEndPt = addPoint(topStartPt.state, xmin, ymax, ptOpts);
  const leftStartPt = addPoint(topEndPt.state, xmin, ymax, ptOpts);
  const leftEndPt = addPoint(leftStartPt.state, xmin, ymin, ptOpts);

  // Edge geometries (CCW). Each gets a fresh id; no naming convention
  // is needed — the serializer emits one document entity per line, not
  // a collapsed composite (cad-architecture.md invariant #11).
  const edgeOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};
  const bottomGeom = addGeometry(
    leftEndPt.state,
    { type: 'line', startId: bottomStartPt.id, endId: bottomEndPt.id, construction },
    edgeOpts,
  );
  const rightGeom = addGeometry(
    bottomGeom.state,
    { type: 'line', startId: rightStartPt.id, endId: rightEndPt.id, construction },
    edgeOpts,
  );
  const topGeom = addGeometry(
    rightGeom.state,
    { type: 'line', startId: topStartPt.id, endId: topEndPt.id, construction },
    edgeOpts,
  );
  const leftGeom = addGeometry(
    topGeom.state,
    { type: 'line', startId: leftStartPt.id, endId: leftEndPt.id, construction },
    edgeOpts,
  );

  // 4 corner coincidents (links adjacent edges' endpoints).
  const conOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};
  const c1 = addConstraint(leftGeom.state, { type: 'coincident', pointA: bottomEndPt.id, pointB: rightStartPt.id }, conOpts);
  const c2 = addConstraint(c1.state, { type: 'coincident', pointA: rightEndPt.id, pointB: topStartPt.id }, conOpts);
  const c3 = addConstraint(c2.state, { type: 'coincident', pointA: topEndPt.id, pointB: leftStartPt.id }, conOpts);
  const c4 = addConstraint(c3.state, { type: 'coincident', pointA: leftEndPt.id, pointB: bottomStartPt.id }, conOpts);

  // 2 horizontal + 2 vertical (axis-alignment).
  const h1 = addConstraint(c4.state, { type: 'horizontal', geometryId: bottomGeom.id }, conOpts);
  const h2 = addConstraint(h1.state, { type: 'horizontal', geometryId: topGeom.id }, conOpts);
  const v1 = addConstraint(h2.state, { type: 'vertical', geometryId: rightGeom.id }, conOpts);
  const v2 = addConstraint(v1.state, { type: 'vertical', geometryId: leftGeom.id }, conOpts);

  return {
    state: v2.state,
    edges: {
      bottom: bottomGeom.id,
      right: rightGeom.id,
      top: topGeom.id,
      left: leftGeom.id,
    },
    points: {
      bottomStart: bottomStartPt.id, bottomEnd: bottomEndPt.id,
      rightStart: rightStartPt.id,   rightEnd: rightEndPt.id,
      topStart: topStartPt.id,       topEnd: topEndPt.id,
      leftStart: leftStartPt.id,     leftEnd: leftEndPt.id,
    },
    constraints: {
      cornerCoincidents: [c1.id, c2.id, c3.id, c4.id],
      horizontals: [h1.id, h2.id],
      verticals: [v1.id, v2.id],
    },
  };
}

export interface DrawCircleOptions {
  /** Coincident-point merge tolerance in mm. Default 1e-6. */
  tolerance?: number;
  /** Construction geometry. */
  construction?: boolean;
  /** Deterministic id factory for tests. Default crypto-random. */
  idFactory?: IdFactory;
}

/**
 * Draw a circle from `center` and `radius`. The center is a
 * point — reused if one already exists at those coords — and the
 * circle geometry references it. Circles are intrinsically closed
 * so no shared-corner logic is needed.
 */
export function drawCircle(
  state: EditorState,
  args: { center: readonly [number, number]; radius: number },
  opts: DrawCircleOptions = {},
): { state: EditorState; circleId: SketchGeometryId; centerId: SketchPointId } {
  if (args.radius <= 0) {
    throw new Error(`drawCircle: radius must be positive, got ${args.radius}`);
  }
  const findOpts = opts.idFactory
    ? { idFactory: opts.idFactory, ...(opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {}) }
    : (opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {});
  const center = findOrCreatePoint(state, args.center[0], args.center[1], findOpts);
  const added = addGeometry(
    center.state,
    {
      type: 'circle',
      centerId: center.id,
      radius: args.radius,
      construction: opts.construction ?? false,
    },
    opts.idFactory ? { idFactory: opts.idFactory } : {},
  );
  return { state: added.state, circleId: added.id, centerId: center.id };
}

export interface DrawSlotOptions {
  /** Coincident-point merge tolerance in mm. Default 1e-6. */
  tolerance?: number;
  /** Construction geometry. */
  construction?: boolean;
  /** Deterministic id factory for tests. Default crypto-random. */
  idFactory?: IdFactory;
}

/**
 * Draw a slot (stadium shape) as **decomposed primitives** — Closed
 * Decision #1 / cad-architecture.md Invariant #11 ("there is no spoon"):
 * a slot is 2 lines + 2 arcs held together by constraints, never stored
 * as a composite `SketchSlot` entity.
 *
 * Topology (CCW loop): topLeft → arc_left → bottomLeft → line_bottom →
 * bottomRight → arc_right → topRight → line_top → topLeft.
 *
 * Constraints:
 *   - 4× coincident — one per corner, linking the line-owned endpoint
 *     to the arc-owned endpoint (each entity owns its endpoints,
 *     adjacency is a removable constraint).
 *   - 4× tangent — each line tangent to each arc.
 *   - 1× equal — the two arcs share radius.
 *   - 1× parallel — the two lines are parallel.
 *
 * Centers are reused via `findOrCreatePoint` (user-supplied anchor
 * points — sharable with other geometry). The 8 corner points are
 * allocated distinct. The two centers must not be
 * coincident — a zero-length slot is degenerate.
 */
export function drawSlot(
  state: EditorState,
  args: {
    center1: readonly [number, number];
    center2: readonly [number, number];
    width: number;
  },
  opts: DrawSlotOptions = {},
): {
  state: EditorState;
  center1Id: SketchPointId;
  center2Id: SketchPointId;
  lines: { top: SketchGeometryId; bottom: SketchGeometryId };
  arcs: { left: SketchGeometryId; right: SketchGeometryId };
  corners: {
    topLeftLine: SketchPointId;    topLeftArc: SketchPointId;
    bottomLeftLine: SketchPointId; bottomLeftArc: SketchPointId;
    topRightLine: SketchPointId;   topRightArc: SketchPointId;
    bottomRightLine: SketchPointId; bottomRightArc: SketchPointId;
  };
  constraints: {
    coincidents: [SketchConstraintId, SketchConstraintId, SketchConstraintId, SketchConstraintId];
    tangents: [SketchConstraintId, SketchConstraintId, SketchConstraintId, SketchConstraintId];
    equalRadius: SketchConstraintId;
    parallel: SketchConstraintId;
  };
} {
  if (args.width <= 0) {
    throw new Error(`drawSlot: width must be positive, got ${args.width}`);
  }
  const tol = opts.tolerance ?? COINCIDENT_TOLERANCE_MM;
  const dx = args.center2[0] - args.center1[0];
  const dy = args.center2[1] - args.center1[1];
  const L = Math.hypot(dx, dy);
  if (L < tol) {
    throw new Error('drawSlot: center1 and center2 must be distinct points');
  }
  const r = args.width / 2;
  // Unit perpendicular, 90° CCW from the c1→c2 axis. The "top" side of
  // the slot is +perp, "bottom" is -perp.
  const perpX = -dy / L;
  const perpY = dx / L;

  const findOpts = opts.idFactory
    ? { idFactory: opts.idFactory, ...(opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {}) }
    : (opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {});
  const ptOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};
  const geoOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};
  const conOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};
  const construction = opts.construction ?? false;

  // Centers — reused if a point already exists at those coords (lets
  // the slot share anchors with other geometry).
  const c1 = findOrCreatePoint(state, args.center1[0], args.center1[1], findOpts);
  const c2 = findOrCreatePoint(c1.state, args.center2[0], args.center2[1], findOpts);

  // Corner coords.
  const tlX = args.center1[0] + r * perpX;
  const tlY = args.center1[1] + r * perpY;
  const blX = args.center1[0] - r * perpX;
  const blY = args.center1[1] - r * perpY;
  const trX = args.center2[0] + r * perpX;
  const trY = args.center2[1] + r * perpY;
  const brX = args.center2[0] - r * perpX;
  const brY = args.center2[1] - r * perpY;

  // 8 distinct corner points (each line/arc owns its endpoints;
  // adjacency = coincident constraint, not shared id).
  const tlLine = addPoint(c2.state, tlX, tlY, ptOpts);
  const trLine = addPoint(tlLine.state, trX, trY, ptOpts);
  const blLine = addPoint(trLine.state, blX, blY, ptOpts);
  const brLine = addPoint(blLine.state, brX, brY, ptOpts);
  const tlArc = addPoint(brLine.state, tlX, tlY, ptOpts);
  const blArc = addPoint(tlArc.state, blX, blY, ptOpts);
  const brArc = addPoint(blArc.state, brX, brY, ptOpts);
  const trArc = addPoint(brArc.state, trX, trY, ptOpts);

  // 2 lines.
  const lineTop = addGeometry(
    trArc.state,
    { type: 'line', startId: tlLine.id, endId: trLine.id, construction },
    geoOpts,
  );
  const lineBot = addGeometry(
    lineTop.state,
    { type: 'line', startId: blLine.id, endId: brLine.id, construction },
    geoOpts,
  );

  // 2 arcs. arc_left winds CCW from tl (start) → leftmost → bl (end);
  // arc_right winds CCW from br (start) → rightmost → tr (end). Picking
  // CCW windings + opposite endpoint orientation between caps is what
  // makes the slot loop CCW overall (so the region detector sees a
  // single closed profile).
  const arcLeft = addGeometry(
    lineBot.state,
    { type: 'arc', centerId: c1.id, startId: tlArc.id, endId: blArc.id, radius: r, construction },
    geoOpts,
  );
  const arcRight = addGeometry(
    arcLeft.state,
    { type: 'arc', centerId: c2.id, startId: brArc.id, endId: trArc.id, radius: r, construction },
    geoOpts,
  );

  // 4 corner coincidents.
  const cTL = addConstraint(arcRight.state, { type: 'coincident', pointA: tlLine.id, pointB: tlArc.id }, conOpts);
  const cBL = addConstraint(cTL.state, { type: 'coincident', pointA: blLine.id, pointB: blArc.id }, conOpts);
  const cTR = addConstraint(cBL.state, { type: 'coincident', pointA: trLine.id, pointB: trArc.id }, conOpts);
  const cBR = addConstraint(cTR.state, { type: 'coincident', pointA: brLine.id, pointB: brArc.id }, conOpts);

  // 4 tangents — each line tangent to each arc.
  const tTL = addConstraint(cBR.state, { type: 'tangent', lineId: lineTop.id, circleId: arcLeft.id }, conOpts);
  const tTR = addConstraint(tTL.state, { type: 'tangent', lineId: lineTop.id, circleId: arcRight.id }, conOpts);
  const tBL = addConstraint(tTR.state, { type: 'tangent', lineId: lineBot.id, circleId: arcLeft.id }, conOpts);
  const tBR = addConstraint(tBL.state, { type: 'tangent', lineId: lineBot.id, circleId: arcRight.id }, conOpts);

  // 1 equal-radius between the two arcs.
  const eqR = addConstraint(tBR.state, { type: 'equal', geometryA: arcLeft.id, geometryB: arcRight.id }, conOpts);

  // 1 parallel between the two lines.
  const par = addConstraint(eqR.state, { type: 'parallel', geometryA: lineTop.id, geometryB: lineBot.id }, conOpts);

  return {
    state: par.state,
    center1Id: c1.id,
    center2Id: c2.id,
    lines: { top: lineTop.id, bottom: lineBot.id },
    arcs: { left: arcLeft.id, right: arcRight.id },
    corners: {
      topLeftLine: tlLine.id,    topLeftArc: tlArc.id,
      bottomLeftLine: blLine.id, bottomLeftArc: blArc.id,
      topRightLine: trLine.id,   topRightArc: trArc.id,
      bottomRightLine: brLine.id, bottomRightArc: brArc.id,
    },
    constraints: {
      coincidents: [cTL.id, cBL.id, cTR.id, cBR.id],
      tangents: [tTL.id, tTR.id, tBL.id, tBR.id],
      equalRadius: eqR.id,
      parallel: par.id,
    },
  };
}

export interface DrawArcOptions {
  /** Coincident-point merge tolerance in mm. Default 1e-6. */
  tolerance?: number;
  /** Construction geometry. */
  construction?: boolean;
  /** Deterministic id factory for tests. Default crypto-random. */
  idFactory?: IdFactory;
  /**
   * Allocate the start endpoint as a fresh `SketchPoint` instead of merging
   * with a coincident existing point. Mirrors {@link DrawLineOptions.distinctStart}
   * — used by importers that express junctions as removable `coincident`
   * constraints between distinct points rather than as a shared point id.
   */
  distinctStart?: boolean;
  /** Same as `distinctStart` but for the end endpoint. */
  distinctEnd?: boolean;
}

/**
 * Draw an arc from `center` + `radius` + `startAngle` + `endAngle`
 * (angles in radians, CCW).
 *
 * The arc has three point references (center, start, end). The start
 * and end points are placed at `center + radius * (cos θ, sin θ)`
 * for each angle. All three may snap to existing coincident points
 * (e.g. an arc that joins a line endpoint shares that line's endpoint
 * id, forming a closed loop with the line).
 *
 * The arc winds CCW from `startAngle` to `endAngle`. Pass
 * `endAngle > startAngle` for a positive sweep; you can pass a negative
 * sweep by flipping them, but the OCCT builder expects CCW so we
 * normalize: if `endAngle < startAngle` we add 2π so the geometry
 * always represents the CCW arc from start to end.
 */
export function drawArc(
  state: EditorState,
  args: {
    center: readonly [number, number];
    radius: number;
    startAngle: number;
    endAngle: number;
  },
  opts: DrawArcOptions = {},
): {
  state: EditorState;
  arcId: SketchGeometryId;
  centerId: SketchPointId;
  startId: SketchPointId;
  endId: SketchPointId;
} {
  if (args.radius <= 0) {
    throw new Error(`drawArc: radius must be positive, got ${args.radius}`);
  }
  if (!Number.isFinite(args.startAngle) || !Number.isFinite(args.endAngle)) {
    throw new Error('drawArc: startAngle and endAngle must be finite numbers (radians).');
  }
  // Normalize so the sweep is always non-zero CCW. If end < start we
  // add 2π once — the loop covers the long way around. If they're
  // equal we reject (zero-length arc).
  const { startAngle } = args;
  let { endAngle } = args;
  if (endAngle === startAngle) {
    throw new Error('drawArc: startAngle and endAngle must differ.');
  }
  if (endAngle < startAngle) endAngle += 2 * Math.PI;

  const findOpts = opts.idFactory
    ? { idFactory: opts.idFactory, ...(opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {}) }
    : (opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {});

  const ptOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};
  const center = findOrCreatePoint(state, args.center[0], args.center[1], findOpts);
  const startX = args.center[0] + args.radius * Math.cos(startAngle);
  const startY = args.center[1] + args.radius * Math.sin(startAngle);
  const endX = args.center[0] + args.radius * Math.cos(endAngle);
  const endY = args.center[1] + args.radius * Math.sin(endAngle);
  const startPt = opts.distinctStart
    ? addPoint(center.state, startX, startY, ptOpts)
    : findOrCreatePoint(center.state, startX, startY, findOpts);
  const endPt = opts.distinctEnd
    ? addPoint(startPt.state, endX, endY, ptOpts)
    : findOrCreatePoint(startPt.state, endX, endY, findOpts);

  const added = addGeometry(
    endPt.state,
    {
      type: 'arc',
      centerId: center.id,
      startId: startPt.id,
      endId: endPt.id,
      radius: args.radius,
      construction: opts.construction ?? false,
    },
    opts.idFactory ? { idFactory: opts.idFactory } : {},
  );
  return {
    state: added.state,
    arcId: added.id,
    centerId: center.id,
    startId: startPt.id,
    endId: endPt.id,
  };
}

export type DrawArc3PointOptions = DrawArcOptions;

/**
 * Draw an arc passing through three points (start, mid, end). Computes
 * the circumscribed circle's center + radius from the perpendicular
 * bisectors, then delegates to `drawArc` so the resulting arc geometry
 * is structurally identical to the center-mode tool (no special "3-point
 * arc" entity — there is no spoon).
 *
 * The mid point exists only as a construction input; it's NOT preserved
 * as a sketch point, since the arc's geometry is fully determined by
 * center + radius + start + end angles. Callers who want the mid as a
 * sketch point can add it separately.
 */
export function drawArc3Point(
  state: EditorState,
  args: {
    start: readonly [number, number];
    mid: readonly [number, number];
    end: readonly [number, number];
  },
  opts: DrawArc3PointOptions = {},
): {
  state: EditorState;
  arcId: SketchGeometryId;
  centerId: SketchPointId;
  startId: SketchPointId;
  endId: SketchPointId;
} {
  const [ax, ay] = args.start;
  const [bx, by] = args.mid;
  const [cx, cy] = args.end;
  // Perpendicular-bisector intersection. d = 2 * (ax(by-cy) + bx(cy-ay) + cx(ay-by)).
  // d == 0 → collinear → degenerate arc.
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) {
    throw new Error('drawArc3Point: the three points are collinear; cannot form an arc.');
  }
  const aSq = ax * ax + ay * ay;
  const bSq = bx * bx + by * by;
  const cSq = cx * cx + cy * cy;
  const centerX = (aSq * (by - cy) + bSq * (cy - ay) + cSq * (ay - by)) / d;
  const centerY = (aSq * (cx - bx) + bSq * (ax - cx) + cSq * (bx - ax)) / d;
  const radius = Math.hypot(ax - centerX, ay - centerY);
  // Pick the angular sweep that passes through the mid point.
  const startAngle = Math.atan2(ay - centerY, ax - centerX);
  const endAngle = Math.atan2(cy - centerY, cx - centerX);
  const midAngle = Math.atan2(by - centerY, bx - centerX);
  // Normalize so we choose the sweep direction (CCW or CW) that contains mid.
  // drawArc only does CCW; if CCW from start→end doesn't cross mid, swap.
  const normalize = (a: number, base: number): number => {
    let x = a;
    while (x < base) x += 2 * Math.PI;
    while (x >= base + 2 * Math.PI) x -= 2 * Math.PI;
    return x;
  };
  const endCCW = normalize(endAngle, startAngle);
  const midCCW = normalize(midAngle, startAngle);
  // mid must be between start (=0 from base) and endCCW for the CCW sweep
  // to contain it. If not, swap start and end so CCW passes through mid.
  if (midCCW > endCCW) {
    return drawArc(state, { center: [centerX, centerY], radius, startAngle: endAngle, endAngle: startAngle }, opts);
  }
  return drawArc(state, { center: [centerX, centerY], radius, startAngle, endAngle }, opts);
}

export interface DrawPointOptions {
  /** Coincident-point merge tolerance in mm. Default 1e-6. */
  tolerance?: number;
  /** Construction (reference) geometry. */
  construction?: boolean;
  /** Deterministic id factory for tests. Default crypto-random. */
  idFactory?: IdFactory;
}

/**
 * Place a standalone reference point. Allocates (or reuses within
 * tolerance) a `SketchPoint` and wraps it in a `SketchStandalonePoint`
 * geometry so it shows up in the geometry browser as a first-class
 * entity. Used for construction reference, dimension anchor, etc.
 */
export function drawPoint(
  state: EditorState,
  at: readonly [number, number],
  opts: DrawPointOptions = {},
): { state: EditorState; geometryId: SketchGeometryId; pointId: SketchPointId } {
  const findOpts = opts.idFactory
    ? { idFactory: opts.idFactory, ...(opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {}) }
    : (opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {});
  const pt = findOrCreatePoint(state, at[0], at[1], findOpts);
  const added = addGeometry(
    pt.state,
    { type: 'point', pointId: pt.id, construction: opts.construction ?? false },
    opts.idFactory ? { idFactory: opts.idFactory } : {},
  );
  return { state: added.state, geometryId: added.id, pointId: pt.id };
}

export interface DrawEllipseOptions {
  /** Coincident-point merge tolerance in mm. Default 1e-6. */
  tolerance?: number;
  construction?: boolean;
  idFactory?: IdFactory;
}

/**
 * Draw an ellipse from `center` + `major` (the end of the major-axis
 * radius, also defines rotation) + `minorRadius`. The ellipse is a
 * single curve primitive — no decomposition (an ellipse is a curve, not
 * a composite shape — there is no spoon for primitives that ARE curves).
 */
export function drawEllipse(
  state: EditorState,
  args: {
    center: readonly [number, number];
    major: readonly [number, number];
    minorRadius: number;
  },
  opts: DrawEllipseOptions = {},
): {
  state: EditorState;
  ellipseId: SketchGeometryId;
  centerId: SketchPointId;
  majorId: SketchPointId;
} {
  if (args.minorRadius <= 0) {
    throw new Error(`drawEllipse: minorRadius must be positive, got ${args.minorRadius}`);
  }
  const findOpts = opts.idFactory
    ? { idFactory: opts.idFactory, ...(opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {}) }
    : (opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {});
  const center = findOrCreatePoint(state, args.center[0], args.center[1], findOpts);
  const major = findOrCreatePoint(center.state, args.major[0], args.major[1], findOpts);
  const added = addGeometry(
    major.state,
    {
      type: 'ellipse',
      centerId: center.id,
      majorId: major.id,
      minorRadius: args.minorRadius,
      construction: opts.construction ?? false,
    },
    opts.idFactory ? { idFactory: opts.idFactory } : {},
  );
  return {
    state: added.state,
    ellipseId: added.id,
    centerId: center.id,
    majorId: major.id,
  };
}

export interface DrawSplineOptions {
  /** Coincident-point merge tolerance in mm. Default 1e-6. */
  tolerance?: number;
  construction?: boolean;
  idFactory?: IdFactory;
}

/**
 * Draw a spline as an ordered point sequence. Each control point may
 * snap to an existing coincident point. The spline is a single curve
 * primitive (a spline IS a curve — same reasoning as drawEllipse).
 */
export function drawSpline(
  state: EditorState,
  points: ReadonlyArray<readonly [number, number]>,
  opts: DrawSplineOptions = {},
): {
  state: EditorState;
  splineId: SketchGeometryId;
  pointIds: SketchPointId[];
} {
  if (points.length < 2) {
    throw new Error(`drawSpline: need at least 2 points, got ${points.length}`);
  }
  const findOpts = opts.idFactory
    ? { idFactory: opts.idFactory, ...(opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {}) }
    : (opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {});
  let current = state;
  const pointIds: SketchPointId[] = [];
  for (const [x, y] of points) {
    const pt = findOrCreatePoint(current, x, y, findOpts);
    pointIds.push(pt.id);
    current = pt.state;
  }
  const added = addGeometry(
    current,
    { type: 'spline', pointIds, construction: opts.construction ?? false },
    opts.idFactory ? { idFactory: opts.idFactory } : {},
  );
  return { state: added.state, splineId: added.id, pointIds };
}

export interface DrawBezierOptions {
  /** Coincident-point merge tolerance in mm for the on-curve endpoints. */
  tolerance?: number;
  construction?: boolean;
  idFactory?: IdFactory;
  /** Allocate the start endpoint as a fresh point (see {@link DrawLineOptions.distinctStart}). */
  distinctStart?: boolean;
  /** Same as `distinctStart` for the end endpoint. */
  distinctEnd?: boolean;
}

/**
 * Draw a cubic Bezier curve from 4 control points (start, two poles, end).
 * `cp1`/`cp2` are always fresh off-curve points; `start`/`end` reuse existing
 * coincident points unless `distinctStart`/`distinctEnd` force fresh ones
 * (importers use the distinct form + a coincident constraint at junctions).
 */
export function drawBezier(
  state: EditorState,
  args: {
    start: readonly [number, number];
    cp1: readonly [number, number];
    cp2: readonly [number, number];
    end: readonly [number, number];
  },
  opts: DrawBezierOptions = {},
): {
  state: EditorState;
  bezierId: SketchGeometryId;
  startId: SketchPointId;
  cp1Id: SketchPointId;
  cp2Id: SketchPointId;
  endId: SketchPointId;
} {
  const ptOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};
  const findOpts = opts.idFactory
    ? { idFactory: opts.idFactory, ...(opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {}) }
    : (opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {});
  const start = opts.distinctStart
    ? addPoint(state, args.start[0], args.start[1], ptOpts)
    : findOrCreatePoint(state, args.start[0], args.start[1], findOpts);
  const cp1 = addPoint(start.state, args.cp1[0], args.cp1[1], ptOpts);
  const cp2 = addPoint(cp1.state, args.cp2[0], args.cp2[1], ptOpts);
  const end = opts.distinctEnd
    ? addPoint(cp2.state, args.end[0], args.end[1], ptOpts)
    : findOrCreatePoint(cp2.state, args.end[0], args.end[1], findOpts);
  const added = addGeometry(
    end.state,
    {
      type: 'bezier',
      startId: start.id,
      cp1Id: cp1.id,
      cp2Id: cp2.id,
      endId: end.id,
      construction: opts.construction ?? false,
    },
    opts.idFactory ? { idFactory: opts.idFactory } : {},
  );
  return {
    state: added.state,
    bezierId: added.id,
    startId: start.id,
    cp1Id: cp1.id,
    cp2Id: cp2.id,
    endId: end.id,
  };
}

export interface DrawPolygonOptions {
  /** Coincident-point merge tolerance in mm. Default 1e-6. */
  tolerance?: number;
  construction?: boolean;
  idFactory?: IdFactory;
}

/**
 * Draw a regular N-gon as **decomposed primitives** — Closed Decision
 * #1 / cad-architecture.md Invariant #11: a polygon is N lines + a
 * construction center + constraints, never a composite `SketchPolygon`.
 *
 * Inputs: `center` + `vertex` (a point on vertex 0; together they fix
 * orientation and the circumscribed radius).
 *
 * Constraints:
 *   - N× coincident — each line's end ⇿ next line's start (each line owns
 *     its 2 endpoints, adjacency = removable constraint).
 *   - (N−1)× equal — chained equal-length so all N sides match.
 *   - (N−1)× angle — each pair of consecutive lines has the exterior
 *     turn angle = 2π/N (CCW from edge i's direction to edge i+1's
 *     direction). With N coincidents + closure, the Nth angle is forced.
 *
 * Plus a single `SketchStandalonePoint` construction geometry at the
 * polygon center — useful as a parametric handle (drag center to
 * translate the whole polygon). Not part of the geometric definition.
 *
 * Only `inscribed` mode is implemented (vertex on circumscribed circle).
 * Circumscribed mode (edges tangent to inscribed circle) is a follow-up.
 */
export function drawPolygon(
  state: EditorState,
  args: {
    center: readonly [number, number];
    /** A point on vertex 0 — fixes the circumscribed radius and orientation. */
    vertex: readonly [number, number];
    /** Number of sides. Must be an integer in [3, 64]. */
    sides: number;
    /** Inscribed (default): vertex lies on the circumscribed circle. */
    mode?: 'inscribed';
  },
  opts: DrawPolygonOptions = {},
): {
  state: EditorState;
  centerId: SketchPointId;
  /** The `SketchStandalonePoint` geometry id wrapping the center (construction). */
  centerGeometryId: SketchGeometryId;
  /** Ordered N line geometry ids — line i goes vertex_i → vertex_{(i+1)%N}. */
  lineIds: SketchGeometryId[];
  /** Ordered N start-point ids (one per line; line_i.startId). */
  vertexStartIds: SketchPointId[];
  /** Ordered N end-point ids (one per line; line_i.endId). */
  vertexEndIds: SketchPointId[];
  constraints: {
    coincidents: SketchConstraintId[];
    equalLengths: SketchConstraintId[];
    angles: SketchConstraintId[];
  };
} {
  if (!Number.isInteger(args.sides) || args.sides < 3 || args.sides > 64) {
    throw new Error(`drawPolygon: sides must be an integer in [3, 64], got ${args.sides}`);
  }
  if (args.mode !== undefined && args.mode !== 'inscribed') {
    throw new Error(`drawPolygon: only 'inscribed' mode is implemented, got '${args.mode}'`);
  }
  const N = args.sides;
  const [cx, cy] = args.center;
  const [vx, vy] = args.vertex;
  const dx = vx - cx;
  const dy = vy - cy;
  const radius = Math.hypot(dx, dy);
  const tol = opts.tolerance ?? COINCIDENT_TOLERANCE_MM;
  if (radius < tol) {
    throw new Error('drawPolygon: vertex must be distinct from center');
  }
  const angle0 = Math.atan2(dy, dx);

  const findOpts = opts.idFactory
    ? { idFactory: opts.idFactory, ...(opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {}) }
    : (opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {});
  const ptOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};
  const geoOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};
  const conOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};
  const construction = opts.construction ?? false;

  // Construction center point (reused if user already has a point there).
  const centerPt = findOrCreatePoint(state, cx, cy, findOpts);
  let current = centerPt.state;
  const centerGeom = addGeometry(
    current,
    { type: 'point', pointId: centerPt.id, construction: true },
    geoOpts,
  );
  current = centerGeom.state;

  // Vertex coords (regular N-gon CCW around center starting at angle0).
  const vertCoords: Array<[number, number]> = [];
  for (let i = 0; i < N; i++) {
    const a = angle0 + (2 * Math.PI * i) / N;
    vertCoords.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }

  // 2N distinct endpoint points (each line owns 2).
  const startIds: SketchPointId[] = [];
  const endIds: SketchPointId[] = [];
  for (let i = 0; i < N; i++) {
    const [sx, sy] = vertCoords[i]!;
    const [ex, ey] = vertCoords[(i + 1) % N]!;
    const start = addPoint(current, sx, sy, ptOpts);
    current = start.state;
    const end = addPoint(current, ex, ey, ptOpts);
    current = end.state;
    startIds.push(start.id);
    endIds.push(end.id);
  }

  // N line geometries.
  const lineIds: SketchGeometryId[] = [];
  for (let i = 0; i < N; i++) {
    const geom = addGeometry(
      current,
      { type: 'line', startId: startIds[i]!, endId: endIds[i]!, construction },
      geoOpts,
    );
    lineIds.push(geom.id);
    current = geom.state;
  }

  // N coincident constraints: line_i.end ⇿ line_{(i+1)%N}.start.
  const coincidents: SketchConstraintId[] = [];
  for (let i = 0; i < N; i++) {
    const next = (i + 1) % N;
    const con = addConstraint(
      current,
      { type: 'coincident', pointA: endIds[i]!, pointB: startIds[next]! },
      conOpts,
    );
    coincidents.push(con.id);
    current = con.state;
  }

  // (N−1) equal-length constraints chained across consecutive sides.
  const equalLengths: SketchConstraintId[] = [];
  for (let i = 0; i < N - 1; i++) {
    const con = addConstraint(
      current,
      { type: 'equal', geometryA: lineIds[i]!, geometryB: lineIds[i + 1]! },
      conOpts,
    );
    equalLengths.push(con.id);
    current = con.state;
  }

  // (N−1) angle constraints — exterior turn = 2π/N (CCW from line_i to
  // line_{i+1}). With N coincidents + closure, the Nth turn is forced
  // by the loop, so we only need N−1.
  const turnAngle = (2 * Math.PI) / N;
  const angles: SketchConstraintId[] = [];
  for (let i = 0; i < N - 1; i++) {
    const con = addConstraint(
      current,
      { type: 'angle', geometryA: lineIds[i]!, geometryB: lineIds[i + 1]!, value: turnAngle },
      conOpts,
    );
    angles.push(con.id);
    current = con.state;
  }

  return {
    state: current,
    centerId: centerPt.id,
    centerGeometryId: centerGeom.id,
    lineIds,
    vertexStartIds: startIds,
    vertexEndIds: endIds,
    constraints: { coincidents, equalLengths, angles },
  };
}

/**
 * Move an existing point to new coordinates. Used by drag-end commits
 * so each drag becomes one undo entry (transient mid-drag positions stay
 * in the editor store and are not persisted).
 *
 * Throws if the point id isn't in the state. Caller is responsible for
 * making sure the point exists (the UI's drag flow always has the id).
 */
export function movePoint(
  state: EditorState,
  pointId: SketchPointId,
  to: readonly [number, number],
): { state: EditorState; pointId: SketchPointId } {
  const existing = state.points.get(pointId);
  if (!existing) {
    throw new Error(`movePoint: point ${pointId} does not exist in this sketch`);
  }
  // A fixed point is pinned — a drag must not move it.
  //
  // This matters most for the sketch origin. `findOrCreatePoint` merges by
  // position, and deliberately does not exclude `pt_origin`, so drawing a
  // circle centred on the origin makes the origin ITSELF the circle's centre
  // — which is the right outcome: the circle is anchored and the sketch loses
  // two degrees of freedom, the same as Fusion's behaviour.
  //
  // Dragging that circle then dragged the origin with it. The sketch's anchor
  // ended up somewhere arbitrary, `con_origin_fixed` went unsatisfiable, and
  // DOF accounting could never reach zero again — the very thing the origin
  // exists to make possible.
  //
  // A silent no-op rather than a throw: this is reached from a pointer drag,
  // and refusing to move is the correct, undramatic outcome. The caller sees
  // the state come back unchanged.
  if (existing.fixed) return { state, pointId };
  const points = new Map(state.points);
  points.set(pointId, { ...existing, x: to[0], y: to[1] });
  return { state: { ...state, points }, pointId };
}

// ---- Removal -----------------------------------------------------------------

/**
 * Return every point id a geometry directly references. Used by
 * `removeGeometry` to GC orphan points; also useful for selection /
 * hit-testing logic that asks "which points belong to this curve".
 *
 * Public because the in-app editor store delegates to it — same logic in
 * one place keeps the doc-side handler and the editor's transient
 * helpers from drifting (see [SketchEditorStore.ts](src/sketch/SketchEditorStore.ts)).
 */
export function getGeometryPointIds(geom: SketchGeometry): SketchPointId[] {
  switch (geom.type) {
    case 'line':    return [geom.startId, geom.endId];
    case 'circle':  return [geom.centerId];
    case 'arc':     return [geom.centerId, geom.startId, geom.endId];
    case 'ellipse': return [geom.centerId, geom.majorId];
    case 'spline':  return [...geom.pointIds];
    case 'bezier':  return [geom.startId, geom.cp1Id, geom.cp2Id, geom.endId];
    case 'point':   return [geom.pointId];
  }
}

/**
 * Does this constraint reference the given geometry id? Used when
 * removing geometry to find every constraint that should be cascaded
 * along with it. Point-only constraints (`coincident`, `fixed`, plain
 * `distance`/`distanceX`/`distanceY`) return false — they survive
 * geometry deletion and only get removed if the point GC reaps their
 * referenced point (a separate concern handled at the point-removal
 * boundary).
 *
 * The switch is exhaustive on purpose — no `default` arm. A new
 * constraint kind that carries a geometry id is then a compile error
 * here instead of silently reporting "references nothing", which is how
 * `concentric` and `midpoint` ended up surviving the geometry they
 * pointed at until the next solve threw `sketch object … not found`.
 */
function constraintReferencesGeometry(
  constraint: SketchConstraint,
  geomId: SketchGeometryId,
): boolean {
  switch (constraint.type) {
    case 'horizontal':
    case 'vertical':
    case 'radius':
    case 'length':
    case 'pointOnLine':
    case 'pointOnCircle':
    case 'symmetric':
    case 'midpoint':
      return constraint.geometryId === geomId;
    case 'parallel':
    case 'perpendicular':
    case 'angle':
    case 'equal':
    case 'concentric':
      return constraint.geometryA === geomId || constraint.geometryB === geomId;
    case 'tangent':
      return (
        constraint.circleId === geomId ||
        constraint.lineId === geomId ||
        constraint.secondCircleId === geomId
      );
    case 'coincident':
    case 'fixed':
    case 'distance':
    case 'distanceX':
    case 'distanceY':
      return false;
  }
}

/**
 * Every point a constraint references. Exhaustive for the same reason as
 * {@link constraintReferencesGeometry}: a constraint left pointing at a
 * garbage-collected point fails the same way one left pointing at
 * deleted geometry does.
 */
function constraintPointIds(constraint: SketchConstraint): SketchPointId[] {
  switch (constraint.type) {
    case 'coincident':
    case 'distance':
    case 'distanceX':
    case 'distanceY':
    case 'symmetric':
      return [constraint.pointA, constraint.pointB];
    case 'fixed':
    case 'pointOnLine':
    case 'pointOnCircle':
    case 'midpoint':
      return [constraint.pointId];
    case 'horizontal':
    case 'vertical':
    case 'radius':
    case 'length':
    case 'parallel':
    case 'perpendicular':
    case 'angle':
    case 'equal':
    case 'concentric':
    case 'tangent':
      return [];
  }
}

/**
 * Remove a geometry along with its dependent state:
 *
 *  - The geometry itself.
 *  - Any point referenced by the geometry that no other geometry still
 *    references (orphan-point GC). Shared corners — e.g. coincident
 *    rectangle endpoints — survive because the neighbouring lines still
 *    reference them.
 *  - Every constraint that referenced the geometry. Point-only
 *    constraints (coincident on the removed point, point-only distance,
 *    `fixed`) are also reaped iff their referenced point was orphaned
 *    above — otherwise they remain valid against the surviving point.
 *
 * Returns a new `EditorState`. Removing a geometry that doesn't exist
 * is a no-op (idempotent — same contract as Map.delete).
 *
 * The in-app editor store and the `RemoveSketchEntity` command handler
 * both call this so deletion produces the same `editorModel` mutation
 * regardless of entry point. Without that shared op, the bus-side
 * handler historically only touched `inputs.buildGeometry` while the editor
 * store mutated `editorModel` — the next hydration round-trip then
 * revived the "deleted" geometry from the still-intact snapshot.
 */
export function removeGeometry(
  state: EditorState,
  geomId: SketchGeometryId,
): { state: EditorState; removedGeometry: SketchGeometry | undefined } {
  const geom = state.geometries.get(geomId);
  if (!geom) return { state, removedGeometry: undefined };

  const geometries = new Map(state.geometries);
  geometries.delete(geomId);

  // GC orphan points: any point the removed geometry owned that no
  // surviving geometry still references.
  const points = new Map(state.points);
  const orphanedPoints = new Set<SketchPointId>();
  for (const pid of getGeometryPointIds(geom)) {
    let stillReferenced = false;
    for (const g of geometries.values()) {
      if (getGeometryPointIds(g).includes(pid)) { stillReferenced = true; break; }
    }
    if (!stillReferenced) {
      points.delete(pid);
      orphanedPoints.add(pid);
    }
  }

  // Drop constraints that reference the geometry directly, plus any
  // constraint left pointing at a point orphaned above.
  const constraints = new Map(state.constraints);
  for (const [cid, c] of constraints) {
    if (
      constraintReferencesGeometry(c, geomId) ||
      constraintPointIds(c).some((pid) => orphanedPoints.has(pid))
    ) {
      constraints.delete(cid);
    }
  }

  return {
    state: { points, geometries, constraints },
    removedGeometry: geom,
  };
}

/**
 * Cascade whatever a modify operation deleted through the constraint and
 * point maps, given the state before and after it ran.
 *
 * `trimAt` deletes geometry inside its per-kind helpers and returns the
 * surviving pieces, but it never looks at the constraint map — a
 * `horizontal` on a trimmed line survived naming an id that was gone,
 * and the next solve threw `sketch object … not found` (planegcs
 * resolves every reference by id when it builds the system). Rather than
 * patching each of the ten delete sites, the op applies this once on the
 * way out, which is also why it works off a diff instead of a list of
 * removed ids.
 *
 * Applies {@link removeGeometry}'s cascade, in this order:
 *
 *  1. Constraints that reference a geometry which disappeared.
 *  2. Points the removed geometry owned that no surviving geometry
 *     references — re-checked after step 1, because the modify op's own
 *     point GC deliberately keeps a point that any constraint names,
 *     including the constraints step 1 just dropped.
 *  3. Constraints left pointing at a point step 2 reaped.
 *
 * `replaced` names geometry the operation rebuilt under its old id (a
 * trimmed line's surviving piece). It is kept, but the constraints on it
 * go as if it had been removed: they were written against the old shape.
 *
 * Returns `after` untouched when the operation removed and replaced no
 * geometry, so ops that only add or move geometry pay a map walk and
 * nothing else.
 */
export function reapDanglingReferences(
  before: EditorState,
  after: EditorState,
  replaced: ReadonlySet<SketchGeometryId> = new Set(),
): EditorState {
  const removed: SketchGeometry[] = [];
  for (const [id, geom] of before.geometries) {
    if (!after.geometries.has(id)) removed.push(geom);
  }
  if (removed.length === 0 && replaced.size === 0) return after;

  const constraints = new Map(after.constraints);
  for (const [cid, c] of constraints) {
    if (
      removed.some((geom) => constraintReferencesGeometry(c, geom.id))
      || [...replaced].some((id) => constraintReferencesGeometry(c, id))
    ) {
      constraints.delete(cid);
    }
  }

  const stillReferenced = new Set<SketchPointId>();
  for (const geom of after.geometries.values()) {
    for (const pid of getGeometryPointIds(geom)) stillReferenced.add(pid);
  }

  const points = new Map(after.points);
  const orphanedPoints = new Set<SketchPointId>();
  for (const geom of removed) {
    for (const pid of getGeometryPointIds(geom)) {
      if (points.has(pid) && !stillReferenced.has(pid)) {
        points.delete(pid);
        orphanedPoints.add(pid);
      }
    }
  }

  if (orphanedPoints.size > 0) {
    for (const [cid, c] of constraints) {
      if (constraintPointIds(c).some((pid) => orphanedPoints.has(pid))) {
        constraints.delete(cid);
      }
    }
  }

  return { ...after, points, geometries: after.geometries, constraints };
}
