/** A closed line drawn over the model, as a base being drawn on a plane is shown. */
import * as THREE from 'three';

const COLOR = 0xf97316;

export class OutlineLoop {
  private readonly material = new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true });
  private readonly line = new THREE.LineLoop(new THREE.BufferGeometry(), this.material);

  constructor(private readonly scene: THREE.Scene) {
    this.line.renderOrder = 1000;
    this.line.visible = false;
    this.line.frustumCulled = false;
    scene.add(this.line);
  }

  /** Shows the loop through `points`, in scene coordinates. */
  show(points: readonly (readonly [number, number, number])[]): void {
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry().setFromPoints(
      points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    );
    this.line.visible = points.length > 1;
  }

  hide(): void {
    this.line.visible = false;
  }

  get shown(): boolean {
    return this.line.visible;
  }

  dispose(): void {
    this.scene.remove(this.line);
    this.line.geometry.dispose();
    this.material.dispose();
  }
}
