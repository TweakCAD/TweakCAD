/**
 * Tangent chains of edges, read from the display's edge polylines: two
 * edges of a body continue each other when they share an end and leave it
 * in opposite directions, within a few degrees. A chain is the edges
 * reached that way from one edge, as fillet and chamfer picking takes them.
 */
import type { BodyMesh, Display, Key } from '@tweakcad/worker/src/v2/service/types';

type V3 = [number, number, number];

/** The angle within which two edge directions at a shared end count as tangent. */
const TANGENT_DEGREES = 8;

interface EdgeEnds {
  key: Key;
  /** Start and end points, and the unit direction leaving each end into the edge. */
  ends: [{ at: V3; out: V3 }, { at: V3; out: V3 }];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function point(segments: Float32Array, index: number): V3 {
  return [segments[index * 3] as number, segments[index * 3 + 1] as number, segments[index * 3 + 2] as number];
}

/** Each drawn edge of a body mesh with its ends; a closed edge (a full circle) has no ends to share. */
function edgesOf(mesh: BodyMesh): EdgeEnds[] {
  const out: EdgeEnds[] = [];
  for (let i = 0; i + 2 < mesh.edges.length; i += 3) {
    const first = mesh.edges[i] as number;
    const count = mesh.edges[i + 1] as number;
    const key = mesh.edges[i + 2] as number;
    if (count === 0) continue;
    // Segment s runs from point 2s to point 2s + 1.
    const a0 = point(mesh.segments, 2 * first);
    const a1 = point(mesh.segments, 2 * first + 1);
    const b0 = point(mesh.segments, 2 * (first + count - 1));
    const b1 = point(mesh.segments, 2 * (first + count - 1) + 1);
    out.push({
      key,
      ends: [
        { at: a0, out: unit(sub(a1, a0)) },
        { at: b1, out: unit(sub(b0, b1)) },
      ],
    });
  }
  return out;
}

function meshOf(display: Display, edge: Key): BodyMesh | undefined {
  for (const d of display.definitions) {
    for (const b of d.bodies) {
      const m = b.mesh;
      for (let i = 2; i < m.edges.length; i += 3) if (m.edges[i] === edge) return m;
    }
  }
  return undefined;
}

/** The edges in `edge`'s tangent chain, `edge` first. */
export function tangentChain(display: Display | null, edge: Key): Key[] {
  const mesh = display ? meshOf(display, edge) : undefined;
  if (!mesh) return [edge];
  const edges = edgesOf(mesh);
  let size = 0;
  for (const e of edges) size = Math.max(size, len(sub(e.ends[0].at, e.ends[1].at)));
  const tol = Math.max(size * 1e-4, 1e-4);
  const cos = Math.cos((TANGENT_DEGREES * Math.PI) / 180);
  const byKey = new Map(edges.map((e) => [e.key, e]));
  const chain: Key[] = [edge];
  const seen = new Set<Key>([edge]);
  const queue = [edge];
  while (queue.length > 0) {
    const current = byKey.get(queue.shift() as Key);
    if (!current) continue;
    for (const end of current.ends) {
      if (len(sub(current.ends[0].at, current.ends[1].at)) <= tol) continue;
      for (const other of edges) {
        if (seen.has(other.key)) continue;
        const touching = other.ends.find((o) => len(sub(o.at, end.at)) <= tol);
        if (!touching || dot(touching.out, end.out) > -cos) continue;
        seen.add(other.key);
        chain.push(other.key);
        queue.push(other.key);
      }
    }
  }
  return chain;
}

/**
 * The faces in `face`'s tangent chain, `face` first, read from the display
 * mesh: two faces of a body continue each other when they share at least
 * two mesh points (an edge between them) with normals within a few degrees
 * there. A chain is the faces reached that way, as shell picking takes them.
 */
export function tangentFaces(display: Display | null, face: Key): Key[] {
  for (const d of display?.definitions ?? []) {
    for (const b of d.bodies) {
      const m = b.mesh;
      for (let i = 2; i < m.faces.length; i += 3) if (m.faces[i] === face) return faceChain(m, face);
    }
  }
  return [face];
}

function faceChain(m: BodyMesh, face: Key): Key[] {
  let size = 0;
  for (let i = 0; i < m.positions.length; i++) size = Math.max(size, Math.abs(m.positions[i] as number));
  const step = Math.max(size * 1e-5, 1e-6);
  const cos = Math.cos((TANGENT_DEGREES * Math.PI) / 180);
  // At each mesh point, the faces that have a vertex there, with their normal.
  const at = new Map<string, { face: Key; normal: V3 }[]>();
  for (let i = 0; i + 2 < m.faces.length; i += 3) {
    const first = m.faces[i] as number;
    const count = m.faces[i + 1] as number;
    const key = m.faces[i + 2] as number;
    const seen = new Set<number>();
    for (let t = first; t < first + count; t++) {
      for (let c = 0; c < 3; c++) {
        const v = m.indices[3 * t + c] as number;
        if (seen.has(v)) continue;
        seen.add(v);
        const p = [0, 1, 2].map((k) => Math.round((m.positions[3 * v + k] as number) / step)).join(',');
        const normal: V3 = [m.normals[3 * v] as number, m.normals[3 * v + 1] as number, m.normals[3 * v + 2] as number];
        const list = at.get(p) ?? [];
        list.push({ face: key, normal });
        at.set(p, list);
      }
    }
  }
  // How many points each pair of faces shares with matching normals.
  const smooth = new Map<Key, Map<Key, number>>();
  for (const list of at.values()) {
    for (const a of list) {
      for (const b of list) {
        if (a.face === b.face || dot(a.normal, b.normal) < cos) continue;
        const row = smooth.get(a.face) ?? new Map<Key, number>();
        row.set(b.face, (row.get(b.face) ?? 0) + 1);
        smooth.set(a.face, row);
      }
    }
  }
  const chain: Key[] = [face];
  const queue = [face];
  while (queue.length > 0) {
    for (const [next, shared] of smooth.get(queue.shift() as Key) ?? []) {
      if (shared < 2 || chain.includes(next)) continue;
      chain.push(next);
      queue.push(next);
    }
  }
  return chain;
}
