/**
 * What a feature's inputs point at (7.3): points, lines, axes, directions and
 * attached frames, read in the part as it stands before the feature.
 */
import { finest, type NamedEntity } from '@tweakcad/format';
import {
  FLAG,
  FeaturePause,
  LENGTH_VECTOR,
  PLACEMENT,
  TEXT,
  add,
  cross,
  dot,
  norm,
  rotate,
  scale,
  sub,
  unit,
  type BuildContext,
  type ConstructionOutput,
  type Frame,
  type Json,
  type SketchResult,
  type V3,
} from './context';
import { lift } from './profiles';
import { contextPlaces } from './contexts';
import { entitiesOf, inContextOf } from './references';
import { apply, applyVector } from './rigid';

/** What reading a place needs: the evaluation and the part before the feature. */
export type Where = Pick<BuildContext, 'ev' | 'part'>;

/** A line in the part; `direction` is a unit vector. */
export interface Line {
  point: V3;
  direction: V3;
}

/** Below this angle (rad) two directions are parallel. */
const PARALLEL = 1e-9;

/** The default planes (9.1 `standard`): right-handed, normal = x × y. */
export const STANDARD: Record<string, Frame> = {
  xy: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] },
  xz: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, -1], normal: [0, 1, 0] },
  yz: { origin: [0, 0, 0], x: [0, 0, -1], y: [0, 1, 0], normal: [1, 0, 0] },
};

/** The default axes, through the origin. */
const STANDARD_AXES: Record<string, V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

const CONSTRUCTION_KINDS = new Set(['plane', 'axis', 'point', 'frame']);

/**
 * The construction output a reference names, by its feature or by its name
 * (9.1); undefined when it names something else. A construction output that
 * did not build in this evaluation pauses.
 */
export function constructionOf(w: Where, ref: Json): ConstructionOutput | undefined {
  const { part, ev } = w;
  if ('object' in ref) {
    const feature = (ref.object as Json).feature as Json | undefined;
    if (!feature) return undefined;
    return part.construction.get(feature.id as string);
  }
  if ('entity' in ref) {
    const hash = ((ref.entity as Json).id as string[]).at(-1);
    if (hash === undefined) return undefined;
    const output = [...part.construction.values()].find((c) => c.ladder.includes(hash));
    if (output) return output;
    const level = ev.names.get(hash) as Json | undefined;
    // A construction output's name is its kind as role, with no `src`; a sketch point has its row as `src`.
    const construction =
      level &&
      CONSTRUCTION_KINDS.has(level.kind as string) &&
      level.role === level.kind &&
      ((level.src as Json[] | undefined) ?? []).length === 0;
    if (construction) throw new FeaturePause(`the construction ${String(level.kind)} is gone`);
  }
  return undefined;
}

/** The one model entity a reference resolves to; `what` names it in pauses. */
export function entityOf(w: Where, ref: Json, what: string): NamedEntity {
  const found = entitiesOf(w, ref, what);
  if (found.length !== 1) throw new FeaturePause(`${what} names several entities`);
  return found[0] as NamedEntity;
}

/** The sketch row a reference names (a curve or a point by its root), or undefined for model geometry. */
export function sketchRowOf(
  w: Where,
  ref: Json,
): { sketch: SketchResult; kind: 'curve' | 'point'; id: string } | undefined {
  const record = ref.entity as Json | undefined;
  if (!record || (record.id as string[]).length === 0) return undefined;
  const level = w.ev.names.get(finest(record.id as string[])) as Json | undefined;
  const first = (level?.src as Json[] | undefined)?.[0];
  if (!level || (level.kind !== 'curve' && level.kind !== 'point') || !first || !('id' in first)) return undefined;
  if (contextPlaces.has(w.part))
    throw new FeaturePause('sketch geometry of another part is not built yet in a captured context');
  const sketch = w.part.sketches.get((level.feature as Json).id as string);
  if (!sketch) throw new FeaturePause('the referenced sketch did not build');
  return { sketch, kind: level.kind, id: (first.id as Json).id as string };
}

/** The point a reference names: the origin, a construction point or frame, a sketch point, a vertex or a circular edge's centre. */
export function pointAt(w: Where, ref: Json): V3 {
  const opened = inContextOf(w, ref);
  if (opened)
    return 'standard' in opened.ref
      ? apply(opened.placement, pointAt(opened.w, opened.ref))
      : pointAt(opened.w, opened.ref);
  if ('standard' in ref) {
    if ((ref.standard as Json).name === 'origin') return [0, 0, 0];
    throw new FeaturePause('this default geometry is not a point');
  }
  const output = constructionOf(w, ref);
  if (output) {
    if (output.kind !== 'point' && output.kind !== 'frame')
      throw new FeaturePause(`a construction ${output.kind} is not a point`);
    return output.frame.origin;
  }
  const row = sketchRowOf(w, ref);
  if (row) {
    const p = row.kind === 'point' ? row.sketch.solved.points.find((q) => q.id === row.id) : undefined;
    if (!p) throw new FeaturePause('the referenced sketch geometry is not a point in this build');
    return lift(row.sketch.frame, [p.x, p.y]);
  }
  const entity = entityOf(w, ref, 'a point');
  const m = w.ev.adapter.measures(entity.key);
  if (entity.kind === 'vertex' && m.point) return m.point as V3;
  if (entity.kind === 'edge' && m.curve === 'circle' && m.center) return m.center as V3;
  throw new FeaturePause('a point names something that is not a point or a circle');
}

/** A point (7.3): a position in the part, or what a reference names. */
export function pointOf(w: Where, point: Json): V3 {
  if ('at' in point) return w.ev.values.literal((point.at as Json).v, LENGTH_VECTOR) as V3;
  return pointAt(w, (point.of as Json).ref as Json);
}

/** The straight line a reference names, directed from its start: a default or construction axis, a sketch line or a straight edge. */
export function lineOf(w: Where, ref: Json): Line {
  const opened = inContextOf(w, ref);
  if (opened) {
    const line = lineOf(opened.w, opened.ref);
    return 'standard' in opened.ref
      ? { point: apply(opened.placement, line.point), direction: applyVector(opened.placement, line.direction) }
      : line;
  }
  if ('standard' in ref) {
    const direction = STANDARD_AXES[(ref.standard as Json).name as string];
    if (!direction) throw new FeaturePause('this default geometry is not an axis');
    return { point: [0, 0, 0], direction };
  }
  const output = constructionOf(w, ref);
  if (output) {
    if (output.kind !== 'axis') throw new FeaturePause(`a construction ${output.kind} is not an axis`);
    return { point: output.frame.origin, direction: output.frame.normal };
  }
  const row = sketchRowOf(w, ref);
  if (row) {
    const lines = row.kind === 'curve' ? (row.sketch.lines.get(row.id) ?? []) : [];
    if (lines.length !== 1)
      throw new FeaturePause(`the axis names ${lines.length === 0 ? 'no line' : 'a divided line'} in this build`);
    const [start, end] = lines[0] as (typeof lines)[number];
    const [a, b] = [lift(row.sketch.frame, start), lift(row.sketch.frame, end)];
    if (norm(sub(b, a)) === 0) throw new FeaturePause('the axis line has no length');
    return { point: a, direction: unit(sub(b, a)) };
  }
  const edge = entityOf(w, ref, 'an axis');
  if (edge.kind !== 'edge') throw new FeaturePause('an axis names something that is not a line');
  const geometry = w.ev.adapter.edgeGeometry(edge.key);
  if (geometry.curve.kind !== 'line') throw new FeaturePause('an axis names an edge that is not straight');
  const start = geometry.start as V3;
  return { point: start, direction: unit(sub(geometry.end as V3, start)) };
}

/** An axis (7.3): along a straight reference, or through a point in a direction. */
export function axisOf(w: Where, axis: Json): Line {
  const { values } = w.ev;
  if ('along' in axis) {
    const along = axis.along as Json;
    const line = lineOf(w, along.ref as Json);
    return values.literal(along.reversed, FLAG) === true ? { ...line, direction: scale(line.direction, -1) } : line;
  }
  const through = axis.through as Json;
  return { point: pointOf(w, through.point as Json), direction: directionOf(w, through.direction as Json) };
}

/**
 * A frame with origin `origin` and z along `z` (a unit vector): x is the
 * part's x axis projected onto the plane normal to z, or its y axis when x
 * is within 1e-9 rad of z (7.3: a face's `plane` frame, `twoPoints`, `alongLine`).
 */
function frameAlong(origin: V3, z: V3): Frame {
  const partX: V3 = [1, 0, 0];
  const axis: V3 = norm(cross(partX, z)) <= PARALLEL ? [0, 1, 0] : partX;
  const x = unit(sub(axis, scale(z, dot(axis, z))));
  return { origin, x, y: cross(z, x), normal: z };
}

/** The frame of a planar face by the `plane` mode: z its outward normal, origin and x the part's projected onto it. */
export function faceFrameOf(w: Where, ref: Json, what = 'a face'): Frame {
  const face = entityOf(w, ref, what);
  if (face.kind !== 'face') throw new FeaturePause('a plane support names something that is not a face');
  const m = w.ev.adapter.measures(face.key);
  if (m.surface !== 'plane') throw new FeaturePause('a curved face is not a plane');
  const normal = m.normal as V3;
  return frameAlong(scale(normal, dot(m.centroid as V3, normal)), normal);
}

/** The frame of the `plane` mode on a default plane, a construction plane or a planar face. */
function planeOf(w: Where, support: Json): Frame {
  const opened = inContextOf(w, support);
  if (opened) {
    const f = planeOf(opened.w, opened.ref);
    if (!('standard' in opened.ref)) return f;
    const p = opened.placement;
    return {
      origin: apply(p, f.origin),
      x: applyVector(p, f.x),
      y: applyVector(p, f.y),
      normal: applyVector(p, f.normal),
    };
  }
  if ('standard' in support) {
    const frame = STANDARD[(support.standard as Json).name as string];
    if (!frame) throw new FeaturePause('the support of a plane frame is not a plane');
    return frame;
  }
  const output = constructionOf(w, support);
  if (output) {
    if (output.kind !== 'plane') throw new FeaturePause('the support of a plane frame is not a plane');
    return output.frame;
  }
  if ('object' in support) throw new FeaturePause('the plane support did not build');
  return faceFrameOf(w, support);
}

/** `v` with the sign that makes its first component off 0 (beyond 1e-9) positive. */
function canonicalSign(v: V3): V3 {
  const first = v.find((c) => Math.abs(c) > 1e-9) ?? 0;
  return first < 0 ? scale(v, -1) : v;
}

/**
 * The `midplane` mode: halfway between two parallel planes (normals within
 * 1e-9 rad, either sense), z the first's normal; otherwise the plane through
 * their line of intersection bisecting the angle between them, z along
 * n1 − n2 (between two faces of a body, the bisector that runs through it).
 * The origin is the part origin projected onto it and x as for a face.
 */
export function midplaneOf(a: Frame, b: Frame): Frame {
  const [n1, n2] = [a.normal, b.normal];
  if (norm(cross(n1, n2)) <= PARALLEL) {
    const z = n1;
    const level = (dot(a.origin, z) + dot(b.origin, z)) / 2;
    return frameAlong(scale(z, level), z);
  }
  const z = unit(sub(n1, n2));
  // A point on the line of intersection: n1·p = d1 and n2·p = d2.
  const u = cross(n1, n2);
  const [d1, d2] = [dot(a.origin, n1), dot(b.origin, n2)];
  const p = scale(cross(sub(scale(n2, d1), scale(n1, d2)), u), 1 / dot(u, u));
  return frameAlong(scale(z, dot(p, z)), z);
}

/**
 * The axis of a cylindrical, conical or toroidal face (the `faceAxis`
 * mode): through the point of the axis nearest the face's centre of mass,
 * directed so its first component off 0 is positive.
 */
function faceAxisOf(w: Where, ref: Json): Line {
  const face = entityOf(w, ref, 'a face');
  if (face.kind !== 'face') throw new FeaturePause('the axis support is not a face');
  const surface = w.ev.adapter.faceGeometry(face.key).surface;
  if (surface.kind !== 'cylinder' && surface.kind !== 'cone' && surface.kind !== 'torus')
    throw new FeaturePause('the face has no axis: it is not a cylinder, a cone or a torus');
  const direction = canonicalSign(unit(surface.axis as V3));
  const centroid = w.ev.adapter.measures(face.key).centroid as V3;
  const origin = surface.origin as V3;
  return { point: add(origin, scale(direction, dot(sub(centroid, origin), direction))), direction };
}

/** The centre the `center` mode puts its origin at: a circular edge's (an arc's too), or a spherical or toroidal face's. */
function centerOf(w: Where, ref: Json): V3 {
  const entity = entityOf(w, ref, 'a centre');
  if (entity.kind === 'edge') {
    const curve = w.ev.adapter.edgeGeometry(entity.key).curve;
    if (curve.kind === 'circle') return curve.center as V3;
    throw new FeaturePause('the edge is not circular');
  }
  if (entity.kind === 'face') {
    const surface = w.ev.adapter.faceGeometry(entity.key).surface;
    if (surface.kind === 'sphere' || surface.kind === 'torus') return surface.origin as V3;
    throw new FeaturePause('the face is not a sphere or a torus');
  }
  throw new FeaturePause('a centre names something that is not a circular edge, a sphere or a torus');
}

/** The frame an attachment mode (7.3) makes from its supports, before `xAxis`, `offset` and `flip`. */
function modeFrame(w: Where, mode: unknown, supports: readonly Json[]): Frame {
  const count = (n: number) => {
    if (supports.length !== n) throw new FeaturePause(`the ${String(mode)} mode takes ${n} supports`);
  };
  switch (mode) {
    case 'plane':
      count(1);
      return planeOf(w, supports[0] as Json);
    case 'planeAtPoint': {
      count(2);
      const base = planeOf(w, supports[0] as Json);
      const p = pointAt(w, supports[1] as Json);
      return { ...base, origin: sub(p, scale(base.normal, dot(sub(p, base.origin), base.normal))) };
    }
    case 'threePoints': {
      count(3);
      const [p1, p2, p3] = supports.map((s) => pointAt(w, s)) as [V3, V3, V3];
      const z = cross(sub(p2, p1), sub(p3, p1));
      if (norm(sub(p2, p1)) === 0 || norm(z) <= PARALLEL * norm(sub(p2, p1)) * norm(sub(p3, p1))) {
        throw new FeaturePause('the three points of the frame are collinear');
      }
      const x = unit(sub(p2, p1));
      const normal = unit(z);
      return { origin: p1, x, y: cross(normal, x), normal };
    }
    case 'twoPoints': {
      count(2);
      const [p1, p2] = supports.map((s) => pointAt(w, s)) as [V3, V3];
      if (norm(sub(p2, p1)) === 0) throw new FeaturePause('the two points of the frame coincide');
      return frameAlong(p1, unit(sub(p2, p1)));
    }
    case 'point':
      count(1);
      return { origin: pointAt(w, supports[0] as Json), x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
    case 'alongLine': {
      count(1);
      const line = lineOf(w, supports[0] as Json);
      return frameAlong(line.point, line.direction);
    }
    case 'midplane': {
      count(2);
      return midplaneOf(planeOf(w, supports[0] as Json), planeOf(w, supports[1] as Json));
    }
    case 'faceAxis': {
      count(1);
      const axis = faceAxisOf(w, supports[0] as Json);
      return frameAlong(axis.point, axis.direction);
    }
    case 'center':
      count(1);
      return { origin: centerOf(w, supports[0] as Json), x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
    default:
      throw new FeaturePause(`the ${String(mode)} attachment mode is not built yet`);
  }
}

/** An attached frame (7.3). */
export function frameOf(w: Where, frame: Json): Frame {
  const { values } = w.ev;
  const placement = (v: unknown) => values.literal(v, PLACEMENT) as { position: V3; rotation: number[] };
  const apply = (base: Frame, p: { position: V3; rotation: number[] }): Frame => {
    const toWorld = (local: V3) =>
      add(add(scale(base.x, local[0]), scale(base.y, local[1])), scale(base.normal, local[2]));
    const turn = (axis: V3) => toWorld(rotate(p.rotation, axis));
    return {
      origin: add(base.origin, toWorld(p.position)),
      x: turn([1, 0, 0]),
      y: turn([0, 1, 0]),
      normal: turn([0, 0, 1]),
    };
  };
  if ('fixed' in frame) return apply(STANDARD.xy as Frame, placement((frame.fixed as Json).placement));
  const attach = frame.attach as Json;
  let base = modeFrame(w, values.literal(attach.mode, TEXT), attach.support as Json[]);
  if (attach.xAxis !== undefined) {
    const d = directionOf(w, attach.xAxis as Json);
    const along = sub(d, scale(base.normal, dot(d, base.normal)));
    if (norm(along) < PARALLEL) throw new FeaturePause('the x direction is along the plane normal');
    const x = unit(along);
    base = { ...base, x, y: cross(base.normal, x) };
  }
  let f = apply(base, placement(attach.offset));
  if (values.literal(attach.flip, FLAG) === true) f = { ...f, y: scale(f.y, -1), normal: scale(f.normal, -1) };
  return f;
}

/** The normal a reference names: a sketch's, a construction plane's, or a planar face's outward normal. */
function normalOf(w: Where, ref: Json): V3 {
  const opened = inContextOf(w, ref);
  if (opened)
    return 'standard' in opened.ref
      ? applyVector(opened.placement, normalOf(opened.w, opened.ref))
      : normalOf(opened.w, opened.ref);
  const feature = ((ref.object as Json | undefined)?.feature as Json | undefined)?.id as string | undefined;
  const sketch = feature === undefined ? undefined : w.part.sketches.get(feature);
  if (sketch) return sketch.frame.normal;
  if ('standard' in ref) {
    const frame = STANDARD[(ref.standard as Json).name as string];
    if (!frame) throw new FeaturePause('this default geometry has no normal');
    return frame.normal;
  }
  const output = constructionOf(w, ref);
  if (output) {
    if (output.kind !== 'plane') throw new FeaturePause(`a construction ${output.kind} has no normal`);
    return output.frame.normal;
  }
  // A feature reference that found neither a sketch nor a construction output names one that did not build.
  if (feature !== undefined)
    throw new FeaturePause('the sketch or construction feature this direction uses did not build');
  return faceFrameOf(w, ref).normal;
}

/** A direction (7.3). */
export function directionOf(w: Where, direction: Json): V3 {
  const { values } = w.ev;
  const tag = Object.keys(direction)[0] as string;
  const d = direction[tag] as Json;
  const signed = (v: V3) => (values.literal(d.reversed, FLAG) === true ? scale(v, -1) : v);
  switch (tag) {
    case 'normal':
      return signed(normalOf(w, d.ref as Json));
    case 'along':
      return signed(lineOf(w, d.ref as Json).direction);
    case 'vector': {
      const v = values.literal(d.v, LENGTH_VECTOR) as V3;
      if (norm(v) === 0) throw new FeaturePause('the direction is a zero vector');
      return signed(unit(v));
    }
    case 'axis': {
      const axis = values.literal(d.axis, { type: 'choice', options: ['x', 'y', 'z'] }) as string;
      return signed(STANDARD_AXES[axis] as V3);
    }
    default:
      throw new FeaturePause('this direction form is not built yet');
  }
}
