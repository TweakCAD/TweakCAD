/**
 * Planar graph region detection for intersecting sketch geometry.
 *
 * This module handles the case where sketch entities overlap/intersect,
 * creating regions that are bounded by edges from multiple entities.
 * For example: a rectangle with a tangent circle creates 5 regions
 * (4 corners + the circle interior).
 *
 * Algorithm:
 * 1. Convert all non-construction geometry to directed edge segments
 * 2. Find all intersection points between edges
 * 3. Split edges at intersection points
 * 4. Build a planar subdivision graph
 * 5. Extract minimal bounded faces using "leftmost turn" traversal
 */

import type { SketchEntity } from '../document/schema.ts';
import type { EntityId } from '../ids.ts';

// --- Types ---

type Point2 = [number, number];

type GraphEdge = {
  id: string;
  entityId: EntityId;
  start: Point2;
  end: Point2;
  /** Original curve type for rendering */
  curveType: 'line' | 'arc';
  /** For arcs: center and radius */
  center?: Point2;
  radius?: number;
  startAngle?: number;
  /** Unwrapped: `endAngle - startAngle` is the signed sweep in face
   *  traversal order (positive CCW), not wrapped to ±π. */
  endAngle?: number;
  /**
   * What this piece of its entity is, independent of where it sits along
   * the entity and of which way the face walks it: the entity id alone for
   * the whole entity, else `<entity>[<from>,<to>]` with the bound at each
   * end in the entity's own direction (start to end for a line, CCW for a
   * circle). A bound is `<` / `>` for the entity's own start / end, or the
   * ids of the entities that cross or touch it there (`+`-joined), with
   * `#k` when those cross it more than once (k-th along the entity).
   */
  identity: string;
};

export type PlanarFace = {
  /** The edges forming this face boundary */
  edges: GraphEdge[];
  /** All entity IDs participating in this face */
  entityIds: EntityId[];
  /** Vertices of the face polygon (for rendering and hit testing) */
  vertices: Point2[];
  /** Centroid of the face */
  centroid: Point2;
  /** Signed area (positive = outer, negative = hole) */
  area: number;
};

// --- Constants ---

const EPSILON = 1e-6;
const CIRCLE_SEGMENTS = 64;

// --- Geometry helpers ---

function dist(a: Point2, b: Point2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function ptKey(p: Point2): string {
  return `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
}

function ptEqual(a: Point2, b: Point2): boolean {
  return dist(a, b) < EPSILON;
}

function angle(from: Point2, to: Point2): number {
  return Math.atan2(to[1] - from[1], to[0] - from[0]);
}

function polygonSignedArea(verts: Point2[]): number {
  let area = 0;
  for (let i = 0; i < verts.length; i++) {
    const curr = verts[i]!;
    const next = verts[(i + 1) % verts.length]!;
    area += curr[0] * next[1] - next[0] * curr[1];
  }
  return area / 2;
}

function polygonCentroid(verts: Point2[]): Point2 {
  if (verts.length === 0) return [0, 0];
  const sa = polygonSignedArea(verts);
  if (Math.abs(sa) < EPSILON) {
    const sum = verts.reduce<Point2>((acc, v) => [acc[0] + v[0], acc[1] + v[1]], [0, 0]);
    return [sum[0] / verts.length, sum[1] / verts.length];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < verts.length; i++) {
    const curr = verts[i]!;
    const next = verts[(i + 1) % verts.length]!;
    const cross = curr[0] * next[1] - next[0] * curr[1];
    cx += (curr[0] + next[0]) * cross;
    cy += (curr[1] + next[1]) * cross;
  }
  const f = 1 / (6 * sa);
  return [cx * f, cy * f];
}

function expressionToNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// --- Point-on-segment test ---

/**
 * Check if a point lies on a line segment (within tolerance).
 * Excludes the segment endpoints themselves.
 */
function pointOnSegment(pt: Point2, segStart: Point2, segEnd: Point2): boolean {
  const dx = segEnd[0] - segStart[0];
  const dy = segEnd[1] - segStart[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < EPSILON * EPSILON) return false;

  // Project pt onto the line
  const t = ((pt[0] - segStart[0]) * dx + (pt[1] - segStart[1]) * dy) / len2;
  if (t <= EPSILON || t >= 1 - EPSILON) return false; // Not strictly interior to segment

  // Distance from pt to the projected point
  const projX = segStart[0] + t * dx;
  const projY = segStart[1] + t * dy;
  const d = dist(pt, [projX, projY]);
  return d < EPSILON * 10; // Slightly looser tolerance for tangency detection
}

// --- Line-Line intersection ---

function lineLineIntersection(
  a1: Point2, a2: Point2,
  b1: Point2, b2: Point2,
): Point2 | null {
  const d1x = a2[0] - a1[0];
  const d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0];
  const d2y = b2[1] - b1[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < EPSILON) return null; // parallel

  const t = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / denom;
  const u = ((b1[0] - a1[0]) * d1y - (b1[1] - a1[1]) * d1x) / denom;

  if (t < EPSILON || t > 1 - EPSILON || u < EPSILON || u > 1 - EPSILON) return null;

  return [a1[0] + t * d1x, a1[1] + t * d1y];
}

// --- Convert entities to edge segments ---

type RawSegment = {
  entityId: EntityId;
  type: 'line';
  start: Point2;
  end: Point2;
} | {
  entityId: EntityId;
  type: 'circle';
  center: Point2;
  radius: number;
};

function entitiesToSegments(entities: Record<EntityId, SketchEntity>): RawSegment[] {
  const segments: RawSegment[] = [];

  for (const entity of Object.values(entities)) {
    if (entity.construction) continue;

    if (entity.type === 'line') {
      const sx = expressionToNum(entity.start[0]);
      const sy = expressionToNum(entity.start[1]);
      const ex = expressionToNum(entity.end[0]);
      const ey = expressionToNum(entity.end[1]);
      if (sx === null || sy === null || ex === null || ey === null) continue;
      if (dist([sx, sy], [ex, ey]) < EPSILON) continue;
      segments.push({ entityId: entity.id, type: 'line', start: [sx, sy], end: [ex, ey] });
    } else if (entity.type === 'circle') {
      const cx = expressionToNum(entity.center[0]);
      const cy = expressionToNum(entity.center[1]);
      const d = expressionToNum(entity.diameter);
      if (cx === null || cy === null || d === null || d <= EPSILON) continue;
      segments.push({ entityId: entity.id, type: 'circle', center: [cx, cy], radius: d / 2 });
    }
    // There are no composite `rectangle` / `slot` entities
    // (invariant #11 — no composite entities). Rectangles arrive here
    // as 4 individual `line` entities and feed through the branch above.
  }

  return segments;
}

// --- Segment identity ---

/**
 * Names the bounds of each piece an entity is split into (see
 * {@link GraphEdge.identity}). A vertex on an entity is bounded by the
 * entity's own endpoint when it is one (a line's start or end, even where
 * another line meets it at a corner), else by the other entities through
 * it. When the same entities bound it at several vertices, each gets `#k`
 * in order along the entity, so the two arcs of a circle cut by one line
 * are told apart.
 */
function segmentBounds(
  subEdges: readonly { entityId: EntityId; from: number; to: number }[],
  vertices: readonly Point2[],
  lineEnds: ReadonlyMap<EntityId, { start: Point2; end: Point2 }>,
  circles: ReadonlyMap<EntityId, { center: Point2; radius: number }>,
) {
  const through = new Map<number, Set<EntityId>>();
  const onEntity = new Map<EntityId, Set<number>>();
  for (const sub of subEdges) {
    for (const v of [sub.from, sub.to]) {
      let ids = through.get(v);
      if (!ids) through.set(v, ids = new Set());
      ids.add(sub.entityId);
      let vs = onEntity.get(sub.entityId);
      if (!vs) onEntity.set(sub.entityId, vs = new Set());
      vs.add(v);
    }
  }

  /** Position of vertex `v` along the entity, in its own direction. */
  const param = (entityId: EntityId, v: number): number => {
    const p = vertices[v];
    if (!p) return 0;
    const line = lineEnds.get(entityId);
    if (line) {
      return (p[0] - line.start[0]) * (line.end[0] - line.start[0])
        + (p[1] - line.start[1]) * (line.end[1] - line.start[1]);
    }
    const circle = circles.get(entityId);
    if (!circle) return 0;
    const a = Math.atan2(p[1] - circle.center[1], p[0] - circle.center[0]);
    return a < 0 ? a + 2 * Math.PI : a;
  };

  const rawTag = (entityId: EntityId, v: number): string => {
    const line = lineEnds.get(entityId);
    const p = vertices[v];
    if (line && p && ptEqual(p, line.start)) return '<';
    if (line && p && ptEqual(p, line.end)) return '>';
    return [...(through.get(v) ?? [])].filter(id => id !== entityId).map(String).sort().join('+');
  };

  const tags = new Map<EntityId, Map<number, string>>();
  const tagsOf = (entityId: EntityId): Map<number, string> => {
    const known = tags.get(entityId);
    if (known) return known;
    const byTag = new Map<string, number[]>();
    for (const v of onEntity.get(entityId) ?? []) {
      const tag = rawTag(entityId, v);
      if (tag === '') continue; // a sample point inside a circle
      const list = byTag.get(tag) ?? [];
      list.push(v);
      byTag.set(tag, list);
    }
    const out = new Map<number, string>();
    for (const [tag, vs] of byTag) {
      const [only] = vs;
      if (vs.length === 1 && only !== undefined) {
        out.set(only, tag);
        continue;
      }
      vs.sort((a, b) => param(entityId, a) - param(entityId, b));
      vs.forEach((v, k) => out.set(v, `${tag}#${k}`));
    }
    tags.set(entityId, out);
    return out;
  };

  /** The identity of the piece of `entityId` between vertices `a` and `b`;
   *  `forward` when `a` comes first in the entity's own direction. */
  const identity = (entityId: EntityId, a: number, b: number, forward: boolean): string => {
    const t = tagsOf(entityId);
    const [from, to] = forward ? [a, b] : [b, a];
    const fromTag = t.get(from) ?? '?';
    const toTag = t.get(to) ?? '?';
    if (fromTag === '<' && toTag === '>') return String(entityId);
    return `${String(entityId)}[${fromTag},${toTag}]`;
  };

  return { param, identity };
}

// --- Build the planar graph ---

type HalfEdge = {
  id: number;
  entityId: EntityId;
  from: number;  // vertex index
  to: number;    // vertex index
  twin: number;  // opposite half-edge index
  next: number;  // next half-edge in face boundary (-1 if unset)
  face: number;  // face index (-1 if unset)
  used: boolean;
};

/**
 * Detect regions formed by intersecting sketch geometry using a planar subdivision.
 *
 * Returns PlanarFace[] representing the minimal bounded regions formed by
 * all non-construction entities (including their intersections).
 */
export function detectIntersectionRegions(entities: Record<EntityId, SketchEntity>): PlanarFace[] {
  const rawSegments = entitiesToSegments(entities);
  if (rawSegments.length === 0) return [];

  // Lookup table for curved entities so the face-emission step can
  // consolidate consecutive subedges (which all share the same entity
  // ID) back into a single arc GraphEdge with native curve info.
  const circleEntities = new Map<EntityId, { center: Point2; radius: number }>();
  for (const entity of Object.values(entities)) {
    if (entity.construction) continue;
    if (entity.type !== 'circle') continue;
    const cx = expressionToNum(entity.center[0]);
    const cy = expressionToNum(entity.center[1]);
    const d = expressionToNum(entity.diameter);
    if (cx === null || cy === null || d === null || d <= EPSILON) continue;
    circleEntities.set(entity.id, { center: [cx, cy], radius: d / 2 });
  }

  // Step 1: Collect all vertices (endpoints + intersection points)
  const vertexMap = new Map<string, number>();
  const vertices: Point2[] = [];

  function addVertex(p: Point2): number {
    const key = ptKey(p);
    const existing = vertexMap.get(key);
    if (existing !== undefined) return existing;
    const idx = vertices.length;
    vertexMap.set(key, idx);
    vertices.push(p);
    return idx;
  }

  // Subdivide line segments and circles into line pieces
  type SubEdge = { entityId: EntityId; from: number; to: number };
  const subEdges: SubEdge[] = [];

  // First pass: collect all line segments and circle approximation segments
  type LineSeg = { entityId: EntityId; start: Point2; end: Point2 };
  const allLineSegs: LineSeg[] = [];

  for (const seg of rawSegments) {
    if (seg.type === 'line') {
      allLineSegs.push({ entityId: seg.entityId, start: seg.start, end: seg.end });
    } else if (seg.type === 'circle') {
      // Approximate circle as polygon segments
      for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a1 = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
        const a2 = (2 * Math.PI * (i + 1)) / CIRCLE_SEGMENTS;
        allLineSegs.push({
          entityId: seg.entityId,
          start: [seg.center[0] + seg.radius * Math.cos(a1), seg.center[1] + seg.radius * Math.sin(a1)],
          end: [seg.center[0] + seg.radius * Math.cos(a2), seg.center[1] + seg.radius * Math.sin(a2)],
        });
      }
    }
  }

  // Step 2: Find all intersection points and split edges.
  // Also handle tangency: if another segment's endpoint lies ON this segment, split here.
  for (let i = 0; i < allLineSegs.length; i++) {
    const segI = allLineSegs[i]!;
    const splits: Point2[] = [segI.start];

    for (let j = 0; j < allLineSegs.length; j++) {
      if (i === j) continue;
      const segJ = allLineSegs[j]!;

      // Line-line crossing
      const ip = lineLineIntersection(segI.start, segI.end, segJ.start, segJ.end);
      if (ip) splits.push(ip);

      // Also check if segJ's endpoints lie on segI (tangency / shared vertex)
      for (const pt of [segJ.start, segJ.end]) {
        if (pointOnSegment(pt, segI.start, segI.end)) {
          splits.push(pt);
        }
      }
    }

    splits.push(segI.end);

    // Sort splits along the segment direction
    const dx = segI.end[0] - segI.start[0];
    const dy = segI.end[1] - segI.start[1];
    splits.sort((a, b) => {
      const ta = (a[0] - segI.start[0]) * dx + (a[1] - segI.start[1]) * dy;
      const tb = (b[0] - segI.start[0]) * dx + (b[1] - segI.start[1]) * dy;
      return ta - tb;
    });

    // Deduplicate splits
    const uniqueSplits: Point2[] = [splits[0]!];
    for (let k = 1; k < splits.length; k++) {
      if (!ptEqual(splits[k]!, uniqueSplits[uniqueSplits.length - 1]!)) {
        uniqueSplits.push(splits[k]!);
      }
    }

    // Create sub-edges between consecutive split points
    for (let k = 0; k < uniqueSplits.length - 1; k++) {
      const from = addVertex(uniqueSplits[k]!);
      const to = addVertex(uniqueSplits[k + 1]!);
      if (from !== to) {
        subEdges.push({ entityId: segI.entityId, from, to });
      }
    }
  }

  if (subEdges.length < 3 || vertices.length < 3) return [];

  const lineEnds = new Map<EntityId, { start: Point2; end: Point2 }>();
  for (const seg of rawSegments) {
    if (seg.type === 'line') lineEnds.set(seg.entityId, { start: seg.start, end: seg.end });
  }
  const bounds = segmentBounds(subEdges, vertices, lineEnds, circleEntities);

  // Step 3: Build half-edge data structure
  const halfEdges: HalfEdge[] = [];
  const edgePairMap = new Map<string, number>(); // "from,to" -> half-edge index

  for (const sub of subEdges) {
    const fwdKey = `${sub.from},${sub.to}`;
    const revKey = `${sub.to},${sub.from}`;

    // Skip duplicate edges
    if (edgePairMap.has(fwdKey)) continue;

    const fwdIdx = halfEdges.length;
    const revIdx = halfEdges.length + 1;

    halfEdges.push({
      id: fwdIdx,
      entityId: sub.entityId,
      from: sub.from,
      to: sub.to,
      twin: revIdx,
      next: -1,
      face: -1,
      used: false,
    });
    halfEdges.push({
      id: revIdx,
      entityId: sub.entityId,
      from: sub.to,
      to: sub.from,
      twin: fwdIdx,
      next: -1,
      face: -1,
      used: false,
    });

    edgePairMap.set(fwdKey, fwdIdx);
    edgePairMap.set(revKey, revIdx);
  }

  // Step 4: For each vertex, sort outgoing half-edges by angle
  const outgoing = new Map<number, number[]>(); // vertex -> sorted half-edge indices
  for (let i = 0; i < halfEdges.length; i++) {
    const he = halfEdges[i]!;
    if (!outgoing.has(he.from)) outgoing.set(he.from, []);
    outgoing.get(he.from)!.push(i);
  }

  for (const [vIdx, edgeIndices] of outgoing) {
    const v = vertices[vIdx]!;
    edgeIndices.sort((a, b) => {
      const heA = halfEdges[a]!;
      const heB = halfEdges[b]!;
      const angA = angle(v, vertices[heA.to]!);
      const angB = angle(v, vertices[heB.to]!);
      return angA - angB;
    });
  }

  // Step 5: Set next pointers using the DCEL convention.
  // Outgoing edges at each vertex are sorted CCW by angle.
  // For each outgoing edge, its twin arrives at this vertex.
  // The next edge in a face traversal (following right-hand / CW boundary)
  // is the PREVIOUS outgoing edge in CCW order (i.e., the next CW neighbor).
  for (const [, edgeIndices] of outgoing) {
    for (let k = 0; k < edgeIndices.length; k++) {
      const outHe = halfEdges[edgeIndices[k]!]!;
      const inHe = halfEdges[outHe.twin]!; // the twin arrives at this vertex
      // Previous in CCW order = next in CW order
      const prevK = (k - 1 + edgeIndices.length) % edgeIndices.length;
      inHe.next = edgeIndices[prevK]!;
    }
  }

  // Step 6: Trace faces by following next pointers
  const faces: PlanarFace[] = [];

  for (let startIdx = 0; startIdx < halfEdges.length; startIdx++) {
    const startHe = halfEdges[startIdx]!;
    if (startHe.used || startHe.next === -1) continue;

    // Trace the face boundary
    const faceEdges: HalfEdge[] = [];
    const faceVerts: Point2[] = [];
    const faceEntityIds = new Set<EntityId>();
    let current = startIdx;
    let safetyCounter = 0;

    while (safetyCounter < halfEdges.length + 1) {
      const he = halfEdges[current]!;
      if (he.used) break;
      he.used = true;
      faceEdges.push(he);
      faceVerts.push(vertices[he.from]!);
      faceEntityIds.add(he.entityId);

      if (he.next === startIdx || he.next === -1) break;
      current = he.next;
      safetyCounter++;
    }

    // Validate: must form a closed loop with positive area
    if (faceEdges.length < 3) continue;
    const lastHe = faceEdges[faceEdges.length - 1]!;
    if (lastHe.next !== startIdx) continue;

    const area = polygonSignedArea(faceVerts);
    // Only keep bounded faces (positive area = CCW = bounded region)
    if (area <= EPSILON) continue;

    // Consolidate consecutive sampled subedges that came from the same
    // CURVED entity (circle today; arc / spline later) back into one
    // GraphEdge with native curve info. Without this step, a circle that
    // contributes ~64 subedges to the planar graph would emit ~64
    // line-typed face edges → the downstream extrude pipeline would
    // build 64 strip faces instead of one cylindrical face. See
    // `wireProfile.ts` for the kernel-side consumer.

    const consolidated: GraphEdge[] = [];
    let i = 0;
    while (i < faceEdges.length) {
      const he = faceEdges[i]!;
      const circle = circleEntities.get(he.entityId);
      if (!circle) {
        consolidated.push({
          id: `${he.from}-${he.to}`,
          entityId: he.entityId,
          start: vertices[he.from]!,
          end: vertices[he.to]!,
          curveType: 'line',
          identity: bounds.identity(he.entityId, he.from, he.to, bounds.param(he.entityId, he.from) < bounds.param(he.entityId, he.to)),
        });
        i++;
        continue;
      }
      // Walk the run of consecutive subedges sharing the same circle entity.
      let runEnd = i;
      while (
        runEnd + 1 < faceEdges.length &&
        faceEdges[runEnd + 1]!.entityId === he.entityId
      ) {
        runEnd++;
      }
      const first = faceEdges[i]!;
      const last = faceEdges[runEnd]!;
      const startPt = vertices[first.from]!;
      const endPt = vertices[last.to]!;
      // Sum the per-subedge angle steps (each well under π) so the sweep
      // keeps its traversal direction and can exceed π — the larger piece
      // of a circle cut by a chord is a major arc.
      const angleOf = (p: Point2): number => Math.atan2(p[1] - circle.center[1], p[0] - circle.center[0]);
      const startAngle = angleOf(startPt);
      let sweep = 0;
      for (let k = i; k <= runEnd; k++) {
        let step = angleOf(vertices[faceEdges[k]!.to]!) - angleOf(vertices[faceEdges[k]!.from]!);
        if (step > Math.PI) step -= 2 * Math.PI;
        else if (step <= -Math.PI) step += 2 * Math.PI;
        sweep += step;
      }
      const endAngle = startAngle + sweep;
      consolidated.push({
        id: `arc:${first.from}-${last.to}`,
        entityId: he.entityId,
        start: startPt,
        end: endPt,
        curveType: 'arc',
        center: circle.center,
        radius: circle.radius,
        startAngle,
        endAngle,
        // A circle's own direction is CCW, so a CW walk runs it backwards.
        identity: bounds.identity(he.entityId, first.from, last.to, sweep > 0),
      });
      i = runEnd + 1;
    }

    faces.push({
      edges: consolidated,
      entityIds: [...faceEntityIds],
      vertices: faceVerts,
      centroid: polygonCentroid(faceVerts),
      area,
    });
  }

  return faces;
}
