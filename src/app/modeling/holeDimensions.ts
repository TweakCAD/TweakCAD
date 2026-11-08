/**
 * The dimensions of hole positions measured from edges, drawn on the face
 * over the model: a line from each position to the foot of its distance on
 * the edge's line.
 */
import * as THREE from 'three';
import type { Vec3 } from '@tweakcad/worker/src/v2/service/types';

const COLOR = 0xf97316;

export class HoleDimensions {
  private readonly lines: THREE.LineSegments;
  private readonly material = new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true });

  constructor(private readonly scene: THREE.Scene) {
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.material);
    this.lines.renderOrder = 1000;
    this.lines.visible = false;
    this.lines.raycast = () => undefined;
    scene.add(this.lines);
  }

  /** Shows `segments`, pairs of points in the part frame; none hides them. */
  show(segments: readonly (readonly [Vec3, Vec3])[]): void {
    this.lines.geometry.dispose();
    this.lines.geometry = new THREE.BufferGeometry().setFromPoints(
      segments.flatMap(([a, b]) => [new THREE.Vector3(...a), new THREE.Vector3(...b)]),
    );
    this.lines.visible = segments.length > 0;
  }

  /** How many segments show. */
  get shown(): number {
    return this.lines.visible ? (this.lines.geometry.getAttribute('position')?.count ?? 0) / 2 : 0;
  }

  dispose(): void {
    this.scene.remove(this.lines);
    this.lines.geometry.dispose();
    this.material.dispose();
  }
}
