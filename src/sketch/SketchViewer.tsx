/**
 * SketchViewer - Readonly sketch display in the 3D viewport.
 *
 * Renders sketch entities (lines, circles, rectangles, arcs) from the
 * document model as Three.js Line2 objects on the sketch plane.
 *
 * Two modes:
 * 1. Display-only: renders geometry with no interaction (eye icon visibility)
 * 2. Profile picker: renders geometry + selectable regions, reports clicks
 *
 * No grid, no points, no snap, no preview, no cursor, no tools, no palette.
 * Reads directly from the document model (SketchFeatureInputs).
 */

import { sketchBuildGeometry } from '@tweakcad/core/src/sketch/derivedGeometry.ts';
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import type { ViewportController } from '@tweakcad/viewport/src/ViewportController.ts';
import type {
  SketchFeatureInputs,
  SketchEntity,
  ProfileRef,
} from '@tweakcad/core/src/document/schema.ts';
import type { FeatureId } from '@tweakcad/core/src/ids.ts';
import { detectSketchRegions, regionToProfileRef, resolveProfile } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
import {
  resolveSketchPlane,
  sketchPlaneKey,
  type SketchPlaneConfig,
  type SketchPlaneInput,
} from './SketchSceneManager.ts';
import { sampleSplinePolyline, sampleCubicBezier } from './curveTessellation.ts';

// ---- Constants ----

const CIRCLE_SEGMENTS = 64;
const PLANE_OFFSET = 0.01;

const VIEWER_COLORS = {
  line: 0x3b82f6,               // blue
  construction: 0x94a3b8,       // slate
  region: 0x93c5fd,             // translucent blue
  regionSelected: 0xfbbf24,     // translucent amber
  regionHovered: 0x60a5fa,      // translucent lighter blue
};

// ---- Props ----

export interface SketchViewerProps {
  /** The sketch feature inputs from the document model */
  sketchInputs: SketchFeatureInputs;
  /** The viewport controller to render into */
  viewportCtrl: ViewportController;
  /**
   * The plane for this sketch. A bare 'XY'|'XZ'|'YZ' name is a default datum
   * plane; a full config carries an explicit world basis (construction planes).
   */
  planeName: SketchPlaneInput;
  /**
   * Enable profile-picking mode. When set, regions are rendered and clickable.
   * Callback receives the updated list of selected ProfileRefs.
   */
  onProfilesChanged?: ((profiles: ProfileRef[]) => void) | undefined;
  /** Sketch feature ID (needed for ProfileRef creation in picker mode) */
  sketchId?: FeatureId | undefined;
  /** Pre-selected profiles (for editing existing extrude) */
  initialProfiles?: ProfileRef[] | undefined;
}

// ---- Component ----

export function SketchViewer({
  sketchInputs,
  viewportCtrl,
  planeName,
  onProfilesChanged,
  sketchId,
  initialProfiles,
}: SketchViewerProps) {
  const rootRef = useRef<THREE.Group | null>(null);
  const regionGroupRef = useRef<THREE.Group | null>(null);
  const regionsRef = useRef<SketchRegion[]>([]);
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const [selectedCount, setSelectedCount] = useState(0);
  const planeRef = useRef<SketchPlaneConfig | null>(null);
  const pickerMode = !!onProfilesChanged;

  // Resolve the plane to a world basis, but keep its identity stable across
  // renders (a construction-plane config is rebuilt fresh each render, so
  // depending on its object identity would tear down + rebuild the scene
  // objects on every parent re-render). Key on the numeric basis instead.
  const planeKey = sketchPlaneKey(planeName);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plane = useMemo(() => resolveSketchPlane(planeName), [planeKey]);

  // Build regions and set initial selection.
  //
  // Pre-selection uses `resolveProfile` (the same matcher buildExtrude
  // uses) instead of raw entity-ID set equality. Why: for sketches like
  // rect+inscribed-circle, four corner regions all share the same
  // entity set {rect_outer, circle_inner}. A raw set-equality match
  // selects ALL FOUR for any single stored corner profile — which
  // makes the toggle look broken: clicking to deselect one corner
  // emits 3 profiles upstream, the effect re-runs, and all 4 land back
  // in the selection. `resolveProfile` disambiguates via the stored
  // `interiorPoint`, picking the one region that actually contains it.
  useEffect(() => {
    const regions = detectSketchRegions(sketchBuildGeometry(sketchInputs));
    regionsRef.current = regions;

    const initialIds = new Set<string>();
    if (initialProfiles && initialProfiles.length > 0) {
      for (const profileRef of initialProfiles) {
        const resolved = resolveProfile(profileRef, regions);
        if (resolved.status === 'resolved' && resolved.region) {
          initialIds.add(resolved.region.id);
        }
      }
    }
    selectedIdsRef.current = initialIds;
    setSelectedCount(initialIds.size);
  }, [sketchInputs, initialProfiles]);

  // Main scene setup: geometry lines + region fills
  useEffect(() => {
    const scene = viewportCtrl.getScene();
    const renderer = viewportCtrl.getRenderer();
    const rendererSize = new THREE.Vector2();
    renderer.getSize(rendererSize);
    planeRef.current = plane;

    // Create root group
    const root = new THREE.Group();
    root.name = 'SketchViewerRoot';
    root.renderOrder = 999;
    rootRef.current = root;

    // Create shared materials
    const lineMaterial = new LineMaterial({
      color: VIEWER_COLORS.line,
      linewidth: 1,
      resolution: rendererSize,
    });
    const constructionMaterial = new LineMaterial({
      color: VIEWER_COLORS.construction,
      linewidth: 1,
      dashed: true,
      dashSize: 1,
      gapSize: 1,
      resolution: rendererSize,
    });

    // Render entity geometry
    renderEntities(root, sketchBuildGeometry(sketchInputs), plane, lineMaterial, constructionMaterial);

    // Region group (for picker mode)
    const regionGroup = new THREE.Group();
    regionGroup.name = 'SketchViewerRegions';
    root.add(regionGroup);
    regionGroupRef.current = regionGroup;

    if (pickerMode) {
      renderRegions(regionGroup, regionsRef.current, selectedIdsRef.current, plane);
    }

    scene.add(root);
    viewportCtrl.requestRender();

    return () => {
      scene.remove(root);
      viewportCtrl.requestRender();
      disposeGroup(root);
      lineMaterial.dispose();
      constructionMaterial.dispose();
      rootRef.current = null;
      regionGroupRef.current = null;
    };
  }, [sketchInputs, viewportCtrl, plane, pickerMode]);

  // Update region fills when selection changes
  useEffect(() => {
    const regionGroup = regionGroupRef.current;
    const plane = planeRef.current;
    if (!regionGroup || !plane || !pickerMode) return;

    // Clear and re-render regions with current selection
    disposeGroup(regionGroup);
    while (regionGroup.children.length > 0) {
      regionGroup.remove(regionGroup.children[0]!);
    }
    renderRegions(regionGroup, regionsRef.current, selectedIdsRef.current, plane);
    viewportCtrl.requestRender();
  }, [selectedCount, pickerMode, viewportCtrl]);

  // Click handler for region picking
  const handleCanvasClick = useCallback((e: MouseEvent) => {
    if (!pickerMode) return;
    const plane = planeRef.current;
    if (!plane) return;

    const canvas = viewportCtrl.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    const worldPoint = viewportCtrl.projectOntoPlane(ndcX, ndcY, plane.normal, plane.origin);
    if (!worldPoint) return;

    const offset = worldPoint.clone().sub(plane.origin);
    const u = offset.dot(plane.uAxis);
    const v = offset.dot(plane.vAxis);

    // Find hit region (smallest area first for most specific hit)
    const hitRegions = regionsRef.current
      .filter(region => isPointInRegion(u, v, region))
      .sort((a, b) => a.area - b.area);

    if (hitRegions.length === 0) return;
    const hitRegion = hitRegions[0]!;

    // Toggle selection
    const selected = selectedIdsRef.current;
    if (selected.has(hitRegion.id)) {
      selected.delete(hitRegion.id);
    } else {
      selected.add(hitRegion.id);
    }
    setSelectedCount(selected.size);

    // Report to parent
    if (onProfilesChanged && sketchId) {
      const allRegions = regionsRef.current;
      const profiles = allRegions
        .filter(r => selected.has(r.id))
        .map(r => regionToProfileRef(sketchId, r, allRegions));
      onProfilesChanged(profiles);
    }
  }, [pickerMode, viewportCtrl, onProfilesChanged, sketchId]);

  // Attach click listener to canvas
  useEffect(() => {
    if (!pickerMode) return;
    const canvas = viewportCtrl.getCanvas();
    canvas.addEventListener('click', handleCanvasClick);
    return () => canvas.removeEventListener('click', handleCanvasClick);
  }, [pickerMode, viewportCtrl, handleCanvasClick]);

  // Render no DOM elements — only Three.js scene objects
  return null;
}

// ---- Region rendering ----

function renderRegions(
  group: THREE.Group,
  regions: SketchRegion[],
  selectedIds: Set<string>,
  plane: SketchPlaneConfig,
): void {
  for (const region of regions) {
    const selected = selectedIds.has(region.id);
    const obj = createRegionObject(region, selected, false, plane);
    if (obj) {
      group.add(obj);
    }
  }
}

function createRegionObject(
  region: SketchRegion,
  selected: boolean,
  hovered: boolean,
  plane: SketchPlaneConfig,
): THREE.Object3D | null {
  const outline = (r: SketchRegion): [number, number][] =>
    r.type === 'circle'
      ? makeCircleRegionVertices(r.center, Math.sqrt(r.area / Math.PI))
      : r.vertices;

  const vertices = outline(region);
  if (vertices.length < 3) return null;

  const shape = new THREE.Shape(vertices.map(v => new THREE.Vector2(v[0], v[1])));
  // Nested holes cut the fill so the annulus highlights as a ring — its
  // inner profile stays unselected (its own fill, no overlap stacking).
  for (const hole of region.holes ?? []) {
    const hv = outline(hole);
    if (hv.length >= 3) {
      shape.holes.push(new THREE.Path(hv.map(p => new THREE.Vector2(p[0], p[1]))));
    }
  }
  const geometry = new THREE.ShapeGeometry(shape);
  const positions = geometry.attributes.position;
  if (positions) {
    for (let i = 0; i < positions.count; i++) {
      const u = positions.getX(i);
      const v = positions.getY(i);
      const world = toWorld(plane, u, v);
      // Slightly below the sketch lines to avoid z-fighting
      world.addScaledVector(plane.normal, -PLANE_OFFSET * 0.5);
      positions.setXYZ(i, world.x, world.y, world.z);
    }
    positions.needsUpdate = true;
  }

  const color = selected
    ? VIEWER_COLORS.regionSelected
    : hovered
      ? VIEWER_COLORS.regionHovered
      : VIEWER_COLORS.region;
  const opacity = selected ? 0.35 : hovered ? 0.25 : 0.15;
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

// ---- Geometry rendering ----

function renderEntities(
  group: THREE.Group,
  entities: Record<string, SketchEntity>,
  plane: SketchPlaneConfig,
  lineMaterial: LineMaterial,
  constructionMaterial: LineMaterial,
): void {
  for (const entity of Object.values(entities)) {
    const material = entity.construction ? constructionMaterial : lineMaterial;
    const obj = createEntityObject(entity, plane, material);
    if (obj) {
      group.add(obj);
    }
  }
}

function createEntityObject(
  entity: SketchEntity,
  plane: SketchPlaneConfig,
  material: LineMaterial,
): THREE.Object3D | null {
  switch (entity.type) {
    case 'line': {
      const sx = parseFloat(String(entity.start[0]));
      const sy = parseFloat(String(entity.start[1]));
      const ex = parseFloat(String(entity.end[0]));
      const ey = parseFloat(String(entity.end[1]));
      if (isNaN(sx) || isNaN(sy) || isNaN(ex) || isNaN(ey)) return null;
      return makeLine2([toWorld(plane, sx, sy), toWorld(plane, ex, ey)], material);
    }
    case 'circle': {
      const cx = parseFloat(String(entity.center[0]));
      const cy = parseFloat(String(entity.center[1]));
      const diameter = parseFloat(String(entity.diameter));
      if (isNaN(cx) || isNaN(cy) || isNaN(diameter)) return null;
      const radius = diameter / 2;
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
        const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
        points.push(toWorld(plane, cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)));
      }
      return makeLine2(points, material);
    }
    // There are no `'rectangle'` / `'slot'` composite cases:
    // rectangles arrive as 4 lines, slots as 2 lines + 2 arcs. Both
    // render through the `'line'` and `'arc'` cases.
    case 'arc': {
      const cx = parseFloat(String(entity.center[0]));
      const cy = parseFloat(String(entity.center[1]));
      const radius = parseFloat(String(entity.radius));
      const startAngle = parseFloat(String(entity.startAngle));
      const endAngle = parseFloat(String(entity.endAngle));
      if (isNaN(cx) || isNaN(cy) || isNaN(radius) || isNaN(startAngle) || isNaN(endAngle)) return null;
      let delta = endAngle - startAngle;
      if (delta < 0) delta += Math.PI * 2;
      const segments = Math.max(16, Math.ceil(CIRCLE_SEGMENTS * (delta / (Math.PI * 2))));
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= segments; i++) {
        const angle = startAngle + (i / segments) * delta;
        points.push(toWorld(plane, cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)));
      }
      return makeLine2(points, material);
    }
    case 'ellipse': {
      const cx = parseFloat(String(entity.center[0]));
      const cy = parseFloat(String(entity.center[1]));
      const mx = parseFloat(String(entity.majorEnd[0]));
      const my = parseFloat(String(entity.majorEnd[1]));
      const minor = parseFloat(String(entity.minorRadius));
      if (isNaN(cx) || isNaN(cy) || isNaN(mx) || isNaN(my) || isNaN(minor)) return null;
      const majorAngle = Math.atan2(my - cy, mx - cx);
      const majorRadius = Math.hypot(mx - cx, my - cy);
      if (majorRadius === 0) return null;
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
        const theta = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
        // Parameterize in the local (major, minor) frame, then rotate.
        const localX = majorRadius * Math.cos(theta);
        const localY = minor * Math.sin(theta);
        const x = cx + localX * Math.cos(majorAngle) - localY * Math.sin(majorAngle);
        const y = cy + localX * Math.sin(majorAngle) + localY * Math.cos(majorAngle);
        points.push(toWorld(plane, x, y));
      }
      return makeLine2(points, material);
    }
    case 'spline': {
      const ctrl: [number, number][] = [];
      for (const [xe, ye] of entity.points) {
        const x = parseFloat(String(xe));
        const y = parseFloat(String(ye));
        if (isNaN(x) || isNaN(y)) return null;
        ctrl.push([x, y]);
      }
      if (ctrl.length < 2) return null;
      const sampled = sampleSplinePolyline(ctrl, 16);
      return makeLine2(sampled.map(([x, y]) => toWorld(plane, x, y)), material);
    }
    case 'bezier': {
      const p0x = parseFloat(String(entity.start[0])), p0y = parseFloat(String(entity.start[1]));
      const c1x = parseFloat(String(entity.cp1[0])), c1y = parseFloat(String(entity.cp1[1]));
      const c2x = parseFloat(String(entity.cp2[0])), c2y = parseFloat(String(entity.cp2[1]));
      const p3x = parseFloat(String(entity.end[0])), p3y = parseFloat(String(entity.end[1]));
      if ([p0x, p0y, c1x, c1y, c2x, c2y, p3x, p3y].some(isNaN)) return null;
      const sampled = sampleCubicBezier([p0x, p0y], [c1x, c1y], [c2x, c2y], [p3x, p3y], 32);
      return makeLine2(sampled.map(([x, y]) => toWorld(plane, x, y)), material);
    }
    case 'point':
      // Standalone reference point — not drawn in the readonly overlay
      // (matches the DXF/SVG export, which excludes reference points).
      return null;
    default:
      return null;
  }
}

// ---- Hit testing ----

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

/** Hole-aware: inside the outer outline but not inside any nested hole, so
 *  clicking the centre of an annulus picks the inner profile, not the ring. */
function isPointInRegion(x: number, y: number, region: SketchRegion): boolean {
  if (!isPointInRegionOutline(x, y, region)) return false;
  for (const hole of region.holes ?? []) {
    if (isPointInRegionOutline(x, y, hole)) return false;
  }
  return true;
}

// ---- Geometry helpers ----

function toWorld(plane: SketchPlaneConfig, u: number, v: number): THREE.Vector3 {
  return plane.origin.clone()
    .addScaledVector(plane.uAxis, u)
    .addScaledVector(plane.vAxis, v)
    .addScaledVector(plane.normal, PLANE_OFFSET);
}

function makeLine2(worldPoints: THREE.Vector3[], material: LineMaterial): Line2 {
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

function disposeGroup(group: THREE.Group): void {
  group.traverse((child) => {
    if (child instanceof Line2) {
      child.geometry.dispose();
    } else if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (child.material instanceof THREE.Material) child.material.dispose();
    }
  });
}
