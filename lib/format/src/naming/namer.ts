import { canonicalBytes, canonicalize, type JsonValue } from '../canonical';
import { compareBytes } from '../collections';
import type { NameTable } from '../names';
import type {
  BodyOutcome,
  BuilderReport,
  KernelFacts,
  OperationHistory,
  ShapeKey,
  ShapeRef,
  ShapeTopology,
  SrcFact,
} from './facts';
import {
  finest,
  idItem,
  indexItem,
  itemSet,
  ladderOf,
  nameItem,
  textItem,
  usesItem,
  withChain,
  type BranchEntry,
  type CopyStep,
  type EntityKey,
  type EntityKind,
  type Naming,
  type SideEntry,
  type SrcItem,
} from './names';
import { checkShapeMap, readShapeMap, type ShapeMapJson } from './shapeMap';
import { NamedState, type NamedEntity } from './state';

/** A situation the spec resolves by pausing the feature (9.6). */
export class NamingPause extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NamingPause';
  }
}

/** How a step's dividers are signed (9.6 Sides). */
export type DividerTest = 'solid' | 'normal';

export interface FeatureNamer {
  /** One kernel operation of the feature, with what only the builder knows. */
  step(history: OperationHistory, report: BuilderReport, test?: DividerTest): void;
  /**
   * A copy of a live shape (pattern, mirror, derive): every name of the
   * source gets `step` appended to its chain at every level, its `src` kept.
   * The source stays live. With `recorded`, the source's names are those
   * `namesOf` gave in an earlier feature: a feature pattern copies a tool that
   * feature consumed.
   */
  copy(history: OperationHistory, step: CopyStep, recorded?: ReadonlyMap<ShapeKey, NamedEntity>): void;
  /** The names the sub-shapes of `shape` carry at this point of the feature. */
  namesOf(shape: ShapeRef): ReadonlyMap<ShapeKey, NamedEntity>;
  /**
   * A stored shape (import, frozen effect, captured instance): its sub-shapes
   * take the identities in `map`, its solids become bodies. Pauses when the map
   * fails the 13.2 load check, by the stored shape's `fingerprint` when it has
   * one. `finish` takes no outcome for these bodies.
   */
  load(shape: ShapeRef, map: ShapeMapJson, fingerprint?: string): void;
  /** A live shape leaves the state: a frozen `remove`, or the body a frozen `modify` replaces. */
  retire(shape: ShapeRef): void;
  /** Sub-shapes of a live shape move, keys and names unchanged, into these shapes: its solids taken apart. */
  regroup(parts: readonly ShapeRef[]): void;
  /** Names edges, vertices and bodies, and returns the state after the feature. */
  finish(bodies: readonly BodyOutcome[]): NamedState;
}

export interface FeatureContext {
  /** The feature's id. */
  feature: string;
  /** The feature's place in the build, lower is earlier. */
  ordinal: number;
  /** Copy steps the names carry (9.5); empty outside patterns and copies. */
  chain?: readonly CopyStep[];
}

/** Compares two ladders by the creation key (9.4): coarsest differing level, then shorter first. */
export function compareCreation(a: NamedEntity, b: NamedEntity): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  const n = Math.min(a.ladder.length, b.ladder.length);
  for (let i = 0; i < n; i++) {
    const x = a.ladder[i] as string;
    const y = b.ladder[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.ladder.length - b.ladder.length;
}

function key(e: NamedEntity): EntityKey {
  return { hash: finest(e.ladder), branch: e.branch };
}

/** The identity of an edge's or vertex's `src`, as `NamedState.producers` keys it. */
function producerId(kind: EntityKind, chain: readonly CopyStep[], role: string, src: readonly SrcItem[]): string {
  return canonicalize({ kind, chain: chain as unknown as JsonValue, role, src: src as unknown as JsonValue });
}

function chainOf(hash: string, names: NameTable): readonly CopyStep[] {
  return (names.get(hash) as { chain?: CopyStep[] } | undefined)?.chain ?? [];
}

/**
 * The copy steps every name in `hashes` ends with, and each hash without them.
 * Copying only appends steps, so these undo it: an edge or vertex of a copy
 * rebuilt by a later step gets back the name the copy gave it (9.4, 9.5).
 */
function sharedSteps(
  hashes: readonly string[],
  names: NameTable,
): { steps: readonly CopyStep[]; source: (hash: string) => string } {
  const chains = hashes.map((h) => chainOf(h, names));
  const first = chains[0] ?? [];
  const stepKey = (chain: readonly CopyStep[], back: number) =>
    canonicalize(chain[chain.length - 1 - back] as unknown as JsonValue);
  let n = 0;
  while (n < first.length && chains.every((c) => c.length > n && stepKey(c, n) === stepKey(first, n))) n++;
  if (n === 0) return { steps: [], source: (hash) => hash };
  const source = (hash: string) => {
    const chain = chainOf(hash, names);
    return names.intern({
      ...(names.get(hash) as object),
      chain: chain.slice(0, chain.length - n),
    } as unknown as JsonValue);
  };
  return { steps: first.slice(first.length - n), source };
}

/** Starts naming one feature's outputs from the state before it (spec 9.3–9.5). */
export function startFeature(
  before: NamedState,
  context: FeatureContext,
  facts: KernelFacts,
  names: NameTable,
): FeatureNamer {
  const { feature, ordinal } = context;
  const chain = context.chain ?? [];
  const entities = new Map(before.entities);
  const bodies = new Map(before.bodies);
  const splits = new Set(before.splits);
  const producers = new Map(before.producers);
  /** Result shapes of this feature not consumed by a later step. */
  const results = new Set<ShapeRef>();
  /** Input body entities consumed by this feature, by shape. */
  const consumedBodies = new Map<ShapeRef, NamedEntity[]>();
  /** Edges split by a step: result edge → the divider faces and test of that step. */
  const splitEdges = new Map<ShapeKey, { dividers: readonly ShapeKey[]; test: DividerTest; from: NamedEntity }>();
  /** Names of the faces of each input edge, for blends standing in for them. */
  const edgeFaceNames = new Map<ShapeKey, string[]>();
  /** Divider face names stay valid after their step consumed them. */
  const retiredNames = new Map<ShapeKey, NamedEntity>();
  /** Copies and loaded shapes are named by `copy` and `load`; `finish` leaves them alone. */
  const copies = new Set<ShapeRef>();
  /** Tool shapes of booleans, dropped when the feature finishes. */
  const tools = new Set<ShapeRef>();
  /** Every step's dividers, for body pieces. */
  const allDividers: { dividers: readonly ShapeKey[]; test: DividerTest }[] = [];

  const entityOf = (k: ShapeKey): NamedEntity | undefined => entities.get(k) ?? retiredNames.get(k);

  const name = (naming: Naming, body: ShapeRef, k: ShapeKey, extra: Partial<NamedEntity> = {}): NamedEntity => ({
    key: k,
    kind: naming.kind,
    ladder: ladderOf(naming, names),
    branch: [],
    aliases: [],
    standsFor: [],
    body,
    createdBy: feature,
    createdAt: ordinal,
    ...extra,
  });

  const srcItem = (fact: SrcFact): SrcItem => {
    if ('id' in fact) return idItem(fact.id);
    if ('index' in fact) return indexItem(fact.index);
    if ('text' in fact) return textItem(fact.text);
    const e = entityOf(fact.entity);
    if (!e) throw new Error(`the builder named sub-shape ${fact.entity}, which has no name`);
    return nameItem(finest(e.ladder));
  };

  const sides = (k: ShapeKey, dividers: readonly ShapeKey[], test: DividerTest): SideEntry[] => {
    const point = facts.samplePoint(k);
    if (point === null) throw new NamingPause(`no sample point inside sub-shape ${k}`);
    const out: SideEntry[] = [];
    for (const d of dividers) {
      const divider = entityOf(d);
      if (!divider) continue;
      const sign = facts.side(point, d, test);
      // A sample point in the divider's own surface writes no entry (9.6 Sides).
      if (sign === 0) continue;
      if (sign === null)
        throw new NamingPause('the closest points of a divider disagree, so the piece has no defined side');
      out.push({ of: finest(divider.ladder), sign });
    }
    return out.sort((a, b) => (a.of < b.of ? -1 : a.of > b.of ? 1 : 0));
  };

  const withBranch = (e: NamedEntity, entry: BranchEntry): NamedEntity => ({
    ...e,
    branch: [...e.branch.filter((b) => b.split !== feature), entry],
  });

  /** The `branch` entries an entity made from `src` inherits, in `src` order, one per split (9.4). */
  const inheritedFrom = (src: readonly SrcFact[]): BranchEntry[] => {
    const out: BranchEntry[] = [];
    for (const fact of src) {
      if (!('entity' in fact)) continue;
      for (const b of entityOf(fact.entity)?.branch ?? []) if (!out.some((x) => x.split === b.split)) out.push(b);
    }
    return out;
  };

  const forget = (topology: ShapeTopology) => {
    for (const f of topology.faces) {
      const e = entities.get(f);
      if (e) retiredNames.set(f, e);
      entities.delete(f);
    }
    for (const edge of topology.edges) {
      const e = entities.get(edge.edge);
      if (e) retiredNames.set(edge.edge, e);
      entities.delete(edge.edge);
    }
    for (const v of topology.vertices) entities.delete(v.vertex);
    for (const s of topology.solids) entities.delete(s.solid);
  };

  return {
    step(history, report, test = 'normal') {
      const inputTopologies = history.inputs.map((input) => ({ input, topology: facts.topology(input.shape) }));
      const targetBodies = new Set(history.inputs.filter((i) => i.use === 'target').map((i) => i.shape));

      // Faces of each input edge, for blends that stand in for them.
      for (const { topology } of inputTopologies) {
        for (const edge of topology.edges) {
          const faceNames = edge.faces
            .map((f) => entities.get(f.face))
            .filter((e): e is NamedEntity => e !== undefined)
            .map((e) => finest(e.ladder));
          edgeFaceNames.set(edge.edge, faceNames);
        }
      }

      if (report.dividers.length > 0) allDividers.push({ dividers: report.dividers, test });
      const kept = new Set(history.faces.kept);
      const result = facts.topology(history.result);
      const reported = new Map(report.outputs.map((o) => [o.entity, o]));
      const sourcesOf = new Map<ShapeKey, ShapeKey[]>();
      for (const [from, to] of history.faces.modified) {
        for (const t of to) sourcesOf.set(t, [...(sourcesOf.get(t) ?? []), from]);
      }
      // A face generated from one input face that the operation removed is that
      // face changed (a drafted wall): one input became it. Generated beside a
      // face that stays (a shell's inner wall), it is new.
      const removed = new Set(history.faces.deleted);
      for (const [from, to] of history.facesFromFace) {
        if (removed.has(from)) for (const t of to) sourcesOf.set(t, [...(sourcesOf.get(t) ?? []), from]);
      }
      // A face a builder says carries on another is that one merged with what it was, even when kept as it was.
      const continued = new Set<ShapeKey>();
      for (const c of report.continued ?? []) {
        const own = kept.has(c.entity) && !continued.has(c.entity) ? [c.entity] : [];
        sourcesOf.set(c.entity, [...(sourcesOf.get(c.entity) ?? []), ...own, c.from]);
        continued.add(c.entity);
      }
      const named = new Map<ShapeKey, NamedEntity>();

      for (const f of result.faces) {
        const output = reported.get(f);
        if (output) {
          const src = output.src.map(srcItem);
          const standsFor = output.src.flatMap((s) => ('entity' in s ? (edgeFaceNames.get(s.entity) ?? []) : []));
          named.set(
            f,
            name({ kind: 'face', chain, feature, role: output.role, src }, history.result, f, {
              standsFor,
              branch: inheritedFrom(output.src),
            }),
          );
          continue;
        }
        if (kept.has(f) && entities.has(f) && !continued.has(f)) {
          named.set(f, { ...(entities.get(f) as NamedEntity), body: history.result });
          continue;
        }
        const sources = (sourcesOf.get(f) ?? [])
          .map((s) => ({ s, e: entityOf(s) }))
          .filter((x): x is { s: ShapeKey; e: NamedEntity } => x.e !== undefined);
        if (sources.length === 1) {
          const { s, e } = sources[0] as { s: ShapeKey; e: NamedEntity };
          const images = history.faces.modified.get(s) ?? [];
          let next: NamedEntity = { ...e, key: f, body: history.result };
          if (images.length > 1) {
            next = withBranch(next, { split: feature, side: [] });
            named.set(f, next);
            continue;
          }
          named.set(f, next);
          continue;
        }
        if (sources.length > 1) {
          // A merge: a target body's face survives; among several, the earliest created.
          const ranked = [...sources].sort((a, b) => {
            const at = targetBodies.has(a.e.body) ? 0 : 1;
            const bt = targetBodies.has(b.e.body) ? 0 : 1;
            return at - bt || compareCreation(a.e, b.e);
          });
          const [survivor, ...others] = ranked.map((x) => x.e) as [NamedEntity, ...NamedEntity[]];
          const aliases = [...survivor.aliases, ...others.flatMap((o) => [key(o), ...o.aliases])];
          named.set(f, { ...survivor, key: f, body: history.result, aliases });
          continue;
        }
        named.set(f, name({ kind: 'face', chain, feature }, history.result, f));
      }

      // Pieces get their sides once every face of the result is known.
      for (const [f, e] of named) {
        const entry = e.branch.find((b) => b.split === feature);
        if (entry && entry.side.length === 0 && report.dividers.length > 0) {
          named.set(f, withBranch(e, { split: feature, side: sides(f, report.dividers, test) }));
        }
      }
      if ([...named.values()].some((e) => e.branch.some((b) => b.split === feature))) splits.add(feature);

      for (const [from, to] of history.edges.modified) {
        const e = entities.get(from);
        if (e && to.length > 1) for (const t of to) splitEdges.set(t, { dividers: report.dividers, test, from: e });
      }

      for (const { input, topology } of inputTopologies) {
        // A tool outlives a boolean, and may be used by the next step of the
        // same feature, so its names stay until the feature finishes.
        if (input.use === 'tool' && !results.has(input.shape)) {
          tools.add(input.shape);
          continue;
        }
        for (const s of topology.solids) {
          const body = entities.get(s.solid);
          if (body) consumedBodies.set(input.shape, [...(consumedBodies.get(input.shape) ?? []), body]);
          bodies.delete(s.solid);
        }
        forget(topology);
        results.delete(input.shape);
      }
      for (const [f, e] of named) entities.set(f, e);
      results.add(history.result);
    },

    copy(history, step, recorded) {
      const named: ReadonlyMap<ShapeKey, NamedEntity> = recorded ?? entities;
      const rehash = (h: string): string => withChain(h, [step], names);
      const copied = (e: NamedEntity, k: ShapeKey): NamedEntity => {
        const ladder = e.ladder.map(rehash);
        if (e.kind === 'edge' || e.kind === 'vertex') {
          const level = names.get(finest(ladder)) as unknown as {
            chain: CopyStep[];
            feature: { id: string };
            role: string;
            src?: SrcItem[];
          };
          producers.set(producerId(e.kind, level.chain, level.role, level.src ?? []), level.feature.id);
        }
        return {
          ...e,
          key: k,
          body: history.result,
          ladder,
          aliases: e.aliases.map((a) => ({ hash: rehash(a.hash), branch: a.branch })),
          standsFor: e.standsFor.map(rehash),
          createdBy: feature,
          createdAt: ordinal,
        };
      };
      const image = new Map<ShapeKey, ShapeKey>();
      for (const h of [history.faces, history.edges]) {
        for (const [from, to] of h.modified) {
          const target = to[0];
          if (to.length !== 1 || target === undefined) continue;
          image.set(from, target);
          const e = named.get(from);
          if (e) entities.set(target, copied(e, target));
        }
      }
      // Vertices and solids pair through the faces and edges around them.
      const source = history.inputs[0]?.shape;
      if (source !== undefined) {
        const signature = (keys: readonly ShapeKey[]) => [...keys].sort((a, b) => a - b).join(',');
        const before = facts.topology(source);
        const after = facts.topology(history.result);
        const vertexBySignature = new Map(after.vertices.map((v) => [signature([...v.faces, ...v.edges]), v.vertex]));
        for (const v of before.vertices) {
          const target = vertexBySignature.get(signature([...v.faces, ...v.edges].map((k) => image.get(k) ?? -1)));
          const e = named.get(v.vertex);
          if (e && target !== undefined) entities.set(target, copied(e, target));
        }
        const solidBySignature = new Map(after.solids.map((sol) => [signature(sol.faces), sol.solid]));
        for (const sol of before.solids) {
          const target = solidBySignature.get(signature(sol.faces.map((k) => image.get(k) ?? -1)));
          const e = named.get(sol.solid);
          if (e && target !== undefined) {
            entities.set(target, copied(e, target));
            bodies.set(target, history.result);
          }
        }
      }
      copies.add(history.result);
      results.add(history.result);
    },

    namesOf(shape) {
      const { faces, edges, vertices, solids } = facts.topology(shape);
      const out = new Map<ShapeKey, NamedEntity>();
      for (const k of [
        ...faces,
        ...edges.map((e) => e.edge),
        ...vertices.map((v) => v.vertex),
        ...solids.map((s) => s.solid),
      ]) {
        const e = entities.get(k);
        if (e) out.set(k, e);
      }
      return out;
    },

    load(shape, map, fingerprint) {
      const mismatch = checkShapeMap(map, shape, facts, fingerprint);
      if (mismatch) {
        throw new NamingPause(
          `shape map ${mismatch.field} disagrees with stored shape ${shape} at ${mismatch.index ?? 'its length'}`,
        );
      }
      const loaded = readShapeMap(map, shape, facts, names);
      for (const e of loaded.entities) {
        // A body a frozen `modify` replaces keeps its place in creation order.
        const earlier = before.lookup(finest(e.ladder)).find((b) => b.kind === e.kind);
        entities.set(e.key, {
          ...e,
          createdBy: earlier?.createdBy ?? feature,
          createdAt: earlier?.createdAt ?? ordinal,
        });
        if (e.kind === 'body') bodies.set(e.key, shape);
      }
      for (const split of loaded.splits) splits.add(split);
      for (const [id, by] of loaded.producers) if (!producers.has(id)) producers.set(id, by);
      copies.add(shape);
      results.add(shape);
    },

    retire(shape) {
      const topology = facts.topology(shape);
      for (const s of topology.solids) bodies.delete(s.solid);
      forget(topology);
      results.delete(shape);
    },

    regroup(parts) {
      for (const part of parts) {
        const { faces, edges, vertices, solids } = facts.topology(part);
        for (const k of [
          ...faces,
          ...edges.map((e) => e.edge),
          ...vertices.map((v) => v.vertex),
          ...solids.map((s) => s.solid),
        ]) {
          const e = entities.get(k);
          if (e) entities.set(k, { ...e, body: part });
        }
        for (const s of solids) bodies.set(s.solid, part);
      }
    },

    finish(outcomes) {
      for (const tool of tools) {
        const topology = facts.topology(tool);
        for (const s of topology.solids) bodies.delete(s.solid);
        // A face the operation left whole lives on, under the same key, in its result.
        forget({ ...topology, faces: topology.faces.filter((f) => entities.get(f)?.body === tool) });
      }
      for (const shape of results) {
        if (copies.has(shape)) continue;
        const topology = facts.topology(shape);
        const faceName = (f: ShapeKey) => {
          const e = entities.get(f);
          return e ? finest(e.ladder) : undefined;
        };
        const produced = (kind: EntityKind, steps: readonly CopyStep[], role: string, src: SrcItem[]) => {
          const id = producerId(kind, steps, role, src);
          let by = producers.get(id);
          if (by === undefined) {
            by = feature;
            producers.set(id, by);
          }
          return by;
        };
        /**
         * The branch entries of an edge's or vertex's faces, taken in `uses`
         * order (the canonical order of the faces' names as `src` writes them,
         * then of their branches), one per split feature (9.4); never in the
         * kernel's adjacency order.
         */
        const inherited = (faces: readonly ShapeKey[], source: (hash: string) => string): BranchEntry[] => {
          const named = faces
            .map((f) => entities.get(f))
            .filter((e): e is NamedEntity => e !== undefined)
            .map((e) => ({
              name: canonicalBytes(source(finest(e.ladder))),
              branch: canonicalBytes(e.branch as unknown as JsonValue),
              entries: e.branch,
            }))
            .sort((a, b) => compareBytes(a.name, b.name) || compareBytes(a.branch, b.branch));
          const out: BranchEntry[] = [];
          for (const { entries } of named) {
            for (const b of entries) if (!out.some((x) => x.split === b.split)) out.push(b);
          }
          return out;
        };

        for (const edge of topology.edges) {
          const faces = edge.faces.map((f) => f.face);
          const shared = sharedSteps(
            faces.map(faceName).filter((n): n is string => n !== undefined),
            names,
          );
          const steps = [...chain, ...shared.steps];
          let role = 'edge';
          let src: SrcItem[];
          if (edge.form === 'normal') {
            const counted = edge.faces.flatMap((f) => {
              const n = faceName(f.face);
              return n === undefined ? [] : f.count === 2 ? [n, n] : [n];
            });
            src = [usesItem(counted.map(shared.source))];
          } else {
            const onCone = faces.some((f) => facts.measures(f).surface === 'cone');
            role = edge.form === 'seam' ? 'seam' : onCone ? 'apex' : 'pole';
            src = faces
              .map(faceName)
              .filter((n): n is string => n !== undefined)
              .map((n) => nameItem(shared.source(n)));
          }
          const by = produced('edge', steps, role, src);
          let entity = name({ kind: 'edge', chain: steps, feature: by, role, src }, shape, edge.edge, {
            branch: inherited(faces, shared.source),
          });
          const split = splitEdges.get(edge.edge);
          if (split && !entity.branch.some((b) => b.split === feature)) {
            entity = withBranch(entity, { split: feature, side: sides(edge.edge, split.dividers, split.test) });
          }
          entities.set(edge.edge, entity);
        }

        for (const v of topology.vertices) {
          const around = [...v.faces, ...v.edges]
            .map((k) => entities.get(k))
            .filter((e): e is NamedEntity => e !== undefined)
            .map((e) => finest(e.ladder));
          const shared = sharedSteps(around, names);
          const steps = [...chain, ...shared.steps];
          const src = itemSet(around.map((n) => nameItem(shared.source(n))));
          const by = produced('vertex', steps, 'vertex', src);
          entities.set(
            v.vertex,
            name({ kind: 'vertex', chain: steps, feature: by, role: 'vertex', src }, shape, v.vertex, {
              branch: inherited(v.faces, shared.source),
            }),
          );
        }
      }

      // Bodies.
      const shapeOf = new Map<ShapeKey, ShapeRef>();
      for (const shape of results) for (const s of facts.topology(shape).solids) shapeOf.set(s.solid, shape);
      const carriedFrom = new Map<string, number>();
      for (const outcome of outcomes) {
        if ('carry' in outcome.from) {
          const k = outcome.from.carry.join('\u0000');
          carriedFrom.set(k, (carriedFrom.get(k) ?? 0) + 1);
        }
      }
      for (const outcome of outcomes) {
        const shape = shapeOf.get(outcome.solid);
        if (shape === undefined) throw new Error(`solid ${outcome.solid} is not in a result of this feature`);
        let entity: NamedEntity;
        if ('create' in outcome.from) {
          const src = outcome.from.create.map(srcItem);
          entity = name({ kind: 'body', chain, feature, role: 'body', src }, shape, outcome.solid);
        } else if ('same' in outcome.from) {
          const { same } = outcome.from;
          const input = [...consumedBodies.values()].flat().find((b) => b.key === same);
          if (!input) throw new Error(`solid ${same} is not a body this feature consumed`);
          entity = { ...input, key: outcome.solid, body: shape };
        } else {
          const inputs = outcome.from.carry.flatMap((s) => consumedBodies.get(s) ?? []).sort(compareCreation);
          const [survivor, ...others] = inputs;
          if (!survivor) {
            entity = name({ kind: 'body', chain, feature }, shape, outcome.solid);
          } else {
            const aliases = [...survivor.aliases, ...others.flatMap((o) => [key(o), ...o.aliases])];
            entity = { ...survivor, key: outcome.solid, body: shape, aliases };
            const pieces = carriedFrom.get(outcome.from.carry.join('\u0000')) ?? 1;
            if (inputs.length === 1 && pieces > 1) {
              const side = allDividers.flatMap((d) => sides(outcome.solid, d.dividers, d.test));
              entity = withBranch(entity, { split: feature, side });
              splits.add(feature);
            }
          }
        }
        entities.set(outcome.solid, entity);
        bodies.set(outcome.solid, shape);
      }
      return new NamedState(entities, bodies, splits, producers);
    },
  };
}
