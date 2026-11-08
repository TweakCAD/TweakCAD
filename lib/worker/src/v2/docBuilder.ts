/**
 * Composes version-2 documents for tests and the lab: sketches of
 * rectangles, circles and curve rows of any kind with optional constraints, regions picked by a point
 * inside them, and extrudes with any extent and operation. Region rows are
 * written as the editor would: detected on the drawn geometry, external
 * curves where the caller gives their shape, and text in fonts the document
 * holds.
 */
import {
  NameTable,
  base32Encode,
  contentHash,
  detectRegions,
  idItem,
  ladderOf,
  makeSet,
  nameHash,
  type CurveShape,
  type DetectedRegion,
  type JsonSet,
  type Loop,
  type Detection,
  type SolvedSketch,
} from '@tweakcad/format';
import type { Font } from 'opentype.js';
import { curveGeometry } from './sketchCurves';
import { fontOf, layoutText } from './sketchText';

type Json = Record<string, unknown>;
type P2 = readonly [number, number];

export interface SketchHandle {
  feature: string;
  /** The region rows as written. */
  rows: readonly { id: string; loop: Loop; holes: JsonSet<Loop> }[];
  /** The profile reference to a region row. */
  refOf(id: string): Json;
  /** Picks the region that contains `inside` and gives the profile reference to it. */
  region(inside: P2): Json;
}

export interface ExtrudeOptions {
  profiles: Json[];
  sides?: { distance?: string; throughAll?: true; taper?: string }[];
  symmetric?: { d: string; measure: 'total' | 'half' };
  op?: 'new' | 'join' | 'cut' | 'intersect';
  /** Extrude the other way along the sketch normal. */
  reversed?: boolean;
  sketch: string;
}

/** Point-in-polygon by ray crossing. */
function inside(p: P2, polygon: readonly P2[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [a, b] = [polygon[i] as P2, polygon[j] as P2];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

function polygonOf(detection: Detection, halfEdges: readonly number[]): P2[] {
  const out: P2[] = [];
  for (const h of halfEdges) {
    const edge = detection.arrangement.edges[h >> 1];
    const live = edge && detection.arrangement.curves[edge.curve];
    if (!edge || !live) continue;
    const [t0, t1] = (h & 1) === 0 ? [edge.t0, edge.t1] : [edge.t1, edge.t0];
    for (let i = 0; i < 32; i++) out.push(live.curve.point(t0 + ((t1 - t0) * i) / 32));
  }
  return out;
}

function contains(detection: Detection, region: DetectedRegion, p: P2): boolean {
  return (
    inside(p, polygonOf(detection, region.outer.halfEdges)) &&
    !region.inner.some((c) => inside(p, polygonOf(detection, c.halfEdges)))
  );
}

export class DocBuilder {
  readonly names = new NameTable();
  readonly library: Json[] = [];
  readonly assets: Json = {};
  /** Parsed fonts by library id. */
  readonly fonts = new Map<string, Font>();
  private counter = 0;
  private readonly timeline: Json[] = [];
  private readonly part: string;

  constructor() {
    this.part = this.id('part');
  }

  /** A font file as a library entry (`{definition: {asset}}`) with its bytes in the assets; returns the entry's id. */
  font(bytes: Uint8Array, name: string): string {
    const hash = contentHash(bytes);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    this.assets[hash] = { mediaType: 'font/ttf', name, size: bytes.length, data: { inline: { base64: btoa(binary) } } };
    const id = this.id('lib');
    const content = { inline: { definition: { asset: hash } } };
    this.library.push({ id, hash: nameHash(content), kind: 'font', content, source: { local: {} }, name });
    this.fonts.set(id, fontOf(hash, bytes));
    return id;
  }

  /** A fresh, deterministic id. */
  id(kind: string): string {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(12, ++this.counter);
    return `${kind}_${base32Encode(bytes)}`;
  }

  val(text: string): Json {
    return { id: this.id('val'), def: { expr: { text, grammar: 1, refs: {} } } };
  }

  /** Appends a feature of any type to the timeline; returns its id. */
  feature(type: string, inputs: Json): string {
    const id = this.id('feat');
    this.timeline.push({
      id,
      type,
      typeVersion: 1,
      name: type,
      suppressed: this.val('false'),
      frozen: { live: {} },
      command: { alone: {} },
      inputs,
    });
    return id;
  }

  /** A sketch on a default plane, drawn by `draw`, with `offset` along its normal. */
  sketch(plane: 'xy' | 'yz' | 'xz', draw: (s: SketchDraw) => void, offset = 0): SketchHandle {
    const s = new SketchDraw(this);
    draw(s);
    const glyphs = s.texts.flatMap((t) => {
      const font = this.fonts.get(t.font);
      if (!font) throw new Error(`no font ${t.font}`);
      return layoutText(font, t.id, t.string, t.size, { origin: t.origin, angle: (t.angle * Math.PI) / 180 });
    });
    const solved: SolvedSketch = {
      points: s.points.map((p) => ({ id: p.id as string, x: p.x as number, y: p.y as number })),
      curves: [...s.curves.flatMap((c) => s.solvedCurve(c) ?? []), ...glyphs],
    };
    const detection = detectRegions(solved);
    const rows = detection.regions.map((r) => ({
      id: this.id('reg'),
      loop: r.loop,
      holes: r.holes,
      origin: { detected: {} },
    }));
    const feature = this.feature('core.sketch', {
      frame: {
        attach: {
          support: [{ standard: { name: plane } }],
          mode: this.val('"plane"'),
          offset: this.val(`placement(vector(0 mm, 0 mm, ${offset} mm), rotate(vector(0, 0, 1), 0 deg))`),
          flip: this.val('false'),
        },
      },
      points: s.points,
      curves: s.curves,
      constraints: s.constraints,
      regions: rows,
      retired: [],
      text: s.texts.map((t) => t.row),
    });
    const refOf = (id: string): Json => {
      const ladder = ladderOf({ kind: 'region', chain: [], feature, role: 'region', src: [idItem(id)] }, this.names);
      return { entity: { id: ladder, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
    };
    return {
      feature,
      rows,
      refOf,
      region: (p) => {
        const index = detection.regions.findIndex((r) => contains(detection, r, p));
        const row = rows[index];
        if (!row) throw new Error(`no region contains (${p[0]}, ${p[1]})`);
        return refOf(row.id);
      },
    };
  }

  extrude(o: ExtrudeOptions): string {
    const side = (s: NonNullable<ExtrudeOptions['sides']>[number]) => ({
      extent: s.throughAll ? { throughAll: {} } : { distance: { d: this.val(s.distance ?? '10 mm') } },
      taper: this.val(s.taper ?? '0 deg'),
    });
    const sides = o.symmetric
      ? [
          {
            extent: { symmetric: { d: this.val(o.symmetric.d), measure: this.val(`"${o.symmetric.measure}"`) } },
            taper: this.val('0 deg'),
          },
        ]
      : (o.sides ?? [{ distance: '10 mm' }]).map(side);
    return this.feature('core.extrude', {
      profiles: makeSet(o.profiles),
      sides,
      direction: {
        normal: { ref: { object: { feature: { id: o.sketch } } }, reversed: this.val(o.reversed ? 'true' : 'false') },
      },
      thin: { solid: {} },
      operation: { op: this.val(`"${o.op ?? 'new'}"`), targets: { all: {} }, keepTools: this.val('false') },
    });
  }

  document(): Json {
    return {
      format: 'tweakcad.document',
      schemaVersion: 2,
      namingRules: 1,
      id: this.id('doc'),
      metadata: {
        name: 'Test',
        description: '',
        createdAt: '2026-11-05T00:00:00Z',
        updatedAt: '2026-11-05T00:00:00Z',
        writer: { app: 'test', version: '0' },
        origin: { original: {} },
      },
      properties: {},
      settings: {},
      parameters: [],
      parts: [
        {
          id: this.part,
          name: 'Part',
          parameters: [],
          timeline: this.timeline,
          rollback: { end: {} },
          groups: [],
          sets: [],
          contexts: [],
          attributes: [],
          configurations: [],
          notes: [],
          properties: {},
        },
      ],
      assemblies: [],
      root: { part: { id: this.part } },
      folders: [],
      views: [],
      library: structuredClone(this.library),
      assets: structuredClone(this.assets),
      names: this.names.toJson(),
    };
  }

  get partId(): string {
    return this.part;
  }
}

export class SketchDraw {
  readonly points: Json[] = [];
  readonly curves: Json[] = [];
  readonly constraints: Json[] = [];
  readonly texts: { id: string; font: string; string: string; size: number; origin: P2; angle: number; row: Json }[] =
    [];
  private readonly externals = new Map<string, CurveShape>();

  constructor(private readonly doc: DocBuilder) {}

  point(x: number, y: number): string {
    const id = this.doc.id('pt');
    this.points.push({ id, x, y });
    return id;
  }

  line(a: string, b: string): string {
    const id = this.doc.id('crv');
    this.curves.push({
      id,
      kind: 'line',
      construction: this.doc.val('false'),
      origin: { drawn: {} },
      start: a,
      end: b,
    });
    return id;
  }

  /** An axis-aligned rectangle; returns its corner points and lines, counter-clockwise from (x, y). */
  rect(x: number, y: number, w: number, h: number): { points: string[]; lines: string[] } {
    const points = [this.point(x, y), this.point(x + w, y), this.point(x + w, y + h), this.point(x, y + h)];
    const lines = points.map((p, i) => this.line(p, points[(i + 1) % 4] as string));
    return { points, lines };
  }

  circle(cx: number, cy: number, r: number): string {
    const center = this.point(cx, cy);
    const id = this.doc.id('crv');
    this.curves.push({
      id,
      kind: 'circle',
      construction: this.doc.val('false'),
      origin: { drawn: {} },
      center,
      radius: r,
    });
    return id;
  }

  /** A driving dimension between two points along x. */
  distanceX(a: string, b: string, value: string): void {
    this.constraint('distanceX', {
      a: { point: { id: a } },
      b: { point: { id: b } },
      value: this.doc.val(value),
      solved: 0,
      label: { auto: {} },
    });
  }

  distanceY(a: string, b: string, value: string): void {
    this.constraint('distanceY', {
      a: { point: { id: a } },
      b: { point: { id: b } },
      value: this.doc.val(value),
      solved: 0,
      label: { auto: {} },
    });
  }

  fixed(p: string): void {
    this.constraint('fixed', { point: { point: { id: p } } });
  }

  horizontal(line: string): void {
    this.constraint('horizontal', { of: { curve: { id: line } } });
  }

  vertical(line: string): void {
    this.constraint('vertical', { of: { curve: { id: line } } });
  }

  constraint(kind: string, fields: Json): void {
    this.constraints.push({ id: this.doc.id('con'), kind, active: this.doc.val('true'), ...fields });
  }

  /** A curve row of any kind, with its kind fields; returns its id. */
  curve(kind: string, fields: Json): string {
    const id = this.doc.id('crv');
    this.curves.push({ id, kind, construction: this.doc.val('false'), origin: { drawn: {} }, ...fields });
    return id;
  }

  /**
   * An external curve row; `shape` is what it builds to in this sketch, for
   * detecting the regions a defining one bounds. Returns its id.
   */
  external(
    source: Json,
    o: { mode?: string; defining?: boolean; index?: number; count?: number; near?: P2; shape?: CurveShape },
  ): string {
    const id = this.doc.id('crv');
    const several = o.index === undefined ? {} : { index: o.index, count: o.count, near: o.near };
    this.curves.push({
      id,
      kind: 'external',
      construction: this.doc.val('false'),
      origin: { drawn: {} },
      source,
      defining: this.doc.val(o.defining ? 'true' : 'false'),
      mode: this.doc.val(`"${o.mode ?? 'project'}"`),
      ...several,
    });
    if (o.shape && o.defining) this.externals.set(id, o.shape);
    return id;
  }

  /** A straight text row in a font of the document, its baseline from `at` at `angle` degrees; returns its id. */
  text(font: string, string: string, size: number, at: P2 = [0, 0], angle = 0): string {
    const id = this.doc.id('txt');
    const row = {
      id,
      string: this.doc.val(JSON.stringify(string)),
      font: {
        id: this.doc.id('val'),
        def: { expr: { text: 'typeface', grammar: 1, refs: { typeface: { library: { id: font } } } } },
      },
      size: this.doc.val(`${size} mm`),
      frame: {
        fixed: {
          placement: this.doc.val(
            `placement(vector(${at[0]} mm, ${at[1]} mm, 0 mm), rotate(vector(0, 0, 1), ${angle} deg))`,
          ),
        },
      },
      path: { straight: {} },
    };
    this.texts.push({ id, font, string, size, origin: at, angle, row });
    return id;
  }

  /** The solved-geometry form of a curve row, for region detection on the drawn positions; null for one that bounds no region. */
  solvedCurve(c: Json): SolvedSketch['curves'][number] | null {
    const external = this.externals.get(c.id as string);
    if (external) {
      const closed =
        external.kind === 'circle' || external.kind === 'ellipse' || (external.kind === 'nurbs' && external.periodic);
      return {
        key: { drawn: { id: c.id as string } },
        shape: external,
        anchors: closed ? { kind: 'none' } : { kind: 'extremities' },
      };
    }
    const at = (id: unknown): P2 => {
      const p = this.points.find((q) => q.id === id) as Json;
      return [p.x as number, p.y as number];
    };
    // Shape values here are plain numbers and flags.
    const literal = (v: unknown) => {
      const text = (((v as Json).def as Json).expr as Json).text as string;
      return text === 'true' ? 1 : text === 'false' ? 0 : Number(text);
    };
    const geometry = curveGeometry(c, { point: at, number: literal, variable: () => undefined });
    return geometry && { key: { drawn: { id: c.id as string } }, ...geometry };
  }
}
