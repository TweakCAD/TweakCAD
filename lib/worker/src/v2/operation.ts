/**
 * A feature's operation (7.3): its tool bodies become new bodies, or join,
 * cut or intersect target bodies, each kernel boolean one named step.
 */
import { BooleanOp, type EvolutionData, type ShapeHandle } from 'occt-wasm';
import {
  type BodyOutcome,
  type CopyStep,
  type FeatureNamer,
  type OperationHistory,
  type ShapeKey,
  type ShapeRef,
  type SrcFact,
} from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import { FLAG, FeaturePause, TEXT, type BuildContext, type Json } from './context';
import { entitiesOf, membersOrSelf } from './references';

/** One tool body a feature built, already named by the feature's namer. */
export interface Tool {
  shape: ShapeRef;
  handle: ShapeHandle;
  /** The `src` of a new body that holds this tool. */
  src: readonly SrcFact[];
}

export interface Live {
  shape: ShapeRef;
  handle: ShapeHandle;
}

/** Gives each solid of `shape` a shape of its own, so one can be used without the others. */
export function divide(ctx: BuildContext, namer: FeatureNamer, shape: ShapeRef): Map<ShapeKey, Live> {
  const { part, ev } = ctx;
  const live = new Map<ShapeKey, Live>();
  for (const { solid } of ev.adapter.topology(shape).solids) {
    const handle = ev.adapter.handleOf(solid);
    live.set(solid, { shape: ev.adapter.addShape(handle, `solid:${ctx.id}:${solid}`), handle });
  }
  namer.regroup([...live.values()].map((l) => l.shape));
  part.shapes.delete(shape);
  for (const l of live.values()) part.shapes.set(l.shape, l.handle);
  return live;
}

/** The live bodies `refs` name, each as a shape of its own; a body named twice comes once. `what` names them in pauses. */
export function liveBodies(
  ctx: BuildContext,
  namer: FeatureNamer,
  refs: readonly Json[],
  what = 'a target body',
): Live[] {
  const { part, ev } = ctx;
  const out = new Map<ShapeRef, Live>();
  const divided = new Map<ShapeKey, Live>();
  for (const ref of refs.flatMap((r) => membersOrSelf(ctx, r))) {
    // A body of another part is geometry to read, never a body this part can change.
    if ('inContext' in ref) throw new FeaturePause(`${what} lies in another part`);
    for (const e of entitiesOf(ctx, ref, what)) {
      const shape = part.state.bodies.get(e.key);
      if (shape === undefined) throw new FeaturePause(`${what} is not a live body`);
      if (!divided.has(e.key) && ev.adapter.topology(shape).solids.length > 1) {
        for (const [solid, live] of divide(ctx, namer, shape)) divided.set(solid, live);
      }
      const handle = part.shapes.get(shape);
      const live = divided.get(e.key) ?? (handle && { shape, handle });
      if (!live) throw new FeaturePause(`${what} has no shape`);
      out.set(live.shape, live);
    }
  }
  return [...out.values()];
}

/** The target bodies of an operation, as live shapes, one body each. */
export function targetsOf(ctx: BuildContext, namer: FeatureNamer, targets: Json): Live[] {
  const { part, ev } = ctx;
  if ('bodies' in targets) return liveBodies(ctx, namer, (targets.bodies as Json).set as Json[]);
  return [...part.shapes].flatMap(([shape, handle]) =>
    ev.adapter.topology(shape).solids.length > 1 ? [...divide(ctx, namer, shape).values()] : [{ shape, handle }],
  );
}

/** A new shape's history: every face and edge is added. */
export function madeHistory(ctx: BuildContext, shape: ShapeRef): OperationHistory {
  const t = ctx.ev.adapter.topology(shape);
  const none = { kept: [], modified: new Map(), deleted: [] };
  return {
    result: shape,
    inputs: [],
    faces: { ...none, added: t.faces },
    edges: { ...none, added: t.edges.map((e) => e.edge) },
    facesFromFace: new Map(),
    facesFromEdge: new Map(),
  };
}

/** The step a kept tool's copy carries (9.5): the copy the operation of `feature` uses up, the tool itself staying. */
export const keptToolStep = (feature: string): CopyStep => ({ op: { id: feature }, key: { tool: {} } });

/**
 * A copy of `source` where it lies, named with `step`, so an operation can use
 * the copy up while the source stays with its names. A zero translation in
 * the kernel copies every sub-shape, so the copy shares no key with its source.
 */
export function copyInPlace(ctx: BuildContext, namer: FeatureNamer, source: Live, step: CopyStep): Live {
  const { kernel: k, adapter } = ctx.ev;
  const evolution = k.translateWithHistory(source.handle, 0, 0, 0, adapter.faceHashes([source.shape]), HASH_BOUND);
  const history = adapter.history(evolution, [{ shape: source.shape, use: 'target' }]);
  const own = new Set(adapter.topology(source.shape).faces);
  if (adapter.topology(history.result).faces.some((f) => own.has(f)))
    throw new FeaturePause('the kernel shared faces between a tool and its copy');
  namer.copy(history, step);
  return { shape: history.result, handle: evolution.result };
}

/** Two bodies closer than this (mm) meet. */
export const CONTACT = 1e-7;

/** A body whose volume changed by less than this fraction kept its volume through a cut or intersect. */
const SAME_VOLUME = 1e-9;

/** Coplanar and coaxial faces a join leaves level with each other merge within this angle (radians). */
export const REFINE_ANGLE = 1e-6;

/**
 * `tools` fused onto `targets` in one kernel boolean, merging the faces it
 * leaves level with each other. Where the merge leaves an invalid solid (as it
 * can joining spheres over their seam or poles), the fuse runs again without
 * it. A union is never smaller than the largest body in it, so a smaller
 * result has lost one, and pauses.
 */
function refinedFuse(ctx: BuildContext, targets: readonly Live[], tools: readonly Live[]): EvolutionData {
  const { kernel: k, adapter } = ctx.ev;
  const bodies = [...targets, ...tools];
  const fuse = (refine: boolean) =>
    k.booleanOp(
      BooleanOp.Fuse,
      targets.map((t) => t.handle),
      tools.map((t) => t.handle),
      {
        ...(refine ? { simplifyAngularTolerance: REFINE_ANGLE } : {}),
        inputFaceHashes: adapter.faceHashes(bodies.map((b) => b.shape)),
        hashUpperBound: HASH_BOUND,
      },
    );
  let evolution = fuse(true);
  if (!k.isValid(evolution.result)) {
    const plain = fuse(false);
    if (k.isValid(plain.result)) {
      k.release(evolution.result);
      evolution = plain;
    } else {
      k.release(plain.result);
    }
  }
  const largest = Math.max(...bodies.map((b) => Math.abs(k.getVolume(b.handle))));
  if (Math.abs(k.getVolume(evolution.result)) < 0.99 * largest) {
    throw new FeaturePause('the kernel lost a body joining these');
  }
  return evolution;
}

/**
 * One kernel boolean of `a` with `b`, named as a step. A join merges the
 * faces it leaves level with each other (`refinedFuse`); a cut or intersect by a tool
 * divides by its faces, or by `dividers` of them where a tool has so many
 * that telling each piece from all of them is the cost of the feature.
 */
export function namedBoolean(
  ctx: BuildContext,
  namer: FeatureNamer,
  kind: 'fuse' | 'cut' | 'intersect',
  a: Live,
  b: Live,
  use: 'tool' | 'target',
  dividers?: readonly ShapeKey[],
): { live: Live; history: OperationHistory } {
  const evolution = kind === 'fuse' ? refinedFuse(ctx, [a], [b]) : cutEvolution(ctx, kind, a, b);
  return namedStep(ctx, namer, kind, a, b, use, evolution, dividers);
}

/** The kernel cut or intersect of `a` by `b`, not named yet. */
function cutEvolution(ctx: BuildContext, kind: 'cut' | 'intersect', a: Live, b: Live): EvolutionData {
  const { kernel: k, adapter } = ctx.ev;
  const hashes = adapter.faceHashes([a.shape, b.shape]);
  return kind === 'cut'
    ? k.cutWithHistory(a.handle, b.handle, hashes, HASH_BOUND)
    : k.intersectWithHistory(a.handle, b.handle, hashes, HASH_BOUND);
}

/** `evolution`, a kernel boolean of `a` with `b`, named as a step, as `namedBoolean` names it. */
function namedStep(
  ctx: BuildContext,
  namer: FeatureNamer,
  kind: 'fuse' | 'cut' | 'intersect',
  a: Live,
  b: Live,
  use: 'tool' | 'target',
  evolution: EvolutionData,
  dividers?: readonly ShapeKey[],
): { live: Live; history: OperationHistory } {
  const { adapter } = ctx.ev;
  const history = adapter.history(evolution, [
    { shape: a.shape, use: 'target' },
    { shape: b.shape, use },
  ]);
  namer.step(
    history,
    { outputs: [], dividers: use === 'tool' && kind !== 'fuse' ? (dividers ?? adapter.topology(b.shape).faces) : [] },
    'normal',
  );
  return { live: { shape: history.result, handle: evolution.result }, history };
}

/** `tools` fused onto `target` in one kernel boolean (`refinedFuse`), named as one step. */
export function namedJoin(ctx: BuildContext, namer: FeatureNamer, target: Live, tools: readonly Live[]): Live {
  const { adapter } = ctx.ev;
  const evolution = refinedFuse(ctx, [target], tools);
  const history = adapter.history(evolution, [
    { shape: target.shape, use: 'target' },
    ...tools.map((t) => ({ shape: t.shape, use: 'tool' as const })),
  ]);
  namer.step(history, { outputs: [], dividers: [] }, 'normal');
  return { shape: history.result, handle: evolution.result };
}

/**
 * Faces followed through a feature's booleans, by what they stand for: a
 * face the step deleted is dropped, a modified one becomes its images, and
 * one the step did not touch stays.
 */
export class FaceTracker<K> {
  private readonly faces = new Map<K, Set<ShapeKey>>();

  track(key: K, faces: readonly ShapeKey[]): void {
    this.faces.set(key, new Set(faces));
  }

  follow(history: OperationHistory): void {
    const gone = new Set(history.faces.deleted);
    for (const [key, faces] of this.faces) {
      this.faces.set(
        key,
        new Set([...faces].flatMap((f) => (gone.has(f) ? [] : (history.faces.modified.get(f) ?? [f])))),
      );
    }
  }

  /** The tracked keys with a face among `faces`, in tracking order. */
  holding(faces: readonly ShapeKey[]): K[] {
    return [...this.faces].filter(([, held]) => faces.some((f) => held.has(f))).map(([key]) => key);
  }
}

function uniqueSorted(src: readonly SrcFact[]): SrcFact[] {
  const byText = new Map(src.map((f) => [JSON.stringify(f), f]));
  return [...byText.keys()].sort().map((key) => byText.get(key) as SrcFact);
}

/**
 * Applies `operation` to the feature's tools and finishes its namer. Every
 * boolean is named as it happens; a resulting solid then carries the target
 * bodies it holds (a join keeps the earliest-created, a cut's pieces get
 * sides), and a solid holding no target is a new body with the `src` of the
 * tools it holds.
 */
export function applyOperation(ctx: BuildContext, namer: FeatureNamer, tools: Tool[], operation: Json): void {
  const { values } = ctx.ev;
  runOperation(
    ctx,
    namer,
    tools,
    values.literal(operation.op, TEXT) as string,
    operation.targets as Json,
    values.literal(operation.keepTools, FLAG) === true,
  );
}

/**
 * An operation a feature type fixes itself, with no `operation` input: a hole always cuts.
 * With `keep`, a tool the operation would use up stays a new body under the
 * feature's names, and the operation uses up a copy of it made in place
 * (`copyInPlace`, step `keptToolStep`), as `core.boolean` keeps its tools.
 * A cut or intersect whose tool overlaps no target pauses rather than leave
 * a face split where the tool touches it.
 */
export function runOperation(
  ctx: BuildContext,
  namer: FeatureNamer,
  tools: Tool[],
  op: string,
  targetSet: Json,
  keep = false,
): void {
  const { ev, part } = ctx;
  const { adapter } = ev;
  if (tools.length === 0) throw new FeaturePause('the feature made no solid');
  if (!['new', 'join', 'cut', 'intersect'].includes(op)) throw new FeaturePause(`unknown operation ${op}`);
  const targets = op === 'new' ? [] : targetsOf(ctx, namer, targetSet);
  const solidsOf = (shape: ShapeRef) => adapter.topology(shape).solids;

  // Each tool and each target is told by its faces, followed through every boolean.
  const tracker = new FaceTracker<Tool | Live>();
  for (const t of [...tools, ...targets]) tracker.track(t, adapter.topology(t.shape).faces);
  const boolean = (kind: 'fuse' | 'cut' | 'intersect', a: Live, b: Live, use: 'tool' | 'target'): Live => {
    const { live, history } = namedBoolean(ctx, namer, kind, a, b, use);
    tracker.follow(history);
    return live;
  };
  const isTool = new Set<Tool | Live>(tools);
  const isTarget = new Set<Tool | Live>(targets);
  const created = (solid: { solid: ShapeKey; faces: readonly ShapeKey[] }): BodyOutcome => {
    const inside = tracker.holding(solid.faces).filter((t): t is Tool => isTool.has(t));
    if (inside.length === 0) throw new FeaturePause('a solid of the feature holds none of its tools');
    // A new body's `src` is the set of what its tools came from (9.4), sorted.
    return { solid: solid.solid, from: { create: uniqueSorted(inside.flatMap((t) => t.src)) } };
  };

  // Several tools of one feature are one tool: fused, their merges named by creation key.
  let tool: Live = tools[0] as Live;
  for (const next of tools.slice(1)) tool = boolean('fuse', tool, next, 'target');
  // Kept with its names, so a feature pattern can apply copies of it.
  const recorded = {
    shape: tool.shape,
    handle: tool.handle,
    op,
    targets: targetSet,
    names: namer.namesOf(tool.shape),
    ordinal: ctx.ordinal,
    keepTools: keep,
  };

  const outcomes: BodyOutcome[] = [];
  const asNewBody = () => {
    for (const solid of solidsOf(tool.shape)) outcomes.push(created(solid));
    part.shapes.set(tool.shape, tool.handle);
  };
  /** The tool the operation uses up: with `keep`, a copy of it in place, the tool staying a body; else the tool. */
  const usedUp = (): Live => {
    if (!keep) return tool;
    asNewBody();
    const copy: Tool = {
      ...copyInPlace(ctx, namer, tool, keptToolStep(ctx.id)),
      src: uniqueSorted(tools.flatMap((t) => t.src)),
    };
    tracker.track(copy, adapter.topology(copy.shape).faces);
    isTool.add(copy);
    return copy;
  };
  if (op === 'new' || (op === 'join' && targets.length === 0)) {
    asNewBody();
  } else if (op === 'join') {
    // The tool joins the targets it meets; a target it does not meet stays as it was, even where it touches one that joins.
    const met = targets.filter((t) => ev.kernel.distanceBetween(tool.handle, t.handle) <= CONTACT);
    // A tool that meets no target is a new body, kept or not.
    let acc = met.length > 0 ? usedUp() : tool;
    for (const target of met) {
      acc = boolean('fuse', target, acc, 'tool');
      part.shapes.delete(target.shape);
    }
    const solids = solidsOf(acc.shape);
    const carried = solids.map((solid) => tracker.holding(solid.faces).filter((t) => isTarget.has(t)));
    // A target the tool swallows whole keeps no face: it lives on in the solid that holds it.
    for (const target of met) {
      if (carried.some((c) => c.includes(target))) continue;
      const i = solids.findIndex((s) => ev.kernel.distanceBetween(adapter.handleOf(s.solid), target.handle) <= CONTACT);
      if (i >= 0) (carried[i] as (Tool | Live)[]).push(target);
    }
    solids.forEach((solid, i) => {
      const held = carried[i] as (Tool | Live)[];
      outcomes.push(
        held.length > 0 ? { solid: solid.solid, from: { carry: held.map((t) => t.shape) } } : created(solid),
      );
    });
    part.shapes.set(acc.shape, acc.handle);
  } else {
    const kind = op === 'cut' ? 'cut' : 'intersect';
    const used = targets.length > 0 ? usedUp() : tool;
    // Whether the tool overlaps a target, told by volume: a cut takes some away, an intersect keeps some.
    let overlaps = false;
    for (const target of targets) {
      const evolution = cutEvolution(ctx, kind, target, used);
      const before = Math.abs(ev.kernel.getVolume(target.handle));
      const after = Math.abs(ev.kernel.getVolume(evolution.result));
      const overlap = kind === 'cut' ? after < before * (1 - SAME_VOLUME) : after > before * SAME_VOLUME;
      overlaps ||= overlap;
      // A tool that only touches a target takes nothing away: the target stays as it was, not split where touched.
      if (kind === 'cut' && !overlap && ev.kernel.distanceBetween(target.handle, used.handle) <= CONTACT) {
        ev.kernel.release(evolution.result);
        continue;
      }
      const { live: result, history } = namedStep(ctx, namer, kind, target, used, 'tool', evolution);
      tracker.follow(history);
      part.shapes.delete(target.shape);
      const solids = solidsOf(result.shape);
      for (const solid of solids) outcomes.push({ solid: solid.solid, from: { carry: [target.shape] } });
      if (solids.length > 0) part.shapes.set(result.shape, result.handle);
    }
    if (!overlaps) throw new FeaturePause('no target body found to cut or intersect');
  }
  part.state = namer.finish(outcomes);
  part.tools.set(ctx.id, recorded);
}
