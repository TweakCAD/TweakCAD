import { canonicalize, type JsonValue } from '../canonical';
import type { KernelFacts, ShapeKey } from './facts';
import { finest, type BranchEntry, type SideEntry } from './names';
import { describeEntity, tightMatcher } from './snapshot';
import type { NamedEntity, NamedState } from './state';

/** A `branch` entry as the document writes it (9.2): the split feature as `{"id"}`. */
export interface RecordBranchEntry {
  split: { id: string };
  side: readonly SideEntry[];
}

/** The entity record a reference stores (9.2), in its JSON form. */
export interface EntityRecord {
  id: readonly string[];
  branch: readonly RecordBranchEntry[];
  side: readonly SideEntry[];
  nb: { set: readonly string[] };
  n: number;
  snapshot: Record<string, JsonValue>;
}

export type Resolution =
  /** Several only for a divided region. */
  | { outcome: 'same'; entities: readonly NamedEntity[] }
  | { outcome: 'ask'; suggestions: readonly NamedEntity[] }
  | { outcome: 'gone' };

export interface ResolveOptions {
  /**
   * Rule 5: whether an entity matches a snapshot's complete `geometry` (9.7).
   * By default the comparison of 9.7 at the tight tolerance, with `size` the
   * part in `state`. A reference whose snapshot is in another frame than the
   * entity (in context, 9.7) passes its own.
   */
  matchesGeometry?: (entity: NamedEntity, geometry: JsonValue) => boolean;
}

/** The faces neighbouring an entity, by the kind rules of 9.2 `nb`. */
function neighbours(entity: NamedEntity, state: NamedState, facts: KernelFacts): NamedEntity[] {
  if (entity.kind !== 'face' && entity.kind !== 'edge' && entity.kind !== 'vertex') return [];
  const topology = facts.topology(entity.body);
  const keys = new Set<ShapeKey>();
  if (entity.kind === 'face') {
    for (const edge of topology.edges) {
      if (!edge.faces.some((f) => f.face === entity.key)) continue;
      for (const f of edge.faces) if (f.face !== entity.key) keys.add(f.face);
    }
  } else if (entity.kind === 'edge') {
    const edge = topology.edges.find((e) => e.edge === entity.key);
    const own = new Set(edge?.faces.map((f) => f.face) ?? []);
    for (const v of topology.vertices) {
      if (!edge?.ends.includes(v.vertex)) continue;
      for (const f of v.faces) if (!own.has(f)) keys.add(f);
    }
  } else {
    for (const f of topology.vertices.find((v) => v.vertex === entity.key)?.faces ?? []) keys.add(f);
  }
  return [...keys].map((k) => state.get(k)).filter((e): e is NamedEntity => e !== undefined);
}

/** Whether a neighbour answers to a recorded hash: any ladder level, an alias, or what a blend stands for. */
function answersTo(face: NamedEntity, hash: string): boolean {
  return face.ladder.includes(hash) || face.aliases.some((a) => a.hash === hash) || face.standsFor.includes(hash);
}

function sideOf(entity: NamedEntity, face: NamedEntity, facts: KernelFacts): 1 | -1 | null {
  const point = facts.samplePoint(entity.key);
  if (point === null) return null;
  // A face of the entity's own body is signed by its normal (9.6 Sides); a
  // point in the face's own surface has no side.
  const sign = facts.side(point, face.key, face.body === entity.body ? 'normal' : 'solid');
  return sign === 0 ? null : sign;
}

/** Writes the record of a pick (9.2) from the state the reference resolves against. */
export function writeRecord(picked: NamedEntity, state: NamedState, facts: KernelFacts): EntityRecord {
  const near = neighbours(picked, state, facts);
  const nb = [...new Set(near.map((f) => finest(f.ladder)))].sort();
  const side: SideEntry[] = [];
  for (const hash of nb) {
    const face = near.find((f) => finest(f.ladder) === hash);
    const sign = face ? sideOf(picked, face, facts) : null;
    if (sign !== null) side.push({ of: hash, sign });
  }
  const branchKey = canonicalize(picked.branch as unknown as JsonValue);
  const hash = finest(picked.ladder);
  let n = 0;
  for (const e of state.entities.values()) {
    if (finest(e.ladder) === hash && canonicalize(e.branch as unknown as JsonValue) === branchKey) n++;
  }
  const snapshot: Record<string, JsonValue> = { ...(facts.measures(picked.key) as Record<string, JsonValue>) };
  const geometry = n > 1 ? describeEntity(picked, facts) : null;
  if (geometry !== null) snapshot.geometry = geometry as unknown as JsonValue;
  const branch = picked.branch.map((b) => ({ split: { id: b.split }, side: b.side }));
  return { id: [...picked.ladder], branch, side, nb: { set: nb }, n, snapshot };
}

/**
 * Rule 1: `candidate` holds the reference's entries in order; a common divider
 * never disagrees. Tool faces can share a name (a hole's faces at one position),
 * so one `of` can carry several signs.
 */
export function containsInOrder(candidate: readonly BranchEntry[], wanted: readonly BranchEntry[]): boolean {
  let at = 0;
  for (const entry of candidate) {
    const want = wanted[at];
    if (want === undefined) break;
    if (entry.split !== want.split) continue;
    const agrees = want.side.every((s) => {
      const theirs = entry.side.filter((t) => t.of === s.of);
      return theirs.length === 0 || theirs.some((t) => t.sign === s.sign);
    });
    if (!agrees) return false;
    at++;
  }
  return at === wanted.length;
}

/** Resolves a reference against a state by rules 0–6 (9.6). Regions resolve in the sketch module. */
export function resolve(
  record: EntityRecord,
  state: NamedState,
  facts: KernelFacts,
  options: ResolveOptions = {},
): Resolution {
  if (record.id.length === 0) return { outcome: 'gone' };
  const hash = finest(record.id);

  // Rule 0: only splits in effect in this state count.
  const wanted: BranchEntry[] = record.branch
    .map((b) => ({ split: b.split.id, side: b.side }))
    .filter((b) => state.splits.has(b.split));

  // Candidates by name or alias, each with the branch it answers with.
  const found = new Map<NamedEntity, readonly BranchEntry[][]>();
  for (const e of state.lookup(hash)) {
    const branches: BranchEntry[][] = [];
    if (e.ladder.includes(hash)) branches.push([...e.branch]);
    for (const a of e.aliases) if (a.hash === hash) branches.push([...a.branch]);
    found.set(e, branches);
  }
  // Rule 1.
  const candidates = [...found]
    .filter(([, branches]) => branches.some((b) => containsInOrder(b, wanted)))
    .map(([e]) => e);

  if (candidates.length === 0) return { outcome: 'gone' };
  const n = record.n;

  const rank = (list: NamedEntity[]): { e: NamedEntity; signs: number; overlap: number }[] =>
    list
      .map((e) => {
        const near = neighbours(e, state, facts);
        const overlap = record.nb.set.filter((h) => near.some((f) => answersTo(f, h))).length;
        let signs = 0;
        for (const s of record.side) {
          const face = near.find((f) => answersTo(f, s.of));
          if (face && sideOf(e, face, facts) === s.sign) signs++;
        }
        return { e, signs, overlap };
      })
      .sort((a, b) => b.signs - a.signs || b.overlap - a.overlap);

  const geometryPick = (list: NamedEntity[]): NamedEntity | null => {
    const geometry = record.snapshot.geometry;
    if (geometry === undefined) return null;
    const matchesGeometry = options.matchesGeometry ?? tightMatcher(state, facts);
    const matches = list.filter((e) => matchesGeometry(e, geometry));
    return matches.length === 1 ? (matches[0] as NamedEntity) : null;
  };

  // Rule 2.
  if (candidates.length > n) return { outcome: 'ask', suggestions: rank(candidates).map((r) => r.e) };

  // Rule 3: some have gone, perhaps the picked one; only a complete geometric match proves it.
  if (candidates.length < n) {
    const match = geometryPick(candidates);
    return match
      ? { outcome: 'same', entities: [match] }
      : { outcome: 'ask', suggestions: rank(candidates).map((r) => r.e) };
  }

  // Rule 4: exactly n. Identity is semantic; neighbours and sides decide which of the n.
  let pool = candidates;
  if (record.nb.set.length > 0) {
    pool = candidates.filter((e) => {
      const near = neighbours(e, state, facts);
      return record.nb.set.some((h) => near.some((f) => answersTo(f, h)));
    });
  }
  if (pool.length === 0) return { outcome: 'ask', suggestions: rank(candidates).map((r) => r.e) };
  if (n === 1 && pool.length === 1) return { outcome: 'same', entities: pool };
  const ranked = rank(pool);
  const [best, second] = ranked;
  if (best && (!second || best.signs !== second.signs || best.overlap !== second.overlap)) {
    return { outcome: 'same', entities: [best.e] };
  }

  // Rule 5: history cannot tell them apart; only one complete geometric match decides.
  const tied = ranked.filter((r) => best && r.signs === best.signs && r.overlap === best.overlap).map((r) => r.e);
  const match = geometryPick(tied);
  return match ? { outcome: 'same', entities: [match] } : { outcome: 'ask', suggestions: ranked.map((r) => r.e) };
}
