/**
 * Shared helpers for synthesizing BuiltBody-shaped artifacts from the
 * viewportStore's flat lists (displayMeshes, topologyMaps,
 * bodyToFeatureMap). Used by:
 *
 *   - browserToolHost.ts: the in-app chat's direct-access path
 *   - mcpBridgeClient.ts: the bridge's WS request handler
 *
 * Single source so both consumers can never disagree on what a body
 * looks like. If the rebuilder is later updated to populate
 * `viewportStore.partArtifacts` properly, this whole module can
 * collapse into a direct read.
 */

import type { CadProject, DisplayMesh, TopologyMap } from '@tweakcad/core/src/document/schema.ts';
import type { PartId, FeatureId } from '@tweakcad/core/src/ids.ts';

export interface BodySummary {
  bodyId: string;
  sourceFeatureId: string;
  role: string;
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * Build the list of bodies belonging to a part. Each body is one
 * displayMesh in the viewport whose `bodyToFeatureMap` entry points
 * at a feature in this part's timeline.
 */
export function synthesizeBodies(
  doc: CadProject,
  displayMeshes: ReadonlyArray<DisplayMesh>,
  bodyToFeatureMap: Readonly<Record<string, FeatureId>>,
  partId: string,
): BodySummary[] {
  const part = doc.parts[partId as PartId];
  if (!part) return [];
  const partFeatureIds = new Set(part.timeline.map((f) => f.id as string));
  const bodies: BodySummary[] = [];
  for (const mesh of displayMeshes) {
    const sourceFeatureId = bodyToFeatureMap[mesh.bodyId];
    if (!sourceFeatureId || !partFeatureIds.has(sourceFeatureId as string)) continue;
    bodies.push({
      bodyId: String(mesh.bodyId),
      sourceFeatureId: String(sourceFeatureId),
      role: 'solid',
      boundingBox: computeBoundingBox(mesh.positions),
    });
  }
  return bodies;
}

/**
 * Look up a topology map by bodyId. Returns null if not found (e.g.
 * the body was built but its topology hasn't propagated yet — though
 * in practice they land in the store atomically together).
 */
export function findTopology(
  topologyMaps: ReadonlyArray<TopologyMap>,
  bodyId: string,
): TopologyMap | null {
  return topologyMaps.find((t) => String(t.bodyId) === bodyId) ?? null;
}

/**
 * Compute an axis-aligned bounding box from a flat Float32Array of
 * `[x0,y0,z0, x1,y1,z1, …]` positions. One linear pass; faster than
 * three.js Box3.setFromBufferAttribute for the typical 100-1000-vertex
 * meshes inspected here.
 */
export function computeBoundingBox(
  positions: Float32Array,
): { min: [number, number, number]; max: [number, number, number] } {
  if (positions.length < 3) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
