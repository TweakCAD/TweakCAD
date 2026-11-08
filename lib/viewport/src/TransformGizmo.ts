/**
 * TransformGizmo — a thin, reusable wrapper over three's `TransformControls`.
 *
 * One instance is reused for every gizmo case in the app by re-`attach`-ing
 * with a different config:
 *   - construction-plane offset → translate, local space, Z (normal) only
 *   - move body (later)         → translate + rotate, all axes
 *
 * Two integration points distinguish it from three's stock examples:
 *
 *   1. **Camera coupling.** three's examples disable `OrbitControls` while a
 *      handle is dragged. We use a custom spherical-orbit camera instead, so
 *      the owner passes a `setCameraNavEnabled` callback that the gizmo flips
 *      off on drag-start and on again on drag-end. Without this the camera
 *      would orbit while you drag a handle.
 *
 *   2. **One Path commit.** During a drag the gizmo mutates the attached
 *      Object3D live (ephemeral, visual only — no command, no rebuild). On
 *      drag-end it fires `onCommit(target)` exactly once; the owner reads the
 *      final transform there and dispatches a single command. The next
 *      rebuild reconciles from the committed value, so an un-committed drag
 *      is harmless.
 */

import type * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

export interface TransformGizmoConfig {
  mode?: 'translate' | 'rotate' | 'scale';
  /** 'local' aligns the handles with the target's own rotation. */
  space?: 'world' | 'local';
  showX?: boolean;
  showY?: boolean;
  showZ?: boolean;
  /** Relative handle size (three default = 1). */
  size?: number;
}

export interface TransformGizmoHandlers {
  /** Fired once when a drag gesture starts. */
  onDragStart?: (target: THREE.Object3D) => void;
  /** Fired continuously while dragging (live, ephemeral). */
  onChange?: (target: THREE.Object3D) => void;
  /** Fired once when a drag gesture ends — commit the transform here. */
  onCommit?: (target: THREE.Object3D) => void;
}

export class TransformGizmo {
  private control: TransformControls;
  private helper: THREE.Object3D;
  private handlers: TransformGizmoHandlers = {};
  private attached = false;

  constructor(
    private scene: THREE.Scene,
    camera: THREE.Camera,
    domElement: HTMLElement,
    setCameraNavEnabled: (enabled: boolean) => void,
  ) {
    this.control = new TransformControls(camera, domElement);

    this.control.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      // Stop the camera fighting the drag (and re-enable when released).
      setCameraNavEnabled(!dragging);
      const target = this.control.object;
      if (!target) return;
      if (dragging) this.handlers.onDragStart?.(target);
      else this.handlers.onCommit?.(target);
    });

    this.control.addEventListener('objectChange', () => {
      const target = this.control.object;
      if (target) this.handlers.onChange?.(target);
    });

    // In three r169+ the controls aren't an Object3D — its visual is a
    // separate helper root that must live in the scene graph.
    this.helper = this.control.getHelper();
    this.scene.add(this.helper);
    this.setVisible(false);
  }

  /** Attach to an object and show the handles. Replaces any prior target. */
  attach(target: THREE.Object3D, config: TransformGizmoConfig = {}, handlers: TransformGizmoHandlers = {}): void {
    this.handlers = handlers;
    this.control.attach(target);
    this.control.setMode(config.mode ?? 'translate');
    this.control.setSpace(config.space ?? 'world');
    this.control.showX = config.showX ?? true;
    this.control.showY = config.showY ?? true;
    this.control.showZ = config.showZ ?? true;
    this.control.setSize(config.size ?? 1);
    this.attached = true;
    this.setVisible(true);
  }

  /** Hide the handles and forget the target. Safe to call when not attached. */
  detach(): void {
    if (this.attached) this.control.detach();
    this.handlers = {};
    this.attached = false;
    this.setVisible(false);
  }

  /** True while a handle is actively being dragged. */
  isDragging(): boolean {
    return this.control.dragging;
  }

  dispose(): void {
    this.detach();
    this.scene.remove(this.helper);
    this.control.dispose();
  }

  private setVisible(v: boolean): void {
    this.control.enabled = v;
    this.helper.visible = v;
  }
}
