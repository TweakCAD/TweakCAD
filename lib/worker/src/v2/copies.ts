/**
 * Rigid copies of live bodies, shared by `core.pattern`, `core.mirror` and
 * `core.move`: the bodies a feature copies, its rigid motions with history,
 * and how the copies enter the part. A copy keeps the name of its source
 * with the copy step in `chain` (9.5), so it never takes a new-body name.
 */
import {
  type CopyStep,
  type FeatureNamer,
  type NamedEntity,
  type OperationHistory,
  type ShapeKey,
  type ShapeRef,
  type SubShapeHistory,
} from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import { FLAG, FeaturePause, TEXT, kv, norm, type BuildContext, type Json, type V3 } from './context';
import {
  CONTACT,
  FaceTracker,
  copyInPlace,
  keptToolStep,
  liveBodies,
  namedBoolean,
  targetsOf,
  type Live,
} from './operation';

/** Coplanar faces within this angle, in radians, merge when a join refines its result. */

/** A rigid motion: an optional turn about a line, then an optional translation. */
export interface Motion {
  turn?: { point: V3; direction: V3; radians: number };
  shift?: V3;
}

/** The bodies a feature copies, each as a shape of its own; other kinds of `of` pause. */
export function sourcesOf(ctx: BuildContext, namer: FeatureNamer, of: Json, what: string): Live[] {
  if ('features' in of) throw new FeaturePause(`${what} of features are not built yet`);
  if ('faces' in of) throw new FeaturePause(`${what} of faces are not built yet`);
  return liveBodies(ctx, namer, (of.bodies as Json).set as Json[], 'a source body');
}

/** Runs a motion on `source`: one kernel history per part of it, none for no motion. */
export function runMotion(
  ctx: BuildContext,
  source: Live,
  motion: Motion,
): { histories: OperationHistory[]; moved: Live } {
  const { kernel: k, adapter } = ctx.ev;
  const histories: OperationHistory[] = [];
  let at = source;
  const record = (evolution: ReturnType<typeof k.translateWithHistory>) => {
    const history = adapter.history(evolution, [{ shape: at.shape, use: 'target' }]);
    histories.push(history);
    at = { shape: history.result, handle: evolution.result };
  };
  const { turn, shift } = motion;
  if (turn && turn.radians !== 0) {
    const axis = { point: kv(turn.point), direction: kv(turn.direction) };
    record(k.rotateWithHistory(at.handle, axis, turn.radians, adapter.faceHashes([at.shape]), HASH_BOUND));
  }
  if (shift && norm(shift) !== 0) {
    record(k.translateWithHistory(at.handle, shift[0], shift[1], shift[2], adapter.faceHashes([at.shape]), HASH_BOUND));
  }
  return { histories, moved: at };
}

function composeKind(first: SubShapeHistory, second: SubShapeHistory): SubShapeHistory {
  const modified = new Map<ShapeKey, ShapeKey[]>();
  for (const [from, to] of first.modified)
    modified.set(
      from,
      to.flatMap((t) => second.modified.get(t) ?? []),
    );
  return { kept: [], modified, deleted: [], added: [] };
}

/**
 * Two motions of one copy as one history from the source to the last result,
 * so a copy is named the same whether its placement turns, shifts or does both.
 */
export function composed(histories: readonly OperationHistory[]): OperationHistory {
  const [first, ...rest] = histories as [OperationHistory, ...OperationHistory[]];
  return rest.reduce(
    (a, b) => ({ ...a, result: b.result, faces: composeKind(a.faces, b.faces), edges: composeKind(a.edges, b.edges) }),
    first,
  );
}

/** A copy of `source` placed by `motion`, named with `step`; with `recorded`, from those names of a consumed source (`FeatureNamer.copy`). */
export function copyByMotion(
  ctx: BuildContext,
  namer: FeatureNamer,
  source: Live,
  motion: Motion,
  step: CopyStep,
  recorded?: ReadonlyMap<ShapeKey, NamedEntity>,
): Live {
  const { histories, moved } = runMotion(ctx, source, motion);
  if (histories.length === 0) throw new FeaturePause('a copy lands exactly on its source');
  namer.copy(composed(histories), step, recorded);
  return moved;
}

/**
 * Applies a copying feature's `operation`. `new` leaves every copy a body of
 * its own; `join` fuses the copies into the targets they meet, each resulting solid
 * carrying the bodies it holds, so a copy that touches no target stays a
 * body under its own name. With `keepTools` every copy stays a body, and a
 * copy of each one that meets a target, made in place (`copyInPlace`), joins
 * in its stead. Finishes the namer.
 */
export function applyToCopies(ctx: BuildContext, namer: FeatureNamer, made: readonly Live[], operation: Json): void {
  const { part, ev } = ctx;
  const { adapter, values } = ev;
  const op = values.literal(operation.op, TEXT);
  if (op === 'cut' || op === 'intersect')
    throw new FeaturePause(`a copying feature with operation ${op} is not built yet`);
  const keep = values.literal(operation.keepTools, FLAG) === true;
  const meets = (c: Live, t: Live) => ev.kernel.distanceBetween(c.handle, t.handle) <= CONTACT;
  let copies = made;
  // The copies join the targets they meet; a target no copy meets stays as it was.
  const all = op === 'join' && copies.length > 0 ? targetsOf(ctx, namer, operation.targets as Json) : [];
  const targets = all.filter((t) => copies.some((c) => meets(c, t)));
  if (targets.length === 0) {
    part.state = namer.finish([]);
    for (const copy of copies) part.shapes.set(copy.shape, copy.handle);
    return;
  }
  if (keep) {
    for (const copy of made) part.shapes.set(copy.shape, copy.handle);
    copies = made
      .filter((c) => targets.some((t) => meets(c, t)))
      .map((c) => copyInPlace(ctx, namer, c, keptToolStep(ctx.id)));
  }

  // The faces still holding each input body, followed through the fuses.
  const tracker = new FaceTracker<ShapeRef>();
  for (const b of [...targets, ...copies]) tracker.track(b.shape, adapter.topology(b.shape).faces);
  const fuse = (a: Live, b: Live, use: 'target' | 'tool'): Live => {
    const { live, history } = namedBoolean(ctx, namer, 'fuse', a, b, use);
    tracker.follow(history);
    return live;
  };
  let acc = targets[0] as Live;
  for (const target of targets.slice(1)) acc = fuse(acc, target, 'target');
  for (const copy of copies) acc = fuse(acc, copy, 'tool');

  const outcomes = adapter.topology(acc.shape).solids.map((solid) => ({
    solid: solid.solid,
    from: { carry: tracker.holding(solid.faces) },
  }));
  part.state = namer.finish(outcomes);
  for (const target of targets) part.shapes.delete(target.shape);
  part.shapes.set(acc.shape, acc.handle);
}
