import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { sketchViewForPlane } from './sketchView';
import { planeConfigFromBasis } from './SketchSceneManager';

function planeWithNormal(normal: [number, number, number]) {
  return planeConfigFromBasis({
    origin: [5, -3, 12],
    uAxis: [1, 0, 0],
    vAxis: [0, 1, 0],
    normal,
  });
}

/** Unit direction from the target to the camera for a spherical view. */
function viewDirection(view: { theta: number; phi: number }): THREE.Vector3 {
  return new THREE.Vector3().setFromSpherical(new THREE.Spherical(1, view.phi, view.theta));
}

describe('sketchViewForPlane', () => {
  it('keeps the standard views for the default planes', () => {
    const xy = sketchViewForPlane('XY');
    expect(xy.theta).toBeCloseTo(0);
    expect(xy.phi).toBeCloseTo(Math.PI / 2);

    const xz = sketchViewForPlane('XZ');
    expect(xz.theta).toBeCloseTo(0);
    expect(xz.phi).toBeCloseTo(0.01);

    const yz = sketchViewForPlane('YZ');
    expect(yz.theta).toBeCloseTo(Math.PI / 2);
    expect(yz.phi).toBeCloseTo(Math.PI / 2);
  });

  it('looks square at a 45° plane instead of snapping to a standard view', () => {
    // End face of a pipe revolved 45° about Y: normal halfway between +X and +Z.
    const s = Math.SQRT1_2;
    const view = sketchViewForPlane(planeWithNormal([s, 0, s]));
    expect(view.theta).toBeCloseTo(Math.PI / 4);
    expect(view.phi).toBeCloseTo(Math.PI / 2);
  });

  it('places the camera on the side the normal points to for an oblique normal', () => {
    const n = new THREE.Vector3(-1, 2, -3).normalize();
    const view = sketchViewForPlane(planeWithNormal([n.x, n.y, n.z]));
    expect(view.phi).toBeCloseTo(Math.acos(n.y));
    expect(view.theta).toBeCloseTo(Math.atan2(n.x, n.z));
    const dir = viewDirection(view);
    expect(dir.x).toBeCloseTo(n.x);
    expect(dir.y).toBeCloseTo(n.y);
    expect(dir.z).toBeCloseTo(n.z);
  });

  it('accepts a non-unit normal', () => {
    const view = sketchViewForPlane(planeWithNormal([0, 3, 3]));
    expect(view.theta).toBeCloseTo(0);
    expect(view.phi).toBeCloseTo(Math.PI / 4);
  });

  it('stays off the orbit poles for planes facing straight up or down', () => {
    expect(sketchViewForPlane(planeWithNormal([0, 1, 0])).phi).toBeCloseTo(0.01);
    expect(sketchViewForPlane(planeWithNormal([0, -1, 0])).phi).toBeCloseTo(Math.PI - 0.01);
  });
});
