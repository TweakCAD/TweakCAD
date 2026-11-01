/**
 * SketchSceneManager - Three.js scene management for sketch entities.
 *
 * Renders sketch entities (lines, circles, points) directly in the 3D scene
 * on the sketch plane. This eliminates the 2D/3D alignment problem and
 * enables orbiting while sketching, ghost mode, and sketching on any plane.
 *
 * Architecture:
 * - Creates a THREE.Group as the sketch root, added to the main scene
 * - Sketch 2D coordinates (u, v) map to world 3D via the plane's axes
 * - Lines use THREE.Line with LineBasicMaterial
 * - Circles are polyline approximations (LineLoop)
 * - Points use THREE.Points with a custom shader for constant screen-space size
 * - Grid is a separate sub-group for the sketch plane grid
 * - Preview (rubber-band) uses a separate group with dashed material
 * - Hit testing: raycaster intersects the sketch plane to get 2D coords,
 *   then distance-tests against entities in 2D
 *
 * The manager reads from SketchEditorStore and updates Three.js objects.
 * Call update() after store changes to sync the scene.
 */

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import type { ViewportController } from '@tweakcad/viewport/src/ViewportController.ts';
import type {
  SketchPoint,
  SketchPointId,
  SketchGeometry,
  SketchGeometryId,
  SketchRegionId,
  SketchPreviewData,
  HitTarget,
  SnapResult,
} from '@tweakcad/core/src/sketch/types.ts';
import { ORIGIN_POINT_ID } from '@tweakcad/core/src/sketch/types.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { catmullRomSpline, sampleSplinePolyline, sampleCubicBezier } from './curveTessellation.ts';

// ---- Constants ----

const COLORS = {
  line: 0x3b82f6,               // blue — default geometry (under-constrained)
  lineFullyDefined: 0x1f2937,   // near-black — fully defined (DOF=0)
  origin: 0xf97316,             // anchor orange — the sketch origin point
  construction: 0x94a3b8,       // slate
  selected: 0xf59e0b,           // amber (orange) — selected state
  hovered: 0xef4444,            // red — hover state, unmistakable against blue
  region: 0x93c5fd,             // translucent blue profile fill
  regionSelected: 0xfbbf24,     // translucent amber selected fill
  regionHovered: 0xfca5a5,      // translucent red hovered fill
  preview: 0x22c55e,            // green
  snapPoint: 0xff7a00,          // orange snap marker
  snapMidpoint: 0x8b5cf6,       // violet midpoint snap marker
  snapGrid: 0x22c55e,           // green grid snap marker
  point: 0xffffff,              // white fill
  pointStroke: 0x3b82f6,        // blue outline
  pointSelected: 0xf59e0b,      // amber (orange) — selected point
  pointHovered: 0xef4444,       // red — hovered point
  gridMinor: 0xe0e0e0,          // light gray
  gridXAxis: 0xef4444,          // red
  gridYAxis: 0x22c55e,          // green (sketch Y, not world Y)
};

const POINT_SIZE = 8;           // screen pixels
const SELECTED_POINT_SIZE = 10;
const CIRCLE_SEGMENTS = 64;
const GRID_SIZE = 200;          // mm total grid extent
const GRID_DIVISIONS = 20;
const PLANE_OFFSET = 0.01;      // slight offset above plane to prevent z-fighting

// ---- Plane Mapping ----

export interface SketchPlaneConfig {
  /** Origin of the sketch plane in world space */
  origin: THREE.Vector3;
  /** U axis direction (sketch X -> world direction) */
  uAxis: THREE.Vector3;
  /** V axis direction (sketch Y -> world direction) */
  vAxis: THREE.Vector3;
  /** Normal of the sketch plane */
  normal: THREE.Vector3;
}

/** One of the three default datum planes, by name. */
export type SketchPlaneName = 'XY' | 'XZ' | 'YZ';

/**
 * How a sketch plane is specified to the renderer. A bare name resolves to
 * a default plane through the origin; a full {@link SketchPlaneConfig} carries
 * an explicit world basis (origin + axes + normal) — that's what a
 * **construction plane** uses, so its geometry is drawn at the plane's real
 * offset world location rather than at the base plane through the origin.
 */
export type SketchPlaneInput = SketchPlaneName | SketchPlaneConfig;

/** Screen right / up as unit vectors in sketch coordinates. */
export interface ScreenFrame {
  right: [number, number];
  up: [number, number];
}

/**
 * Build a plane config from a resolved construction-plane basis. The basis
 * comes from {@link ConstructionPlaneDisplay} (origin/uAxis/vAxis/normal as
 * `[x,y,z]` arrays in world space), which the rebuilder already emits for
 * every construction-plane feature.
 */
export function planeConfigFromBasis(basis: {
  origin: readonly [number, number, number];
  uAxis: readonly [number, number, number];
  vAxis: readonly [number, number, number];
  normal: readonly [number, number, number];
}): SketchPlaneConfig {
  return {
    origin: new THREE.Vector3(basis.origin[0], basis.origin[1], basis.origin[2]),
    uAxis: new THREE.Vector3(basis.uAxis[0], basis.uAxis[1], basis.uAxis[2]),
    vAxis: new THREE.Vector3(basis.vAxis[0], basis.vAxis[1], basis.vAxis[2]),
    normal: new THREE.Vector3(basis.normal[0], basis.normal[1], basis.normal[2]),
  };
}

/** Resolve either a default-plane name or an explicit config to a config. */
export function resolveSketchPlane(input: SketchPlaneInput): SketchPlaneConfig {
  return typeof input === 'string' ? planeConfigFromName(input) : input;
}

/**
 * A stable content key for a plane input, for use in React effect dependency
 * arrays. A {@link SketchPlaneConfig} is typically rebuilt fresh each render,
 * so depending on its object identity would re-create scene objects on every
 * parent render; keying on its numeric basis avoids that churn.
 */
export function sketchPlaneKey(input: SketchPlaneInput): string {
  if (typeof input === 'string') return input;
  const f = (v: THREE.Vector3) => `${v.x},${v.y},${v.z}`;
  return `cfg:${f(input.origin)}:${f(input.uAxis)}:${f(input.vAxis)}:${f(input.normal)}`;
}

/**
 * Create plane config from a plane name. Every default plane is right-handed
 * (u × v = normal) and must match `DEFAULT_PLANES` in the worker's
 * `resolvePlane.ts`.
 */
export function planeConfigFromName(name: 'XY' | 'XZ' | 'YZ'): SketchPlaneConfig {
  const origin = new THREE.Vector3(0, 0, 0);

  switch (name) {
    case 'XZ':
      // Y-up ground plane: sketch U = world X, sketch V = world -Z,
      // normal = world Y. u × v = normal, so seen from +Y (the sketch
      // camera's side) U points right and V points up on screen.
      return {
        origin,
        uAxis: new THREE.Vector3(1, 0, 0),
        vAxis: new THREE.Vector3(0, 0, -1),
        normal: new THREE.Vector3(0, 1, 0),
      };
    case 'XY':
      // sketch X = world X, sketch Y = world Y, normal = world Z
      return {
        origin,
        uAxis: new THREE.Vector3(1, 0, 0),
        vAxis: new THREE.Vector3(0, 1, 0),
        normal: new THREE.Vector3(0, 0, 1),
      };
    case 'YZ':
      // sketch U = world -Z (sketch's "horizontal"), sketch V = world Y
      // (sketch's "vertical" — aligned with real-world up). Keeping V tied
      // to world +Y makes "vertical" constraints visually vertical on every
      // upright sketch plane; U = -Z keeps u × v = normal, so seen from +X
      // U points right on screen.
      return {
        origin,
        uAxis: new THREE.Vector3(0, 0, -1),
        vAxis: new THREE.Vector3(0, 1, 0),
        normal: new THREE.Vector3(1, 0, 0),
      };
    default: {
      // Defensive: the param is typed as the three-name union, but
      // upstream callers (e.g. SketchViewer mounts in Shell.tsx) derive
      // it from doc data that might be malformed — particularly when
      // an external tool like the MCP bridge wrote a sketch with a
      // string plane field instead of a defaultPlane ref. Throw a
      // clear error here so the upstream error boundary catches a
      // message that names the bad value, instead of cascading into
      // an opaque "Cannot read properties of undefined (reading
      // 'uAxis')" later in the renderer.
      const _exhaustive: never = name;
      throw new Error(
        `planeConfigFromName: unknown plane name ${JSON.stringify(_exhaustive)} ` +
          `(expected 'XY' | 'XZ' | 'YZ')`,
      );
    }
  }
}

// ---- SketchSceneManager ----

export class SketchSceneManager {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private viewportCtrl: ViewportController;
  private plane: SketchPlaneConfig;

  // Three.js groups
  private root: THREE.Group;
  private gridGroup: THREE.Group;
  private regionGroup: THREE.Group;
  private geometryGroup: THREE.Group;
  private pointGroup: THREE.Group;
  private previewGroup: THREE.Group;
  private snapGroup: THREE.Group;

  // Object tracking (to update/remove efficiently)
  private geometryObjects = new Map<SketchGeometryId, THREE.Object3D>();
  private regionObjects = new Map<SketchRegionId, THREE.Object3D>();
  private pointObjects = new Map<SketchPointId, THREE.Mesh>();

  // Renderer size for LineMaterial resolution
  private rendererSize: THREE.Vector2;

  // Materials (shared, reusable) - LineMaterial for thick lines
  private lineMaterial: LineMaterial;
  private constructionMaterial: LineMaterial;
  private selectedMaterial: LineMaterial;
  private hoveredMaterial: LineMaterial;
  private previewMaterial: LineMaterial;
  private pointMaterial: THREE.MeshBasicMaterial;
  private pointSelectedMaterial: THREE.MeshBasicMaterial;
  private pointHoveredMaterial: THREE.MeshBasicMaterial;
  /** V11.5 · distinctly-coloured material for the sketch origin point.
   *  Rendered at the same size as a regular point but in orange so
   *  it reads as an anchor at a glance. Selection/hover still use the
   *  regular highlight materials. */
  private pointOriginMaterial: THREE.MeshBasicMaterial;
  private pointGeometry: THREE.CircleGeometry;

  private _disposed = false;

  constructor(viewportCtrl: ViewportController, plane: SketchPlaneInput) {
    this.viewportCtrl = viewportCtrl;
    this.scene = viewportCtrl.getScene();
    this.camera = viewportCtrl.getCamera();
    this.plane = resolveSketchPlane(plane);

    // Create groups
    this.root = new THREE.Group();
    this.root.name = 'SketchRoot';
    this.gridGroup = new THREE.Group();
    this.gridGroup.name = 'SketchGrid';
    this.regionGroup = new THREE.Group();
    this.regionGroup.name = 'SketchRegions';
    this.geometryGroup = new THREE.Group();
    this.geometryGroup.name = 'SketchGeometry';
    this.pointGroup = new THREE.Group();
    this.pointGroup.name = 'SketchPoints';
    this.previewGroup = new THREE.Group();
    this.previewGroup.name = 'SketchPreview';
    this.snapGroup = new THREE.Group();
    this.snapGroup.name = 'SketchSnapMarkers';

    this.root.add(this.gridGroup);
    this.root.add(this.regionGroup);
    this.root.add(this.geometryGroup);
    this.root.add(this.previewGroup);
    this.root.add(this.pointGroup);
    this.root.add(this.snapGroup);

    // Make sketch entities render on top of ghost bodies
    this.root.renderOrder = 999;

    // Get renderer size for LineMaterial resolution
    const renderer = viewportCtrl.getRenderer();
    this.rendererSize = new THREE.Vector2();
    renderer.getSize(this.rendererSize);

    // All sketch line materials share the same fine 0.8 px width so default,
    // hovered, selected, and preview lines look identical in weight — only
    // color distinguishes them — a fine hairline look.
    const LINE_WIDTH = 0.8;
    this.lineMaterial = new LineMaterial({
      color: COLORS.line,
      linewidth: LINE_WIDTH,
      resolution: this.rendererSize,
    });
    this.constructionMaterial = new LineMaterial({
      color: COLORS.construction,
      linewidth: LINE_WIDTH,
      dashed: true,
      dashSize: 1,
      gapSize: 1,
      resolution: this.rendererSize,
    });
    this.selectedMaterial = new LineMaterial({
      color: COLORS.selected,
      linewidth: LINE_WIDTH,
      resolution: this.rendererSize,
    });
    this.hoveredMaterial = new LineMaterial({
      color: COLORS.hovered,
      linewidth: LINE_WIDTH,
      resolution: this.rendererSize,
    });
    this.previewMaterial = new LineMaterial({
      color: COLORS.preview,
      linewidth: LINE_WIDTH,
      dashed: true,
      dashSize: 1.5,
      gapSize: 1,
      resolution: this.rendererSize,
    });

    this.pointMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.point,
      depthTest: false,
      transparent: true,
    });
    this.pointSelectedMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.pointSelected,
      depthTest: false,
      transparent: true,
    });
    this.pointHoveredMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.pointHovered,
      depthTest: false,
      transparent: true,
    });
    this.pointOriginMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.origin,
      depthTest: false,
      transparent: true,
    });

    // Point geometry (small circle, will be billboarded)
    this.pointGeometry = new THREE.CircleGeometry(0.5, 16);

    // Add grid
    this.createGrid();

    // Add to scene
    this.scene.add(this.root);
  }

  // ---- Public API ----

  /** Full sync: rebuild all Three.js objects from store state */
  update(
    points: Map<SketchPointId, SketchPoint>,
    geometries: Map<SketchGeometryId, SketchGeometry>,
    regions: SketchRegion[],
    selectedPointIds: Set<SketchPointId>,
    selectedGeometryIds: Set<SketchGeometryId>,
    selectedRegionIds: Set<SketchRegionId>,
    hoveredTarget: HitTarget,
    preview: SketchPreviewData,
    activeSnap: SnapResult | null,
    /** Extra entities to render with hover style — from a hovered constraint row in the Sketch Browser. */
    hoveredConstraintRefs: { points: ReadonlySet<SketchPointId>; geometries: ReadonlySet<SketchGeometryId> } = { points: new Set(), geometries: new Set() },
  ): void {
    if (this._disposed) return;

    // Update selectable closed profile regions behind sketch curves
    this.syncRegions(regions, selectedRegionIds, hoveredTarget);

    // Update geometries (constraint hover refs treated as hover)
    this.syncGeometries(geometries, points, selectedGeometryIds, hoveredTarget, hoveredConstraintRefs.geometries);

    // Update points (constraint hover refs treated as hover)
    this.syncPoints(points, selectedPointIds, hoveredTarget, hoveredConstraintRefs.points);

    // Update preview
    this.syncPreview(preview);

    // Update active snap marker
    this.syncSnapMarker(activeSnap);
  }

  /**
   * Project a sketch 2D point onto screen coordinates (CSS pixels relative
   * to the canvas's bounding rect). Used to anchor HTML overlays such as
   * dimension labels and the dimension-tool value input.
   */
  sketchToScreen(u: number, v: number): { x: number; y: number; behindCamera: boolean } {
    const world = this.toWorld(u, v);
    const ndc = world.clone().project(this.camera);
    const canvas = this.viewportCtrl.getCanvas();
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((ndc.x + 1) / 2) * rect.width,
      y: ((1 - ndc.y) / 2) * rect.height,
      behindCamera: ndc.z < -1 || ndc.z > 1,
    };
  }

  /**
   * Convert screen coordinates to sketch 2D coordinates.
   * Uses raycasting to intersect the sketch plane.
   */
  screenToSketch(clientX: number, clientY: number): [number, number] | null {
    const canvas = this.viewportCtrl.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const worldPoint = this.viewportCtrl.projectOntoPlane(
      ndcX,
      ndcY,
      this.plane.normal,
      this.plane.origin,
    );

    if (!worldPoint) return null;

    // Project world point onto sketch plane axes to get 2D coords
    const offset = worldPoint.clone().sub(this.plane.origin);
    const u = offset.dot(this.plane.uAxis);
    const v = offset.dot(this.plane.vAxis);
    return [u, v];
  }

  /**
   * The screen's right and up directions at a cursor position, expressed as
   * unit vectors in sketch coordinates. Content laid out along them reads
   * upright and unmirrored from the current camera, whichever way the plane's
   * u/v axes happen to face (on a default plane seen head-on they match u/v;
   * on a face or construction plane, or after orbiting, they may not). `up` is made
   * exactly perpendicular to `right`. Null when the plane is edge-on.
   */
  screenFrameAt(clientX: number, clientY: number): ScreenFrame | null {
    const STEP_PX = 50;
    const o = this.screenToSketch(clientX, clientY);
    const r = this.screenToSketch(clientX + STEP_PX, clientY);
    const u = this.screenToSketch(clientX, clientY - STEP_PX);
    if (!o || !r || !u) return null;
    const rx = r[0] - o[0], ry = r[1] - o[1];
    const len = Math.hypot(rx, ry);
    if (len < 1e-9) return null;
    const right: [number, number] = [rx / len, ry / len];
    const perp: [number, number] = [-right[1], right[0]];
    const sign = perp[0] * (u[0] - o[0]) + perp[1] * (u[1] - o[1]) >= 0 ? 1 : -1;
    return { right, up: [perp[0] * sign, perp[1] * sign] };
  }

  /**
   * Hit test: find what sketch entity is under the cursor.
   * @param clientX - Mouse X in viewport pixels
   * @param clientY - Mouse Y in viewport pixels
   * @param points - Current points from store
   * @param geometries - Current geometries from store
   * @returns The hit target or null
   */
  hitTest(
    clientX: number,
    clientY: number,
    points: Map<SketchPointId, SketchPoint>,
    geometries: Map<SketchGeometryId, SketchGeometry>,
    regions: SketchRegion[],
    profilePickingMode: boolean = false,
  ): HitTarget {
    const sketchPos = this.screenToSketch(clientX, clientY);
    if (!sketchPos) return null;

    const [mx, my] = sketchPos;

    // Scale tolerance based on camera distance for consistent feel
    const camDist = this.camera.position.distanceTo(this.plane.origin);
    const tolerance = camDist * 0.008; // ~8px equivalent at typical view

    // In profile picking mode: regions have highest priority.
    // Clicking anywhere inside a region should select it.
    if (profilePickingMode) {
      // Regions first (smallest area first for most specific hit)
      const regionHits = regions
        .filter(region => isPointInRegion(mx, my, region))
        .sort((a, b) => a.area - b.area);
      if (regionHits.length > 0 && regionHits[0]) {
        return { type: 'region', id: regionHits[0].id as SketchRegionId };
      }

      // Then geometry (for the geometry-to-region bridge in sketchTools.ts)
      for (const [gid, geom] of geometries) {
        if (isNearGeometry(mx, my, geom, points, tolerance)) {
          return { type: 'geometry', id: gid };
        }
      }

      return null;
    }

    // Normal edit mode: points > geometry > regions
    // Points first (smaller targets, higher priority)
    for (const [pid, pt] of points) {
      const dx = pt.x - mx;
      const dy = pt.y - my;
      if (Math.sqrt(dx * dx + dy * dy) <= tolerance * 1.5) {
        return { type: 'point', id: pid };
      }
    }

    // Geometry
    for (const [gid, geom] of geometries) {
      if (isNearGeometry(mx, my, geom, points, tolerance)) {
        return { type: 'geometry', id: gid };
      }
    }

    // Closed regions last so edge/point edits remain easy. This enables
    // profile picking by clicking inside a closed loop.
    //
    // Sort hits by area ascending so the SMALLEST containing region
    // wins — clicking in a rect+inscribed-circle corner region picks
    // the corner (area ≈ 86), not the enclosing rectangle (area 1600).
    // Mirrors the profile-picking-mode branch above and the existing
    // `hitTestRegion` / `selectRegionAtPoint` helpers in
    // SketchEditorStore.ts. Without this sort, the picker returns
    // whichever region happens to be first in the regions array — by
    // default that's the largest, because `detectSketchRegions` sorts
    // descending by area.
    const regionHits = regions
      .filter(region => isPointInRegion(mx, my, region))
      .sort((a, b) => a.area - b.area);
    if (regionHits.length > 0 && regionHits[0]) {
      return { type: 'region', id: regionHits[0].id as SketchRegionId };
    }

    return null;
  }

  /**
   * V7 · Tint all default-coloured sketch geometry deeper-blue when the
   * sketch is fully defined (DOF = 0), or back to the default blue when
   * it isn't. Selected / hovered / construction materials are
   * unaffected — selection state always wins over status state. Cheap:
   * swaps the colour on a single shared `LineMaterial`; the renderer
   * picks it up on the next frame without re-uploading geometry.
   */
  setFullyDefinedTint(fullyDefined: boolean): void {
    this.lineMaterial.color.setHex(fullyDefined ? COLORS.lineFullyDefined : COLORS.line);
  }

  /** Remove all sketch objects from the scene */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    this.scene.remove(this.root);

    // Dispose geometries
    this.geometryObjects.forEach((obj) => {
      if (obj instanceof THREE.Line) {
        obj.geometry.dispose();
      }
    });
    // Point geometry is shared across all point meshes - disposed below
    this.pointObjects.clear();

    // Dispose materials
    this.lineMaterial.dispose();
    this.constructionMaterial.dispose();
    this.selectedMaterial.dispose();
    this.hoveredMaterial.dispose();
    this.previewMaterial.dispose();
    this.pointMaterial.dispose();
    this.pointSelectedMaterial.dispose();
    this.pointHoveredMaterial.dispose();
    this.pointOriginMaterial.dispose();
    this.pointGeometry.dispose();

    // Dispose grid
    this.gridGroup.traverse((child) => {
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) child.material.dispose();
      }
    });

    this.geometryObjects.clear();
    this.regionObjects.clear();
    this.pointObjects.clear();
  }

  // ---- Private: Region Sync ----

  private syncRegions(
    regions: SketchRegion[],
    selectedIds: Set<SketchRegionId>,
    hoveredTarget: HitTarget,
  ): void {
    const activeRegionIds = new Set(regions.map(region => region.id as SketchRegionId));

    for (const [regionId, obj] of this.regionObjects) {
      if (!activeRegionIds.has(regionId)) {
        this.regionGroup.remove(obj);
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (obj.material instanceof THREE.Material) obj.material.dispose();
        }
        this.regionObjects.delete(regionId);
      }
    }

    for (const region of regions) {
      const regionId = region.id as SketchRegionId;
      const existing = this.regionObjects.get(regionId);
      if (existing) {
        this.regionGroup.remove(existing);
        if (existing instanceof THREE.Mesh) {
          existing.geometry.dispose();
          if (existing.material instanceof THREE.Material) existing.material.dispose();
        }
      }

      const selected = selectedIds.has(regionId);
      const hovered = hoveredTarget?.type === 'region' && hoveredTarget.id === regionId;
      const obj = this.createRegionObject(region, selected, hovered);
      if (obj) {
        this.regionGroup.add(obj);
        this.regionObjects.set(regionId, obj);
      }
    }
  }

  private createRegionObject(
    region: SketchRegion,
    selected: boolean,
    hovered: boolean,
  ): THREE.Object3D | null {
    const regionOutline = (r: SketchRegion): [number, number][] =>
      r.type === 'circle'
        ? makeCircleRegionVertices(r.center, Math.sqrt(r.area / Math.PI))
        : r.vertices;

    const vertices = regionOutline(region);
    if (vertices.length < 3) return null;

    const shape = new THREE.Shape(vertices.map(vertex => new THREE.Vector2(vertex[0], vertex[1])));
    // Nested holes (a circle inside this region) cut the fill, so the
    // annulus highlights as a ring — selecting it doesn't light up the
    // inner profile.
    for (const hole of region.holes ?? []) {
      const hv = regionOutline(hole);
      if (hv.length >= 3) {
        shape.holes.push(new THREE.Path(hv.map(v => new THREE.Vector2(v[0], v[1]))));
      }
    }
    const geometry = new THREE.ShapeGeometry(shape);
    const positions = geometry.attributes.position;
    if (positions) {
      for (let i = 0; i < positions.count; i++) {
        const u = positions.getX(i);
        const v = positions.getY(i);
        const world = this.toWorld(u, v).sub(this.plane.normal.clone().multiplyScalar(PLANE_OFFSET * 0.5));
        positions.setXYZ(i, world.x, world.y, world.z);
      }
      positions.needsUpdate = true;
    }

    const color = selected
      ? COLORS.regionSelected
      : hovered
        ? COLORS.regionHovered
        : COLORS.region;
    const opacity = selected ? 0.32 : hovered ? 0.24 : 0.14;
    const material = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 999;
    return mesh;
  }

  // ---- Private: Geometry Sync ----

  private syncGeometries(
    geometries: Map<SketchGeometryId, SketchGeometry>,
    points: Map<SketchPointId, SketchPoint>,
    selectedIds: Set<SketchGeometryId>,
    hoveredTarget: HitTarget,
    hoveredFromConstraint: ReadonlySet<SketchGeometryId> = new Set(),
  ): void {
    // Remove objects for deleted geometries
    for (const [gid, obj] of this.geometryObjects) {
      if (!geometries.has(gid)) {
        this.geometryGroup.remove(obj);
        if (obj instanceof THREE.Line) obj.geometry.dispose();
        this.geometryObjects.delete(gid);
      }
    }

    // Add/update objects for current geometries
    for (const [gid, geom] of geometries) {
      const selected = selectedIds.has(gid);
      const hovered = (hoveredTarget?.type === 'geometry' && hoveredTarget.id === gid)
        || hoveredFromConstraint.has(gid);

      const existing = this.geometryObjects.get(gid);
      if (existing) {
        // Update existing - dispose old geometry and rebuild
        this.geometryGroup.remove(existing);
        if (existing instanceof THREE.Line) existing.geometry.dispose();
      }

      const obj = this.createGeometryObject(geom, points, selected, hovered);
      if (obj) {
        this.geometryGroup.add(obj);
        this.geometryObjects.set(gid, obj);
      }
    }
  }

  /** Create a Line2 from world-space points */
  private makeLine2(worldPoints: THREE.Vector3[], material: LineMaterial): Line2 {
    const positions: number[] = [];
    for (const p of worldPoints) {
      positions.push(p.x, p.y, p.z);
    }
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    const line = new Line2(geometry, material);
    line.computeLineDistances();
    line.renderOrder = 1000;
    return line;
  }

  private createGeometryObject(
    geom: SketchGeometry,
    points: Map<SketchPointId, SketchPoint>,
    selected: boolean,
    hovered: boolean,
  ): THREE.Object3D | null {
    const material = selected
      ? this.selectedMaterial
      : hovered
        ? this.hoveredMaterial
        : geom.construction
          ? this.constructionMaterial
          : this.lineMaterial;

    switch (geom.type) {
      case 'line': {
        const start = points.get(geom.startId);
        const end = points.get(geom.endId);
        if (!start || !end) return null;

        return this.makeLine2([
          this.toWorld(start.x, start.y),
          this.toWorld(end.x, end.y),
        ], material);
      }
      case 'circle': {
        const center = points.get(geom.centerId);
        if (!center) return null;

        const circlePoints: THREE.Vector3[] = [];
        for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
          const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
          circlePoints.push(this.toWorld(
            center.x + geom.radius * Math.cos(angle),
            center.y + geom.radius * Math.sin(angle),
          ));
        }

        return this.makeLine2(circlePoints, material);
      }
      case 'arc': {
        const center = points.get(geom.centerId);
        const arcStart = points.get(geom.startId);
        const arcEnd = points.get(geom.endId);
        if (!center || !arcStart || !arcEnd) return null;

        // Derive radius from current points instead of the stored value so
        // the arc always visually passes through its start point (the end
        // may have drifted slightly if constraints aren't fully satisfied;
        // the solver's equidistance residual pulls it back). Average of
        // start/end distance softens any small residual mismatch.
        const rStart = Math.hypot(arcStart.x - center.x, arcStart.y - center.y);
        const rEnd = Math.hypot(arcEnd.x - center.x, arcEnd.y - center.y);
        const radius = (rStart + rEnd) * 0.5 || geom.radius;

        const startAngle = Math.atan2(arcStart.y - center.y, arcStart.x - center.x);
        let endAngle = Math.atan2(arcEnd.y - center.y, arcEnd.x - center.x);
        if (endAngle < startAngle) endAngle += Math.PI * 2;
        const deltaAngle = endAngle - startAngle;

        const arcPoints: THREE.Vector3[] = [];
        const segments = Math.max(16, Math.ceil(CIRCLE_SEGMENTS * (deltaAngle / (Math.PI * 2))));
        for (let i = 0; i <= segments; i++) {
          const angle = startAngle + (i / segments) * deltaAngle;
          arcPoints.push(this.toWorld(
            center.x + radius * Math.cos(angle),
            center.y + radius * Math.sin(angle),
          ));
        }

        return this.makeLine2(arcPoints, material);
      }
      case 'ellipse': {
        const center = points.get(geom.centerId);
        const major = points.get(geom.majorId);
        if (!center || !major) return null;

        const majorAngle = Math.atan2(major.y - center.y, major.x - center.x);
        const majorRadius = Math.hypot(major.x - center.x, major.y - center.y);
        const ellipsePoints: THREE.Vector3[] = [];
        for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
          const theta = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
          // Parameterize ellipse in local (major, minor) frame, then rotate
          const localX = majorRadius * Math.cos(theta);
          const localY = geom.minorRadius * Math.sin(theta);
          const x = center.x + localX * Math.cos(majorAngle) - localY * Math.sin(majorAngle);
          const y = center.y + localX * Math.sin(majorAngle) + localY * Math.cos(majorAngle);
          ellipsePoints.push(this.toWorld(x, y));
        }
        return this.makeLine2(ellipsePoints, material);
      }
      // There are no `slot` or `polygon` editor-geometry render cases:
      // the tools decompose at draw time into 2 lines + 2 arcs
      // (slot) or N lines + construction point (polygon), all of which
      // render through the existing `line` / `arc` / `point` cases.
      case 'spline': {
        if (geom.pointIds.length < 2) return null;
        const ctrl: [number, number][] = [];
        for (const pid of geom.pointIds) {
          const pt = points.get(pid);
          if (!pt) return null;
          ctrl.push([pt.x, pt.y]);
        }
        const interpolated = sampleSplinePolyline(ctrl, 16);
        const pts: THREE.Vector3[] = [];
        for (const [x, y] of interpolated) pts.push(this.toWorld(x, y));
        return this.makeLine2(pts, material);
      }
      case 'bezier': {
        const p0 = points.get(geom.startId);
        const c1 = points.get(geom.cp1Id);
        const c2 = points.get(geom.cp2Id);
        const p3 = points.get(geom.endId);
        if (!p0 || !c1 || !c2 || !p3) return null;
        const sampled = sampleCubicBezier([p0.x, p0.y], [c1.x, c1.y], [c2.x, c2.y], [p3.x, p3.y], 32);
        return this.makeLine2(sampled.map(([x, y]) => this.toWorld(x, y)), material);
      }
      case 'point': {
        // Standalone points are rendered via the point sync pass.
        return null;
      }
    }
  }

  // ---- Private: Point Sync ----

  private syncPoints(
    points: Map<SketchPointId, SketchPoint>,
    selectedIds: Set<SketchPointId>,
    hoveredTarget: HitTarget,
    hoveredFromConstraint: ReadonlySet<SketchPointId> = new Set(),
  ): void {
    // Remove deleted points
    for (const [pid, mesh] of this.pointObjects) {
      if (!points.has(pid)) {
        this.pointGroup.remove(mesh);
        this.pointObjects.delete(pid);
      }
    }

    // Add/update points
    for (const [pid, pt] of points) {
      const selected = selectedIds.has(pid);
      const hovered = (hoveredTarget?.type === 'point' && hoveredTarget.id === pid)
        || hoveredFromConstraint.has(pid);

      let mesh = this.pointObjects.get(pid);

      if (!mesh) {
        mesh = new THREE.Mesh(this.pointGeometry, this.pointMaterial);
        mesh.renderOrder = 1001;
        this.pointGroup.add(mesh);
        this.pointObjects.set(pid, mesh);
      }

      // Update position
      const worldPos = this.toWorld(pt.x, pt.y);
      mesh.position.copy(worldPos);

      // Billboard: always face camera
      mesh.lookAt(this.camera.position);

      // Scale point to constant screen size. The origin is rendered
      // slightly larger so the anchor reads from across the canvas.
      const isOrigin = pid === ORIGIN_POINT_ID;
      const dist = this.camera.position.distanceTo(worldPos);
      const baseSize = selected ? SELECTED_POINT_SIZE : POINT_SIZE;
      const scale = dist * baseSize * (isOrigin ? 0.0014 : 0.001);
      mesh.scale.set(scale, scale, scale);

      // Material — selection / hover still win over the origin tint so the
      // user gets the standard highlight feedback when interacting with it.
      mesh.material = selected
        ? this.pointSelectedMaterial
        : hovered
          ? this.pointHoveredMaterial
          : isOrigin
            ? this.pointOriginMaterial
            : this.pointMaterial;
    }
  }

  // ---- Private: Preview Sync ----

  private syncPreview(preview: SketchPreviewData): void {
    // Clear existing preview
    while (this.previewGroup.children.length > 0) {
      const child = this.previewGroup.children[0]!;
      this.previewGroup.remove(child);
      if (child instanceof Line2) child.geometry.dispose();
    }

    if (!preview) return;

    switch (preview.type) {
      case 'line': {
        const line = this.makeLine2([
          this.toWorld(preview.startX, preview.startY),
          this.toWorld(preview.endX, preview.endY),
        ], this.previewMaterial);
        this.previewGroup.add(line);
        break;
      }
      case 'rectangle': {
        const x1 = Math.min(preview.x1, preview.x2);
        const y1 = Math.min(preview.y1, preview.y2);
        const x2 = Math.max(preview.x1, preview.x2);
        const y2 = Math.max(preview.y1, preview.y2);

        const line = this.makeLine2([
          this.toWorld(x1, y1),
          this.toWorld(x2, y1),
          this.toWorld(x2, y2),
          this.toWorld(x1, y2),
          this.toWorld(x1, y1),
        ], this.previewMaterial);
        this.previewGroup.add(line);
        break;
      }
      case 'circle': {
        const circlePoints: THREE.Vector3[] = [];
        for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
          const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
          circlePoints.push(this.toWorld(
            preview.centerX + preview.radius * Math.cos(angle),
            preview.centerY + preview.radius * Math.sin(angle),
          ));
        }

        const line = this.makeLine2(circlePoints, this.previewMaterial);
        this.previewGroup.add(line);
        break;
      }
      case 'arc': {
        const start = preview.startAngle;
        let end = preview.endAngle;
        if (end < start) end += Math.PI * 2;
        const segments = Math.max(16, Math.ceil(CIRCLE_SEGMENTS * (end - start) / (Math.PI * 2)));
        const arcPoints: THREE.Vector3[] = [];
        for (let i = 0; i <= segments; i++) {
          const t = start + ((end - start) * i) / segments;
          arcPoints.push(this.toWorld(
            preview.centerX + preview.radius * Math.cos(t),
            preview.centerY + preview.radius * Math.sin(t),
          ));
        }
        this.previewGroup.add(this.makeLine2(arcPoints, this.previewMaterial));
        break;
      }
      case 'polygon': {
        const baseAngle = Math.atan2(preview.vertexY - preview.centerY, preview.vertexX - preview.centerX);
        const r = Math.hypot(preview.vertexX - preview.centerX, preview.vertexY - preview.centerY);
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= preview.sides; i++) {
          const theta = baseAngle + (i / preview.sides) * Math.PI * 2;
          pts.push(this.toWorld(
            preview.centerX + r * Math.cos(theta),
            preview.centerY + r * Math.sin(theta),
          ));
        }
        this.previewGroup.add(this.makeLine2(pts, this.previewMaterial));
        break;
      }
      case 'slot': {
        const dx = preview.x2 - preview.x1;
        const dy = preview.y2 - preview.y1;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) break;
        const r = preview.width / 2;
        const axisAngle = Math.atan2(dy, dx);
        const segments = 24;
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= segments; i++) {
          const t = axisAngle - Math.PI / 2 + (i / segments) * Math.PI;
          pts.push(this.toWorld(preview.x2 + r * Math.cos(t), preview.y2 + r * Math.sin(t)));
        }
        for (let i = 0; i <= segments; i++) {
          const t = axisAngle + Math.PI / 2 + (i / segments) * Math.PI;
          pts.push(this.toWorld(preview.x1 + r * Math.cos(t), preview.y1 + r * Math.sin(t)));
        }
        // close
        pts.push(pts[0]!.clone());
        this.previewGroup.add(this.makeLine2(pts, this.previewMaterial));
        break;
      }
      case 'ellipse': {
        const majorAngle = Math.atan2(preview.majorY - preview.centerY, preview.majorX - preview.centerX);
        const majorRadius = Math.hypot(preview.majorX - preview.centerX, preview.majorY - preview.centerY);
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
          const theta = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
          const lx = majorRadius * Math.cos(theta);
          const ly = preview.minorRadius * Math.sin(theta);
          const x = preview.centerX + lx * Math.cos(majorAngle) - ly * Math.sin(majorAngle);
          const y = preview.centerY + lx * Math.sin(majorAngle) + ly * Math.cos(majorAngle);
          pts.push(this.toWorld(x, y));
        }
        this.previewGroup.add(this.makeLine2(pts, this.previewMaterial));
        break;
      }
      case 'spline': {
        if (preview.points.length === 0) break;
        const all: [number, number][] = [...preview.points, [preview.cursorX, preview.cursorY]];
        if (all.length < 2) break;
        const sampled = catmullRomSpline(all, 16);
        const pts: THREE.Vector3[] = sampled.map(([x, y]) => this.toWorld(x, y));
        this.previewGroup.add(this.makeLine2(pts, this.previewMaterial));
        break;
      }
      case 'outline': {
        for (const loop of preview.loops) {
          if (loop.length < 2) continue;
          this.previewGroup.add(this.makeLine2(loop.map(([x, y]) => this.toWorld(x, y)), this.previewMaterial));
        }
        break;
      }
    }
  }

  // ---- Private: Snap Marker Sync ----

  private syncSnapMarker(activeSnap: SnapResult | null): void {
    while (this.snapGroup.children.length > 0) {
      const child = this.snapGroup.children[0]!;
      this.snapGroup.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) child.material.dispose();
      }
    }

    if (!activeSnap || activeSnap.type === 'none') return;

    const worldPos = this.toWorld(activeSnap.x, activeSnap.y)
      .addScaledVector(this.plane.normal, PLANE_OFFSET * 2);
    const color = activeSnap.type === 'point'
      ? COLORS.snapPoint
      : activeSnap.type === 'midpoint'
        ? COLORS.snapMidpoint
        : COLORS.snapGrid;
    const geometry = activeSnap.type === 'midpoint'
      ? new THREE.RingGeometry(0.45, 0.7, 4)
      : new THREE.RingGeometry(0.45, 0.7, 24);
    const material = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
    });
    const marker = new THREE.Mesh(geometry, material);
    marker.position.copy(worldPos);
    marker.lookAt(this.camera.position);
    marker.renderOrder = 1200;

    const dist = this.camera.position.distanceTo(worldPos);
    const scale = dist * 0.012;
    marker.scale.set(scale, scale, scale);
    this.snapGroup.add(marker);
  }

  // ---- Private: Grid ----

  private createGrid(): void {
    const halfSize = GRID_SIZE / 2;
    const step = GRID_SIZE / GRID_DIVISIONS;

    // Minor grid lines
    const gridMaterial = new THREE.LineBasicMaterial({
      color: COLORS.gridMinor,
      transparent: true,
      opacity: 0.5,
    });

    for (let i = -GRID_DIVISIONS / 2; i <= GRID_DIVISIONS / 2; i++) {
      const offset = i * step;

      // Lines along U axis
      const uGeom = new THREE.BufferGeometry().setFromPoints([
        this.toWorld(-halfSize, offset),
        this.toWorld(halfSize, offset),
      ]);
      const uLine = new THREE.Line(uGeom, i === 0 ? new THREE.LineBasicMaterial({ color: COLORS.gridXAxis }) : gridMaterial);
      uLine.renderOrder = 998;
      this.gridGroup.add(uLine);

      // Lines along V axis
      const vGeom = new THREE.BufferGeometry().setFromPoints([
        this.toWorld(offset, -halfSize),
        this.toWorld(offset, halfSize),
      ]);
      const vLine = new THREE.Line(vGeom, i === 0 ? new THREE.LineBasicMaterial({ color: COLORS.gridYAxis }) : gridMaterial);
      vLine.renderOrder = 998;
      this.gridGroup.add(vLine);
    }
  }

  // ---- Private: Coordinate Mapping ----

  /** Convert sketch 2D (u, v) to world 3D position */
  private toWorld(u: number, v: number): THREE.Vector3 {
    return this.plane.origin.clone()
      .addScaledVector(this.plane.uAxis, u)
      .addScaledVector(this.plane.vAxis, v)
      .addScaledVector(this.plane.normal, PLANE_OFFSET);
  }
}

// ---- Hit Test Helpers ----

function isNearGeometry(
  x: number,
  y: number,
  geom: SketchGeometry,
  points: Map<SketchPointId, SketchPoint>,
  tolerance: number,
): boolean {
  switch (geom.type) {
    case 'line': {
      const start = points.get(geom.startId);
      const end = points.get(geom.endId);
      if (!start || !end) return false;
      return distanceToSegment(x, y, start.x, start.y, end.x, end.y) <= tolerance;
    }
    case 'circle': {
      const center = points.get(geom.centerId);
      if (!center) return false;
      const dist = Math.sqrt((x - center.x) ** 2 + (y - center.y) ** 2);
      return Math.abs(dist - geom.radius) <= tolerance;
    }
    case 'arc': {
      const center = points.get(geom.centerId);
      if (!center) return false;
      const dist = Math.sqrt((x - center.x) ** 2 + (y - center.y) ** 2);
      return Math.abs(dist - geom.radius) <= tolerance;
    }
    case 'ellipse': {
      // Approximate hit test: distance to ellipse contour via sampled points
      const center = points.get(geom.centerId);
      const major = points.get(geom.majorId);
      if (!center || !major) return false;
      const majorAngle = Math.atan2(major.y - center.y, major.x - center.x);
      const majorRadius = Math.hypot(major.x - center.x, major.y - center.y);
      let best = Infinity;
      const samples = 32;
      for (let i = 0; i < samples; i++) {
        const theta = (i / samples) * Math.PI * 2;
        const lx = majorRadius * Math.cos(theta);
        const ly = geom.minorRadius * Math.sin(theta);
        const px = center.x + lx * Math.cos(majorAngle) - ly * Math.sin(majorAngle);
        const py = center.y + lx * Math.sin(majorAngle) + ly * Math.cos(majorAngle);
        const d = Math.hypot(x - px, y - py);
        if (d < best) best = d;
      }
      return best <= tolerance;
    }
    // There are no `slot` or `polygon` hit-test cases — decomposed
    // primitives flow through the line / arc cases instead.
    case 'spline': {
      if (geom.pointIds.length < 2) return false;
      const ctrl: [number, number][] = [];
      for (const pid of geom.pointIds) {
        const pt = points.get(pid);
        if (!pt) return false;
        ctrl.push([pt.x, pt.y]);
      }
      const sampled = sampleSplinePolyline(ctrl, 8);
      for (let i = 1; i < sampled.length; i++) {
        const [x1, y1] = sampled[i - 1]!;
        const [x2, y2] = sampled[i]!;
        if (distanceToSegment(x, y, x1, y1, x2, y2) <= tolerance) return true;
      }
      return false;
    }
    case 'bezier': {
      const p0 = points.get(geom.startId);
      const c1 = points.get(geom.cp1Id);
      const c2 = points.get(geom.cp2Id);
      const p3 = points.get(geom.endId);
      if (!p0 || !c1 || !c2 || !p3) return false;
      const sampled = sampleCubicBezier([p0.x, p0.y], [c1.x, c1.y], [c2.x, c2.y], [p3.x, p3.y], 16);
      for (let i = 1; i < sampled.length; i++) {
        const [x1, y1] = sampled[i - 1]!;
        const [x2, y2] = sampled[i]!;
        if (distanceToSegment(x, y, x1, y1, x2, y2) <= tolerance) return true;
      }
      return false;
    }
    case 'point': {
      const pt = points.get(geom.pointId);
      if (!pt) return false;
      return Math.hypot(x - pt.x, y - pt.y) <= tolerance;
    }
  }
}

function distanceToSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

function makeCircleRegionVertices(center: [number, number], radius: number): [number, number][] {
  const vertices: [number, number][] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    vertices.push([
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle),
    ]);
  }
  return vertices;
}

/** Ray-cast against a region's outer outline only (ignores holes). */
function isPointInRegionOutline(x: number, y: number, region: SketchRegion): boolean {
  const vertices = region.type === 'circle'
    ? makeCircleRegionVertices(region.center, Math.sqrt(region.area / Math.PI))
    : region.vertices;
  if (vertices.length < 3) return false;

  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const current = vertices[i]!;
    const previous = vertices[j]!;
    const intersects = ((current[1] > y) !== (previous[1] > y)) &&
      (x < ((previous[0] - current[0]) * (y - current[1])) / (previous[1] - current[1]) + current[0]);
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Hole-aware containment: inside the outer outline but NOT inside any
 *  nested hole, so clicking an annulus's centre selects the inner profile,
 *  not the annulus. */
function isPointInRegion(x: number, y: number, region: SketchRegion): boolean {
  if (!isPointInRegionOutline(x, y, region)) return false;
  for (const hole of region.holes ?? []) {
    if (isPointInRegionOutline(x, y, hole)) return false;
  }
  return true;
}
