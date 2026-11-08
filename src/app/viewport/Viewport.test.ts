import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { groundGrid, viewAlong } from './Viewport';

describe('viewAlong', () => {
  it('puts the camera on the side the normal points to', () => {
    for (const n of [
      [0, 0, 1],
      [1, 0, 0],
      [0, 0, -1],
      [0.6, 0, 0.8],
      [0, 0.6, 0.8],
    ] as [number, number, number][]) {
      const { theta, phi } = viewAlong(n);
      const camera = new THREE.Vector3().setFromSpherical(new THREE.Spherical(1, phi, theta));
      expect(camera.x).toBeCloseTo(n[0], 6);
      expect(camera.y).toBeCloseTo(n[1], 6);
      expect(camera.z).toBeCloseTo(n[2], 6);
    }
  });

  it('keeps off the poles for a plane facing up or down', () => {
    expect(viewAlong([0, 1, 0]).phi).toBeCloseTo(0.001, 6);
    expect(viewAlong([0, -1, 0]).phi).toBeCloseTo(Math.PI - 0.001, 6);
    expect(viewAlong([0, -1, 0]).theta).toBe(0);
  });
});

describe('the ground grid', () => {
  it('draws first and writes no depth, so bodies below the ground hide it', () => {
    const grid = groundGrid();
    expect(grid.renderOrder).toBeLessThan(0);
    for (const m of ([] as THREE.Material[]).concat(grid.material)) expect(m.depthWrite).toBe(false);
  });
});
