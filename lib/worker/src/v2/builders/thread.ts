/**
 * `core.thread` (appendix A) and the thread of a `core.hole`. A cosmetic
 * thread changes no geometry: it is the feature's own output, data on the faces it threads (`PartResult.threads`), and the
 * faces keep their names. A modelled thread cuts the ISO 68-1 groove into
 * the body, and refuses a result that did not lose the groove's volume.
 */
import { OcctError, type ThreadGroove } from 'occt-wasm';
import {
  finest,
  startFeature,
  type EntityKey,
  type FeatureNamer,
  type NamedEntity,
  type ShapeKey,
  type ShapeRef,
  type SrcFact,
} from '@tweakcad/format';
import {
  FLAG,
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
  type CosmeticThread,
  type Json,
  type V3,
} from '../context';
import { divide, madeHistory, namedBoolean, type Live } from '../operation';
import { entitiesOf } from '../references';
import { isInternalClass, threadSize, type ThreadSize } from '../threadTable';

/** Lengths and diameters agree within this (mm). */
const TOLERANCE = 1e-6;

export interface ThreadSpec {
  standard: string;
  class: string;
  internal: boolean;
  size: ThreadSize;
  modelled: boolean;
  /** A left-handed thread; absent or false, right-handed. */
  leftHand?: boolean;
}

const HAND = { type: 'choice', options: ['right', 'left'] } as const;

/** The standard, designation, class, modelled flag and hand of a thread, checked against the standard's table. */
export function threadSpec(ctx: BuildContext, t: Json): ThreadSpec {
  const { values } = ctx.ev;
  const standard = values.literal(t.standard, TEXT) as string;
  const cls = values.literal(t.class, TEXT) as string;
  const size = threadSize(standard, values.literal(t.designation, TEXT) as string);
  const leftHand = t.hand !== undefined && values.literal(t.hand, HAND) === 'left';
  return {
    standard,
    class: cls,
    internal: isInternalClass(cls),
    size,
    modelled: values.literal(t.modelled, FLAG) === true,
    leftHand,
  };
}

/** The x direction the kernel gives a frame made from its origin and z alone (OCCT's `gp_Ax3(P, V)`): angle 0 of a groove. */
export function kernelX(z: V3): V3 {
  const [a, b, c] = z;
  const [ax, bx, cx] = [Math.abs(a), Math.abs(b), Math.abs(c)];
  let x: V3;
  if (bx <= ax && bx <= cx) x = ax > cx ? [-c, 0, a] : [c, 0, -a];
  else if (ax <= bx && ax <= cx) x = bx > cx ? [0, -c, b] : [0, c, -b];
  else x = ax > bx ? [-b, a, 0] : [b, -a, 0];
  return unit(x);
}

/** The cylinder the faces share: its axis and radius. Pauses for faces that are not one coaxial cylinder. */
function cylinderOf(ctx: BuildContext, faces: readonly NamedEntity[]): { origin: V3; axis: V3; radius: number } {
  const { adapter } = ctx.ev;
  let found: { origin: V3; axis: V3; radius: number } | undefined;
  for (const face of faces) {
    const { surface } = adapter.faceGeometry(face.key);
    if (surface.kind !== 'cylinder') throw new FeaturePause('a threaded face is not cylindrical');
    const here = {
      origin: [...surface.origin] as V3,
      axis: unit([...surface.axis] as V3),
      radius: surface.radii[0] as number,
    };
    if (!found) {
      found = here;
      continue;
    }
    const off = sub(here.origin, found.origin);
    const across = norm(sub(off, scale(found.axis, dot(off, found.axis))));
    if (
      Math.abs(Math.abs(dot(here.axis, found.axis)) - 1) > 1e-9 ||
      across > TOLERANCE ||
      Math.abs(here.radius - found.radius) > TOLERANCE
    ) {
      throw new FeaturePause('the threaded faces are not one cylinder');
    }
  }
  if (!found) throw new FeaturePause('a thread has no face');
  return found;
}

/** The range the faces' vertices span along `axis` from `origin`. */
function axialRange(ctx: BuildContext, faces: readonly NamedEntity[], origin: V3, axis: V3): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const face of faces) {
    for (const p of ctx.ev.adapter.measures(face.key).vertices ?? []) {
      const t = dot(sub([...p] as V3, origin), axis);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
  }
  return [lo, hi];
}

/** Whether the faces are a hole's (their outward normal points at the axis) rather than a shaft's. */
function isHole(ctx: BuildContext, face: NamedEntity, origin: V3, axis: V3): boolean {
  const { adapter } = ctx.ev;
  const sample = adapter.samplePoint(face.key);
  if (sample === null) throw new FeaturePause('a threaded face has no sample point');
  const p = [...sample] as V3;
  const onAxis = add(origin, scale(axis, dot(sub(p, origin), axis)));
  const sign = adapter.side(add(onAxis, scale(sub(p, onAxis), 0.5)), face.key, 'normal');
  if (sign === null || sign === 0) throw new FeaturePause('a threaded face has no defined side');
  return sign === 1;
}

/** Where along the axis the groove's centre sits at angle 0, in pitches: off the seams a cylinder tends to have. */
const PHASE = 0.137;

/** A removed volume agrees with the groove's within this, relative. */
const VOLUME_MATCH = 1e-4;

/**
 * The groove of an ISO 68-1 thread in a cylinder of `radius`. The basic
 * profile's flanks run from the minor to the major radius, a flat of P/8
 * at the major one inside a nut and P/4 at the minor one on a bolt; a cylinder
 * between the two takes the part of the groove it reaches.
 */
export function grooveOf(spec: ThreadSpec, radius: number, length: number): ThreadGroove {
  const { pitch, major } = spec.size;
  const big = major / 2;
  const small = big - (5 * Math.sqrt(3) * pitch) / 16;
  if (spec.internal ? radius >= big - TOLERANCE : radius <= small + TOLERANCE)
    throw new FeaturePause(`an ${spec.size.designation} thread has no groove in a face of diameter ${2 * radius} mm`);
  const across = (radius - small) / (big - small);
  const common = { pitch, length, coverRadius: radius, phase: PHASE * pitch };
  return spec.internal
    ? {
        ...common,
        rootRadius: big,
        rootHalfWidth: pitch / 16,
        coverHalfWidth: (3 * pitch) / 8 + across * (pitch / 16 - (3 * pitch) / 8),
      }
    : {
        ...common,
        rootRadius: small,
        rootHalfWidth: pitch / 8,
        coverHalfWidth: pitch / 8 + across * ((7 * pitch) / 16 - pitch / 8),
      };
}

/** The groove's volume: its trapezoid swept round its centroid, as many turns as its length holds. */
export function grooveVolume(g: ThreadGroove): number {
  const r = [g.coverRadius, g.rootRadius, g.rootRadius, g.coverRadius] as const;
  const z = [-g.coverHalfWidth, -g.rootHalfWidth, g.rootHalfWidth, g.coverHalfWidth] as const;
  let area = 0;
  let moment = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const cross = (r[i] as number) * (z[j] as number) - (r[j] as number) * (z[i] as number);
    area += cross;
    moment += ((r[i] as number) + (r[j] as number)) * cross;
  }
  return Math.abs(area / 2) * 2 * Math.PI * (moment / (3 * area)) * (g.length / g.pitch);
}

/** What the kernel lists, in its order: the groove's strips, each in patches, then its two ends. */
const STRIPS = ['cover', 'flankLow', 'root', 'flankHigh'] as const;

function grooveOutputs(
  ctx: BuildContext,
  shape: ShapeRef,
  tag: string,
): { entity: ShapeKey; role: string; src: SrcFact[] }[] {
  const { adapter } = ctx.ev;
  const ends = ['start', 'end'];
  let strip = -1;
  let index = 0;
  let last: string | undefined;
  return adapter.topology(shape).faces.map((entity) => {
    const { surface } = adapter.measures(entity);
    if (surface === 'plane') return { entity, role: ends.shift() as string, src: [{ id: tag }] };
    if (surface !== last) {
      strip += 1;
      index = 0;
      last = surface;
    }
    return { entity, role: STRIPS[strip] as string, src: [{ id: tag }, { index: index++ }] };
  });
}

/** A thread's place on its cylinder, as `CosmeticThread` gives it. */
export interface ThreadRun {
  start: V3;
  direction: V3;
  length: number;
  radius: number;
}

/**
 * The groove of `run` cut out of `body`, named as steps of `namer`. A body
 * with material all round the groove must lose exactly its volume; where
 * something else already took part of it, what is left of the groove must go.
 */
export function cutThread(
  ctx: BuildContext,
  namer: FeatureNamer,
  body: Live,
  spec: ThreadSpec,
  run: ThreadRun,
  tag: string,
): Live {
  const { kernel: k, adapter } = ctx.ev;
  const groove = grooveOf(spec, run.radius, run.length);
  const [ox, oy, oz] = run.start;
  const [dx, dy, dz] = run.direction;
  const before = k.getVolume(body.handle);
  try {
    const right = k.threadGroove({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }, groove);
    // A left-handed groove is the right-handed one reflected in a plane through the axis, the one holding angle 0, so it starts as the right-handed one does.
    const handle = spec.leftHand
      ? k.mirror(right, { x: ox, y: oy, z: oz }, kv(cross(run.direction, kernelX(run.direction))))
      : right;
    if (handle !== right) k.release(right);
    const shape = adapter.addShape(handle, `thread:${tag}`);
    const outputs = grooveOutputs(ctx, shape, tag);
    namer.step(madeHistory(ctx, shape), { outputs, dividers: [] });
    // Telling each piece of the cylinder from every face of a long groove costs more than the cut.
    const flank = outputs
      .filter((o) => o.role === 'flankLow')
      .map((o) => o.entity)
      .slice(0, 2);
    const { live } = namedBoolean(ctx, namer, 'cut', body, { shape, handle }, 'tool', flank);
    const removed = before - k.getVolume(live.handle);
    const near = (expected: number) => Math.abs(removed - expected) <= VOLUME_MATCH * expected;
    if (
      !k.isValid(live.handle) ||
      !(near(grooveVolume(groove)) || near(k.getVolume(k.intersect(body.handle, handle))))
    ) {
      throw new FeaturePause('the kernel could not cut this thread into the body');
    }
    return live;
  } catch (e) {
    if (e instanceof OcctError)
      throw new FeaturePause(`the kernel could not cut this thread into the body: ${e.message}`);
    throw e;
  }
}

/** The body holding `face`, as a shape of its own. */
export function bodyOf(ctx: BuildContext, namer: FeatureNamer, face: NamedEntity): Live {
  const { part, ev } = ctx;
  const solids = ev.adapter.topology(face.body).solids;
  if (solids.length > 1) {
    const holder = solids.find((s) => s.faces.includes(face.key));
    const live = holder && divide(ctx, namer, face.body).get(holder.solid);
    if (!live) throw new FeaturePause('a threaded face is not on a solid');
    return live;
  }
  const handle = part.shapes.get(face.body);
  if (handle === undefined) throw new FeaturePause('a threaded face is not on a live body');
  return { shape: face.body, handle };
}

/** Puts what `cuts` made of each body back in the part, and finishes the feature's names. */
export function finishThreads(ctx: BuildContext, namer: FeatureNamer, cuts: ReadonlyMap<ShapeRef, Live>): void {
  const { part, ev } = ctx;
  const outcomes = [...cuts].flatMap(([from, live]) => {
    part.shapes.delete(from);
    const { solids } = ev.adapter.topology(live.shape);
    if (solids.length > 0) part.shapes.set(live.shape, live.handle);
    return solids.map((s) => ({ solid: s.solid, from: { carry: [from] } }));
  });
  part.state = namer.finish(outcomes);
}

const keyOf = (e: NamedEntity): EntityKey => ({ hash: finest(e.ladder), branch: e.branch });

/**
 * A cosmetic thread on `faces`, which must be one cylinder of the size's
 * diameter range and of the class's kind (a capital class in a hole).
 * `from` gives where a partial thread starts; the whole faces otherwise.
 */
export function cosmeticThread(
  ctx: BuildContext,
  spec: ThreadSpec,
  faces: readonly NamedEntity[],
  partial?: { length: number; from: V3 },
): CosmeticThread {
  const { size } = spec;
  const cylinder = cylinderOf(ctx, faces);
  const diameter = 2 * cylinder.radius;
  if (diameter < size.minor - TOLERANCE || diameter > size.major + TOLERANCE) {
    throw new FeaturePause(`an ${size.designation} thread does not fit a face of diameter ${diameter} mm`);
  }
  const hole = isHole(ctx, faces[0] as NamedEntity, cylinder.origin, cylinder.axis);
  if (hole !== spec.internal) {
    throw new FeaturePause(
      hole
        ? `class ${spec.class} is for a shaft's thread, and the face is a hole`
        : `class ${spec.class} is for a hole's thread, and the face is a shaft`,
    );
  }
  const [lo, hi] = axialRange(ctx, faces, cylinder.origin, cylinder.axis);
  if (!(hi > lo)) throw new FeaturePause('a threaded face has no length along its axis');
  if (!partial)
    return threadRecord(spec, faces, add(cylinder.origin, scale(cylinder.axis, lo)), cylinder.axis, hi - lo);
  const t = dot(sub(partial.from, cylinder.origin), cylinder.axis);
  const atLo = Math.abs(t - lo) <= TOLERANCE;
  if (!atLo && Math.abs(t - hi) > TOLERANCE) throw new FeaturePause('a thread starts at an end of its faces');
  if (partial.length <= 0 || partial.length > hi - lo + TOLERANCE)
    throw new FeaturePause('the thread is longer than its faces or has no length');
  return atLo
    ? threadRecord(spec, faces, add(cylinder.origin, scale(cylinder.axis, lo)), cylinder.axis, partial.length)
    : threadRecord(
        spec,
        faces,
        add(cylinder.origin, scale(cylinder.axis, hi)),
        scale(cylinder.axis, -1),
        partial.length,
      );
}

/**
 * A hole's thread on its bore, the whole length of the bore from where it
 * starts along `axis`, the hole's direction into the material. Never pauses.
 */
export function boreThread(
  ctx: BuildContext,
  spec: ThreadSpec,
  bores: readonly NamedEntity[],
  at: V3,
  axis: V3,
): CosmeticThread {
  const [lo, hi] = axialRange(ctx, bores, at, axis);
  return threadRecord(spec, bores, add(at, scale(axis, lo)), axis, Math.max(hi - lo, 0));
}

function threadRecord(
  spec: ThreadSpec,
  faces: readonly NamedEntity[],
  start: V3,
  direction: V3,
  length: number,
): CosmeticThread {
  const { size } = spec;
  return {
    faces: faces.map(keyOf),
    standard: spec.standard,
    designation: size.designation,
    class: spec.class,
    internal: spec.internal,
    pitch: size.pitch,
    major: size.major,
    pitchDiameter: size.pitchDiameter,
    minor: size.minor,
    start,
    direction,
    length,
    ...(spec.leftHand ? { hand: 'left' as const } : {}),
  };
}

function resolved(ctx: BuildContext, ref: Json, what: string): NamedEntity[] {
  if ('inContext' in ref) throw new FeaturePause(`${what} lies in another part`);
  return entitiesOf(ctx, ref, what);
}

/** Where a partial thread starts: the centre of a circular edge of one of its faces. */
function startOf(ctx: BuildContext, ref: Json, faces: readonly NamedEntity[]): V3 {
  const { adapter } = ctx.ev;
  const [edge, ...more] = resolved(ctx, ref, 'the edge a thread starts at');
  if (!edge || more.length > 0 || edge.kind !== 'edge') throw new FeaturePause('a thread starts at one edge');
  const keys = new Set<ShapeKey>(faces.map((f) => f.key));
  const bounds = adapter
    .topology(edge.body)
    .edges.find((e) => e.edge === edge.key)
    ?.faces.some((f) => keys.has(f.face));
  if (!bounds) throw new FeaturePause('the edge a thread starts at does not bound a threaded face');
  const { curve } = adapter.edgeGeometry(edge.key);
  if (curve.kind !== 'circle') throw new FeaturePause('the edge a thread starts at is not a circle');
  return [...curve.center] as V3;
}

registerBuilder('core.thread', (ctx) => {
  const { inputs, id, ordinal, part } = ctx;
  const { adapter, names, values } = ctx.ev;
  const spec = threadSpec(ctx, inputs);
  const faces = ((inputs.faces as Json).set as Json[]).flatMap((ref) => resolved(ctx, ref, 'a threaded face'));
  if (faces.some((f) => f.kind !== 'face')) throw new FeaturePause('a threaded entity is not a face');
  const length = inputs.length as Json;
  const partial =
    'distance' in length
      ? {
          length: values.number((length.distance as Json).d, LENGTH),
          from: startOf(ctx, (length.distance as Json).from as Json, faces),
        }
      : undefined;
  const thread = cosmeticThread(ctx, spec, faces, partial);
  if (!spec.modelled) {
    part.threads.set(id, [thread]);
    return;
  }
  const namer = startFeature(part.state, { feature: id, ordinal }, adapter, names);
  const body = bodyOf(ctx, namer, faces[0] as NamedEntity);
  const live = cutThread(ctx, namer, body, spec, { ...thread, radius: cylinderOf(ctx, faces).radius }, id);
  finishThreads(ctx, namer, new Map([[body.shape, live]]));
});
