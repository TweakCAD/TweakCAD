/**
 * Overlay geometry for the selection and the hover: a face as its triangle
 * range of the body mesh, an edge as its segment range, a sketch curve or
 * axis as a recoloured copy, a point as a larger dot, a region or plane as a
 * tinted copy. Overlays are added beside what they mark (same parent, so
 * the same instance placement) and are never pickable.
 */
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { HIGHLIGHT_EDGE_PIXELS, ORDER, type HighlightStyle } from './style';

/** Something drawn that an item highlights. */
export type Drawn =
  | { kind: 'face'; mesh: THREE.Mesh; first: number; count: number }
  | { kind: 'edge'; lines: THREE.LineSegments; first: number; count: number }
  | { kind: 'line'; line: THREE.Line }
  | { kind: 'point'; points: THREE.Points; index: number }
  | { kind: 'surface'; mesh: THREE.Mesh };

const noRaycast = (): void => undefined;

/** Builds the overlay for one drawn thing, or null when there is nothing to show. */
export function overlayFor(d: Drawn, style: HighlightStyle): THREE.Object3D | null {
  let object: THREE.Object3D;
  if (d.kind === 'face') {
    const src = d.mesh.geometry;
    const index = src.getIndex();
    const position = src.getAttribute('position');
    if (!index || !position || d.count <= 0) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', position);
    const normal = src.getAttribute('normal');
    if (normal) geom.setAttribute('normal', normal);
    geom.setIndex(
      new THREE.BufferAttribute((index.array as Uint32Array).slice(d.first * 3, (d.first + d.count) * 3), 1),
    );
    object = new THREE.Mesh(
      geom,
      new THREE.MeshBasicMaterial({
        color: style.faceColor,
        transparent: true,
        opacity: style.faceOpacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
  } else if (d.kind === 'edge') {
    const position = d.lines.geometry.getAttribute('position');
    if (!position || d.count <= 0) return null;
    object = wideSegments(
      (position.array as Float32Array).slice(d.first * 6, (d.first + d.count) * 6),
      style.lineColor,
    );
  } else if (d.kind === 'line') {
    // Sketch curves and construction outlines, as wide as a highlighted edge.
    const position = d.line.geometry.getAttribute('position');
    if (!position || position.count < 2) return null;
    const points = position.array as Float32Array;
    object = wideSegments(
      d.line instanceof THREE.LineSegments
        ? points.slice(0, (position.count - (position.count % 2)) * 3)
        : stripAsSegments(points, position.count, d.line instanceof THREE.LineLoop),
      style.lineColor,
    );
    object.position.copy(d.line.position);
    object.quaternion.copy(d.line.quaternion);
    object.scale.copy(d.line.scale);
  } else if (d.kind === 'point') {
    const position = d.points.geometry.getAttribute('position');
    if (!position) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([position.getX(d.index), position.getY(d.index), position.getZ(d.index)]),
        3,
      ),
    );
    object = new THREE.Points(
      geom,
      new THREE.PointsMaterial({
        color: style.lineColor,
        size: 9,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
      }),
    );
    object.position.copy(d.points.position);
  } else {
    const material = new THREE.MeshBasicMaterial({
      color: style.regionColor,
      transparent: true,
      opacity: style.regionOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    object = new THREE.Mesh(d.mesh.geometry, material);
    object.position.copy(d.mesh.position);
    object.quaternion.copy(d.mesh.quaternion);
    object.scale.copy(d.mesh.scale);
    object.userData.sharedGeometry = true;
  }
  object.renderOrder = ORDER.highlight;
  object.raycast = noRaycast;
  object.userData.overlay = true;
  return object;
}

const drawSize = new THREE.Vector2();

/** Segments drawn `HIGHLIGHT_EDGE_PIXELS` wide, through bodies, so a highlighted line stays visible where a face covers it. */
function wideSegments(positions: Float32Array, color: number): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  const material = new LineMaterial({
    color,
    linewidth: HIGHLIGHT_EDGE_PIXELS,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  const lines = new LineSegments2(geometry, material);
  lines.onBeforeRender = (renderer) => {
    renderer.getSize(drawSize);
    if (!material.resolution.equals(drawSize)) material.resolution.copy(drawSize);
  };
  return lines;
}

/** A polyline's `count` points as segment pairs; a loop closes back to its first point. */
function stripAsSegments(points: Float32Array, count: number, closed: boolean): Float32Array {
  const segments = count - 1 + (closed ? 1 : 0);
  const out = new Float32Array(segments * 6);
  for (let i = 0; i < segments; i++) {
    const a = i * 3;
    const b = ((i + 1) % count) * 3;
    out.set(points.subarray(a, a + 3), i * 6);
    out.set(points.subarray(b, b + 3), i * 6 + 3);
  }
  return out;
}

/** The parent a drawn thing hangs from, where its overlay goes. */
export function parentOf(d: Drawn): THREE.Object3D | null {
  const object =
    d.kind === 'face' || d.kind === 'surface'
      ? d.mesh
      : d.kind === 'edge'
        ? d.lines
        : d.kind === 'line'
          ? d.line
          : d.points;
  return object.parent;
}

/** Removes and frees overlays. */
export function disposeOverlays(overlays: readonly THREE.Object3D[]): void {
  for (const o of overlays) {
    o.parent?.remove(o);
    const shared = o.userData.sharedGeometry === true;
    const mesh = o as THREE.Mesh;
    if (!shared) mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  }
}
