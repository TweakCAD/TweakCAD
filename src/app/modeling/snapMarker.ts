/**
 * The marker a placement shows where a position would snap: a ring with a
 * cross, lying in the face's plane, drawn over the model at a constant size
 * on screen as of when it was placed.
 */
import * as THREE from 'three';
import type { Vec3 } from '@tweakcad/worker/src/v2/service/types';

/** The marker's radius in screen pixels. */
const MARKER_PIXELS = 9;
const COLOR = 0xf97316;

export class SnapMarker {
  private readonly group = new THREE.Group();
  private readonly material = new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true });

  constructor(private readonly scene: THREE.Scene) {
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      ring.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
    }
    const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ring), this.material);
    const cross = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-1.5, 0, 0),
        new THREE.Vector3(1.5, 0, 0),
        new THREE.Vector3(0, -1.5, 0),
        new THREE.Vector3(0, 1.5, 0),
      ]),
      this.material,
    );
    for (const line of [loop, cross]) {
      line.renderOrder = 1000;
      this.group.add(line);
    }
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Shows the marker at `at` in the plane through it with `normal`, `pixel` scene units to a screen pixel there. */
  show(at: Vec3, normal: Vec3, pixel: number): void {
    this.group.position.set(...at);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...normal).normalize());
    this.group.scale.setScalar(pixel * MARKER_PIXELS);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  get shown(): boolean {
    return this.group.visible;
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const child of this.group.children) (child as THREE.Line).geometry.dispose();
    this.material.dispose();
  }
}
