/**
 * The three.js content of a display: the shown part's bodies (with face
 * styles and edges), sketches (curves, points, translucent regions) and
 * construction outputs, and cosmetic threads drawn over their faces, or
 * for an assembly each instance's part at its placement; plus the three
 * standard planes. It also answers picks against
 * that content and draws the selection and hover.
 *
 * Coordinates are the part's (or the assembly's): the scene is not rotated.
 * Nothing here needs a renderer, so it is tested in Node.
 */
import * as THREE from 'three';
import type {
  BodyDisplay,
  BodyMesh,
  ConstructionDisplay,
  DefinitionDisplay,
  Display,
  FrameDisplay,
  InstanceDisplay,
  Key,
  SketchDisplay,
  Style,
  ThreadDisplay,
  Vec3,
} from '@tweakcad/worker/src/v2/service/types';
import { edgeAt, faceAt, matrixOf } from '@tweakcad/worker/src/v2/service/picking';
import {
  STANDARD_DATUMS,
  STANDARD_PLANES,
  sameItem,
  type InstanceRef,
  type SelectionItem,
  type StandardDatum,
  type StandardPlane,
} from '../selection';
import { disposeOverlays, overlayFor, parentOf, type Drawn } from './highlight';
import { setThreadLook, threadOverlay } from './threadOverlay';
import {
  CONSTRUCTION_FILL,
  CONSTRUCTION_OPACITY,
  CONSTRUCTION_OUTLINE,
  CONSTRUCTION_PLANE_SIZE,
  DEFAULT_BODY_COLOR,
  EDGE_COLOR,
  GHOST_OPACITY,
  HIGHLIGHT_GLOW,
  EDGE_PICK_PIXELS,
  ORDER,
  PICK_PIXELS,
  PRESELECTION,
  SELECTED_EDGE_COLOR,
  SELECTION,
  SKETCH_CONSTRUCTION,
  SKETCH_LIFT,
  SKETCH_LINE,
  SKETCH_REGION,
  SKETCH_REGION_OPACITY,
  STANDARD_PLANE_OPACITY,
  STANDARD_PLANE_SIZE,
  type HighlightStyle,
} from './style';

/** Render order of the section cap's stencil passes; the cap draws after them. */
export const SECTION_STENCIL_ORDER = 1;

/**
 * Section-cap stencil passes: while a section cuts the bodies, each body
 * mesh gets two invisible children sharing its geometry. Back faces add
 * one to the stencil, front faces take one away; where the cut plane goes
 * through solid material the count is not zero, and the cap (stencil test
 * not equal 0) fills it.
 */
function stencilMaterial(side: THREE.Side, op: THREE.StencilOp): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    side,
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: op,
    stencilZFail: op,
    stencilZPass: op,
  });
}

/** How see-through the other instances draw while one part is edited in its assembly's context. */
const FADED_OPACITY = 0.3;

/** What a pick can land on. */
export type PickKind = 'face' | 'edge' | 'sketchCurve' | 'sketchPoint' | 'region' | 'construction' | 'standard';

export const ALL_PICKS: ReadonlySet<PickKind> = new Set<PickKind>([
  'face',
  'edge',
  'sketchCurve',
  'sketchPoint',
  'region',
  'construction',
  'standard',
]);

/** What the document shows: one of its parts, one of its assemblies, or nothing. */
export type ShownRoot = { part: string } | { assembly: string } | null;

/** The standard planes as the format defines them (9.1): right-handed, normal = x × y. */
export const STANDARD_FRAMES: Record<StandardPlane, FrameDisplay> = {
  xy: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] },
  xz: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, -1], normal: [0, 1, 0] },
  yz: { origin: [0, 0, 0], x: [0, 0, -1], y: [0, 1, 0], normal: [1, 0, 0] },
};

const STANDARD_COLORS: Record<StandardPlane, number> = { xy: 0x3b82f6, xz: 0x22c55e, yz: 0xef4444 };
/** The standard axes in the colours of the planes they are normal to; the origin point grey. */
export const DATUM_COLORS: Record<StandardDatum, number> = { x: 0xef4444, y: 0x22c55e, z: 0x3b82f6, origin: 0x888888 };
const DATUM_DIRECTIONS: Record<Exclude<StandardDatum, 'origin'>, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** What a pickable object is, kept in its `userData.pick`. */
type PickTag =
  | { kind: 'face'; mesh: BodyMesh; instance?: InstanceRef }
  | { kind: 'edge'; mesh: BodyMesh; instance?: InstanceRef }
  | { kind: 'sketchCurve' | 'region' | 'construction'; key: Key; instance?: InstanceRef }
  | { kind: 'sketchPoint'; keys: Key[]; instance?: InstanceRef }
  | { kind: 'standard'; name: StandardPlane };

interface BodyEntry {
  body: BodyDisplay;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments | null;
  /** The cosmetic threads drawn over its faces, children of `mesh`. */
  threads: THREE.Mesh[];
  /** The style each material of the mesh shows: the body's first, then its face styles. */
  styles: Style[];
  override: Partial<Style>;
}

interface SketchEntry {
  sketch: SketchDisplay;
  group: THREE.Group;
}

const PICK_ORDER: Record<PickKind, number> = {
  sketchPoint: 0,
  sketchCurve: 1,
  construction: 2,
  edge: 3,
  region: 4,
  standard: 5,
  face: 6,
};

const v3 = (v: Vec3) => new THREE.Vector3(v[0], v[1], v[2]);

function frameMatrix(f: FrameDisplay): THREE.Matrix4 {
  return new THREE.Matrix4().makeBasis(v3(f.x), v3(f.y), v3(f.normal)).setPosition(v3(f.origin));
}

const itemId = (key: Key, instance?: InstanceRef) =>
  instance ? `${instance.assembly}#${instance.index}|${key}` : `|${key}`;

const withInstance = <T extends object>(o: T, instance: InstanceRef | undefined): T & { instance?: InstanceRef } =>
  instance ? { ...o, instance } : o;

export class ModelScene {
  /** Everything this class draws hangs from here. */
  readonly root = new THREE.Group();
  private readonly content = new THREE.Group();
  private readonly standard = new THREE.Group();
  private readonly standardMeshes = new Map<StandardPlane, THREE.Mesh>();
  /** The standard axes and the origin, drawn only while selected or hovered (they are picked in the browser). */
  private readonly datums = new THREE.Group();
  private readonly datumObjects = new Map<StandardDatum, THREE.Object3D>();
  private pickables: THREE.Object3D[] = [];
  private drawn = new Map<string, Drawn[]>();
  private bodies: BodyEntry[] = [];
  /**
   * Body face and edge materials of the display before, taken again by the
   * next: a new material costs the renderer a program lookup on its first
   * frame, thousands of them a long frame. `applyBodyLooks` sets everything
   * that differs between bodies.
   */
  private spareFaces: THREE.MeshPhongMaterial[] = [];
  private spareEdges: THREE.LineBasicMaterial[] = [];
  private sketches: SketchEntry[] = [];
  private byFeature = new Map<string, Drawn[]>();
  private display: Display | null = null;
  private geometries = new GeometryCache();
  private ghost = false;
  private hiddenSketch: string | null = null;
  private shownSketches: ReadonlySet<string> = new Set();
  private filter: ReadonlySet<PickKind> = ALL_PICKS;
  /** Opaque faces hide the sketch regions behind them from picks, whatever picks may land on. */
  private regionsOccluded = true;
  private selection: readonly SelectionItem[] = [];
  private hover: SelectionItem | null = null;
  private selectionOverlays: THREE.Object3D[] = [];
  private hoverOverlays: THREE.Object3D[] = [];
  /** The planes bodies are cut by (a section view), or null. */
  private clipping: THREE.Plane[] | null = null;
  private readonly stencilBack = stencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp);
  private readonly stencilFront = stencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp);

  constructor() {
    this.root.name = 'ModelScene';
    this.content.name = 'content';
    this.standard.name = 'standardPlanes';
    this.datums.name = 'standardDatums';
    this.root.add(this.content, this.standard, this.datums);
    this.buildStandardPlanes();
    this.buildStandardDatums();
  }

  // ---- Content ----

  /**
   * Draws `display`'s view of `shown`, replacing what was drawn. For an
   * assembly, `view.exploded` draws its instances where that exploded view
   * puts them, and instances for which `view.faded` holds draw see-through.
   * `view.own` is the instance of a part edited in the assembly's context:
   * it draws as the part itself (its picks name the part's own keys) at the
   * scene's origin, and the other instances where they stand from it, so
   * the scene's coordinates are the part's.
   */
  setDisplay(
    display: Display | null,
    shown: ShownRoot,
    view: { exploded?: string | null; faded?: (index: number) => boolean; own?: number } = {},
  ): void {
    const before = this.geometries;
    this.clearContent(true);
    this.geometries = GeometryCache.after(before);
    try {
      this.drawDisplay(display, shown, view);
    } finally {
      // Geometry of a mesh drawn before and not now is let go; what is drawn again keeps its GPU buffers.
      before.disposeUnless(this.geometries);
      this.geometries.settle();
      // Materials the new display did not take are let go.
      for (const m of [...this.spareFaces, ...this.spareEdges]) m.dispose();
      this.spareFaces = [];
      this.spareEdges = [];
    }
  }

  private drawDisplay(
    display: Display | null,
    shown: ShownRoot,
    view: { exploded?: string | null; faded?: (index: number) => boolean; own?: number },
  ): void {
    this.moved = null;
    this.display = display;
    this.content.matrixAutoUpdate = false;
    this.content.matrix.identity();
    if (!display || !shown) return this.refreshHighlights();
    if ('part' in shown) {
      const index = display.parts[shown.part];
      const definition = index === undefined ? undefined : display.definitions[index];
      if (definition) this.content.add(this.buildDefinition(definition, undefined, {}));
    } else {
      const assembly = display.assemblies.find((a) => a.id === shown.assembly);
      const own = view.own !== undefined ? assembly?.instances[view.own] : undefined;
      const exploded = view.exploded && !own ? assembly?.exploded[view.exploded] : undefined;
      if (own) this.content.matrix.fromArray(matrixOf(own.placement)).invert();
      this.content.matrixWorldNeedsUpdate = true;
      assembly?.instances.forEach((inst, index) => {
        const definition = display.definitions[inst.definition];
        if (!definition) return;
        const override = view.faded?.(index) ? { ...inst.override, opacity: FADED_OPACITY } : inst.override;
        const group = this.buildDefinition(
          definition,
          index === view.own ? undefined : { assembly: assembly.id, index },
          override,
        );
        placeInstance(group, exploded?.[index] ? { ...inst, placement: exploded[index] } : inst);
        this.content.add(group);
      });
    }
    this.applyBodyLooks();
    this.refreshHighlights();
  }

  get shownDisplay(): Display | null {
    return this.display;
  }

  /** The drawn group of an assembly's instance, by its index in the display, for moving it while it is dragged. */
  instanceObject(index: number): THREE.Object3D | undefined {
    return this.content.children.find((c) => c.name === `instance ${index}`);
  }

  private buildDefinition(
    d: DefinitionDisplay,
    instance: InstanceRef | undefined,
    override: Partial<Style>,
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = instance ? `instance ${instance.index}` : `definition ${d.index}`;
    for (const body of d.bodies) this.buildBody(group, body, instance, override, d.threads);
    for (const sketch of d.sketches) this.buildSketch(group, sketch, instance);
    for (const c of d.construction) this.buildConstruction(group, c, instance);
    return group;
  }

  private buildBody(
    parent: THREE.Group,
    body: BodyDisplay,
    instance: InstanceRef | undefined,
    override: Partial<Style>,
    threads: readonly ThreadDisplay[],
  ): void {
    const { mesh: data } = body;

    // One material per distinct look; triangles of a face that shows otherwise use its own.
    const styles: Style[] = [body];
    const styleOf = new Map<Key, number>();
    for (const fs of body.faceStyles) {
      styleOf.set(fs.key, styles.length);
      styles.push({ color: fs.color, opacity: fs.opacity, visible: fs.visible });
    }
    const triangles = data.indices.length / 3;
    const faceRanges: { first: number; count: number; key: Key }[] = [];
    for (let i = 0; i + 2 < data.faces.length; i += 3) {
      faceRanges.push({
        first: data.faces[i] as number,
        count: data.faces[i + 1] as number,
        key: data.faces[i + 2] as number,
      });
    }
    faceRanges.sort((a, b) => a.first - b.first);
    // Draw groups: contiguous triangles of one material merge into one group.
    const groups: { start: number; count: number; material: number }[] = [];
    const push = (start: number, count: number, material: number) => {
      const last = groups[groups.length - 1];
      if (last && last.material === material && last.start + last.count === start) last.count += count;
      else groups.push({ start, count, material });
    };
    let cursor = 0;
    for (const r of faceRanges) {
      if (r.first > cursor) push(cursor, r.first - cursor, 0);
      push(r.first, r.count, styleOf.get(r.key) ?? 0);
      cursor = Math.max(cursor, r.first + r.count);
    }
    if (cursor < triangles) push(cursor, triangles - cursor, 0);
    // Instances of a definition, and a display that shows the one before otherwise, draw one geometry per mesh and grouping.
    const geometry = this.geometries.faces(body.geometry ?? data, JSON.stringify(groups), () => {
      const made = new THREE.BufferGeometry();
      made.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      made.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
      made.setIndex(new THREE.BufferAttribute(data.indices, 1));
      for (const g of groups) made.addGroup(g.start * 3, g.count * 3, g.material);
      return made;
    });

    const materials = styles.map(
      () =>
        this.spareFaces.pop() ??
        new THREE.MeshPhongMaterial({
          color: DEFAULT_BODY_COLOR,
          specular: 0x222222,
          shininess: 30,
          flatShading: false,
        }),
    );
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.name = body.name;
    mesh.userData.pick = withInstance({ kind: 'face', mesh: data }, instance) satisfies PickTag;
    parent.add(mesh);
    this.pickables.push(mesh);

    let edges: THREE.LineSegments | null = null;
    if (data.segments.length > 0) {
      const edgeGeom = this.geometries.edges(body.geometry ?? data, () => {
        const made = new THREE.BufferGeometry();
        made.setAttribute('position', new THREE.BufferAttribute(data.segments, 3));
        return made;
      });
      edges = new THREE.LineSegments(
        edgeGeom,
        this.spareEdges.pop() ?? new THREE.LineBasicMaterial({ color: EDGE_COLOR }),
      );
      edges.userData.pick = withInstance({ kind: 'edge', mesh: data }, instance) satisfies PickTag;
      parent.add(edges);
      this.pickables.push(edges);
    }

    // A thread does not show on a face its style hides.
    const hidden = new Set(body.faceStyles.filter((f) => !f.visible).map((f) => f.key));
    const overlays = threads.flatMap((t) => threadOverlay(data, t, (face) => !hidden.has(face)) ?? []);
    for (const o of overlays) mesh.add(o);

    const entry: BodyEntry = { body, mesh, edges, threads: overlays, styles, override };
    this.bodies.push(entry);
    for (const r of faceRanges)
      this.index(itemId(r.key, instance), { kind: 'face', mesh, first: r.first, count: r.count });
    if (edges) {
      for (let i = 0; i + 2 < data.edges.length; i += 3) {
        this.index(itemId(data.edges[i + 2] as number, instance), {
          kind: 'edge',
          lines: edges,
          first: data.edges[i] as number,
          count: data.edges[i + 1] as number,
        });
      }
    }
    // A body's own key highlights all its faces.
    for (const r of faceRanges)
      this.index(itemId(body.key, instance), { kind: 'face', mesh, first: r.first, count: r.count });
    // The faces each feature made, so selecting a feature that made no body (a fillet, a cut) shows what it did.
    for (const r of faceRanges) {
      const made = this.display?.entities[r.key]?.feature;
      if (made !== undefined) this.indexFeature(made, { kind: 'face', mesh, first: r.first, count: r.count });
    }
  }

  private buildSketch(parent: THREE.Group, sketch: SketchDisplay, instance: InstanceRef | undefined): void {
    const group = new THREE.Group();
    group.name = `sketch ${sketch.feature}`;
    group.visible = this.sketchShown(sketch);
    group.position.copy(v3(sketch.frame.normal).multiplyScalar(SKETCH_LIFT));
    const line = new THREE.LineBasicMaterial({ color: SKETCH_LINE });
    const dashed = new THREE.LineDashedMaterial({ color: SKETCH_CONSTRUCTION, dashSize: 1, gapSize: 1 });
    for (const c of sketch.curves) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(c.points, 3));
      const object = new THREE.Line(geom, c.construction ? dashed : line);
      if (c.construction) object.computeLineDistances();
      object.userData.pick = withInstance({ kind: 'sketchCurve', key: c.key }, instance) satisfies PickTag;
      group.add(object);
      this.pickables.push(object);
      this.index(itemId(c.key, instance), { kind: 'line', line: object });
      this.indexFeature(sketch.feature, { kind: 'line', line: object });
    }
    if (sketch.points.length > 0) {
      const positions = new Float32Array(sketch.points.length * 3);
      sketch.points.forEach((p, i) => positions.set(p.at, i * 3));
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const points = new THREE.Points(
        geom,
        new THREE.PointsMaterial({ color: SKETCH_LINE, size: 5, sizeAttenuation: false }),
      );
      points.userData.pick = withInstance(
        { kind: 'sketchPoint', keys: sketch.points.map((p) => p.key) },
        instance,
      ) satisfies PickTag;
      group.add(points);
      this.pickables.push(points);
      sketch.points.forEach((p, index) => this.index(itemId(p.key, instance), { kind: 'point', points, index }));
    }
    const fill = new THREE.MeshBasicMaterial({
      color: SKETCH_REGION,
      transparent: true,
      opacity: SKETCH_REGION_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    for (const r of sketch.regions) {
      const geom = regionGeometry(r.loops, sketch.frame);
      if (!geom) continue;
      const mesh = new THREE.Mesh(geom, fill);
      mesh.renderOrder = ORDER.region;
      // Below the curves, which are lifted off the plane.
      mesh.position.copy(v3(sketch.frame.normal).multiplyScalar(-SKETCH_LIFT / 2));
      mesh.userData.pick = withInstance({ kind: 'region', key: r.key }, instance) satisfies PickTag;
      group.add(mesh);
      this.pickables.push(mesh);
      this.index(itemId(r.key, instance), { kind: 'surface', mesh });
    }
    parent.add(group);
    this.sketches.push({ sketch, group });
  }

  private buildConstruction(parent: THREE.Group, c: ConstructionDisplay, instance: InstanceRef | undefined): void {
    const matrix = frameMatrix(c.frame);
    const tag = withInstance({ kind: 'construction', key: c.key }, instance) satisfies PickTag;
    const add = (object: THREE.Object3D, drawn: Drawn, pickable = true) => {
      object.applyMatrix4(matrix);
      object.visible = c.visible;
      object.renderOrder = ORDER.construction;
      if (pickable) {
        object.userData.pick = tag;
        this.pickables.push(object);
      }
      parent.add(object);
      this.index(itemId(c.key, instance), drawn);
      this.indexFeature(c.feature, drawn);
    };
    if (c.kind === 'plane') {
      const plane = new THREE.PlaneGeometry(CONSTRUCTION_PLANE_SIZE, CONSTRUCTION_PLANE_SIZE);
      const mesh = new THREE.Mesh(
        plane,
        new THREE.MeshBasicMaterial({
          color: CONSTRUCTION_FILL,
          transparent: true,
          opacity: CONSTRUCTION_OPACITY,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      add(mesh, { kind: 'surface', mesh });
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(plane),
        new THREE.LineBasicMaterial({ color: CONSTRUCTION_OUTLINE, transparent: true, opacity: 0.85 }),
      );
      add(outline, { kind: 'line', line: outline }, false);
    } else if (c.kind === 'axis') {
      const h = CONSTRUCTION_PLANE_SIZE / 2;
      const geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -h), new THREE.Vector3(0, 0, h)]);
      const line = new THREE.Line(
        geom,
        new THREE.LineDashedMaterial({ color: CONSTRUCTION_OUTLINE, dashSize: 3, gapSize: 1.5 }),
      );
      line.computeLineDistances();
      add(line, { kind: 'line', line });
    } else if (c.kind === 'point') {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      const points = new THREE.Points(
        geom,
        new THREE.PointsMaterial({ color: CONSTRUCTION_OUTLINE, size: 7, sizeAttenuation: false }),
      );
      add(points, { kind: 'point', points, index: 0 });
    } else {
      const s = CONSTRUCTION_PLANE_SIZE / 4;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([0, 0, 0, s, 0, 0, 0, 0, 0, 0, s, 0, 0, 0, 0, 0, 0, s]), 3),
      );
      geom.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array([1, 0, 0, 1, 0, 0, 0, 0.7, 0, 0, 0.7, 0, 0, 0, 1, 0, 0, 1]), 3),
      );
      const triad = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ vertexColors: true }));
      add(triad, { kind: 'line', line: triad });
    }
  }

  private buildStandardPlanes(): void {
    const plane = new THREE.PlaneGeometry(STANDARD_PLANE_SIZE, STANDARD_PLANE_SIZE);
    const edges = new THREE.EdgesGeometry(plane);
    for (const name of STANDARD_PLANES) {
      const color = STANDARD_COLORS[name];
      const matrix = frameMatrix(STANDARD_FRAMES[name]);
      const mesh = new THREE.Mesh(
        plane,
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: STANDARD_PLANE_OPACITY,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      mesh.applyMatrix4(matrix);
      mesh.renderOrder = ORDER.standard;
      mesh.name = name;
      mesh.userData.pick = { kind: 'standard', name } satisfies PickTag;
      const outline = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
      );
      outline.applyMatrix4(matrix);
      outline.renderOrder = ORDER.standard + 1;
      this.standard.add(mesh, outline);
      this.standardMeshes.set(name, mesh);
    }
  }

  private buildStandardDatums(): void {
    const h = STANDARD_PLANE_SIZE / 2;
    for (const name of STANDARD_DATUMS) {
      const color = DATUM_COLORS[name];
      let object: THREE.Object3D;
      if (name === 'origin') {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
        object = new THREE.Points(
          geom,
          new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false, transparent: true }),
        );
      } else {
        const d = v3(DATUM_DIRECTIONS[name]);
        const geom = new THREE.BufferGeometry().setFromPoints([
          d.clone().multiplyScalar(-h),
          d.clone().multiplyScalar(h),
        ]);
        object = new THREE.Line(geom, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
      }
      object.name = name;
      object.renderOrder = ORDER.standard + 2;
      object.visible = false;
      this.datums.add(object);
      this.datumObjects.set(name, object);
    }
  }

  private index(id: string, d: Drawn): void {
    const list = this.drawn.get(id);
    if (list) list.push(d);
    else this.drawn.set(id, [d]);
  }

  private indexFeature(feature: string, d: Drawn): void {
    const list = this.byFeature.get(feature);
    if (list) list.push(d);
    else this.byFeature.set(feature, [d]);
  }

  /** Empties the scene's content; with `spare`, the bodies' materials are kept for the next display to take. */
  private clearContent(spare = false): void {
    disposeOverlays(this.selectionOverlays);
    disposeOverlays(this.hoverOverlays);
    this.selectionOverlays = [];
    this.hoverOverlays = [];
    const kept = new Set<THREE.Material>();
    if (spare) {
      for (const entry of this.bodies) {
        for (const m of entry.mesh.material as THREE.MeshPhongMaterial[]) {
          kept.add(m);
          this.spareFaces.push(m);
        }
        if (entry.edges) {
          const m = entry.edges.material as THREE.LineBasicMaterial;
          kept.add(m);
          this.spareEdges.push(m);
        }
      }
    }
    this.content.traverse((o) => {
      const m = o as THREE.Mesh;
      // A body's geometry is the cache's to let go.
      if (m.geometry && !this.geometries.holds(m.geometry)) m.geometry.dispose();
      const material = m.material;
      if (Array.isArray(material)) material.forEach((x) => kept.has(x) || x.dispose());
      else if (material !== this.stencilBack && material !== this.stencilFront && !(material && kept.has(material)))
        material?.dispose();
    });
    this.content.clear();
    this.pickables = [];
    this.drawn.clear();
    this.byFeature.clear();
    this.bodies = [];
    this.sketches = [];
  }

  // ---- Modes ----

  /**
   * Bodies show faintly while a sketch is edited (`ghost`), and that
   * sketch's own drawing is hidden. `shownSketches` draw, and take picks,
   * whatever their own visibility.
   */
  setMode(o: { ghost: boolean; hiddenSketch: string | null; shownSketches?: readonly string[] }): void {
    this.ghost = o.ghost;
    this.hiddenSketch = o.hiddenSketch;
    this.shownSketches = new Set(o.shownSketches ?? []);
    for (const s of this.sketches) s.group.visible = this.sketchShown(s.sketch);
    this.applyBodyLooks();
  }

  private sketchShown(sketch: SketchDisplay): boolean {
    return (sketch.visible || this.shownSketches.has(sketch.feature)) && sketch.feature !== this.hiddenSketch;
  }

  setStandardPlanesVisible(visible: boolean): void {
    this.standard.visible = visible;
  }

  get standardPlanesVisible(): boolean {
    return this.standard.visible;
  }

  /** What picks may land on. */
  setPickFilter(kinds: ReadonlySet<PickKind>): void {
    this.filter = kinds;
  }

  /**
   * Whether opaque faces hide the regions behind them from picks even where
   * faces are not picked (off while a panel previews its feature, whose
   * new solid covers the regions it is made from).
   */
  setRegionsOccluded(on: boolean): void {
    this.regionsOccluded = on;
  }

  private applyBodyLooks(): void {
    const glowing = new Set(this.selection.flatMap((i) => ('feature' in i ? [i.feature] : [])));
    for (const entry of this.bodies) {
      const materials = entry.mesh.material as THREE.MeshPhongMaterial[];
      const glow = glowing.has(entry.body.feature);
      entry.styles.forEach((style, i) => {
        const m = materials[i] as THREE.MeshPhongMaterial;
        // Only what changes the shader program asks for it again: transparency and the number of cutting planes.
        const program = `${m.transparent}|${m.clippingPlanes?.length ?? 0}`;
        m.color.set(entry.override.color ?? style.color);
        const opacity = (entry.override.opacity ?? style.opacity) * (this.ghost ? GHOST_OPACITY : 1);
        m.transparent = opacity < 1;
        m.opacity = opacity;
        m.depthWrite = opacity >= 1;
        m.visible = style.visible;
        m.clippingPlanes = this.clipping;
        if (glow) {
          m.emissive.copy(m.color).lerp(new THREE.Color(0xffffff), 0.5);
          m.emissiveIntensity = HIGHLIGHT_GLOW;
        } else {
          m.emissive.setHex(0x000000);
          m.emissiveIntensity = 0;
        }
        if (`${m.transparent}|${m.clippingPlanes?.length ?? 0}` !== program) m.needsUpdate = true;
      });
      const visible = entry.body.visible && entry.override.visible !== false;
      entry.mesh.visible = visible;
      const bodyOpacity = (entry.override.opacity ?? entry.body.opacity) * (this.ghost ? GHOST_OPACITY : 1);
      for (const t of entry.threads) setThreadLook(t, bodyOpacity, this.clipping);
      if (entry.edges) {
        entry.edges.visible = visible;
        const edgeMaterial = entry.edges.material as THREE.LineBasicMaterial;
        const planes = edgeMaterial.clippingPlanes?.length ?? 0;
        edgeMaterial.color.setHex(glow ? SELECTED_EDGE_COLOR : EDGE_COLOR);
        edgeMaterial.clippingPlanes = this.clipping;
        if ((this.clipping?.length ?? 0) !== planes) edgeMaterial.needsUpdate = true;
      }
      this.applyStencil(entry, materials);
    }
  }

  /** The cap's stencil passes under a body's mesh while a section cuts it; a see-through body gets no cap. */
  private applyStencil(entry: BodyEntry, materials: THREE.MeshPhongMaterial[]): void {
    const existing = entry.mesh.children.find((c) => c.name === 'section stencil');
    if (!this.clipping) {
      if (existing) entry.mesh.remove(existing);
      return;
    }
    let group = existing;
    if (!group) {
      group = new THREE.Group();
      group.name = 'section stencil';
      for (const material of [this.stencilBack, this.stencilFront]) {
        const pass = new THREE.Mesh(entry.mesh.geometry, material);
        pass.renderOrder = SECTION_STENCIL_ORDER;
        pass.raycast = () => undefined;
        group.add(pass);
      }
      entry.mesh.add(group);
    }
    group.visible = !materials.some((m) => m.transparent);
  }

  // ---- Section ----

  /**
   * Cuts the shown bodies and their edges with `planes` (world space; what
   * a plane's normal points away from is cut off), or stops cutting with
   * null. The planes are held by reference, so moving one moves the cut on
   * the next frame. Picks ignore what is cut off.
   */
  setClipping(planes: THREE.Plane[] | null): void {
    this.clipping = planes && planes.length > 0 ? planes : null;
    for (const m of [this.stencilBack, this.stencilFront]) {
      m.clippingPlanes = this.clipping;
      m.needsUpdate = true;
    }
    this.refreshHighlights();
  }

  get clippingPlanes(): readonly THREE.Plane[] | null {
    return this.clipping;
  }

  // ---- Picking ----

  /**
   * The item under `raycaster`'s ray. Points come before curves, curves and
   * edges before surfaces, and anything translucent (a region, a plane) in
   * front of the nearest face before that face: the face is opaque, so what
   * lies behind it is not what the user meant. A standard plane is picked
   * over a face only when it lies in front of it; a face on the plane is
   * picked instead. A region behind an opaque face is not picked even where
   * faces are not (see `setRegionsOccluded`).
   *
   * `threshold` is the line and point tolerance in scene units. With
   * `pixelAt` (the scene units per screen pixel at a point), a line or point
   * is taken only within `PICK_PIXELS` screen pixels of the ray where it
   * lies (an edge within `EDGE_PICK_PIXELS`), however near or far it is, and
   * `threshold` only bounds the search.
   */
  pick(
    raycaster: THREE.Raycaster,
    threshold: number,
    pixelAt?: (point: THREE.Vector3) => number,
  ): SelectionItem | null {
    raycaster.params.Line = { threshold };
    raycaster.params.Points = { threshold };
    const targets = [...this.pickables, ...this.standardMeshes.values()].filter((o) => {
      const tag = o.userData.pick as PickTag;
      return this.filter.has(tag.kind) && shown(o);
    });
    const clipping = this.clipping;
    const unclipped = (h: THREE.Intersection): boolean => {
      const kind = (h.object.userData.pick as PickTag).kind;
      return (
        !clipping || (kind !== 'face' && kind !== 'edge') || clipping.every((p) => p.distanceToPoint(h.point) >= -1e-6)
      );
    };
    const near = (h: THREE.Intersection): boolean => {
      if (!pixelAt) return true;
      const kind = (h.object.userData.pick as PickTag).kind;
      if (h.object instanceof THREE.Points) return (h.distanceToRay ?? 0) <= PICK_PIXELS * pixelAt(h.point);
      if (h.object instanceof THREE.Line)
        return (
          raycaster.ray.distanceToPoint(h.point) <=
          (kind === 'edge' ? EDGE_PICK_PIXELS : PICK_PIXELS) * pixelAt(h.point)
        );
      return true;
    };
    const hits = raycaster.intersectObjects(targets, false).filter((h) => unclipped(h) && near(h));
    let nearestFace = Infinity;
    for (const h of hits) {
      if ((h.object.userData.pick as PickTag).kind === 'face' && faceShown(h)) {
        nearestFace = h.distance;
        break;
      }
    }
    const slack = Number.isFinite(nearestFace) ? Math.max(nearestFace * 1e-3, 1e-3) : 0;
    const regionLimit =
      this.regionsOccluded && !this.filter.has('face') ? this.nearestOpaqueFace(raycaster) : nearestFace;
    const regionSlack = Number.isFinite(regionLimit) ? Math.max(regionLimit * 1e-3, 1e-3) : 0;
    let best: { item: SelectionItem; order: number; distance: number } | null = null;
    for (const h of hits) {
      const tag = h.object.userData.pick as PickTag;
      if (tag.kind === 'face' && !faceShown(h)) continue;
      if (tag.kind !== 'face' && h.distance > nearestFace + slack) continue;
      if (tag.kind === 'region' && h.distance > regionLimit + regionSlack) continue;
      // Between a standard plane and a face the nearer wins; a face lying on the plane wins over it.
      if (tag.kind === 'standard' && h.distance >= nearestFace - slack) continue;
      const item = itemOf(tag, h);
      if (!item) continue;
      const order = PICK_ORDER[tag.kind];
      if (!best || order < best.order || (order === best.order && h.distance < best.distance))
        best = { item, order, distance: h.distance };
    }
    return best?.item ?? null;
  }

  /** The distance along the ray to the nearest shown opaque body face, picked or not; Infinity for none. */
  private nearestOpaqueFace(raycaster: THREE.Raycaster): number {
    const faces = this.pickables.filter((o) => (o.userData.pick as PickTag).kind === 'face' && shown(o));
    const clipping = this.clipping;
    for (const h of raycaster.intersectObjects(faces, false)) {
      if (clipping && !clipping.every((p) => p.distanceToPoint(h.point) >= -1e-6)) continue;
      const materials = (h.object as THREE.Mesh).material;
      const material = Array.isArray(materials) ? materials[h.face?.materialIndex ?? 0] : materials;
      if (material && material.visible !== false && !material.transparent) return h.distance;
    }
    return Infinity;
  }

  // ---- Selection and hover ----

  setSelection(items: readonly SelectionItem[]): void {
    this.selection = items;
    this.refreshHighlights();
  }

  setHover(item: SelectionItem | null): void {
    if (sameItem(this.hover, item)) return;
    this.hover = item;
    disposeOverlays(this.hoverOverlays);
    this.hoverOverlays =
      item && !this.selection.some((s) => sameItem(s, item)) ? this.overlays([item], PRESELECTION) : [];
    this.applyStandardLooks();
  }

  private refreshHighlights(): void {
    disposeOverlays(this.selectionOverlays);
    disposeOverlays(this.hoverOverlays);
    this.selectionOverlays = this.overlays(this.selection, SELECTION);
    this.hoverOverlays =
      this.hover && !this.selection.some((s) => sameItem(s, this.hover))
        ? this.overlays([this.hover], PRESELECTION)
        : [];
    this.applyStandardLooks();
    this.applyBodyLooks();
  }

  private overlays(items: readonly SelectionItem[], style: HighlightStyle): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const item of items) {
      let drawn: Drawn[] | undefined;
      if ('key' in item) drawn = this.drawn.get(itemId(item.key, item.instance));
      else if ('feature' in item) {
        // A feature that made a body glows instead (see applyBodyLooks); its faces need no overlay.
        const madeBody = this.bodies.some((b) => b.body.feature === item.feature);
        drawn = this.byFeature.get(item.feature)?.filter((d) => !madeBody || d.kind !== 'face');
      }
      for (const d of drawn ?? []) {
        const overlay = overlayFor(d, style);
        const parent = parentOf(d);
        if (!overlay || !parent) continue;
        overlay.userData.source =
          d.kind === 'face' || d.kind === 'surface'
            ? d.mesh
            : d.kind === 'edge'
              ? d.lines
              : d.kind === 'line'
                ? d.line
                : d.points;
        // A body's highlight is cut by a section as the body is.
        if (d.kind === 'face' || d.kind === 'edge') clipOverlay(overlay, this.clipping);
        parent.add(overlay);
        out.push(overlay);
      }
    }
    this.placeMoved(out);
    return out;
  }

  // ---- A move in progress ----

  /** Bodies drawn moved, until the next display: their keys and the move. */
  private moved: { keys: ReadonlySet<Key>; matrix: THREE.Matrix4 } | null = null;

  /**
   * Draws the shown bodies `keys` (with their edges and highlights) moved
   * by `matrix` in the part's frame, as a drag moves them before the move
   * is evaluated; null draws them where they are. A new display ends it.
   */
  moveBodies(keys: readonly Key[], matrix: THREE.Matrix4 | null): void {
    const before = this.moved;
    this.moved = matrix && keys.length > 0 ? { keys: new Set(keys), matrix: matrix.clone() } : null;
    const objects = this.movedObjects(before?.keys ?? new Set());
    for (const o of objects) this.place(o, null);
    this.placeMoved([...this.selectionOverlays, ...this.hoverOverlays]);
  }

  private movedObjects(keys: ReadonlySet<Key>, overlays: readonly THREE.Object3D[] = []): Set<THREE.Object3D> {
    const out = new Set<THREE.Object3D>();
    for (const { body, mesh, edges } of this.bodies) {
      if (!keys.has(body.key)) continue;
      out.add(mesh);
      if (edges) out.add(edges);
    }
    for (const o of [...this.selectionOverlays, ...this.hoverOverlays, ...overlays])
      if (out.has(o.userData.source as THREE.Object3D)) out.add(o);
    return out;
  }

  private placeMoved(overlays: readonly THREE.Object3D[]): void {
    if (!this.moved) {
      for (const o of overlays) this.place(o, null);
      return;
    }
    const objects = this.movedObjects(this.moved.keys, overlays);
    for (const o of objects) this.place(o, this.moved.matrix);
    for (const o of overlays) if (!objects.has(o)) this.place(o, null);
  }

  private place(o: THREE.Object3D, matrix: THREE.Matrix4 | null): void {
    if (!matrix) {
      if (!o.matrixAutoUpdate) {
        o.matrixAutoUpdate = true;
        o.updateMatrix();
      }
      return;
    }
    o.matrixAutoUpdate = false;
    o.matrix.copy(matrix);
    o.matrixWorldNeedsUpdate = true;
  }

  private applyStandardLooks(): void {
    for (const [name, mesh] of this.standardMeshes) {
      const item = { standard: name };
      const selected = this.selection.some((s) => sameItem(s, item));
      const hovered = sameItem(this.hover, item);
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.opacity = selected
        ? SELECTION.planeOpacity
        : hovered
          ? PRESELECTION.planeOpacity
          : STANDARD_PLANE_OPACITY;
    }
    for (const [name, object] of this.datumObjects) {
      const item = { datum: name };
      object.visible = this.selection.some((s) => sameItem(s, item)) || sameItem(this.hover, item);
    }
  }

  /** The cosmetic threads drawn, for tests and debugging. */
  get threadOverlays(): THREE.Mesh[] {
    return this.bodies.flatMap((b) => b.threads);
  }

  /** Highlights present for the selection and the hover, for tests and debugging. */
  get overlayCount(): { selection: number; hover: number } {
    return { selection: this.selectionOverlays.length, hover: this.hoverOverlays.length };
  }

  // ---- Queries ----

  /** The bounds of the shown bodies, in scene coordinates (empty with none). */
  bodiesBox(): THREE.Box3 {
    const box = new THREE.Box3();
    this.root.updateMatrixWorld(true);
    for (const { mesh } of this.bodies) {
      if (!mesh.visible) continue;
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      if (bb) box.union(bb.clone().applyMatrix4(mesh.matrixWorld));
    }
    return box;
  }

  /** What Home frames: the shown bodies, or with none the standard planes (shown or not, for the scale of an empty part). */
  framingBox(): THREE.Box3 {
    const box = this.bodiesBox();
    if (box.isEmpty()) {
      this.root.updateMatrixWorld(true);
      box.setFromObject(this.standard);
    }
    return box;
  }

  /** The frame a sketch of the shown part lies in. */
  sketchFrame(feature: string): FrameDisplay | null {
    return this.sketches.find((s) => s.sketch.feature === feature)?.sketch.frame ?? null;
  }

  dispose(): void {
    this.clearContent();
    this.geometries.disposeUnless(new GeometryCache());
    this.stencilBack.dispose();
    this.stencilFront.dispose();
    this.standard.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
    this.root.parent?.remove(this.root);
  }
}

/**
 * The geometries drawn for body meshes, by the mesh's geometry id
 * (`BodyDisplay.geometry`), or by mesh object where it has none: a display
 * draws a geometry it shares with the display before with the same buffers,
 * so they stay on the GPU.
 */
type GeometryKey = BodyMesh | number;

class GeometryCache {
  private readonly byFaces = new Map<GeometryKey, Map<string, THREE.BufferGeometry>>();
  private readonly byEdges = new Map<GeometryKey, THREE.BufferGeometry>();
  private readonly all = new Set<THREE.BufferGeometry>();
  /** The cache of the display before, whose geometries this one takes over. */
  private from: GeometryCache | null = null;

  /** Takes over what `previous` drew, as asked for. */
  static after(previous: GeometryCache): GeometryCache {
    const next = new GeometryCache();
    next.from = previous;
    return next;
  }

  faces(mesh: GeometryKey, grouping: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let groupings = this.byFaces.get(mesh);
    if (!groupings) this.byFaces.set(mesh, (groupings = new Map()));
    let geometry = groupings.get(grouping) ?? this.from?.byFaces.get(mesh)?.get(grouping);
    geometry ??= make();
    groupings.set(grouping, geometry);
    this.all.add(geometry);
    return geometry;
  }

  edges(mesh: GeometryKey, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
    const geometry = this.byEdges.get(mesh) ?? this.from?.byEdges.get(mesh) ?? make();
    this.byEdges.set(mesh, geometry);
    this.all.add(geometry);
    return geometry;
  }

  /** Done taking over. */
  settle(): void {
    this.from = null;
  }

  holds(geometry: THREE.BufferGeometry): boolean {
    return this.all.has(geometry) || (this.from?.all.has(geometry) ?? false);
  }

  /** Disposes every geometry this cache holds that `kept` does not. */
  disposeUnless(kept: GeometryCache): void {
    for (const g of this.all) if (!kept.all.has(g)) g.dispose();
    this.all.clear();
    this.byFaces.clear();
    this.byEdges.clear();
    this.from = null;
  }
}

function placeInstance(group: THREE.Group, inst: InstanceDisplay): void {
  group.matrixAutoUpdate = false;
  group.matrix.fromArray(matrixOf(inst.placement));
  group.visible = inst.visible;
}

/** True when the object and all its parents are visible. */
function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** False for a hit on a face whose look hides it. */
/** Gives a highlight overlay's materials the section's clipping planes. */
export function clipOverlay(overlay: THREE.Object3D, planes: THREE.Plane[] | null): void {
  const material = (overlay as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  for (const m of Array.isArray(material) ? material : material ? [material] : []) {
    m.clippingPlanes = planes;
    m.needsUpdate = true;
  }
}

function faceShown(h: THREE.Intersection): boolean {
  const materials = (h.object as THREE.Mesh).material;
  if (!Array.isArray(materials)) return true;
  const index = h.face?.materialIndex ?? 0;
  return materials[index]?.visible !== false;
}

function itemOf(tag: PickTag, h: THREE.Intersection): SelectionItem | null {
  if (tag.kind === 'standard') return { standard: tag.name };
  if (tag.kind === 'face') {
    const key = h.faceIndex === undefined || h.faceIndex === null ? undefined : faceAt(tag.mesh, h.faceIndex);
    return key === undefined ? null : withInstance({ key }, tag.instance);
  }
  if (tag.kind === 'edge') {
    const key = typeof h.index === 'number' ? edgeAt(tag.mesh, Math.floor(h.index / 2)) : undefined;
    return key === undefined ? null : withInstance({ key }, tag.instance);
  }
  if (tag.kind === 'sketchPoint') {
    const key = typeof h.index === 'number' ? tag.keys[h.index] : undefined;
    return key === undefined ? null : withInstance({ key }, tag.instance);
  }
  return withInstance({ key: tag.key }, tag.instance);
}

/** A region's fill: its loops taken into the sketch frame, triangulated, and placed back. */
function regionGeometry(loops: readonly Float32Array[], frame: FrameDisplay): THREE.BufferGeometry | null {
  const [outer, ...holes] = loops;
  if (!outer) return null;
  const o = v3(frame.origin);
  const x = v3(frame.x);
  const y = v3(frame.y);
  const toPlane = (loop: Float32Array): THREE.Vector2[] => {
    const out: THREE.Vector2[] = [];
    const p = new THREE.Vector3();
    for (let i = 0; i + 2 < loop.length; i += 3) {
      p.set(loop[i] as number, loop[i + 1] as number, loop[i + 2] as number).sub(o);
      out.push(new THREE.Vector2(p.dot(x), p.dot(y)));
    }
    return out;
  };
  const outline = toPlane(outer);
  if (outline.length < 3) return null;
  const shape = new THREE.Shape(outline);
  for (const h of holes) {
    const hole = toPlane(h);
    if (hole.length >= 3) shape.holes.push(new THREE.Path(hole));
  }
  const geom = new THREE.ShapeGeometry(shape);
  geom.applyMatrix4(frameMatrix(frame));
  return geom;
}
