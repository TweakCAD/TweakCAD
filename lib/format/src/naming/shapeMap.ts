import { canonicalBytes, canonicalize, type JsonValue } from '../canonical';
import { contentHash } from '../hash';
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
  /** Only in maps written before fingerprints: the measures the load check compared. */
  snapshot?: Record<string, JsonValue>;
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

function hasNonFinite(value: JsonValue): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  return Array.isArray(value) && value.some(hasNonFinite);
}

/**
 * What an entry of a map written before fingerprints records of its sub-shape:
 * the 9.7 measures, plus `geometry` for vertices, edges and faces. Those
 * describe everything; a wire, shell or solid would only repeat them, and is
 * held to them by `children`.
 */
export function entrySnapshot(sub: SubShape, facts: KernelFacts): Record<string, JsonValue> {
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
 * The fingerprint of a stored shape's numbering (13.2): the content hash of
 * one row per sub-shape in index order, `[kind, children, extra]`, `extra`
 * being a vertex's point, an edge's parameter range, or null. Every value is
 * read from the stored shape, not computed, so the same bytes give the same
 * fingerprint, and any other numbering changes it. Take it from the shape as
 * decoded from its bytes: a text round trip need not keep every last bit.
 */
export function shapeFingerprint(shape: ShapeRef, facts: KernelFacts): string {
  return contentHash(canonicalBytes(numberingRows(shape, facts)));
}

/** One sub-shape's row of the fingerprint: kind, children, and a vertex's point or an edge's range. */
export type NumberingRow = readonly [SubShape['kind'], readonly number[], readonly number[] | null];

/** The rows `shapeFingerprint` hashes, in index order. */
export function numberingRows(shape: ShapeRef, facts: KernelFacts): NumberingRow[] {
  return facts.subShapes(shape).map((sub) => {
    let extra: readonly number[] | null = null;
    if (sub.kind === 'vertex') extra = facts.measures(sub.key).point ?? null;
    else if (sub.kind === 'edge') extra = facts.edgeRange(sub.key);
    return [sub.kind, sub.children, extra];
  });
}

/**
 * Whether a shape decoded from its bytes is numbered as the live shape its
 * map was written from: the same kinds and children in the same order, and
 * every point and range the same up to what the text form keeps (relative
 * 1e-12). A writer checks this before it stores a map, since the map names
 * the live shape's sub-shapes and the fingerprint the decoded shape's.
 */
export function sameNumbering(live: readonly NumberingRow[], decoded: readonly NumberingRow[]): boolean {
  if (live.length !== decoded.length) return false;
  return live.every(([kind, children, extra], i) => {
    const [k, c, e] = decoded[i] as NumberingRow;
    if (kind !== k || children.length !== c.length || children.some((x, j) => x !== c[j])) return false;
    if (extra === null || e === null) return extra === e;
    return (
      extra.length === e.length &&
      extra.every((x, j) => Math.abs(x - (e[j] as number)) <= 1e-12 * Math.max(1, Math.abs(x)))
    );
  });
}

/**
 * Writes the map of `shape` from the state naming it. Sub-shapes the state does
 * not name (wires, shells, a stored shape's root) get an empty ladder. A
 * capture appends `capture.chain` to every name; `branch` entries name features
 * and stay as they are (9.5). The stored shape's fingerprint goes with it.
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
      children: makeSet(sub.children),
    };
  });
}

/** Where a map first disagrees with the shape it came with. */
export interface ShapeMapMismatch {
  /** The entry, or null when the map has the wrong length. */
  index: number | null;
  field: 'length' | 'children' | 'snapshot' | 'fingerprint';
}

/**
 * The 13.2 load check, null when the map and the shape agree: each entry's
 * children, then the shape's `fingerprint`, or, for a map written before
 * fingerprints, each entry's snapshot at the load tolerance.
 */
export function checkShapeMap(
  map: ShapeMapJson,
  shape: ShapeRef,
  facts: KernelFacts,
  fingerprint?: string,
): ShapeMapMismatch | null {
  const subs = facts.subShapes(shape);
  if (map.length !== subs.length) return { index: null, field: 'length' };
  for (const [index, sub] of subs.entries()) {
    const children = new Set((map[index] as ShapeMapEntry).children.set);
    if (children.size !== sub.children.length || !sub.children.every((c) => children.has(c))) {
      return { index, field: 'children' };
    }
  }
  if (fingerprint !== undefined) {
    return shapeFingerprint(shape, facts) === fingerprint ? null : { index: null, field: 'fingerprint' };
  }
  const root = subs[0];
  if (root === undefined) return null;
  const tolerance = loadTolerance(diagonal(facts.measures(root.key).bbox));
  for (const [index, sub] of subs.entries()) {
    const snapshot = (map[index] as ShapeMapEntry).snapshot;
    if (!snapshot || !matchesSnapshot(snapshot, entrySnapshot(sub, facts), tolerance))
      return { index, field: 'snapshot' };
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
