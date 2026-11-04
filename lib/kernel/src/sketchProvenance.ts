/**
 * Names for the faces a sketch-driven solid is made of, from the sketch.
 *
 * `createSketchFace` records which edge of the sketch face each profile
 * segment became ({@link sketchFaceProvenance}). An extrude, or a revolve
 * short of a full turn, keeps that face as its start cap (the same shape, so
 * the same hash) and sweeps each of its edges into exactly one side face. So
 * {@link sketchSolidFaceNames} names every face by adjacency:
 *
 * - the start cap is the sketch face: `start(<region>)`;
 * - a side face borders exactly one sketch edge: `side(<segment>)`;
 * - the end cap is the one face that borders none: `end(<region>)`.
 *
 * Names end in `)`, never in `_<digits>`, so they are not mistaken for
 * walk-order IDs (`isWalkOrderId`): a repair hint does not move a ref off one.
 * A face this cannot name (a full revolve has no start cap) is left to the
 * walk-order fallback.
 */

import type { OcctKernel as UpstreamKernel, ShapeHandle } from 'occt-wasm';
import type { Vec3 } from '@tweakcad/core/src/math.ts';
import type { ResolvedProfile, WireSegment } from './types.ts';

/** What a sketch face was built from: its region, and the segment behind each edge (by hash). */
export type SketchFaceProvenance = {
  region: string | undefined;
  edges: Map<number, string>;
};

/** Distance (mm) within which an edge passes through a segment's probe point. */
const PROBE_TOLERANCE_MM = 1e-4;

type Candidate = { id: string; probe: Vec3; ends: string };

/**
 * Pair each edge of `face`, built from `profile` and its holes, with the
 * segment it came from. Edges are matched by their end points (and, for
 * segments that share both, by a point on the segment), so the pairing does
 * not depend on how OCCT ordered or rebuilt the edges. Returns `undefined`
 * when the profile carries no provenance.
 */
export function sketchFaceProvenance(
  k: UpstreamKernel,
  face: ShapeHandle,
  profile: ResolvedProfile,
  hashUpperBound: number,
): SketchFaceProvenance | undefined {
  const candidates = [profile, ...(profile.holes ?? [])].flatMap(profileCandidates);
  if (candidates.length === 0 && profile.region === undefined) return undefined;
  const byEnds = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byEnds.get(c.ends) ?? [];
    list.push(c);
    byEnds.set(c.ends, list);
  }

  const edges = new Map<number, string>();
  for (const edge of k.getSubShapes(face, 'edge')) {
    try {
      // No end-point match (an end that rounds the other way): try them all.
      const matches = byEnds.get(edgeEnds(k, edge)) ?? candidates;
      const found = matches.length === 1 ? matches[0] : closestByProbe(k, edge, matches);
      if (found) edges.set(k.hashCode(edge, hashUpperBound), found.id);
    } finally {
      k.release(edge);
    }
  }
  return { region: profile.region, edges };
}

/**
 * Names for the faces of `solid`, swept from `sketchFace`, in walk order;
 * `undefined` where a face gets the walk-order fallback. `tag` is the op's
 * origin tag (`extrude_<featureId>`).
 */
export function sketchSolidFaceNames(
  k: UpstreamKernel,
  solid: ShapeHandle,
  sketchFace: ShapeHandle,
  provenance: SketchFaceProvenance,
  tag: string,
  hashUpperBound: number,
): (string | undefined)[] {
  const capHash = k.hashCode(sketchFace, hashUpperBound);
  const faces = k.getSubShapes(solid, 'face');
  try {
    const names: (string | undefined)[] = faces.map(() => undefined);
    const start = faces.findIndex(f => k.hashCode(f, hashUpperBound) === capHash);
    if (start < 0) return names;
    const region = provenance.region;
    if (region !== undefined) names[start] = `sf_${tag}~start(${region})`;

    const bare: number[] = [];
    faces.forEach((face, i) => {
      if (i === start) return;
      const sketchEdges = new Set<string>();
      for (const edge of k.getSubShapes(face, 'edge')) {
        const id = provenance.edges.get(k.hashCode(edge, hashUpperBound));
        if (id !== undefined) sketchEdges.add(id);
        k.release(edge);
      }
      const [only] = sketchEdges;
      if (only === undefined) bare.push(i);
      else if (sketchEdges.size === 1) names[i] = `sf_${tag}~side(${only})`;
    });
    const [endCap] = bare;
    if (region !== undefined && bare.length === 1 && endCap !== undefined) names[endCap] = `sf_${tag}~end(${region})`;
    return unique(names);
  } finally {
    for (const f of faces) k.release(f);
  }
}

/** Drop any name given to more than one face: those faces get the fallback. */
function unique(names: (string | undefined)[]): (string | undefined)[] {
  const count = new Map<string, number>();
  for (const n of names) if (n !== undefined) count.set(n, (count.get(n) ?? 0) + 1);
  return names.map(n => (n !== undefined && count.get(n) === 1 ? n : undefined));
}

function profileCandidates(profile: ResolvedProfile): Candidate[] {
  if (profile.type === 'wire') {
    return (profile.segments ?? []).flatMap(seg => {
      const ends = segmentEnds(seg);
      const probe = segmentProbe(seg);
      if (seg.id === undefined || !ends || !probe) return [];
      return [{ id: seg.id, probe, ends: endsKey(...ends) }];
    });
  }
  if (profile.boundaryId === undefined) return [];
  const probe = closedProbe(profile);
  return probe ? [{ id: profile.boundaryId, probe, ends: CLOSED }] : [];
}

const CLOSED = 'closed';

function segmentEnds(seg: WireSegment): [Vec3, Vec3] | undefined {
  if (seg.kind !== 'spline') return [seg.start, seg.end];
  const first = seg.points[0];
  const last = seg.points[seg.points.length - 1];
  return first && last ? [first, last] : undefined;
}

/** A point on the segment away from its ends. */
function segmentProbe(seg: WireSegment): Vec3 | undefined {
  switch (seg.kind) {
    case 'line': return lerp(seg.start, seg.end, 0.5);
    case 'arc3pt': return seg.mid;
    case 'bezier': {
      // The cubic at t = 1/2: (P0 + 3 P1 + 3 P2 + P3) / 8.
      const { start: a, cp1: b, cp2: c, end: d } = seg;
      const at = (i: 0 | 1 | 2) => (a[i] + 3 * b[i] + 3 * c[i] + d[i]) / 8;
      return [at(0), at(1), at(2)];
    }
    case 'spline': {
      // An interpolation point the curve passes through.
      const pts = seg.points;
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (pts.length > 2) return pts[Math.floor(pts.length / 2)];
      return first && last ? lerp(first, last, 0.5) : undefined;
    }
  }
}

/** A point on a one-edge profile's boundary. */
function closedProbe(profile: ResolvedProfile): Vec3 | undefined {
  if (profile.type === 'closedSpline') return profile.vertices?.[0];
  if (profile.type !== 'circle') return undefined;
  const radius = profile.radius ?? (profile.diameter !== undefined ? profile.diameter / 2 : undefined);
  if (radius === undefined) return undefined;
  const c = profile.center ?? profile.origin;
  const u = profile.uAxis ?? perpendicular(profile.normal);
  return [c[0] + u[0] * radius, c[1] + u[1] * radius, c[2] + u[2] * radius];
}

function edgeEnds(k: UpstreamKernel, edge: ShapeHandle): string {
  const vertices = k.getSubShapes(edge, 'vertex');
  try {
    const points = vertices.map(v => {
      const p = k.vertexPosition(v);
      return [p.x, p.y, p.z] as Vec3;
    });
    const a = points[0];
    const b = points[points.length - 1];
    if (!a || !b) return CLOSED;
    return pointKey(a) === pointKey(b) ? CLOSED : endsKey(a, b);
  } finally {
    for (const v of vertices) k.release(v);
  }
}

function closestByProbe(k: UpstreamKernel, edge: ShapeHandle, candidates: Candidate[]): Candidate | undefined {
  let best: Candidate | undefined;
  let bestDistance = PROBE_TOLERANCE_MM;
  for (const c of candidates) {
    const { point } = k.projectPointOnEdge(edge, { x: c.probe[0], y: c.probe[1], z: c.probe[2] });
    const d = Math.hypot(point.x - c.probe[0], point.y - c.probe[1], point.z - c.probe[2]);
    if (d <= bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

function endsKey(a: Vec3, b: Vec3): string {
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/** Coordinates to 1e-4 mm; a value that rounds to -0 keys as 0. */
function pointKey(p: Vec3): string {
  return p.map(v => {
    const s = v.toFixed(4);
    return s === '-0.0000' ? '0.0000' : s;
  }).join(',');
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function perpendicular(n: Vec3): Vec3 {
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const c: Vec3 = [
    n[1] * helper[2] - n[2] * helper[1],
    n[2] * helper[0] - n[0] * helper[2],
    n[0] * helper[1] - n[1] * helper[0],
  ];
  const len = Math.hypot(c[0], c[1], c[2]);
  return [c[0] / len, c[1] / len, c[2] / len];
}
