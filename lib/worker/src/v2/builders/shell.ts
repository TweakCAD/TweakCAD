/**
 * `core.shell` (appendix A): each body hollowed through its removed faces,
 * or, with none removed, closed around a sealed void. A wall offset into the
 * body is named `inner` after the face it offsets; with `outside` the offset
 * walls are `inner` too, and with `both` each wall offset out carries on the
 * name of the original face it was offset from. A rim is named after the face
 * removed.
 *
 * A body with an opening is one kernel shell per side. A shell on both sides
 * fuses the inside shell and the outside shell, which meet on the original
 * faces. A closed body is its offset solid less the solid offset the other
 * way: its own faces, or the outside offset, and the void inside it.
 */
import { BooleanOp, JoinType, OcctError, type EvolutionData } from 'occt-wasm';
import {
  startFeature,
  type BodyOutcome,
  type FeatureNamer,
  type NamedEntity,
  type OperationHistory,
  type ShapeKey,
  type ShapeRef,
  type SrcFact,
} from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import { FeaturePause, LENGTH, registerBuilder, type BuildContext, type Json } from '../context';
import { entitiesOf } from '../references';
import { liveBodies, REFINE_ANGLE, type Live } from '../operation';

const DIRECTION = { type: 'choice', options: ['inside', 'outside', 'both'] } as const;

/** Modelling tolerance of the offset surfaces. */
const TOLERANCE = 1e-3;

/** Volumes that should add up exactly agree to this fraction. */
const VOLUME_MATCH = 1e-6;

/** Wall thicknesses on each side of the original faces; 0 on a side that has no wall. */
interface Walls {
  inside: number;
  outside: number;
}

type Output = { entity: ShapeKey; role: string; src: SrcFact[] };

function resolvedSet(ctx: BuildContext, set: Json, what: string): NamedEntity[] {
  return (set.set as Json[]).flatMap((ref) => {
    if ('inContext' in ref) throw new FeaturePause(`${what} lies in another part`);
    return entitiesOf(ctx, ref, what);
  });
}

/** A kernel call; a kernel failure pauses the feature. */
function kernel(call: () => EvolutionData): EvolutionData {
  try {
    return call();
  } catch (e) {
    if (e instanceof OcctError) throw new FeaturePause('the kernel cannot shell this body at this thickness');
    throw e;
  }
}

const near = (a: number, b: number, scale: number) => Math.abs(a - b) <= VOLUME_MATCH * scale;

/** The volume of a valid solid; null for a result the kernel did not make whole. */
function soundVolume(ctx: BuildContext, handle: Live['handle']): number | null {
  const { kernel: k } = ctx.ev;
  try {
    return k.isValid(handle) ? k.getVolume(handle) : null;
  } catch (e) {
    if (e instanceof OcctError) return null;
    throw e;
  }
}

/** The new faces each input face generated, under `role`, named after it. */
function offsetWalls(history: OperationHistory, role: string): Output[] {
  const out: Output[] = [];
  for (const [face, walls] of history.facesFromFace)
    for (const entity of walls) out.push({ entity, role, src: [{ entity: face }] });
  return out;
}

/** The rims an opened face left, each named after it; `rims` learns which removed face each came from. */
function rimsOf(history: OperationHistory, opened: readonly ShapeKey[], rims: Map<ShapeKey, ShapeKey>): Output[] {
  const out: Output[] = [];
  for (const face of opened) {
    for (const entity of history.faces.modified.get(face) ?? []) {
      out.push({ entity, role: 'rim', src: [{ entity: face }] });
      rims.set(entity, face);
    }
  }
  return out;
}

type Continued = { entity: ShapeKey; from: ShapeKey };

/** One kernel step, named; the shell's body stays in the names until a step takes it as its target. */
function step(
  ctx: BuildContext,
  namer: FeatureNamer,
  evolution: EvolutionData,
  inputs: OperationHistory['inputs'],
  outputs: (h: OperationHistory) => Output[],
  continued?: (h: OperationHistory) => Continued[],
): Live {
  const history = ctx.ev.adapter.history(evolution, inputs);
  namer.step(history, {
    outputs: outputs(history),
    dividers: [],
    ...(continued ? { continued: continued(history) } : {}),
  });
  return { shape: history.result, handle: evolution.result };
}

/** A body hollowed through its opened faces, on one side or both. */
function opened(ctx: BuildContext, namer: FeatureNamer, body: Live, faces: readonly ShapeKey[], walls: Walls): Live {
  const { kernel: k, adapter } = ctx.ev;
  const shell = (thickness: number) =>
    kernel(() =>
      k.shellWithHistory(
        body.handle,
        faces.map((f) => adapter.handleOf(f)),
        thickness,
        TOLERANCE,
        adapter.faceHashes([body.shape]),
        HASH_BOUND,
        JoinType.Intersection,
      ),
    );
  const volume = k.getVolume(body.handle);
  const rims = new Map<ShapeKey, ShapeKey>();
  let inside: EvolutionData | null = null;
  if (walls.inside > 0) {
    inside = shell(walls.inside);
    // Walls that meet are not always reported: the result is then invalid, or the body comes back unhollowed.
    if ((soundVolume(ctx, inside.result) ?? volume) >= volume)
      throw new FeaturePause('the shell is too thick for this body');
  }
  const outside = walls.outside > 0 ? shell(-walls.outside) : null;
  if (outside && soundVolume(ctx, outside.result) === null)
    throw new FeaturePause('the shell is too thick for this body');
  if (!outside || !inside) {
    const only = (inside ?? outside) as EvolutionData;
    return step(ctx, namer, only, [{ shape: body.shape, use: 'target' }], (h) => [
      ...offsetWalls(h, 'inner'),
      ...rimsOf(h, faces, rims),
    ]);
  }

  const a = step(ctx, namer, inside, [{ shape: body.shape, use: 'tool' }], (h) => [
    ...offsetWalls(h, 'inner'),
    ...rimsOf(h, faces, rims),
  ]);
  // The walls offset out are left unnamed here: once the fuse takes the original faces away, each carries on the one it was offset from.
  const outerWalls: { original: ShapeKey; walls: readonly ShapeKey[] }[] = [];
  const b = step(ctx, namer, outside, [{ shape: body.shape, use: 'target' }], (h) => {
    const kept = new Set(h.faces.kept);
    for (const [face, walls] of h.facesFromFace) {
      for (const original of kept.has(face) ? [face] : (h.faces.modified.get(face) ?? []))
        outerWalls.push({ original, walls });
    }
    return rimsOf(h, faces, rims);
  });
  const fused = kernel(() =>
    k.booleanOp(BooleanOp.Fuse, [a.handle], [b.handle], {
      simplifyAngularTolerance: REFINE_ANGLE,
      inputFaceHashes: adapter.faceHashes([a.shape, b.shape]),
      hashUpperBound: HASH_BOUND,
    }),
  );
  const [va, vb] = [k.getVolume(a.handle), k.getVolume(b.handle)];
  const vf = soundVolume(ctx, fused.result);
  if (vf === null || !near(vf, va + vb, va + vb))
    throw new FeaturePause('the kernel cannot shell this body at this thickness');
  // The two rims of an opening lie in one plane and become one face, named after the face removed.
  return step(
    ctx,
    namer,
    fused,
    [
      { shape: a.shape, use: 'target' },
      { shape: b.shape, use: 'tool' },
    ],
    (h) => {
      const out = new Map<ShapeKey, Output>();
      for (const [from, to] of h.faces.modified) {
        const removed = rims.get(from);
        if (removed !== undefined)
          for (const entity of to) out.set(entity, { entity, role: 'rim', src: [{ entity: removed }] });
      }
      return [...out.values()];
    },
    (h) => {
      const kept = new Set(h.faces.kept);
      return outerWalls.flatMap(({ original, walls }) =>
        walls.flatMap((wall) =>
          (kept.has(wall) ? [wall] : (h.faces.modified.get(wall) ?? [])).map((entity) => ({ entity, from: original })),
        ),
      );
    },
  );
}

/** A body with no opening: hollowed around a sealed void. */
function closed(ctx: BuildContext, namer: FeatureNamer, body: Live, walls: Walls): Live {
  const { kernel: k, adapter } = ctx.ev;
  const offset = (distance: number) =>
    kernel(() =>
      k.offsetWithHistory(
        body.handle,
        distance,
        TOLERANCE,
        adapter.faceHashes([body.shape]),
        HASH_BOUND,
        JoinType.Intersection,
      ),
    );
  const volume = k.getVolume(body.handle);
  const check = (e: EvolutionData, grows: boolean) => {
    const v = soundVolume(ctx, e.result);
    if (v === null || v <= 0 || (grows ? v <= volume : v >= volume))
      throw new FeaturePause('the shell is too thick for this body');
    return v;
  };

  // The outer solid: the body itself, or its offset out.
  let outer = body;
  let outerVolume = volume;
  if (walls.outside > 0) {
    const out = offset(walls.outside);
    outerVolume = check(out, true);
    // With a wall inside too, this step leaves the body to the next, and each face offset out carries on the face it offsets.
    outer = step(ctx, namer, out, [{ shape: body.shape, use: 'tool' }], (h) =>
      walls.inside > 0 ? [] : offsetWalls(h, 'inner'),
    );
  }
  // The void: the body itself, or its offset in.
  let inner = body;
  let innerVolume = volume;
  if (walls.inside > 0) {
    const into = offset(-walls.inside);
    innerVolume = check(into, false);
    inner = step(ctx, namer, into, [{ shape: body.shape, use: walls.outside > 0 ? 'target' : 'tool' }], (h) =>
      offsetWalls(h, 'inner'),
    );
  }

  const cut = kernel(() =>
    k.cutWithHistory(outer.handle, inner.handle, adapter.faceHashes([outer.shape, inner.shape]), HASH_BOUND),
  );
  const left = soundVolume(ctx, cut.result);
  if (
    left === null ||
    k.subShapeCount(cut.result, 'solid') !== 1 ||
    !near(left, outerVolume - innerVolume, outerVolume)
  ) {
    throw new FeaturePause('the kernel cannot shell this body at this thickness');
  }
  // The body is the target of the last step that reads it, so it keeps its name.
  const inputs: OperationHistory['inputs'] =
    walls.inside > 0 && walls.outside > 0
      ? [
          { shape: outer.shape, use: 'target' },
          { shape: inner.shape, use: 'tool' },
        ]
      : [
          { shape: body.shape, use: 'target' },
          { shape: (walls.inside > 0 ? inner : outer).shape, use: 'tool' },
        ];
  return step(ctx, namer, cut, inputs, () => []);
}

registerBuilder('core.shell', (ctx) => {
  const { inputs, id, ordinal, part } = ctx;
  const { adapter, values, names } = ctx.ev;
  const direction = values.literal(inputs.direction, DIRECTION);
  const thickness = values.number(inputs.thickness, LENGTH);
  if (thickness <= 0) throw new FeaturePause('the shell has no thickness');
  let walls: Walls = direction === 'inside' ? { inside: thickness, outside: 0 } : { inside: 0, outside: thickness };
  if (direction === 'both') {
    if (inputs.outsideThickness === undefined)
      throw new FeaturePause('a shell on both sides needs an outside thickness');
    const outside = values.number(inputs.outsideThickness, LENGTH);
    if (outside <= 0) throw new FeaturePause('the shell has no outside thickness');
    walls = { inside: thickness, outside };
  }

  const namer = startFeature(part.state, { feature: id, ordinal }, adapter, names);
  // Each body as a shape of its own; a body sharing a shape with others is divided out first.
  const bodies = liveBodies(ctx, namer, (inputs.bodies as Json).set as Json[]);
  const removed = resolvedSet(ctx, inputs.remove as Json, 'a removed face');
  const ownerOf = new Map<ShapeKey, ShapeRef>();
  for (const face of removed) {
    if (face.kind !== 'face') throw new FeaturePause('a removed entity is not a face');
    const owner = bodies.find((b) => adapter.topology(b.shape).faces.includes(face.key));
    if (!owner) throw new FeaturePause('a removed face is not on a shelled body');
    ownerOf.set(face.key, owner.shape);
  }

  const outcomes: BodyOutcome[] = [];
  const built: { input: ShapeRef; result: Live }[] = [];
  for (const body of bodies) {
    const faces = removed.filter((f) => ownerOf.get(f.key) === body.shape).map((f) => f.key);
    const result = faces.length > 0 ? opened(ctx, namer, body, faces, walls) : closed(ctx, namer, body, walls);
    built.push({ input: body.shape, result });
    for (const solid of adapter.topology(result.shape).solids)
      outcomes.push({ solid: solid.solid, from: { carry: [body.shape] } });
  }
  for (const b of built) {
    part.shapes.delete(b.input);
    part.shapes.set(b.result.shape, b.result.handle);
  }
  part.state = namer.finish(outcomes);
});
