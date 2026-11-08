/**
 * An arrow in the view that drags a length: it stands at `at` pointing along
 * `direction`, and a drag along it writes `distance` plus how far it moved
 * (at least 0.01 mm, to the hundredth) as it goes. Returns whether it is
 * being dragged, so its drags do not click.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import { TransformGizmo } from '@tweakcad/viewport/src/TransformGizmo';
import type { Viewport } from '../viewport/Viewport';

export interface Arrow {
  at: [number, number, number];
  direction: [number, number, number];
  distance: number;
}

/** The text a drag writes: the length it ends at, at least 0.01, to the hundredth. */
export const draggedLength = (distance: number, moved: number): string =>
  String(Math.max(0.01, Math.round((distance + moved) * 100) / 100) + 0);

export function useArrowHandle(
  viewport: Viewport | null,
  arrow: Arrow | null,
  onDistance: (text: string) => void,
): () => boolean {
  const gizmo = useRef<TransformGizmo | null>(null);
  const proxy = useRef(new THREE.Object3D());
  const drag = useRef<{ from: THREE.Vector3; distance: number; direction: THREE.Vector3 } | null>(null);
  const write = useRef(onDistance);
  useLayoutEffect(() => {
    write.current = onDistance;
  });

  useEffect(() => {
    if (!viewport) return;
    const g = new TransformGizmo(viewport.getScene(), viewport.getCamera(), viewport.getCanvas(), () => undefined);
    gizmo.current = g;
    const scene = viewport.getScene();
    const object = proxy.current;
    scene.add(object);
    return () => {
      g.dispose();
      scene.remove(object);
      gizmo.current = null;
      viewport.requestRender();
    };
  }, [viewport]);

  const key = arrow ? `${arrow.at.join()}|${arrow.direction.join()}|${arrow.distance}` : '';
  useEffect(() => {
    const g = gizmo.current;
    if (!g || !viewport || g.isDragging()) return;
    if (!arrow) {
      g.detach();
      viewport.requestRender();
      return;
    }
    const direction = new THREE.Vector3(...arrow.direction).normalize();
    proxy.current.position.set(...arrow.at);
    proxy.current.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
    proxy.current.updateMatrixWorld();
    g.attach(
      proxy.current,
      { mode: 'translate', space: 'local', showX: false, showY: false, showZ: true },
      {
        onDragStart: (o) => {
          drag.current = { from: o.position.clone(), distance: arrow.distance, direction };
        },
        onChange: (o) => {
          const d = drag.current;
          if (!d) return;
          write.current(draggedLength(d.distance, o.position.clone().sub(d.from).dot(d.direction)));
          viewport.requestRender();
        },
        onCommit: () => {
          drag.current = null;
        },
      },
    );
    viewport.requestRender();
    // Keyed by where the arrow stands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, viewport]);

  return useCallback(() => gizmo.current?.isDragging() ?? false, []);
}
