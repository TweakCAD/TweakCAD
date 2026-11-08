/**
 * ViewCube - Orientation indicator cube, a standard CAD navigation aid.
 *
 * Renders a small labeled cube in a corner overlay that:
 *  1. Tracks the main camera rotation
 *  2. Displays face labels (FRONT, BACK, TOP, BOTTOM, LEFT, RIGHT)
 *  3. Highlights on hover
 *  4. Snaps the main camera to standard views on click
 *
 * Uses a dedicated orthographic camera + scene rendered into a corner
 * of the main WebGLRenderer via scissor/viewport.
 */

import * as THREE from 'three';

// ---- Standard view definitions ----

interface StandardView {
  /** Spherical theta (azimuth) */
  theta: number;
  /** Spherical phi (polar) */
  phi: number;
}

/** Map face names to spherical camera angles */
const STANDARD_VIEWS: Record<string, StandardView> = {
  FRONT: { theta: Math.PI / 2, phi: Math.PI / 2 },
  BACK: { theta: -Math.PI / 2, phi: Math.PI / 2 },
  TOP: { theta: Math.PI / 2, phi: 0.001 }, // avoid gimbal at exact 0
  BOTTOM: { theta: Math.PI / 2, phi: Math.PI - 0.001 },
  RIGHT: { theta: 0, phi: Math.PI / 2 },
  LEFT: { theta: Math.PI, phi: Math.PI / 2 },
};

// ---- Colors ----

const FACE_COLOR = 0x4a4a4a;
const FACE_HOVER_COLOR = 0x5a7aaa;
const EDGE_COLOR = 0x333333;
const LABEL_COLOR = '#ffffff';
const LABEL_FONT = 'bold 48px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

// ---- ViewCube class ----

export type ViewCubeClickHandler = (view: StandardView) => void;

export class ViewCube {
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private cubeMeshes: THREE.Mesh[] = [];
  private edgeLines: THREE.LineSegments;
  private raycaster = new THREE.Raycaster();
  private hoveredFace: THREE.Mesh | null = null;

  /** Size in pixels of the viewcube viewport */
  private readonly size: number;
  /** Materials per face (so we can highlight individually) */
  private faceMaterials: THREE.MeshPhongMaterial[] = [];
  /** Map from mesh UUID to face name */
  private meshToFace = new Map<string, string>();

  private onClick: ViewCubeClickHandler | null = null;

  constructor(size = 120) {
    this.size = size;
    this.scene = new THREE.Scene();

    // Orthographic camera looking at the cube from a fixed distance
    const d = 2.5;
    this.camera = new THREE.OrthographicCamera(-d, d, d, -d, 0.1, 100);
    this.camera.position.set(3, 3, 3);
    this.camera.lookAt(0, 0, 0);

    // Lighting for the mini scene
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    this.scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
    dirLight.position.set(3, 5, 4);
    this.scene.add(dirLight);

    // Build the labeled cube faces
    this.buildCube();

    // Build edge outlines
    this.edgeLines = this.buildEdges();
    this.scene.add(this.edgeLines);
  }

  /** Register a callback for when a face is clicked */
  setOnClick(handler: ViewCubeClickHandler): void {
    this.onClick = handler;
  }

  /**
   * Sync the viewcube camera rotation with the main camera.
   * We copy the main camera's quaternion but keep a fixed distance.
   */
  syncRotation(mainCamera: THREE.PerspectiveCamera): void {
    // Place the viewcube camera at a fixed distance, matching main camera's orientation
    const dir = new THREE.Vector3(0, 0, 1);
    dir.applyQuaternion(mainCamera.quaternion);
    this.camera.position.copy(dir.multiplyScalar(5));
    this.camera.quaternion.copy(mainCamera.quaternion);
  }

  /**
   * Render the viewcube into the top-right corner of the given renderer.
   * Must be called after the main scene render (uses scissor test).
   */
  render(renderer: THREE.WebGLRenderer): void {
    // Use getSize which accounts for setSize calls properly
    const renderSize = new THREE.Vector2();
    renderer.getSize(renderSize);
    const pixelRatio = renderer.getPixelRatio();
    const fullW = Math.floor(renderSize.x * pixelRatio);
    const fullH = Math.floor(renderSize.y * pixelRatio);
    const s = Math.floor(this.size * pixelRatio);

    // Position: top-right corner with 8px margin (WebGL y=0 is bottom)
    const margin = Math.floor(8 * pixelRatio);
    const x = fullW - s - margin;
    const y = fullH - s - margin;

    // Save and set state for overlay rendering
    const prevAutoClear = renderer.autoClear;
    const prevScissorTest = renderer.getScissorTest();

    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, s, s);
    renderer.setScissor(x, y, s, s);

    // Clear only the viewcube region
    renderer.setClearColor(0x000000, 0); // transparent
    renderer.clear(true, true, false); // clear color+depth in scissor region only

    // Render viewcube scene
    renderer.render(this.scene, this.camera);

    // Restore full state
    renderer.setScissorTest(prevScissorTest);
    renderer.autoClear = prevAutoClear;
    renderer.setViewport(0, 0, fullW, fullH);
    renderer.setScissor(0, 0, fullW, fullH);
    renderer.setClearColor(0xf0f0f0, 1); // restore main scene clear color
  }

  /**
   * Handle mouse move for hover highlighting.
   * @param clientX - Mouse X relative to canvas
   * @param clientY - Mouse Y relative to canvas
   * @param canvasWidth - Canvas client width
   * @param canvasHeight - Canvas client height
   * @returns true if the mouse is over the viewcube area
   */
  handleMouseMove(clientX: number, clientY: number, canvasWidth: number, _canvasHeight: number): boolean {
    const margin = 8;
    const cubeLeft = canvasWidth - this.size - margin;
    const cubeTop = margin;

    // Check if mouse is within viewcube bounds
    if (clientX < cubeLeft || clientX > cubeLeft + this.size || clientY < cubeTop || clientY > cubeTop + this.size) {
      this.clearHover();
      return false;
    }

    // Convert to NDC within the viewcube viewport
    const localX = clientX - cubeLeft;
    const localY = clientY - cubeTop;
    const ndcX = (localX / this.size) * 2 - 1;
    const ndcY = -(localY / this.size) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const intersects = this.raycaster.intersectObjects(this.cubeMeshes);

    if (intersects.length > 0) {
      const hit = intersects[0]!.object as THREE.Mesh;
      if (hit !== this.hoveredFace) {
        this.clearHover();
        this.hoveredFace = hit;
        const mat = hit.material as THREE.MeshPhongMaterial;
        mat.color.setHex(FACE_HOVER_COLOR);
        mat.needsUpdate = true;
      }
    } else {
      this.clearHover();
    }

    return true;
  }

  /**
   * Handle click. Returns the StandardView if a face was clicked, null otherwise.
   */
  handleClick(clientX: number, clientY: number, canvasWidth: number, _canvasHeight: number): StandardView | null {
    const margin = 8;
    const cubeLeft = canvasWidth - this.size - margin;
    const cubeTop = margin;

    if (clientX < cubeLeft || clientX > cubeLeft + this.size || clientY < cubeTop || clientY > cubeTop + this.size) {
      return null;
    }

    const localX = clientX - cubeLeft;
    const localY = clientY - cubeTop;
    const ndcX = (localX / this.size) * 2 - 1;
    const ndcY = -(localY / this.size) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const intersects = this.raycaster.intersectObjects(this.cubeMeshes);

    if (intersects.length > 0) {
      const hit = intersects[0]!.object as THREE.Mesh;
      const faceName = this.meshToFace.get(hit.uuid);
      if (faceName) {
        const view = STANDARD_VIEWS[faceName];
        if (view) {
          this.onClick?.(view);
          return view;
        }
      }
    }
    return null;
  }

  /** Dispose all resources */
  dispose(): void {
    for (const mesh of this.cubeMeshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.edgeLines.geometry.dispose();
    (this.edgeLines.material as THREE.Material).dispose();
  }

  // ---- Private helpers ----

  private clearHover(): void {
    if (this.hoveredFace) {
      const mat = this.hoveredFace.material as THREE.MeshPhongMaterial;
      mat.color.setHex(FACE_COLOR);
      mat.needsUpdate = true;
      this.hoveredFace = null;
    }
  }

  /**
   * Build 6 separate plane meshes for the cube faces, each with a canvas texture label.
   */
  private buildCube(): void {
    const faceData: { name: string; position: [number, number, number]; rotation: [number, number, number] }[] = [
      { name: 'FRONT', position: [0, 0, 1], rotation: [0, 0, 0] },
      { name: 'BACK', position: [0, 0, -1], rotation: [0, Math.PI, 0] },
      { name: 'TOP', position: [0, 1, 0], rotation: [-Math.PI / 2, 0, 0] },
      { name: 'BOTTOM', position: [0, -1, 0], rotation: [Math.PI / 2, 0, 0] },
      { name: 'RIGHT', position: [1, 0, 0], rotation: [0, Math.PI / 2, 0] },
      { name: 'LEFT', position: [-1, 0, 0], rotation: [0, -Math.PI / 2, 0] },
    ];

    for (const face of faceData) {
      const texture = this.createFaceTexture(face.name);
      const material = new THREE.MeshPhongMaterial({
        map: texture,
        color: FACE_COLOR,
        specular: 0x111111,
        shininess: 10,
      });
      this.faceMaterials.push(material);

      const geometry = new THREE.PlaneGeometry(2, 2);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...face.position);
      mesh.rotation.set(...face.rotation);

      this.meshToFace.set(mesh.uuid, face.name);
      this.cubeMeshes.push(mesh);
      this.scene.add(mesh);
    }
  }

  /**
   * Create a canvas texture with the face label text.
   */
  private createFaceTexture(label: string): THREE.CanvasTexture {
    const res = 256;
    const canvas = document.createElement('canvas');
    canvas.width = res;
    canvas.height = res;
    const ctx = canvas.getContext('2d')!;

    // Background
    ctx.fillStyle = '#606060';
    ctx.fillRect(0, 0, res, res);

    // Subtle border
    ctx.strokeStyle = '#888888';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, res - 4, res - 4);

    // Label
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, res / 2, res / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Build wireframe edge lines around the cube.
   */
  private buildEdges(): THREE.LineSegments {
    const box = new THREE.BoxGeometry(2, 2, 2);
    const edges = new THREE.EdgesGeometry(box);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: EDGE_COLOR, linewidth: 2 }));
    box.dispose();
    return line;
  }
}
