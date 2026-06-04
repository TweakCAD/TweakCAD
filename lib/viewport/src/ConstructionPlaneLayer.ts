/**
 * ConstructionPlaneLayer — renders construction planes as translucent
 * rectangles in the viewport.
 *
 * Each plane gets a square mesh (`PLANE_SIZE` mm a side) plus a coloured
 * outline so it reads as a plane even when transparent. The mesh's
 * `userData.featureId` lets the picker resolve a click back to the
 * source feature. Visibility honors the timeline's eye toggle via the
 * `visible` field in each {@link ConstructionPlaneDisplay} entry.
 *
 * The layer doesn't mutate the scene tree beyond adding/removing its
 * own root group. Replacement is atomic — `update()` disposes every
 * previous mesh and rebuilds from scratch, mirroring the pattern in
 * {@link MeshRegistry.updateAll}.
 */

import * as THREE from 'three';
import type { ConstructionPlaneDisplay } from '@tweakcad/core/src/document/schema.ts';
import type { FeatureId } from '@tweakcad/core/src/ids.ts';

/** Size of the rendered rectangle in scene units (mm). */
const PLANE_SIZE = 80;

/** Default fill color — same blue as the Sketch / Plane brand color. */
const PLANE_FILL_COLOR = 0x3b82f6;
/** Outline color — same hue, darker so it pops against the fill. */
const PLANE_OUTLINE_COLOR = 0x1d4ed8;

export type PlaneEntry = {
  featureId: FeatureId;
  mesh: THREE.Mesh;
  outline: THREE.LineSegments;
};

export class ConstructionPlaneLayer {
  private root: THREE.Group;
  private entries: PlaneEntry[] = [];
  /** Shared geometry — every plane mesh reuses these. Owned by the layer. */
  private planeGeom: THREE.PlaneGeometry;
  private edgeGeom: THREE.EdgesGeometry;

  /**
   * @param scene The Three.js scene to render into. The layer adds a
   *   single root group to it and removes that group on dispose.
   */
  constructor(scene: THREE.Scene) {
    this.root = new THREE.Group();
    this.root.name = 'ConstructionPlaneLayer';
    scene.add(this.root);

    this.planeGeom = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
    this.edgeGeom = new THREE.EdgesGeometry(this.planeGeom);
  }

  /**
   * Replace the rendered plane set with `planes`. Disposes every prior
   * mesh and rebuilds from scratch so atomicity matches the rebuild
   * pipeline's "one rebuild = one consistent viewport state" contract.
   */
  update(planes: ConstructionPlaneDisplay[]): void {
    this.disposeAll();

    for (const plane of planes) {
      if (!plane.visible) continue;
      const entry = this.makePlaneEntry(plane);
      this.entries.push(entry);
    }
  }

  /** Iterable for the picker (it needs to raycast every mesh in the layer). */
  getEntries(): readonly PlaneEntry[] {
    return this.entries;
  }

  /** The rendered entry for one plane, or undefined if it isn't shown. */
  getEntry(featureId: FeatureId): PlaneEntry | undefined {
    return this.entries.find(e => e.featureId === featureId);
  }

  /** Remove every mesh from the scene and free its GPU memory. */
  dispose(): void {
    this.disposeAll();
    this.root.parent?.remove(this.root);
    this.planeGeom.dispose();
    this.edgeGeom.dispose();
  }

  // ---- private ----

  private disposeAll(): void {
    for (const entry of this.entries) {
      this.root.remove(entry.mesh);
      this.root.remove(entry.outline);
      if (entry.mesh.material instanceof THREE.Material) {
        entry.mesh.material.dispose();
      }
      if (entry.outline.material instanceof THREE.Material) {
        entry.outline.material.dispose();
      }
    }
    this.entries = [];
  }

  private makePlaneEntry(plane: ConstructionPlaneDisplay): PlaneEntry {
    // Convert the resolved basis (uAxis + vAxis + normal in world space)
    // into a Three.js matrix that orients a unit XY plane onto the
    // construction plane's pose. Standard column-basis matrix:
    //   M = [ u v n | origin ]
    const u = new THREE.Vector3(plane.uAxis[0], plane.uAxis[1], plane.uAxis[2]);
    const v = new THREE.Vector3(plane.vAxis[0], plane.vAxis[1], plane.vAxis[2]);
    const n = new THREE.Vector3(plane.normal[0], plane.normal[1], plane.normal[2]);
    const matrix = new THREE.Matrix4().makeBasis(u, v, n).setPosition(
      plane.origin[0], plane.origin[1], plane.origin[2],
    );

    const material = new THREE.MeshBasicMaterial({
      color: PLANE_FILL_COLOR,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.planeGeom, material);
    mesh.applyMatrix4(matrix);
    mesh.userData['featureId'] = plane.featureId;
    mesh.userData['planeName'] = plane.name;
    // Render after solid bodies so transparency composites correctly,
    // but below selection highlights (those live in their own layer).
    mesh.renderOrder = 1450;

    const outlineMat = new THREE.LineBasicMaterial({
      color: PLANE_OUTLINE_COLOR,
      transparent: true,
      opacity: 0.85,
    });
    const outline = new THREE.LineSegments(this.edgeGeom, outlineMat);
    outline.applyMatrix4(matrix);
    outline.renderOrder = 1451;

    this.root.add(mesh);
    this.root.add(outline);

    return { featureId: plane.featureId, mesh, outline };
  }
}
