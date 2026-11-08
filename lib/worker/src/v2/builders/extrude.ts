/**
 * `core.extrude` (appendix A): each profile region, or its thin band, swept
 * along the direction into a tool body, its walls named after the sketch
 * curve each came from, then the operation.
 *
 * A side ends at a distance, through all, or at a stop: a face (`toFace`), a
 * body (`toBody`), or the nearest or furthest face of the target bodies on
 * the ray from the profile's centre of mass (`upToNext`, `upToLast`). The
 * tool is swept past the stop, divided by it, and keeps the piece holding the
 * profile; the cap there lies on the stop. A face the profile does not wholly
 * reach is extended to its whole surface first (planes, cylinders and
 * spheres).
 *
 * Tapers widen the profile for positive angles and pivot about the sketch
 * plane, each side by its own angle. Where the second side's taper is the
 * opposite of the first's, the walls run straight through the sketch plane,
 * one face per profile curve; otherwise each side has its own walls, and
 * those of the second side carry `index(1)` in `src`.
 *
 * The extrude starts on the sketch plane, at an offset from it along the
 * direction, or on a face or plane (`start`). A plane parallel to the sketch
 * plane moves the profile onto it; any other face is a start surface: the
 * profile is swept far both ways, divided by the surface and kept ahead of
 * it, so the start cap takes the surface's shape, and a side's distance ends
 * on the surface moved by that distance.
 */
import { startFeature, type FeatureNamer, type OperationHistory, type ShapeKey, type SrcFact } from '@tweakcad/format';
import { BooleanOp, type BoundingBox, type ShapeHandle } from 'occt-wasm';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import {
  ANGLE,
  FeaturePause,
  LENGTH,
  TEXT,
  add,
  cross,
  dot,
  kv,
  norm,
  registerBuilder,
  scale,
  sub,
  unit,
  type BuildContext,
  type Frame,
  type Json,
  type V3,
} from '../context';
import { STANDARD, constructionOf, directionOf, entityOf } from '../places';
import { REFINE_ANGLE, applyOperation, namedBoolean, type Live, type Tool } from '../operation';
import { buildProfiles, segmentOf, sketchTolerance, type Profile } from '../profiles';
import { sweptFaces, thinOf, wallOf, type SweptFace } from '../thin';

/** Where one side ends. */
type End =
  | { kind: 'length'; d: number }
  | { kind: 'throughAll' }
  | { kind: 'toFace'; face: Json; offset: number }
  | { kind: 'toBody'; body: Json }
  | { kind: 'upToNext' | 'upToLast' };

interface Side {
  end: End;
  /** Degrees; positive widens the profile as the side goes. */
  taper: number;
}

/** The sides as they run: `forward` along the direction, `back` opposite to it (a negative length ends on the first side's side). */
function sidesOf(ctx: BuildContext, sides: Json[]): { forward: Side; back: Side | undefined } {
  const { values } = ctx.ev;
  const one = (side: Json): Side => {
    const extent = side.extent as Json;
    const taper = values.number(side.taper, ANGLE);
    const tag = Object.keys(extent)[0] as string;
    const o = extent[tag] as Json;
    switch (tag) {
      case 'distance':
        return { end: { kind: 'length', d: values.number(o.d, LENGTH) }, taper };
      case 'throughAll':
        return { end: { kind: 'throughAll' }, taper };
      case 'toFace':
        return { end: { kind: 'toFace', face: o.face as Json, offset: values.number(o.offset, LENGTH) }, taper };
      case 'toBody':
        return { end: { kind: 'toBody', body: o.body as Json }, taper };
      case 'upToNext':
      case 'upToLast':
        return { end: { kind: tag }, taper };
      case 'symmetric':
        throw new FeaturePause('a symmetric extent is the only side');
      default:
        throw new FeaturePause('this extent is not built yet');
    }
  };
  const first = sides[0] as Json;
  const extent = first.extent as Json;
  if ('symmetric' in extent) {
    if (sides.length !== 1) throw new FeaturePause('a symmetric extent is the only side');
    const s = extent.symmetric as Json;
    const d = values.number(s.d, LENGTH);
    const half = values.literal(s.measure, TEXT) === 'half' ? d : d / 2;
    const taper = values.number(first.taper, ANGLE);
    return { forward: { end: { kind: 'length', d: half }, taper }, back: { end: { kind: 'length', d: half }, taper } };
  }
  return { forward: one(first), back: sides[1] ? one(sides[1] as Json) : undefined };
}

/** Below this angle (rad) two directions are parallel. */
const PARALLEL = 1e-9;

/** Where an extrude starts (appendix A `start`). */
type Start =
  /** The profile moved `by` along the direction: the sketch plane, an offset, or a plane parallel to the sketch plane. */
  | { kind: 'shift'; by: number }
  /** A face or plane the profile is projected onto, then moved `offset` along the direction. */
  | { kind: 'surface'; ref: Json; offset: number };

/** The plane a start reference names, or undefined for a curved face. */
function startPlane(ctx: BuildContext, ref: Json): { point: V3; normal: V3 } | undefined {
  if ('standard' in ref) {
    const frame = STANDARD[(ref.standard as Json).name as string];
    if (!frame) throw new FeaturePause('the start of the extrude is not a face or a plane');
    return { point: frame.origin, normal: frame.normal };
  }
  const output = constructionOf(ctx, ref);
  if (output) {
    if (output.kind !== 'plane')
      throw new FeaturePause(`a construction ${output.kind} is not a face to start an extrude from`);
    return { point: output.frame.origin, normal: output.frame.normal };
  }
  const face = entityOf(ctx, ref, 'the start face');
  if (face.kind !== 'face') throw new FeaturePause('the start face names something that is not a face');
  const s = ctx.ev.adapter.faceGeometry(face.key).surface;
  return s.kind === 'plane' ? { point: s.point as V3, normal: unit(s.normal as V3) } : undefined;
}

/** Where a profile's extrude starts. */
function startOf(ctx: BuildContext, start: Json | undefined, profile: Profile, dir: V3): Start {
  if (start === undefined || 'profilePlane' in start) return { kind: 'shift', by: 0 };
  const { values } = ctx.ev;
  if ('offset' in start) return { kind: 'shift', by: values.number((start.offset as Json).d, LENGTH) };
  if (!('object' in start)) throw new FeaturePause('this start is not built yet');
  const o = start.object as Json;
  const offset = values.number(o.offset, LENGTH);
  const plane = startPlane(ctx, o.face as Json);
  if (plane && Math.abs(dot(plane.normal, dir)) <= PARALLEL)
    throw new FeaturePause('the extrude runs along its start plane');
  const { frame } = profile.sketch;
  if (plane && norm(cross(plane.normal, frame.normal)) <= PARALLEL) {
    return { kind: 'shift', by: dot(plane.normal, sub(plane.point, frame.origin)) / dot(plane.normal, dir) + offset };
  }
  return { kind: 'surface', ref: o.face as Json, offset };
}

/** A shape's axis-aligned box, as one extrude's reach calculations take it. */
type Bounds = (handle: ShapeHandle) => BoundingBox;

/**
 * The boxes an extrude's reach is worked out from, each shape's once. Where
 * the reach only has to be long enough (`loose`), a box holding the precise
 * one does: the kernel's loose box (analytic extents and control hulls plus
 * tolerance) always contains it and costs a fraction of it on curved
 * faces. Where the reach is itself a length of the result, the precise box.
 */
function boundsOf(ctx: BuildContext, loose: boolean): Bounds {
  const known = new Map<ShapeHandle, BoundingBox>();
  return (handle) => {
    let b = known.get(handle);
    if (!b)
      known.set(
        handle,
        (b = loose ? ctx.ev.kernel.getBoundingBox(handle, { precise: false }) : ctx.ev.kernel.getBoundingBox(handle)),
      );
    return b;
  };
}

/**
 * Whether the reach of an extrude only has to be long enough, so that a
 * longer one changes nothing it builds: no side is tapered (a taper that
 * narrows the profile closes it at some length), and every side ends at its
 * distance, at a stop that divides the swept tool, or through all in a cut
 * or an intersect, which keep nothing of the tool beyond the bodies. A
 * through-all side that joins or makes a body is as long as the reach.
 */
function reachOnlyBounds(ctx: BuildContext, forward: Side, back: Side | undefined): boolean {
  const sides = back ? [forward, back] : [forward];
  if (sides.some((s) => s.taper !== 0)) return false;
  if (!sides.some((s) => s.end.kind === 'throughAll')) return true;
  const op = ctx.ev.values.literal(((ctx.inputs.operation as Json).op as Json | undefined) ?? {}, TEXT);
  return op === 'cut' || op === 'intersect';
}

/** Far enough to pass through every live body: the diagonal of all their boxes, twice. */
function throughAll(ctx: BuildContext, bounds: Bounds): number {
  let reach = 1;
  for (const handle of ctx.part.shapes.values()) {
    // A body a cut took whole has no extent.
    if (ctx.ev.kernel.getSubShapes(handle, 'solid').length === 0) continue;
    const b = bounds(handle);
    const far = Math.max(...[b.xmin, b.xmax, b.ymin, b.ymax, b.zmin, b.zmax].map(Math.abs));
    reach = Math.max(reach, Math.hypot(b.xmax - b.xmin, b.ymax - b.ymin, b.zmax - b.zmin) + far);
  }
  return 2 * reach;
}

/** How far a side sweeps before any stop trims it. */
function lengthOf(end: End, reach: number): number {
  return end.kind === 'length' ? end.d : reach;
}

/**
 * What a stop divides the swept tool with, tried in order: the face as it is,
 * then its whole surface. `short` is the pause when none is reached.
 */
interface Stop {
  cutters: ShapeHandle[];
  short: string;
}

/** A square of half-width `half` in a plane, centred on the point of the plane nearest `near`. */
function planeSquare(ctx: BuildContext, point: V3, normal: V3, near: V3, half: number): ShapeHandle {
  const k = ctx.ev.kernel;
  const n = unit(normal);
  const centre = sub(near, scale(n, dot(sub(near, point), n)));
  const seed: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = unit(cross(seed, n));
  const y = cross(n, x);
  const corner = (a: number, b: number) => kv(add(centre, add(scale(x, a * half), scale(y, b * half))));
  const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  return k.makeFace(k.makeWire(corners.map((c, i) => k.makeLineEdge(c, corners[(i + 1) % 4] as typeof c))));
}

/** A solid placed with its z axis along `axis`, its origin at `origin`. */
function placed(ctx: BuildContext, shape: ShapeHandle, origin: V3, axis: V3): ShapeHandle {
  const z = unit(axis);
  const seed: V3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = unit(cross(seed, z));
  const y = cross(z, x);
  return ctx.ev.kernel.transform(shape, [
    x[0],
    y[0],
    z[0],
    origin[0],
    x[1],
    y[1],
    z[1],
    origin[1],
    x[2],
    y[2],
    z[2],
    origin[2],
  ]);
}

/** The stop of a face, a construction plane or a default plane, moved `shift` along the side. */
function faceStop(ctx: BuildContext, ref: Json, shift: V3, near: V3, reach: number): Stop {
  const k = ctx.ev.kernel;
  const move = (h: ShapeHandle) => (norm(shift) === 0 ? h : k.translate(h, shift[0], shift[1], shift[2]));
  const plane = (frame: Frame): Stop => ({
    cutters: [move(planeSquare(ctx, frame.origin, frame.normal, near, 4 * reach))],
    short: 'the extrude does not reach the target plane',
  });
  if ('standard' in ref) {
    const frame = STANDARD[(ref.standard as Json).name as string];
    if (!frame) throw new FeaturePause('the target of the extrude is not a face or a plane');
    return plane(frame);
  }
  const output = constructionOf(ctx, ref);
  if (output) {
    if (output.kind !== 'plane') throw new FeaturePause(`a construction ${output.kind} is not a face to extrude to`);
    return plane(output.frame);
  }
  const face = entityOf(ctx, ref, 'the target face');
  if (face.kind !== 'face') throw new FeaturePause('the target face names something that is not a face');
  return stopAtFace(ctx, face.key, shift, near, reach);
}

/** The stop of one model face: the face, then its surface extended. */
function stopAtFace(ctx: BuildContext, face: ShapeKey, shift: V3, near: V3, reach: number): Stop {
  const { kernel: k, adapter } = ctx.ev;
  const move = (h: ShapeHandle) => (norm(shift) === 0 ? h : k.translate(h, shift[0], shift[1], shift[2]));
  const s = adapter.faceGeometry(face).surface;
  const cutters = [move(adapter.handleOf(face))];
  if (s.kind === 'plane') cutters.push(move(planeSquare(ctx, s.point as V3, s.normal as V3, near, 4 * reach)));
  else if (s.kind === 'cylinder') {
    const axis = unit(s.axis as V3);
    const long = 4 * reach + 2 * norm(sub(near, s.origin as V3));
    cutters.push(
      move(placed(ctx, k.makeCylinder(s.radii[0] as number, 2 * long), sub(s.origin as V3, scale(axis, long)), axis)),
    );
  } else if (s.kind === 'sphere') {
    const o = s.origin as V3;
    cutters.push(move(k.translate(k.makeSphere(s.radii[0] as number), o[0], o[1], o[2])));
  }
  return {
    cutters,
    short:
      cutters.length > 1
        ? 'the extrude does not reach the target face'
        : 'the profile runs past the curved target face, which is not extended yet',
  };
}

/** The faces of the operation's target bodies, every live body for `all`. */
function targetFaces(ctx: BuildContext, targets: Json): ShapeKey[] {
  const { part, ev } = ctx;
  if (!('bodies' in targets)) return [...part.shapes.keys()].flatMap((shape) => ev.adapter.topology(shape).faces);
  return ((targets.bodies as Json).set as Json[]).flatMap((ref) => {
    const body = entityOf(ctx, ref, 'a target body');
    const shape = part.state.bodies.get(body.key);
    if (body.kind !== 'body' || shape === undefined) throw new FeaturePause('a target body is not a live body');
    return ev.adapter.topology(shape).solids.find((s) => s.solid === body.key)?.faces ?? [];
  });
}

/**
 * The face `upToNext` and `upToLast` stop at: of the target bodies' faces the
 * ray from `from` along `u` meets ahead of it, the nearest or the furthest.
 */
function rayFace(
  ctx: BuildContext,
  faces: readonly ShapeKey[],
  from: V3,
  u: V3,
  reach: number,
  last: boolean,
  tolerance: number,
): ShapeKey {
  const { kernel: k, adapter } = ctx.ev;
  const ray = k.makeLineEdge(kv(from), kv(add(from, scale(u, reach))));
  const hits: { face: ShapeKey; t: number }[] = [];
  for (const face of faces) {
    const handle = adapter.handleOf(face);
    if (k.distanceBetween(ray, handle) > tolerance) continue;
    for (const v of k.getSubShapes(k.section(ray, handle), 'vertex')) {
      const p = k.vertexPosition(v);
      const t = dot(sub([p.x, p.y, p.z], from), u);
      if (t > tolerance) hits.push({ face, t });
    }
  }
  if (hits.length === 0) throw new FeaturePause('no face of the target bodies lies ahead of the profile');
  const best = hits.reduce((a, b) => ((last ? b.t > a.t : b.t < a.t) ? b : a));
  if (hits.some((h) => h.face !== best.face && Math.abs(h.t - best.t) <= tolerance)) {
    throw new FeaturePause('the ray from the profile meets an edge, so the face it stops at is not one face');
  }
  return best.face;
}

/** What one side stops at, looked for from `centre` on the profile at its start, or undefined for a side that ends at its length. */
function stopOf(ctx: BuildContext, end: End, profile: Profile, u: V3, reach: number, centre: V3): Stop | undefined {
  switch (end.kind) {
    case 'length':
    case 'throughAll':
      return undefined;
    case 'toFace':
      return faceStop(ctx, end.face, scale(u, end.offset), centre, reach);
    case 'toBody': {
      const body = entityOf(ctx, end.body, 'the target body');
      if (body.kind !== 'body') throw new FeaturePause('the target body names something that is not a body');
      return { cutters: [ctx.ev.adapter.handleOf(body.key)], short: 'the profile runs past the target body' };
    }
    default: {
      const faces = targetFaces(ctx, (ctx.inputs.operation as Json).targets as Json);
      const face = rayFace(ctx, faces, centre, u, reach, end.kind === 'upToLast', sketchTolerance(profile.sketch));
      return stopAtFace(ctx, face, [0, 0, 0], centre, reach);
    }
  }
}

/** What the faces `faces` became in one step. */
function imagesOf(history: OperationHistory, faces: readonly ShapeKey[]): ShapeKey[] {
  const kept = new Set(history.faces.kept);
  return faces.flatMap((f) => history.faces.modified.get(f) ?? (kept.has(f) ? [f] : []));
}

/** One swept tool part way through its build: the shape, its walls and its caps. */
interface Swept extends Live {
  walls: ShapeKey[];
  first: ShapeKey[];
  last: ShapeKey[];
}

/** Follows a swept tool through one step. */
function after(history: OperationHistory, handle: ShapeHandle, s: Swept): Swept {
  return {
    shape: history.result,
    handle,
    walls: imagesOf(history, s.walls),
    first: imagesOf(history, s.first),
    last: imagesOf(history, s.last),
  };
}

interface Job {
  ctx: BuildContext;
  namer: FeatureNamer;
  profile: Profile;
  swept: SweptFace;
  dir: V3;
  tag: string;
}

/**
 * The face swept from `from` along the direction by `length` (negative runs
 * against it), named: walls after their curve, with `index(1)` closing the
 * `src` of the second side's own walls, and the caps by `caps`.
 */
function sweep(
  job: Job,
  face: ShapeHandle,
  from: number,
  length: number,
  caps: { first?: string; last: string },
  second: boolean,
): Swept {
  const { ctx, namer, profile, swept, dir, tag } = job;
  const { kernel: k, adapter } = ctx.ev;
  const moved = from !== 0 ? k.translate(face, ...(scale(dir, from) as V3)) : face;
  const part = second ? `${tag}:back` : tag;
  const profileRef = adapter.addShape(moved, `profile:${part}`);
  const v = scale(dir, length);
  const evolution = k.extrudeWithHistory(moved, v[0], v[1], v[2], adapter.faceHashes([profileRef]), HASH_BOUND);
  const history = adapter.sweepHistory(evolution, profileRef, `tool:${part}`);
  const region: SrcFact = { id: profile.regionId };
  const outputs: { entity: ShapeKey; role: string; src: SrcFact[] }[] = [];
  const walls: ShapeKey[] = [];
  for (const [edge, faces] of history.facesFromEdge) {
    const point = adapter.samplePoint(edge);
    if (!point) throw new FeaturePause('a profile edge has no sample point');
    // Look on the sketch plane, where the profile was drawn.
    const { role, root } = wallOf(ctx, profile, swept, add(point as V3, scale(dir, -from)));
    const segment = segmentOf(profile, root);
    const src: SrcFact[] = second ? [...segment, region, { index: 1 }] : [...segment, region];
    for (const wall of faces) outputs.push({ entity: wall, role, src });
    walls.push(...faces);
  }
  const first = [...(history.caps?.first ?? [])];
  const last = [...(history.caps?.last ?? [])];
  if (caps.first) for (const f of first) outputs.push({ entity: f, role: caps.first, src: [region] });
  for (const f of last) outputs.push({ entity: f, role: caps.last, src: [region] });
  namer.step(history, { outputs, dividers: [] });
  return { shape: history.result, handle: evolution.result, walls, first, last };
}

/** Cuts pieces of a swept tool away; the new faces, on what divided them off, are the cap `role` at its `far` end. */
function cutAway(
  job: Job,
  tool: Swept,
  pieces: readonly ShapeHandle[],
  far: 'first' | 'last',
  role: string,
  ref: string,
): Swept {
  const { ctx, namer, profile } = job;
  const { kernel: k, adapter } = ctx.ev;
  const cut = pieces.length === 1 ? (pieces[0] as ShapeHandle) : k.makeCompound([...pieces]);
  const cutRef = adapter.addShape(cut, ref);
  // Pieces of the stop on one surface (either side of a cylinder's seam) merge into one cap.
  const evolution = k.booleanOp(BooleanOp.Cut, [tool.handle], [cut], {
    simplifyAngularTolerance: REFINE_ANGLE,
    inputFaceHashes: adapter.faceHashes([tool.shape, cutRef]),
    hashUpperBound: HASH_BOUND,
  });
  const history = adapter.history(evolution, [
    { shape: tool.shape, use: 'target' },
    { shape: cutRef, use: 'tool' },
  ]);
  const fromTool = new Set(imagesOf(history, adapter.topology(tool.shape).faces));
  const caps = adapter.topology(history.result).faces.filter((f) => !fromTool.has(f));
  if (caps.length === 0) throw new FeaturePause('the stop left no cap on the extrude');
  namer.step(history, {
    outputs: caps.map((f) => ({ entity: f, role, src: [{ id: profile.regionId }] })),
    dividers: [],
  });
  const next = after(history, evolution.result, tool);
  return far === 'first' ? { ...next, first: caps } : { ...next, last: caps };
}

/**
 * Cuts a swept tool back to a stop: divided by the stop, it keeps the piece
 * holding `anchor` (the profile), which must no longer reach the `far` cap.
 * The new faces on the stop are the cap `role`.
 */
function trim(job: Job, tool: Swept, anchor: ShapeHandle, far: 'first' | 'last', stop: Stop, role: string): Swept {
  const { ctx, profile } = job;
  const { kernel: k, adapter } = ctx.ev;
  const tolerance = sketchTolerance(profile.sketch);
  for (const [i, cutter] of stop.cutters.entries()) {
    // A stop that meets the sketch is refused. A profile inside a solid stop is at distance 0 from it.
    if (k.distanceBetween(anchor, cutter) <= tolerance)
      throw new FeaturePause('the extrude stops at something that meets the profile');
    const pieces = k.getSubShapes(k.split(tool.handle, [cutter]), 'solid');
    const touching = pieces.map((p) => k.distanceBetween(p, anchor) <= tolerance);
    const near = pieces.filter((_, n) => touching[n]);
    const others = pieces.filter((_, n) => !touching[n]);
    if (near.length !== 1) throw new FeaturePause('the stop divides the profile');
    const reaches = tool[far].some((f) => k.distanceBetween(near[0] as ShapeHandle, adapter.handleOf(f)) <= tolerance);
    if (others.length === 0 || reaches) continue;
    return cutAway(job, tool, others, far, role, `stop:${job.tag}:${far}:${i}`);
  }
  throw new FeaturePause(stop.short);
}

/** Leans a tool's walls by `taper` degrees, pulled along `pull`, each keeping its section in the sketch plane moved `at` along the direction. */
function draft(job: Job, tool: Swept, taper: number, pull: V3, at: number): Swept {
  const { ctx, namer, profile, dir } = job;
  const { kernel: k, adapter } = ctx.ev;
  const { frame } = profile.sketch;
  const evolution = k.draftWithHistory(
    tool.handle,
    tool.walls.map((w) => adapter.handleOf(w)),
    (-taper * Math.PI) / 180,
    kv(pull),
    adapter.faceHashes([tool.shape]),
    HASH_BOUND,
    { origin: kv(add(frame.origin, scale(dir, at))), normal: kv(frame.normal) },
  );
  const history = adapter.history(evolution, [{ shape: tool.shape, use: 'target' }]);
  namer.step(history, { outputs: [], dividers: [] });
  return after(history, evolution.result, tool);
}

/** The profile's centre of mass moved `by` along the direction. */
function centreAt(job: Job, by: number): V3 {
  const c = job.ctx.ev.kernel.getSurfaceCenterOfMass(job.profile.face);
  return add([c.x, c.y, c.z], scale(job.dir, by));
}

/** A shape moved `by` along the direction. */
function moved(job: Job, shape: ShapeHandle, by: number): ShapeHandle {
  return by === 0 ? shape : job.ctx.ev.kernel.translate(shape, ...(scale(job.dir, by) as V3));
}

/** One swept face's tool, its profile moved `o` along the direction: one sweep through both sides, trimmed at its stops and drafted. */
function straightTool(job: Job, forward: Side, back: Side | undefined, reach: number, o: number): Live {
  const { ctx, profile, dir } = job;
  const lf = lengthOf(forward.end, reach);
  const lb = back ? lengthOf(back.end, reach) : 0;
  const face = job.swept.face;
  let tool = sweep(job, face, o - lb, lb + lf, { first: 'start', last: 'end' }, false);
  // The profile at its start, or the start cap when a negative second side moves the tool off it.
  const anchor = moved(job, face, lb >= 0 ? o : o - lb);
  const ahead = stopOf(ctx, forward.end, profile, dir, reach, centreAt(job, o));
  if (ahead) tool = trim(job, tool, anchor, 'last', ahead, 'end');
  const behind = back && stopOf(ctx, back.end, profile, scale(dir, -1), reach, centreAt(job, o));
  if (behind) tool = trim(job, tool, anchor, 'first', behind, 'start');
  if (forward.taper !== 0) tool = draft(job, tool, forward.taper, dir, o);
  return tool;
}

/** One swept face's tool with walls of its own on each side: each side swept from the profile moved `o`, trimmed and drafted, then the two joined. */
function splitTool(job: Job, forward: Side, back: Side, reach: number, o: number): Live {
  const { ctx, namer, dir } = job;
  const one = (side: Side, second: boolean): Swept => {
    const u = second ? scale(dir, -1) : dir;
    // The second side starts from a copy, so the two tools share no sub-shape.
    const face = second ? ctx.ev.kernel.copy(job.swept.face) : job.swept.face;
    const role = second ? 'start' : 'end';
    let tool = sweep(job, face, o, (second ? -1 : 1) * lengthOf(side.end, reach), { last: role }, second);
    const stop = stopOf(ctx, side.end, job.profile, u, reach, centreAt(job, o));
    if (stop) tool = trim(job, tool, moved(job, face, o), 'last', stop, role);
    return side.taper !== 0 ? draft(job, tool, side.taper, u, o) : tool;
  };
  const a = one(forward, false);
  const b = one(back, true);
  return namedBoolean(ctx, namer, 'fuse', a, b, 'target').live;
}

/**
 * A start surface seen along one line: the line through `point`, inside the
 * profile, along the direction. For each cutter (the face, then its whole
 * surface), where the line meets it and which meeting the start takes, as
 * distances along the direction from `point`.
 */
interface StartLine {
  point: V3;
  cutters: ShapeHandle[];
  crossings: number[][];
  at: (number | undefined)[];
  short: string;
}

/** A point inside a face: its centre of mass when that lies in it, otherwise its sample point. */
function insidePoint(job: Job, face: ShapeHandle): V3 {
  const { kernel: k, adapter } = job.ctx.ev;
  const c = k.getSurfaceCenterOfMass(face);
  if (k.distanceBetween(k.makeVertex(c.x, c.y, c.z), face) <= sketchTolerance(job.profile.sketch))
    return [c.x, c.y, c.z];
  const ref = adapter.addShape(face, `probe:${job.tag}`);
  const p = adapter.samplePoint(adapter.topology(ref).faces[0] as ShapeKey);
  if (!p) throw new FeaturePause('the profile has no point inside it');
  return p as V3;
}

/**
 * Where the line meets a start face: of the meetings, the nearest the sketch
 * plane ahead of it along the direction, or behind it when none is ahead.
 */
function startLine(job: Job, start: Extract<Start, { kind: 'surface' }>, reach: number): StartLine {
  const { ctx, dir } = job;
  const k = ctx.ev.kernel;
  const tolerance = sketchTolerance(job.profile.sketch);
  const point = insidePoint(job, job.swept.face);
  const stop = faceStop(ctx, start.ref, scale(dir, start.offset), point, reach);
  const span = 8 * reach;
  const line = k.makeLineEdge(kv(add(point, scale(dir, -span))), kv(add(point, scale(dir, span))));
  const crossings = stop.cutters.map((cutter) => {
    if (k.distanceBetween(line, cutter) > tolerance) return [];
    const ts = k
      .getSubShapes(k.section(line, cutter), 'vertex')
      .map((v) => {
        const p = k.vertexPosition(v);
        return dot(sub([p.x, p.y, p.z], point), dir);
      })
      .sort((a, b) => a - b);
    return ts.filter((t, i) => i === 0 || t - (ts[i - 1] as number) > tolerance);
  });
  // The offset moves the surface, not the choice of meeting.
  const at = crossings.map((ts) => ts.find((t) => t - start.offset >= -tolerance) ?? ts.at(-1));
  return { point, cutters: stop.cutters, crossings, at, short: 'the profile does not reach the start face' };
}

/** A start line with its surface moved `by` along the direction. */
function shiftedLine(job: Job, s: StartLine, by: number, short: string): StartLine {
  return {
    point: s.point,
    cutters: s.cutters.map((c) => moved(job, c, by)),
    crossings: s.crossings.map((ts) => ts.map((t) => t + by)),
    at: s.at.map((t) => (t === undefined ? undefined : t + by)),
    short,
  };
}

/**
 * Cuts a swept tool, `length` long each way of its start line's point, back
 * to a start surface: divided by the surface, it keeps what lies `keep` of
 * the meeting the line takes and drops the pieces holding the line's other
 * stretches. What it keeps must no longer reach the cap at that end.
 */
function surfaceTrim(
  job: Job,
  tool: Swept,
  s: StartLine,
  keep: 'ahead' | 'behind',
  length: number,
  role: string,
): Swept {
  const { ctx, dir, profile } = job;
  const { kernel: k, adapter } = ctx.ev;
  const tolerance = sketchTolerance(profile.sketch);
  const far = keep === 'ahead' ? 'first' : 'last';
  for (const [i, cutter] of s.cutters.entries()) {
    const cut = s.at[i];
    if (cut === undefined) continue;
    const ts = s.crossings[i] as number[];
    const dropped =
      keep === 'ahead'
        ? [-length, ...ts.filter((t) => t < cut - tolerance), cut]
        : [cut, ...ts.filter((t) => t > cut + tolerance), length];
    const probes = dropped.slice(1).map((t, n) => add(s.point, scale(dir, ((dropped[n] as number) + t) / 2)));
    const pieces = k.getSubShapes(k.split(tool.handle, [cutter]), 'solid');
    const drop = pieces.filter((p) => probes.some((q) => k.containsPoint(p, kv(q))));
    const kept = pieces.filter((p) => !drop.includes(p));
    if (drop.length === 0 || kept.length === 0) continue;
    if (kept.some((p) => tool[far].some((f) => k.distanceBetween(p, adapter.handleOf(f)) <= tolerance))) continue;
    return cutAway(job, tool, drop, far, role, `start:${job.tag}:${far}:${i}`);
  }
  throw new FeaturePause(s.short);
}

/**
 * One swept face's tool from a start surface: swept far both ways, cut back
 * to the surface (or the surface moved by the second side's distance), then
 * to the surface moved by the first side's distance or to its stop.
 */
function surfaceTool(
  job: Job,
  start: Extract<Start, { kind: 'surface' }>,
  forward: Side,
  back: Side | undefined,
  reach: number,
): Live {
  const { ctx, dir, profile } = job;
  const k = ctx.ev.kernel;
  const line = startLine(job, start, reach);
  const first = line.at.findIndex((t) => t !== undefined);
  if (first < 0) throw new FeaturePause(line.short);
  const furthest = Math.max(0, ...line.crossings.flat().map(Math.abs));
  const lf = lengthOf(forward.end, reach);
  const lb = back ? lengthOf(back.end, reach) : 0;
  const length = furthest + reach + Math.abs(lf) + Math.abs(lb);
  let tool = sweep(job, job.swept.face, -length, 2 * length, { first: 'start', last: 'end' }, false);
  const t = line.at[first] as number;
  const from = add(line.point, scale(dir, t));
  const stopped = (end: End) => end.kind !== 'length' && end.kind !== 'throughAll';
  // A stop is checked against the start, or against the back end when a negative second side moves it off the start.
  let anchor = k.makeVertex(...add(line.point, scale(dir, lb >= 0 ? t : t - lb)));
  if (!back) {
    tool = surfaceTrim(job, tool, line, 'ahead', length, 'start');
    anchor = k.makeCompound(tool.first.map((f) => ctx.ev.adapter.handleOf(f)));
  } else if (back.end.kind === 'length') {
    tool = surfaceTrim(
      job,
      tool,
      shiftedLine(job, line, -lb, 'the second side does not reach the start face'),
      'ahead',
      length,
      'start',
    );
  }
  if (forward.end.kind === 'length')
    tool = surfaceTrim(
      job,
      tool,
      shiftedLine(job, line, lf, 'the extrude does not reach the start face'),
      'behind',
      length,
      'end',
    );
  else if (stopped(forward.end))
    tool = trim(job, tool, anchor, 'last', stopOf(ctx, forward.end, profile, dir, length, from) as Stop, 'end');
  if (back && stopped(back.end))
    tool = trim(
      job,
      tool,
      anchor,
      'first',
      stopOf(ctx, back.end, profile, scale(dir, -1), length, from) as Stop,
      'start',
    );
  return tool;
}

/** Two opposite corners of a shape's box. */
function cornersOf(bounds: Bounds, handle: ShapeHandle): V3[] {
  const b = bounds(handle);
  return [
    [b.xmin, b.ymin, b.zmin],
    [b.xmax, b.ymax, b.zmax],
  ];
}

/**
 * Where a face, plane or body a side stops at or starts from lies, moved
 * `offset` along `u`: a plane where the line from `from` along `u` meets it,
 * anything else as its box. Nothing for a reference that does not resolve,
 * which pauses where the stop or start is built.
 */
function pointsOf(ctx: BuildContext, bounds: Bounds, ref: Json, what: string, from: V3, u: V3, offset: number): V3[] {
  const shift = (p: V3) => add(p, scale(u, offset));
  const onPlane = (frame: Frame | undefined): V3[] => {
    const along = frame ? dot(frame.normal, u) : 0;
    if (!frame || Math.abs(along) <= PARALLEL) return [];
    return [shift(add(from, scale(u, dot(frame.normal, sub(frame.origin, from)) / along)))];
  };
  try {
    if ('standard' in ref) return onPlane(STANDARD[(ref.standard as Json).name as string]);
    const output = constructionOf(ctx, ref);
    if (output) return output.kind === 'plane' ? onPlane(output.frame) : [];
    return cornersOf(bounds, ctx.ev.adapter.handleOf(entityOf(ctx, ref, what).key)).map(shift);
  } catch (e) {
    if (e instanceof FeaturePause) return [];
    throw e;
  }
}

/**
 * How far a side may have to sweep from one swept face, moved `shift` along
 * the direction: twice the size of the box holding every live body, the face
 * and whatever its sides stop at or it starts from, so a side passes all of
 * them wherever the profile lies.
 */
function reachFrom(
  ctx: BuildContext,
  bounds: Bounds,
  face: ShapeHandle,
  shift: number,
  dir: V3,
  sides: [Side, Side | undefined],
  start: Start,
): number {
  const corners = cornersOf(bounds, face).map((p) => add(p, scale(dir, shift)));
  const centre = scale(add(corners[0] as V3, corners[1] as V3), 0.5);
  const points = [...corners, ...[...ctx.part.shapes.values()].flatMap((h) => cornersOf(bounds, h))];
  sides.forEach((side, i) => {
    const u = i === 0 ? dir : scale(dir, -1);
    if (side?.end.kind === 'toFace')
      points.push(...pointsOf(ctx, bounds, side.end.face, 'the target face', centre, u, side.end.offset));
    if (side?.end.kind === 'toBody')
      points.push(...pointsOf(ctx, bounds, side.end.body, 'the target body', centre, u, 0));
  });
  if (start.kind === 'surface')
    points.push(...pointsOf(ctx, bounds, start.ref, 'the start face', centre, dir, start.offset));
  const span = [0, 1, 2].map(
    (axis) => Math.max(...points.map((p) => p[axis] as number)) - Math.min(...points.map((p) => p[axis] as number)),
  );
  return 2 * Math.hypot(...span) + 1;
}

/** The size of a face's box plus its furthest coordinate. */
function farOf(bounds: Bounds, face: ShapeHandle): number {
  const b = bounds(face);
  const far = Math.max(...[b.xmin, b.xmax, b.ymin, b.ymax, b.zmin, b.zmax].map(Math.abs));
  return Math.hypot(b.xmax - b.xmin, b.ymax - b.ymin, b.zmax - b.zmin) + far;
}

registerBuilder('core.extrude', (ctx) => {
  const { inputs, id, ordinal } = ctx;
  const { adapter, names } = ctx.ev;
  const thin = thinOf(ctx, inputs.thin as Json);
  const { forward, back } = sidesOf(ctx, inputs.sides as Json[]);
  // Only a side that does not end at its distance, or a start on a surface, needs the bodies' extent.
  const lf = lengthOf(forward.end, Infinity);
  const lb = back ? lengthOf(back.end, Infinity) : 0;
  if (lf <= 0) throw new FeaturePause('the first side of an extrude runs a positive distance');
  if (lb + lf <= 0) throw new FeaturePause('the extrude has no length');
  const tb = back?.taper ?? 0;
  const tapered = forward.taper !== 0 || tb !== 0;
  const start = inputs.start as Json | undefined;
  if (thin && tapered) throw new FeaturePause('tapered thin extrudes are not built yet');
  if (tapered && lb < 0) throw new FeaturePause('a tapered extrude with a negative second side is not built yet');
  const dir = directionOf(ctx, inputs.direction as Json);
  // The walls run straight through the sketch plane unless the two tapers lean differently.
  const split = back !== undefined && lb !== 0 && tb !== -forward.taper;
  const stopped = [forward, back].some(
    (s) => s !== undefined && s.end.kind !== 'length' && s.end.kind !== 'throughAll',
  );
  const distances = [forward, back].every((s) => s === undefined || s.end.kind === 'length');
  let bounds: Bounds | undefined;
  let all: number | undefined;
  const reachBounds = () => (bounds ??= boundsOf(ctx, reachOnlyBounds(ctx, forward, back)));
  const throughAllOnce = () => (all ??= throughAll(ctx, reachBounds()));

  const namer = startFeature(ctx.part.state, { feature: id, ordinal }, adapter, names);
  const tools: Tool[] = [];
  buildProfiles(ctx, inputs.profiles as Json).forEach((profile, n) => {
    const from = startOf(ctx, start, profile, dir);
    if (from.kind === 'surface' && tapered)
      throw new FeaturePause('a tapered extrude from a face not parallel to its sketch is not built yet');
    sweptFaces(ctx, profile, thin).forEach((swept, m) => {
      const job: Job = { ctx, namer, profile, swept, dir, tag: `${id}:${n}:${m}` };
      // A stop or a start may lie past the bodies, beyond the profile; a stopped side sweeps past both.
      const shift = from.kind === 'shift' ? from.by : 0;
      // Sides that end at their distances from the sketch plane, or an offset of it, sweep no further: no reach.
      let reach = 0;
      if (!distances || from.kind === 'surface') {
        const near =
          (stopped || from.kind === 'surface'
            ? throughAllOnce() + 2 * farOf(reachBounds(), swept.face)
            : throughAllOnce()) + Math.abs(shift);
        reach = Math.max(near, reachFrom(ctx, reachBounds(), swept.face, shift, dir, [forward, back], from));
      }
      let tool: Live;
      if (from.kind === 'surface') tool = surfaceTool(job, from, forward, back, reach);
      else if (split && back) tool = splitTool(job, forward, back, reach, shift);
      else tool = straightTool(job, forward, back, reach, shift);
      tools.push({ shape: tool.shape, handle: tool.handle, src: [{ id: profile.regionId }] });
    });
  });
  applyOperation(ctx, namer, tools, inputs.operation as Json);
});
