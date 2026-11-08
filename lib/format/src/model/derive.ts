import { child } from './diagnostics';
import { readOperation } from './extrude';
import { readOverride, registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { LIBRARY, readAttachedFrame, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** What an insertion places: a part or assembly of this document, or a library component (11.1, 12.1). */
export function readDefinitionRef(c: InputContext, v: unknown, path: string): void {
  const { r } = c;
  const of = r.union(v, path, ['part', 'assembly', 'component']);
  if (of?.tag === 'part') r.idRef(of.payload, of.path, 'part');
  else if (of?.tag === 'assembly') r.idRef(of.payload, of.path, 'asm');
  else if (of?.tag === 'component') {
    const o = r.object(of.payload, of.path, { required: ['value'] });
    if (o) value(c, o.value, child(of.path, 'value'), LIBRARY);
  }
}

/**
 * `core.derive` (11.1), typeVersion 1. `mirror` is optional: absent, the
 * derived bodies are placed by `frame` only; present, they are then
 * reflected in that plane of the host, as an opposite-hand part is made (12.1).
 */
function readDeriveInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, {
    required: ['from', 'instance', 'items', 'overrides', 'frame', 'operation'],
    optional: ['mirror'],
  });
  if (!o) return;
  readDefinitionRef(c, o.from, child(path, 'from'));
  r.define(o.instance, child(path, 'instance'), 'inst');
  const items = r.union(o.items, child(path, 'items'), ['all', 'items']);
  if (items?.tag === 'all') r.object(items.payload, items.path, { required: [] });
  else if (items?.tag === 'items') {
    const members = r.set(items.payload, items.path);
    if (members?.length === 0) r.diagnostics.refuse('bad-value', items.path, 'the derived items are not empty');
    members?.forEach((m, i) => readReference(r, m, child(child(items.path, 'set'), i)));
  }
  const op = child(path, 'overrides');
  if (r.list(o.overrides, op)) {
    o.overrides.forEach((ov, i) =>
      readOverride(r, values, ov, child(op, i), scope.owner, scope.feature ?? scope.owner, -1, false),
    );
  }
  readAttachedFrame(c, o.frame, child(path, 'frame'));
  readOperation(c, o.operation, child(path, 'operation'));
  if (o.mirror !== undefined) {
    const m = r.object(o.mirror, child(path, 'mirror'), { required: ['plane'] });
    if (m) readReference(r, m.plane, child(child(path, 'mirror'), 'plane'));
  }
}

registerFeatureType('core.derive', { versions: [1], readInputs: readDeriveInputs });

/** The definitions one definition builds from: a part's derives, an assembly's instances (10). */
function uses(doc: Json): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const target = (of: unknown): string | undefined => {
    if (typeof of !== 'object' || of === null) return undefined;
    const o = of as Json;
    const id = ((o.part ?? o.assembly) as Json | undefined)?.id;
    return typeof id === 'string' ? id : undefined;
  };
  const features = (list: unknown, into: string[]): void => {
    if (!Array.isArray(list)) return;
    for (const f of list as Json[]) {
      if (f?.type === 'core.derive') {
        const t = target((f.inputs as Json | undefined)?.from);
        if (t) into.push(t);
      }
      features(f?.children, into);
    }
  };
  for (const p of Array.isArray(doc.parts) ? (doc.parts as Json[]) : []) {
    if (typeof p?.id !== 'string') continue;
    const into: string[] = [];
    features(p.timeline, into);
    out.set(p.id, into);
  }
  for (const a of Array.isArray(doc.assemblies) ? (doc.assemblies as Json[]) : []) {
    if (typeof a?.id !== 'string') continue;
    const into: string[] = [];
    for (const inst of Array.isArray(a.instances) ? (a.instances as Json[]) : []) {
      const t = target(inst?.of);
      if (t) into.push(t);
    }
    out.set(a.id, into);
  }
  return out;
}

/**
 * No cycle among derives (20): a part that derives, directly or through
 * assemblies and other parts, from itself. Cycles of assemblies alone are
 * refused where assemblies are read.
 */
export function checkDeriveCycles(r: Reader, doc: Json): void {
  const graph = uses(doc);
  for (const start of graph.keys()) {
    if (!start.startsWith('part_')) continue;
    const seen = new Set<string>();
    const stack = [...(graph.get(start) ?? [])];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      if (at === start) {
        r.diagnostics.refuse('cycle', '/parts', `part ${start} derives from itself`);
        break;
      }
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(graph.get(at) ?? []));
    }
  }
}
