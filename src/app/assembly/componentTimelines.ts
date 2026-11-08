/**
 * The timelines of an assembly's parts, for the timeline bar while the assembly
 * is shown. Each part has its own timeline, so the whole design is listed part
 * by part: the top-level component's items first, then a group for each other
 * component. Editing one in place shows its items alone.
 */
import { isPlainObject } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import type { FeatureRow, PartView } from '../features';
import { assemblyOf, rowsOf } from './assembly';

export interface ComponentTimelines {
  /** The items of the part named after the assembly, which stands for its top-level component. */
  top: FeatureRow[];
  /** The other components' items, in the order of their first instances. */
  rest: FeatureRow[];
  /** A group for each component in `rest`. */
  groups: { id: string; name: string; members: string[] }[];
  /** The instance to edit in place for each item. */
  instanceOf: ReadonlyMap<string, string>;
}

export function componentTimelines(doc: Doc, assembly: string, parts: readonly PartView[]): ComponentTimelines {
  const row = assemblyOf(doc, assembly);
  const out: ComponentTimelines = { top: [], rest: [], groups: [], instanceOf: new Map() };
  const instanceOf = out.instanceOf as Map<string, string>;
  const seen = new Set<string>();
  for (const instance of rowsOf(row, 'instances')) {
    const of = instance.of as Json | undefined;
    if (!of || !isPlainObject(of.part)) continue;
    const id = String(of.part.id);
    const part = parts.find((p) => p.id === id);
    if (!part || seen.has(id) || part.features.length === 0) continue;
    seen.add(id);
    for (const f of part.features) instanceOf.set(f.id, String(instance.id));
    if (part.name === row?.name) out.top.push(...part.features);
    else {
      out.rest.push(...part.features);
      out.groups.push({ id: `component:${id}`, name: part.name, members: part.features.map((f) => f.id) });
    }
  }
  return out;
}
