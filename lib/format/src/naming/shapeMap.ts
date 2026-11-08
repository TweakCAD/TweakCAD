import { canonicalize, type JsonValue } from '../canonical';
import { makeSet, type JsonSet } from '../collections';
import type { NameTable } from '../names';
import type { KernelFacts, ShapeRef, SubShape } from './facts';
import {
  finest,
  withChain,
  type BranchEntry,
  type CopyStep,
  type EntityKey,
  type EntityKind,
  type SideEntry,
} from './names';
import {
  describeEdge,
  describeFace,
  describeVertex,
  diagonal,
  loadTolerance,
  matchesSnapshot,
  type Description,
} from './snapshot';
import type { NamedEntity, NamedState } from './state';

/**
 * Shape maps (13.2): the identity of every sub-shape of a stored shape, one
 * entry per sub-shape in index order, so that references made before freezing,
 * capturing or importing still resolve afterwards.
 */

interface BranchJson {
  split: { id: string };
  side: readonly SideEntry[];
}

interface EntityKeyJson {
  hash: string;
  branch: readonly BranchJson[];
}

export interface ShapeMapEntry {
  ladder: readonly string[];
  aliases: JsonSet<EntityKeyJson>;
  branch: readonly BranchJson[];
  snapshot: Record<string, JsonValue>;
  children: JsonSet<number>;
}

export type ShapeMapJson = readonly ShapeMapEntry[];

const branchJson = (branch: readonly BranchEntry[]): BranchJson[] =>
  branch.map((b) => ({ split: { id: b.split }, side: b.side }));

const branchOf = (branch: readonly BranchJson[]): BranchEntry[] =>
  branch.map((b) => ({ split: b.split.id, side: b.side }));

const keyJson = (key: EntityKey): EntityKeyJson => ({ hash: key.hash, branch: branchJson(key.branch) });

function distinct<T>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [canonicalize(item), item])).values()];
}

/**
 * What a sub-shape's entry records of it: the 9.7 measures, plus `geometry` for
 * vertices, edges and faces. Those describe everything; a wire, shell or solid
 * would only repeat them, and is held to them by `children`.
 */
function hasNonFinite(value: JsonValue): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  return Array.isArray(value) && value.some(hasNonFinite);
}

function snapshotOf(sub: SubShape, facts: KernelFacts): Record<string, JsonValue> {
  // A degenerate entity can measure as NaN: such a measure is not recorded, and what is not recorded is not compared.
  const snapshot: Record<string, JsonValue> = Object.fromEntries(
    Object.entries(facts.measures(sub.key) as Record<string, JsonValue>).filter(([, value]) => !hasNonFinite(value)),
  );
  let geometry: Description | null = null;
  if (sub.kind === 'vertex') geometry = describeVertex(sub.key, facts);
  else if (sub.kind === 'edge') geometry = describeEdge(sub.key, facts);
  else if (sub.kind === 'face') geometry = describeFace(sub.key, facts);
  if (geometry !== null) snapshot.geometry = geometry as unknown as JsonValue;
  return snapshot;
}

/** What makes a map for a captured instance: its path as chain steps (9.5), innermost first. */
export interface CaptureChain {
  chain: readonly CopyStep[];
  names: NameTable;
}

/**
 * Writes the map of `shape` from the state naming it. Sub-shapes the state does
 * not name (wires, shells, a stored shape's root) get an empty ladder. A
 * capture appends `capture.chain` to every name; `branch` entries name features
 * and stay as they are (9.5).
 */
export function writeShapeMap(
  state: NamedState,
  shape: ShapeRef,
  facts: KernelFacts,
  capture?: CaptureChain,
): ShapeMapEntry[] {
  const extended = (hash: string) => (capture ? withChain(hash, capture.chain, capture.names) : hash);
  return facts.subShapes(shape).map((sub) => {
    const entity = state.get(sub.key);
    const aliases = (entity?.aliases ?? []).map((a) => keyJson({ hash: extended(a.hash), branch: a.branch }));
    return {
      ladder: (entity?.ladder ?? []).map(extended),
      aliases: makeSet(distinct(aliases)),
      branch: branchJson(entity?.branch ?? []),
      snapshot: snapshotOf(sub, facts),
      children: makeSet(sub.children),
    };
  });
}

/** Where a map first disagrees with the shape it came with. */
export interface ShapeMapMismatch {
  /** The entry, or null when the map has the wrong length. */
  index: number | null;
  field: 'length' | 'children' | 'snapshot';
}

/** The 13.2 load check: each entry against the sub-shape at its index, at the load tolerance. Null when they agree. */
export function checkShapeMap(map: ShapeMapJson, shape: ShapeRef, facts: KernelFacts): ShapeMapMismatch | null {
  const subs = facts.subShapes(shape);
  if (map.length !== subs.length) return { index: null, field: 'length' };
  const root = subs[0];
  if (root === undefined) return null;
  const tolerance = loadTolerance(diagonal(facts.measures(root.key).bbox));
  for (const [index, sub] of subs.entries()) {
    const entry = map[index] as ShapeMapEntry;
    const children = new Set(entry.children.set);
    if (children.size !== sub.children.length || !sub.children.every((c) => children.has(c))) {
      return { index, field: 'children' };
    }
    if (!matchesSnapshot(entry.snapshot, snapshotOf(sub, facts), tolerance)) return { index, field: 'snapshot' };
  }
  return null;
}

const ENTITY_KINDS: Partial<Record<SubShape['kind'], EntityKind>> = {
  solid: 'body',
  face: 'face',
  edge: 'edge',
  vertex: 'vertex',
};

interface NameObject {
  kind?: JsonValue;
  chain?: JsonValue;
  feature?: { id?: JsonValue };
  role?: JsonValue;
  src?: readonly { name?: { hash: string }; uses?: { set: readonly { item: string }[] } }[];
}

/**
 * What an entity made from an edge stands for as a neighbour (9.6 rule 4): the
 * faces that edge lay between. The map does not hold them; the name does.
 */
function standsForOf(level: NameObject | undefined, names: NameTable): string[] {
  return (level?.src ?? []).flatMap((item) => {
    if (!item.name) return [];
    const source = names.get(item.name.hash) as NameObject | undefined;
    if (source?.kind !== 'edge') return [];
    return (source.src ?? []).flatMap((s) => s.uses?.set.map((u) => u.item) ?? []);
  });
}

/** A loaded entity, before the namer places it in the build. */
export type LoadedEntity = Omit<NamedEntity, 'createdBy' | 'createdAt'>;

export interface LoadedMap {
  entities: LoadedEntity[];
  /** Split features the map's branches say are in effect (9.6 rule 0). */
  splits: Set<string>;
  /** Who first produced each edge and vertex `src`, in the form `NamedState.producers` keys it. */
  producers: Map<string, string>;
}

/**
 * The identities a checked map gives `shape`'s sub-shapes. Ladders, `branch`
 * and `aliases` come as written. A later live feature re-derives edge and
 * vertex names from their faces, so the producers go back into the state for
 * those names to come out the same.
 */
export function readShapeMap(map: ShapeMapJson, shape: ShapeRef, facts: KernelFacts, names: NameTable): LoadedMap {
  const entities: LoadedEntity[] = [];
  const splits = new Set<string>();
  const producers = new Map<string, string>();
  for (const [index, sub] of facts.subShapes(shape).entries()) {
    const entry = map[index] as ShapeMapEntry;
    const kind = ENTITY_KINDS[sub.kind];
    if (kind === undefined || entry.ladder.length === 0) continue;
    const branch = branchOf(entry.branch);
    const aliases = entry.aliases.set.map((a) => ({ hash: a.hash, branch: branchOf(a.branch) }));
    for (const b of [...branch, ...aliases.flatMap((a) => a.branch)]) splits.add(b.split);

    const level = names.get(finest(entry.ladder)) as NameObject | undefined;
    if ((kind === 'edge' || kind === 'vertex') && typeof level?.feature?.id === 'string') {
      const { kind: k, chain, role, src } = level;
      producers.set(canonicalize({ kind: k, chain, role, src: src ?? [] } as unknown as JsonValue), level.feature.id);
    }
    entities.push({
      key: sub.key,
      kind,
      ladder: entry.ladder,
      branch,
      aliases,
      standsFor: kind === 'face' ? standsForOf(level, names) : [],
      body: shape,
    });
  }
  return { entities, splits, producers };
}
