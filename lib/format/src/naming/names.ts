import type { JsonValue } from '../canonical';
import { canonicalOrder, makeCountedSet } from '../collections';
import type { NameTable } from '../names';

/** Name objects and identity ladders (spec 9.3). */

export type EntityKind =
  'face' | 'edge' | 'vertex' | 'body' | 'region' | 'curve' | 'plane' | 'axis' | 'point' | 'frame';

/** One `src` item (9.3), already in its JSON form. */
export type SrcItem =
  | { name: { hash: string } }
  | { id: { id: string } }
  | { index: { i: number } }
  | { text: { t: string } }
  | { uses: { set: { item: string; count: number }[] } };

/** A copy step of a `chain` (9.5). */
export interface CopyStep {
  op: { id: string };
  key: JsonValue;
}

export interface Naming {
  kind: EntityKind;
  chain: readonly CopyStep[];
  feature: string;
  /** Absent: no rule names it beyond level 0. */
  role?: string | undefined;
  /** Absent with a role: the ladder stops at level 1. */
  src?: readonly SrcItem[] | undefined;
}

/** The levels of a naming, coarse to fine, as hashes recorded in `names`. */
export function ladderOf(naming: Naming, names: NameTable): string[] {
  const base = { kind: naming.kind, chain: naming.chain as unknown as JsonValue, feature: { id: naming.feature } };
  const ladder = [names.intern(base as JsonValue)];
  if (naming.role === undefined) return ladder;
  const withRole = { ...base, role: naming.role };
  ladder.push(names.intern(withRole as JsonValue));
  if (naming.src === undefined || naming.src.length === 0) return ladder;
  ladder.push(names.intern({ ...withRole, src: naming.src as unknown as JsonValue } as JsonValue));
  return ladder;
}

/** The finest level, which nested names use in naming-rules version 1. */
export function finest(ladder: readonly string[]): string {
  const last = ladder[ladder.length - 1];
  if (last === undefined) throw new Error('empty ladder');
  return last;
}

/**
 * The name `hash` becomes when `steps` are appended to its chain (9.5). `src`
 * stays as it is: it is the source's history.
 */
export function withChain(hash: string, steps: readonly CopyStep[], names: NameTable): string {
  const level = names.get(hash);
  if (level === null || typeof level !== 'object' || Array.isArray(level)) {
    throw new Error(`name ${hash} is not in the name table`);
  }
  const chain = Array.isArray(level.chain) ? level.chain : [];
  return names.intern({ ...level, chain: [...chain, ...(steps as unknown as JsonValue[])] });
}

export const nameItem = (hash: string): SrcItem => ({ name: { hash } });
export const idItem = (id: string): SrcItem => ({ id: { id } });
export const indexItem = (i: number): SrcItem => ({ index: { i } });
export const textItem = (t: string): SrcItem => ({ text: { t } });

/** An edge's faces as a counted set of their finest names (a seam's face counts twice). */
export function usesItem(faceNames: readonly string[]): SrcItem {
  return { uses: makeCountedSet(faceNames) };
}

/** A set of items, sorted by canonical bytes (9.4: where a rule lists a set). */
export function itemSet(items: readonly SrcItem[]): SrcItem[] {
  return canonicalOrder(items);
}

/** One side sign (9.2). */
export interface SideEntry {
  of: string;
  sign: 1 | -1;
}

/** One split event a piece descends from (9.2). */
export interface BranchEntry {
  split: string;
  side: readonly SideEntry[];
}

/** An entity key `{hash, branch}` (7.2, 9.6). */
export interface EntityKey {
  hash: string;
  branch: readonly BranchEntry[];
}
