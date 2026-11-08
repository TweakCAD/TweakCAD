import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { disposeOutlines, outlineHit, outlineObjects } from './pickOutlines';

/** A square face of the model, 40 wide, at height `z`, as the model scene tags faces. */
function modelFace(z: number): THREE.Group {
  const geometry = new THREE.PlaneGeometry(40, 40);
  geometry.translate(0, 0, z);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.userData.pick = { kind: 'face' };
  const root = new THREE.Group();
  root.add(mesh);
  root.updateMatrixWorld();
  return root;
}

/** A ray straight down onto (x, y). */
function down(x: number, y: number): THREE.Raycaster {
  return new THREE.Raycaster(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1));
}

/** An edge along x at height 0 (pick 0), and a 4 × 4 face at height 1 around (10, 10) (pick 1). */
function outlines(): THREE.Object3D[] {
  const square = new THREE.PlaneGeometry(4, 4);
  square.translate(10, 10, 1);
  const objects = outlineObjects([
    { kind: 'edge', segments: new Float32Array([-10, 0, 0, 10, 0, 0]) },
    null,
    {
      kind: 'face',
      positions: new Float32Array(square.getAttribute('position').array),
      indices: new Uint32Array(square.getIndex()!.array),
    },
  ]);
  for (const o of objects) o.updateMatrixWorld();
  return objects;
}

describe('a click on the outline of a pick the preview replaced', () => {
  it('finds the picked edge within a few pixels of it, in front of the preview', () => {
    const o = outlines();
    expect(outlineHit(down(3, 0.2), o, modelFace(-5), 0.1)).toBe(0);
    expect(outlineHit(down(3, 2), o, modelFace(-5), 0.1)).toBeNull();
    disposeOutlines(o);
  });

  it('finds the picked face, by the index of the pick it draws', () => {
    expect(outlineHit(down(10, 10), outlines(), modelFace(-5), 0.1)).toBe(2);
  });

  it('finds a picked edge the preview covers closely, as a fillet in a corner does', () => {
    expect(outlineHit(down(3, 0), outlines(), modelFace(0.5), 0.1)).toBe(0);
  });

  it('leaves a picked edge that a body hides, so the click picks what is in front', () => {
    expect(outlineHit(down(3, 0), outlines(), modelFace(10), 0.1)).toBeNull();
  });

  it('finds nothing without outlines', () => {
    expect(outlineHit(down(0, 0), [], modelFace(-5), 0.1)).toBeNull();
  });
});
