/**
 * Patterns and mirrors of features: each patterned feature's tool, as it
 * entered its operation, is copied to every slot and applied to the bodies
 * with that feature's own operation. The copies carry the tool's names with
 * the copy step in `chain` (9.5), and a copied tapped hole its cosmetic thread.
 */
import {
  canonicalize,
  finest,
  resolve,
  withChain,
  type CopyStep,
  type EntityRecord,
  type FeatureNamer,
  type JsonValue,
} from '@tweakcad/format';
import {
  FeaturePause,
  add,
  cross,
  dot,
  scale,
  sub,
  unit,
  type BuildContext,
  type CosmeticThread,
  type Json,
  type RecordedTool,
  type V3,
} from './context';
import type { Motion } from './copies';
import { CONTACT, runOperation, type Live } from './operation';

export interface FeatureTool extends RecordedTool {
  feature: string;
}

/** The patterned features' tools in timeline order, with the one operation they share. */
export interface FeatureTools {
  tools: FeatureTool[];
  op: 'join' | 'cut';
  targets: Json;
}

/** One copied tool: where it came from, the copy step its names carry, and how it moved points and directions. */
export interface FeatureCopy {
  live: Live;
  feature: string;
  step: CopyStep;
  point: (p: V3) => V3;
  vector: (v: V3) => V3;
}

/** Rotates `v` about the unit `axis` by `radians`. */
function turnVector(v: V3, axis: V3, radians: number): V3 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}

/** The point and direction maps of a rigid motion: its turn, then its shift. */
export function motionMaps(motion: Motion): Pick<FeatureCopy, 'point' | 'vector'> {
  const { turn, shift } = motion;
  const vector = (v: V3): V3 => (turn ? turnVector(v, unit(turn.direction), turn.radians) : v);
  const point = (p: V3): V3 => {
    const turned = turn ? add(turn.point, vector(sub(p, turn.point))) : p;
    return shift ? add(turned, shift) : turned;
  };
  return { point, vector };
}

/** The point and direction maps of a reflection in a plane. */
export function mirrorMaps(plane: { point: V3; normal: V3 }): Pick<FeatureCopy, 'point' | 'vector'> {
  const n = unit(plane.normal);
  const vector = (v: V3): V3 => sub(v, scale(n, 2 * dot(v, n)));
  return { vector, point: (p) => sub(p, scale(n, 2 * dot(sub(p, plane.point), n))) };
}

/** The tools of the features `of.features` names; pauses for a feature with no tool, or features that differ in operation. */
export function featureTools(ctx: BuildContext, of: Json, what: string): FeatureTools {
  const { part, ev } = ctx;
  const refs = (of.features as Json).set as Json[];
  const tools = refs.map((ref): FeatureTool => {
    const feature = ((ref.object as Json | undefined)?.feature as Json | undefined)?.id as string | undefined;
    if (feature === undefined) throw new FeaturePause(`${what} name their features by id`);
    const tool = part.tools.get(feature);
    if (tool) return { ...tool, feature };
    if (ev.pauses.some((p) => p.feature === feature))
      throw new FeaturePause(`a feature the ${what} copy did not build`);
    throw new FeaturePause(
      `a feature the ${what} copy has no tool shape: only features that join or cut, built before them, have one, and a modelled thread has none`,
    );
  });
  tools.sort((a, b) => a.ordinal - b.ordinal);
  const [first] = tools as [FeatureTool];
  if (first.op === 'new') throw new FeaturePause(`${what} of a feature that makes a new body are not built yet`);
  if (tools.some((t) => t.keepTools))
    throw new FeaturePause(`${what} of a feature that keeps its tool body are not built yet`);
  if (first.op !== 'join' && first.op !== 'cut')
    throw new FeaturePause(`${what} of a feature with operation ${first.op} are not built yet`);
  const targets = canonicalize(first.targets as JsonValue);
  if (tools.some((t) => t.op !== first.op || canonicalize(t.targets as JsonValue) !== targets)) {
    throw new FeaturePause(`${what} of features with different operations or targets are not built yet`);
  }
  return { tools, op: first.op, targets: first.targets };
}

/** The live shapes of an operation's targets, read without dividing them. */
function targetShapes(ctx: BuildContext, targets: Json): Live[] {
  const { part, ev } = ctx;
  const all = [...part.shapes].map(([shape, handle]) => ({ shape, handle }));
  if (!('bodies' in targets)) return all;
  const refs = (targets.bodies as Json).set as Json[];
  const shapes = new Set(
    refs.flatMap((ref) => {
      const record = ref.entity as EntityRecord | undefined;
      const found = record ? resolve(record, part.state, ev.adapter) : undefined;
      return found?.outcome === 'same' ? found.entities.map((e) => part.state.bodies.get(e.key)) : [];
    }),
  );
  return all.filter((l) => shapes.has(l.shape));
}

/** Each copied feature's cosmetic threads, on the copies of their faces. */
function copiedThreads(ctx: BuildContext, copies: readonly FeatureCopy[]): CosmeticThread[] {
  const { part, ev } = ctx;
  return copies.flatMap(({ feature, step, point, vector }) =>
    (part.threads.get(feature) ?? []).flatMap((thread) => {
      const faces = thread.faces.flatMap((f) =>
        part.state.lookup(withChain(f.hash, [step], ev.names)).filter((e) => e.kind === 'face'),
      );
      if (faces.length === 0) return [];
      return [
        {
          ...thread,
          faces: faces.map((e) => ({ hash: finest(e.ladder), branch: e.branch })),
          start: point(thread.start),
          direction: vector(thread.direction),
        },
      ];
    }),
  );
}

/**
 * Applies the copies with their features' operation and finishes the namer.
 * A joining copy that meets no target pauses: it would be a new body, and a
 * new body made from a copied tool has no naming rule yet.
 */
export function applyFeatureCopies(
  ctx: BuildContext,
  namer: FeatureNamer,
  copies: readonly FeatureCopy[],
  from: FeatureTools,
): void {
  if (copies.length === 0) {
    ctx.part.state = namer.finish([]);
    return;
  }
  if (from.op === 'join') {
    const targets = targetShapes(ctx, from.targets);
    const alone = copies.some(
      ({ live }) => !targets.some((t) => ctx.ev.kernel.distanceBetween(live.handle, t.handle) <= CONTACT),
    );
    if (alone) throw new FeaturePause('a copy of a joining feature that meets no target body is not built yet');
  }
  runOperation(
    ctx,
    namer,
    copies.map(({ live }) => ({ ...live, src: [] })),
    from.op,
    from.targets,
  );
  const threads = copiedThreads(ctx, copies);
  if (threads.length > 0) ctx.part.threads.set(ctx.id, threads);
}
