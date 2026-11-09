/**
 * A version-2 document as a FreeCAD `.FCStd`, from its evaluation. Each body a
 * part builds becomes a PartDesign Body whose features are the ones FreeCAD
 * has, so FreeCAD can recompute the tree. A feature with no FreeCAD form comes
 * in as the solid it built, stored in a `Part::Feature` the Body continues
 * from, so what follows stays parametric. Parameters become spreadsheets, and
 * values bound to them become expressions.
 *
 * Frames are kept: a part's frame is its Body's. Every feature also stores the
 * shape it built here, so the file shows the model without a recompute.
 */
import type { ShapeHandle } from 'occt-wasm';
import { canonicalize, finest, type NamedEntity, type ShapeRef, type ValueEvaluator } from '@tweakcad/format';
import {
  ANGLE,
  FLAG,
  INTEGER,
  LENGTH,
  LENGTH_VECTOR,
  TEXT,
  type BuildContext,
  type Evaluation,
  type Frame,
  type Json,
  type PartResult,
  type SketchResult,
  type V3,
} from '../context';
import { axisOf, constructionOf, directionOf, faceFrameOf, frameOf, pointAt, sketchRowOf } from '../places';
import { referenceFace, targetEdges } from '../blend';
import { threadSpec } from '../builders/thread';
import { ISO_METRIC, ISO_METRIC_SIZES, isoDesignations, threadSize } from '../threadTable';
import { entitiesOf } from '../references';
import { bodyIdentity } from '../service/identity';
import { escape, FcFile, IDENTITY, type FcOut, type FcPlacement, type LinkSub, type Q } from './file';
import { faceRegions } from './regions';
import { writeSketch, type WrittenSketch } from './sketch';

export interface ExportNote {
  /** The feature or part it is about. */
  object: string;
  message: string;
}

export interface ExportPart {
  id: string;
  row: Json;
  result: PartResult;
  /** The part after each feature, by ordinal. */
  steps: readonly (PartResult | undefined)[];
}

export interface LiveBody {
  /** The body's identity across the timeline. */
  id: string;
  ref: ShapeRef;
  handle: ShapeHandle;
  /** `#rrggbb`, when an attribute colours it. */
  color?: string;
  opacity?: number;
}

/** A body shape outside the document's parts: a library part placed in an assembly. */
export interface PlacedShape {
  label: string;
  handle: ShapeHandle;
  placement: FcPlacement;
}

export interface ExportSource {
  doc: Json;
  ev: Evaluation;
  parts: readonly ExportPart[];
  /** The bodies live in a state of a part, in a stable order. */
  bodies(part: ExportPart, state: PartResult): LiveBody[];
  /** Where each document part is placed by the root assembly, in order; empty when the root is a part. */
  instances: readonly { part: string; placement: FcPlacement }[];
  /** Placed shapes that are not parts of the document. */
  placedShapes: readonly PlacedShape[];
}

export interface FcstdExport {
  bytes: Uint8Array;
  notes: ExportNote[];
  /** Each document part's FreeCAD Bodies. */
  bodies: { part: string; body: string; features: string[] }[];
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scaled = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const plus = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** The rotation taking the part's axes to a frame's. */
function rotationOf(x: V3, y: V3, z: V3): Q {
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const t = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 >= m11 && m00 >= m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 >= m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return q;
}

const placementOf = (f: Frame): FcPlacement => ({ position: f.origin, rotation: rotationOf(f.x, f.y, f.normal) });

function rotated(q: Q, v: V3): V3 {
  const u: V3 = [q[0], q[1], q[2]];
  const t = scaled(cross(u, v), 2);
  return plus(plus(v, scaled(t, q[3])), cross(u, t));
}

function multiply(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

const compose = (a: FcPlacement, b: FcPlacement): FcPlacement => ({
  position: plus(a.position, rotated(a.rotation, b.position)),
  rotation: multiply(a.rotation, b.rotation),
});
function invert(p: FcPlacement): FcPlacement {
  const q: Q = [-p.rotation[0], -p.rotation[1], -p.rotation[2], p.rotation[3]];
  return { position: scaled(rotated(q, p.position), -1), rotation: q };
}
/** A placement as the kernel's 3x4 row-major matrix. */
function matrixOf(p: FcPlacement): number[] {
  const [x, y, z] = [rotated(p.rotation, [1, 0, 0]), rotated(p.rotation, [0, 1, 0]), rotated(p.rotation, [0, 0, 1])];
  const o = p.position;
  return [x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2]];
}

const shift = (at: FcPlacement, by: V3) => compose(at, { position: by, rotation: [0, 0, 0, 1] });

/** A placement whose z axis runs along `z`, for a datum line. */
function alongZ(origin: V3, z: V3): FcPlacement {
  const seed: V3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const y = cross(z, seed);
  const unitY = scaled(y, 1 / Math.hypot(...y));
  return { position: origin, rotation: rotationOf(cross(unitY, z), unitY, z) };
}

/** FreeCAD's origin planes, as frames of its own. */
const FC_PLANES: Record<string, { name: string; frame: Frame }> = {
  xy: { name: 'XY_Plane', frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] } },
  xz: { name: 'XZ_Plane', frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], normal: [0, -1, 0] } },
  yz: { name: 'YZ_Plane', frame: { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], normal: [1, 0, 0] } },
};
const FC_AXES: Record<string, { name: string; direction: V3 }> = {
  x: { name: 'X_Axis', direction: [1, 0, 0] },
  y: { name: 'Y_Axis', direction: [0, 1, 0] },
  z: { name: 'Z_Axis', direction: [0, 0, 1] },
};
/** The origin's features and the placement FreeCAD gives each. */
/** FreeCAD's ISO metric thread sizes, the coarse ones in the same order as the table here. */
const COARSE_SIZES = ISO_METRIC_SIZES.filter((d) => isoDesignations(d)[0] === `M${d}`).map((d) => `M${d}`);
const FREECAD_SIZES = COARSE_SIZES.map((d) => {
  const { major, pitch } = threadSize(ISO_METRIC, d);
  return `M${major}x${Number.isInteger(pitch) ? pitch.toFixed(1) : pitch}`;
});
/** FreeCAD's ISO metric fine thread sizes, in its order. */
const FREECAD_FINE_SIZES = [
  'M1x0.2 M1.1x0.2 M1.2x0.2 M1.4x0.2 M1.6x0.2 M1.8x0.2 M2x0.25 M2.2x0.25 M2.5x0.35 M3x0.35 M3.5x0.35',
  'M4x0.5 M4.5x0.5 M5x0.5 M5.5x0.5 M6x0.75 M7x0.75 M8x0.75 M8x1.0 M9x0.75 M9x1.0 M10x0.75 M10x1.0',
  'M10x1.25 M11x0.75 M11x1.0 M12x1.0 M12x1.25 M12x1.5 M14x1.0 M14x1.25 M14x1.5 M15x1.0 M15x1.5 M16x1.0',
  'M16x1.5 M17x1.0 M17x1.5 M18x1.0 M18x1.5 M18x2.0 M20x1.0 M20x1.5 M20x2.0 M22x1.0 M22x1.5 M22x2.0',
  'M24x1.0 M24x1.5 M24x2.0 M25x1.0 M25x1.5 M25x2.0 M27x1.0 M27x1.5 M27x2.0 M28x1.0 M28x1.5 M28x2.0',
  'M30x1.0 M30x1.5 M30x2.0 M30x3.0 M32x1.5 M32x2.0 M33x1.5 M33x2.0 M33x3.0 M35x1.5 M35x2.0 M36x1.5',
  'M36x2.0 M36x3.0 M39x1.5 M39x2.0 M39x3.0 M40x1.5 M40x2.0 M40x3.0 M42x1.5 M42x2.0 M42x3.0 M42x4.0',
  'M45x1.5 M45x2.0 M45x3.0 M45x4.0 M48x1.5 M48x2.0 M48x3.0 M48x4.0 M50x1.5 M50x2.0 M50x3.0 M52x1.5',
  'M52x2.0 M52x3.0 M52x4.0 M55x1.5 M55x2.0 M55x3.0 M55x4.0 M56x1.5 M56x2.0 M56x3.0 M56x4.0 M58x1.5',
  'M58x2.0 M58x3.0 M58x4.0 M60x1.5 M60x2.0 M60x3.0 M60x4.0 M62x1.5 M62x2.0 M62x3.0 M62x4.0 M64x1.5',
  'M64x2.0 M64x3.0 M64x4.0 M65x1.5 M65x2.0 M65x3.0 M65x4.0 M68x1.5 M68x2.0 M68x3.0 M68x4.0 M70x1.5',
  'M70x2.0 M70x3.0 M70x4.0 M70x6.0 M72x1.5 M72x2.0 M72x3.0 M72x4.0 M72x6.0 M75x1.5 M75x2.0 M75x3.0',
  'M75x4.0 M75x6.0 M76x1.5 M76x2.0 M76x3.0 M76x4.0 M76x6.0 M80x1.5 M80x2.0 M80x3.0 M80x4.0 M80x6.0',
  'M85x2.0 M85x3.0 M85x4.0 M85x6.0 M90x2.0 M90x3.0 M90x4.0 M90x6.0 M95x2.0 M95x3.0 M95x4.0 M95x6.0',
  'M100x2.0 M100x3.0 M100x4.0 M100x6.0',
]
  .join(' ')
  .split(' ');

/** A pitch as FreeCAD names it in a size, `1.0` for whole millimetres. */
const pitchName = (pitch: number) => (Number.isInteger(pitch) ? pitch.toFixed(1) : String(pitch));

/**
 * The FreeCAD thread type (1, ISO metric; 2, ISO metric fine), size list and
 * index for a size and pitch, or null when FreeCAD has neither that pitch
 * nor a coarse size of that diameter.
 */
function freecadThread(
  major: number,
  pitch: number,
): { type: 1 | 2; sizes: readonly string[]; index: number; exact: boolean } | null {
  const coarse = FREECAD_SIZES.indexOf(`M${major}x${pitchName(pitch)}`);
  if (coarse >= 0) return { type: 1, sizes: FREECAD_SIZES, index: coarse, exact: true };
  const fine = FREECAD_FINE_SIZES.indexOf(`M${major}x${pitchName(pitch)}`);
  if (fine >= 0) return { type: 2, sizes: FREECAD_FINE_SIZES, index: fine, exact: true };
  const fallback = COARSE_SIZES.indexOf(`M${major}`);
  return fallback >= 0 ? { type: 1, sizes: FREECAD_SIZES, index: fallback, exact: false } : null;
}

/** The classes a FreeCAD Hole offers for an ISO metric thread. */
const FREECAD_CLASSES = ['4G', '4H', '5G', '5H', '6G', '6H', '7G', '7H', '8G', '8H'];

const ORIGIN: { label: string; type: string; role: string; rotation: Q }[] = [
  { label: 'X-axis', type: 'App::Line', role: 'X_Axis', rotation: [0, 0, 0, 1] },
  { label: 'Y-axis', type: 'App::Line', role: 'Y_Axis', rotation: [0.5, 0.5, 0.5, 0.5] },
  { label: 'Z-axis', type: 'App::Line', role: 'Z_Axis', rotation: [0.5, -0.5, 0.5, 0.5] },
  { label: 'XY-plane', type: 'App::Plane', role: 'XY_Plane', rotation: [0, 0, 0, 1] },
  { label: 'XZ-plane', type: 'App::Plane', role: 'XZ_Plane', rotation: [0.7071067811865476, 0, 0, 0.7071067811865476] },
  { label: 'YZ-plane', type: 'App::Plane', role: 'YZ_Plane', rotation: [0.5, 0.5, 0.5, 0.5] },
  { label: 'Origin', type: 'App::Point', role: 'Origin', rotation: [0, 0, 0, 1] },
];

/** Words FreeCAD reads as units or constants, which cannot name a spreadsheet alias. */
const UNIT_WORDS = new Set(
  'nm um mm cm dm m km in inch ft foot yd mi mil thou ug mg g kg t lb oz st cwt s ms us ns min h hr deg rad gon A mA kA V mV kV W mW kW J mJ kJ Pa kPa MPa GPa N mN kN K mK C F H T S L l ml ohm pi e'.split(
    ' ',
  ),
);
const OPERATORS = /^[\s\d.eE+\-*/^()%,]*$/;
const KNOWN_WORDS = new Set([
  'sqrt',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'abs',
  'min',
  'max',
  'floor',
  'ceil',
  'round',
  'pow',
  'exp',
  'log',
  'pi',
  'mm',
  'cm',
  'm',
  'in',
  'ft',
  'deg',
  'rad',
]);

/** Numeric parameters and bound values as FreeCAD expressions. */
class Expressions {
  /** A parameter's alias and the sheet object holding it. */
  private readonly parameters = new Map<string, { sheet: FcOut; alias: string }>();
  /** Where a named value of the document ended up: `Pad.Length`, `Sketch.Constraints.width`. */
  readonly values = new Map<string, string>();

  constructor(
    private readonly fc: FcFile,
    private readonly values_: ValueEvaluator,
  ) {}

  /** A sheet holding a parameter table's rows: name, value, description. */
  table(table: Json): void {
    const rows = ((table.parameters as Json[]) ?? []).filter((p) => p.type === 'number');
    if (rows.length === 0) return;
    const sheet = this.fc.add('Spreadsheet::Sheet', String(table.name ?? 'Parameters'));
    const used = new Set<string>();
    rows.forEach((p) => {
      let alias = String(p.name);
      if (UNIT_WORDS.has(alias) || /^[A-Z]{1,3}\d+$/.test(alias) || used.has(alias)) alias = `p_${alias}`;
      used.add(alias);
      this.parameters.set(p.id as string, { sheet, alias });
    });
    const cells: string[] = [];
    rows.forEach((p, i) => {
      const row = i + 1;
      const value = p.value as Json;
      const here = this.parameters.get(p.id as string) as { alias: string };
      const text = this.expression(value, sheet) ?? this.literalText(value, p);
      cells.push(`<Cell address="A${row}" content="${escape(String(p.name))}"/>`);
      cells.push(`<Cell address="B${row}" content="=${escape(text)}" alias="${escape(here.alias)}"/>`);
    });
    sheet.raw(
      'cells',
      'Spreadsheet::PropertySheet',
      `<Cells Count="${cells.length}" xlink="0">${cells.join('')}</Cells>`,
    );
  }

  private literalText(value: Json, p: Json): string {
    const quantity = p.quantity as string;
    if (quantity === 'length') return `${this.values_.number(value, LENGTH)} mm`;
    if (quantity === 'angle') return `${this.values_.number(value, ANGLE)} deg`;
    const def = value.def as Json;
    const expr = def.expr as Json | undefined;
    return expr ? String(expr.text) : '0';
  }

  /** The expression `value` is bound by, in FreeCAD's language; undefined for a plain literal or text FreeCAD would not read. */
  expression(value: Json, from?: FcOut): string | undefined {
    const expr = (value.def as Json | undefined)?.expr as Json | undefined;
    if (!expr) return undefined;
    const refs = (expr.refs ?? {}) as Record<string, Json>;
    const names = Object.keys(refs);
    if (names.length === 0) return undefined;
    let text = String(expr.text);
    if (text.includes('"') || text.includes('?')) return undefined;
    const swaps = new Map<string, string>();
    for (const name of names) {
      const ref = refs[name] as Json;
      const parameter = ref.parameter as Json | undefined;
      const valueRef = ref.value as Json | undefined;
      let target: string | undefined;
      if (parameter) {
        const p = this.parameters.get(parameter.id as string);
        if (p) target = p.sheet === from ? p.alias : `${p.sheet.name}.${p.alias}`;
      } else if (valueRef) target = this.values.get(valueRef.id as string);
      if (!target) return undefined;
      swaps.set(name, target);
    }
    text = text.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) => swaps.get(word) ?? word);
    const left = String(expr.text).replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) =>
      swaps.has(word) || KNOWN_WORDS.has(word) ? '' : word,
    );
    return OPERATORS.test(left) ? text : undefined;
  }

  /** Binds `path` of `out` to `value`, and records where the value is for what reads it later. */
  bind(out: FcOut, path: string, value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    const v = value as Json;
    if (typeof v.id === 'string') this.values.set(v.id, `${out.name}.${path}`);
    const text = this.expression(v);
    if (text) out.expression(path, text);
  }
}

/** One FreeCAD Body: what it holds and the shapes it stands for. */
interface Chain {
  body: FcOut;
  origin: Map<string, FcOut>;
  group: FcOut[];
  /** The last solid feature. */
  tip: FcOut | undefined;
  /** Identities of the live bodies this Body's shape holds. */
  ids: Set<string>;
  sketches: Map<string, { out: FcOut; written: WrittenSketch }>;
  /** The Body's current shape, as BREP text. */
  brep: string | undefined;
  /** How the body it ended as shows. */
  look: { color?: string; opacity?: number };
}

type Where = { ev: Evaluation; part: PartResult };

class PartWriter {
  private readonly chains: Chain[] = [];
  private readonly features = new Map<string, FcOut>();
  private readonly sketchRows = new Map<string, { row: Json; name: string; result: SketchResult }>();
  /** Construction features waiting for a Body: their frames and types. */
  private readonly datums = new Map<string, FcOut>();
  private readonly label: string;

  constructor(
    private readonly fc: FcFile,
    private readonly src: ExportSource,
    private readonly part: ExportPart,
    private readonly ex: Expressions,
    private readonly notes: ExportNote[],
  ) {
    this.label = String(part.row.name ?? 'Body');
  }

  private get values(): ValueEvaluator {
    return this.src.ev.values;
  }

  private note(object: string, message: string): void {
    this.notes.push({ object, message });
  }

  private num(v: unknown, target: typeof LENGTH | typeof ANGLE = LENGTH): number {
    return this.values.number(v, target);
  }

  private flag(v: unknown): boolean {
    return this.values.literal(v, FLAG) === true;
  }

  private text(v: unknown): string {
    return String(this.values.literal(v, TEXT));
  }

  private chain(label: string): Chain {
    const body = this.fc.add('PartDesign::Body', label);
    const origin = new Map<string, FcOut>();
    const root = this.fc.add('App::Origin', 'Origin');
    for (const o of ORIGIN) {
      const f = this.fc.add(o.type, o.label);
      f.string('Role', o.role);
      f.placement({ position: [0, 0, 0], rotation: o.rotation });
      f.bool('Visibility', false);
      origin.set(o.role, f);
    }
    root.linkList('OriginFeatures', [...origin.values()]);
    root.bool('Visibility', false);
    origin.set('root', root);
    const chain: Chain = {
      body,
      origin,
      group: [],
      tip: undefined,
      ids: new Set(),
      sketches: new Map(),
      brep: undefined,
      look: {},
    };
    this.chains.push(chain);
    return chain;
  }

  private anyChain(): Chain {
    return this.chains[0] ?? this.chain(this.label);
  }

  private brepOf(handles: readonly ShapeHandle[]): string {
    const k = this.src.ev.kernel;
    if (handles.length === 1) return k.toBREP(handles[0] as ShapeHandle);
    const compound = k.makeCompound([...handles]);
    try {
      return k.toBREP(compound);
    } finally {
      k.release(compound);
    }
  }

  /**
   * The part-frame shape of `handles` as the BREP of an object at `at`: FreeCAD
   * takes an object's placement from its shape's location as it reads the
   * shape, so the geometry goes back to the object's frame and the location
   * carries it out again.
   */
  private brepAt(handles: readonly ShapeHandle[], at: FcPlacement): string {
    const k = this.src.ev.kernel;
    const shape = handles.length === 1 ? (handles[0] as ShapeHandle) : k.makeCompound([...handles]);
    const local = k.transform(shape, matrixOf(invert(at)));
    const placed = k.located(local, matrixOf(at));
    const text = k.toBREP(placed);
    k.release(placed);
    k.release(local);
    if (shape !== handles[0]) k.release(shape);
    return text;
  }

  /** The object a sketch became in `chain`, writing it there the first time. */
  private sketchIn(id: string, chain: Chain): { out: FcOut; written: WrittenSketch } | undefined {
    const had = chain.sketches.get(id);
    if (had) return had;
    const s = this.sketchRows.get(id);
    if (!s) return undefined;
    const out = this.fc.add('Sketcher::SketchObject', s.name);
    this.placeSketch(out, s.row, s.result.frame, chain);
    const written = writeSketch(out, {
      row: s.row,
      result: s.result,
      values: this.values,
      expression: (v) => this.ex.expression(v),
      note: (m) => this.note(s.name, m),
    });
    out.bool('Visibility', false);
    chain.group.push(out);
    const made = { out, written };
    chain.sketches.set(id, made);
    return made;
  }

  /**
   * A stored shape at the sketch's place. Without one FreeCAD solves the sketch
   * as it loads and sets its placement from the unplaced result; a recompute
   * replaces this one.
   */
  private sketchShape(out: FcOut, frame: Frame): void {
    const k = this.src.ev.kernel;
    const { x, y, normal: z, origin: o } = frame;
    const vertex = k.makeVertex(0, 0, 0);
    const placed = k.located(vertex, [x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2]]);
    out.shape(k.toBREP(placed));
    k.release(placed);
    k.release(vertex);
  }

  /** A sketch on an origin plane is attached to it; any other keeps its solved place. */
  private placeSketch(out: FcOut, row: Json, frame: Frame, chain: Chain): void {
    const placement = placementOf(frame);
    out.placement(placement);
    this.sketchShape(out, frame);
    const attach = (row.frame as Json).attach as Json | undefined;
    const support = attach?.support as Json[] | undefined;
    const standard = support?.length === 1 ? ((support[0] as Json).standard as Json | undefined)?.name : undefined;
    const plane = typeof standard === 'string' ? FC_PLANES[standard] : undefined;
    if (plane && attach && this.text(attach.mode) === 'plane') {
      out.linkSubList('AttachmentSupport', [{ object: chain.origin.get(plane.name) as FcOut, subs: [] }]);
      out.enumeration('MapMode', 5);
      out.placement(compose(invert(placementOf(plane.frame)), placement), 'AttachmentOffset');
    } else out.enumeration('MapMode', 0);
  }

  /** Regions of one sketch as a profile: the whole sketch when FreeCAD would make those faces of it, else a sketch of just them. */
  private profile(refs: readonly Json[], chain: Chain, feature: string): FcOut | undefined {
    const ids: { sketch: string; region: string }[] = [];
    for (const ref of refs) {
      const record = ref.entity as Json | undefined;
      const level = record ? (this.src.ev.names.get(finest(record.id as string[])) as Json | undefined) : undefined;
      const first = (level?.src as Json[] | undefined)?.[0];
      if (!level || level.kind !== 'region' || !first || !('id' in first)) return undefined;
      ids.push({ sketch: (level.feature as Json).id as string, region: (first.id as Json).id as string });
    }
    const sketch = ids[0]?.sketch;
    if (!sketch || ids.some((i) => i.sketch !== sketch)) return undefined;
    const s = this.sketchRows.get(sketch);
    if (!s) return undefined;
    const regions = (s.row.regions as Json[]) ?? [];
    const wanted = new Set(ids.map((i) => i.region));
    const detection = s.result.detection;
    const rowOf = new Map(s.result.table.regions.map((r) => [canonicalize(r.loop), r.id]));
    const faces = new Set(faceRegions(detection).map((r) => rowOf.get(canonicalize(r.loop))));
    const same = wanted.size === faces.size && [...wanted].every((w) => faces.has(w));
    if (detection.arrangement.curves.some((c) => c.edges.length > 1)) {
      this.note(feature, 'its profile uses parts of curves that cross, which a FreeCAD sketch does not');
      return undefined;
    }
    if (same) return this.sketchIn(sketch, chain)?.out;
    const only = new Set<string>();
    for (const r of regions.filter((x) => wanted.has(x.id as string))) {
      const uses = [...((r.loop as Json[]) ?? []), ...(((r.holes as Json).set as Json[][]) ?? []).flat()];
      for (const u of uses) {
        const inner = (u.closed ?? u.open ?? u) as Json;
        const curve = ((inner.curve as Json | undefined)?.drawn as Json | undefined)?.id;
        if (typeof curve === 'string') only.add(curve);
      }
    }
    if (only.size === 0) return undefined;
    const out = this.fc.add('Sketcher::SketchObject', `${s.name} (${feature})`);
    this.placeSketch(out, s.row, s.result.frame, chain);
    writeSketch(out, { row: s.row, result: s.result, values: this.values, only, note: (m) => this.note(s.name, m) });
    out.bool('Visibility', false);
    chain.group.push(out);
    this.note(
      feature,
      'its profile is some of the regions of its sketch, so it has a sketch of just those curves, without constraints',
    );
    return out;
  }

  /** Writes a solid feature in the Body's chain, with the shape it built here. */
  private solid(out: FcOut, chain: Chain, brep: string, suppressedBase = chain.tip): void {
    out.link('BaseFeature', suppressedBase);
    out.bool('Refine', true);
    out.shape(brep);
    out.bool('Visibility', false);
    chain.group.push(out);
    chain.tip = out;
    chain.brep = brep;
  }

  private datumLine(chain: Chain, label: string, origin: V3, direction: V3): FcOut {
    const out = this.fc.add('PartDesign::Line', `${label} axis`);
    out.enumeration('MapMode', 0);
    out.placement(alongZ(origin, direction));
    out.bool('Visibility', false);
    chain.group.push(out);
    return out;
  }

  /** What FreeCAD links for an axis: an origin axis or a datum line, and whether its direction opposes `direction`. */
  private axisLink(chain: Chain, label: string, origin: V3, direction: V3): { object: FcOut; reversed: boolean } {
    for (const a of Object.values(FC_AXES)) {
      const d = dot(a.direction, direction);
      const offAxis = Math.hypot(...cross(a.direction, origin));
      if (Math.abs(Math.abs(d) - 1) < 1e-9 && offAxis < 1e-9)
        return { object: chain.origin.get(a.name) as FcOut, reversed: d < 0 };
    }
    return { object: this.datumLine(chain, label, origin, direction), reversed: false };
  }

  private extrude(f: Json, chain: Chain, w: Where, brep: string): boolean {
    const i = f.inputs as Json;
    const label = f.name as string;
    if (!('solid' in (i.thin as Json))) return false;
    if (i.start !== undefined && !('profilePlane' in (i.start as Json))) return false;
    const op = this.text((i.operation as Json).op);
    if (op === 'intersect') return false;
    const pad = op !== 'cut';
    const sides = i.sides as Json[];
    const first = sides[0] as Json;
    const second = sides[1];
    // Extents up to something read the Body the feature is in, which a new Body does not have.
    const onBody = chain.tip !== undefined;
    const extentOf = (side: Json): { type: number; length: number; bound?: unknown; face?: string[] } | undefined => {
      const e = side.extent as Json;
      if ('distance' in e) return { type: 0, length: this.num((e.distance as Json).d), bound: (e.distance as Json).d };
      if (!onBody) return undefined;
      if ('upToLast' in e) return pad ? { type: 1, length: 0 } : undefined;
      if ('throughAll' in e) return pad ? undefined : { type: 1, length: 0 };
      if ('upToNext' in e) return { type: 2, length: 0 };
      if ('toFace' in e) {
        const t = e.toFace as Json;
        const face = this.elementNames([t.face as Json], 'face', chain, w.part);
        if (!face || face.length !== 1 || this.num(t.offset) !== 0) return undefined;
        return { type: 3, length: 0, face };
      }
      return undefined;
    };
    const symmetric = (first.extent as Json).symmetric as Json | undefined;
    const a = symmetric ? { type: 0, length: 0 } : extentOf(first);
    const b = second ? extentOf(second as Json) : undefined;
    if (!a || (second && !b) || (b && b.length < 0)) return false;
    const refs = ((i.profiles as Json).set as Json[]) ?? [];
    const profile = this.profile(refs, chain, label);
    if (!profile) return false;
    const sketchId = this.sketchOf(refs[0] as Json);
    const normal = sketchId ? this.sketchRows.get(sketchId)?.result.frame.normal : undefined;
    if (!normal) return false;
    const direction = directionOf(w, i.direction as Json);
    const along = dot(direction, normal);
    if (Math.abs(Math.abs(along) - 1) > 1e-9) return false;

    const out = this.fc.add(pad ? 'PartDesign::Pad' : 'PartDesign::Pocket', label);
    out.linkSub('Profile', profile);
    out.bool('AllowMultiFace', true);
    // A pad runs along the sketch normal and a pocket against it, each turned round by Reversed.
    out.bool('Reversed', pad ? along < 0 : along > 0);
    if (symmetric) {
      const measure = this.text(symmetric.measure);
      const d = this.num(symmetric.d);
      out.length('Length', measure === 'total' ? d : 2 * d);
      if (measure === 'total') this.ex.bind(out, 'Length', symmetric.d);
      // FreeCAD 1.1 reads a symmetric pad or pocket from SideType and treats Midplane as deprecated.
      out.enumeration('SideType', 2);
      out.enumeration('Type', 0);
    } else {
      out.length('Length', a.length);
      out.enumeration('Type', a.type);
      if (a.face) out.linkSub('UpToFace', chain.tip, a.face);
      this.ex.bind(out, 'Length', a.bound);
      if (b) {
        out.enumeration('SideType', 1);
        out.enumeration('Type2', b.type);
        out.length('Length2', b.length);
        this.ex.bind(out, 'Length2', b.bound);
        out.angle('TaperAngle2', this.num((second as Json).taper, ANGLE));
      }
    }
    out.angle('TaperAngle', this.num(first.taper, ANGLE));
    this.solid(out, chain, brep);
    return true;
  }

  /** The sketch a region reference lies in. */
  private sketchOf(ref: Json): string | undefined {
    const record = ref.entity as Json | undefined;
    const level = record ? (this.src.ev.names.get(finest(record.id as string[])) as Json | undefined) : undefined;
    return level ? ((level.feature as Json | undefined)?.id as string | undefined) : undefined;
  }

  private revolve(f: Json, chain: Chain, w: Where, brep: string): boolean {
    const i = f.inputs as Json;
    const label = f.name as string;
    if (!('solid' in (i.thin as Json))) return false;
    const op = this.text((i.operation as Json).op);
    if (op === 'intersect') return false;
    const additive = op !== 'cut';
    const refs = ((i.profiles as Json).set as Json[]) ?? [];
    const profile = this.profile(refs, chain, label);
    if (!profile) return false;
    const sides = i.sides as Json[];
    const line = axisOf(w, i.axis as Json);
    const out = this.fc.add(additive ? 'PartDesign::Revolution' : 'PartDesign::Groove', label);
    out.linkSub('Profile', profile);
    out.bool('AllowMultiFace', true);
    const reference = this.sketchAxis(i.axis as Json, refs[0] as Json, chain, w);
    const link = reference ?? this.axisLink(chain, label, line.point, line.direction);
    out.linkSub('ReferenceAxis', link.object, 'sub' in link ? [link.sub as string] : ['']);
    out.bool('Reversed', link.reversed);
    out.vector('Base', line.point);
    out.vector('Axis', line.direction);
    const first = sides[0] as Json;
    if ('full' in first) {
      out.angle('Angle', 360);
    } else if ('symmetric' in first) {
      const s = first.symmetric as Json;
      const a = this.num(s.a, ANGLE);
      out.angle('Angle', this.text(s.measure) === 'total' ? a : 2 * a);
      out.bool('Midplane', true);
    } else {
      out.angle('Angle', this.num((first.angle as Json).a, ANGLE));
      this.ex.bind(out, 'Angle', (first.angle as Json).a);
      const second = sides[1] as Json | undefined;
      if (second) {
        out.enumeration('Type', 4);
        out.angle('Angle2', this.num((second.angle as Json).a, ANGLE));
      }
    }
    this.solid(out, chain, brep);
    return true;
  }

  /** A revolve axis along a line of the profile's own sketch, or along its H or V axis. */
  private sketchAxis(
    axis: Json,
    profile: Json,
    chain: Chain,
    w: Where,
  ): { object: FcOut; sub: string; reversed: boolean } | undefined {
    const sketch = this.sketchOf(profile);
    const s = sketch ? this.sketchIn(sketch, chain) : undefined;
    const result = sketch ? this.sketchRows.get(sketch)?.result : undefined;
    if (!s || !result) return undefined;
    const line = axisOf(w, axis);
    const toLocal = (p: V3): [number, number] => {
      const d: V3 = [p[0] - result.frame.origin[0], p[1] - result.frame.origin[1], p[2] - result.frame.origin[2]];
      return [dot(d, result.frame.x), dot(d, result.frame.y)];
    };
    const [px, py] = toLocal(line.point);
    const [dx, dy] = [dot(line.direction, result.frame.x), dot(line.direction, result.frame.y)];
    if (Math.abs(dot(line.direction, result.frame.normal)) > 1e-9) return undefined;
    if (Math.abs(py) < 1e-9 && Math.abs(Math.abs(dx) - 1) < 1e-9)
      return { object: s.out, sub: 'H_Axis', reversed: dx < 0 };
    if (Math.abs(px) < 1e-9 && Math.abs(Math.abs(dy) - 1) < 1e-9)
      return { object: s.out, sub: 'V_Axis', reversed: dy < 0 };
    const along = (axis.along as Json | undefined)?.ref as Json | undefined;
    const row = along ? sketchRowOf(w, along) : undefined;
    const n = row?.kind === 'curve' ? s.written.axes.get(row.id) : undefined;
    if (n === undefined) return undefined;
    return {
      object: s.out,
      sub: `Axis${n}`,
      reversed: along && (axis.along as Json).reversed !== undefined ? this.flag((axis.along as Json).reversed) : false,
    };
  }

  private hole(f: Json, chain: Chain, w: Where, brep: string): boolean {
    const i = f.inputs as Json;
    const label = f.name as string;
    const placementInput = i.placement as Json;
    const frame =
      'frame' in placementInput
        ? frameOf(w, placementInput.frame as Json)
        : faceFrameOf(w, placementInput.face as Json);
    const depth = i.depth as Json;
    if (!('distance' in depth) && !('throughAll' in depth)) return false;
    const thread =
      'thread' in (i.thread as Json)
        ? threadSpec({ ...w, inputs: i } as never, (i.thread as Json).thread as Json)
        : undefined;
    // A tapped hole is drilled with the standard's tap drill; FreeCAD's own thread tables hold other clearances.
    const diameter = thread ? thread.size.tapDrill : this.num(i.diameter);
    const centres: [number, number][] = (i.positions as Json[]).map((p) => {
      const at = p.at as Json;
      if ('at' in at) {
        const v = this.values.literal((at.at as Json).v, LENGTH_VECTOR) as unknown as V3;
        return [v[0], v[1]];
      }
      const q = pointAt(w, (at.of as Json).ref as Json);
      const d: V3 = [q[0] - frame.origin[0], q[1] - frame.origin[1], q[2] - frame.origin[2]];
      return [dot(d, frame.x), dot(d, frame.y)];
    });
    const sketch = this.fc.add('Sketcher::SketchObject', `${label} centres`);
    sketch.enumeration('MapMode', 0);
    sketch.placement(placementOf(frame));
    this.sketchShape(sketch, frame);
    const geometry = centres.map(
      ([x, y], g) =>
        `<Geometry type="Part::GeomCircle" id="${g + 1}" migrated="1"><GeoExtensions count="1"><GeoExtension type="Sketcher::SketchGeometryExtension" internalGeometryType="0" geometryModeFlags="00000000000000000000000000000000" geometryLayer="0"/></GeoExtensions><Circle CenterX="${x}" CenterY="${y}" CenterZ="0" NormalX="0" NormalY="0" NormalZ="1" AngleXU="0" Radius="${diameter / 2}"/><Construction value="0"/></Geometry>`,
    );
    sketch.raw(
      'Geometry',
      'Part::PropertyGeometryList',
      `<GeometryList count="${geometry.length}">${geometry.join('')}</GeometryList>`,
    );
    sketch.raw('Constraints', 'Sketcher::PropertyConstraintList', '<ConstraintList count="0"></ConstraintList>');
    sketch.bool('Visibility', false);
    chain.group.push(sketch);

    const out = this.fc.add('PartDesign::Hole', label);
    out.linkSub('Profile', sketch);
    out.length('Diameter', diameter);
    if (!thread) this.ex.bind(out, 'Diameter', i.diameter);
    const through = 'throughAll' in depth;
    out.enumeration('DepthType', through ? 1 : 0);
    if (!through) {
      out.length('Depth', this.num((depth.distance as Json).d));
      this.ex.bind(out, 'Depth', (depth.distance as Json).d);
    }
    const tip = i.tip as Json;
    const angled = 'angle' in tip && !through;
    out.enumeration('DrillPoint', angled ? 1 : 0);
    if (angled) out.angle('DrillPointAngle', this.num((tip.angle as Json).a, ANGLE));
    out.bool('DrillForDepth', false);
    const kind = this.text(i.kind);
    const cut = kind === 'counterbore' ? 1 : kind === 'countersink' ? 2 : 0;
    out.raw(
      'HoleCutType',
      'App::PropertyEnumeration',
      `<Integer value="${cut}" CustomEnum="true"/><CustomEnumList count="4"><Enum value="None"/><Enum value="Counterbore"/><Enum value="Countersink"/><Enum value="Counterdrill"/></CustomEnumList>`,
    );
    out.bool('HoleCutCustomValues', true);
    if (cut === 1) {
      const c = i.counterbore as Json;
      out.length('HoleCutDiameter', this.num(c.diameter));
      out.length('HoleCutDepth', this.num(c.depth));
    } else if (cut === 2) {
      const c = i.countersink as Json;
      out.length('HoleCutDiameter', this.num(c.diameter));
      out.angle('HoleCutCountersinkAngle', this.num(c.angle, ANGLE));
    }
    const fc = thread && freecadThread(thread.size.major, thread.size.pitch);
    out.bool('Threaded', !!fc);
    if (thread && !fc)
      this.note(label, `FreeCAD has no ${thread.size.designation} thread, so the hole is drilled without one`);
    if (thread && fc) {
      out.bool('ModelThread', thread.modelled);
      out.enumeration('ThreadType', fc.type);
      out.raw(
        'ThreadSize',
        'App::PropertyEnumeration',
        `<Integer value="${fc.index}" CustomEnum="true"/><CustomEnumList count="${fc.sizes.length}">${fc.sizes.map((s) => `<Enum value="${s}"/>`).join('')}</CustomEnumList>`,
      );
      out.enumeration('ThreadClass', Math.max(FREECAD_CLASSES.indexOf(thread.class), FREECAD_CLASSES.indexOf('6H')));
      out.enumeration('ThreadDirection', thread.leftHand ? 1 : 0);
      if (!fc.exact)
        this.note(
          label,
          `FreeCAD has no ${thread.size.designation}, so it gets the coarse pitch of M${thread.size.major}`,
        );
      if (thread.modelled)
        this.note(
          label,
          'FreeCAD models this thread with its own profile, so its recompute differs a little from the shape stored here',
        );
    }
    this.solid(out, chain, brep);
    return true;
  }

  /** The one solid shape a Body holds just before a feature: what `EdgeN` and `FaceN` count in. */
  private shapeOf(chain: Chain, before: PartResult): ShapeRef | undefined {
    if (chain.ids.size !== 1) return undefined;
    const body = this.src.bodies(this.part, before).find((b) => chain.ids.has(b.id));
    return body && this.src.ev.adapter.topology(body.ref).solids.length === 1 ? body.ref : undefined;
  }

  /** The `EdgeN` or `FaceN` names of references, by their place in the Body's shape before the feature. */
  private elementNames(
    refs: readonly Json[],
    kind: 'edge' | 'face',
    chain: Chain,
    before: PartResult,
  ): string[] | undefined {
    const { adapter } = this.src.ev;
    const w: Where = { ev: this.src.ev, part: before };
    const shape = this.shapeOf(chain, before);
    if (shape === undefined) return undefined;
    const subs = adapter.subShapes(shape).filter((s) => s.kind === kind);
    const names: string[] = [];
    for (const ref of refs) {
      let found: NamedEntity[];
      try {
        found = entitiesOf(w, ref, 'an element');
      } catch {
        return undefined;
      }
      for (const entity of found) {
        const index = subs.findIndex((s) => s.key === entity.key);
        if (index < 0) return undefined;
        names.push(`${kind === 'edge' ? 'Edge' : 'Face'}${index + 1}`);
      }
    }
    return names;
  }

  private dressUp(f: Json, chain: Chain, before: PartResult, brep: string): boolean {
    const i = f.inputs as Json;
    const label = f.name as string;
    if (!chain.tip) return false;
    const fillet = f.type === 'core.fillet';
    const sets = i.sets as Json[];
    if (sets.length !== 1) return false;
    const set = sets[0] as Json;
    const names = this.elementNames(((set.targets as Json).set as Json[]) ?? [], 'edge', chain, before);
    if (!names || names.length === 0) return false;
    if (fillet) {
      if (this.num(set.setback) !== 0 || !('constant' in (set.radius as Json))) return false;
      const out = this.fc.add('PartDesign::Fillet', label);
      out.linkSub('Base', chain.tip, names);
      const r = (set.radius as Json).constant as Json;
      out.float('Radius', this.num(r.s), 'App::PropertyQuantityConstraint');
      this.ex.bind(out, 'Radius', r.s);
      this.solid(out, chain, brep);
      return true;
    }
    const size = set.size as Json;
    const flip = 'distance' in size ? false : this.chamferFlip(set, chain, before);
    if (flip === undefined) return false;
    const out = this.fc.add('PartDesign::Chamfer', label);
    out.linkSub('Base', chain.tip, names);
    out.bool('FlipDirection', flip);
    if ('distance' in size) {
      out.enumeration('ChamferType', 0);
      out.float('Size', this.num((size.distance as Json).d), 'App::PropertyQuantityConstraint');
      this.ex.bind(out, 'Size', (size.distance as Json).d);
    } else if ('twoDistances' in size) {
      const s = size.twoDistances as Json;
      out.enumeration('ChamferType', 1);
      out.float('Size', this.num(s.d1), 'App::PropertyQuantityConstraint');
      out.float('Size2', this.num(s.d2), 'App::PropertyQuantityConstraint');
    } else {
      const s = size.distanceAngle as Json;
      out.enumeration('ChamferType', 2);
      out.float('Size', this.num(s.d), 'App::PropertyQuantityConstraint');
      out.angle('Angle', this.num(s.angle, ANGLE));
    }
    this.solid(out, chain, brep);
    return true;
  }

  /**
   * FreeCAD lays a chamfer's first size on the first face of an edge, or on the
   * last when flipped, for every edge alike; here it goes on the reference face
   * of each. Undefined when the edges differ.
   */
  private chamferFlip(set: Json, chain: Chain, before: PartResult): boolean | undefined {
    const shape = this.shapeOf(chain, before);
    if (shape === undefined) return undefined;
    const { adapter } = this.src.ev;
    const ctx = { ev: this.src.ev, part: before } as BuildContext;
    const order = new Map(
      adapter
        .subShapes(shape)
        .filter((s) => s.kind === 'face')
        .map((s, i) => [s.key, i]),
    );
    const edges = targetEdges(ctx, [{ targets: set.targets as Json, size: 0 }]).get(shape) ?? [];
    const flips = new Set(
      edges.map((e) => {
        const faces =
          adapter
            .topology(shape)
            .edges.find((x) => x.edge === e.edge)
            ?.faces.map((f) => f.face) ?? [];
        const first = [...faces].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0];
        return referenceFace(ctx, shape, e) !== first;
      }),
    );
    return flips.size === 1 ? [...flips][0] : undefined;
  }

  private shell(f: Json, chain: Chain, before: PartResult, brep: string): boolean {
    const i = f.inputs as Json;
    if (!chain.tip) return false;
    const direction = this.text(i.direction);
    if (direction === 'both') return false;
    const names = this.elementNames(((i.remove as Json).set as Json[]) ?? [], 'face', chain, before);
    if (!names || names.length === 0) return false;
    const out = this.fc.add('PartDesign::Thickness', f.name as string);
    out.linkSub('Base', chain.tip, names);
    out.length('Value', this.num(i.thickness));
    this.ex.bind(out, 'Value', i.thickness);
    out.enumeration('Mode', 0);
    out.enumeration('Join', 1);
    out.bool('Reversed', direction === 'inside');
    this.solid(out, chain, brep);
    return true;
  }

  private primitive(f: Json, chain: Chain, w: Where, brep: string, handles: readonly ShapeHandle[]): boolean {
    const i = f.inputs as Json;
    const op = this.text((i.operation as Json).op);
    if (op === 'intersect') return false;
    const add = op === 'cut' ? 'Subtractive' : 'Additive';
    const shape = i.shape as Json;
    const at = placementOf(frameOf(w, i.frame as Json));
    const label = f.name as string;
    let placed = at;
    let out: FcOut;
    if ('box' in shape) {
      const s = shape.box as Json;
      const [x, y, z] = [this.num(s.width), this.num(s.depth), this.num(s.height)];
      out = this.fc.add(`PartDesign::${add}Box`, label);
      out.length('Length', x);
      out.length('Width', y);
      out.length('Height', z);
      this.ex.bind(out, 'Length', s.width);
      this.ex.bind(out, 'Width', s.depth);
      this.ex.bind(out, 'Height', s.height);
      placed = shift(at, [-x / 2, -y / 2, -z / 2]);
    } else if ('cylinder' in shape) {
      const s = shape.cylinder as Json;
      const h = this.num(s.height);
      out = this.fc.add(`PartDesign::${add}Cylinder`, label);
      out.length('Radius', this.num(s.radius));
      out.length('Height', h);
      this.ex.bind(out, 'Radius', s.radius);
      this.ex.bind(out, 'Height', s.height);
      placed = shift(at, [0, 0, -h / 2]);
    } else if ('sphere' in shape) {
      const s = shape.sphere as Json;
      out = this.fc.add(`PartDesign::${add}Sphere`, label);
      out.length('Radius', this.num(s.radius));
      this.ex.bind(out, 'Radius', s.radius);
    } else if ('cone' in shape) {
      const s = shape.cone as Json;
      const h = this.num(s.height);
      out = this.fc.add(`PartDesign::${add}Cone`, label);
      out.length('Radius1', this.num(s.bottomRadius));
      out.length('Radius2', this.num(s.topRadius));
      out.length('Height', h);
      placed = shift(at, [0, 0, -h / 2]);
    } else if ('torus' in shape) {
      const s = shape.torus as Json;
      out = this.fc.add(`PartDesign::${add}Torus`, label);
      out.length('Radius1', this.num(s.majorRadius));
      out.length('Radius2', this.num(s.minorRadius));
    } else return false;
    out.placement(placed);
    out.enumeration('MapMode', 0);
    this.solid(out, chain, this.brepAt(handles, placed));
    chain.brep = brep;
    return true;
  }

  private originals(of: Json, out: FcOut): boolean {
    if ('features' in of) {
      const ids = ((of.features as Json).set as Json[]).map(
        (r) => ((r.object as Json | undefined)?.feature as Json | undefined)?.id as string | undefined,
      );
      const objects = ids.map((id) => (id ? this.features.get(id) : undefined));
      if (objects.some((o) => o === undefined)) return false;
      out.linkList('Originals', objects as FcOut[]);
      out.enumeration('TransformMode', 0);
      return true;
    }
    if ('bodies' in of) {
      out.linkList('Originals', []);
      out.enumeration('TransformMode', 1);
      return true;
    }
    return false;
  }

  private pattern(f: Json, chain: Chain, w: Where, brep: string): boolean {
    const i = f.inputs as Json;
    const label = f.name as string;
    const layout = i.layout as Json;
    if ((i.vary as Json[]).length > 0 || ((i.skip as Json).set as Json[]).length > 0) return false;
    const rows = 'linear' in layout ? ((layout.linear as Json).directions as Json[]) : [];
    let out: FcOut | undefined;
    if (rows.some((r) => !this.linearWritable(r))) return false;
    if (rows.length === 2) {
      // Two directions are two patterns in one MultiTransform.
      const steps = rows.map((r, n) => this.linear(r, `${label} direction ${n + 1}`, chain, w));
      if (steps.some((s) => s === undefined)) return false;
      out = this.transforms(steps as FcOut[], chain, label);
    } else out = this.layoutObject(layout, label, chain, w);
    if (!out) return false;
    if (!this.originals(i.of as Json, out)) {
      this.fc.objects.splice(this.fc.objects.indexOf(out), 1);
      return false;
    }
    this.solid(out, chain, brep);
    return true;
  }

  /** Whether a direction of a linear layout is a FreeCAD LinearPattern: equal spacing, all copies on one side of the seed. */
  private linearWritable(r: Json): boolean {
    return 'equal' in (r.spacing as Json) && !(r.symmetric !== undefined && this.flag(r.symmetric));
  }

  /** One direction of a linear layout, as a pattern. */
  private linear(r: Json, name: string, chain: Chain, w: Where): FcOut | undefined {
    if (!this.linearWritable(r)) return undefined;
    const o = this.fc.add('PartDesign::LinearPattern', name);
    const link = this.axisLink(chain, name, [0, 0, 0], directionOf(w, r.direction as Json));
    const count = this.values.literal(r.count, INTEGER) as number;
    const s = this.num(((r.spacing as Json).equal as Json).s);
    o.linkSub('Direction', link.object, ['']);
    // FreeCAD's Length and Offset are not negative: a step against the direction reverses it.
    o.bool('Reversed', link.reversed !== s < 0);
    o.integer('Occurrences', count, 'App::PropertyIntegerConstraint');
    o.length('Length', Math.abs(s) * (count - 1));
    o.length('Offset', Math.abs(s));
    o.enumeration('Mode', 1);
    return o;
  }

  /** A layout of one direction or a circle, as a pattern. */
  private layoutObject(layout: Json, name: string, chain: Chain, w: Where): FcOut | undefined {
    if ('linear' in layout) {
      const rows = (layout.linear as Json).directions as Json[];
      return rows.length === 1 ? this.linear(rows[0] as Json, name, chain, w) : undefined;
    }
    if (!('circular' in layout)) return undefined;
    const c = layout.circular as Json;
    if (this.flag(c.symmetric)) return undefined;
    const line = axisOf(w, c.axis as Json);
    const o = this.fc.add('PartDesign::PolarPattern', name);
    const link = this.axisLink(chain, name, line.point, line.direction);
    const angle = this.num(c.angle, ANGLE);
    o.linkSub('Axis', link.object, ['']);
    // FreeCAD's Angle runs from 0 to 360: a turn the other way reverses the axis.
    o.bool('Reversed', link.reversed !== angle < 0);
    o.angle('Angle', Math.abs(angle));
    o.integer('Occurrences', this.values.literal(c.count, INTEGER) as number, 'App::PropertyIntegerConstraint');
    o.enumeration('Mode', 0);
    return o;
  }

  /** The transformations a MultiTransform holds stay in its Body, and it lists them. */
  private transforms(steps: readonly FcOut[], chain: Chain, label: string): FcOut {
    for (const s of steps) {
      s.bool('Visibility', false);
      chain.group.push(s);
    }
    const out = this.fc.add('PartDesign::MultiTransform', label);
    out.linkList('Transformations', steps);
    return out;
  }

  private chainOf(f: Json, chain: Chain, w: Where, brep: string): boolean {
    const i = f.inputs as Json;
    const label = f.name as string;
    const steps: FcOut[] = [];
    for (const [n, row] of (i.steps as Json[]).entries()) {
      const step = row.step as Json;
      const name = `${label} step ${n + 1}`;
      let o: FcOut | undefined;
      if ('mirror' in step) {
        const plane = this.planeLink((step.mirror as Json).plane as Json, chain, w);
        if (plane) {
          o = this.fc.add('PartDesign::Mirrored', name);
          o.linkSub('MirrorPlane', plane, ['']);
        }
      } else o = this.layoutObject(step, name, chain, w);
      if (!o) return false;
      steps.push(o);
    }
    const out = this.transforms(steps, chain, label);
    if (!this.originals(i.of as Json, out)) return false;
    this.solid(out, chain, brep);
    return true;
  }

  /** The object FreeCAD links for a plane: an origin plane or a datum plane. */
  private planeLink(plane: Json, chain: Chain, w: Where): FcOut | undefined {
    if ('standard' in plane) {
      const p = FC_PLANES[(plane.standard as Json).name as string];
      return p && chain.origin.get(p.name);
    }
    const c = constructionOf(w, plane);
    const id = (((plane.object as Json | undefined)?.feature as Json | undefined)?.id ?? undefined) as
      string | undefined;
    return c && id ? this.datums.get(id) : undefined;
  }

  private draft(f: Json, chain: Chain, w: Where, before: PartResult, brep: string): boolean {
    const i = f.inputs as Json;
    if (!chain.tip) return false;
    const names = this.elementNames(((i.faces as Json).set as Json[]) ?? [], 'face', chain, before);
    if (!names || names.length === 0) return false;
    const neutral = i.neutral as Json;
    const plane = this.planeLink(neutral, chain, w);
    const face = plane ? undefined : this.elementNames([neutral], 'face', chain, before);
    if (!plane && (!face || face.length !== 1)) return false;
    const normal =
      'standard' in neutral
        ? (FC_PLANES[(neutral.standard as Json).name as string] as { frame: Frame }).frame.normal
        : undefined;
    const pull = directionOf(w, i.pull as Json);
    const angle = this.num(i.angle, ANGLE);
    const along = normal ? dot(pull, normal) : 1;
    if (Math.abs(Math.abs(along) - 1) > 1e-9 || along < 0 !== angle < 0) return false;
    const out = this.fc.add('PartDesign::Draft', f.name as string);
    out.linkSub('Base', chain.tip, names);
    out.linkSub('NeutralPlane', plane ?? chain.tip, plane ? [''] : face);
    out.float('Angle', Math.abs(angle), 'App::PropertyAngle');
    out.bool('Reversed', along < 0);
    this.solid(out, chain, brep);
    return true;
  }

  private coil(f: Json, chain: Chain, w: Where, brep: string): boolean {
    const i = f.inputs as Json;
    const label = f.name as string;
    const op = this.text((i.operation as Json).op);
    const section = i.section as Json;
    if (op === 'intersect' || !('profiles' in section) || !('pitch' in (i.advance as Json))) return false;
    const profile = this.profile(((section.profiles as Json).set as Json[]) ?? [], chain, label);
    if (!profile) return false;
    const line = axisOf(w, i.axis as Json);
    const out = this.fc.add(op === 'cut' ? 'PartDesign::SubtractiveHelix' : 'PartDesign::AdditiveHelix', label);
    out.linkSub('Profile', profile);
    const link = this.axisLink(chain, label, line.point, line.direction);
    out.linkSub('ReferenceAxis', link.object, ['']);
    out.bool('Reversed', link.reversed);
    out.enumeration('Mode', 0);
    out.length('Pitch', this.num(((i.advance as Json).pitch as Json).p));
    out.length('Height', this.num(i.height));
    out.bool('LeftHanded', i.handedness !== undefined && this.text(i.handedness) === 'left');
    this.solid(out, chain, brep);
    return true;
  }

  private mirror(f: Json, chain: Chain, w: Where, brep: string): boolean {
    const i = f.inputs as Json;
    const label = f.name as string;
    const link = this.planeLink(i.plane as Json, chain, w);
    if (!link) return false;
    const out = this.fc.add('PartDesign::Mirrored', label);
    out.linkSub('MirrorPlane', link, ['']);
    if (!this.originals(i.of as Json, out)) {
      this.fc.objects.splice(this.fc.objects.indexOf(out), 1);
      return false;
    }
    this.solid(out, chain, brep);
    return true;
  }

  private loft(f: Json, chain: Chain, brep: string): boolean {
    const i = f.inputs as Json;
    const label = f.name as string;
    if ((i.rails as Json[]).length > 0 || i.centerline !== undefined) return false;
    const op = this.text((i.operation as Json).op);
    if (op === 'intersect') return false;
    const sketches: FcOut[] = [];
    for (const row of i.sections as Json[]) {
      const section = row.section as Json;
      if (!('profiles' in section)) return false;
      const s = this.profile(((section.profiles as Json).set as Json[]) ?? [], chain, label);
      if (!s) return false;
      sketches.push(s);
    }
    const out = this.fc.add(op === 'cut' ? 'PartDesign::SubtractiveLoft' : 'PartDesign::AdditiveLoft', label);
    out.linkSub('Profile', sketches[0]);
    out.linkSubList(
      'Sections',
      sketches.slice(1).map((o): LinkSub => ({ object: o, subs: [] })),
    );
    out.bool('Ruled', this.flag(i.ruled));
    out.bool('Closed', this.flag(i.closed));
    this.solid(out, chain, brep);
    return true;
  }

  private sweep(f: Json, chain: Chain, w: Where, brep: string): boolean {
    const i = f.inputs as Json;
    const label = f.name as string;
    const rows = i.sections as Json[];
    const section = (rows[0] as Json).section as Json;
    if (rows.length !== 1 || !('profiles' in section) || i.twist !== undefined || i.scale !== undefined) return false;
    const orientation = i.orientation as Json;
    if ('guide' in orientation) return false;
    const op = this.text((i.operation as Json).op);
    if (op === 'intersect') return false;
    const profile = this.profile(((section.profiles as Json).set as Json[]) ?? [], chain, label);
    if (!profile) return false;
    const path = i.path as Json[];
    const rowsOf = path.map((r) => sketchRowOf(w, r));
    const sketchId = rowsOf[0]
      ? [...w.part.sketches.entries()].find(([, s]) => s === rowsOf[0]?.sketch)?.[0]
      : undefined;
    if (!sketchId || rowsOf.some((r) => !r || r.sketch !== rowsOf[0]?.sketch)) return false;
    const spine = this.sketchIn(sketchId, chain);
    if (!spine) return false;
    const live = ((this.sketchRows.get(sketchId)?.row.curves as Json[]) ?? []).filter(
      (c) => !this.flag(c.construction),
    );
    const out = this.fc.add(op === 'cut' ? 'PartDesign::SubtractivePipe' : 'PartDesign::AdditivePipe', label);
    out.linkSub('Profile', profile);
    // FreeCAD numbers a sketch's edges over what is not construction.
    const subs =
      live.length === path.length ? [] : rowsOf.map((r) => `Edge${live.findIndex((c) => c.id === r?.id) + 1}`);
    out.linkSub('Spine', spine.out, subs);
    out.enumeration('Mode', 'fixed' in orientation ? 1 : 0);
    out.enumeration('Transition', 1);
    this.solid(out, chain, brep);
    return true;
  }

  /** The chain continues from the solid built here, stored: what came before stays in the Body as history. */
  private keep(f: Json, chain: Chain, brep: string): void {
    const label = f.name as string;
    const stored = this.fc.add('Part::Feature', `${label} (stored)`);
    stored.shape(brep);
    stored.bool('Visibility', false);
    const base = this.fc.add('PartDesign::FeatureBase', label);
    base.link('BaseFeature', stored);
    base.shape(brep);
    base.bool('Visibility', false);
    chain.group.push(base);
    chain.tip = base;
    chain.brep = brep;
  }

  private datum(f: Json, kind: string, result: PartResult): void {
    const output = result.construction.get(f.id as string);
    if (!output) return;
    const chain = this.anyChain();
    const type = {
      plane: 'PartDesign::Plane',
      axis: 'PartDesign::Line',
      point: 'PartDesign::Point',
      frame: 'PartDesign::CoordinateSystem',
    }[kind] as string;
    const out = this.fc.add(type, f.name as string);
    out.enumeration('MapMode', 0);
    out.placement(placementOf(output.frame));
    out.bool('Visibility', false);
    chain.group.push(out);
    this.datums.set(f.id as string, out);
  }

  run(): void {
    const { row, steps } = this.part;
    const timeline = (row.timeline as Json[]) ?? [];
    const rollback = ((row.rollback as Json | undefined)?.before as Json | undefined)?.id as string | undefined;
    const stop = rollback === undefined ? timeline.length : timeline.findIndex((f) => f.id === rollback);
    const empty: PartResult = { ...this.part.result, shapes: new Map(), sketches: new Map(), construction: new Map() };
    let live = new Map<string, LiveBody>();
    let before: PartResult = empty;
    for (let n = 0; n < stop; n++) {
      const f = timeline[n] as Json;
      const after = steps[n];
      const label = f.name as string;
      if (!after) continue;
      if (this.flag(f.suppressed)) {
        this.note(label, 'it is suppressed, so it was left out');
        before = after;
        continue;
      }
      const type = f.type as string;
      if (type === 'core.sketch') {
        const result = after.sketches.get(f.id as string);
        if (result) this.sketchRows.set(f.id as string, { row: f.inputs as Json, name: label, result });
        before = after;
        continue;
      }
      if (type.startsWith('core.construction')) {
        this.datum(f, type.replace('core.construction', '').toLowerCase(), after);
        before = after;
        continue;
      }
      const now = new Map(this.src.bodies(this.part, after).map((b) => [b.id, b]));
      const created = [...now.keys()].filter((b) => !live.has(b));
      const removed = [...live.keys()].filter((b) => !now.has(b));
      const changed = [...now.keys()].filter((b) => live.has(b) && live.get(b)?.ref !== now.get(b)?.ref);
      if (created.length + removed.length + changed.length === 0) {
        if (type !== 'core.measure') this.note(label, 'it changes no solid here, so it was left out');
        before = after;
        live = now;
        continue;
      }
      const owners = new Set(this.chains.filter((c) => [...removed, ...changed].some((b) => c.ids.has(b))));
      // A feature on several Bodies at once: each goes on from what it built there.
      if (owners.size > 1 && removed.length === 0 && created.length === 0) {
        for (const c of owners) {
          const shapes = [...c.ids].flatMap((b) => {
            const h = now.get(b)?.handle;
            return h === undefined ? [] : [h];
          });
          if (shapes.length > 0) this.keep(f, c, this.brepOf(shapes));
        }
        this.note(label, 'it changes several Bodies at once, so each is stored as the solid it built');
        before = after;
        live = now;
        continue;
      }
      // Copies of a body stay with it: FreeCAD transforms a whole Body in place.
      if (owners.size === 0) {
        const source = this.copiedChain(f, before);
        if (source) owners.add(source);
      }
      const chain = owners.size > 0 ? ([...owners][0] as Chain) : this.freshChain();
      for (const other of [...owners].slice(1)) {
        // The feature joins Bodies: what it built stands in the first, and the others end here.
        for (const b of other.ids) chain.ids.add(b);
        other.ids.clear();
      }
      for (const b of removed) chain.ids.delete(b);
      for (const b of created) chain.ids.add(b);
      const handles = [...chain.ids].flatMap((b) => {
        const h = now.get(b)?.handle;
        return h === undefined ? [] : [h];
      });
      if (handles.length === 0) {
        chain.tip = undefined;
        chain.brep = undefined;
        before = after;
        live = now;
        continue;
      }
      const brep = this.brepOf(handles);
      const w: Where = { ev: this.src.ev, part: before };
      let done = false;
      if (owners.size <= 1) {
        try {
          done = this.write(f, chain, w, before, brep, handles);
        } catch (e) {
          this.note(
            label,
            `it could not be written as a FreeCAD feature: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (done) this.features.set(f.id as string, chain.tip as FcOut);
      else {
        this.note(label, 'it has no FreeCAD feature here, so it is stored as the solid it built');
        this.keep(f, chain, brep);
      }
      before = after;
      live = now;
    }
    for (const c of this.chains) {
      const body = [...c.ids].flatMap((b) => live.get(b) ?? [])[0];
      if (body)
        c.look = {
          ...(body.color ? { color: body.color } : {}),
          ...(body.opacity !== undefined ? { opacity: body.opacity } : {}),
        };
    }
    if (rollback !== undefined)
      this.note(this.label, 'it is rolled back, so the features after that point were left out');
    if (this.chains.length === 0) this.chain(this.label);
    // Sketches nothing used stay with the first Body.
    for (const id of this.sketchRows.keys())
      if (!this.chains.some((c) => c.sketches.has(id))) this.sketchIn(id, this.chains[0] as Chain);
  }

  /** The Body holding what a pattern or mirror of bodies copies, when one does. */
  private copiedChain(f: Json, before: PartResult): Chain | undefined {
    if (f.type !== 'core.pattern' && f.type !== 'core.mirror') return undefined;
    const of = (f.inputs as Json).of as Json;
    const refs = ((of.bodies as Json | undefined)?.set as Json[] | undefined) ?? [];
    const w: Where = { ev: this.src.ev, part: before };
    const ids = new Set(this.src.bodies(this.part, before).map((b) => b.id));
    for (const ref of refs) {
      const entity = entitiesOf(w, ref, 'a body')[0];
      if (!entity) continue;
      const id = bodyIdentity(entity);
      if (ids.has(id)) return this.chains.find((c) => c.ids.has(id));
    }
    return undefined;
  }

  private freshChain(): Chain {
    const first = this.chains[0];
    if (first && first.tip === undefined) return first;
    const n = this.chains.length;
    return this.chain(n === 0 ? this.label : `${this.label} ${n + 1}`);
  }

  private write(
    f: Json,
    chain: Chain,
    w: Where,
    before: PartResult,
    brep: string,
    handles: readonly ShapeHandle[],
  ): boolean {
    switch (f.type) {
      case 'core.extrude':
        return this.extrude(f, chain, w, brep);
      case 'core.revolve':
        return this.revolve(f, chain, w, brep);
      case 'core.hole':
        return this.hole(f, chain, w, brep);
      case 'core.fillet':
      case 'core.chamfer':
        return this.dressUp(f, chain, before, brep);
      case 'core.shell':
        return this.shell(f, chain, before, brep);
      case 'core.primitive':
        return this.primitive(f, chain, w, brep, handles);
      case 'core.pattern':
        return this.pattern(f, chain, w, brep);
      case 'core.mirror':
        return this.mirror(f, chain, w, brep);
      case 'core.transformChain':
        return this.chainOf(f, chain, w, brep);
      case 'core.draft':
        return this.draft(f, chain, w, before, brep);
      case 'core.coil':
        return this.coil(f, chain, w, brep);
      case 'core.loft':
        return this.loft(f, chain, brep);
      case 'core.sweep':
        return this.sweep(f, chain, w, brep);
      default:
        return false;
    }
  }

  /** Closes each Body: its group, tip and shape. */
  finish(placement: FcPlacement, shown: boolean): { body: string; features: string[] }[] {
    const out: { body: string; features: string[] }[] = [];
    for (const c of this.chains) {
      c.body.linkList('Group', c.group);
      c.body.link('Tip', c.tip);
      c.body.link('Origin', c.origin.get('root'));
      c.body.link('BaseFeature', undefined);
      c.body.bool('AllowCompound', true);
      c.body.placement(placement);
      c.body.bool('Visibility', shown && c.ids.size > 0);
      this.fc.view(c.body, { ...c.look, visible: shown && c.ids.size > 0 });
      if (c.brep !== undefined) c.body.shape(c.brep);
      out.push({ body: c.body.label, features: c.group.map((g) => g.label) });
    }
    return out;
  }
}

/** Writes the document. `source` holds its evaluation. */
export function exportFcstd(source: ExportSource): FcstdExport {
  const { doc, ev } = source;
  const label = String((doc.metadata as Json | undefined)?.name ?? 'Model');
  const fc = new FcFile(label);
  const notes: ExportNote[] = [];
  const ex = new Expressions(fc, ev.values);
  for (const table of (doc.parameters as Json[]) ?? []) ex.table(table);
  const bodies: FcstdExport['bodies'] = [];
  const writers: { part: ExportPart; writer: PartWriter }[] = [];
  for (const part of source.parts) {
    for (const table of (part.row.parameters as Json[]) ?? []) ex.table(table);
    const writer = new PartWriter(fc, source, part, ex, notes);
    writer.run();
    writers.push({ part, writer });
  }
  const placedOnce = new Set<string>();
  const links: { part: string; placement: FcPlacement }[] = [];
  for (const i of source.instances) {
    if (placedOnce.has(i.part)) links.push(i);
    placedOnce.add(i.part);
  }
  const bodiesOf = new Map<string, string>();
  for (const { part, writer } of writers) {
    const first = source.instances.find((i) => i.part === part.id);
    // With nothing placed the document shows its root part, or every part when the root is not one.
    const unplaced = source.instances.length + source.placedShapes.length === 0;
    const root = ((doc.root as Json | undefined)?.part as Json | undefined)?.id;
    const made = writer.finish(
      first?.placement ?? IDENTITY,
      first !== undefined || (unplaced && (root === undefined || root === part.id)),
    );
    if (made[0]) bodiesOf.set(part.id, made[0].body);
    bodies.push(...made.map((m) => ({ part: part.id, ...m })));
  }
  for (const l of links) {
    const target = fc.objects.find((o) => o.label === bodiesOf.get(l.part) && o.type === 'PartDesign::Body');
    if (!target) continue;
    const link = fc.add('App::Link', target.label);
    link.raw('LinkedObject', 'App::PropertyXLink', `<XLink name="${target.name}"/>`);
    link.placement(l.placement);
    link.placement(l.placement, 'LinkPlacement');
  }
  for (const s of source.placedShapes) {
    const out = fc.add('Part::Feature', s.label);
    out.placement(s.placement);
    const located = ev.kernel.located(s.handle, matrixOf(s.placement));
    out.shape(ev.kernel.toBREP(located));
    ev.kernel.release(located);
  }
  return { bytes: fc.bytes(), notes, bodies };
}
