import type { BodyOutcome, KernelFacts, OperationHistory, ShapeKey, ShapeRef } from './facts';
import type { FeatureNamer } from './namer';

/**
 * Derived shape maps (13.2): an import whose identities are exactly the
 * `import` rule's over its stored shape's index order stores no entries, only
 * the fingerprint; its names come from naming the decoded shape again.
 */

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
