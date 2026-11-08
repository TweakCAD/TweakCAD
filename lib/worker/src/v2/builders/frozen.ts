/**
 * Frozen features (7.2; chapter 10, step 2.2): the stored bodies replace the
 * feature's effect. Each effect creates, modifies or removes one body, its
 * stored shape loaded as an import's is, so every sub-shape keeps the identity
 * its shape map gives it (13.2) and picks made before freezing still resolve.
 * The stored values and construction outputs stand in for the feature's own.
 */
import type { ShapeHandle } from 'occt-wasm';
import {
  canonicalRotation,
  canonicalize,
  contentHash,
  fromStored,
  startFeature,
  type FeatureNamer,
  type JsonValue,
  type NamedEntity,
  NamedState,
  type Quaternion,
  type ShapeKey,
  type ShapeRef,
  type ValueTarget,
} from '@tweakcad/format';
import {
  FeaturePause,
  cross,
  rotate,
  unit,
  type BuildContext,
  type ConstructionOutput,
  type CosmeticThread,
  type Frame,
  type Json,
  type RecordedTool,
  type V3,
} from '../context';
import { divide } from '../operation';
import { loadStored } from './import';

/** Types whose features are never frozen (7.2). */
function neverFrozen(type: string): string | undefined {
  if (type === 'core.sketch') return 'a sketch cannot be frozen';
  if (type === 'core.measure') return 'a measure feature cannot be frozen';
  if (type.startsWith('core.asm.')) return 'an assembly feature cannot be frozen';
  return undefined;
}

/**
 * BREP text with each shape's "checked" flag (the third of its seven flags)
 * as a shape just built has it. The flag is bookkeeping, not geometry:
 * meshing a shape for display clears it, and a body is the same body shown
 * or not.
 */
function sameFlags(brep: string): string {
  const at = brep.indexOf('\nTShapes ');
  if (at < 0) return brep;
  return (
    brep.slice(0, at) +
    brep.slice(at).replace(/^([01]{2})[01]([01]{4})$/gm, (_, head: string, tail: string) => `${head}1${tail}`)
  );
}

/**
 * The content hash a body's stored shape has: a root compound holding it,
 * written as BREP without any mesh (13.2), its shapes' flags as when built.
 * A frozen `modify` records it of the body entering the feature, so a replay
 * can tell when an earlier edit changed it.
 */
export function bodyHash(ctx: Pick<BuildContext, 'ev'>, solid: ShapeKey): string {
  const { kernel: k, adapter } = ctx.ev;
  const root = k.makeCompound([adapter.handleOf(solid)]);
  const bare = k.copy(root);
  try {
    return contentHash(new TextEncoder().encode(sameFlags(k.toBREP(bare))));
  } finally {
    k.release(bare);
    k.release(root);
  }
}

interface BodyKey {
  hash: string;
  branch: readonly { split: { id: string }; side: readonly unknown[] }[];
}

const branchText = (branch: NamedEntity['branch']) =>
  canonicalize(branch.map((b) => ({ split: { id: b.split }, side: b.side })) as unknown as JsonValue);

/** The one body of `state` a body key names (7.2): its ladder holds the hash and its branch is the key's. */
function bodyOf(state: NamedState, key: BodyKey): NamedEntity {
  const branch = canonicalize(key.branch as unknown as JsonValue);
  const found = [...state.bodies.keys()]
    .map((solid) => state.get(solid) as NamedEntity)
    .filter((e) => e.ladder.includes(key.hash) && branchText(e.branch) === branch);
  if (found.length === 0) throw new FeaturePause('a body the frozen feature acts on is not there');
  if (found.length > 1) throw new FeaturePause('a body key of the frozen feature names several bodies');
  return found[0] as NamedEntity;
}

/**
 * Takes a live body out of the part: its shape divided first when it holds
 * other bodies too. `shapeOf` follows each body's shape through those divisions.
 */
function takeOut(ctx: BuildContext, namer: FeatureNamer, shapeOf: Map<ShapeKey, ShapeRef>, body: NamedEntity): void {
  const { part, ev } = ctx;
  let shape = shapeOf.get(body.key);
  if (shape === undefined || !part.shapes.has(shape))
    throw new FeaturePause('a body the frozen feature acts on has no shape');
  if (ev.adapter.topology(shape).solids.length > 1) {
    for (const [solid, live] of divide(ctx, namer, shape)) shapeOf.set(solid, live.shape);
    shape = shapeOf.get(body.key) as ShapeRef;
  }
  namer.retire(shape);
  part.shapes.delete(shape);
}

/** A construction output from its stored geometry (12.4), in the frame chapter 15 reads it from. */
function constructionOf(entry: Json): ConstructionOutput {
  const ladder = entry.ladder as string[];
  const geometry = entry.geometry as Json;
  const tag = Object.keys(geometry)[0] as string;
  const g = geometry[tag] as Json;
  const across = (z: V3): V3 => {
    const seed: V3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return unit(cross(cross(z, seed), z));
  };
  const frameOf = (origin: V3, x: V3, normal: V3): Frame => ({ origin, x, y: cross(normal, x), normal });
  switch (tag) {
    case 'plane': {
      const normal = unit(g.normal as V3);
      return { kind: 'plane', ladder, frame: frameOf(g.origin as V3, unit(g.x as V3), normal) };
    }
    case 'axis': {
      const normal = unit(g.direction as V3);
      return { kind: 'axis', ladder, frame: frameOf(g.origin as V3, across(normal), normal) };
    }
    case 'point':
      return { kind: 'point', ladder, frame: frameOf(g.at as V3, [1, 0, 0], [0, 0, 1]) };
    default: {
      const q = (geometry.frame as Json).rotation as number[];
      const x = rotate(q, [1, 0, 0]);
      const normal = rotate(q, [0, 0, 1]);
      return { kind: 'frame', ladder, frame: frameOf((geometry.frame as Json).position as V3, x, normal) };
    }
  }
}

/** The stored values of a frozen feature become the values' results (7.2). */
function supplyValues(ctx: BuildContext, values: Json): void {
  for (const [id, literal] of Object.entries(values)) {
    const l = literal as Json;
    const target = { type: l.type, ...(l.quantity === undefined ? {} : { quantity: l.quantity }) } as ValueTarget;
    ctx.ev.values.supply(id, fromStored(l.value as JsonValue, target));
  }
}

/** Replays a frozen feature's stored effect in place of its build. */
export function replayFrozen(ctx: BuildContext, payload: Json): void {
  const { ev, part, id, ordinal } = ctx;
  const never = neverFrozen(ctx.feature.type as string);
  if (never) throw new FeaturePause(never);

  const construction = (payload.construction as Json[]).map(constructionOf);
  if (construction.length > 1)
    throw new FeaturePause('a frozen feature with several construction outputs is not built yet');

  const before = part.state;
  const namer = startFeature(before, { feature: id, ordinal }, ev.adapter, ev.names);
  const effects = payload.effects as Json[];
  // Every body key names a body in the state before the feature.
  const bodies = effects.map((effect) => {
    const body = (effect.modify ?? effect.remove) as Json | undefined;
    return body && bodyOf(before, body.body as BodyKey);
  });
  if (new Set(bodies.filter((b) => b !== undefined)).size !== bodies.filter((b) => b !== undefined).length) {
    throw new FeaturePause('two effects of the frozen feature act on one body');
  }
  const shapeOf = new Map(before.bodies);
  let changed = false;
  const loaded: { ref: string; handle: ShapeHandle; ladder?: readonly string[]; branch?: string; key?: string }[] = [];
  effects.forEach((effect, i) => {
    const body = bodies[i];
    if ('remove' in effect) {
      takeOut(ctx, namer, shapeOf, body as NamedEntity);
      return;
    }
    if ('modify' in effect) {
      const modify = effect.modify as Json;
      if (modify.input !== undefined && bodyHash(ctx, (body as NamedEntity).key) !== modify.input) changed = true;
      takeOut(ctx, namer, shapeOf, body as NamedEntity);
      const { ref, handle } = loadStored(ctx, namer, modify.stored as Json, `frozen:${id}:${i}`);
      loaded.push({
        ref,
        handle,
        key: (modify.body as BodyKey).hash,
        branch: canonicalize((modify.body as BodyKey).branch as unknown as JsonValue),
      });
      return;
    }
    const create = effect.create as Json;
    const { ref, handle } = loadStored(ctx, namer, create.stored as Json, `frozen:${id}:${i}`);
    loaded.push({ ref, handle, ladder: create.ladder as string[], branch: canonicalize(create.branch as JsonValue) });
  });

  const state = namer.finish([]);
  // Each stored shape holds the one body its effect names, with that identity.
  for (const l of loaded) {
    const solids = ev.adapter.topology(l.ref).solids.map((s) => state.get(s.solid));
    const [solid] = solids;
    if (solids.length !== 1 || !solid)
      throw new FeaturePause('a stored shape of the frozen feature does not hold one body');
    const same = l.ladder
      ? canonicalize([...solid.ladder]) === canonicalize([...l.ladder])
      : solid.ladder.includes(l.key as string);
    if (!same || branchText(solid.branch) !== l.branch)
      throw new FeaturePause('a stored body has another identity than its effect gives it');
  }
  const { threads, tool } = restoredOutputs(ctx, (payload.outputs as Json[] | undefined) ?? []);
  // Everything loaded: the replay takes effect as a whole.
  part.state = state;
  for (const l of loaded) part.shapes.set(l.ref, l.handle);
  const [output] = construction;
  if (output) part.construction.set(id, output);
  if (threads.length > 0) part.threads.set(id, threads);
  if (tool) part.tools.set(id, tool);
  supplyValues(ctx, payload.values as Json);
  if (changed)
    ev.stale.push({
      feature: id,
      message: 'an earlier edit changed a body this frozen feature modifies; it replays its stored shape',
    });
}

/** A frozen feature's other outputs (7.2 `outputs`): its cosmetic threads, and the tool a feature pattern copies. */
function restoredOutputs(
  ctx: BuildContext,
  outputs: readonly Json[],
): { threads: CosmeticThread[]; tool: RecordedTool | undefined } {
  const { ev, id, ordinal } = ctx;
  const threads: CosmeticThread[] = [];
  let tool: RecordedTool | undefined;
  for (const o of outputs) {
    if ('thread' in o) {
      const t = o.thread as Json;
      const faces = ((t.faces as Json).set as Json[]).map((k) => ({
        hash: k.hash as string,
        branch: (k.branch as Json[]).map((b) => ({ split: (b.split as Json).id as string, side: b.side as never })),
      }));
      threads.push({ ...(t as unknown as CosmeticThread), faces });
    } else if ('tool' in o) {
      const t = o.tool as Json;
      const namer = startFeature(NamedState.empty(), { feature: id, ordinal }, ev.adapter, ev.names);
      const { ref, handle } = loadStored(ctx, namer, t.stored as Json, `frozen:${id}:tool`);
      const state = namer.finish([]);
      tool = {
        shape: ref,
        handle,
        op: t.op as string,
        targets: t.targets as Json,
        names: state.entities,
        ordinal,
        keepTools: false,
      };
    }
  }
  return { threads, tool };
}

/** A frame's rotation as a unit quaternion `[x, y, z, w]` in canonical sign, from its axes. */
export function quaternionOf(frame: Frame): Quaternion {
  const [x, y, z] = [frame.x, frame.y, frame.normal];
  const [m00, m11, m22] = [x[0], y[1], z[2]];
  const trace = m00 + m11 + m22;
  let q: Quaternion;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s];
  }
  const n = Math.hypot(...q);
  return canonicalRotation(q.map((c) => c / n) as Quaternion);
}
