/**
 * The three.js drawing of a sketch being edited, in the host's group: curves
 * (construction ones dashed), points, closed regions shaded faintly (a picked
 * or hovered one stronger), the
 * preview of the tool in progress, snap markers, constraint glyphs, and
 * selection and hover, each in its own colour and line weight.
 *
 * Everything is drawn in sketch coordinates under one group placed by the
 * sketch frame. Points and markers keep a constant size on screen; they
 * size themselves from the renderer and camera as they are drawn. Constraint
 * glyphs are HTML over the viewport (`ConstraintGlyphs`), so they can be
 * clicked.
 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { cyclePolyline, type Detection } from '@tweakcad/format';
import type { FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import type { SketchGeometry } from './geometry';
import { STANDARD_IDS, type P2 } from './rows';
import type { SketchOptions } from './session';
import { regionId } from './regionPick';
import type { Snap } from './snap';

export const COLORS = {
  line: 0x3b82f6,
  lineFullyDefined: 0x1f2937,
  origin: 0xf97316,
  construction: 0x94a3b8,
  selected: 0xf59e0b,
  hovered: 0xef4444,
  region: 0x93c5fd,
  regionSelected: 0xfbbf24,
  regionHovered: 0xfca5a5,
  preview: 0x22c55e,
  snapPoint: 0xff7a00,
  snapMidpoint: 0x8b5cf6,
  snapGrid: 0x22c55e,
  point: 0xffffff,
  pointStroke: 0x3b82f6,
  gridMinor: 0xe0e0e0,
  gridXAxis: 0xef4444,
  gridYAxis: 0x22c55e,
  box: 0x3b82f6,
};

const LINE_WIDTH = 0.8;
const POINT_SIZE = 8;
const SELECTED_POINT_SIZE = 10;
const ORIGIN_POINT_SIZE = 11;
const MARKER_PIXELS = 14;
const HINT_PIXELS = 18;
/** Lifts above the plane, so the drawing does not fight a face lying in it. */
const LIFT = { region: 0.005, curve: 0.01, point: 0.02 };
const CIRCLE_SEGMENTS = 64;

export type PreviewShape =
  | { kind: 'polyline'; points: P2[] }
  | { kind: 'circle'; center: P2; radius: number }
  | { kind: 'arc'; center: P2; radius: number; from: P2; to: P2 }
  | { kind: 'box'; from: P2; to: P2; crossing: boolean };

export interface DrawingView {
  geometry: SketchGeometry;
  selection: ReadonlySet<string>;
  /** What draws as hovered: the entity under the pointer, or the geometry of a constraint row hovered in the browser. */
  hover: ReadonlySet<string>;
  options: SketchOptions;
  /** No degrees of freedom left: curves draw near-black. */
  fullyDefined: boolean;
  detection: Detection | null;
  preview: PreviewShape[];
  snap: Snap | null;
  /** The horizontal or vertical constraint a line in progress will get. */
  hint: { kind: 'horizontal' | 'vertical'; at: P2 } | null;
  gridSpacing: number;
  /** Glyph contours of the sketch's text, by text row. */
  glyphs: { text: string; polyline: P2[] }[];
}

const resolution = new THREE.Vector2(1, 1);
const sizeNow = new THREE.Vector2();

function makeLineMaterial(color: number, dashed = false, dash = 1): LineMaterial {
  return new LineMaterial({ color, linewidth: LINE_WIDTH, resolution, dashed, dashSize: dash, gapSize: 1 });
}

/** A texture of a small rounded badge, or null where there is no canvas (tests). */
function badge(symbol: string, fg: string, bg: string, border: string): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const size = 64;
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = bg;
  g.strokeStyle = border;
  g.lineWidth = 4;
  g.beginPath();
  g.roundRect(4, 4, size - 8, size - 8, 10);
  g.fill();
  g.stroke();
  g.strokeStyle = fg;
  g.fillStyle = fg;
  g.lineWidth = 5;
  if (symbol === 'ring' || symbol === 'square') {
    g.clearRect(0, 0, size, size);
    g.strokeStyle = fg;
    g.lineWidth = 7;
    if (symbol === 'ring') {
      g.beginPath();
      g.arc(32, 32, 22, 0, 2 * Math.PI);
      g.stroke();
    } else g.strokeRect(12, 12, 40, 40);
  } else {
    g.font = 'bold 38px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(symbol, 32, 34);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const textures = new Map<string, THREE.Texture | null>();
function cachedBadge(key: string, make: () => THREE.Texture | null): THREE.Texture | null {
  if (!textures.has(key)) textures.set(key, make());
  return textures.get(key) ?? null;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** A sprite that keeps `pixels` of height on screen, `center` giving where it sits against its position. */
function pixelSprite(
  texture: THREE.Texture | null,
  pixels: number,
  center: [number, number] = [0.5, 0.5],
): THREE.Sprite {
  const material = new THREE.SpriteMaterial({
    map: texture,
    depthTest: false,
    depthWrite: false,
    sizeAttenuation: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(center[0], center[1]);
  sprite.renderOrder = 1200;
  sprite.onBeforeRender = (renderer, _scene, camera) => {
    renderer.getSize(sizeNow);
    // Without size attenuation a sprite's height in clip space is its scale times the projection's y factor.
    const s = (2 * pixels) / ((camera.projectionMatrix.elements[5] ?? 1) * Math.max(1, sizeNow.y));
    if (sprite.scale.y !== s) {
      sprite.scale.set(s, s, 1);
      sprite.updateMatrixWorld();
    }
  };
  return sprite;
}

const POINT_VERTEX = `
attribute vec3 fill;
attribute vec3 stroke;
attribute float size;
uniform float pixelRatio;
varying vec3 vFill;
varying vec3 vStroke;
void main() {
  vFill = fill;
  vStroke = stroke;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * pixelRatio;
}`;

const POINT_FRAGMENT = `
varying vec3 vFill;
varying vec3 vStroke;
void main() {
  float r = length(gl_PointCoord * 2.0 - 1.0);
  if (r > 1.0) discard;
  gl_FragColor = vec4(r > 0.62 ? vStroke : vFill, 1.0);
}`;

export class SketchDrawing {
  /** Sketch coordinates to part coordinates. */
  readonly root = new THREE.Group();
  private readonly materials = {
    line: makeLineMaterial(COLORS.line),
    construction: makeLineMaterial(COLORS.construction, true, 1),
    selected: makeLineMaterial(COLORS.selected),
    hovered: makeLineMaterial(COLORS.hovered),
    preview: makeLineMaterial(COLORS.preview, true, 1.5),
    box: makeLineMaterial(COLORS.box),
    crossing: makeLineMaterial(COLORS.preview, true, 1.5),
  };
  private readonly pointMaterial = new THREE.ShaderMaterial({
    uniforms: { pixelRatio: { value: 1 } },
    vertexShader: POINT_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });

  constructor(
    private readonly group: THREE.Group,
    frame: FrameDisplay,
  ) {
    this.root.name = 'SketchSession';
    this.root.renderOrder = 999;
    const { origin: o, x, y, normal: n } = frame;
    this.root.matrix.set(x[0], y[0], n[0], o[0], x[1], y[1], n[1], o[1], x[2], y[2], n[2], o[2], 0, 0, 0, 1);
    this.root.matrixAutoUpdate = false;
    this.root.matrixWorldNeedsUpdate = true;
    group.add(this.root);
  }

  /** Redraws everything from `view`. */
  update(view: DrawingView): void {
    this.clear();
    const { geometry, options } = view;
    this.materials.line.color.setHex(view.fullyDefined ? COLORS.lineFullyDefined : COLORS.line);
    if (options.grid) this.drawGrid(geometry, view.gridSpacing);
    if (options.profile && view.detection) this.drawRegions(view.detection, view);
    for (const c of geometry.curves.values()) {
      if (c.kind === 'point' || c.polyline.length < 2) continue;
      if (c.construction && !options.construction) continue;
      const material = view.selection.has(c.id)
        ? this.materials.selected
        : view.hover.has(c.id)
          ? this.materials.hovered
          : c.construction
            ? this.materials.construction
            : this.materials.line;
      this.root.add(this.line(c.polyline, material, LIFT.curve));
    }
    for (const g of view.glyphs) {
      const material = view.selection.has(g.text)
        ? this.materials.selected
        : view.hover.has(g.text)
          ? this.materials.hovered
          : this.materials.line;
      if (g.polyline.length >= 2) this.root.add(this.line(g.polyline, material, LIFT.curve));
    }
    for (const axis of [STANDARD_IDS.x, STANDARD_IDS.y]) {
      const material = view.selection.has(axis)
        ? this.materials.selected
        : view.hover.has(axis)
          ? this.materials.hovered
          : null;
      const reach = 1e4;
      if (material)
        this.root.add(
          this.line(
            axis === STANDARD_IDS.x
              ? [
                  [-reach, 0],
                  [reach, 0],
                ]
              : [
                  [0, -reach],
                  [0, reach],
                ],
            material,
            LIFT.curve,
          ),
        );
    }
    for (const shape of view.preview) this.drawPreview(shape);
    this.drawPoints(view);
    if (view.snap && view.snap.kind !== 'none') this.drawSnap(view.snap);
    if (view.hint) {
      const tex = cachedBadge(`hint:${view.hint.kind}`, () =>
        badge(view.hint?.kind === 'horizontal' ? 'H' : 'V', '#ffffff', '#3b82f6', '#1a4cc7'),
      );
      const chip = pixelSprite(tex, HINT_PIXELS, [-0.4, -0.4]);
      chip.name = 'hint';
      chip.position.set(view.hint.at[0], view.hint.at[1], LIFT.point);
      this.root.add(chip);
    }
  }

  /** Removes everything drawn. */
  clear(): void {
    for (const child of [...this.root.children]) {
      this.root.remove(child);
      child.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        // Shared materials stay; per-object ones (regions, sprites, grid) go with their object.
        if (material && !Array.isArray(material) && !this.isShared(material)) material.dispose();
      });
    }
  }

  dispose(): void {
    this.clear();
    this.group.remove(this.root);
    for (const m of Object.values(this.materials)) m.dispose();
    this.pointMaterial.dispose();
  }

  private isShared(material: THREE.Material): boolean {
    return material === this.pointMaterial || Object.values(this.materials).includes(material as LineMaterial);
  }

  private line(points: readonly P2[], material: LineMaterial, z: number): Line2 {
    const positions: number[] = [];
    for (const p of points) positions.push(p[0], p[1], z);
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    const line = new Line2(geometry, material);
    line.computeLineDistances();
    line.renderOrder = 1000;
    line.onBeforeRender = (renderer) => {
      renderer.getSize(sizeNow);
      if (!material.resolution.equals(sizeNow)) material.resolution.copy(sizeNow);
    };
    return line;
  }

  private drawGrid(geometry: SketchGeometry, spacing: number): void {
    let [x0, y0, x1, y1] = [-100, -100, 100, 100];
    for (const p of geometry.points.values()) {
      x0 = Math.min(x0, p[0] - spacing * 2);
      y0 = Math.min(y0, p[1] - spacing * 2);
      x1 = Math.max(x1, p[0] + spacing * 2);
      y1 = Math.max(y1, p[1] + spacing * 2);
    }
    let step = spacing;
    while ((x1 - x0) / step > 200 || (y1 - y0) / step > 200) step *= 10;
    [x0, y0] = [Math.floor(x0 / step) * step, Math.floor(y0 / step) * step];
    [x1, y1] = [Math.ceil(x1 / step) * step, Math.ceil(y1 / step) * step];
    const minor: number[] = [];
    for (let x = x0; x <= x1 + 1e-9; x += step) if (Math.abs(x) > 1e-9) minor.push(x, y0, 0, x, y1, 0);
    for (let y = y0; y <= y1 + 1e-9; y += step) if (Math.abs(y) > 1e-9) minor.push(x0, y, 0, x1, y, 0);
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(minor, 3)),
      new THREE.LineBasicMaterial({ color: COLORS.gridMinor, transparent: true, opacity: 0.5 }),
    );
    grid.renderOrder = 998;
    this.root.add(grid);
    const axis = (points: number[], color: number) => {
      const line = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3)),
        new THREE.LineBasicMaterial({ color }),
      );
      line.renderOrder = 998;
      this.root.add(line);
    };
    axis([x0, 0, 0, x1, 0, 0], COLORS.gridXAxis);
    axis([0, y0, 0, 0, y1, 0], COLORS.gridYAxis);
  }

  private drawRegions(detection: Detection, view: DrawingView): void {
    detection.regions.forEach((region, i) => {
      const id = regionId(i);
      const [color, opacity] = view.selection.has(id)
        ? [COLORS.regionSelected, 0.32]
        : view.hover.has(id)
          ? [COLORS.regionHovered, 0.24]
          : [COLORS.region, 0.14];
      const outline = (cycle: (typeof region)['outer']) =>
        cyclePolyline(detection.arrangement, cycle, 1).map((p) => new THREE.Vector2(p[0], p[1]));
      const outer = outline(region.outer);
      if (outer.length < 3) return;
      const shape = new THREE.Shape(outer);
      for (const hole of region.inner) {
        const h = outline(hole);
        if (h.length >= 3) shape.holes.push(new THREE.Path(h));
      }
      const mesh = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.position.z = LIFT.region;
      mesh.renderOrder = 999;
      this.root.add(mesh);
    });
  }

  private drawPreview(shape: PreviewShape): void {
    const ring = (center: P2, radius: number, a0: number, sweep: number): P2[] => {
      const n = Math.max(16, Math.ceil((CIRCLE_SEGMENTS * sweep) / (2 * Math.PI)));
      return Array.from({ length: n + 1 }, (_, i) => {
        const t = a0 + (sweep * i) / n;
        return [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)] as P2;
      });
    };
    switch (shape.kind) {
      case 'polyline':
        this.root.add(this.line(shape.points, this.materials.preview, LIFT.curve));
        return;
      case 'circle':
        if (shape.radius > 0)
          this.root.add(
            this.line(ring(shape.center, shape.radius, 0, 2 * Math.PI), this.materials.preview, LIFT.curve),
          );
        return;
      case 'arc': {
        const a0 = Math.atan2(shape.from[1] - shape.center[1], shape.from[0] - shape.center[0]);
        const a1 = Math.atan2(shape.to[1] - shape.center[1], shape.to[0] - shape.center[0]);
        const sweep = (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        this.root.add(this.line(ring(shape.center, shape.radius, a0, sweep), this.materials.preview, LIFT.curve));
        return;
      }
      case 'box': {
        const [a, b] = [shape.from, shape.to];
        const corners: P2[] = [a, [b[0], a[1]], b, [a[0], b[1]], a];
        this.root.add(this.line(corners, shape.crossing ? this.materials.crossing : this.materials.box, LIFT.point));
        return;
      }
    }
  }

  private drawPoints(view: DrawingView): void {
    const { geometry } = view;
    const positions: number[] = [];
    const fills: number[] = [];
    const strokes: number[] = [];
    const sizes: number[] = [];
    const color = new THREE.Color();
    const push = (p: P2, fill: number, stroke: number, size: number) => {
      positions.push(p[0], p[1], LIFT.point);
      color.setHex(fill);
      fills.push(color.r, color.g, color.b);
      color.setHex(stroke);
      strokes.push(color.r, color.g, color.b);
      sizes.push(size);
    };
    const pointCurves = new Map<string, string>();
    for (const c of geometry.curves.values()) if (c.kind === 'point') pointCurves.set(c.row.at as string, c.id);
    const origin = view.selection.has(STANDARD_IDS.origin)
      ? COLORS.selected
      : view.hover.has(STANDARD_IDS.origin)
        ? COLORS.hovered
        : COLORS.origin;
    push([0, 0], origin, origin, ORIGIN_POINT_SIZE);
    for (const [id, p] of geometry.points) {
      if (!geometry.used.has(id)) continue;
      const curve = pointCurves.get(id);
      if (!view.options.points && !curve) continue;
      const selected = view.selection.has(id) || (curve !== undefined && view.selection.has(curve));
      const hovered = view.hover.has(id) || (curve !== undefined && view.hover.has(curve));
      if (selected) push(p, COLORS.selected, COLORS.selected, SELECTED_POINT_SIZE);
      else if (hovered) push(p, COLORS.hovered, COLORS.hovered, POINT_SIZE);
      else push(p, COLORS.point, view.fullyDefined ? COLORS.lineFullyDefined : COLORS.pointStroke, POINT_SIZE);
    }
    if (positions.length === 0) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('fill', new THREE.Float32BufferAttribute(fills, 3));
    g.setAttribute('stroke', new THREE.Float32BufferAttribute(strokes, 3));
    g.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
    const points = new THREE.Points(g, this.pointMaterial);
    points.renderOrder = 1001;
    points.frustumCulled = false;
    points.onBeforeRender = (renderer) => {
      const uniform = this.pointMaterial.uniforms.pixelRatio;
      if (uniform) uniform.value = renderer.getPixelRatio();
    };
    this.root.add(points);
  }

  private drawSnap(snap: Snap): void {
    const [symbol, color] =
      snap.kind === 'midpoint'
        ? ['square', COLORS.snapMidpoint]
        : snap.kind === 'grid'
          ? ['ring', COLORS.snapGrid]
          : snap.kind === 'axisX'
            ? ['ring', COLORS.gridXAxis]
            : snap.kind === 'axisY'
              ? ['ring', COLORS.gridYAxis]
              : ['ring', COLORS.snapPoint];
    const tex = cachedBadge(`snap:${symbol}:${color}`, () =>
      badge(symbol, hex(color), 'rgba(0,0,0,0)', 'rgba(0,0,0,0)'),
    );
    const marker = pixelSprite(tex, MARKER_PIXELS);
    marker.name = 'snap';
    marker.position.set(snap.at[0], snap.at[1], LIFT.point);
    this.root.add(marker);
  }
}
