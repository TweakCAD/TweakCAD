/**
 * The 3D view: renderer, camera, lights and grid, orbit / pan / zoom, and
 * pointer picks into the model scene. React lays out the panels around it;
 * this class owns the canvas.
 *
 * Camera controls are the modelling view's: left or right drag orbits,
 * middle drag pans, the wheel zooms toward the cursor, standard views
 * animate. Frames are drawn on demand.
 *
 * A pointer handler (a sketch session, a tool) sees every pointer event
 * first; when it takes one, the view neither orbits nor picks.
 *
 * A section view cuts the bodies with a plane, caps the cut where it goes
 * through material, and draws the plane with a handle that slides it along
 * its normal. It is a view aid: nothing is written to the document.
 */
import * as THREE from 'three';
import { FrameGate } from '@tweakcad/viewport/src/frameGate';
import { TransformGizmo } from '@tweakcad/viewport/src/TransformGizmo';
import {
  fitFraming,
  homeFraming,
  lerpFraming,
  HOME_PHI,
  HOME_THETA,
  type CameraFraming,
} from '@tweakcad/viewport/src/cameraFraming';
import type { FrameDisplay, Vec3 } from '@tweakcad/worker/src/v2/service/types';
import type { SelectionItem } from '../selection';
import { ModelScene, SECTION_STENCIL_ORDER } from './ModelScene';
import { PICK_PIXELS } from './style';

/** Pixels the pointer may move between press and release for a click. */
const CLICK_DRAG_TOLERANCE = 3;
/** Window events that request a frame. */
const RENDER_ON_INPUT = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'wheel',
  'keydown',
  'keyup',
] as const;

export interface ViewportPointer {
  type: 'down' | 'move' | 'up';
  clientX: number;
  clientY: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export interface PickModifiers {
  shift: boolean;
  ctrl: boolean;
}

/** The fill of a section's cap, a lighter shade of the default body colour. */
const SECTION_CAP_COLOR = 0xa9c0d8;
const SECTION_FILL = 0x10b981;
const SECTION_OUTLINE = 0x059669;

/** A section view's cut: a plane through `point` (default: the bodies' centre) whose normal points to the half that stays. */
export interface SectionSpec {
  normal: Vec3;
  point?: Vec3;
  /** Told where the cut stands after its handle moves it. */
  onMove?: (point: Vec3) => void;
}

interface SectionState {
  visual: THREE.Mesh;
  outline: THREE.LineSegments;
  cap: THREE.Mesh;
  plane: THREE.Plane;
  normal: THREE.Vector3;
  gizmo: TransformGizmo;
}

export interface ViewState {
  theta: number;
  phi: number;
  radius: number;
  target: [number, number, number];
}

/**
 * The orbit angles that put the camera on the side `normal` points to,
 * looking back along it (THREE.Spherical: theta about +Y from +Z, phi from
 * +Y). Straight up or down is nudged off the pole, as the top and bottom
 * views are.
 */
export function viewAlong(normal: Vec3): { theta: number; phi: number } {
  const [x, y, z] = normal;
  const length = Math.hypot(x, y, z) || 1;
  const phi = Math.min(Math.PI - 0.001, Math.max(0.001, Math.acos(Math.max(-1, Math.min(1, y / length)))));
  const theta = Math.hypot(x, z) < 1e-9 ? 0 : Math.atan2(x, z);
  return { theta, phi };
}

/**
 * The ground grid, drawn as a backdrop: first, writing no depth, so every
 * body draws over it, even where a body reaches below the ground.
 */
export function groundGrid(): THREE.GridHelper {
  const grid = new THREE.GridHelper(200, 20, 0xcccccc, 0xe0e0e0);
  grid.renderOrder = -1;
  for (const m of ([] as THREE.Material[]).concat(grid.material)) m.depthWrite = false;
  return grid;
}

export class Viewport {
  readonly model = new ModelScene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  private readonly frames = new FrameGate();
  private readonly onInput = (): void => this.frames.request();
  private readonly raycaster = new THREE.Raycaster();
  private readonly grid = groundGrid();
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  private spherical = new THREE.Spherical(50, Math.PI / 3, Math.PI / 4);
  private target = new THREE.Vector3();
  private dragging = false;
  private dragButton = -1;
  private lastMouse = { x: 0, y: 0 };
  private downAt: { x: number; y: number } | null = null;
  private pointerTaken = false;

  private animating = false;
  private animStart = { theta: 0, phi: 0 };
  private animEnd = { theta: 0, phi: 0 };
  private animFraming: { from: CameraFraming; to: CameraFraming } | null = null;
  private animStartTime = 0;
  private readonly animDuration = 400;

  private picking = true;
  private hoverListener: ((item: SelectionItem | null) => void) | null = null;
  private clickListener: ((item: SelectionItem | null, modifiers: PickModifiers) => void) | null = null;
  private pointerHandler: ((e: ViewportPointer) => boolean) | null = null;
  private section: SectionState | null = null;

  constructor(canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer lets screenshots read the canvas back.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, stencil: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0xf0f0f0, 1);
    // Materials carry their own clipping planes (the section view).
    this.renderer.localClippingEnabled = true;
    this.scene.add(this.model.root);
    this.setupLighting();
    this.scene.add(this.grid);
    this.updateCamera();
    this.setupControls(canvas);
    for (const type of RENDER_ON_INPUT) window.addEventListener(type, this.onInput, { capture: true, passive: true });
    this.animate();
  }

  /** Draws a frame on the next animation tick; call after changing the scene from outside. */
  requestRender(): void {
    this.frames.request();
  }

  /** Renders every frame until the returned function is called. */
  holdContinuousRender(): () => void {
    return this.frames.hold();
  }

  /** The ground grid on or off (off while a sketch draws its own). */
  setGridVisible(visible: boolean): void {
    if (this.grid.visible === visible) return;
    this.grid.visible = visible;
    this.requestRender();
  }

  /** The scene, for a session that draws into it. */
  getScene(): THREE.Scene {
    return this.scene;
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  // ---- Picking ----

  /** Hover and click picks on or off (off while something else owns the pointer). */
  setPicking(on: boolean): void {
    this.picking = on;
    if (!on) this.hoverListener?.(null);
  }

  onHover(listener: ((item: SelectionItem | null) => void) | null): void {
    this.hoverListener = listener;
  }

  onClick(listener: ((item: SelectionItem | null, modifiers: PickModifiers) => void) | null): void {
    this.clickListener = listener;
  }

  /** A handler that sees pointer events first; returning true takes the event. */
  setPointerHandler(handler: ((e: ViewportPointer) => boolean) | null): void {
    this.pointerHandler = handler;
  }

  /** Scene units per screen pixel at `point` (default: the orbit target). */
  pixelSize(point: THREE.Vector3 = this.target): number {
    const height = this.renderer.domElement.clientHeight || 1;
    const distance = this.camera.position.distanceTo(point);
    return (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / height;
  }

  private rayAt(clientX: number, clientY: number): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return true;
  }

  /** The item under a screen point. */
  pickAt(clientX: number, clientY: number): SelectionItem | null {
    if (!this.rayAt(clientX, clientY)) return null;
    this.scene.updateMatrixWorld();
    // The search reaches the farthest shown geometry; each hit is then held to its own on-screen tolerance.
    const sphere = new THREE.Box3().setFromObject(this.model.root).getBoundingSphere(new THREE.Sphere());
    const far = sphere.isEmpty()
      ? this.target
      : this.camera.position
          .clone()
          .add(
            this.raycaster.ray.direction
              .clone()
              .multiplyScalar(this.camera.position.distanceTo(sphere.center) + sphere.radius),
          );
    return this.model.pick(this.raycaster, Math.max(this.pixelSize(), this.pixelSize(far)) * PICK_PIXELS, (p) =>
      this.pixelSize(p),
    );
  }

  /**
   * Where a screen point meets a frame's xy plane, in that frame's
   * coordinates, with the scene units per pixel there. Null when the ray
   * runs parallel to the plane.
   */
  planePoint(
    clientX: number,
    clientY: number,
    frame: FrameDisplay,
  ): { uv: [number, number]; at: THREE.Vector3; pixel: number } | null {
    if (!this.rayAt(clientX, clientY)) return null;
    const origin = new THREE.Vector3(...frame.origin);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...frame.normal), origin);
    const at = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, at)) return null;
    const d = at.clone().sub(origin);
    return {
      uv: [d.dot(new THREE.Vector3(...frame.x)), d.dot(new THREE.Vector3(...frame.y))],
      at,
      pixel: this.pixelSize(at),
    };
  }

  /** A scene point in CSS pixels relative to the canvas, or null behind the camera. */
  toScreen(p: Vec3): { x: number; y: number } | null {
    const v = new THREE.Vector3(...p).project(this.camera);
    if (v.z > 1) return null;
    const canvas = this.renderer.domElement;
    return { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight };
  }

  // ---- Camera ----

  zoomIn(): void {
    this.animFraming = null;
    this.spherical.radius = Math.max(1, this.spherical.radius * 0.8);
    this.updateCamera();
  }

  zoomOut(): void {
    this.animFraming = null;
    this.spherical.radius = Math.min(1000, this.spherical.radius * 1.25);
    this.updateCamera();
  }

  /** Frames the bodies. */
  fitToView(): void {
    const framing = fitFraming(this.model.bodiesBox(), this.camera.fov);
    if (!framing) return;
    this.animFraming = null;
    this.target.copy(framing.target);
    this.spherical.radius = framing.radius;
    this.updateCamera();
  }

  /** Animates to the home angles, framing the bodies (the standard planes when there are none). */
  resetView(): void {
    this.animateToView(HOME_THETA, HOME_PHI, homeFraming(this.model.framingBox(), this.camera.fov));
  }

  setStandardView(view: 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | 'home'): void {
    if (view === 'home') return this.resetView();
    // THREE.Spherical: theta is the azimuth from +Z about Y, phi the polar angle from +Y.
    const views = {
      front: { theta: 0, phi: Math.PI / 2 },
      back: { theta: Math.PI, phi: Math.PI / 2 },
      top: { theta: 0, phi: 0.001 },
      bottom: { theta: 0, phi: Math.PI - 0.001 },
      right: { theta: Math.PI / 2, phi: Math.PI / 2 },
      left: { theta: -Math.PI / 2, phi: Math.PI / 2 },
    };
    const v = views[view];
    this.animateToView(v.theta, v.phi);
  }

  /** Animates to orbit angles; `framed` also frames the model as Home does. */
  goToView(theta: number, phi: number, framed = false): void {
    this.animateToView(theta, phi, framed ? homeFraming(this.model.framingBox(), this.camera.fov) : undefined);
  }

  getViewState(): ViewState {
    return {
      theta: this.spherical.theta,
      phi: this.spherical.phi,
      radius: this.spherical.radius,
      target: [this.target.x, this.target.y, this.target.z],
    };
  }

  restoreViewState(state: ViewState): void {
    this.target.set(...state.target);
    this.spherical.radius = state.radius;
    this.animateToView(state.theta, state.phi);
  }

  getCameraQuaternion(): THREE.Quaternion {
    return this.camera.quaternion.clone();
  }

  /** The camera's up vector, so a sketch's axes map to screen right and up. */
  setCameraUp(up: Vec3): void {
    this.camera.up.set(...up);
    this.camera.lookAt(this.target);
    this.requestRender();
  }

  /** The canvas as a JPEG data URL. */
  screenshot(quality = 0.8): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/jpeg', quality);
  }

  // ---- Section ----

  /**
   * Starts a section cut, or moves it, or with null ends it. The half of
   * the bodies the normal points away from is cut off; the cut starts
   * through `spec.point`, by default the bodies' centre. A translucent
   * rectangle shows the plane, with a handle that slides it along its
   * normal as it is dragged.
   */
  setSection(spec: SectionSpec | null): void {
    this.requestRender();
    if (this.section) {
      const s = this.section;
      s.gizmo.dispose();
      this.scene.remove(s.visual, s.outline, s.cap);
      s.visual.geometry.dispose();
      (s.visual.material as THREE.Material).dispose();
      s.outline.geometry.dispose();
      (s.outline.material as THREE.Material).dispose();
      (s.cap.material as THREE.Material).dispose();
      this.section = null;
      this.model.setClipping(null);
    }
    if (!spec) return;

    const normal = new THREE.Vector3(...spec.normal).normalize();
    const box = this.model.bodiesBox();
    const centre = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const point = spec.point ? new THREE.Vector3(...spec.point) : centre;
    const size = box.isEmpty() ? 200 : box.getSize(new THREE.Vector3()).length() * 1.2 + 20;

    // Local z along the normal, so the handle's z arrow slides the cut.
    const ref = Math.abs(normal.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(ref, normal).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    const basis = new THREE.Matrix4().makeBasis(u, v, normal).setPosition(point);

    const geometry = new THREE.PlaneGeometry(size, size);
    const visual = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: SECTION_FILL,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    visual.applyMatrix4(basis);
    visual.renderOrder = 1460;
    visual.raycast = () => undefined;
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: SECTION_OUTLINE, transparent: true, opacity: 0.85 }),
    );
    outline.applyMatrix4(basis);
    outline.renderOrder = 1461;
    // Opaque, so it draws after the stencil passes; not cut, as it lies on the plane. It resets the stencil where it draws.
    const cap = new THREE.Mesh(
      geometry,
      new THREE.MeshPhongMaterial({
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
      }),
    );
    cap.applyMatrix4(basis);
    cap.renderOrder = SECTION_STENCIL_ORDER + 1;
    cap.raycast = () => undefined;
    this.scene.add(visual, outline, cap);

    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
    this.model.setClipping([plane]);
    const gizmo = new TransformGizmo(this.scene, this.camera, this.renderer.domElement, () => undefined);
    const follow = () => {
      outline.position.copy(visual.position);
      cap.position.copy(visual.position);
      plane.setFromNormalAndCoplanarPoint(normal, visual.position);
      this.requestRender();
    };
    const moved = () => {
      follow();
      spec.onMove?.([visual.position.x, visual.position.y, visual.position.z]);
    };
    gizmo.attach(
      visual,
      { mode: 'translate', space: 'local', showX: false, showY: false, showZ: true },
      { onChange: moved, onCommit: moved },
    );
    this.section = { visual, outline, cap, plane, normal, gizmo };
  }

  /** The section's cut, if there is one: where it stands and its normal (world space). */
  sectionCut(): { point: Vec3; normal: Vec3 } | null {
    if (!this.section) return null;
    const { visual, normal } = this.section;
    return { point: [visual.position.x, visual.position.y, visual.position.z], normal: [normal.x, normal.y, normal.z] };
  }

  /** Moves the cut to stand at `point`, keeping its normal; not while its handle is being dragged. */
  moveSection(point: Vec3): void {
    const s = this.section;
    if (!s || s.gizmo.isDragging()) return;
    s.visual.position.set(...point);
    s.visual.updateMatrixWorld();
    s.outline.position.copy(s.visual.position);
    s.cap.position.copy(s.visual.position);
    s.plane.setFromNormalAndCoplanarPoint(s.normal, s.visual.position);
    this.requestRender();
  }

  /** The section's cut plane (world space), or null when there is none. */
  sectionPlane(): THREE.Plane | null {
    return this.section ? this.section.plane.clone() : null;
  }

  dispose(): void {
    this.disposed = true;
    this.setSection(null);
    for (const type of RENDER_ON_INPUT) window.removeEventListener(type, this.onInput, { capture: true });
    for (const c of this.cleanups) c();
    this.model.dispose();
    this.renderer.dispose();
  }

  private animate = (): void => {
    if (this.disposed) return;
    if (this.animating) this.updateAnimation();
    if (this.frames.take()) this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.animate);
  };

  private setupLighting(): void {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(5, 10, 7);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-5, -5, -7);
    this.scene.add(fill);
  }

  private updateCamera(): void {
    this.camera.position.copy(new THREE.Vector3().setFromSpherical(this.spherical).add(this.target));
    this.camera.lookAt(this.target);
    this.requestRender();
  }

  private animateToView(theta: number, phi: number, framing?: CameraFraming): void {
    this.animFraming = framing
      ? { from: { target: this.target.clone(), radius: this.spherical.radius }, to: framing }
      : null;
    this.animStart = { theta: this.spherical.theta, phi: this.spherical.phi };
    let dTheta = theta - this.animStart.theta;
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    this.animEnd = { theta: this.animStart.theta + dTheta, phi };
    this.animStartTime = performance.now();
    this.animating = true;
    this.requestRender();
  }

  private updateAnimation(): void {
    let t = Math.min((performance.now() - this.animStartTime) / this.animDuration, 1);
    t = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.spherical.theta = this.animStart.theta + (this.animEnd.theta - this.animStart.theta) * t;
    this.spherical.phi = this.animStart.phi + (this.animEnd.phi - this.animStart.phi) * t;
    if (this.animFraming) {
      const out = { target: this.target, radius: 0 };
      lerpFraming(this.animFraming.from, this.animFraming.to, t, out);
      this.spherical.radius = out.radius;
    }
    this.updateCamera();
    if (t >= 1) {
      this.animating = false;
      this.animFraming = null;
    }
  }

  private pointerEvent(type: ViewportPointer['type'], e: MouseEvent): boolean {
    if (!this.pointerHandler) return false;
    return this.pointerHandler({
      type,
      clientX: e.clientX,
      clientY: e.clientY,
      button: e.button,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
    });
  }

  private setupControls(canvas: HTMLCanvasElement): void {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      canvas.addEventListener(type, fn, options);
      this.cleanups.push(() => canvas.removeEventListener(type, fn, options));
    };

    on('mousedown', (e) => {
      // A press in the view ends typing in a field over it, as a press anywhere would.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
      // A press on the section's handle drags the cut; the view neither orbits nor picks.
      if (this.section?.gizmo.isDragging() && e.button === 0) {
        e.preventDefault();
        this.pointerTaken = true;
        return;
      }
      // A handler that takes a left press owns the gesture until release; other buttons still orbit and pan.
      // Its press keeps focus where the handler put it (a field it opened), so the browser does not move it.
      if (this.pointerEvent('down', e) && e.button === 0) {
        e.preventDefault();
        this.pointerTaken = true;
        return;
      }
      this.dragging = true;
      this.dragButton = e.button;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.downAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
      e.preventDefault();
    });

    on('mousemove', (e) => {
      const taken = this.pointerEvent('move', e);
      if (!this.dragging) {
        if (!taken && this.picking && !this.pointerTaken) this.hoverListener?.(this.pickAt(e.clientX, e.clientY));
        else if (taken) this.hoverListener?.(null);
        return;
      }
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      if (this.dragButton === 1) {
        const speed = 0.05 * this.spherical.radius * 0.01;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
        this.animFraming = null;
        this.target.addScaledVector(right, -dx * speed).addScaledVector(up, dy * speed);
      } else {
        this.animating = false;
        this.animFraming = null;
        this.spherical.theta -= dx * 0.005;
        this.spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.spherical.phi - dy * 0.005));
      }
      this.updateCamera();
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });

    on('mouseup', (e) => {
      const taken = this.pointerEvent('up', e) || this.pointerTaken;
      this.pointerTaken = false;
      if (!taken && this.downAt && e.button === 0 && this.picking && this.clickListener) {
        if (Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) <= CLICK_DRAG_TOLERANCE) {
          this.clickListener(this.pickAt(e.clientX, e.clientY), { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
        }
      }
      this.downAt = null;
      this.dragging = false;
      this.dragButton = -1;
    });

    on('mouseleave', () => {
      this.dragging = false;
      this.dragButton = -1;
      this.downAt = null;
      this.hoverListener?.(null);
    });

    on(
      'wheel',
      (e) => {
        e.preventDefault();
        this.animFraming = null;
        const radius = Math.max(1, Math.min(1000, this.spherical.radius * (e.deltaY < 0 ? 0.9 : 1.1)));
        if (this.rayAt(e.clientX, e.clientY)) {
          // Zoom toward the cursor: move the target toward the point under it, on the plane through the target.
          const view = new THREE.Vector3();
          this.camera.getWorldDirection(view);
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(view, this.target);
          const point = new THREE.Vector3();
          if (this.raycaster.ray.intersectPlane(plane, point)) {
            this.target.addScaledVector(point.sub(this.target), (1 - radius / this.spherical.radius) * 0.5);
          }
        }
        this.spherical.radius = radius;
        this.updateCamera();
      },
      { passive: false },
    );

    on('contextmenu', (e) => e.preventDefault());
  }
}
