/**
 * SelectionHighlight — renders overlay geometry to visualize the current
 * primary selection and the hover preselection.
 *
 * Owned by ViewportController. The class maintains at most two overlay
 * Three.js objects at a time (one per "slot"):
 *   - selection (the clicked element): bright yellow, mostly opaque
 *   - preselection (the hovered element): lighter yellow, lower opacity
 *
 * Overlays are added to the scene directly, never registered in
 * MeshRegistry, so the picker's `intersectObject` loop never raycasts
 * against them.
 *
 * Face overlays clone the body's geometry indices for the face's triangle
 * range (TopologyMap.faces[i].triStart..triEnd, half-open). Edge overlays
 * wrap the edge's pre-computed `lineSegments` Float32Array. Vertex/body
 * overlays land later if/when those selection types need them.
 */

import * as THREE from 'three';
import type { Selection } from '@tweakcad/core/src/document/schema.ts';
import type { BodyId, FaceId, EdgeId } from '@tweakcad/core/src/ids.ts';
import type { MeshRegistry, MeshEntry } from './MeshRegistry.ts';

/** Z-order trick: overlays render after solid bodies but inherit depth. */
const HIGHLIGHT_RENDER_ORDER = 999;

/** Per-slot material configuration. */
type SlotStyle = {
  faceColor: number;
  faceOpacity: number;
  edgeColor: number;
  edgeWidth: number; // not honored by LineBasicMaterial in WebGL; kept for future Line2 swap
};

const SELECTION_STYLE: SlotStyle = {
  faceColor: 0xfacc15, // amber-400
  faceOpacity: 0.55,
  edgeColor: 0xeab308, // amber-500
  edgeWidth: 3,
};

const PRESELECTION_STYLE: SlotStyle = {
  faceColor: 0xfef08a, // amber-200
  faceOpacity: 0.35,
  edgeColor: 0xfde047, // amber-300
  edgeWidth: 2,
};

type Slot = 'selection' | 'preselection';

/**
 * One live overlay (face mesh OR edge line). Stored per slot so we can
 * dispose the previous overlay when the selection changes.
 */
type LiveOverlay = {
  object: THREE.Mesh | THREE.LineSegments;
  /** Owned by us — clone of the body's geometry. Must be disposed. */
  geometry: THREE.BufferGeometry;
  /** Owned by us. Must be disposed. */
  material: THREE.Material;
};

export class SelectionHighlight {
  private scene: THREE.Scene;
  private slots: Map<Slot, LiveOverlay> = new Map();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Update the primary (clicked) selection highlight. */
  update(sel: Selection | null, registry: MeshRegistry): void {
    this.setSlot('selection', sel, registry, SELECTION_STYLE);
  }

  /** Update the preselection (hover) highlight. */
  updatePreselection(sel: Selection | null, registry: MeshRegistry): void {
    this.setSlot('preselection', sel, registry, PRESELECTION_STYLE);
  }

  /** Tear down all overlays. */
  dispose(): void {
    for (const slot of Array.from(this.slots.keys())) {
      this.clearSlot(slot);
    }
  }

  // ---- Internals ----

  private setSlot(slot: Slot, sel: Selection | null, registry: MeshRegistry, style: SlotStyle): void {
    this.clearSlot(slot);
    if (!sel) return;
    const live = this.buildOverlay(sel, registry, style);
    if (!live) return;
    live.object.renderOrder = HIGHLIGHT_RENDER_ORDER;
    // Mark the overlay so the picker's intersectObject loop can skip if it
    // ever ends up reachable. Currently it doesn't — overlays are added to
    // the scene without going through MeshRegistry — but this is a belt-
    // and-suspenders measure.
    live.object.userData.isSelectionOverlay = true;
    this.scene.add(live.object);
    this.slots.set(slot, live);
  }

  private clearSlot(slot: Slot): void {
    const live = this.slots.get(slot);
    if (!live) return;
    this.scene.remove(live.object);
    live.geometry.dispose();
    live.material.dispose();
    this.slots.delete(slot);
  }

  private buildOverlay(
    sel: Selection,
    registry: MeshRegistry,
    style: SlotStyle,
  ): LiveOverlay | null {
    switch (sel.type) {
      case 'face':
        return buildFaceOverlay(sel.bodyId, sel.faceId, registry, style);
      case 'edge':
        return buildEdgeOverlay(sel.bodyId, sel.edgeId, registry, style);
      // Body / sketchEntity / plane / feature highlights are not handled
      // here. Body could fall back to the existing highlightBodies tint
      // pathway if the consumer wants it.
      default:
        return null;
    }
  }
}

// ---- Builders ----

/**
 * Construct a translucent face overlay by extracting the face's index range
 * from the body's mesh and reusing the body's position+normal buffers.
 * Position/normal buffers are *shared* via `setAttribute(…, original)` —
 * no clone — because they aren't modified. Only the index buffer is owned.
 */
function buildFaceOverlay(
  bodyId: BodyId,
  faceId: FaceId,
  registry: MeshRegistry,
  style: SlotStyle,
): LiveOverlay | null {
  const entry = registry.getEntry(bodyId);
  if (!entry?.topoMap) return null;

  const face = entry.topoMap.faces.find(f => f.faceId === faceId);
  if (!face) return null;

  const srcGeom = entry.mesh.geometry;
  const srcPos = srcGeom.getAttribute('position');
  const srcNormal = srcGeom.getAttribute('normal');
  const srcIndex = srcGeom.getIndex();
  if (!srcPos || !srcIndex) return null;

  const triCount = face.triEnd - face.triStart;
  if (triCount <= 0) return null;

  // Index range in the flat index buffer.
  const indexStart = face.triStart * 3;
  const indexEnd = face.triEnd * 3;
  const srcIndexArr = srcIndex.array;
  const sliced = (srcIndexArr instanceof Uint32Array ? new Uint32Array(indexEnd - indexStart) : new Uint16Array(indexEnd - indexStart));
  for (let i = 0; i < indexEnd - indexStart; i++) {
    // Cast through Number to satisfy both typed-array variants.
    sliced[i] = Number(srcIndexArr[indexStart + i]);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', srcPos);
  if (srcNormal) geom.setAttribute('normal', srcNormal);
  geom.setIndex(new THREE.BufferAttribute(sliced, 1));

  const mat = new THREE.MeshBasicMaterial({
    color: style.faceColor,
    transparent: true,
    opacity: style.faceOpacity,
    side: THREE.DoubleSide,
    // Render on top but still respect depth so the highlight follows the
    // body's surface contours rather than floating above them.
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const mesh = new THREE.Mesh(geom, mat);
  return { object: mesh, geometry: geom, material: mat };
}

/**
 * Construct an edge overlay from the edge's precomputed lineSegments.
 * The body's `edges` THREE.LineSegments stores the full flat array; we
 * extract just this edge's segment range.
 */
function buildEdgeOverlay(
  bodyId: BodyId,
  edgeId: EdgeId,
  registry: MeshRegistry,
  style: SlotStyle,
): LiveOverlay | null {
  const entry: MeshEntry | undefined = registry.getEntry(bodyId);
  if (!entry?.topoMap) return null;

  const edge = entry.topoMap.edges.find(e => e.edgeId === edgeId);
  if (!edge) return null;

  // edge.lineSegments is 6 floats per segment (start xyz + end xyz). We can
  // build a BufferGeometry directly from it; no slicing needed because the
  // tracker already gives us per-edge segments.
  const positions = edge.lineSegments;
  if (positions.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const mat = new THREE.LineBasicMaterial({
    color: style.edgeColor,
    transparent: true,
    opacity: 1.0,
    // depthTest off so the highlighted edge is always visible, even when it
    // sits inside a body. Edges are 1-pixel thin and easy to occlude
    // otherwise. linewidth is ignored by most WebGL implementations.
    depthTest: false,
    depthWrite: false,
  });

  const lines = new THREE.LineSegments(geom, mat);
  return { object: lines, geometry: geom, material: mat };
}
