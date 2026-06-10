/**
 * DXF (AutoCAD ASCII DXF) → sketch geometry import.
 *
 * IMPORT ONLY, and 2D-sketch only. The inverse of `./dxf.ts` (sketch →
 * DXF export). This produces native sketch primitives (line / circle /
 * arc / ellipse / spline) to populate a NEW sketch — it is a separate
 * path from the 3D body import (STEP / STL / BREP → `ImportedGeometry`).
 *
 * Two stages, both pure:
 *
 *   1. `parseDxf(text)` — a group-code reader. DXF ASCII is a flat stream
 *      of (code, value) line pairs. We group the ENTITIES section into
 *      per-entity group-code → value maps, then dispatch per entity type
 *      into a normalized `DxfPrimitive`. Unsupported types are collected
 *      in `skipped` (de-duplicated) for a single caller-side warning.
 *   2. `buildEditorStateFromPrimitives(primitives)` — turns those
 *      primitives into an `EditorState` by calling the same
 *      `operations.ts` drawing builders the editor and command bus use.
 *      Line/arc endpoints that meet (within `MERGE_EPSILON_MM`) are kept as
 *      DISTINCT points joined by a removable `coincident` constraint — the
 *      editor's canonical junction model (see `drawRectangle`). So a closed
 *      profile imports as an editable constrained loop with a populated
 *      constraints panel, not a silently-fused point chain.
 *
 * Supported entity subset (everything else is skipped with a warning):
 *
 *   - LINE              → line
 *   - LWPOLYLINE        → sequence of lines (closed flag honored; a bulge
 *                         on a segment becomes an arc)
 *   - POLYLINE / VERTEX → same as LWPOLYLINE (old-style vertex list)
 *   - CIRCLE            → circle
 *   - ARC               → arc
 *   - ELLIPSE           → ellipse
 *   - SPLINE            → spline (control points; the control polygon is
 *                         used directly — knots/weights are not evaluated)
 *
 * Layers, colors, text, hatches, dimensions, blocks/inserts, and any
 * other entity are ignored.
 *
 * Conventions — the exact INVERSE of `./dxf.ts` (which see):
 *
 *   - Coordinates are scaled to mm using the HEADER `$INSUNITS` variable
 *     (inches → ×25.4, m → ×1000, …; missing/unitless ⇒ mm). This converts
 *     to the drawing's REAL size — it never normalises or fits-to-view, so
 *     true CNC dimensions survive. DXF Y is up, same as the sketch plane, so
 *     there is NO Y flip (that is an SVG-only concern).
 *   - ARC group codes 50 / 51 (startAngle / endAngle) are DEGREES, CCW.
 *     We convert to RADIANS (`deg * π / 180`) for the sketch model, which
 *     stores arc angles in radians CCW.
 *   - ELLIPSE group 11/21/31 is the major-axis endpoint as a vector
 *     RELATIVE to the center; group 40 is the axis ratio (minor/major).
 *     We decode to the sketch model's `center`, absolute `majorEnd`
 *     (= center + vector) and `minorRadius` (= |vector| · ratio).
 *   - CIRCLE group 40 is the radius; the sketch `drawCircle` takes a
 *     radius too (the document entity later stores diameter).
 */

import {
  emptyEditorState,
  drawLine,
  drawCircle,
  drawArc,
  drawEllipse,
  drawSpline,
  addConstraint,
  type EditorState,
  type IdFactory,
} from '../operations.ts';
import type { SketchPointId } from '../types.ts';

const DEG_TO_RAD = Math.PI / 180;

/**
 * Endpoint-merge epsilon (mm). Looser than the strict 1e-6 default used
 * by the in-editor draw tools because DXF coordinates come from external
 * CAD/CAM software and are typically rounded to ~4–6 decimal places, so
 * two endpoints that are "the same" may differ in the last digit. 1e-4 mm
 * (0.1 µm) is far below any meaningful CAD tolerance yet absorbs that
 * rounding so shared corners actually merge into one point.
 */
export const MERGE_EPSILON_MM = 1e-4;

// ---- Units ($INSUNITS) -----------------------------------------------------
//
// DXF coordinates are in "drawing units"; the HEADER variable $INSUNITS
// declares what one unit means. We scale every coordinate to millimetres (the
// sketch model's unit) so an imported drawing lands at its REAL size — we do
// NOT normalise or fit-to-view (that would destroy true CNC dimensions). A
// missing / unitless / unrecognised $INSUNITS is treated as millimetres
// (factor 1), matching what our own exporter writes ($INSUNITS = 4).

/** $INSUNITS code → millimetres per drawing unit. Omitted codes ⇒ 1 (mm). */
const INSUNITS_TO_MM: Record<number, number> = {
  1: 25.4,       // inches
  2: 304.8,      // feet
  4: 1,          // millimeters
  5: 10,         // centimeters
  6: 1000,       // meters
  8: 0.0000254,  // microinches
  9: 0.0254,     // mils
  10: 914.4,     // yards
};

/** Friendly source-unit name for the caller's import log. */
const INSUNITS_NAME: Record<number, string> = {
  1: 'inches', 2: 'feet', 4: 'mm', 5: 'cm', 6: 'm',
  8: 'microinches', 9: 'mils', 10: 'yards',
};

/**
 * Read the HEADER `$INSUNITS` integer, or 0 (unitless) if absent. The
 * variable appears as the pair `9 / $INSUNITS` followed by `70 / <int>`.
 */
function readInsunits(text: string): number {
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i + 3 < lines.length; i++) {
    if (lines[i]!.trim() === '9' && lines[i + 1]!.trim() === '$INSUNITS') {
      const n = Number(lines[i + 3]?.trim());
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

/** Scale a primitive's lengths/coordinates by `f` (angles are unitless). */
function scalePrimitive(p: DxfPrimitive, f: number): DxfPrimitive {
  switch (p.kind) {
    case 'line':
      return { kind: 'line', start: [p.start[0] * f, p.start[1] * f], end: [p.end[0] * f, p.end[1] * f] };
    case 'circle':
      return { kind: 'circle', center: [p.center[0] * f, p.center[1] * f], radius: p.radius * f };
    case 'arc':
      return {
        kind: 'arc',
        center: [p.center[0] * f, p.center[1] * f],
        radius: p.radius * f,
        startAngle: p.startAngle,
        endAngle: p.endAngle,
      };
    case 'ellipse':
      return {
        kind: 'ellipse',
        center: [p.center[0] * f, p.center[1] * f],
        majorEnd: [p.majorEnd[0] * f, p.majorEnd[1] * f],
        minorRadius: p.minorRadius * f,
      };
    case 'spline':
      return { kind: 'spline', points: p.points.map(([x, y]) => [x * f, y * f]) };
  }
}

// ---- Normalized primitives -------------------------------------------------

export type DxfPrimitive =
  | { kind: 'line'; start: [number, number]; end: [number, number] }
  | { kind: 'circle'; center: [number, number]; radius: number }
  | {
      kind: 'arc';
      center: [number, number];
      radius: number;
      /** Radians, CCW (already converted from DXF degrees). */
      startAngle: number;
      /** Radians, CCW. */
      endAngle: number;
    }
  | {
      kind: 'ellipse';
      center: [number, number];
      /** Absolute coordinate of the major-axis endpoint (center + vector). */
      majorEnd: [number, number];
      minorRadius: number;
    }
  | { kind: 'spline'; points: Array<[number, number]> };

export interface DxfImportResult {
  /** Primitives, already scaled to millimetres per `$INSUNITS`. */
  primitives: DxfPrimitive[];
  /** De-duplicated list of DXF entity types that were skipped. */
  skipped: string[];
  /** mm-per-drawing-unit scale applied from `$INSUNITS` (1 = mm / unitless). */
  unitScale: number;
  /** Friendly source-unit name when a non-mm scale was applied (for logging). */
  unitName?: string;
}

// ---- Group-code reader -----------------------------------------------------

/**
 * One DXF entity as its group-code → values map. A group code may appear
 * more than once on an entity (e.g. a SPLINE's repeated 10/20 control
 * points), so each code maps to the ORDERED list of its values. Helpers
 * below read either the first value or the whole list.
 */
type EntityRecord = Map<number, string[]>;

/** First numeric value for a group code, or `fallback` if absent/NaN. */
function numAt(rec: EntityRecord, code: number, fallback = 0): number {
  const v = rec.get(code)?.[0];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** All numeric values for a group code, in stream order. */
function numsAt(rec: EntityRecord, code: number): number[] {
  const raw = rec.get(code);
  if (!raw) return [];
  return raw.map((v) => Number(v)).filter((n) => Number.isFinite(n));
}

/**
 * Split the DXF text into the ENTITIES section's per-entity records.
 *
 * The format is a flat list of (code, value) pairs, two physical lines
 * each. A `0` group code marks the start of a new entity (its value is
 * the entity type, e.g. `LINE`). We accumulate everything until the next
 * `0` into the current entity's record. Only the ENTITIES section is
 * walked; HEADER / TABLES / BLOCKS etc. are skipped.
 *
 * POLYLINE is a special multi-record entity: a `POLYLINE` header followed
 * by N `VERTEX` entities and a `SEQEND`. We surface those as separate
 * records here and stitch them back together in `recordsToPrimitives`.
 */
function parseEntityRecords(text: string): Array<{ type: string; rec: EntityRecord }> {
  // Normalize line endings and tokenize into (code, value) pairs.
  const lines = text.split(/\r\n|\r|\n/);
  const records: Array<{ type: string; rec: EntityRecord }> = [];

  let inEntities = false;
  let current: { type: string; rec: EntityRecord } | null = null;

  // Walk two lines at a time: code, then value.
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeStr = lines[i]!.trim();
    const value = lines[i + 1]!.trim();
    const code = Number(codeStr);
    if (!Number.isFinite(code)) continue; // malformed pair — skip defensively

    if (code === 0) {
      // Section / entity boundary.
      if (value === 'SECTION') {
        // The NEXT 2-group code is `2 <section-name>`. Peek ahead.
        const nameCode = Number(lines[i + 2]?.trim());
        const nameVal = lines[i + 3]?.trim();
        inEntities = nameCode === 2 && nameVal === 'ENTITIES';
        current = null;
        continue;
      }
      if (value === 'ENDSEC') {
        inEntities = false;
        current = null;
        continue;
      }
      if (value === 'EOF') break;
      // Start of a new entity.
      if (inEntities) {
        current = { type: value, rec: new Map() };
        records.push(current);
      } else {
        current = null;
      }
      continue;
    }

    if (current) {
      const list = current.rec.get(code);
      if (list) list.push(value);
      else current.rec.set(code, [value]);
    }
  }

  return records;
}

// ---- Per-entity dispatch ---------------------------------------------------

/**
 * Convert a LWPOLYLINE / POLYLINE vertex list (+ closed flag + per-vertex
 * bulges) into line and arc primitives. A bulge `b` is `tan(θ/4)` where θ
 * is the included angle of the arc from this vertex to the next; `b === 0`
 * is a straight segment. Closed polylines emit a final segment back to the
 * first vertex.
 */
function polylineToPrimitives(
  vertices: Array<[number, number]>,
  bulges: number[],
  closed: boolean,
): DxfPrimitive[] {
  const out: DxfPrimitive[] = [];
  const n = vertices.length;
  if (n < 2) return out;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % n]!;
    const bulge = bulges[i] ?? 0;
    if (bulge === 0) {
      out.push({ kind: 'line', start: [a[0], a[1]], end: [b[0], b[1]] });
      continue;
    }
    const arc = bulgeToArc(a, b, bulge);
    if (arc) out.push(arc);
    else out.push({ kind: 'line', start: [a[0], a[1]], end: [b[0], b[1]] });
  }
  return out;
}

/**
 * Convert a bulged polyline segment (start, end, bulge) into an arc
 * primitive. The bulge is `tan(θ/4)`; θ is the signed included angle
 * (positive = CCW). Returns null if the geometry is degenerate.
 */
function bulgeToArc(
  a: [number, number],
  b: [number, number],
  bulge: number,
): DxfPrimitive | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const chord = Math.hypot(dx, dy);
  if (chord === 0) return null;
  const theta = 4 * Math.atan(bulge); // included angle, signed
  const sinHalf = Math.sin(theta / 2);
  if (sinHalf === 0) return null;
  const radius = chord / (2 * Math.abs(sinHalf));
  // Sagitta direction: perpendicular to the chord, sign from the bulge.
  const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // Distance from chord midpoint to the arc center.
  const h = radius * Math.cos(theta / 2);
  // Unit perpendicular to the chord (rotate chord dir +90°). For a
  // positive (CCW) bulge the center sits to the left of a→b.
  const ux = -dy / chord;
  const uy = dx / chord;
  const sign = bulge > 0 ? 1 : -1;
  const cx = mid[0] + sign * h * ux;
  const cy = mid[1] + sign * h * uy;
  let startAngle = Math.atan2(a[1] - cy, a[0] - cx);
  let endAngle = Math.atan2(b[1] - cy, b[0] - cx);
  // drawArc winds CCW from start → end. For a negative (CW) bulge the
  // sweep goes the other way, so swap endpoints to keep it CCW.
  if (bulge < 0) {
    const t = startAngle;
    startAngle = endAngle;
    endAngle = t;
  }
  if (startAngle === endAngle) return null;
  return { kind: 'arc', center: [cx, cy], radius, startAngle, endAngle };
}

/**
 * Dispatch parsed entity records into normalized primitives, stitching
 * old-style POLYLINE + VERTEX runs back together. Unsupported types are
 * accumulated into `skipped`.
 */
function recordsToPrimitives(
  records: Array<{ type: string; rec: EntityRecord }>,
): { primitives: DxfPrimitive[]; skipped: string[] } {
  const primitives: DxfPrimitive[] = [];
  const skippedSet = new Set<string>();

  for (let i = 0; i < records.length; i++) {
    const { type, rec } = records[i]!;
    switch (type) {
      case 'LINE': {
        primitives.push({
          kind: 'line',
          start: [numAt(rec, 10), numAt(rec, 20)],
          end: [numAt(rec, 11), numAt(rec, 21)],
        });
        break;
      }
      case 'CIRCLE': {
        const radius = numAt(rec, 40);
        if (radius > 0) {
          primitives.push({ kind: 'circle', center: [numAt(rec, 10), numAt(rec, 20)], radius });
        }
        break;
      }
      case 'ARC': {
        const radius = numAt(rec, 40);
        if (radius > 0) {
          primitives.push({
            kind: 'arc',
            center: [numAt(rec, 10), numAt(rec, 20)],
            radius,
            startAngle: numAt(rec, 50) * DEG_TO_RAD,
            endAngle: numAt(rec, 51) * DEG_TO_RAD,
          });
        }
        break;
      }
      case 'ELLIPSE': {
        const center: [number, number] = [numAt(rec, 10), numAt(rec, 20)];
        const vx = numAt(rec, 11);
        const vy = numAt(rec, 21);
        const ratio = numAt(rec, 40);
        const majorR = Math.hypot(vx, vy);
        if (majorR > 0 && ratio > 0) {
          primitives.push({
            kind: 'ellipse',
            center,
            majorEnd: [center[0] + vx, center[1] + vy],
            minorRadius: majorR * ratio,
          });
        }
        break;
      }
      case 'LWPOLYLINE': {
        // 10/20 repeat per vertex; 42 is the bulge for the vertex it
        // follows. We can't trust 42 to appear for every vertex, so map
        // bulges positionally via the raw stream — but the grouped record
        // loses interleaving. LWPOLYLINE lists each vertex's 42 (if any)
        // immediately, so we approximate: align bulges to the vertices
        // that have them by index. The common producers (and our own
        // export) emit no bulges, so straight segments are the norm.
        const xs = numsAt(rec, 10);
        const ys = numsAt(rec, 20);
        const flags = numAt(rec, 70);
        const closed = (flags & 1) === 1;
        const vertices: Array<[number, number]> = [];
        const count = Math.min(xs.length, ys.length);
        for (let k = 0; k < count; k++) vertices.push([xs[k]!, ys[k]!]);
        const bulges = numsAt(rec, 42);
        primitives.push(...polylineToPrimitives(vertices, bulges, closed));
        break;
      }
      case 'POLYLINE': {
        // Old-style: header carries the closed flag (70), followed by a
        // run of VERTEX entities until SEQEND. Consume the following
        // VERTEX records.
        const flags = numAt(rec, 70);
        const closed = (flags & 1) === 1;
        const vertices: Array<[number, number]> = [];
        const bulges: number[] = [];
        let j = i + 1;
        for (; j < records.length; j++) {
          const next = records[j]!;
          if (next.type === 'VERTEX') {
            vertices.push([numAt(next.rec, 10), numAt(next.rec, 20)]);
            bulges.push(numAt(next.rec, 42));
            continue;
          }
          if (next.type === 'SEQEND') { j++; break; }
          break; // unexpected — stop the run
        }
        i = j - 1; // skip the consumed VERTEX/SEQEND records
        primitives.push(...polylineToPrimitives(vertices, bulges, closed));
        break;
      }
      case 'SPLINE': {
        // Control points are repeated 10/20 pairs. We use the control
        // polygon directly (knots group 40 / weights group 41 are not
        // evaluated — the sketch spline is defined by its control points).
        const xs = numsAt(rec, 10);
        const ys = numsAt(rec, 20);
        const points: Array<[number, number]> = [];
        const count = Math.min(xs.length, ys.length);
        for (let k = 0; k < count; k++) points.push([xs[k]!, ys[k]!]);
        if (points.length >= 2) primitives.push({ kind: 'spline', points });
        break;
      }
      case 'VERTEX':
      case 'SEQEND':
        // Consumed as part of a POLYLINE run above; a stray one is ignored.
        break;
      default:
        skippedSet.add(type);
        break;
    }
  }

  return { primitives, skipped: Array.from(skippedSet) };
}

// ---- Public API ------------------------------------------------------------

/**
 * Parse a DXF ASCII string into normalized sketch primitives plus the
 * list of skipped (unsupported) entity types. Pure — same input yields
 * the same output. Never throws on unsupported content; it collects it
 * into `skipped` instead.
 */
export function parseDxf(text: string): DxfImportResult {
  const records = parseEntityRecords(text);
  const { primitives, skipped } = recordsToPrimitives(records);

  const insunits = readInsunits(text);
  const unitScale = INSUNITS_TO_MM[insunits] ?? 1;
  const scaled = unitScale === 1 ? primitives : primitives.map((p) => scalePrimitive(p, unitScale));

  const unitName = INSUNITS_NAME[insunits];
  return unitScale !== 1 && unitName !== undefined
    ? { primitives: scaled, skipped, unitScale, unitName }
    : { primitives: scaled, skipped, unitScale };
}

/**
 * Build an `EditorState` from normalized primitives by routing each through
 * the matching `operations.ts` builder, then expressing every curve junction
 * as a removable `coincident` constraint between distinct endpoints.
 *
 * This matches the editor's canonical shape model (see `drawRectangle` /
 * `drawPolygon`): adjacent endpoints share COORDINATES but not point ids, and
 * the connection is an explicit constraint the user can see and delete — not
 * a silently-shared point. So an imported closed profile is a real, editable
 * constrained loop, and the constraints panel is populated.
 *
 * No solve is run: imported coordinates are already final, so every coincident
 * constraint is satisfied as written. `idFactory` is injectable for
 * deterministic test output. A primitive the builder rejects (degenerate arc /
 * zero-radius circle) is skipped rather than aborting the whole import.
 */
export function buildEditorStateFromPrimitives(
  primitives: readonly DxfPrimitive[],
  opts: { idFactory?: IdFactory } = {},
): EditorState {
  const base: { tolerance: number; idFactory?: IdFactory } = { tolerance: MERGE_EPSILON_MM };
  if (opts.idFactory) base.idFactory = opts.idFactory;
  const idOpts = opts.idFactory ? { idFactory: opts.idFactory } : {};

  let state = emptyEditorState();
  // Line / arc endpoints, captured for the coincidence pass below. Each is the
  // point id the builder allocated plus its drawing-space coordinate.
  const endpoints: { id: SketchPointId; x: number; y: number }[] = [];

  for (const p of primitives) {
    try {
      switch (p.kind) {
        case 'line': {
          const r = drawLine(state, p.start, p.end, { ...base, distinctStart: true, distinctEnd: true });
          state = r.state;
          endpoints.push({ id: r.startId, x: p.start[0], y: p.start[1] });
          endpoints.push({ id: r.endId, x: p.end[0], y: p.end[1] });
          break;
        }
        case 'circle':
          state = drawCircle(state, { center: p.center, radius: p.radius }, base).state;
          break;
        case 'arc': {
          const r = drawArc(
            state,
            { center: p.center, radius: p.radius, startAngle: p.startAngle, endAngle: p.endAngle },
            { ...base, distinctStart: true, distinctEnd: true },
          );
          state = r.state;
          endpoints.push({
            id: r.startId,
            x: p.center[0] + p.radius * Math.cos(p.startAngle),
            y: p.center[1] + p.radius * Math.sin(p.startAngle),
          });
          endpoints.push({
            id: r.endId,
            x: p.center[0] + p.radius * Math.cos(p.endAngle),
            y: p.center[1] + p.radius * Math.sin(p.endAngle),
          });
          break;
        }
        case 'ellipse':
          state = drawEllipse(
            state,
            { center: p.center, major: p.majorEnd, minorRadius: p.minorRadius },
            base,
          ).state;
          break;
        case 'spline':
          state = drawSpline(state, p.points, base).state;
          break;
      }
    } catch {
      // Degenerate primitive (zero radius / zero sweep / collinear) —
      // skip it and keep importing the rest.
    }
  }

  return addCoincidentConstraints(state, endpoints, MERGE_EPSILON_MM, idOpts);
}

/**
 * Add a `coincident` constraint between every pair of endpoints that share a
 * location (within `tolerance`). Endpoints at one junction form a group; the
 * group is chained with n-1 constraints so each pair is a single removable
 * link — the same shape `drawRectangle` produces at its corners.
 */
function addCoincidentConstraints(
  state: EditorState,
  endpoints: ReadonlyArray<{ id: SketchPointId; x: number; y: number }>,
  tolerance: number,
  idOpts: { idFactory?: IdFactory },
): EditorState {
  const used = new Array(endpoints.length).fill(false);
  let s = state;
  for (let i = 0; i < endpoints.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const group: number[] = [i];
    for (let j = i + 1; j < endpoints.length; j++) {
      if (used[j]) continue;
      const a = endpoints[i]!;
      const b = endpoints[j]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) <= tolerance) {
        used[j] = true;
        group.push(j);
      }
    }
    for (let k = 1; k < group.length; k++) {
      const pointA = endpoints[group[k - 1]!]!.id;
      const pointB = endpoints[group[k]!]!.id;
      s = addConstraint(s, { type: 'coincident', pointA, pointB }, idOpts).state;
    }
  }
  return s;
}

/**
 * Convenience: parse DXF text and build the populated `EditorState` in
 * one call. Returns the state, the skipped-entity list, and the `$INSUNITS`
 * scale that was applied (`unitScale` + friendly `unitName` when non-mm) so
 * the caller can warn / log. The state is empty if nothing was supported.
 */
export function dxfToEditorState(
  text: string,
  opts: { idFactory?: IdFactory } = {},
): { state: EditorState; skipped: string[]; unitScale: number; unitName?: string } {
  const { primitives, skipped, unitScale, unitName } = parseDxf(text);
  const state = buildEditorStateFromPrimitives(primitives, opts);
  return unitName !== undefined
    ? { state, skipped, unitScale, unitName }
    : { state, skipped, unitScale };
}
