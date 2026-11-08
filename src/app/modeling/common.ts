/**
 * What the modelling commands share: new feature rows, literal value
 * objects, feature names, and where a part takes a new feature.
 */
import { GRAMMAR, isPlainObject } from '@tweakcad/format';
import type { Doc, Editor, Json } from '@tweakcad/editor';
import { partOf } from '../features';

/** A value object holding literal expression text, with a new id. */
export function literal(editor: Editor, text: string): Json {
  return { id: editor.newId('val'), def: { expr: { text, grammar: GRAMMAR, refs: {} } } };
}

/** A new top-level feature row (7.2) with its inputs. */
export function featureRow(editor: Editor, id: string, type: string, name: string, inputs: Json): Json {
  return {
    id,
    type,
    typeVersion: 1,
    name,
    suppressed: literal(editor, 'false'),
    frozen: { live: {} },
    command: { alone: {} },
    inputs,
  };
}

function eachFeature(features: unknown, visit: (f: Json) => void): void {
  if (!Array.isArray(features)) return;
  for (const f of features as Json[]) {
    visit(f);
    eachFeature(f.children, visit);
  }
}

/**
 * The name a new feature of a part takes: `base` and the next number after
 * the highest one the part's features of that name use ("Sketch 1",
 * "Sketch 2", …), so a deleted feature's number is not taken again.
 */
export function nextFeatureName(doc: Doc, part: string, base: string): string {
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`);
  let highest = 0;
  eachFeature(partOf(doc, part)?.timeline, (f) => {
    const m = typeof f.name === 'string' ? pattern.exec(f.name) : null;
    if (m) highest = Math.max(highest, Number(m[1]));
  });
  return `${base} ${highest + 1}`;
}

/**
 * Where a new feature goes in a part: before the feature the part is rolled
 * back to (so it lands at the marker), or at the end.
 */
export function insertionPoint(doc: Doc, part: string): string | undefined {
  const rollback = partOf(doc, part)?.rollback;
  if (isPlainObject(rollback) && isPlainObject(rollback.before) && typeof rollback.before.id === 'string')
    return rollback.before.id;
  return undefined;
}

/** The last top-level feature before `before` (or the end), whose named values a new feature there can use. */
export function featureBefore(doc: Doc, part: string, before: string | undefined): string | undefined {
  const timeline = partOf(doc, part)?.timeline;
  if (!Array.isArray(timeline)) return undefined;
  const rows = timeline as Json[];
  const end = before === undefined ? rows.length : rows.findIndex((f) => f.id === before);
  const row = rows[(end < 0 ? rows.length : end) - 1];
  return typeof row?.id === 'string' ? row.id : undefined;
}
