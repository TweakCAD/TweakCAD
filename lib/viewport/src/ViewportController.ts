/**
 * ViewportController - imperative Three.js controller for CAD rendering.
 * React handles panels around it; this class owns the 3D canvas entirely.
 * No React dependency - pure Three.js.
 */

import * as THREE from 'three';
import type { DisplayMesh, TopologyMap, Selection, ConstructionPlaneDisplay } from '@tweakcad/core/src/document/schema.ts';
import type { BodyId, FaceId, EdgeId, FeatureId } from '@tweakcad/core/src/ids.ts';
import { MeshRegistry, SECTION_STENCIL_RENDER_ORDER } from './MeshRegistry.ts';
import { ConstructionPlaneLayer } from './ConstructionPlaneLayer.ts';
import { TransformGizmo } from './TransformGizmo.ts';
import type { FeatureDisplayMode } from './displayMode.ts';
import { triangleToFaceId, segmentToEdgeId } from './topologyLookup.ts';
import { SelectionHighlight } from './selectionHighlight.ts';
import { fitFraming, homeFraming, lerpFraming, HOME_THETA, HOME_PHI } from './cameraFraming.ts';
import type { CameraFraming } from './cameraFraming.ts';
import { FrameGate } from './frameGate.ts';

/**
 * What kind of topology element clicks should resolve to.
 * 'edgeOrFace' resolves to the nearest visible edge under the cursor and
 * falls back to the face when no edge is in reach.
 */
export type PickMode = 'face' | 'edge' | 'edgeOrFace' | 'body' | 'none';

/**
 * Result of a successful pick. The viewport doesn't know about partId; the
 * React layer adds that when writing into the document's selection store.
 *
 * `constructionPlane` is reported when the user clicks a translucent
 * plane from the {@link ConstructionPlaneLayer}. It currently fires
 * alongside face/body picks (a click on a body face overrides — bodies
 * are opaque, planes translucent, so the body is what the user meant).
 */
export type PickedTopology =
  | { type: 'face'; bodyId: BodyId; faceId: FaceId }
  | { type: 'edge'; bodyId: BodyId; edgeId: EdgeId }
  | { type: 'body'; bodyId: BodyId }
  | { type: 'constructionPlane'; featureId: FeatureId }
  | null;

/** Declarative spec for a single-parameter on-canvas manipulator. */
export interface ManipulatorSpec {
  /** Object the handle moves (mutated live for feedback). */
  target: THREE.Object3D;
  /** 'distance' → linear handle along target local Z; 'angle' → rotation. */
  kind: 'distance' | 'angle';
  /** World axis used to sign the dragged value (≈ target local Z). */
  axis: THREE.Vector3;
  /**
   * The parameter's value corresponding to the target's pose at drag start.
   * A function is re-evaluated on each drag start — use it when the target
   * may have been moved between drags by another input (e.g. typing in a
   * field), so the dragged delta is measured from the current value.
   */
  baseValue: number | (() => number);
  /** Relative handle size (three default = 1). */
  size?: number;
}

export interface ManipulatorHandlers {
  /** Fired continuously while dragging with the live value (no dispatch). */
  onChange?: (value: number) => void;
  /** Fired once on release with the final value — commit here. */
  onCommit: (value: number) => void;
}

/** Pixels of pointer movement allowed between mousedown and mouseup to still count as a click. */
const CLICK_DRAG_TOLERANCE = 3;
/** Window events that request a frame (see `ViewportController.requestRender`). */
const RENDER_ON_INPUT = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'keydown', 'keyup'] as const;
/** Fill colour of the section-view cap (a lighter shade of the body colour). */
const SECTION_CAP_COLOR = 0xa9c0d8;
// ViewCube disabled until rendering pipeline is stabilized
// import { ViewCube } from './ViewCube.ts';

export class ViewportController {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private meshRegistry: MeshRegistry;
  private constructionPlaneLayer: ConstructionPlaneLayer;
  private selectionHighlight: SelectionHighlight;
  private transformGizmo: TransformGizmo;
  // Pose captured when a construction-plane offset manipulator is attached,
  // so a numeric field can drive the same live preview (see
  // setAttachedPlaneOffset). Null when no plane manipulator is active.
  private attachedPlaneOffset: {
    entry: { mesh: THREE.Object3D; outline: THREE.Object3D };
    committedOrigin: THREE.Vector3;
    normal: THREE.Vector3;
    committedOffset: number;
  } | null = null;
  // Active section-view cut, or null. The clipPlane is shared (by reference)
  // with the body materials, so mutating its constant gives a live cut.
  private sectionState: {
    visual: THREE.Mesh;
    outline: THREE.LineSegments;
    cap: THREE.Mesh;
    clipPlane: THREE.Plane;
    normal: THREE.Vector3;
  } | null = null;
  // Rotate-mode body Move drives a proxy at the body centroid; these track it
  // so the mesh's auto-matrix can be restored on detach.
  private bodyMoveProxy: THREE.Object3D | null = null;
  private bodyMoveDriven: { mesh: THREE.Object3D; edges?: THREE.Object3D }[] | null = null;
  // Active body-Move request, re-applied to the fresh meshes after each rebuild
  // so the gizmo survives the rebuild a drag triggers.
  private bodyMoveRequest: {
    bodyIds: BodyId[];
    mode: 'translate' | 'rotate';
    onCommit: (delta: { position: [number, number, number]; quaternion: [number, number, number, number] }) => void;
  } | null = null;
  // private viewCube: ViewCube;
  private disposed = false;

  // Frames are drawn on demand (see FrameGate). Every mutator below requests
  // one, as does the camera and any input in the window.
  private readonly frames = new FrameGate();
  private readonly onInput = (): void => this.frames.request();

  // Orbit controls state (simple implementation)
  private isDragging = false;
  // When false, the orbit/pan handlers no-op so an in-progress gizmo drag
  // (or any future modal interaction) owns the pointer. Flipped by the
  // gizmo via setCameraNavEnabled on drag start/end.
  private navEnabled = true;
  private lastMouse = { x: 0, y: 0 };
  private spherical = new THREE.Spherical(50, Math.PI / 3, Math.PI / 4);
  private target = new THREE.Vector3(0, 0, 0);

  // Smooth camera animation
  private animating = false;
  private animStart = { theta: 0, phi: 0 };
  private animEnd = { theta: 0, phi: 0 };
  // Target/radius to blend toward alongside the angles; null when only the
  // angles animate. Cleared by pan/zoom so user input isn't overridden.
  private animFraming: { from: CameraFraming; to: CameraFraming } | null = null;
  private animStartTime = 0;
  private readonly animDuration = 400; // ms

  // Picking state. The viewport raycasts against MeshRegistry's entries
  // when pickMode != 'none', then reports hits via the callbacks. The
  // React layer (Shell.tsx) wires these into the document selection store.
  private pickMode: PickMode = 'none';
  private pickRaycaster = new THREE.Raycaster();
  private occlusionRaycaster = new THREE.Raycaster();
  private pickCallback: ((picked: PickedTopology) => void) | null = null;
  private preselectCallback: ((picked: PickedTopology) => void) | null = null;
  // Pointer-down position for click-vs-drag distinction.
  private mouseDownAt: { x: number; y: number } | null = null;

  /**
   * @param canvas - The HTML canvas element to render into
   */
  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // Required so canvas.toDataURL() returns a usable image during
      // `captureScreenshot()`. Without this, WebGL clears the back
      // buffer after each render and toDataURL returns a blank PNG.
      // The cost is marginal — one extra GPU memory copy per frame.
      preserveDrawingBuffer: true,
      // Section-view caps are drawn with the stencil buffer.
      stencil: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0xf0f0f0, 1);
    // Required for per-material clipping planes (section view).
    this.renderer.localClippingEnabled = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    this.meshRegistry = new MeshRegistry(this.scene);
    this.constructionPlaneLayer = new ConstructionPlaneLayer(this.scene);
    this.selectionHighlight = new SelectionHighlight(this.scene);

    // ViewCube disabled
    // this.viewCube = new ViewCube(120);
    // this.viewCube.setOnClick((view) => {
    //   this.animateToView(view.theta, view.phi);
    // });

    this.transformGizmo = new TransformGizmo(
      this.scene,
      this.camera,
      canvas,
      (enabled) => this.setCameraNavEnabled(enabled),
    );

    this.setupLighting();
    this.setupGrid();
    this.updateCameraFromSpherical();
    this.setupControls(canvas);
    // Hover highlights, gizmo handles and every drag change the scene from
    // an input handler, so any input anywhere in the window requests a frame.
    for (const type of RENDER_ON_INPUT) {
      window.addEventListener(type, this.onInput, { capture: true, passive: true });
    }
    this.animate();
  }

  /** Draw a frame on the next animation tick. Call after changing the scene from outside this class. */
  requestRender(): void {
    this.frames.request();
  }

  /**
   * Render every frame until the returned function is called. For modes that
   * change the scene on their own schedule (the sketch editor and the plane
   * picker add and update objects directly). Releasing draws one more frame.
   */
  holdContinuousRender(): () => void {
    return this.frames.hold();
  }

  /**
   * Enable/disable camera navigation (orbit + pan). The transform gizmo
   * calls this so the camera doesn't fight a handle drag. Disabling also
   * cancels any in-progress orbit so a gizmo grab that began mid-press
   * doesn't leave the camera "stuck" dragging.
   */
  setCameraNavEnabled(enabled: boolean): void {
    this.navEnabled = enabled;
    if (!enabled) this.isDragging = false;
  }

  /**
   * Generic manipulator: drag an on-canvas handle to edit ONE scalar
   * parameter of something, reporting the new value live and on release.
   * This is the shared primitive behind construction-plane offset, the
   * section-view cut depth, and (later) body move — "same gizmo, different
   * sink": the caller decides what `onChange` / `onCommit(value)` do.
   *
   * Conventions:
   *   - `kind: 'distance'` → a single linear (translate) handle. The handle
   *     drags the target along its **local Z**, so the caller must orient
   *     `target` so local Z = the desired world `axis` (construction-plane
   *     meshes already are — local Z is the plane normal). `value` reported
   *     is `baseValue + signedDistanceMovedAlong(axis)`.
   *   - `kind: 'angle'` → a single rotation handle about local Z (used by
   *     plane-at-angle later; value plumbing lands with that feature).
   *
   * Nothing is dispatched mid-drag — `onCommit` fires once on release.
   */
  attachManipulator(spec: ManipulatorSpec, handlers: ManipulatorHandlers): void {
    this.requestRender();
    const { target, kind } = spec;
    const axis = spec.axis.clone().normalize();
    const readBase = (): number =>
      typeof spec.baseValue === 'function' ? spec.baseValue() : spec.baseValue;
    let startPos = target.position.clone();
    let base = readBase();

    const valueAt = (t: THREE.Object3D): number => {
      if (kind === 'distance') {
        return base + t.position.clone().sub(startPos).dot(axis);
      }
      // 'angle' value extraction lands with the plane-at-angle feature.
      return base;
    };

    this.transformGizmo.attach(
      target,
      {
        mode: kind === 'distance' ? 'translate' : 'rotate',
        space: 'local',
        showX: false,
        showY: false,
        showZ: true,
        ...(spec.size !== undefined ? { size: spec.size } : {}),
      },
      {
        onDragStart: (t) => { startPos = t.position.clone(); base = readBase(); },
        onChange: (t) => handlers.onChange?.(valueAt(t)),
        onCommit: (t) => handlers.onCommit(valueAt(t)),
      },
    );
  }

  /** Hide any active manipulator. */
  detachManipulator(): void {
    this.requestRender();
    this.transformGizmo.detach();
    this.attachedPlaneOffset = null;
    this.bodyMoveRequest = null;
    this.clearBodyMoveProxy();
  }

  /**
   * Convenience over {@link attachManipulator} for the construction-plane
   * offset case: resolves the plane's rendered mesh + normal, drags it
   * along the normal for live feedback (keeping the outline glued), and
   * reports the new absolute offset. `committedOffset` is the plane's stored
   * offset at attach time (so the mesh's display origin maps to it). Pair
   * with {@link setAttachedPlaneOffset} to drive the same preview from a
   * numeric field. Pass `plane: null` to hide.
   */
  attachConstructionPlaneOffsetManipulator(
    plane: ConstructionPlaneDisplay | null,
    committedOffset: number,
    handlers: ManipulatorHandlers,
  ): void {
    if (!plane) { this.detachManipulator(); return; }
    const entry = this.constructionPlaneLayer.getEntry(plane.featureId);
    if (!entry) { this.detachManipulator(); return; }
    const normal = new THREE.Vector3(
      plane.normal[0], plane.normal[1], plane.normal[2],
    ).normalize();
    const committedOrigin = new THREE.Vector3(plane.origin[0], plane.origin[1], plane.origin[2]);
    this.attachedPlaneOffset = { entry, committedOrigin, normal, committedOffset };

    this.attachManipulator(
      {
        target: entry.mesh,
        kind: 'distance',
        axis: normal,
        // Re-derive the offset the mesh currently sits at, so a drag that
        // follows a field edit measures its delta from the right place.
        baseValue: () =>
          committedOffset + entry.mesh.position.clone().sub(committedOrigin).dot(normal),
      },
      {
        onChange: (value) => {
          // Keep the outline glued to the mesh as it drags.
          entry.outline.position.copy(entry.mesh.position);
          handlers.onChange?.(value);
        },
        onCommit: handlers.onCommit,
      },
    );
  }

  /**
   * Move the currently-attached construction plane's preview to `offset`
   * (mm along its normal) without a rebuild — used when the numeric field
   * drives the value so the plane tracks typing the way it tracks dragging.
   * No-op if no plane manipulator is attached.
   */
  setAttachedPlaneOffset(offset: number): void {
    const a = this.attachedPlaneOffset;
    if (!a) return;
    const pos = a.committedOrigin.clone().addScaledVector(a.normal, offset - a.committedOffset);
    a.entry.mesh.position.copy(pos);
    a.entry.outline.position.copy(pos);
    this.requestRender();
  }

  // ---- Section view ----

  /**
   * Start (or move) a section cut. `spec.normal` is the cut's world normal —
   * the half of every body the normal points *away* from is clipped, so you
   * see the interior. `spec.point` defaults to the model's bounding-box
   * centre so the cut starts mid-body. A translucent section rectangle is
   * drawn with a drag handle that slides the cut along its normal live (this
   * is a view aid — no document change, no rebuild). Pass `null` to clear.
   *
   * The cut is capped: a plane-sized cap mesh is drawn only where the body
   * stencil passes (MeshRegistry.setClippingPlanes) leave a non-zero count,
   * i.e. where the plane passes through solid material.
   */
  setSectionPlane(
    spec: { normal: [number, number, number]; point?: [number, number, number] } | null,
  ): void {
    this.requestRender();
    // Tear down any existing section first.
    if (this.sectionState) {
      this.detachManipulator();
      const s = this.sectionState;
      this.scene.remove(s.visual);
      this.scene.remove(s.outline);
      this.scene.remove(s.cap);
      s.visual.geometry.dispose();
      (s.visual.material as THREE.Material).dispose();
      s.outline.geometry.dispose();
      (s.outline.material as THREE.Material).dispose();
      (s.cap.material as THREE.Material).dispose();
      this.sectionState = null;
      this.meshRegistry.setClippingPlanes([]);
    }
    if (!spec) return;

    const normal = new THREE.Vector3(spec.normal[0], spec.normal[1], spec.normal[2]).normalize();
    const box = this.meshRegistry.getBodiesBoundingBox();
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const point = spec.point
      ? new THREE.Vector3(spec.point[0], spec.point[1], spec.point[2])
      : center;
    const size = box.isEmpty() ? 200 : box.getSize(new THREE.Vector3()).length() * 1.2 + 20;

    // Orthonormal basis with local Z = normal so the handle's local Z drags
    // along the cut normal.
    const ref = Math.abs(normal.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(ref, normal).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    const basis = new THREE.Matrix4().makeBasis(u, v, normal).setPosition(point);

    const planeGeom = new THREE.PlaneGeometry(size, size);
    const visual = new THREE.Mesh(planeGeom, new THREE.MeshBasicMaterial({
      color: 0x10b981, transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthWrite: false,
    }));
    visual.applyMatrix4(basis);
    visual.renderOrder = 1460;
    this.scene.add(visual);

    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeom), new THREE.LineBasicMaterial({
      color: 0x059669, transparent: true, opacity: 0.85,
    }));
    outline.applyMatrix4(basis);
    outline.renderOrder = 1461;
    this.scene.add(outline);

    // Opaque, so it draws in the opaque pass after the stencil passes and
    // before the translucent section rectangle. Not clipped: it lies on the
    // clip plane. The stencil is reset where the cap draws.
    const cap = new THREE.Mesh(planeGeom, new THREE.MeshPhongMaterial({
      color: SECTION_CAP_COLOR,
      specular: 0x111111,
      shininess: 10,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    }));
    cap.applyMatrix4(basis);
    cap.renderOrder = SECTION_STENCIL_RENDER_ORDER + 1;
    cap.raycast = () => {};
    this.scene.add(cap);

    const clipPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
    this.meshRegistry.setClippingPlanes([clipPlane]);
    this.sectionState = { visual, outline, cap, clipPlane, normal };

    // Drag handle slides the cut along the normal — view-only, no commit.
    const sync = () => {
      outline.position.copy(visual.position);
      cap.position.copy(visual.position);
      clipPlane.setFromNormalAndCoplanarPoint(normal, visual.position);
    };
    this.attachManipulator(
      { target: visual, kind: 'distance', axis: normal, baseValue: 0 },
      { onChange: sync, onCommit: sync },
    );
  }

  /** Flip which side of the section cut is kept. No-op if not sectioning. */
  flipSection(): void {
    if (!this.sectionState) return;
    const p = this.sectionState.visual.position;
    const n = this.sectionState.normal;
    this.setSectionPlane({ normal: [-n.x, -n.y, -n.z], point: [p.x, p.y, p.z] });
  }

  /** True while a section cut is active. */
  isSectioning(): boolean {
    return this.sectionState !== null;
  }

  // ---- Body move ----

  /**
   * Attach a Move/Rotate gizmo to a body's mesh. The body's geometry is baked
   * at its stored placement, so the mesh sits at the origin; the gizmo reports
   * a *delta transform* (the gesture, in world space) which the caller composes
   * onto the stored transform.
   *
   * - `mode: 'translate'` → 3-axis arrows on the mesh; delta is a pure
   *   translation (`mesh.position`, rotation identity).
   * - `mode: 'rotate'` → rotation rings about the body's bounding-box CENTRE
   *   (a proxy at the centroid), so the body spins in place rather than
   *   orbiting the world origin. The delta is the rotate-about-pivot transform
   *   (which carries both a rotation and the pivot-induced translation).
   *
   * Edges follow live. Pass `bodyId: null` to detach.
   */
  attachBodyMoveGizmo(
    bodyIds: BodyId[] | null,
    mode: 'translate' | 'rotate' = 'translate',
    onCommit?: (delta: { position: [number, number, number]; quaternion: [number, number, number, number] }) => void,
  ): void {
    this.requestRender();
    if (!bodyIds || bodyIds.length === 0 || !onCommit) {
      this.bodyMoveRequest = null;
      this.clearBodyMoveProxy();
      this.transformGizmo.detach();
      return;
    }
    // Remember the request so we can re-attach to the FRESH meshes after each
    // rebuild (a drag commits → rebuild disposes meshes + makes new ones;
    // setDisplayMeshes calls applyBodyMoveRequest after swapping meshes, so
    // the gizmo doesn't vanish on release).
    this.bodyMoveRequest = { bodyIds, mode, onCommit };
    this.applyBodyMoveRequest();
  }

  /**
   * (Re)attach the body-move gizmo from the stored request. The handle is a
   * proxy at the CENTROID of all moved bodies, and the gizmo's world delta is
   * applied to every one of them live — so Move all drags all bodies together
   * (not one-then-catch-up) and the handle sits on the body, not at the world
   * origin. Reported delta is composed onto the stored transform by the caller.
   */
  private applyBodyMoveRequest(): void {
    const req = this.bodyMoveRequest;
    if (!req) return;
    const { bodyIds, mode, onCommit } = req;
    this.clearBodyMoveProxy();

    const driven: { mesh: THREE.Object3D; edges?: THREE.Object3D }[] = [];
    const box = new THREE.Box3();
    for (const id of bodyIds) {
      const entry = this.meshRegistry.getEntry(id);
      if (!entry) continue;
      box.expandByObject(entry.mesh);
      driven.push({ mesh: entry.mesh, ...(entry.edges ? { edges: entry.edges } : {}) });
    }
    if (driven.length === 0 || box.isEmpty()) { this.transformGizmo.detach(); return; }

    const pivot = box.getCenter(new THREE.Vector3());
    const proxy = new THREE.Object3D();
    proxy.position.copy(pivot);
    proxy.updateMatrixWorld();
    this.scene.add(proxy);
    this.bodyMoveProxy = proxy;
    this.bodyMoveDriven = driven;
    for (const d of driven) {
      d.mesh.matrixAutoUpdate = false;
      if (d.edges) d.edges.matrixAutoUpdate = false;
    }

    // World delta of the gesture, relative to the proxy's start pose (at the
    // pivot): D = T(proxy.pos)·R(proxy.quat)·T(-pivot). Translate → T(delta);
    // rotate → rotate-about-pivot. Applied to each moved mesh (which sit at
    // identity since geometry is baked).
    const deltaMatrix = (): THREE.Matrix4 =>
      new THREE.Matrix4().compose(proxy.position, proxy.quaternion, new THREE.Vector3(1, 1, 1))
        .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));

    const applyLive = (): void => {
      const m = deltaMatrix();
      for (const d of driven) {
        d.mesh.matrix.copy(m);
        d.mesh.matrixWorldNeedsUpdate = true;
        if (d.edges) { d.edges.matrix.copy(m); d.edges.matrixWorldNeedsUpdate = true; }
      }
    };

    // Diagnostics for the runaway-delta bug: a single small drag has been
    // observed committing a delta far larger than the gesture. The delta is
    // derived from `proxy.position` relative to `pivot`, and `pivot` comes
    // from the meshes' WORLD bounds, so a stale `matrixWorld` at attach time
    // would poison every subsequent drag. Logging both ends makes which one
    // is wrong obvious from one gesture. Attach + commit are user-initiated
    // and rare, so this is not a hot path. Remove once the cause is fixed.
    const fmt = (v: THREE.Vector3): string =>
      `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
    console.log(
      `[MoveGizmo] attach bodies=${bodyIds.length} mode=${mode}` +
        ` worldBounds=min${fmt(box.min)} max${fmt(box.max)} pivot=${fmt(pivot)}`,
    );

    this.transformGizmo.attach(
      proxy,
      { mode, space: 'world', showX: true, showY: true, showZ: true },
      {
        onChange: applyLive,
        onCommit: () => {
          const m = deltaMatrix();
          const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const s = new THREE.Vector3();
          m.decompose(p, q, s);
          console.log(
            `[MoveGizmo] commit pivot=${fmt(pivot)} proxy=${fmt(proxy.position)}` +
              ` -> delta=${fmt(p)} |delta|=${p.length().toFixed(2)}mm`,
          );
          onCommit({ position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] });
        },
      },
    );
  }

  /**
   * World-space bounds of a specific set of bodies, or null when none of them
   * are currently rendered. Scoped rather than whole-scene (`MeshRegistry`'s
   * `getBodiesBoundingBox`) so a placement action can measure just the import
   * it is about to move, ignoring everything else in the document.
   *
   * Reads the rendered geometry, which the kernel bakes transforms into — so
   * this is where the bodies actually ARE, not where they started.
   */
  getBodiesBounds(
    bodyIds: BodyId[],
  ): { min: [number, number, number]; max: [number, number, number] } | null {
    const box = new THREE.Box3();
    let found = false;
    for (const id of bodyIds) {
      const entry = this.meshRegistry.getEntry(id);
      if (!entry) continue;
      entry.mesh.updateWorldMatrix(true, false);
      entry.mesh.geometry.computeBoundingBox();
      const bb = entry.mesh.geometry.boundingBox;
      if (!bb) continue;
      box.union(bb.clone().applyMatrix4(entry.mesh.matrixWorld));
      found = true;
    }
    if (!found || box.isEmpty()) return null;
    return {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
    };
  }

  /** Tear down the move proxy and restore the driven meshes' auto-matrices. */
  private clearBodyMoveProxy(): void {
    if (this.bodyMoveDriven) {
      for (const d of this.bodyMoveDriven) {
        for (const obj of [d.mesh, d.edges]) {
          if (!obj) continue;
          obj.matrix.identity();
          obj.position.set(0, 0, 0);
          obj.quaternion.identity();
          obj.scale.set(1, 1, 1);
          obj.matrixAutoUpdate = true;
          obj.updateMatrix();
        }
      }
      this.bodyMoveDriven = null;
    }
    if (this.bodyMoveProxy) {
      this.scene.remove(this.bodyMoveProxy);
      this.bodyMoveProxy = null;
    }
  }

  /**
   * Update all display meshes from a rebuild result.
   * @param meshes - Array of display meshes from the worker
   * @param topoMaps - Topology maps for picking
   */
  setDisplayMeshes(meshes: DisplayMesh[], topoMaps: TopologyMap[]): void {
    this.requestRender();
    this.meshRegistry.updateAll(meshes, topoMaps);
    // Fresh meshes get fresh materials — re-apply the active section cut.
    if (this.sectionState) {
      this.meshRegistry.setClippingPlanes([this.sectionState.clipPlane]);
    }
    // A drag commits → rebuild → fresh mesh; re-attach the Move gizmo to it
    // so it doesn't vanish on release.
    if (this.bodyMoveRequest) {
      this.applyBodyMoveRequest();
    }
  }

  /**
   * Replace the rendered construction planes. Called once per rebuild
   * with the worker's `constructionPlanes` payload — the layer disposes
   * its prior meshes and creates fresh ones. Hidden CPs (timeline eye
   * toggled off) are filtered out by the layer.
   */
  setConstructionPlanes(planes: ConstructionPlaneDisplay[]): void {
    this.requestRender();
    this.constructionPlaneLayer.update(planes);
  }

  /**
   * Apply per-body display modes driven by DisplayContext + feature visibility.
   * @param modes - Map of bodyId to display mode
   */
  applyDisplayModes(modes: Map<BodyId, FeatureDisplayMode>): void {
    this.requestRender();
    this.meshRegistry.applyDisplayModes(modes);
  }

  /**
   * Test/debug accessor for the underlying mesh registry. Exposed so
   * dev-mode inspectors (preview-eval, console) can verify per-body
   * visibility / opacity state without reaching into private fields.
   * Not part of the supported runtime contract.
   */
  _getMeshRegistry(): MeshRegistry {
    return this.meshRegistry;
  }

  /**
   * Highlight selected bodies (blue emissive tint). Pass null to clear.
   */
  highlightBodies(bodyIds: Set<BodyId> | null): void {
    this.requestRender();
    this.meshRegistry.highlightBodies(bodyIds);
  }

  /**
   * Highlight the current selection.
   * @param sel - The current selection or null
   */
  setSelection(sel: Selection | null): void {
    this.requestRender();
    this.selectionHighlight.update(sel, this.meshRegistry);
  }

  /**
   * Update the preselection (hover highlight).
   * @param sel - The hover preselection or null
   */
  setPreselection(sel: Selection | null): void {
    this.requestRender();
    this.selectionHighlight.updatePreselection(sel, this.meshRegistry);
  }

  // ---- Picking ----

  /**
   * Set what kind of topology element pointer clicks resolve to.
   * 'none' disables picking entirely (so the orbit controls don't fight
   * with a feature picker that expects exclusive event handling).
   */
  setPickMode(mode: PickMode): void {
    this.pickMode = mode;
    // Stop hovering preselection from sticking when we leave pick mode.
    if (mode === 'none' && this.preselectCallback) {
      this.preselectCallback(null);
    }
  }

  /** Current pick mode (mostly for diagnostics/tests). */
  getPickMode(): PickMode {
    return this.pickMode;
  }

  /**
   * Register a click-pick callback. Called once per click that resolves to
   * a topology element. Pass null to detach.
   */
  setPickCallback(cb: ((picked: PickedTopology) => void) | null): void {
    this.pickCallback = cb;
  }

  /**
   * Register a hover (preselection) callback. Called on pointermove with
   * the topology element under the cursor, or null when the cursor leaves
   * any body. Pass null to detach.
   */
  setPreselectCallback(cb: ((picked: PickedTopology) => void) | null): void {
    this.preselectCallback = cb;
  }

  /**
   * Raycast against registered body meshes/edges using a screen point and
   * report the topology element under it. Pure: doesn't mutate selection
   * state. Used by both the click and hover handlers.
   */
  private pickAt(clientX: number, clientY: number): PickedTopology {
    if (this.pickMode === 'none') return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.pickRaycaster.setFromCamera(ndc, this.camera);

    if (this.pickMode === 'edge' || this.pickMode === 'edgeOrFace') {
      // Slightly generous edge threshold so users don't have to land
      // pointer-perfect on the line. Tuned for a typical zoom; could be
      // made camera-distance-adaptive later.
      this.pickRaycaster.params.Line = { threshold: this.spherical.radius * 0.01 };
      // In 'edgeOrFace' mode a click inside a face must not resolve to an
      // edge hidden behind it, so line hits are kept only where the edge
      // point itself is visible.
      const visibleOnly = this.pickMode === 'edgeOrFace';
      let best: { dist: number; bodyId: BodyId; segIdx: number; topoMap?: TopologyMap } | null = null;
      for (const entry of this.meshRegistry.getEntries()) {
        const edges = entry.edges;
        if (!edges || !edges.visible) continue;
        const hits = this.pickRaycaster.intersectObject(edges, false);
        const h = visibleOnly ? hits.find(hit => this.isPointVisible(hit.point)) : hits[0];
        // For THREE.LineSegments raycasts, the Intersection populates
        // `index` (start-vertex index of the hit segment), NOT
        // `faceIndex` — `faceIndex` is set only for Mesh hits where
        // it indexes triangles. Earlier versions of this code checked
        // `faceIndex` and silently no-op'd because it was always
        // undefined for line hits → edge picking never reached
        // segmentToEdgeId. Three.js 0.170+ Line.js builds segment K
        // from vertices 2K and 2K+1, so segment index = index/2 for
        // the non-indexed LineSegments geometry MeshRegistry creates.
        if (!h || typeof h.index !== 'number') continue;
        if (best && h.distance >= best.dist) continue;
        const segIdx = Math.floor(h.index / 2);
        best = { dist: h.distance, bodyId: entry.bodyId, segIdx, ...(entry.topoMap !== undefined ? { topoMap: entry.topoMap } : {}) };
      }
      const edgeId = best ? segmentToEdgeId(best.segIdx, best.topoMap) : undefined;
      if (best && edgeId) return { type: 'edge', bodyId: best.bodyId, edgeId };
      if (this.pickMode === 'edge') return null;
    }

    // Face / body modes raycast against the solid meshes.
    let bestFace: { dist: number; bodyId: BodyId; triIdx: number; topoMap?: TopologyMap } | null = null;
    for (const entry of this.meshRegistry.getEntries()) {
      if (!entry.mesh.visible) continue;
      const hits = this.pickRaycaster.intersectObject(entry.mesh, false);
      const h = hits[0];
      if (!h || typeof h.faceIndex !== 'number') continue;
      if (bestFace && h.distance >= bestFace.dist) continue;
      bestFace = { dist: h.distance, bodyId: entry.bodyId, triIdx: h.faceIndex, ...(entry.topoMap !== undefined ? { topoMap: entry.topoMap } : {}) };
    }
    if (!bestFace) return null;

    if (this.pickMode === 'body') {
      return { type: 'body', bodyId: bestFace.bodyId };
    }
    // pickMode === 'face' | 'edgeOrFace'
    const faceId = triangleToFaceId(bestFace.triIdx, bestFace.topoMap);
    if (!faceId) return null;
    return { type: 'face', bodyId: bestFace.bodyId, faceId };
  }

  /**
   * True when no visible body surface sits between the camera and `point`
   * (a point on an edge line). The tolerance absorbs the edge lying on the
   * surface it bounds.
   */
  private isPointVisible(point: THREE.Vector3): boolean {
    const origin = this.pickRaycaster.ray.origin;
    const dir = point.clone().sub(origin);
    const dist = dir.length();
    if (dist < 1e-9) return true;
    this.occlusionRaycaster.set(origin, dir.divideScalar(dist));
    this.occlusionRaycaster.far = dist;
    const eps = Math.max(dist * 1e-3, 1e-4);
    for (const entry of this.meshRegistry.getEntries()) {
      if (!entry.mesh.visible) continue;
      const hit = this.occlusionRaycaster.intersectObject(entry.mesh, false)[0];
      if (hit && hit.distance < dist - eps) return false;
    }
    return true;
  }

  /**
   * Handle canvas resize.
   * @param w - New width in pixels
   * @param h - New height in pixels
   */
  resize(w: number, h: number): void {
    this.requestRender();
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---- Public API for toolbar controls ----

  /** Zoom in by reducing spherical radius */
  zoomIn(): void {
    this.animFraming = null;
    this.spherical.radius *= 0.8;
    this.spherical.radius = Math.max(1, this.spherical.radius);
    this.updateCameraFromSpherical();
  }

  /** Zoom out by increasing spherical radius */
  zoomOut(): void {
    this.animFraming = null;
    this.spherical.radius *= 1.25;
    this.spherical.radius = Math.min(1000, this.spherical.radius);
    this.updateCameraFromSpherical();
  }

  /** Fit camera to show all model bodies */
  fitToView(): void {
    // Fit only the solid bodies — NOT the whole scene. Walking every mesh
    // pulls in overlays (construction planes, the section plane, selection
    // highlights, the transform gizmo), which either skew the framing or, if
    // one has a degenerate bounding box, poison the union with NaN and send
    // the camera nowhere. The body registry is the real model content.
    const framing = fitFraming(this.meshRegistry.getBodiesBoundingBox(), this.camera.fov);
    if (!framing) return;

    this.animFraming = null;
    this.target.copy(framing.target);
    this.spherical.radius = framing.radius;
    this.updateCameraFromSpherical();
  }

  /** Snap to a standard view by name. `home` also frames the model, like {@link resetView}. */
  setStandardView(view: 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | 'home'): void {
    if (view === 'home') {
      this.resetView();
      return;
    }
    // THREE.Spherical: theta=azimuth from +Z around Y, phi=polar from Y+
    // theta=0,phi=PI/2 => camera on +Z looking at -Z => sees FRONT (z+ face)
    const views: Record<string, { theta: number; phi: number }> = {
      front:  { theta: 0,               phi: Math.PI / 2 },
      back:   { theta: Math.PI,         phi: Math.PI / 2 },
      top:    { theta: 0,               phi: 0.001 },
      bottom: { theta: 0,               phi: Math.PI - 0.001 },
      right:  { theta: Math.PI / 2,     phi: Math.PI / 2 },
      left:   { theta: -Math.PI / 2,    phi: Math.PI / 2 },
    };
    const v = views[view];
    if (v) {
      this.animateToView(v.theta, v.phi);
    }
  }

  /**
   * Animate to the home angles while framing the model bodies the way Fit All
   * does. With no bodies, home is the origin at the default distance.
   */
  resetView(): void {
    const framing = homeFraming(this.meshRegistry.getBodiesBoundingBox(), this.camera.fov);
    this.animateToView(HOME_THETA, HOME_PHI, framing);
  }

  /** Save current camera view state (for restore after sketch mode) */
  getViewState(): { theta: number; phi: number; radius: number; target: [number, number, number] } {
    return {
      theta: this.spherical.theta,
      phi: this.spherical.phi,
      radius: this.spherical.radius,
      target: [this.target.x, this.target.y, this.target.z],
    };
  }

  /** Restore a previously saved camera view state (with animation) */
  restoreViewState(state: { theta: number; phi: number; radius: number; target: [number, number, number] }): void {
    this.target.set(state.target[0], state.target[1], state.target[2]);
    this.spherical.radius = state.radius;
    this.animateToView(state.theta, state.phi);
  }

  /** Get the current camera quaternion (for ViewCube sync) */
  getCameraQuaternion(): { x: number; y: number; z: number; w: number } {
    return {
      x: this.camera.quaternion.x,
      y: this.camera.quaternion.y,
      z: this.camera.quaternion.z,
      w: this.camera.quaternion.w,
    };
  }

  /** Animate to a specific spherical view (called by ViewCube) */
  goToView(theta: number, phi: number): void {
    this.animateToView(theta, phi);
  }

  /** Get the Three.js scene (for adding sketch geometry, overlays, etc.) */
  getScene(): THREE.Scene {
    return this.scene;
  }

  /** Get the Three.js camera */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /** Get the renderer DOM element (canvas) */
  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /**
   * Capture a JPEG screenshot of the current view. Returns the image
   * as base64 (no data: URL prefix) plus the mime type. Used by the
   * tool layer to give a tool consumer visual feedback on what's in the
   * viewport.
   *
   * `maxDim` caps the longer edge of the output (default 768 px) and
   * `quality` is the JPEG quality 0..1 (default 0.6). These defaults
   * land a typical viewport screenshot at ~25–60 KB base64 — small
   * enough for a typical MCP client's tool-result budget. Earlier defaults
   * of 1024×q0.75 overflowed at least one client (51k chars >> 16 KB
   * budget); the new defaults are tighter at the cost of slightly
   * fuzzier image, which doesn't matter for verification shots ("does
   * this look like a plate?").
   *
   * Implementation: forces a render so the WebGL buffer has the latest
   * pixels, then either reads from the WebGL canvas directly (if it's
   * already under the size cap) or downscales through an offscreen 2D
   * canvas. `preserveDrawingBuffer:true` in the renderer config makes
   * the direct read reliable.
   */
  captureScreenshot(
    opts: { maxDim?: number; quality?: number } = {},
  ): { mimeType: 'image/jpeg'; data: string } {
    const maxDim = opts.maxDim ?? 768;
    const quality = opts.quality ?? 0.6;

    // Force a render so the buffer reflects the current scene state
    // — even if rAF is paused (a tool consumer may call this when the
    // user is idle and no frames are being scheduled).
    this.renderer.render(this.scene, this.camera);

    const srcCanvas = this.renderer.domElement;
    const srcW = srcCanvas.width;
    const srcH = srcCanvas.height;
    const longEdge = Math.max(srcW, srcH);

    let outDataUrl: string;
    if (longEdge <= maxDim) {
      outDataUrl = srcCanvas.toDataURL('image/jpeg', quality);
    } else {
      const scale = maxDim / longEdge;
      const dstW = Math.max(1, Math.floor(srcW * scale));
      const dstH = Math.max(1, Math.floor(srcH * scale));
      const tmp = document.createElement('canvas');
      tmp.width = dstW;
      tmp.height = dstH;
      const ctx = tmp.getContext('2d');
      if (!ctx) {
        // 2D context refusal is extremely rare; if it happens, fall
        // back to the unscaled image rather than failing the tool call.
        outDataUrl = srcCanvas.toDataURL('image/jpeg', quality);
      } else {
        ctx.drawImage(srcCanvas, 0, 0, dstW, dstH);
        outDataUrl = tmp.toDataURL('image/jpeg', quality);
      }
    }

    const prefix = 'data:image/jpeg;base64,';
    const data = outDataUrl.startsWith(prefix) ? outDataUrl.slice(prefix.length) : outDataUrl;
    return { mimeType: 'image/jpeg', data };
  }

  /** Get the WebGL renderer */
  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  /**
   * Snapshot the current viewport as a WebP blob suitable for use as a
   * project thumbnail.
   *
   * Two gotchas this method handles:
   *
   *   - Three.js's default WebGL context doesn't preserve the drawing
   *     buffer between frames, so `canvas.toBlob()` on the live canvas
   *     can return a blank image. We force a synchronous re-render right
   *     before reading pixels.
   *
   *   - The live canvas can be very large (DPR=2 on a 1920×1080 viewport
   *     yields a 3840×2160 buffer). We downscale via OffscreenCanvas with
   *     aspect-fit letterboxing so callers always get a predictable size.
   *
   * Returns null when the canvas is zero-sized (e.g., editor not yet
   * mounted) or the platform lacks OffscreenCanvas / WebP support.
   */
  async captureThumbnail(
    opts: { width?: number; height?: number; quality?: number } = {},
  ): Promise<Blob | null> {
    const targetW = opts.width ?? 800;
    const targetH = opts.height ?? 600;
    const quality = opts.quality ?? 0.8;

    // Synchronous re-render so the drawing buffer has fresh content.
    this.renderer.render(this.scene, this.camera);

    const source = this.renderer.domElement;
    if (source.width === 0 || source.height === 0) return null;

    if (typeof OffscreenCanvas === 'undefined') return null;
    const off = new OffscreenCanvas(targetW, targetH);
    const ctx = off.getContext('2d');
    if (!ctx) return null;

    // Aspect-fit: scale to fit while preserving source aspect ratio,
    // letterbox the remainder with the renderer's clear color so the
    // thumbnail blends with the viewport background.
    const srcRatio = source.width / source.height;
    const dstRatio = targetW / targetH;
    let drawW = targetW;
    let drawH = targetH;
    let drawX = 0;
    let drawY = 0;
    if (srcRatio > dstRatio) {
      drawH = targetW / srcRatio;
      drawY = (targetH - drawH) / 2;
    } else {
      drawW = targetH * srcRatio;
      drawX = (targetW - drawW) / 2;
    }

    ctx.fillStyle = '#f0f0f0'; // matches setClearColor in constructor
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, drawX, drawY, drawW, drawH);

    try {
      return await off.convertToBlob({ type: 'image/webp', quality });
    } catch {
      // Some platforms might not support WebP — fall through to PNG.
      try {
        return await off.convertToBlob({ type: 'image/png' });
      } catch {
        return null;
      }
    }
  }

  /**
   * Project a screen point (NDC) onto a world-space plane.
   * Used for sketch drawing on arbitrary planes.
   * @param ndcX - Normalized device X (-1 to 1)
   * @param ndcY - Normalized device Y (-1 to 1)
   * @param planeNormal - Plane normal in world space
   * @param planePoint - A point on the plane in world space
   * @returns The intersection point in world space, or null
   */
  projectOntoPlane(
    ndcX: number,
    ndcY: number,
    planeNormal: THREE.Vector3,
    planePoint: THREE.Vector3,
  ): THREE.Vector3 | null {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, planePoint);
    const result = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, result) ? result : null;
  }

  /** Dispose the viewport and all resources */
  dispose(): void {
    this.disposed = true;
    for (const type of RENDER_ON_INPUT) {
      window.removeEventListener(type, this.onInput, { capture: true });
    }
    this.setSectionPlane(null);
    this.transformGizmo.dispose();
    this.selectionHighlight.dispose();
    this.meshRegistry.dispose();
    // this.viewCube.dispose();
    this.renderer.dispose();
  }

  /** Main animation loop */
  private animate = (): void => {
    if (this.disposed) return;

    // Update smooth camera animation if active (each step requests a frame)
    if (this.animating) {
      this.updateAnimation();
    }

    // Render main scene, only when something may have changed
    if (this.frames.take()) {
      this.renderer.render(this.scene, this.camera);
    }

    // ViewCube disabled
    // this.viewCube.syncRotation(this.camera);
    // this.viewCube.render(this.renderer);

    requestAnimationFrame(this.animate);
  };

  /** Setup scene lighting */
  private setupLighting(): void {
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 7);
    this.scene.add(dir);

    const dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dir2.position.set(-5, -5, -7);
    this.scene.add(dir2);
  }

  /** Setup a grid helper on the XZ ground plane (Y-up, standard CAD convention) */
  private setupGrid(): void {
    const grid = new THREE.GridHelper(200, 20, 0xcccccc, 0xe0e0e0);
    // GridHelper is already on XZ by default (Y-up), no rotation needed
    this.scene.add(grid);
  }

  /**
   * Override the camera's up-vector. Three.js's lookAt uses this to
   * disambiguate orientation when the camera looks straight along a world
   * axis. Sketch mode sets this so the sketch's u/v axes map cleanly to
   * screen right/up, otherwise H/V constraints appear rotated 90°.
   */
  setCameraUp(up: { x: number; y: number; z: number }): void {
    this.camera.up.set(up.x, up.y, up.z);
    this.camera.lookAt(this.target);
    this.requestRender();
  }

  /** Convert spherical coordinates to camera position */
  private updateCameraFromSpherical(): void {
    const pos = new THREE.Vector3().setFromSpherical(this.spherical);
    pos.add(this.target);
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target);
    this.requestRender();
  }

  /**
   * Animate camera to a target view over animDuration ms. When `framing` is
   * given, the orbit target and radius blend toward it on the same curve.
   */
  private animateToView(theta: number, phi: number, framing?: CameraFraming): void {
    this.animFraming = framing
      ? { from: { target: this.target.clone(), radius: this.spherical.radius }, to: framing }
      : null;
    this.animStart.theta = this.spherical.theta;
    this.animStart.phi = this.spherical.phi;

    // Normalize theta difference to take shortest path
    let dTheta = theta - this.animStart.theta;
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI;

    this.animEnd.theta = this.animStart.theta + dTheta;
    this.animEnd.phi = phi;
    this.animStartTime = performance.now();
    this.animating = true;
  }

  /** Update animation state each frame */
  private updateAnimation(): void {
    const elapsed = performance.now() - this.animStartTime;
    let t = Math.min(elapsed / this.animDuration, 1);

    // Ease-in-out cubic
    t = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    this.spherical.theta = this.animStart.theta + (this.animEnd.theta - this.animStart.theta) * t;
    this.spherical.phi = this.animStart.phi + (this.animEnd.phi - this.animStart.phi) * t;
    if (this.animFraming) {
      const out = { target: this.target, radius: 0 };
      lerpFraming(this.animFraming.from, this.animFraming.to, t, out);
      this.spherical.radius = out.radius;
    }
    this.updateCameraFromSpherical();

    if (t >= 1) {
      this.animating = false;
      this.animFraming = null;
    }
  }

  /** Setup mouse controls for orbiting, zooming, panning */
  private setupControls(canvas: HTMLCanvasElement): void {
    let dragButton = -1;

    canvas.addEventListener('mousedown', (e: MouseEvent) => {
      // A gizmo drag (or other modal interaction) owns the pointer — don't
      // start an orbit/pan underneath it. The gizmo's pointerdown fires
      // before this mousedown and flips navEnabled off.
      if (!this.navEnabled) return;
      // Left button = orbit, Middle button = pan, Right button = orbit
      if (e.button === 0 || e.button === 1 || e.button === 2) {
        this.isDragging = true;
        dragButton = e.button;
        this.lastMouse = { x: e.clientX, y: e.clientY };
        // Remember where the down happened so mouseup can tell click-vs-drag.
        // Only left-button counts as a potential pick — middle/right pan/orbit only.
        this.mouseDownAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
        e.preventDefault();
      }
    });

    canvas.addEventListener('mousemove', (e: MouseEvent) => {
      // Hover preselection only fires when we're NOT mid-drag and pick is on.
      // Cheap to compute (one raycast per body) and only runs when the mode
      // is set, so the orbit path is unaffected.
      if (!this.isDragging && this.pickMode !== 'none' && this.preselectCallback) {
        this.preselectCallback(this.pickAt(e.clientX, e.clientY));
      }

      if (!this.isDragging) return;

      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;

      if (dragButton === 1) {
        // Middle button: pan
        const panSpeed = 0.05 * this.spherical.radius * 0.01;
        const right = new THREE.Vector3();
        const up = new THREE.Vector3();
        right.setFromMatrixColumn(this.camera.matrix, 0);
        up.setFromMatrixColumn(this.camera.matrix, 1);
        this.animFraming = null;
        this.target.addScaledVector(right, -dx * panSpeed);
        this.target.addScaledVector(up, dy * panSpeed);
      } else {
        // Left/right button: orbit
        this.animating = false;
        this.animFraming = null;
        this.spherical.theta -= dx * 0.005;
        this.spherical.phi -= dy * 0.005;
        this.spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.spherical.phi));
      }

      this.updateCameraFromSpherical();
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });

    canvas.addEventListener('mouseup', (e: MouseEvent) => {
      // Distinguish a click (negligible drag) from an orbit-release. We only
      // fire a pick when the user pressed and released without dragging more
      // than a few pixels — anything larger was a camera move.
      if (
        this.mouseDownAt &&
        e.button === 0 &&
        this.pickMode !== 'none' &&
        this.pickCallback
      ) {
        const dx = e.clientX - this.mouseDownAt.x;
        const dy = e.clientY - this.mouseDownAt.y;
        if (Math.hypot(dx, dy) <= CLICK_DRAG_TOLERANCE) {
          this.pickCallback(this.pickAt(e.clientX, e.clientY));
        }
      }
      this.mouseDownAt = null;
      this.isDragging = false;
      dragButton = -1;
    });

    canvas.addEventListener('mouseleave', () => {
      this.isDragging = false;
      dragButton = -1;
      this.mouseDownAt = null;
      // Clear hover preselection so a stale highlight doesn't linger on the
      // viewport when the user moves into another panel.
      if (this.preselectCallback) this.preselectCallback(null);
    });

    // Zoom toward mouse cursor: dolly radius + shift orbit target toward cursor
    canvas.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      this.animFraming = null;

      const zoomIn = e.deltaY < 0;
      const factor = zoomIn ? 0.9 : 1.1;
      const newRadius = Math.max(1, Math.min(1000, this.spherical.radius * factor));

      // Cast a ray from cursor NDC to find the world point on the target plane
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

      // Intersect with a plane through the target, perpendicular to the view direction
      const viewDir = new THREE.Vector3();
      this.camera.getWorldDirection(viewDir);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir, this.target);
      const worldPoint = new THREE.Vector3();
      const hit = raycaster.ray.intersectPlane(plane, worldPoint);

      if (hit) {
        // Shift orbit target toward the cursor point proportionally to zoom delta
        const zoomRatio = 1 - newRadius / this.spherical.radius;
        const shift = new THREE.Vector3().subVectors(worldPoint, this.target);
        this.target.addScaledVector(shift, zoomRatio * 0.5);
      }

      this.spherical.radius = newRadius;
      this.updateCameraFromSpherical();
    }, { passive: false });

    canvas.addEventListener('contextmenu', (e: Event) => {
      e.preventDefault();
    });
  }
}
