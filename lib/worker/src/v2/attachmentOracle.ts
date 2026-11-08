/**
 * Judges whether references still land on the same entity after an edit,
 * by geometry alone: each face is told by its surface, each edge and vertex
 * by the surfaces it lies on. Names are never consulted, so a naming bug
 * cannot hide itself. For the wrong-attachment suites.
 */
import { resolve, writeRecord, type NamedEntity, type ShapeKey, type Vec3 } from '@tweakcad/format';
import type { Evaluation } from './evaluate';

/**
 * Where a point of the old build is in the new one, for the geometry an edit
 * leaves in place; `turn`, when given, says how a direction at a point turns
 * (directions stay as they are otherwise).
 */
export type Move = ((p: Vec3) => Vec3) & { turn?: (d: Vec3, at: Vec3) => Vec3 };
export const same: Move = (p) => p;

/** `move` with directions turned by `turn`. */
export function turning(move: (p: Vec3) => Vec3, turn: (d: Vec3, at: Vec3) => Vec3): Move {
  return Object.assign((p: Vec3) => move(p), { turn });
}

const r4 = (x: number) => (Math.abs(x) < 5e-5 ? 0 : x).toFixed(4);
export const key = (v: readonly number[]) => v.map(r4).join(',');
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** A direction with its sign fixed, so a line's two directions read the same. */
function canonical(v: Vec3): Vec3 {
  const first = v.find((x) => Math.abs(x) > 1e-6) ?? 1;
  return first < 0 ? [-v[0], -v[1], -v[2]] : v;
}

/** A direction at `at`, carried by `move`. */
const moved = (move: Move, at: Vec3, d: Vec3): Vec3 => unit(move.turn ? move.turn(d, at) : d);

interface FaceFacts {
  tag: string;
  /** A round face's radius, which tells coaxial faces apart; 0 for others. */
  radius: number;
}

/** A face told by its surface alone: a plane by normal and offset, a round surface by kind, axis and axis line. */
function faceFacts(ev: Evaluation, face: ShapeKey, move: Move): FaceFacts {
  const centroid = ev.adapter.measures(face).centroid as Vec3;
  let s: ReturnType<Evaluation['adapter']['faceGeometry']>['surface'];
  try {
    s = ev.adapter.faceGeometry(face).surface;
  } catch {
    // A surface the adapter gives no exact data for (the wall of an extruded ellipse or spline): by where it stands in plan.
    const at = move(centroid);
    return { tag: `swept ${key([at[0], at[1]])}`, radius: 0 };
  }
  if (s.kind === 'plane') {
    const n = moved(move, centroid, s.normal);
    return { tag: `plane ${key(n)} ${r4(dot(n, move(centroid)))}`, radius: 0 };
  }
  if (s.kind === 'bspline') return { tag: `bspline ${key(move(centroid))}`, radius: 0 };
  const radius = s.radii[s.radii.length - 1] ?? 0;
  if (s.kind === 'sphere') return { tag: `sphere ${key(move(s.origin))}`, radius };
  const axis = canonical(moved(move, s.origin, s.axis));
  // The axis line by its point nearest the origin.
  const o = move(s.origin);
  const foot: Vec3 = [o[0] - axis[0] * dot(o, axis), o[1] - axis[1] * dot(o, axis), o[2] - axis[2] * dot(o, axis)];
  return { tag: `${s.kind} ${key(axis)} ${key(foot)}`, radius };
}

interface Tagged {
  entity: NamedEntity;
  tag: string;
  /** Where it is, and its size's rank among entities with its tag, to tell those apart. */
  at: readonly number[];
}

/** Ranks outweigh positions: coaxial faces or concentric edges keep their order of size through an edit. */
const RANK_WEIGHT = 1e3;

/** Every face, edge and vertex of the part, tagged by the surfaces it lies on, after `move`. */
function tagged(ev: Evaluation, part: string, move: Move): Tagged[] {
  const result = ev.parts.get(part);
  if (!result) throw new Error(`no part ${part}`);
  const facesOf = new Map<ShapeKey, readonly ShapeKey[]>();
  for (const shape of result.shapes.keys()) {
    const t = ev.adapter.topology(shape);
    for (const e of t.edges)
      facesOf.set(
        e.edge,
        e.faces.map((f) => f.face),
      );
    for (const v of t.vertices) facesOf.set(v.vertex, v.faces);
  }
  const facts = new Map<ShapeKey, FaceFacts>();
  const factsOf = (f: ShapeKey) => {
    const known = facts.get(f);
    if (known) return known;
    const made = faceFacts(ev, f, move);
    facts.set(f, made);
    return made;
  };
  const out: (Tagged & { size: number })[] = [];
  for (const entity of result.state.entities.values()) {
    const m = ev.adapter.measures(entity.key);
    if (entity.kind === 'face') {
      const f = factsOf(entity.key);
      out.push({ entity, tag: f.tag, at: move(m.centroid as Vec3), size: f.radius });
    } else if (entity.kind === 'edge' || entity.kind === 'vertex') {
      const faces = [...new Set((facesOf.get(entity.key) ?? []).map((f) => factsOf(f).tag))].sort();
      const at = (m.midpoint ?? m.point ?? m.center ?? m.vertices?.[0] ?? m.bbox?.[0]) as Vec3 | undefined;
      if (!at) throw new Error(`no position measured for ${entity.kind} ${JSON.stringify(m)}`);
      out.push({ entity, tag: `${entity.kind} ${faces.join(' | ')}`, at: move(at), size: m.length ?? 0 });
    }
  }
  const sizes = new Map<string, number[]>();
  for (const t of out) sizes.set(t.tag, [...(sizes.get(t.tag) ?? []), Number(r4(t.size))]);
  return out.map(({ entity, tag, at, size }) => {
    const distinct = [...new Set(sizes.get(tag))].sort((a, b) => a - b);
    return { entity, tag, at: [...at, distinct.indexOf(Number(r4(size))) * RANK_WEIGHT] };
  });
}

const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((x, i) => x - (b[i] ?? 0)));

export interface Outcome {
  checked: number;
  /** Resolved to a different entity: the failure the suites exist for. */
  wrong: string[];
  /** Asked or gone though one entity in the new build is plainly the same. */
  lost: string[];
  asked: number;
  /** Gone, with nothing in the new build like it. */
  gone: number;
}

/** Picks every face, edge and vertex of `part` in `before`, resolves each in `after`, and judges it. */
export function judge(before: Evaluation, after: Evaluation, part: string, move: Move): Outcome {
  const stateA = before.parts.get(part)?.state;
  const stateB = after.parts.get(part)?.state;
  if (!stateA || !stateB) throw new Error(`no part ${part}`);
  const old = tagged(before, part, move);
  const now = tagged(after, part, same);
  const byTag = new Map<string, Tagged[]>();
  for (const t of now) byTag.set(t.tag, [...(byTag.get(t.tag) ?? []), t]);

  const out: Outcome = { checked: 0, wrong: [], lost: [], asked: 0, gone: 0 };
  for (const t of old) {
    const role = (before.names.get(t.entity.ladder[1] as string) as { role?: string } | undefined)?.role;
    if (role === 'seam' || role === 'pole' || role === 'apex') continue;
    out.checked++;
    const found = resolve(writeRecord(t.entity, stateA, before.adapter), stateB, after.adapter);
    const candidates = (byTag.get(t.tag) ?? []).filter((c) => c.entity.kind === t.entity.kind);
    const nearest = candidates.slice().sort((x, y) => distance(x.at, t.at) - distance(y.at, t.at))[0];
    const label = `${t.tag} at ${key(t.at)}`;
    if (found.outcome === 'same') {
      const ok =
        found.entities.every((e) => candidates.some((c) => c.entity.key === e.key)) &&
        (candidates.length <= 1 || found.entities.some((e) => e.key === nearest?.entity.key));
      if (!ok) {
        const where = found.entities.map((e) => {
          const hit = now.find((x) => x.entity.key === e.key);
          return hit ? `${hit.tag} at ${key(hit.at)}` : '?';
        });
        out.wrong.push(`${label} -> ${where.join('; ')}`);
      }
    } else {
      if (found.outcome === 'ask') out.asked++;
      if (candidates.length === 1) out.lost.push(`${label}: ${found.outcome}`);
      else if (found.outcome === 'gone' && candidates.length === 0) out.gone++;
    }
  }
  return out;
}

/** Points above `z` rise by `dz`. */
export const above =
  (z: number, dz: number): Move =>
  (p) =>
    p[2] > z + 1e-6 ? [p[0], p[1], p[2] + dz] : p;

/** Points in the box from `min` to `max` move by `by`. */
export const inBox =
  (min: Vec3, max: Vec3, by: Vec3): Move =>
  (p) =>
    p.every((v, i) => v >= (min[i] as number) - 1e-6 && v <= (max[i] as number) + 1e-6)
      ? [p[0] + by[0], p[1] + by[1], p[2] + by[2]]
      : p;

/** The first of `moves` that moves a point decides where it goes. */
export const either =
  (...moves: Move[]): Move =>
  (p) => {
    for (const m of moves) {
      const q = m(p);
      if (q[0] !== p[0] || q[1] !== p[1] || q[2] !== p[2]) return q;
    }
    return p;
  };
