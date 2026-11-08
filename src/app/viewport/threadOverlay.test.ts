import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { BodyMesh, ThreadDisplay } from '@tweakcad/worker/src/v2/service/types';
import { threadOverlay } from './threadOverlay';

/** One triangle, face key 7. */
const mesh: BodyMesh = {
  positions: new Float32Array([3, 0, 0, 0, 3, 0, -3, 0, 1]),
  normals: new Float32Array([1, 0, 0, 0, 1, 0, -1, 0, 0]),
  indices: new Uint32Array([0, 1, 2]),
  faces: new Uint32Array([0, 1, 7]),
  segments: new Float32Array(),
  edges: new Uint32Array(),
  points: new Float32Array(),
  vertices: new Uint32Array(),
} as BodyMesh;

const thread: ThreadDisplay = {
  feature: 'feat_1',
  faces: [7],
  designation: 'M6',
  class: '6g',
  internal: false,
  pitch: 1,
  radius: 3,
  start: [0, 0, 0],
  direction: [0, 0, 1],
  length: 10,
};

const around = (t: ThreadDisplay) =>
  ((threadOverlay(mesh, t)?.material as THREE.ShaderMaterial).uniforms.around?.value as THREE.Vector3).toArray();

describe('a cosmetic thread overlay', () => {
  it('turns its helix the other way round the axis for a left-handed thread', () => {
    const right = around(thread);
    const left = around({ ...thread, hand: 'left' });
    expect(left.map((c) => c + 0)).toEqual(right.map((c) => -c + 0));
    expect(Math.hypot(...right)).toBeCloseTo(1, 9);
  });
});
