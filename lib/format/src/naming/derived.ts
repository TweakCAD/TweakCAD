import { canonicalBytes } from '../canonical';
import { contentHash } from '../hash';
import type { BodyOutcome, KernelFacts, OperationHistory, ShapeKey, ShapeRef } from './facts';
import type { FeatureNamer } from './namer';

/**
 * Derived shape maps (13.2): an import whose identities are exactly the
 * `import` rule's over its stored shape's index order stores no entries. Its
 * names come from naming the decoded shape again, and a fingerprint of the
 * numbering stands in for the entries' load check.
 */

/**
 * The fingerprint of a stored shape's numbering: the content hash of one row
 * per sub-shape in index order, `[kind, children, extra]`, `extra` being a
 * vertex's point, an edge's parameter range, or null. Every value is read
 * from the stored shape, not computed, so the same bytes give the same
 * fingerprint, and any other numbering changes it.
 */
export function shapeFingerprint(shape: ShapeRef, facts: KernelFacts): string {
  const rows = facts.subShapes(shape).map((sub) => {
    let extra: readonly number[] | null = null;
    if (sub.kind === 'vertex') extra = facts.measures(sub.key).point ?? null;
    else if (sub.kind === 'edge') extra = facts.edgeRange(sub.key);
    return [sub.kind, sub.children, extra];
  });
  return contentHash(canonicalBytes(rows));
}

/**
 * Names a stored shape by the `import` rule (9.4): each face and each solid by
 * its index, edges and vertices from their faces. Returns the bodies for
 * `namer.finish`. The importer and the builder both name through this, so a
 * derived map replays the names the import was written with.
 */
export function nameImported(namer: FeatureNamer, shape: ShapeRef, facts: KernelFacts): BodyOutcome[] {
  const index = new Map(facts.subShapes(shape).map((s, i) => [s.key, i]));
  const at = (key: ShapeKey) => ({ index: index.get(key) as number });
  const none = { kept: [], modified: new Map(), deleted: [], added: [] };
  const history: OperationHistory = {
    result: shape,
    inputs: [],
    faces: none,
    edges: none,
    facesFromFace: new Map(),
    facesFromEdge: new Map(),
  };
  const topology = facts.topology(shape);
  namer.step(history, {
    outputs: topology.faces.map((f) => ({ entity: f, role: 'face', src: [at(f)] })),
    dividers: [],
  });
  return topology.solids.map((s) => ({ solid: s.solid, from: { create: [at(s.solid)] } }));
}
