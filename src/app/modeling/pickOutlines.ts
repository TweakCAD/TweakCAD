/**
 * A panel's picks that its preview replaced (an edge a fillet rounds, a
 * face a shell opens, a body a combine consumes) are drawn where they lie in
 * the state the feature starts from, over the preview, and a click on one
 * finds it, so clicking a picked one again drops it as it does without a
 * preview.
 */
import * as THREE from 'three';
import type { PickOutline } from '@tweakcad/worker/src/v2/service/types';
import { ORDER, PICK_PIXELS, SELECTION } from '../viewport/style';

/** How far behind the nearest shown face an outline may lie and still take a click, in screen pixels at that depth. */
export const OUTLINE_DEPTH_PIXELS = 30;

/** The drawn outlines of picks; each object's `userData.outline` is the index of the pick it draws. */
export function outlineObjects(outlines: readonly (PickOutline | null)[]): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  outlines.forEach((o, index) => {
    if (!o) return;
    const geometry = new THREE.BufferGeometry();
    let object: THREE.Object3D;
    if (o.kind === 'edge') {
      geometry.setAttribute('position', new THREE.BufferAttribute(o.segments, 3));
      object = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({
          color: SELECTION.lineColor,
          depthTest: false,
          depthWrite: false,
          transparent: true,
        }),
      );
    } else {
      geometry.setAttribute('position', new THREE.BufferAttribute(o.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(o.indices, 1));
      object = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: SELECTION.faceColor,
          transparent: true,
          opacity: SELECTION.faceOpacity * 0.6,
          side: THREE.DoubleSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
      );
    }
    object.renderOrder = ORDER.highlight;
    object.userData.outline = index;
    out.push(object);
  });
  return out;
}

/** Frees outline objects and takes them out of the scene. */
export function disposeOutlines(objects: readonly THREE.Object3D[]): void {
  for (const o of objects) {
    o.parent?.remove(o);
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    (m.material as THREE.Material | undefined)?.dispose();
  }
}

/** Whether an object and every parent of it is visible. */
function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/**
 * The index of the pick whose outline `raycaster`'s ray meets, or null.
 * An outline counts when nothing shown lies far in front of it: it may sit
 * up to `OUTLINE_DEPTH_PIXELS` behind the nearest face of `model` (a
 * concave edge a fillet fills in lies just behind the fillet), but not
 * behind a body. `pixel` is scene units per screen pixel; edges are met
 * within `PICK_PIXELS` of the ray.
 */
export function outlineHit(
  raycaster: THREE.Raycaster,
  outlines: readonly THREE.Object3D[],
  model: THREE.Object3D,
  pixel: number,
): number | null {
  if (outlines.length === 0) return null;
  raycaster.params.Line = { threshold: pixel * PICK_PIXELS };
  const hits = raycaster.intersectObjects([...outlines], false);
  if (hits.length === 0) return null;
  const nearest = raycaster
    .intersectObject(model, true)
    .find((h) => (h.object.userData.pick as { kind?: string } | undefined)?.kind === 'face' && shown(h.object));
  const limit = nearest ? nearest.distance + pixel * OUTLINE_DEPTH_PIXELS : Infinity;
  const hit = hits.find((h) => h.distance <= limit);
  return hit ? (hit.object.userData.outline as number) : null;
}

/** A ray from `camera` through a point of `canvas`, in client coordinates; null for a canvas with no size. */
export function rayThrough(
  canvas: HTMLCanvasElement,
  camera: THREE.Camera,
  clientX: number,
  clientY: number,
): THREE.Raycaster | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(
    new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1),
    camera,
  );
  return raycaster;
}
