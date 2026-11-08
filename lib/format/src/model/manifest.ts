/**
 * The manifest of an assembly (12.4): the rows it reaches transitively, with
 * presentation and solver state removed, so its name hash (a context's
 * `source`) changes exactly when something the captured geometry depends on
 * changes.
 */
import { nameHash } from '../hash';

type Json = Record<string, unknown>;

/** Fields removed wherever they appear: presentation and history of the edit, never geometry. */
const DROPPED = new Set([
  'attributes',
  'views',
  'notes',
  'properties',
  'metadata',
  'folders',
  'groups',
  'rollback',
  'command',
  'snapshot',
]);

/** Rows by id prefix, whose own `name` and `description` are presentation. */
const ROWS = ['doc_', 'part_', 'asm_', 'feat_', 'tbl_', 'par_', 'val_', 'inst_', 'pos_', 'exp_', 'set_', 'lib_'];

/** Solver state of rows, by id prefix: not bit-stable, so never part of a manifest. */
const SOLVER_STATE: Record<string, readonly string[]> = {
  pt_: ['x', 'y'],
  con_: ['solved', 'label'],
  jnt_: ['state'],
  inst_: ['placement'],
};

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: Json) => (typeof v.id === 'string' ? v.id : '');

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (!isObject(value)) return value;
  const id = idOf(value);
  const row = ROWS.some((p) => id.startsWith(p));
  const state = Object.entries(SOLVER_STATE).find(([p]) => id.startsWith(p))?.[1] ?? [];
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROPPED.has(k)) continue;
    if (row && (k === 'name' || k === 'description')) continue;
    if (state.includes(k)) continue;
    // A part's contexts are reduced to what selects them; captures belong to no manifest.
    if (k === 'contexts' && Array.isArray(v)) {
      out[k] = v
        .filter(isObject)
        .map((c) => ({ id: c.id, at: c.at, ...(c.position === undefined ? {} : { position: strip(c.position) }) }));
      continue;
    }
    out[k] = strip(v);
  }
  return out;
}

/** Every value under `v` held by a key named `key` whose value is `{"id": …}`. */
function idsUnder(v: unknown, key: string, into: Set<string>): void {
  if (Array.isArray(v)) {
    for (const x of v) idsUnder(x, key, into);
    return;
  }
  if (!isObject(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (k === key && isObject(x) && typeof x.id === 'string') into.add(x.id);
    idsUnder(x, key, into);
  }
}

const byId = (rows: Json[]) => rows.slice().sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));

/** The manifest of assembly `assembly` in `doc` (12.4). */
export function manifestOf(doc: Json, assembly: string): Json {
  const assemblies = new Map(((doc.assemblies as Json[]) ?? []).map((a) => [idOf(a), a]));
  const parts = new Map(((doc.parts as Json[]) ?? []).map((p) => [idOf(p), p]));
  const library = new Map(((doc.library as Json[]) ?? []).map((l) => [idOf(l), l]));
  const reachedAssemblies = new Set<string>();
  const reachedParts = new Set<string>();
  const reachedLibrary = new Set<string>();
  const visit = (row: Json | undefined, kind: 'assembly' | 'part') => {
    if (!row) return;
    const seen = kind === 'assembly' ? reachedAssemblies : reachedParts;
    if (seen.has(idOf(row))) return;
    seen.add(idOf(row));
    const nestedParts = new Set<string>();
    const nestedAssemblies = new Set<string>();
    idsUnder(row, 'part', nestedParts);
    idsUnder(row, 'assembly', nestedAssemblies);
    idsUnder(row, 'library', reachedLibrary);
    for (const id of nestedParts) visit(parts.get(id), 'part');
    for (const id of nestedAssemblies) visit(assemblies.get(id), 'assembly');
  };
  visit(assemblies.get(assembly), 'assembly');
  const pick = <T>(ids: Set<string>, rows: Map<string, T>) =>
    byId([...ids].flatMap((id) => (rows.has(id) ? [rows.get(id) as Json] : [])));
  return strip({
    assemblies: pick(reachedAssemblies, assemblies),
    parts: pick(reachedParts, parts),
    parameters: byId(((doc.parameters as Json[]) ?? []).filter(isObject)),
    library: pick(reachedLibrary, library),
  }) as Json;
}

/** A context's `source`: the name hash of its assembly's manifest (12.4). */
export function manifestHash(doc: Json, assembly: string): string {
  return nameHash(manifestOf(doc, assembly));
}
