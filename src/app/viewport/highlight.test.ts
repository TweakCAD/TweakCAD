import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { overlayFor } from './highlight';
import { HIGHLIGHT_EDGE_PIXELS, PRESELECTION } from './style';

const positions = (o: LineSegments2) => {
  const start = o.geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute;
  const end = o.geometry.getAttribute('instanceEnd') as THREE.InterleavedBufferAttribute;
  return Array.from({ length: start.count }, (_, i) => [start.getX(i), start.getY(i), end.getX(i), end.getY(i)]);
};

describe('line highlights', () => {
  it('draws a sketch polyline, a closed outline and segments as wide as an edge, where the line stands', () => {
    const strip = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(1, 1, 0),
      ]),
    );
    strip.position.set(5, 0, 0);
    const wide = overlayFor({ kind: 'line', line: strip }, PRESELECTION) as LineSegments2;
    expect(wide).toBeInstanceOf(LineSegments2);
    expect(wide.material.linewidth).toBe(HIGHLIGHT_EDGE_PIXELS);
    expect(positions(wide)).toEqual([
      [0, 0, 1, 0],
      [1, 0, 1, 1],
    ]);
    expect(wide.position.x).toBe(5);

    const loop = new THREE.LineLoop(strip.geometry);
    expect(positions(overlayFor({ kind: 'line', line: loop }, PRESELECTION) as LineSegments2)).toHaveLength(3);

    const pairs = new THREE.LineSegments(strip.geometry);
    expect(positions(overlayFor({ kind: 'line', line: pairs }, PRESELECTION) as LineSegments2)).toEqual([[0, 0, 1, 0]]);
  });
});
