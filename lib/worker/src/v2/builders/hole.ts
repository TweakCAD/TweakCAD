/**
 * `core.hole` (appendix A): one tool per position, stacked from cylinders and
 * cones along the hole's axis. Every tool face is named after its position
 * when made; history carries the names through the tool's fuse and the cut.
 */
import type { ShapeHandle } from 'occt-wasm';
import {
  finest,
  idItem,
  ladderOf,
  startFeature,
  type FeatureNamer,
  type NamedEntity,
  type ShapeRef,
} from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import {
  ANGLE,
  FeaturePause,
  LENGTH,
  LENGTH_VECTOR,
  add,
  dot,
  registerBuilder,
  scale,
  sub,
  type BuildContext,
  type Frame,
  type Json,
  type V3,
} from '../context';
import { madeHistory, runOperation, type Live, type Tool } from '../operation';
import { entityOf, faceFrameOf, frameOf, pointAt } from '../places';
import { entitiesOf } from '../references';
import { lift } from '../profiles';
import { bodyOf, boreThread, cutThread, finishThreads, threadSpec } from './thread';

const KIND = { type: 'choice', options: ['simple', 'counterbore', 'countersink'] } as const;

/** Part-frame axes within this angle of a face's normal are not projected onto it (7.3 `plane`). */
/** What every position of a hole shares; depths run from the placement plane into the material. */
interface HoleShape {
  radius: number;
  /** Null: through all, worked out per position. */
  depth: number | null;
  /** Height of the angled tip past `depth`. Null: a flat tip. */
  tip: number | null;
  counterbore: { radius: number; depth: number } | null;
  countersink: { radius: number; height: number } | null;
}

/** One solid of a tool, `z0` to `z1` along the axis. */
interface Piece {
  make: (height: number) => ShapeHandle;
  z0: number;
  z1: number;
  role: string;
  /** The face at `z1`, when it has a role of its own. */
  endRole?: string;
}

/**
 * A position on the placement plane. A vector is in the placement frame; a
 * referenced point is in the part. Either is projected along the normal.
 */
function pointOn(ctx: BuildContext, frame: Frame, point: Json): V3 {
  if ('at' in point) {
    const v = ctx.ev.values.literal((point.at as Json).v, LENGTH_VECTOR) as V3;
    return lift(frame, [v[0], v[1]]);
  }
  const p = pointAt(ctx, (point.of as Json).ref as Json);
  return sub(p, scale(frame.normal, dot(sub(p, frame.origin), frame.normal)));
}

type V2 = [number, number];

/** A point in the placement frame's plane. */
const inPlane = (frame: Frame, p: V3): V2 => [dot(sub(p, frame.origin), frame.x), dot(sub(p, frame.origin), frame.y)];

/**
 * The line of a reference edge in the face's plane, `inward` the unit
 * normal to it that points into the face beside the edge's middle.
 * Pauses for an edge that is gone, curved or not an edge of the face.
 */
function edgeLine(ctx: BuildContext, frame: Frame, face: NamedEntity, ref: Json): { point: V2; inward: V2 } {
  const { adapter, kernel: k } = ctx.ev;
  if ('inContext' in ref) throw new FeaturePause('a hole reference edge lies in another part');
  const found = entitiesOf(ctx, ref, 'a hole reference edge');
  const edge = found[0];
  if (found.length !== 1 || edge?.kind !== 'edge')
    throw new FeaturePause('a hole reference names something that is not one edge');
  const bounds = adapter
    .topology(face.body)
    .edges.find((e) => e.edge === edge.key)
    ?.faces.some((f) => f.face === face.key);
  if (!bounds) throw new FeaturePause('a hole reference edge is not an edge of the hole face');
  const geometry = adapter.edgeGeometry(edge.key);
  if (geometry.curve.kind !== 'line') throw new FeaturePause('a hole reference edge is not straight');
  const [a, b] = [inPlane(frame, geometry.start as V3), inPlane(frame, geometry.end as V3)];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length <= 0) throw new FeaturePause('a hole reference edge has no length');
  const normal: V2 = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
  const middle: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const handle = adapter.handleOf(face.key);
  const onFace = (sign: number): boolean => {
    const step = 1e-3 * length * sign;
    const probe = lift(frame, [middle[0] + step * normal[0], middle[1] + step * normal[1]]);
    const { u, v } = k.uvFromPoint(handle, { x: probe[0], y: probe[1], z: probe[2] });
    return k.classifyPointOnFace(handle, u, v) === 'in';
  };
  const [ahead, behind] = [onFace(1), onFace(-1)];
  if (ahead === behind) throw new FeaturePause('the hole face is not on one side of a reference edge');
  return { point: a, inward: ahead ? normal : [-normal[0], -normal[1]] };
}

/**
 * A position on the placement plane. A vector is in the placement frame; a
 * referenced point is in the part. Either is projected along the normal.
 * With `from`, the position then lies each distance from its edge's line,
 * on the face's side: one edge sets the coordinate across it, two set both.
 */
function positionOf(ctx: BuildContext, frame: Frame, face: NamedEntity | null, row: Json): V3 {
  const at = pointOn(ctx, frame, row.at as Json);
  const from = row.from as Json[] | undefined;
  if (from === undefined) return at;
  if (!face) throw new FeaturePause('a hole measured from edges is placed on a face');
  const lines = from.map((f) => {
    const line = edgeLine(ctx, frame, face, f.edge as Json);
    // The position lies on the line `inward · p = c`.
    return {
      inward: line.inward,
      c: ctx.ev.values.number(f.d, LENGTH) + line.inward[0] * line.point[0] + line.inward[1] * line.point[1],
    };
  });
  const [p0, p1] = inPlane(frame, at);
  const [first, second] = lines as [(typeof lines)[number], (typeof lines)[number] | undefined];
  if (!second) {
    const off = first.c - (first.inward[0] * p0 + first.inward[1] * p1);
    return lift(frame, [p0 + off * first.inward[0], p1 + off * first.inward[1]]);
  }
  const [n, m] = [first.inward, second.inward];
  const det = n[0] * m[1] - n[1] * m[0];
  if (Math.abs(det) < 1e-9) throw new FeaturePause('the two hole reference edges are parallel');
  return lift(frame, [(first.c * m[1] - second.c * n[1]) / det, (n[0] * second.c - m[0] * first.c) / det]);
}

/** A cone's height from a radius to its apex, or between two radii, at a full angle in degrees. */
function coneHeight(radius: number, degrees: number): number {
  if (degrees <= 0 || degrees >= 180) throw new FeaturePause('a hole cone angle lies between 0 and 180 degrees');
  return radius / Math.tan((degrees * Math.PI) / 360);
}

/** The hole's sizes; `drilled` replaces the radius `diameter` gives (a tapped hole's tap drill). */
function shapeOf(ctx: BuildContext, drilled?: number): HoleShape {
  const { inputs } = ctx;
  const { values } = ctx.ev;
  const radius = drilled ?? values.number(inputs.diameter, LENGTH) / 2;
  if (radius <= 0) throw new FeaturePause('the hole has no diameter');

  const extent = inputs.depth as Json;
  let depth: number | null = null;
  if ('distance' in extent) {
    depth = values.number((extent.distance as Json).d, LENGTH);
    if (depth <= 0) throw new FeaturePause('the hole has no depth');
  } else if (!('throughAll' in extent)) throw new FeaturePause('this hole depth is not built yet');

  const tipInput = inputs.tip as Json;
  const tip =
    depth !== null && 'angle' in tipInput ? coneHeight(radius, values.number((tipInput.angle as Json).a, ANGLE)) : null;

  const kind = values.literal(inputs.kind, KIND);
  let counterbore: HoleShape['counterbore'] = null;
  let countersink: HoleShape['countersink'] = null;
  if (kind === 'counterbore') {
    const c = inputs.counterbore as Json | undefined;
    if (!c) throw new FeaturePause('a counterbore hole needs its counterbore sizes');
    counterbore = { radius: values.number(c.diameter, LENGTH) / 2, depth: values.number(c.depth, LENGTH) };
    if (counterbore.radius <= radius) throw new FeaturePause('the counterbore is not wider than the hole');
    if (counterbore.depth <= 0) throw new FeaturePause('the counterbore has no depth');
  } else if (kind === 'countersink') {
    const c = inputs.countersink as Json | undefined;
    if (!c) throw new FeaturePause('a countersink hole needs its countersink sizes');
    const wide = values.number(c.diameter, LENGTH) / 2;
    if (wide <= radius) throw new FeaturePause('the countersink is not wider than the hole');
    countersink = { radius: wide, height: coneHeight(wide - radius, values.number(c.angle, ANGLE)) };
  }
  return { radius, depth, tip, counterbore, countersink };
}

/** Far enough along `axis` from `at` to pass every live body. */
function throughAll(ctx: BuildContext, at: V3, axis: V3): number {
  let far = 0;
  for (const handle of ctx.part.shapes.values()) {
    const b = ctx.ev.kernel.getBoundingBox(handle);
    for (const x of [b.xmin, b.xmax]) {
      for (const y of [b.ymin, b.ymax]) {
        for (const z of [b.zmin, b.zmax]) far = Math.max(far, dot(sub([x, y, z], at), axis));
      }
    }
  }
  if (far <= 0) throw new FeaturePause('a through-all hole points away from every body');
  return far + 1;
}

/** The solids of one position's tool, the axis running into the material from 0. */
function piecesOf(ctx: BuildContext, shape: HoleShape, depth: number): Piece[] {
  const k = ctx.ev.kernel;
  const { radius, counterbore, countersink, tip } = shape;
  const start = counterbore?.depth ?? countersink?.height ?? 0;
  if (start >= depth) throw new FeaturePause('the hole is not deeper than its counterbore or countersink');
  const pieces: Piece[] = [];
  if (counterbore) {
    pieces.push({ make: (h) => k.makeCylinder(counterbore.radius, h), z0: 0, z1: start, role: 'counterbore' });
  }
  if (countersink) {
    pieces.push({ make: (h) => k.makeCone(countersink.radius, radius, h), z0: 0, z1: start, role: 'countersink' });
  }
  const flat = shape.depth !== null && tip === null;
  pieces.push({
    make: (h) => k.makeCylinder(radius, h),
    z0: start,
    z1: depth,
    role: 'bore',
    ...(flat ? { endRole: 'tip' } : {}),
  });
  if (tip !== null) pieces.push({ make: (h) => k.makeCone(radius, 0, h), z0: depth, z1: depth + tip, role: 'tip' });
  return pieces;
}

/** Builds one position's tool, each solid named as it is made, then fused along the axis. */
function toolAt(
  ctx: BuildContext,
  namer: FeatureNamer,
  shape: HoleShape,
  frame: Frame,
  at: V3,
  position: string,
): Tool {
  const { kernel: k, adapter } = ctx.ev;
  const axis = scale(frame.normal, -1);
  const y = scale(frame.y, -1);
  const depth = shape.depth ?? throughAll(ctx, at, axis);
  let tool: { shape: ShapeRef; handle: ShapeHandle } | null = null;
  piecesOf(ctx, shape, depth).forEach((piece, n) => {
    const local = piece.make(piece.z1 - piece.z0);
    const base = add(at, scale(axis, piece.z0));
    const handle = k.transform(local, [
      frame.x[0],
      y[0],
      axis[0],
      base[0],
      frame.x[1],
      y[1],
      axis[1],
      base[1],
      frame.x[2],
      y[2],
      axis[2],
      base[2],
    ]);
    k.release(local);
    const ref = adapter.addShape(handle, `hole:${ctx.id}:${position}:${n}`);
    const history = madeHistory(ctx, ref);
    const end = add(at, scale(axis, piece.z1));
    const outputs = adapter.topology(ref).faces.map((entity) => {
      const m = adapter.measures(entity);
      const isEnd = m.surface === 'plane' && Math.abs(dot(sub(m.centroid as V3, end), axis)) < 1e-9;
      return { entity, role: isEnd && piece.endRole ? piece.endRole : piece.role, src: [{ id: position }] };
    });
    namer.step(history, { outputs, dividers: [] });
    if (!tool) {
      tool = { shape: ref, handle };
      return;
    }
    const evolution = k.fuseWithHistory(tool.handle, handle, adapter.faceHashes([tool.shape, ref]), HASH_BOUND);
    const fused = adapter.history(evolution, [
      { shape: tool.shape, use: 'target' },
      { shape: ref, use: 'target' },
    ]);
    namer.step(fused, { outputs: [], dividers: [] });
    tool = { shape: fused.result, handle: evolution.result };
  });
  const built = tool as unknown as { shape: ShapeRef; handle: ShapeHandle };
  return { ...built, src: [{ id: position }] };
}

registerBuilder('core.hole', (ctx) => {
  const { inputs, id, ordinal, part } = ctx;
  const { adapter, names } = ctx.ev;
  const threadInput = inputs.thread as Json;
  const thread = 'thread' in threadInput ? threadSpec(ctx, threadInput.thread as Json) : null;
  if (thread && !thread.internal) throw new FeaturePause(`class ${thread.class} is for a shaft's thread, not a hole's`);
  const placement = inputs.placement as Json;
  const frame =
    'frame' in placement
      ? frameOf(ctx, placement.frame as Json)
      : faceFrameOf(ctx, placement.face as Json, 'the hole face');
  // A tapped hole is drilled with the standard's tap drill; `diameter` is not used.
  const shape = shapeOf(ctx, thread ? thread.size.tapDrill / 2 : undefined);
  const namer = startFeature(part.state, { feature: id, ordinal }, adapter, names);
  const face =
    'face' in placement && !('inContext' in (placement.face as Json))
      ? entityOf(ctx, placement.face as Json, 'the hole face')
      : null;
  const positions = (inputs.positions as Json[]).map((row) => ({
    id: row.id as string,
    at: positionOf(ctx, frame, face, row),
  }));
  const tools = positions.map((p) => toolAt(ctx, namer, shape, frame, p.at, p.id));
  runOperation(ctx, namer, tools, 'cut', { all: {} });
  if (!thread) return;
  // The thread runs the bore's whole length.
  const axis = scale(frame.normal, -1);
  const bored = positions.flatMap((p) => {
    const hash = finest(ladderOf({ kind: 'face', chain: [], feature: id, role: 'bore', src: [idItem(p.id)] }, names));
    const bores = part.state.lookup(hash).filter((e) => e.kind === 'face');
    return bores.length > 0 ? [{ id: p.id, bores, thread: boreThread(ctx, thread, bores, p.at, axis) }] : [];
  });
  if (!thread.modelled) {
    part.threads.set(
      id,
      bored.map((b) => b.thread),
    );
    return;
  }
  // A copy of this hole would be drilled without its thread.
  part.tools.delete(id);
  const threading = startFeature(part.state, { feature: id, ordinal }, adapter, names);
  const cuts = new Map<ShapeRef, Live>();
  for (const b of bored) {
    const held = (b.bores[0] as NamedEntity).body;
    const body = cuts.get(held) ?? bodyOf(ctx, threading, b.bores[0] as NamedEntity);
    cuts.set(held, cutThread(ctx, threading, body, thread, { ...b.thread, radius: thread.size.tapDrill / 2 }, b.id));
  }
  finishThreads(ctx, threading, cuts);
});
