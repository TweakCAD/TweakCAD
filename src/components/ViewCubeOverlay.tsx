/**
 * ViewCubeOverlay - Separate canvas overlay for the orientation cube.
 *
 * Features:
 *  - 6 face selectors (FRONT, BACK, TOP, BOTTOM, LEFT, RIGHT)
 *  - 12 edge selectors (between adjacent faces)
 *  - 8 corner selectors (where 3 faces meet)
 *  - Hover highlighting
 *  - Click to snap camera to standard/edge/corner views
 *  - Completely independent from main viewport (own WebGL renderer)
 */

import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';

interface ViewCubeOverlayProps {
  onViewChange: (theta: number, phi: number) => void;
  getMainCameraQuaternion: () => THREE.Quaternion | null;
  size?: number;
}

// ---- View angle definitions ----
// Spherical coordinates (theta = azimuth around Y, phi = polar from Y+)

const PI = Math.PI;
const HALF = PI / 2;
const QUARTER = PI / 4;

// THREE.Spherical(radius, phi, theta):
//   theta = azimuth from +Z axis around Y axis (theta=0 => camera on +Z looking at -Z)
//   phi   = polar angle from Y+ (phi=0 => top, phi=PI/2 => equator, phi=PI => bottom)
//
// FRONT face is at z=+S. Camera on +Z (theta=0) looks at origin => sees FRONT.
// RIGHT face is at x=+S. Camera on +X (theta=PI/2) looks at origin => sees RIGHT.

const VIEWS: Record<string, { theta: number; phi: number }> = {
  // Faces
  FRONT:  { theta: 0,        phi: HALF },
  BACK:   { theta: PI,       phi: HALF },
  TOP:    { theta: 0,        phi: 0.001 },
  BOTTOM: { theta: 0,        phi: PI - 0.001 },
  RIGHT:  { theta: HALF,     phi: HALF },
  LEFT:   { theta: -HALF,    phi: HALF },
  // Edges (between two adjacent faces)
  'FRONT-TOP':    { theta: 0,        phi: QUARTER },
  'FRONT-BOTTOM': { theta: 0,        phi: PI - QUARTER },
  'FRONT-RIGHT':  { theta: QUARTER,  phi: HALF },
  'FRONT-LEFT':   { theta: -QUARTER, phi: HALF },
  'BACK-TOP':     { theta: PI,       phi: QUARTER },
  'BACK-BOTTOM':  { theta: PI,       phi: PI - QUARTER },
  'BACK-RIGHT':   { theta: HALF + QUARTER, phi: HALF },
  'BACK-LEFT':    { theta: -(HALF + QUARTER), phi: HALF },
  'TOP-RIGHT':    { theta: HALF,     phi: QUARTER },
  'TOP-LEFT':     { theta: -HALF,    phi: QUARTER },
  'BOTTOM-RIGHT': { theta: HALF,     phi: PI - QUARTER },
  'BOTTOM-LEFT':  { theta: -HALF,    phi: PI - QUARTER },
  // Corners (where 3 faces meet)
  'FRONT-TOP-RIGHT':    { theta: QUARTER,             phi: QUARTER + 0.15 },
  'FRONT-TOP-LEFT':     { theta: -QUARTER,            phi: QUARTER + 0.15 },
  'FRONT-BOTTOM-RIGHT': { theta: QUARTER,             phi: PI - QUARTER - 0.15 },
  'FRONT-BOTTOM-LEFT':  { theta: -QUARTER,            phi: PI - QUARTER - 0.15 },
  'BACK-TOP-RIGHT':     { theta: HALF + QUARTER,      phi: QUARTER + 0.15 },
  'BACK-TOP-LEFT':      { theta: -(HALF + QUARTER),   phi: QUARTER + 0.15 },
  'BACK-BOTTOM-RIGHT':  { theta: HALF + QUARTER,      phi: PI - QUARTER - 0.15 },
  'BACK-BOTTOM-LEFT':   { theta: -(HALF + QUARTER),   phi: PI - QUARTER - 0.15 },
};

// ---- Colors ----

const FACE_COLOR = 0xffffff;
const HOVER_COLOR = 0xaaddff;
const EDGE_NORMAL_COLOR = 0xe8e8e8;
const CORNER_NORMAL_COLOR = 0xdddddd;
const LABEL_COLOR = '#444444';

export function ViewCubeOverlay({ onViewChange, getMainCameraQuaternion, size = 112 }: ViewCubeOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
    allHitTargets: THREE.Mesh[];  // faces + edges + corners for raycasting
    meshToView: Map<string, string>;
    hoveredMesh: THREE.Mesh | null;
    hoveredOrigColor: number;
    raycaster: THREE.Raycaster;
    disposed: boolean;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(size, size);
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const d = 2.5;
    const camera = new THREE.OrthographicCamera(-d, d, d, -d, 0.1, 100);
    camera.position.set(3, 3, 3);
    camera.lookAt(0, 0, 0);

    // Lighting (still needed for ambient illumination on basic materials? no, but keeping ambient for potential future use)
    scene.add(new THREE.AmbientLight(0xffffff, 1.0));

    const allHitTargets: THREE.Mesh[] = [];
    const meshToView = new Map<string, string>();

    // Cube half-size
    const S = 1.0;
    // Edge/corner element thickness
    const E = 0.15;

    // ---- Build 6 faces ----
    const faceData: { name: string; pos: [number, number, number]; rot: [number, number, number] }[] = [
      { name: 'FRONT',  pos: [0, 0, S],   rot: [0, 0, 0] },
      { name: 'BACK',   pos: [0, 0, -S],  rot: [0, PI, 0] },
      { name: 'TOP',    pos: [0, S, 0],   rot: [-HALF, 0, 0] },
      { name: 'BOTTOM', pos: [0, -S, 0],  rot: [HALF, 0, 0] },
      { name: 'RIGHT',  pos: [S, 0, 0],   rot: [0, HALF, 0] },
      { name: 'LEFT',   pos: [-S, 0, 0],  rot: [0, -HALF, 0] },
    ];

    const faceSize = S * 2 - E * 2; // face slightly smaller than full to leave room for edges
    for (const face of faceData) {
      const texture = createFaceTexture(face.name);
      const material = new THREE.MeshBasicMaterial({ map: texture, color: FACE_COLOR });
      const geometry = new THREE.PlaneGeometry(faceSize, faceSize);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...face.pos);
      mesh.rotation.set(...face.rot);
      meshToView.set(mesh.uuid, face.name);
      allHitTargets.push(mesh);
      scene.add(mesh);
    }

    // ---- Build 12 edges ----
    // Each edge is a thin box along one cube edge
    const edgeLen = S * 2 - E * 2;
    const edgeGeo = new THREE.BoxGeometry(edgeLen, E, E);
    const edgeDefs: { name: string; pos: [number, number, number]; rotZ: number; rotY: number }[] = [
      // Top edges (y = S)
      { name: 'FRONT-TOP',    pos: [0, S, S],    rotZ: 0, rotY: 0 },
      { name: 'BACK-TOP',     pos: [0, S, -S],   rotZ: 0, rotY: 0 },
      { name: 'TOP-RIGHT',    pos: [S, S, 0],    rotZ: 0, rotY: HALF },
      { name: 'TOP-LEFT',     pos: [-S, S, 0],   rotZ: 0, rotY: HALF },
      // Bottom edges (y = -S)
      { name: 'FRONT-BOTTOM', pos: [0, -S, S],   rotZ: 0, rotY: 0 },
      { name: 'BACK-BOTTOM',  pos: [0, -S, -S],  rotZ: 0, rotY: 0 },
      { name: 'BOTTOM-RIGHT', pos: [S, -S, 0],   rotZ: 0, rotY: HALF },
      { name: 'BOTTOM-LEFT',  pos: [-S, -S, 0],  rotZ: 0, rotY: HALF },
      // Vertical edges
      { name: 'FRONT-RIGHT',  pos: [S, 0, S],    rotZ: HALF, rotY: 0 },
      { name: 'FRONT-LEFT',   pos: [-S, 0, S],   rotZ: HALF, rotY: 0 },
      { name: 'BACK-RIGHT',   pos: [S, 0, -S],   rotZ: HALF, rotY: 0 },
      { name: 'BACK-LEFT',    pos: [-S, 0, -S],  rotZ: HALF, rotY: 0 },
    ];

    for (const edge of edgeDefs) {
      const material = new THREE.MeshBasicMaterial({ color: EDGE_NORMAL_COLOR });
      const mesh = new THREE.Mesh(edgeGeo, material);
      mesh.position.set(...edge.pos);
      mesh.rotation.set(0, edge.rotY, edge.rotZ);
      meshToView.set(mesh.uuid, edge.name);
      allHitTargets.push(mesh);
      scene.add(mesh);
    }

    // ---- Build 8 corners ----
    const cornerGeo = new THREE.BoxGeometry(E, E, E);
    const cornerDefs: { name: string; pos: [number, number, number] }[] = [
      { name: 'FRONT-TOP-RIGHT',    pos: [S, S, S] },
      { name: 'FRONT-TOP-LEFT',     pos: [-S, S, S] },
      { name: 'FRONT-BOTTOM-RIGHT', pos: [S, -S, S] },
      { name: 'FRONT-BOTTOM-LEFT',  pos: [-S, -S, S] },
      { name: 'BACK-TOP-RIGHT',     pos: [S, S, -S] },
      { name: 'BACK-TOP-LEFT',      pos: [-S, S, -S] },
      { name: 'BACK-BOTTOM-RIGHT',  pos: [S, -S, -S] },
      { name: 'BACK-BOTTOM-LEFT',   pos: [-S, -S, -S] },
    ];

    for (const corner of cornerDefs) {
      const material = new THREE.MeshBasicMaterial({ color: CORNER_NORMAL_COLOR });
      const mesh = new THREE.Mesh(cornerGeo, material);
      mesh.position.set(...corner.pos);
      meshToView.set(mesh.uuid, corner.name);
      allHitTargets.push(mesh);
      scene.add(mesh);
    }

    // ---- Edge wireframe ----
    const boxGeo = new THREE.BoxGeometry(S * 2, S * 2, S * 2);
    const edgeLines = new THREE.EdgesGeometry(boxGeo);
    scene.add(new THREE.LineSegments(edgeLines, new THREE.LineBasicMaterial({ color: 0xbbbbbb })));
    boxGeo.dispose();

    // ---- Axis indicator: colored arrows + X/Y/Z letters ----
    // A triad emanating from the cube's back-bottom-left corner along the
    // world +X/+Y/+Z axes. Each axis is an ArrowHelper (so it gets a real
    // arrowhead) plus a bold letter sprite at the tip, in bright R/G/B. The
    // previous version drew thin, dull, headless lines that were nearly
    // invisible against the viewport; arrowheads + letters fix that.
    const axisOrigin = new THREE.Vector3(-S, -S, -S);
    const axisLen = 2 * S + 0.55; // crosses the cube and pokes ~0.55 past the far face
    const headLen = 0.34;
    const headWidth = 0.22;
    const axisDisposables: (THREE.ArrowHelper | THREE.Sprite)[] = [];

    // Draw the triad always-on-top: with depth-testing on, the segment of
    // each axis that passes through the cube is occluded, so only the
    // protruding stubs show. Disabling depthTest makes the full axis lie
    // tangentially along the cube's near edges and exit with its arrowhead —
    // the whole line stays visible regardless of orientation.
    const onTop = (mat: THREE.Material) => {
      mat.depthTest = false;
      mat.depthWrite = false;
      mat.transparent = true;
    };

    const makeAxis = (dir: THREE.Vector3, colorHex: number, letter: string, letterColor: string) => {
      const arrow = new THREE.ArrowHelper(dir, axisOrigin, axisLen, colorHex, headLen, headWidth);
      onTop(arrow.line.material as THREE.Material);
      onTop(arrow.cone.material as THREE.Material);
      arrow.line.renderOrder = 10;
      arrow.cone.renderOrder = 10;
      scene.add(arrow);
      axisDisposables.push(arrow);

      const sprite = makeAxisLabel(letter, letterColor);
      sprite.position.copy(axisOrigin).addScaledVector(dir, axisLen + 0.28);
      sprite.renderOrder = 11;
      scene.add(sprite);
      axisDisposables.push(sprite);
    };

    makeAxis(new THREE.Vector3(1, 0, 0), 0xff4444, 'X', '#ff5252');
    makeAxis(new THREE.Vector3(0, 1, 0), 0x2ecc40, 'Y', '#36d04a');
    makeAxis(new THREE.Vector3(0, 0, 1), 0x4488ff, 'Z', '#5a9bff');

    const state = {
      renderer,
      scene,
      camera,
      allHitTargets,
      meshToView,
      hoveredMesh: null as THREE.Mesh | null,
      hoveredOrigColor: 0,
      raycaster: new THREE.Raycaster(),
      disposed: false,
    };
    stateRef.current = state;

    // Animation loop
    let frameId = 0;
    const animate = () => {
      if (state.disposed) return;
      frameId = requestAnimationFrame(animate);

      const quat = getMainCameraQuaternion();
      if (quat) {
        const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
        camera.position.copy(dir.multiplyScalar(5));
        camera.quaternion.copy(quat);
      }

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      state.disposed = true;
      cancelAnimationFrame(frameId);
      renderer.dispose();
      edgeGeo.dispose();
      cornerGeo.dispose();
      for (const mesh of allHitTargets) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      for (const obj of axisDisposables) {
        if (obj instanceof THREE.ArrowHelper) {
          obj.line.geometry.dispose();
          (obj.line.material as THREE.Material).dispose();
          obj.cone.geometry.dispose();
          (obj.cone.material as THREE.Material).dispose();
        } else {
          const mat = obj.material as THREE.SpriteMaterial;
          mat.map?.dispose();
          mat.dispose();
        }
      }
    };
  }, [size, getMainCameraQuaternion]);

  // ---- Hover ----
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const state = stateRef.current;
    if (!state) return;

    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    state.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), state.camera);
    const hits = state.raycaster.intersectObjects(state.allHitTargets);

    // Clear previous hover
    if (state.hoveredMesh) {
      (state.hoveredMesh.material as THREE.MeshBasicMaterial).color.setHex(state.hoveredOrigColor);
      state.hoveredMesh = null;
    }

    if (hits.length > 0) {
      const mesh = hits[0]!.object as THREE.Mesh;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      state.hoveredOrigColor = mat.color.getHex();
      mat.color.setHex(HOVER_COLOR);
      state.hoveredMesh = mesh;
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    const state = stateRef.current;
    if (!state || !state.hoveredMesh) return;
    (state.hoveredMesh.material as THREE.MeshBasicMaterial).color.setHex(state.hoveredOrigColor);
    state.hoveredMesh = null;
  }, []);

  // ---- Click ----
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const state = stateRef.current;
    if (!state) return;

    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    state.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), state.camera);
    const hits = state.raycaster.intersectObjects(state.allHitTargets);

    if (hits.length > 0) {
      const mesh = hits[0]!.object as THREE.Mesh;
      const viewName = state.meshToView.get(mesh.uuid);
      if (viewName) {
        const view = VIEWS[viewName];
        if (view) {
          onViewChange(view.theta, view.phi);
        }
      }
    }
  }, [onViewChange]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        width: size,
        height: size,
        cursor: 'pointer',
        zIndex: 20,
        pointerEvents: 'auto',
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
    />
  );
}

// ---- Helper ----

function createFaceTexture(label: string): THREE.CanvasTexture {
  const res = 256;
  const canvas = document.createElement('canvas');
  canvas.width = res;
  canvas.height = res;
  const ctx = canvas.getContext('2d')!;

  // Very light face background
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, res, res);

  // Subtle border
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, res - 4, res - 4);

  // Dark text label
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = 'bold 44px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, res / 2, res / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * A billboarded letter (X/Y/Z) for the axis indicator. Drawn on a small
 * canvas as a colored glyph with a faint dark outline so it stays legible
 * over both the light viewport and the white cube faces.
 */
function makeAxisLabel(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 96;
  const ctx = c.getContext('2d')!;
  // Thin (normal-weight) glyph, no outline — a halo stroke reads as a
  // blurry "double edge" at this size. A single clean colored fill keeps
  // the letters as crisp and thin as the axis lines.
  ctx.font = '60px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, 48, 51);

  const texture = new THREE.CanvasTexture(c);
  texture.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.64, 0.64, 1);
  return sprite;
}
