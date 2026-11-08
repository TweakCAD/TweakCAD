/**
 * Sketch records: points, curves, relations and dimensions.
 *
 * A sketch's base level names its placement and lists the records it owns. An
 * analytic curve stores twelve doubles followed by references to its points, and
 * those references anchor the read because what comes before them varies with
 * the class version. Points and curves share the point records they reference,
 * which is how a closed profile stays joined.
 */

import type { DesignIndex, RecordRange } from './designIndex';
import { isKindOf, primaryRange, readPrologue, refAt, refsIn, secondaryRange } from './designIndex';
import { ByteReader, F3dFormatError } from './byteReader';
import { readComponentPlacement, multiply, rigidMatrixAt } from './components';
import type {
  F3dCurve,
  F3dDimension,
  F3dDimensionKind,
  F3dMatrix,
  F3dParameter,
  F3dPoint,
  F3dRelation,
  F3dRelationKind,
  F3dSketch,
} from './types';

const TYPE_SKETCH = '44A64366';
const TYPE_PLACEMENT = 'F47A46FB';
const TYPE_COMPONENT = 'E03784ED';
const TYPE_POINT = 'C2CEDAE7';
const TYPE_LINE = 'DCA267ED';
const TYPE_CIRCLE_OR_ARC = 'F0130424';
const TYPE_ELLIPSE = 'FF23079A';
const TYPE_SPLINE = 'D82E012F';
const TYPE_RELATION = '60403D47';
const TYPE_PARAMETER_OWNER = 'D91D429C';
/** Line subclasses that belong to a text's box or an ellipse's axes, not to the drawing. */
const HELPER_LINES = new Set(['EA3B930A', '16DEFC4D', '58751243']);
const TYPE_TEXT = new Set(['F0B1AFA3', 'E0618268']);

const DIMENSION_TYPES: Record<string, F3dDimensionKind> = {
  '8C780195': 'linear',
  '664AD49F': 'diameter',
  '8EDAC24D': 'radial',
  '6EEAFDE5': 'angular',
};

const RELATION_KINDS: Record<number, F3dRelationKind> = {
  0x1: 'coincident',
  0x2: 'collinear',
  0x4: 'concentric',
  0x10: 'parallel',
  0x20: 'perpendicular',
  0x40: 'horizontal',
  0x80: 'vertical',
  0x100: 'tangent',
  0x400: 'symmetric',
  0x800: 'equal',
  0x1000: 'midpoint',
};

const PAYLOAD_BYTES = 96;
/** Early lines store start, displacement and direction only. */
const SHORTEST_LINE_PAYLOAD_BYTES = 72;
const POINT_FLAG_BYTES = [8, 7];
const isCoordinate = (v: number): boolean => v === 0 || (Math.abs(v) > 1e-60 && Math.abs(v) < 1e9);
const TWO_PI = Math.PI * 2;

const view = (index: DesignIndex) => new DataView(index.bulk.buffer, index.bulk.byteOffset, index.bulk.byteLength);

function doubles(index: DesignIndex, pos: number, count: number): number[] {
  const v = view(index);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(v.getFloat64(pos + i * 8, true));
  return out;
}

function readPoint(index: DesignIndex, range: RecordRange): F3dPoint {
  const { next } = readPrologue(index, range);
  const incidence = refAt(index.bulk, next, range.end);
  if (!incidence) throw new F3dFormatError(`Point ${range.id} has no incidence reference`);
  // The flags before the coordinates differ in length by a byte between
  // generations. Read one byte off, a coordinate turns into a denormal.
  for (const flagBytes of POINT_FLAG_BYTES) {
    const r = new ByteReader(index.bulk, incidence.next, range.end);
    r.skip(flagBytes);
    const [x, y, z] = [r.f64(), r.f64(), r.f64()];
    if (isCoordinate(x) && isCoordinate(y) && isCoordinate(z)) return { id: range.id, x, y, z };
  }
  throw new F3dFormatError(`Point ${range.id} has no coordinates`);
}

/** The run of point references after a curve's payload: where it starts, and what it names. */
function pointRefs(
  index: DesignIndex,
  range: RecordRange,
  from: number,
  payloadBytes = PAYLOAD_BYTES,
): { start: number; ids: number[]; next: number } {
  for (let p = from + payloadBytes; p + 11 <= range.end; p++) {
    const first = refAt(index.bulk, p, range.end);
    if (!first || !isKindOf(index, index.typeOf.get(first.id)?.key, TYPE_POINT)) continue;
    const ids = [first.id];
    let next = first.next;
    for (;;) {
      const ref = refAt(index.bulk, next, range.end);
      if (!ref || !isKindOf(index, index.typeOf.get(ref.id)?.key, TYPE_POINT)) break;
      ids.push(ref.id);
      next = ref.next;
    }
    return { start: p, ids, next };
  }
  throw new F3dFormatError(`Curve ${range.id} names no points`);
}

/**
 * Offset of the construction flag after a curve's last point reference, by the
 * length of what follows that reference. Layouts differ between generations.
 * Worked out from which byte is never set on curves that profiles use, so it is
 * reliable rather than certain.
 */
const CONSTRUCTION_FLAG_OFFSET: Record<number, number> = { 49: 0, 51: 2, 52: 6, 53: 7, 54: 8, 56: 6, 57: 7, 58: 8 };
/** The owner reference at the end of a record gains a type GUID in one generation. */
const TYPED_REFERENCE_EXTRA_BYTES = 40;

function readConstruction(index: DesignIndex, range: RecordRange, afterRefs: number): boolean {
  const tail = range.end - afterRefs;
  const offset = CONSTRUCTION_FLAG_OFFSET[tail] ?? CONSTRUCTION_FLAG_OFFSET[tail - TYPED_REFERENCE_EXTRA_BYTES];
  return offset !== undefined && index.bulk[afterRefs + offset] === 1;
}

const curveKey = (properties: Map<string, number>) => ({
  primaryId: properties.get('crv_primary_id') ?? 0,
  secondaryId: properties.get('crv_secondary_id') ?? 0,
});

function readLine(index: DesignIndex, range: RecordRange): F3dCurve {
  const { next, properties } = readPrologue(index, range);
  const refs = pointRefs(index, range, next, SHORTEST_LINE_PAYLOAD_BYTES);
  if (refs.ids.length < 2) throw new F3dFormatError(`Line ${range.id} names one point`);
  return {
    kind: 'line',
    id: range.id,
    ...curveKey(properties),
    endId: refs.ids[0] as number,
    startId: refs.ids[1] as number,
    construction: readConstruction(index, range, refs.next),
  };
}

function readCircleOrArc(index: DesignIndex, range: RecordRange, points: Map<number, F3dPoint>): F3dCurve {
  const { next, properties } = readPrologue(index, range);
  const refs = pointRefs(index, range, next);
  const [cx, cy, , nx, ny, nz, xx, xy, xz, radius, startAngle, endAngle] = doubles(
    index,
    refs.start - PAYLOAD_BYTES,
    12,
  ) as [number, number, number, number, number, number, number, number, number, number, number, number];
  const construction = readConstruction(index, range, refs.next);
  if (refs.ids.length === 1) {
    return {
      kind: 'circle',
      id: range.id,
      ...curveKey(properties),
      centerId: refs.ids[0] as number,
      radius,
      construction,
    };
  }
  const near = (id: number, x: number, y: number) => {
    const p = points.get(id);
    return p ? Math.hypot(p.x - x, p.y - y) : Infinity;
  };
  const centerId = [...refs.ids].sort((a, b) => near(a, cx, cy) - near(b, cx, cy))[0] as number;
  const ends = refs.ids.filter((id) => id !== centerId);

  // The file's angles run about its normal from its x axis. Which reference is
  // the start follows from where that puts the first angle.
  const yx = ny * xz - nz * xy;
  const yy = nz * xx - nx * xz;
  const at = (angle: number): [number, number] => [
    cx + radius * (Math.cos(angle) * xx + Math.sin(angle) * yx),
    cy + radius * (Math.cos(angle) * xy + Math.sin(angle) * yy),
  ];
  const [sx, sy] = at(startAngle);
  const [a, b] = [ends[0] as number, ends[1] ?? (ends[0] as number)];
  const startId = near(a, sx, sy) <= near(b, sx, sy) ? a : b;
  const endId = startId === a ? b : a;
  return {
    kind: 'arc',
    id: range.id,
    ...curveKey(properties),
    centerId,
    startId,
    endId,
    center: [cx, cy],
    start: [sx, sy],
    end: at(endAngle),
    radius,
    counterClockwise: nz >= 0,
    construction,
  };
}

function readEllipse(index: DesignIndex, range: RecordRange): F3dCurve {
  const { next, properties } = readPrologue(index, range);
  const refs = pointRefs(index, range, next);
  const v = doubles(index, refs.start - PAYLOAD_BYTES, 13);
  return {
    kind: 'ellipse',
    id: range.id,
    ...curveKey(properties),
    centerId: refs.ids[0] as number,
    center: [v[0] as number, v[1] as number],
    majorAxis: [v[3] as number, v[4] as number],
    minorAxis: [v[6] as number, v[7] as number],
    majorRadius: v[9] as number,
    minorRadius: v[10] as number,
    startAngle: v[11] as number,
    endAngle: (v[11] as number) === 0 && Math.abs((v[12] as number) - TWO_PI) < 1e-9 ? TWO_PI : (v[12] as number),
    construction: readConstruction(index, range, refs.next),
  };
}

/** `u32 n, u32 n, u32 8`, then n elements of `width` doubles. */
function readArray(r: ByteReader, width: number): number[] {
  const n = r.count(0);
  const again = r.u32();
  const elementBytes = r.u32();
  if (n !== again || elementBytes !== 8 || n * width * 8 > r.remaining) {
    throw new F3dFormatError('Malformed spline array');
  }
  const out: number[] = [];
  for (let i = 0; i < n * width; i++) out.push(r.f64());
  return out;
}

function readSpline(index: DesignIndex, id: number): F3dCurve {
  const primary = primaryRange(index, id);
  const key = primary ? curveKey(readPrologue(index, primary).properties) : { primaryId: 0, secondaryId: 0 };
  const range = secondaryRange(index, id);
  if (!range) throw new F3dFormatError(`Spline ${id} has no base level`);
  const refs = refsIn(index, range.start, range.end);
  const endRef = refs.findIndex((r) => isKindOf(index, index.typeOf.get(r.id)?.key, TYPE_POINT));
  const start = refs[endRef + 1];
  if (endRef < 0 || !start) throw new F3dFormatError(`Spline ${id} names no end points`);

  const r = new ByteReader(index.bulk, start.next, range.end);
  r.skip(2);
  const degree = r.u32();
  r.f64(); // fit tolerance
  const knots = readArray(r, 1);
  const weights = readArray(r, 1);
  const flat = readArray(r, 3);
  const poles: [number, number][] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) poles.push([flat[i] as number, flat[i + 1] as number]);
  if (degree < 1 || poles.length <= degree || knots.length === 0) {
    throw new F3dFormatError(`Spline ${id} has an impossible shape`);
  }
  return {
    kind: 'spline',
    id,
    ...key,
    startId: start.id,
    endId: (refs[endRef] as { id: number }).id,
    degree,
    knots,
    weights,
    poles,
    construction: false,
  };
}

function readRelation(index: DesignIndex, id: number): { sketchId: number; relation: F3dRelation } {
  const range = primaryRange(index, id);
  if (!range) throw new F3dFormatError(`Relation ${id} has no record`);
  const { leading, next } = readPrologue(index, range);
  const sketch = refAt(index.bulk, next, range.end);
  if (!sketch) throw new F3dFormatError(`Relation ${id} names no sketch`);
  const r = new ByteReader(index.bulk, sketch.next, range.end);
  const mask = r.u32();
  return {
    sketchId: sketch.id,
    relation: { id, kind: RELATION_KINDS[mask] ?? 'unknown', loci: leading.filter((l) => l !== 0) },
  };
}

function readDimension(
  index: DesignIndex,
  id: number,
  kind: F3dDimensionKind,
  parameterOf: Map<number, F3dParameter>,
): { sketchId: number; dimension: F3dDimension } {
  const range = primaryRange(index, id);
  const base = secondaryRange(index, id);
  if (!range || !base) throw new F3dFormatError(`Dimension ${id} has no record`);

  const sketchRef = refsIn(index, base.start, base.end).find((r) => index.typeOf.get(r.id)?.key === TYPE_SKETCH);
  if (!sketchRef) throw new F3dFormatError(`Dimension ${id} names no sketch`);

  const owners = refsIn(index, range.start, range.end).filter(
    (r) => index.typeOf.get(r.id)?.key === TYPE_PARAMETER_OWNER,
  );
  const owner = owners[owners.length - 1];
  if (!owner) throw new F3dFormatError(`Dimension ${id} names no parameter`);

  const r = new ByteReader(index.bulk, owner.next, range.end);
  const count = r.count(11);
  const loci: number[] = [];
  for (let i = 0; i < count; i++) {
    const ref = refAt(index.bulk, r.pos, range.end);
    if (!ref) throw new F3dFormatError(`Dimension ${id} has an unreadable locus`);
    r.pos = ref.next;
    if (ref.id !== 0) loci.push(ref.id);
  }

  const horizontal = index.bulk[owner.pos - 6] === 0x40;
  const vertical = index.bulk[owner.pos - 6] === 0x80;
  return {
    sketchId: sketchRef.id,
    dimension: {
      id,
      kind,
      direction: horizontal ? 'horizontal' : vertical ? 'vertical' : 'aligned',
      loci,
      parameter: parameterOf.get(owner.id) ?? null,
    },
  };
}

type SketchHead = { placementId: number | null; name: string; owned: number[] };

function readSketchHead(index: DesignIndex, id: number): SketchHead {
  const range = secondaryRange(index, id);
  if (!range) throw new F3dFormatError(`Sketch ${id} has no base level`);
  const r = new ByteReader(index.bulk, range.start, range.end);
  r.str8(); // class tag
  r.u64(); // id
  r.str8(); // name of the record itself, empty
  const placement = refAt(index.bulk, r.pos, range.end);
  if (!placement) throw new F3dFormatError(`Sketch ${id} has no placement`);
  r.pos = placement.next;
  const ordinal = r.u32();
  r.skip(2);
  // Later class versions put a reference before the name.
  const extra = refAt(index.bulk, r.pos, range.end);
  if (extra) r.pos = extra.next;
  const stored = r.wstr();
  const name = stored.length > 0 ? stored : `Sketch${ordinal}`;
  r.skip(1);
  const count = r.count(11);
  const owned: number[] = [];
  for (let i = 0; i < count; i++) {
    const ref = refAt(index.bulk, r.pos, range.end);
    if (!ref) break;
    r.pos = ref.next;
    if (ref.id !== 0) owned.push(ref.id);
  }
  return { placementId: placement.id, name, owned };
}

type Placement = { matrix: F3dMatrix | null; componentId: number | null };

function readPlacement(index: DesignIndex, id: number | null): Placement {
  const range = id === null ? undefined : primaryRange(index, id);
  if (!range || index.typeOf.get(range.id)?.key !== TYPE_PLACEMENT) return { matrix: null, componentId: null };
  const { next } = readPrologue(index, range);
  const componentId =
    refsIn(index, next, range.end).find((r) => index.typeOf.get(r.id)?.key === TYPE_COMPONENT)?.id ?? null;
  if (index.bulk[next] === 1) return { matrix: null, componentId };
  return { matrix: rigidMatrixAt(view(index), next + 1), componentId };
}

export function readSketches(index: DesignIndex, parameters: F3dParameter[]): F3dSketch[] {
  const parameterOf = new Map<number, F3dParameter>();
  for (const p of parameters) if (p.ownerId !== null) parameterOf.set(p.ownerId, p);

  const components = readComponentPlacement(index);
  const sketches = new Map<number, F3dSketch>();
  const owned = new Map<number, number[]>();
  const skip = (sketch: F3dSketch, what: string) => {
    sketch.skipped[what] = (sketch.skipped[what] ?? 0) + 1;
  };

  for (const id of index.idsOf.get(TYPE_SKETCH) ?? []) {
    let head: SketchHead;
    try {
      head = readSketchHead(index, id);
    } catch {
      continue;
    }
    const placement = readPlacement(index, head.placementId);
    const world =
      placement.componentId !== null && placement.componentId !== components.rootId
        ? components.worldOf(placement.componentId)
        : null;
    const matrix = world && placement.matrix ? multiply(world, placement.matrix) : (world ?? placement.matrix);
    sketches.set(id, {
      id,
      name: head.name,
      placement: matrix,
      componentId:
        placement.componentId !== null && placement.componentId !== components.rootId ? placement.componentId : null,
      componentName:
        placement.componentId !== null && placement.componentId !== components.rootId
          ? components.nameOf(placement.componentId)
          : null,
      points: new Map(),
      curves: [],
      relations: [],
      dimensions: [],
      skipped: {},
    });
    owned.set(id, head.owned);
  }

  for (const [sketchId, ids] of owned) {
    const sketch = sketches.get(sketchId) as F3dSketch;

    for (const id of ids) {
      const key = index.typeOf.get(id)?.key;
      if (key !== TYPE_POINT) continue;
      const range = primaryRange(index, id);
      try {
        if (range) sketch.points.set(id, readPoint(index, range));
      } catch {
        skip(sketch, 'point');
      }
    }

    for (const id of ids) {
      const key = index.typeOf.get(id)?.key;
      if (key === undefined || key === TYPE_POINT) continue;
      const range = primaryRange(index, id);
      try {
        if (TYPE_TEXT.has(key)) skip(sketch, 'text');
        else if (HELPER_LINES.has(key)) continue;
        else if (isKindOf(index, key, TYPE_LINE) && range) sketch.curves.push(readLine(index, range));
        else if (key === TYPE_CIRCLE_OR_ARC && range) sketch.curves.push(readCircleOrArc(index, range, sketch.points));
        else if (key === TYPE_ELLIPSE && range) sketch.curves.push(readEllipse(index, range));
        else if (key === TYPE_SPLINE) sketch.curves.push(readSpline(index, id));
      } catch {
        skip(sketch, 'curve');
      }
    }
  }

  for (const id of index.idsOf.get(TYPE_RELATION) ?? []) {
    try {
      const { sketchId, relation } = readRelation(index, id);
      sketches.get(sketchId)?.relations.push(relation);
    } catch {
      // A relation that can't be read is left out; the sketch stays valid.
    }
  }

  for (const [key, kind] of Object.entries(DIMENSION_TYPES)) {
    for (const id of index.idsOf.get(key) ?? []) {
      try {
        const { sketchId, dimension } = readDimension(index, id, kind, parameterOf);
        sketches.get(sketchId)?.dimensions.push(dimension);
      } catch {
        // As for relations.
      }
    }
  }

  return [...sketches.values()];
}
