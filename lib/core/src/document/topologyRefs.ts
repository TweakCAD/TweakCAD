/**
 * Building stable face and edge references from a topology map entry.
 *
 * Every pick site goes through these so a reference always carries the
 * entry's repair hint: the hint is what lets a rebuild notice that the
 * stable id has come to name a different face or edge (see `RepairHint`).
 */

import type { BodyRef, EdgeRef, FaceRef, TopologyMap } from './schema.ts';

type StableFaceRef = Extract<FaceRef, { type: 'stableTopology' }>;
type StableEdgeRef = Extract<EdgeRef, { type: 'stableTopology' }>;

/** A face ref for `face`, or `null` when it has no stable id yet. Also a valid `PlaneRef`. */
export function stableFaceRef(bodyRef: BodyRef, face: TopologyMap['faces'][number]): StableFaceRef | null {
  if (!face.stableFaceId) return null;
  return {
    type: 'stableTopology',
    bodyRef: { partId: bodyRef.partId, bodyId: bodyRef.bodyId },
    stableFaceId: face.stableFaceId,
    ...(face.repairHint ? { repairHint: face.repairHint } : {}),
  };
}

/** An edge ref for `edge`, or `null` when it has no stable id yet. */
export function stableEdgeRef(bodyRef: BodyRef, edge: TopologyMap['edges'][number]): StableEdgeRef | null {
  if (!edge.stableEdgeId) return null;
  return {
    type: 'stableTopology',
    bodyRef: { partId: bodyRef.partId, bodyId: bodyRef.bodyId },
    stableEdgeId: edge.stableEdgeId,
    ...(edge.repairHint ? { repairHint: edge.repairHint } : {}),
  };
}
