/**
 * Default sketch-plane handedness. Each default plane's (u, v, normal) must be
 * right-handed and identical in the editor and the worker, so sketch
 * coordinates (hand-drawn, imported or typed by an agent) read unmirrored
 * from the sketch camera, which looks at the plane from its +normal side.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseSvg } from '@tweakcad/core/src/sketch/io/svgImport.ts';
import { DEFAULT_PLANES } from '@tweakcad/worker/src/featureBuilders/resolvePlane.ts';
import { planeConfigFromName, type SketchPlaneConfig } from './SketchSceneManager.ts';

const PLANES = ['XY', 'XZ', 'YZ'] as const;

/**
 * A camera on the plane's +normal side, aimed at its origin with world +Y up:
 * the spherical view the editor snaps to on sketch entry (polar angle kept off
 * the pole so the ground plane still has a defined screen-up).
 */
function sketchCamera(plane: SketchPlaneConfig): THREE.PerspectiveCamera {
  const n = plane.normal;
  const theta = Math.atan2(n.x, n.z);
  const phi = Math.min(Math.max(Math.acos(n.y), 0.01), Math.PI - 0.01);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.setFromSpherical(new THREE.Spherical(50, phi, theta)).add(plane.origin);
  camera.lookAt(plane.origin);
  camera.updateMatrixWorld();
  return camera;
}

/** Sketch (x, y) → normalized device coordinates (x right, y up). */
function toScreen(plane: SketchPlaneConfig, camera: THREE.Camera, [x, y]: [number, number]): [number, number] {
  const p = plane.origin.clone()
    .addScaledVector(plane.uAxis, x)
    .addScaledVector(plane.vAxis, y)
    .project(camera);
  return [p.x, p.y];
}

describe('default sketch plane bases', () => {
  it.each(PLANES)('%s is right-handed: u × v = normal', (name) => {
    const plane = planeConfigFromName(name);
    const cross = new THREE.Vector3().crossVectors(plane.uAxis, plane.vAxis);
    expect(cross.distanceTo(plane.normal)).toBeLessThan(1e-12);
  });

  it.each(PLANES)('%s matches the worker basis', (name) => {
    const editor = planeConfigFromName(name);
    const worker = DEFAULT_PLANES[name];
    expect(editor.origin.toArray()).toEqual(worker.origin);
    expect(editor.uAxis.toArray()).toEqual(worker.uAxis);
    expect(editor.vAxis.toArray()).toEqual(worker.vAxis);
    expect(editor.normal.toArray()).toEqual(worker.normal);
  });

  it.each(PLANES)('%s: sketch +x reads right and +y reads up from the sketch camera', (name) => {
    const plane = planeConfigFromName(name);
    const camera = sketchCamera(plane);
    const [ox, oy] = toScreen(plane, camera, [0, 0]);
    const [rx, ry] = toScreen(plane, camera, [10, 0]);
    const [ux, uy] = toScreen(plane, camera, [0, 10]);
    expect(rx - ox).toBeGreaterThan(0);
    expect(Math.abs(ry - oy)).toBeLessThan(1e-3);
    expect(uy - oy).toBeGreaterThan(0);
    expect(Math.abs(ux - ox)).toBeLessThan(1e-3);
  });

  it.each(PLANES)('%s: an imported asymmetric SVG reads unmirrored from the sketch camera', (name) => {
    // An "F": stem on the left, arms pointing right, top bar at the SVG top.
    const outline: Array<[number, number]> = [
      [0, 0], [30, 0], [30, 10], [10, 10], [10, 20], [25, 20], [25, 30], [10, 30], [10, 50], [0, 50],
    ];
    const d = `M${outline.map(([x, y]) => `${x} ${y}`).join(' L')} Z`;
    const { primitives } = parseSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 50"><path d="${d}"/></svg>`,
    );
    const lines = primitives.flatMap(p => (p.kind === 'line' ? [p] : []));
    expect(lines).toHaveLength(outline.length);

    const plane = planeConfigFromName(name);
    const camera = sketchCamera(plane);
    const area = (edges: Array<[[number, number], [number, number]]>) =>
      edges.reduce((a, [[x1, y1], [x2, y2]]) => a + x1 * y2 - x2 * y1, 0) / 2;

    // An image viewer draws the SVG y-down; the sketch camera's NDC is y-up.
    // Seen unmirrored, the outline's winding therefore flips sign between them.
    const svgArea = area(outline.map((p, i) => [p, outline[(i + 1) % outline.length]!]));
    const screenArea = area(lines.map(l => [toScreen(plane, camera, l.start), toScreen(plane, camera, l.end)]));
    expect(Math.sign(screenArea)).toBe(-Math.sign(svgArea));
  });
});
