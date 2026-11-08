/**
 * What the browser does beyond selecting: a new part from its header, a
 * derived component copied, and the groups its rows are drawn in (a part's
 * derived components, the bodies of an import that made several).
 */
import { isPlainObject } from '@tweakcad/format';
import type { CommandResult, Editor, Json } from '@tweakcad/editor';
import { emptyPart } from './document';
import { findFeature, partOfFeature, type FeatureRow } from './features';
import { newPart, open } from './assembly/commands';
import { nextPartName } from './assembly/assembly';
import { shownAssembly } from './assembly/focus';
import { newTarget, writeFeature } from './modeling/feature';
import type { AppServices } from './services';

/**
 * New Part from the browser: with an assembly shown, a part placed in it and
 * edited there (as ASSEMBLE ▸ New Part, which tells of a refusal itself:
 * null); otherwise an empty part added to the document and opened.
 */
export async function addPart(services: AppServices): Promise<CommandResult | null> {
  const { editor, app } = services;
  if (shownAssembly(editor.document, app.getState().focus)) {
    await newPart(services);
    return null;
  }
  const id = editor.newId('part');
  const result = editor.dispatch({ type: 'addPart', part: emptyPart(id, nextPartName(editor.document)) });
  if (result.ok) open(services, { part: id });
  return result;
}

/** `inputs` with a fresh id for every value object and for the derive's own instance. */
export function freshInputs(inputs: Json, newId: (kind: string) => string): Json {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isPlainObject(v)) return v;
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    if (typeof v.id === 'string' && 'def' in v) out.id = newId('val');
    return out;
  };
  const copy = walk(inputs) as Json;
  if (typeof copy.instance === 'string') copy.instance = newId('inst');
  return copy;
}

/**
 * Another copy of a derived component in its part: the same source,
 * placement, overrides and operation, named as the part's next of its kind
 * ("Bracket 2" after "Bracket 1"), at the rollback marker.
 */
export function duplicateDerive(editor: Editor, feature: string): CommandResult {
  const row = findFeature(editor.document, feature);
  const part = partOfFeature(editor.document, feature);
  if (!row || row.type !== 'core.derive' || !part || !isPlainObject(row.inputs)) {
    return { ok: false, error: { code: 'not-found', message: 'Only a derived component can be duplicated' } };
  }
  const base = String(row.name ?? 'Derive').replace(/\s+\d+$/, '') || 'Derive';
  const target = newTarget(editor, part, base);
  return writeFeature(
    editor,
    target,
    'core.derive',
    { ok: true, inputs: freshInputs(row.inputs, (kind) => editor.newId(kind)), names: {} },
    base,
  );
}

/** A part's derived components, composites' members included. */
export function componentsOf(rows: readonly FeatureRow[]): FeatureRow[] {
  return rows.flatMap((r) => [...(r.type === 'core.derive' ? [r] : []), ...componentsOf(r.children)]);
}

/** The row of feature `id` among `rows`, composites' members included. */
export function rowOf(rows: readonly FeatureRow[], id: string): FeatureRow | undefined {
  for (const r of rows) {
    if (r.id === id) return r;
    const inner = rowOf(r.children, id);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * The bodies list in its drawn order: each body alone, except the bodies of
 * an import that made several, which go together under the import, at the
 * place of its first.
 */
export function bodyGroups<B extends { feature: string }>(
  rows: readonly FeatureRow[],
  bodies: readonly B[],
): ({ body: B } | { feature: FeatureRow; bodies: B[] })[] {
  const counts = new Map<string, number>();
  for (const b of bodies) counts.set(b.feature, (counts.get(b.feature) ?? 0) + 1);
  const out: ({ body: B } | { feature: FeatureRow; bodies: B[] })[] = [];
  const groups = new Map<string, B[]>();
  for (const b of bodies) {
    const row = (counts.get(b.feature) ?? 0) > 1 ? rowOf(rows, b.feature) : undefined;
    if (row?.type !== 'core.import') {
      out.push({ body: b });
      continue;
    }
    const group = groups.get(row.id);
    if (group) group.push(b);
    else {
      const members = [b];
      groups.set(row.id, members);
      out.push({ feature: row, bodies: members });
    }
  }
  return out;
}
