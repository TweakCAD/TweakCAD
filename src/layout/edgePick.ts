/**
 * Edge picking for the Fillet / Chamfer dialogs: turns one viewport
 * selection into the stable EdgeRefs it contributes.
 *
 *   - edge pick → that edge, or its tangent chain when `tangentChain` is on;
 *   - face pick → every boundary edge of the face (seams excluded).
 */

import type { EdgeRef, Selection, TopologyMap } from '@tweakcad/core/src/document/schema.ts';
import { faceBoundaryEdges, tangentChain } from '@tweakcad/core/src/document/edgeQueries.ts';

export type EdgePickResult = {
  /** Refs to add, in topology order (seed first for a chain). */
  refs: EdgeRef[];
  /** Resolved edges skipped because they carry no stable id yet. */
  missingStableIds: number;
};

const EMPTY: EdgePickResult = { refs: [], missingStableIds: 0 };

export function resolveEdgePick(
  sel: Selection | null,
  topologyMaps: readonly TopologyMap[],
  opts: { tangentChain: boolean },
): EdgePickResult {
  if (!sel || (sel.type !== 'edge' && sel.type !== 'face')) return EMPTY;
  const topo = topologyMaps.find(t => t.bodyId === sel.bodyId);
  if (!topo) return sel.type === 'edge' ? { refs: [], missingStableIds: 1 } : EMPTY;

  let edges: TopologyMap['edges'];
  if (sel.type === 'face') {
    edges = faceBoundaryEdges(topo, String(sel.faceId));
  } else if (opts.tangentChain) {
    edges = tangentChain(topo, String(sel.edgeId));
  } else {
    edges = topo.edges.filter(e => e.edgeId === sel.edgeId);
  }
  if (sel.type === 'edge' && edges.length === 0) return { refs: [], missingStableIds: 1 };

  const refs: EdgeRef[] = [];
  let missingStableIds = 0;
  for (const e of edges) {
    if (!e.stableEdgeId) { missingStableIds++; continue; }
    refs.push({
      type: 'stableTopology',
      bodyRef: { partId: sel.partId, bodyId: sel.bodyId },
      stableEdgeId: e.stableEdgeId,
    });
  }
  return { refs, missingStableIds };
}

/** Append `add` to `current`, skipping refs already present. Returns `current` when nothing is new. */
export function appendEdgeRefs(current: EdgeRef[], add: readonly EdgeRef[]): EdgeRef[] {
  const seen = new Set(current.map(e => JSON.stringify(e)));
  const fresh: EdgeRef[] = [];
  for (const ref of add) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(ref);
  }
  return fresh.length > 0 ? [...current, ...fresh] : current;
}
