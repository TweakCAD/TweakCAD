/**
 * Measured values (6.3) and `core.measure` (appendix A). Every `measure` value
 * a feature holds is measured after the feature's build (chapter 10, step 2.5),
 * against the part after the build for the feature's own outputs and before it
 * for everything else, and its result is what the values using it read. A
 * value that cannot be measured pauses what uses it, never the feature.
 */
import { OcctError, type ShapeHandle } from 'occt-wasm';
import {
  NamingPause,
  ValuePause,
  finest,
  isPlainObject,
  quantityNamed,
  resolve,
  type EntityRecord,
  type ExprValue,
  type NamedEntity,
  type NamedState,
} from '@tweakcad/format';
import {
  FeaturePause,
  dot,
  kv,
  norm,
  registerBuilder,
  sub,
  unit,
  type BuildContext,
  type Json,
  type PartResult,
  type SketchResult,
  type V3,
} from '../context';
import { entitiesOf, inContextOf } from '../references';
import { STANDARD, constructionOf, sketchRowOf } from '../places';
import { lift } from '../profiles';

// A measure feature has no outputs: its values are measured after the build, as every feature's are.
registerBuilder('core.measure', () => undefined);

/** What a measure reference names. Default and construction axes and planes are unbounded. */
export type Operand =
  | { kind: 'point'; at: V3 }
  | { kind: 'axis'; direction: V3 }
  | { kind: 'plane'; normal: V3 }
  /** `state` is the part state it resolved in. */
  | { kind: 'entity'; entity: NamedEntity; state: NamedState }
  | { kind: 'curve'; sketch: SketchResult; id: string };

/** What measuring reads: the evaluation the operands live in. */
type On = Pick<BuildContext, 'ev'>;

const AXES: Record<string, V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** The quantity each measure kind yields. */
export const QUANTITY: Record<string, string> = {
  distance: 'length',
  length: 'length',
  area: 'area',
  volume: 'volume',
  angle: 'angle',
  radius: 'length',
};

function entityOperand(ctx: BuildContext, before: PartResult, record: EntityRecord): Operand {
  const { ev } = ctx;
  if (record.id.length === 0) throw new FeaturePause('a measured reference is to be reconnected');
  const level = ev.names.get(finest(record.id)) as Json | undefined;
  if (level?.kind === 'region') throw new FeaturePause('measuring sketch regions is not built yet');
  // A name this feature made is one of its own outputs, measured after its build.
  const own = ((ev.names.get(record.id[0] as string) as Json | undefined)?.feature as Json | undefined)?.id === ctx.id;
  const state = (own ? ctx.part : before).state;
  const found = resolve(record, state, ev.adapter);
  if (found.outcome !== 'same')
    throw new FeaturePause(`a measured entity is ${found.outcome === 'ask' ? 'ambiguous' : 'gone'}`);
  if (found.entities.length !== 1) throw new FeaturePause('a measured reference names several entities');
  return { kind: 'entity', entity: found.entities[0] as NamedEntity, state };
}

function operandOf(ctx: BuildContext, before: PartResult, ref: Json): Operand {
  const w = { ev: ctx.ev, part: ctx.part };
  if ('standard' in ref) {
    const name = (ref.standard as Json).name as string;
    if (name === 'origin') return { kind: 'point', at: [0, 0, 0] };
    const axis = AXES[name];
    if (axis) return { kind: 'axis', direction: axis };
    const plane = STANDARD[name];
    if (plane) return { kind: 'plane', normal: plane.normal };
  }
  if ('object' in ref) {
    // A sketch stands for its plane, as a direction's `normal` does (7.3).
    const sketch = ctx.part.sketches.get((((ref.object as Json).feature ?? {}) as Json).id as string);
    if (sketch) return { kind: 'plane', normal: sketch.frame.normal };
  }
  if ('entity' in ref || 'object' in ref) {
    const output = constructionOf(w, ref);
    if (output) {
      if (output.kind === 'axis') return { kind: 'axis', direction: output.frame.normal };
      if (output.kind === 'plane') return { kind: 'plane', normal: output.frame.normal };
      return { kind: 'point', at: output.frame.origin };
    }
  }
  if ('entity' in ref) {
    const row = sketchRowOf(w, ref);
    if (row?.kind === 'point') {
      const p = row.sketch.solved.points.find((q) => q.id === row.id);
      if (!p) throw new FeaturePause('a measured sketch point is not in this build');
      return { kind: 'point', at: lift(row.sketch.frame, [p.x, p.y]) };
    }
    if (row) return { kind: 'curve', sketch: row.sketch, id: row.id };
    return entityOperand(ctx, before, ref.entity as EntityRecord);
  }
  if ('inContext' in ref) {
    // Another part's geometry, as its context captured it, in this part's frame.
    const opened = inContextOf(w, ref);
    const found = entitiesOf(w, ref, 'a measured entity');
    if (!opened || found.length !== 1) throw new FeaturePause('a measured reference names several entities');
    return { kind: 'entity', entity: found[0] as NamedEntity, state: opened.w.part.state };
  }
  throw new FeaturePause('this kind of reference is not measured yet');
}

/** The live pieces of a sketch curve: lines by their ends, other curves by their solved shape. */
function curvePieces(op: Extract<Operand, { kind: 'curve' }>) {
  const lines = op.sketch.lines.get(op.id) ?? [];
  const shapes = op.sketch.solved.curves
    .filter((c) => 'drawn' in c.key && c.key.drawn.id === op.id)
    .map((c) => c.shape);
  if (lines.length === 0 && shapes.length === 0) throw new FeaturePause('a measured sketch curve is not in this build');
  return { lines, shapes: lines.length > 0 ? [] : shapes };
}

/** The radius of a sketch circle or arc. */
function sketchRadius(op: Extract<Operand, { kind: 'curve' }>): number {
  const { shapes } = curvePieces(op);
  const [shape] = shapes;
  if (shapes.length !== 1 || !shape) throw new FeaturePause('a radius is measured on one circle or arc');
  if (shape.kind === 'circle') return shape.radius;
  if (shape.kind === 'arc') return Math.hypot(shape.start[0] - shape.center[0], shape.start[1] - shape.center[1]);
  throw new FeaturePause('a radius is measured on one circle or arc');
}

function sketchLength(op: Extract<Operand, { kind: 'curve' }>): number {
  const { lines, shapes } = curvePieces(op);
  let total = lines.reduce((sum, [a, b]) => sum + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
  for (const shape of shapes) {
    if (shape.kind === 'circle') total += 2 * Math.PI * shape.radius;
    else if (shape.kind === 'arc') {
      const [a0, a1] = [shape.start, shape.end].map((p) =>
        Math.atan2(p[1] - shape.center[1], p[0] - shape.center[0]),
      ) as [number, number];
      let sweep = a1 - a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      total += Math.hypot(shape.start[0] - shape.center[0], shape.start[1] - shape.center[1]) * sweep;
    } else throw new FeaturePause(`the length of a sketch ${shape.kind} is not measured yet`);
  }
  return total;
}

/**
 * The direction of a straight edge, which the kernel may turn between builds:
 * from the end at the vertex with the lower finest name to the other, as a
 * variable fillet's `at` runs.
 */
function edgeDirection(ctx: On, e: NamedEntity, state: NamedState): V3 {
  const { adapter } = ctx.ev;
  const geometry = adapter.edgeGeometry(e.key);
  if (geometry.curve.kind !== 'line') throw new FeaturePause('an angle is measured on straight edges');
  const ends = adapter.topology(e.body).edges.find((x) => x.edge === e.key)?.ends ?? [];
  const named = ends.map((v) => {
    const ladder = state.get(v)?.ladder ?? [];
    return { v, name: ladder.length > 0 ? finest(ladder) : undefined };
  });
  const [a, b] = named;
  if (!a?.name || !b?.name || a.name === b.name)
    throw new FeaturePause('the ends of a measured edge share a name, so it has no direction');
  const [from, to] = (a.name < b.name ? [a, b] : [b, a]).map((x) => adapter.measures(x.v).point as V3) as [V3, V3];
  return unit(sub(to, from));
}

function directionOf(ctx: On, op: Operand): V3 {
  const { adapter } = ctx.ev;
  switch (op.kind) {
    case 'axis':
      return op.direction;
    case 'plane':
      return op.normal;
    case 'curve': {
      const [line] = curvePieces(op).lines;
      if (!line) throw new FeaturePause('an angle is measured on sketch lines');
      const [a, b] = [lift(op.sketch.frame, line[0]), lift(op.sketch.frame, line[1])];
      return unit(sub(b, a));
    }
    case 'entity': {
      const e = op.entity;
      if (e.kind === 'edge') return edgeDirection(ctx, e, op.state);
      const m = adapter.measures(e.key);
      if (e.kind === 'face' && m.surface === 'plane') return m.normal as V3;
      throw new FeaturePause('an angle is measured between lines, axes and planar faces');
    }
    default:
      throw new FeaturePause('an angle is measured between lines, axes and planar faces');
  }
}

/** Kernel shapes for a distance; `made` collects the ones made here, to release. */
function shapesOf(ctx: On, op: Operand, made: ShapeHandle[]): ShapeHandle[] {
  const { kernel: k, adapter } = ctx.ev;
  const keep = (h: ShapeHandle) => {
    made.push(h);
    return h;
  };
  switch (op.kind) {
    case 'point':
      return [keep(k.makeVertex(op.at[0], op.at[1], op.at[2]))];
    case 'entity':
      return [adapter.handleOf(op.entity.key)];
    case 'curve': {
      const { lines, shapes } = curvePieces(op);
      const frame = op.sketch.frame;
      const out = lines.map(([a, b]) => keep(k.makeLineEdge(kv(lift(frame, a)), kv(lift(frame, b)))));
      for (const shape of shapes) {
        if (shape.kind !== 'circle') throw new FeaturePause(`a distance to a sketch ${shape.kind} is not measured yet`);
        out.push(keep(k.makeCircleEdge(kv(lift(frame, shape.center)), kv(frame.normal), shape.radius)));
      }
      return out;
    }
    default:
      throw new FeaturePause('a distance to a default or construction axis or plane is not measured yet');
  }
}

function distance(ctx: On, a: Operand, b: Operand): number {
  if (a.kind === 'point' && b.kind === 'point') return norm(sub(a.at, b.at));
  const { kernel: k } = ctx.ev;
  const made: ShapeHandle[] = [];
  try {
    const [as, bs] = [shapesOf(ctx, a, made), shapesOf(ctx, b, made)];
    return Math.min(...as.flatMap((x) => bs.map((y) => k.distanceBetween(x, y))));
  } finally {
    for (const h of made) k.release(h);
  }
}

function entities(ops: readonly Operand[], kind: string, what: string): NamedEntity[] {
  if (ops.length === 0) throw new FeaturePause(`${what} is measured on one or more references`);
  return ops.map((op) => {
    if (op.kind !== 'entity' || op.entity.kind !== kind)
      throw new FeaturePause(`${what} is measured on ${kind === 'body' ? 'bodies' : `${kind}s`}`);
    return op.entity;
  });
}

/** One measure of `kind` (appendix A `core.measure`) on its operands, in base units; pauses when it cannot be taken. */
export function measureOperands(ctx: On, kind: string, ops: readonly Operand[]): number {
  const { adapter } = ctx.ev;
  switch (kind) {
    case 'distance': {
      const [a, b] = ops;
      if (ops.length !== 2 || !a || !b) throw new FeaturePause('a distance is measured between two references');
      return distance(ctx, a, b);
    }
    case 'length':
      if (ops.length === 0) throw new FeaturePause('a length is measured on one or more references');
      return ops.reduce((sum, op) => {
        if (op.kind === 'curve') return sum + sketchLength(op);
        if (op.kind === 'entity' && op.entity.kind === 'edge')
          return sum + (adapter.measures(op.entity.key).length as number);
        throw new FeaturePause('a length is measured on edges and sketch curves');
      }, 0);
    case 'area':
      return entities(ops, 'face', 'an area').reduce((sum, e) => sum + (adapter.measures(e.key).area as number), 0);
    case 'volume':
      return entities(ops, 'body', 'a volume').reduce((sum, e) => sum + (adapter.measures(e.key).volume as number), 0);
    case 'angle': {
      const [a, b] = ops;
      if (ops.length !== 2 || !a || !b) throw new FeaturePause('an angle is measured between two references');
      const cos = Math.max(-1, Math.min(1, dot(directionOf(ctx, a), directionOf(ctx, b))));
      return (Math.acos(cos) * 180) / Math.PI;
    }
    case 'radius': {
      const [op] = ops;
      if (ops.length !== 1 || !op) throw new FeaturePause('a radius is measured on one reference');
      if (op.kind === 'curve') return sketchRadius(op);
      if (op.kind === 'entity' && op.entity.kind === 'edge') {
        const curve = adapter.edgeGeometry(op.entity.key).curve;
        if (curve.kind === 'circle') return curve.radius;
      }
      if (op.kind === 'entity' && op.entity.kind === 'face') {
        const surface = adapter.faceGeometry(op.entity.key).surface;
        if ((surface.kind === 'cylinder' || surface.kind === 'sphere') && surface.radii[0] !== undefined)
          return surface.radii[0];
      }
      throw new FeaturePause('a radius is measured on one circle, arc, cylinder or sphere');
    }
    default:
      throw new FeaturePause(`the measure kind ${kind} is not built yet`);
  }
}

/** The value objects among a feature's inputs. */
export function valueObjects(v: unknown, out: Json[] = []): Json[] {
  if (Array.isArray(v)) for (const item of v) valueObjects(item, out);
  else if (isPlainObject(v)) {
    if (typeof v.id === 'string' && v.id.startsWith('val_') && 'def' in v) out.push(v);
    else for (const [key, item] of Object.entries(v)) if (key !== 'extensions') valueObjects(item, out);
  }
  return out;
}

/** Ids of the feature's values whose definition in this build is a measure. */
export function measuredValues(ctx: Pick<BuildContext, 'ev' | 'inputs'>): string[] {
  return valueObjects(ctx.inputs)
    .map((v) => v.id as string)
    .filter((id) => isPlainObject(ctx.ev.values.definition(id)?.measure));
}

/** Chapter 10, step 2.5: measures the feature's `measure` values; `before` is the part as it stood before the build. */
export function measureValues(ctx: BuildContext, before: PartResult): void {
  const { values } = ctx.ev;
  for (const id of measuredValues(ctx)) {
    const m = values.definition(id)?.measure as Json;
    try {
      const quantity = quantityNamed(QUANTITY[m.kind as string] ?? '');
      if (!quantity) throw new FeaturePause(`the measure kind ${String(m.kind)} is not built yet`);
      const ops = (m.of as Json[]).map((ref) => operandOf(ctx, before, ref));
      const result: ExprValue = {
        kind: 'scalar',
        dim: quantity.dim,
        value: measureOperands(ctx, m.kind as string, ops),
      };
      values.supply(id, result);
    } catch (e) {
      if (e instanceof FeaturePause || e instanceof ValuePause || e instanceof NamingPause)
        values.withhold(id, e.message);
      else if (e instanceof OcctError) values.withhold(id, `the kernel could not measure it: ${e.message}`);
      else throw e;
    }
  }
}
