/**
 * MeshRegistry - maps bodyId to Three.js objects in the scene.
 * Handles creation, update, and disposal of Three.js meshes
 * from DisplayMesh data received from workers.
 */

import * as THREE from 'three';
import type { DisplayMesh, TopologyMap } from '@tweakcad/core/src/document/schema.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { FeatureDisplayMode } from './displayMode.ts';

/** Default material for solid bodies */
const DEFAULT_BODY_MATERIAL = new THREE.MeshPhongMaterial({
  color: 0x6699cc,
  specular: 0x222222,
  shininess: 30,
  flatShading: false,
});

/** Material for edge lines */
const EDGE_LINE_MATERIAL = new THREE.LineBasicMaterial({
  color: 0x333333,
  linewidth: 1,
});

export type MeshEntry = {
  bodyId: BodyId;
  mesh: THREE.Mesh;
  edges?: THREE.LineSegments;
  topoMap?: TopologyMap;
};

export class MeshRegistry {
  private entries = new Map<BodyId, MeshEntry>();
  private scene: THREE.Scene;

  /** @param scene - The Three.js scene to add/remove meshes from */
  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Replace all current meshes with new ones from a rebuild result.
   * Disposes old geometries and creates new Three.js objects.
   * @param meshes - Display meshes from the worker
   * @param topoMaps - Topology maps for each body
   */
  updateAll(meshes: DisplayMesh[], topoMaps: TopologyMap[]): void {
    // Dispose existing
    this.disposeAll();

    // Create topology lookup
    const topoLookup = new Map<BodyId, TopologyMap>();
    for (const topo of topoMaps) {
      topoLookup.set(topo.bodyId, topo);
    }

    // Create new meshes
    for (const displayMesh of meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(displayMesh.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(displayMesh.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(displayMesh.indices, 1));

      const mesh = new THREE.Mesh(geometry, DEFAULT_BODY_MATERIAL.clone());
      // Tag the Three.js object with its source bodyId so raycaster hits can
      // identify which body was struck without searching the registry.
      mesh.userData.bodyId = displayMesh.bodyId;
      this.scene.add(mesh);

      const topoMap = topoLookup.get(displayMesh.bodyId);
      const entry: MeshEntry = {
        bodyId: displayMesh.bodyId,
        mesh,
        ...(topoMap !== undefined ? { topoMap } : {}),
      };

      // Add edge lines if available
      if (displayMesh.edgePositions && displayMesh.edgePositions.length > 0) {
        const edgeGeom = new THREE.BufferGeometry();
        edgeGeom.setAttribute('position', new THREE.BufferAttribute(displayMesh.edgePositions, 3));
        const edges = new THREE.LineSegments(edgeGeom, EDGE_LINE_MATERIAL);
        edges.userData.bodyId = displayMesh.bodyId;
        this.scene.add(edges);
        entry.edges = edges;
      }

      this.entries.set(displayMesh.bodyId, entry);
    }
  }

  /**
   * Set visibility for a specific body.
   * @param bodyId - The body to show/hide
   * @param visible - Whether to show the body
   */
  setBodyVisible(bodyId: BodyId, visible: boolean): void {
    const entry = this.entries.get(bodyId);
    if (entry) {
      entry.mesh.visible = visible;
      if (entry.edges) entry.edges.visible = visible;
    }
  }

  /**
   * Set opacity for a specific body.
   * @param bodyId - The body to adjust
   * @param opacity - Opacity value 0.0 to 1.0
   */
  setBodyOpacity(bodyId: BodyId, opacity: number): void {
    const entry = this.entries.get(bodyId);
    if (!entry) return;
    const mat = entry.mesh.material as THREE.MeshPhongMaterial;
    mat.transparent = opacity < 1.0;
    mat.opacity = opacity;
    mat.depthWrite = opacity >= 1.0;
    mat.needsUpdate = true;
  }

  /**
   * Highlight a body (selection). Pass null to clear all highlights.
   * Highlighted bodies get a blue emissive tint.
   */
  highlightBodies(bodyIds: Set<BodyId> | null): void {
    for (const [bid, entry] of this.entries) {
      const mat = entry.mesh.material as THREE.MeshPhongMaterial;
      if (bodyIds && bodyIds.has(bid)) {
        mat.emissive.setHex(0x1a6fd1);
        mat.emissiveIntensity = 0.3;
      } else {
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
      }
      mat.needsUpdate = true;
    }
  }

  /**
   * Apply display modes to all bodies at once. The mode map is
   * computed centrally by `computeAllBodyDisplayModes` in
   * `displayMode.ts` from (feature visibility + per-body hide set +
   * current DisplayContext); this method is the dumb apply step.
   * @param modes - Map of bodyId to display mode
   */
  applyDisplayModes(modes: Map<BodyId, FeatureDisplayMode>): void {
    for (const [bodyId, mode] of modes) {
      switch (mode) {
        case 'hidden':
          this.setBodyVisible(bodyId, false);
          break;
        case 'normal':
          this.setBodyVisible(bodyId, true);
          this.setBodyOpacity(bodyId, 1.0);
          break;
        case 'ghosted':
          this.setBodyVisible(bodyId, true);
          this.setBodyOpacity(bodyId, 0.25);
          break;
        default:
          // readonlySketch and editingSketch are handled by sketch components, not mesh registry
          break;
      }
    }
  }

  /**
   * Iterate over all registered bodies. Used by the picker for raycasting
   * against meshes and edges. Caller must not mutate the returned objects.
   */
  getEntries(): Iterable<MeshEntry> {
    return this.entries.values();
  }

  /** Look up an entry by bodyId for highlight rendering / inspection. */
  getEntry(bodyId: BodyId): MeshEntry | undefined {
    return this.entries.get(bodyId);
  }

  /**
   * Apply section-view clipping planes to every body mesh (and the shared
   * edge material). Pass `[]` to clear. The caller owns the THREE.Plane
   * objects and may mutate their `constant` in place for a live cut — the
   * materials hold the same array reference, so the renderer picks it up
   * next frame (with `renderer.localClippingEnabled = true`).
   */
  setClippingPlanes(planes: THREE.Plane[]): void {
    const value = planes.length > 0 ? planes : null;
    for (const entry of this.entries.values()) {
      const mat = entry.mesh.material as THREE.Material;
      mat.clippingPlanes = value;
      mat.needsUpdate = true;
    }
    EDGE_LINE_MATERIAL.clippingPlanes = value;
    EDGE_LINE_MATERIAL.needsUpdate = true;
  }

  /** World-space bounding box of all body meshes (empty box if none). */
  getBodiesBoundingBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const entry of this.entries.values()) {
      entry.mesh.geometry.computeBoundingBox();
      const bb = entry.mesh.geometry.boundingBox;
      if (bb) box.union(bb.clone().applyMatrix4(entry.mesh.matrixWorld));
    }
    return box;
  }

  /** Dispose all managed meshes and geometries */
  dispose(): void {
    this.disposeAll();
  }

  /** Internal: remove and dispose all entries */
  private disposeAll(): void {
    for (const entry of this.entries.values()) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      if (entry.mesh.material instanceof THREE.Material) {
        entry.mesh.material.dispose();
      }
      if (entry.edges) {
        this.scene.remove(entry.edges);
        entry.edges.geometry.dispose();
      }
    }
    this.entries.clear();
  }
}
