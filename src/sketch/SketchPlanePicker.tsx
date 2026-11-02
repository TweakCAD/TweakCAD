/**
 * SketchPlanePicker - plane selection overlay.
 *
 * When the user clicks Sketch in the toolbar, this component is mounted on top
 * of the viewport. It:
 *  - Adds three translucent square meshes (XY, XZ, YZ) at the world origin
 *  - Highlights the plane under the cursor
 *  - Picks the plane on click and calls onPick(name)
 *  - Cancels (Esc / click on background) -> onCancel()
 *
 * It does NOT modify the viewport scene tree beyond adding/removing its own
 * group; nothing is persisted in the document until the user actually picks.
 *
 * Future: also list flat faces of existing bodies as pickable planes
 * (sketch on any planar face). For v0.1 we ship with default planes.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ViewportController } from '@tweakcad/viewport/src/ViewportController.ts';
import type { ConstructionPlaneDisplay } from '@tweakcad/core/src/document/schema.ts';
import type { FeatureId } from '@tweakcad/core/src/ids.ts';

// ---- Types ----

export type SketchPlaneName = 'XY' | 'XZ' | 'YZ';

/**
 * A pick result discriminated by kind:
 *   - `default`     — one of the three built-in planes (XY/XZ/YZ).
 *   - `construction`— a user-created construction plane.
 * The caller (Shell) converts each into the appropriate `PlaneRef`
 * variant before dispatching `CreateSketch`.
 */
export type SketchPlanePick =
  | { kind: 'default'; name: SketchPlaneName }
  | { kind: 'construction'; featureId: FeatureId; name: string };

interface SketchPlanePickerProps {
  viewportCtrl: ViewportController | null;
  /**
   * Existing construction planes from the rebuild result. Rendered as
   * extra pickable squares at their world poses, in addition to the
   * three default planes at the origin. Empty by default.
   */
  constructionPlanes?: ConstructionPlaneDisplay[] | undefined;
  onPick: (pick: SketchPlanePick) => void;
  onCancel: () => void;
}

// ---- Plane configuration ----

interface PlaneDef {
  name: SketchPlaneName;
  /** World normal */
  normal: THREE.Vector3;
  /** Color when hovered (each plane has a distinct chroma) */
  color: number;
  /** Label color */
  labelColor: string;
  /** Quaternion rotating the unit XY square so it lies on this plane */
  quaternion: THREE.Quaternion;
}

function makePlaneDefs(): PlaneDef[] {
  return [
    {
      name: 'XY',
      normal: new THREE.Vector3(0, 0, 1),
      color: 0x3b82f6,
      labelColor: '#3b82f6',
      quaternion: new THREE.Quaternion(), // default XY square already
    },
    {
      name: 'XZ',
      normal: new THREE.Vector3(0, 1, 0),
      color: 0x22c55e,
      labelColor: '#22c55e',
      quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
    },
    {
      name: 'YZ',
      normal: new THREE.Vector3(1, 0, 0),
      color: 0xef4444,
      labelColor: '#ef4444',
      quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
    },
  ];
}

const PLANE_SIZE = 60; // mm
/** Color used for construction-plane meshes — matches CP brand in cadIcons. */
const CP_COLOR = 0x3b82f6;

/**
 * A pickable entry rendered in the picker. Each carries the pick result
 * that should be emitted if its mesh is clicked, so the raycast logic
 * doesn't need to branch on kind.
 */
type Pickable = {
  mesh: THREE.Mesh;
  /** Stable hover key — `XY|XZ|YZ` for defaults, `cp:<featureId>` for CPs. */
  hoverKey: string;
  pick: SketchPlanePick;
};

// ---- Component ----

export function SketchPlanePicker({ viewportCtrl, constructionPlanes, onPick, onCancel }: SketchPlanePickerProps) {
  const rootRef = useRef<THREE.Group | null>(null);
  const pickablesRef = useRef<Pickable[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  // While the user is orbiting/panning with the middle or right mouse
  // button, we forward every subsequent move + up to the canvas. Without
  // this ref the canvas only saw the initial mousedown and never received
  // the drag — so orbit "didn't work" while picking a plane.
  const forwardedButtonRef = useRef<number | null>(null);

  // Mount: add the picker geometry to the scene. Re-mounts whenever the
  // construction-plane list changes so newly-created CPs become pickable
  // mid-session without having to close and reopen the picker.
  useEffect(() => {
    if (!viewportCtrl) return;

    const scene = viewportCtrl.getScene();
    const root = new THREE.Group();
    root.name = 'SketchPlanePicker';
    rootRef.current = root;

    const planeGeom = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
    const edgeGeom = new THREE.EdgesGeometry(planeGeom);

    const pickables: Pickable[] = [];

    // Default planes (XY/XZ/YZ).
    for (const def of makePlaneDefs()) {
      const material = new THREE.MeshBasicMaterial({
        color: def.color,
        transparent: true,
        opacity: 0.15,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(planeGeom, material);
      mesh.quaternion.copy(def.quaternion);
      mesh.userData['planeName'] = def.name;
      mesh.renderOrder = 1500;

      const outline = new THREE.LineSegments(
        edgeGeom,
        new THREE.LineBasicMaterial({ color: def.color, transparent: true, opacity: 0.9 }),
      );
      outline.quaternion.copy(def.quaternion);
      outline.renderOrder = 1501;

      root.add(mesh);
      root.add(outline);
      pickables.push({ mesh, hoverKey: def.name, pick: { kind: 'default', name: def.name } });
    }

    // Construction planes from the rebuild — rendered using the same
    // basis-matrix approach as ConstructionPlaneLayer so the picker
    // square and the persistent layer square coincide visually.
    for (const cp of constructionPlanes ?? []) {
      const u = new THREE.Vector3(cp.uAxis[0], cp.uAxis[1], cp.uAxis[2]);
      const v = new THREE.Vector3(cp.vAxis[0], cp.vAxis[1], cp.vAxis[2]);
      const n = new THREE.Vector3(cp.normal[0], cp.normal[1], cp.normal[2]);
      const matrix = new THREE.Matrix4()
        .makeBasis(u, v, n)
        .setPosition(cp.origin[0], cp.origin[1], cp.origin[2]);

      const material = new THREE.MeshBasicMaterial({
        color: CP_COLOR,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(planeGeom, material);
      mesh.applyMatrix4(matrix);
      mesh.userData['featureId'] = cp.featureId;
      mesh.renderOrder = 1500;

      const outline = new THREE.LineSegments(
        edgeGeom,
        new THREE.LineBasicMaterial({ color: CP_COLOR, transparent: true, opacity: 0.9 }),
      );
      outline.applyMatrix4(matrix);
      outline.renderOrder = 1501;

      root.add(mesh);
      root.add(outline);
      pickables.push({
        mesh,
        hoverKey: `cp:${cp.featureId}`,
        pick: { kind: 'construction', featureId: cp.featureId, name: cp.name },
      });
    }

    pickablesRef.current = pickables;
    scene.add(root);
    // Plane hover highlights change straight in the scene.
    const releaseContinuousRender = viewportCtrl.holdContinuousRender();

    return () => {
      scene.remove(root);
      releaseContinuousRender();
      planeGeom.dispose();
      edgeGeom.dispose();
      for (const { mesh } of pickables) {
        if (mesh.material instanceof THREE.Material) mesh.material.dispose();
      }
      root.traverse((child) => {
        if (child instanceof THREE.LineSegments && child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      });
      pickablesRef.current = [];
      rootRef.current = null;
    };
  }, [viewportCtrl, constructionPlanes]);

  // Apply hover styling — bump opacity on the focused mesh.
  useEffect(() => {
    applyHoverOpacity(pickablesRef.current, hovered);
  }, [hovered]);

  // Picker overlay click handling: raycast to find which plane was hit.
  // If a middle/right drag is in progress, forward the move to the canvas
  // instead so the orbit controls receive the full mousemove stream.
  const handlePointerMove = (e: React.PointerEvent) => {
    if (forwardedButtonRef.current !== null) {
      forwardToCanvas(e, viewportCtrl, 'mousemove');
      return;
    }
    if (!viewportCtrl) return;
    const target = pickPlane(e.clientX, e.clientY, viewportCtrl, pickablesRef.current);
    setHovered(target?.hoverKey ?? null);
  };

  const handleClick = (e: React.MouseEvent) => {
    // Only respond to primary button — non-primary clicks are already
    // forwarded through the pointerdown/up path below.
    if (e.button !== 0) return;
    if (!viewportCtrl) return;
    const target = pickPlane(e.clientX, e.clientY, viewportCtrl, pickablesRef.current);
    if (target) {
      onPick(target.pick);
    } else {
      onCancel();
    }
  };

  // Forward middle/right click drags and wheel to viewport canvas so orbit/pan
  // still works while picking a plane.
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) {
      forwardedButtonRef.current = e.button;
      forwardToCanvas(e, viewportCtrl, 'mousedown');
    }
  };
  const handlePointerUp = (e: React.PointerEvent) => {
    if (forwardedButtonRef.current !== null) {
      forwardToCanvas(e, viewportCtrl, 'mouseup');
      forwardedButtonRef.current = null;
    }
  };
  const handleWheel = (e: React.WheelEvent) => {
    if (!viewportCtrl) return;
    const canvas = viewportCtrl.getCanvas();
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
      clientX: e.clientX, clientY: e.clientY,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
      bubbles: true,
    }));
  };

  // Escape cancels
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    <>
      {/* Transparent capture surface */}
      <div
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          pointerEvents: 'auto',
          cursor: hovered ? 'pointer' : 'default',
          zIndex: 20,
        }}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onClick={handleClick}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Floating instruction banner */}
      <div style={styles.banner}>
        <div style={styles.bannerTitle}>Select a sketch plane</div>
        <div style={styles.bannerHint}>
          Click <b style={{ color: '#3b82f6' }}>XY</b>, <b style={{ color: '#22c55e' }}>XZ</b>, or <b style={{ color: '#ef4444' }}>YZ</b>
          {(constructionPlanes?.length ?? 0) > 0
            ? <>, or one of the <b style={{ color: '#3b82f6' }}>{constructionPlanes!.length} construction plane{constructionPlanes!.length === 1 ? '' : 's'}</b></>
            : null}
          {hovered ? `; ${hovered.startsWith('cp:') ? 'construction plane' : hovered} highlighted` : ''}.
          <br />
          <span style={{ color: '#999' }}>Esc to cancel.</span>
        </div>
        <button style={styles.cancelBtn} onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

// ---- Hover styling ----

function applyHoverOpacity(pickables: readonly Pickable[], hovered: string | null): void {
  for (const p of pickables) {
    if (!(p.mesh.material instanceof THREE.MeshBasicMaterial)) continue;
    // Default planes use 0.15 idle / 0.45 hover; CPs use 0.18 / 0.5
    // (slightly more present since CPs are user-created reference).
    const isCp = p.pick.kind === 'construction';
    p.mesh.material.opacity = p.hoverKey === hovered
      ? (isCp ? 0.5 : 0.45)
      : (isCp ? 0.18 : 0.15);
  }
}

// ---- Hit testing ----

function pickPlane(
  clientX: number,
  clientY: number,
  viewportCtrl: ViewportController,
  pickables: Pickable[],
): Pickable | null {
  const canvas = viewportCtrl.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, viewportCtrl.getCamera());

  // Test each pickable mesh, take the nearest hit.
  let best: { p: Pickable; dist: number } | null = null;
  for (const p of pickables) {
    const hits = raycaster.intersectObject(p.mesh, false);
    if (hits.length > 0 && hits[0]) {
      const dist = hits[0].distance;
      if (!best || dist < best.dist) {
        best = { p, dist };
      }
    }
  }
  return best?.p ?? null;
}

// Forward a pointer event to the viewport canvas so orbit/pan still works.
// The caller passes the target mouse event type explicitly — the React
// pointer event types map ambiguously (e.g. PointerEvent reused for move/up).
function forwardToCanvas(
  e: React.PointerEvent | React.MouseEvent,
  viewportCtrl: ViewportController | null,
  type: 'mousedown' | 'mousemove' | 'mouseup',
): void {
  if (!viewportCtrl) return;
  const canvas = viewportCtrl.getCanvas();
  canvas.dispatchEvent(new MouseEvent(type, {
    button: e.button,
    buttons: e.buttons,
    clientX: e.clientX,
    clientY: e.clientY,
    ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
    bubbles: true,
  }));
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  banner: {
    position: 'absolute',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#fff',
    border: '1px solid #d8d8d8',
    borderRadius: 6,
    boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
    padding: '10px 16px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4,
    zIndex: 30,
    minWidth: 260,
    pointerEvents: 'auto',
  },
  bannerTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#222',
  },
  bannerHint: {
    fontSize: 11,
    color: '#666',
    lineHeight: 1.4,
  },
  cancelBtn: {
    marginTop: 4,
    padding: '4px 10px',
    fontSize: 11,
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    background: '#f7f7f7',
    color: '#333',
    cursor: 'pointer',
  },
};
