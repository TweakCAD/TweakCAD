/**
 * A FreeCAD sketch (`Sketcher::SketchObject`) as `core.sketch` rows (chapter
 * 8): its geometry as points and curves, its constraints as constraint rows,
 * and the regions its curves bound.
 *
 * FreeCAD addresses a curve by its index in the geometry list and a point by
 * a curve and a position (1 start, 2 end, 3 centre); the H and V axes are
 * curves -1 and -2, and the root point is the start of -1. Coincidence is a
 * constraint there and a shared point here, so coincident points are merged
 * first, then every other constraint is written against the merged points.
 */
import { RESERVED_WORDS, detectRegions, type SolvedCurve, type SolvedSketch } from '@tweakcad/format';
import { faceRegions } from '@tweakcad/worker/src/v2/fcstd/regions';
import { curveGeometry } from '@tweakcad/worker/src/v2/sketchCurves';
import { listOf, type FcObject } from './document';
import { deg, mm, snap } from './placement';
import type { Json, Writer } from './writer';
import { findChild, findChildren, type XmlNode } from './xml';

type P2 = [number, number];

export interface SketchNote {
  severity: 'info' | 'warning';
  message: string;
}

export interface ConvertedSketch {
  inputs: Json;
  /** The region rows whose faces FreeCAD makes of the sketch (outer loops and islands, not holes). */
  faces: string[];
  /** Every region row, by id. */
  regions: string[];
  /** Sketch point of each circle's centre, in geometry order, for holes. */
  circleCenters: { point: string; at: P2 }[];
  /** The `n`-th construction line (FreeCAD's `AxisN`) and the `n`-th edge (`EdgeN`): curve id and its ends. */
  axes: { curve: string; start: P2; end: P2 }[];
  edges: { curve: string; start: P2; end: P2 }[];
  notes: SketchNote[];
}

// FreeCAD's Sketcher constraint types (Constraint.h).
const C = {
  coincident: 1,
  horizontal: 2,
  vertical: 3,
  parallel: 4,
  tangent: 5,
  distance: 6,
  distanceX: 7,
  distanceY: 8,
  angle: 9,
  perpendicular: 10,
  radius: 11,
  equal: 12,
  pointOnObject: 13,
  symmetric: 14,
  internalAlignment: 15,
  snellsLaw: 16,
  block: 17,
  diameter: 18,
  weight: 19,
} as const;
const UNDEFINED = -2000;
const NAMES: Record<number, string> = Object.fromEntries(Object.entries(C).map(([k, v]) => [v, k]));

interface Geo {
  index: number;
  kind: 'line' | 'circle' | 'arc' | 'ellipse' | 'ellipticalArc' | 'point' | 'nurbs';
  construction: boolean;
  /** Curve fields that name points, by FreeCAD position or role. */
  at: Map<string, P2>;
  radius?: number;
  minorRadius?: number;
  nurbs?: { degree: number; weights: number[]; knots: number[]; multiplicities: number[]; periodic: boolean };
}

const n = (node: XmlNode | undefined, attr: string): number => {
  const v = Number(node?.attrs[attr]);
  return Number.isFinite(v) ? v : 0;
};

/** Construction as the geometry writes it: a `<Construction>` element, or bit 1 of the extension's mode flags. */
function constructionOf(g: XmlNode): boolean {
  const c = findChild(g, 'Construction');
  if (c) return c.attrs.value === '1' || c.attrs.value === 'true';
  const ext = findChild(g, 'GeoExtensions');
  const flags =
    ext &&
    findChildren(ext, 'GeoExtension').find((e) => e.attrs.geometryModeFlags !== undefined)?.attrs.geometryModeFlags;
  return flags ? flags.charAt(flags.length - 2) === '1' : false;
}

/** Geometry FreeCAD keeps only to drive another curve by internal alignment: ellipse axes and foci, B-spline poles and knots. */
function isInternal(g: XmlNode): boolean {
  const ext = findChild(g, 'GeoExtensions');
  const type =
    ext &&
    findChildren(ext, 'GeoExtension').find((e) => e.attrs.internalGeometryType !== undefined)?.attrs
      .internalGeometryType;
  return type !== undefined && type !== '0';
}

/** The in-plane axes of a FreeCAD conic: x turned by `AngleXU`, y following the normal's side. */
function axes(node: XmlNode): { x: P2; y: P2; flipped: boolean } {
  const a = n(node, 'AngleXU');
  const flipped = n(node, 'NormalZ') < 0;
  const x: P2 = [Math.cos(a), Math.sin(a)];
  return { x, y: flipped ? [x[1], -x[0]] : [-x[1], x[0]], flipped };
}

function parseGeometry(g: XmlNode, index: number): Geo | { unsupported: string } {
  const type = g.attrs.type ?? '';
  const construction = constructionOf(g);
  const at = new Map<string, P2>();
  switch (type) {
    case 'Part::GeomLineSegment': {
      const l = findChild(g, 'LineSegment');
      at.set('1', [n(l, 'StartX'), n(l, 'StartY')]);
      at.set('2', [n(l, 'EndX'), n(l, 'EndY')]);
      return { index, kind: 'line', construction, at };
    }
    case 'Part::GeomCircle': {
      const c = findChild(g, 'Circle');
      at.set('3', [n(c, 'CenterX'), n(c, 'CenterY')]);
      return { index, kind: 'circle', construction, at, radius: n(c, 'Radius') };
    }
    case 'Part::GeomArcOfCircle': {
      const c = findChild(g, 'ArcOfCircle');
      const center: P2 = [n(c, 'CenterX'), n(c, 'CenterY')];
      const r = n(c, 'Radius');
      const { x, y, flipped } = axes(c as XmlNode);
      const point = (t: number): P2 => [
        center[0] + r * (Math.cos(t) * x[0] + Math.sin(t) * y[0]),
        center[1] + r * (Math.cos(t) * x[1] + Math.sin(t) * y[1]),
      ];
      const [s, e] = [point(n(c, 'StartAngle')), point(n(c, 'EndAngle'))];
      at.set('3', center);
      // Arcs run counter-clockwise; one on a flipped plane runs the other way.
      at.set('1', flipped ? e : s);
      at.set('2', flipped ? s : e);
      return { index, kind: 'arc', construction, at, radius: r };
    }
    case 'Part::GeomEllipse':
    case 'Part::GeomArcOfEllipse': {
      const arc = type === 'Part::GeomArcOfEllipse';
      const c = findChild(g, arc ? 'ArcOfEllipse' : 'Ellipse');
      const center: P2 = [n(c, 'CenterX'), n(c, 'CenterY')];
      const [major, minor] = [n(c, 'MajorRadius'), n(c, 'MinorRadius')];
      const { x, y, flipped } = axes(c as XmlNode);
      const point = (t: number): P2 => [
        center[0] + major * Math.cos(t) * x[0] + minor * Math.sin(t) * y[0],
        center[1] + major * Math.cos(t) * x[1] + minor * Math.sin(t) * y[1],
      ];
      at.set('3', center);
      at.set('major', [center[0] + major * x[0], center[1] + major * x[1]]);
      if (flipped && arc) return { unsupported: `${type} on a flipped plane` };
      if (arc) {
        at.set('1', point(n(c, 'StartAngle')));
        at.set('2', point(n(c, 'EndAngle')));
      }
      return { index, kind: arc ? 'ellipticalArc' : 'ellipse', construction, at, minorRadius: minor };
    }
    case 'Part::GeomPoint': {
      const p = findChild(g, 'GeomPoint');
      at.set('1', [n(p, 'X'), n(p, 'Y')]);
      return { index, kind: 'point', construction, at };
    }
    case 'Part::GeomBSplineCurve': {
      const b = findChild(g, 'BSplineCurve');
      if (!b) return { unsupported: type };
      const poles = findChildren(b, 'Pole');
      const knots = findChildren(b, 'Knot');
      poles.forEach((p, i) => at.set(`pole${i}`, [n(p, 'X'), n(p, 'Y')]));
      const periodic = b.attrs.IsPeriodic === '1' || b.attrs.IsPeriodic === 'true';
      return {
        index,
        kind: 'nurbs',
        construction,
        at,
        nurbs: {
          degree: Math.trunc(n(b, 'Degree')),
          weights: poles.map((p) => n(p, 'Weight') || 1),
          knots: knots.map((k) => n(k, 'Value')),
          multiplicities: knots.map((k) => Math.trunc(n(k, 'Mult'))),
          periodic,
        },
      };
    }
    default:
      return { unsupported: type.replace(/^Part::Geom/, '') || 'unknown geometry' };
  }
}

/** The FreeCAD position of a point of `geo` as the key its point is kept under. */
function positionKey(geo: Geo, pos: number): string | undefined {
  if (geo.kind === 'nurbs') {
    if (geo.nurbs?.periodic) return undefined;
    const count = [...geo.at.keys()].filter((k) => k.startsWith('pole')).length;
    return pos === 1 ? 'pole0' : pos === 2 ? `pole${count - 1}` : undefined;
  }
  const key = String(pos);
  return geo.at.has(key) ? key : undefined;
}

/** Union-find over point keys `geo:position`. */
class Merges {
  private readonly parent = new Map<string, string>();
  find(k: string): string {
    let at = k;
    for (let p = this.parent.get(at); p !== undefined && p !== at; p = this.parent.get(at)) at = p;
    return at;
  }
  union(a: string, b: string): void {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Shape values as the writer writes them: literal numbers and flags. */
function literal(v: unknown): number {
  const text = (((v as Json).def as Json).expr as Json).text as string;
  return text === 'true' ? 1 : text === 'false' ? 0 : Number(text);
}

/** A curve of an outline: a line to the point, or an arc about `center` to it, counter-clockwise. */
export type OutlineStep = { to: P2 } | { to: P2; center: P2 };

/** Sketch rows of one closed outline, unconstrained, for a primitive that is built from a sketch here; undefined when the outline encloses no region. */
export function outlineRows(
  w: Writer,
  start: P2,
  steps: readonly OutlineStep[],
): { inputs: Json; region: string } | undefined {
  const points: Json[] = [];
  const positions = new Map<string, P2>();
  // Points closer than SAME are one, the first written. They are kept by squares of a grid SAME wide, so one's match lies in its square or a neighbouring one.
  const SAME = 1e-9;
  const squares = new Map<string, { id: string; at: P2; n: number }[]>();
  const point = (at: P2): string => {
    const [i, j] = [Math.floor(at[0] / SAME), Math.floor(at[1] / SAME)];
    let close: { id: string; n: number } | undefined;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const p of squares.get(`${i + di},${j + dj}`) ?? [])
          if (dist(p.at, at) < SAME && (!close || p.n < close.n)) close = p;
      }
    }
    if (close) return close.id;
    const id = w.ids('pt');
    points.push({ id, x: snap(at[0]), y: snap(at[1]) });
    positions.set(id, at);
    const key = `${i},${j}`;
    squares.set(key, [...(squares.get(key) ?? []), { id, at, n: points.length }]);
    return id;
  };
  const curves: Json[] = [];
  let at = point(start);
  for (const step of steps) {
    const to = point(step.to);
    if (to === at) continue;
    const base = { id: w.ids('crv'), construction: w.flag(false), origin: { drawn: {} } };
    curves.push(
      'center' in step
        ? { ...base, kind: 'arc', center: point(step.center), start: at, end: to }
        : { ...base, kind: 'line', start: at, end: to },
    );
    at = to;
  }
  const { regionRows } = detected(w, points, curves, positions);
  const region = regionRows[0];
  if (!region) return undefined;
  return {
    inputs: { points, curves, constraints: [], regions: regionRows, retired: [], text: [] },
    region: region.id as string,
  };
}

/** A circle's rows, for the same use; undefined when it encloses no region. */
export function circleRows(w: Writer, center: P2, radius: number): { inputs: Json; region: string } | undefined {
  const id = w.ids('pt');
  const points = [{ id, x: snap(center[0]), y: snap(center[1]) }];
  const curves: Json[] = [
    {
      id: w.ids('crv'),
      kind: 'circle',
      construction: w.flag(false),
      origin: { drawn: {} },
      center: id,
      radius: snap(radius),
    },
  ];
  const { regionRows } = detected(w, points, curves, new Map([[id, center]]));
  const region = regionRows[0];
  if (!region) return undefined;
  return {
    inputs: { points, curves, constraints: [], regions: regionRows, retired: [], text: [] },
    region: region.id as string,
  };
}

/** Regions detected on curve rows at `positions`. */
function detected(w: Writer, points: readonly Json[], curves: readonly Json[], positions: ReadonlyMap<string, P2>) {
  const at = (id: unknown): P2 => positions.get(id as string) ?? [0, 0];
  const solved: SolvedSketch = {
    points: points.map((p) => ({ id: p.id as string, x: p.x as number, y: p.y as number })),
    curves: curves.flatMap((c): SolvedCurve[] => {
      if (literal(c.construction) === 1 || c.kind === 'point') return [];
      const geometry = curveGeometry(c, { point: at, number: literal, variable: () => undefined });
      return geometry ? [{ key: { drawn: { id: c.id as string } }, ...geometry }] : [];
    }),
  };
  const detection = detectRegions(solved);
  const regionRows: Json[] = detection.regions.map((r) => ({
    id: w.ids('reg'),
    loop: r.loop,
    holes: r.holes,
    origin: { detected: {} },
  }));
  return { detection, regionRows };
}

/** The value object of a dimension: `index` is its place in FreeCAD's constraint list. */
export type DimensionValue = (
  index: number,
  name: string,
  literal: string,
  number: number,
  quantity: 'length' | 'angle',
  valueName: string | undefined,
) => Json;

export function convertSketch(sketch: FcObject, w: Writer, dimensionValue?: DimensionValue): ConvertedSketch {
  const notes: SketchNote[] = [];
  const geos = new Map<number, Geo>();
  const skipped = new Map<string, number>();
  listOf(sketch, 'Geometry', 'GeometryList')
    .filter((g) => g.name === 'Geometry')
    .forEach((g, index) => {
      if (isInternal(g)) return;
      const parsed = parseGeometry(g, index);
      if ('unsupported' in parsed) skipped.set(parsed.unsupported, (skipped.get(parsed.unsupported) ?? 0) + 1);
      else geos.set(index, parsed);
    });
  for (const [kind, count] of skipped)
    notes.push({
      severity: 'warning',
      message: `${count} ${kind} ${count === 1 ? 'curve was' : 'curves were'} left out`,
    });
  // Projected geometry, as FreeCAD last projected it (curves -3, -4, … after the two axes): held where it lies, for the constraints on it.
  const external: number[] = [];
  listOf(sketch, 'ExternalGeo', 'GeometryList')
    .filter((g) => g.name === 'Geometry')
    .forEach((g, i) => {
      if (i < 2) return;
      const parsed = parseGeometry(g, -1 - i);
      if ('unsupported' in parsed) return;
      geos.set(parsed.index, { ...parsed, construction: true });
      external.push(parsed.index);
    });
  if (external.length > 0) {
    notes.push({
      severity: 'info',
      message: `${external.length} projected ${external.length === 1 ? 'curve came' : 'curves came'} in as fixed construction geometry`,
    });
  }

  const constraints = listOf(sketch, 'Constraints', 'ConstraintList').filter((c) => c.name === 'Constrain');
  const attr = (c: XmlNode, a: string, fallback: number) => {
    const v = Number(c.attrs[a]);
    return Number.isFinite(v) ? Math.trunc(v) : fallback;
  };
  const read = (c: XmlNode) => ({
    type: attr(c, 'Type', 0),
    name: c.attrs.Name ?? '',
    value: Number(c.attrs.Value ?? 0),
    first: attr(c, 'First', UNDEFINED),
    firstPos: attr(c, 'FirstPos', 0),
    second: attr(c, 'Second', UNDEFINED),
    secondPos: attr(c, 'SecondPos', 0),
    third: attr(c, 'Third', UNDEFINED),
    thirdPos: attr(c, 'ThirdPos', 0),
    driving: c.attrs.IsDriving !== '0',
    active: c.attrs.IsActive !== '0',
  });
  const rows = constraints.map((c, index) => ({ ...read(c), index }));

  // Coincidence first: FreeCAD's coincident points, and the ends a tangency or perpendicularity at two ends joins.
  const merges = new Merges();
  const key = (g: number, pos: number): string | undefined => {
    if (g === -1 && pos === 1) return 'origin';
    const geo = geos.get(g);
    const k = geo && positionKey(geo, pos);
    return k === undefined ? undefined : `${g}:${k}`;
  };
  for (const r of rows) {
    const joins =
      r.type === C.coincident ||
      ((r.type === C.tangent || r.type === C.perpendicular) &&
        r.firstPos !== 0 &&
        r.secondPos !== 0 &&
        r.third === UNDEFINED);
    if (!joins || !r.active) continue;
    const [a, b] = [key(r.first, r.firstPos), key(r.second, r.secondPos)];
    if (a && b) merges.union(a === 'origin' ? a : b === 'origin' ? b : a, a === 'origin' ? b : b === 'origin' ? a : b);
  }

  // Points: one per merged group, at the first member's position.
  const points: Json[] = [];
  const pointOf = new Map<string, string>();
  const atOrigin = new Set<string>();
  const positions = new Map<string, P2>();
  for (const geo of geos.values()) {
    for (const [field, at] of geo.at) {
      const k = `${geo.index}:${field}`;
      const root = merges.find(k);
      let id = pointOf.get(root);
      if (id === undefined) {
        id = w.ids('pt');
        pointOf.set(root, id);
        const place: P2 = root === 'origin' ? [0, 0] : at;
        if (root === 'origin') atOrigin.add(id);
        points.push({ id, x: snap(place[0]), y: snap(place[1]) });
        positions.set(id, place);
      }
      pointOf.set(k, id);
    }
  }
  const pt = (g: number, field: string) => pointOf.get(`${g}:${field}`) as string;

  // Curves.
  const curves: Json[] = [];
  const curveOf = new Map<number, string>();
  const circleCenters: ConvertedSketch['circleCenters'] = [];
  const axesOut: ConvertedSketch['axes'] = [];
  const edgesOut: ConvertedSketch['edges'] = [];
  let degenerate = 0;
  for (const geo of geos.values()) {
    const id = w.ids('crv');
    const base = { id, kind: geo.kind, construction: w.flag(geo.construction), origin: { drawn: {} } };
    let row: Json;
    switch (geo.kind) {
      case 'line':
        if (pt(geo.index, '1') === pt(geo.index, '2')) {
          degenerate++;
          continue;
        }
        row = { ...base, start: pt(geo.index, '1'), end: pt(geo.index, '2') };
        break;
      case 'circle':
        row = { ...base, center: pt(geo.index, '3'), radius: snap(geo.radius ?? 0) };
        break;
      case 'arc':
        if (pt(geo.index, '1') === pt(geo.index, '2')) {
          degenerate++;
          continue;
        }
        row = { ...base, center: pt(geo.index, '3'), start: pt(geo.index, '1'), end: pt(geo.index, '2') };
        break;
      case 'ellipse':
        row = {
          ...base,
          center: pt(geo.index, '3'),
          majorEnd: pt(geo.index, 'major'),
          minorRadius: snap(geo.minorRadius ?? 0),
        };
        break;
      case 'ellipticalArc':
        row = {
          ...base,
          center: pt(geo.index, '3'),
          majorEnd: pt(geo.index, 'major'),
          minorRadius: snap(geo.minorRadius ?? 0),
          start: pt(geo.index, '1'),
          end: pt(geo.index, '2'),
        };
        break;
      case 'point':
        row = { ...base, at: pt(geo.index, '1') };
        break;
      case 'nurbs': {
        const s = geo.nurbs as NonNullable<Geo['nurbs']>;
        const poles = [...geo.at.keys()].filter((k) => k.startsWith('pole')).map((k) => pt(geo.index, k));
        row = {
          ...base,
          degree: w.val(String(s.degree)),
          poles,
          weights: s.weights.map((v) => w.val(String(snap(v)))),
          knots: s.knots.map((v) => w.val(String(snap(v)))),
          multiplicities: s.multiplicities,
          periodic: w.flag(s.periodic),
        };
        break;
      }
    }
    curves.push(row);
    curveOf.set(geo.index, id);
    // FreeCAD numbers the sketch's own curves for AxisN and EdgeN; projected ones are not among them.
    if (geo.index < 0) continue;
    if (geo.kind === 'circle' && !geo.construction)
      circleCenters.push({ point: pt(geo.index, '3'), at: geo.at.get('3') as P2 });
    if (geo.kind === 'line') {
      const line = { curve: id, start: geo.at.get('1') as P2, end: geo.at.get('2') as P2 };
      (geo.construction ? axesOut : edgesOut).push(line);
    } else if (!geo.construction && geo.kind !== 'point')
      edgesOut.push({ curve: id, start: geo.at.get('1') ?? [0, 0], end: geo.at.get('2') ?? [0, 0] });
  }
  if (degenerate > 0) notes.push({ severity: 'warning', message: `${degenerate} curves of no length were left out` });

  // Constraints.
  const out: Json[] = [];
  const pointOp = (g: number, pos: number): Json | null => {
    if (g === -1 && pos === 1) return { sketchStandard: { name: 'origin' } };
    const k = key(g, pos);
    const id = k === undefined ? undefined : (pointOf.get(k) ?? pointOf.get(merges.find(k)));
    if (id === undefined) return null;
    return atOrigin.has(id) ? { sketchStandard: { name: 'origin' } } : { point: { id } };
  };
  const curveOp = (g: number): Json | null => {
    if (g === -1) return { sketchStandard: { name: 'x' } };
    if (g === -2) return { sketchStandard: { name: 'y' } };
    const id = curveOf.get(g);
    return id === undefined ? null : { curve: { id } };
  };
  const isLine = (g: number) => g === -1 || g === -2 || geos.get(g)?.kind === 'line';
  const isRound = (g: number) => {
    const k = geos.get(g)?.kind;
    return k === 'circle' || k === 'arc';
  };
  const own = (op: Json) => 'sketchStandard' in op || 'sketchX' in op;
  // A name is given once in its part; FreeCAD lets each sketch reuse one.
  const valueName = (raw: string): string | undefined => {
    const name = raw.trim().replace(/[^A-Za-z0-9_]/g, '_');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || RESERVED_WORDS.has(name) || w.valueNames.has(name)) return undefined;
    w.valueNames.add(name);
    return name;
  };
  const push = (kind: string, active: boolean, fields: Json): void => {
    const ops = Object.values(fields).filter(
      (v): v is Json =>
        typeof v === 'object' &&
        v !== null &&
        ('point' in v || 'curve' in v || 'sketchStandard' in v || 'sketchX' in v),
    );
    if (ops.length > 0 && ops.every(own)) return;
    out.push({ id: w.ids('con'), kind, active: w.flag(active), ...fields });
  };
  const dimension = (
    r: (typeof rows)[number],
    text: string,
    solved: number,
    quantity: 'length' | 'angle' = 'length',
  ) => {
    const named = r.name ? valueName(r.name) : undefined;
    return {
      value: dimensionValue ? dimensionValue(r.index, r.name, text, solved, quantity, named) : w.val(text, named),
      solved,
      label: { auto: {} },
    };
  };
  /** An angle in degrees in (−180, 180]. */
  const turn = (d: number) => {
    let a = d % 360;
    if (a <= -180) a += 360;
    if (a > 180) a -= 360;
    return a;
  };
  /** Whether two round curves touch from inside, by their stored geometry. */
  const internal = (a: number, b: number): boolean => {
    const [ga, gb] = [geos.get(a), geos.get(b)];
    if (!ga || !gb || !isRound(a) || !isRound(b)) return false;
    const d = dist(ga.at.get('3') as P2, gb.at.get('3') as P2);
    const [ra, rb] = [ga.radius ?? 0, gb.radius ?? 0];
    return Math.abs(d - Math.abs(ra - rb)) < Math.abs(d - (ra + rb));
  };
  const dropped = new Map<string, number>();
  const drop = (what: string) => dropped.set(what, (dropped.get(what) ?? 0) + 1);

  for (const g of external) {
    const id = curveOf.get(g);
    if (id !== undefined) out.push({ id: w.ids('con'), kind: 'block', active: w.flag(true), curve: { curve: { id } } });
  }
  // A point merged with the root point is held there.
  for (const id of atOrigin) {
    for (const kind of ['horizontal', 'vertical']) {
      out.push({
        id: w.ids('con'),
        kind,
        active: w.flag(true),
        of: { points: { a: { point: { id } }, b: { sketchStandard: { name: 'origin' } } } },
      });
    }
  }
  for (const r of rows) {
    const kindName = NAMES[r.type] ?? `type ${r.type}`;
    if (r.type === C.coincident || r.type === C.internalAlignment) continue;
    if (!r.driving && [C.distance, C.distanceX, C.distanceY, C.angle, C.radius, C.diameter].includes(r.type as never))
      continue;
    const a = curveOp(r.first);
    const b = r.second === UNDEFINED ? null : curveOp(r.second);
    const fail = () => drop(kindName);
    switch (r.type) {
      case C.horizontal:
      case C.vertical: {
        const kind = r.type === C.horizontal ? 'horizontal' : 'vertical';
        if (r.second === UNDEFINED) {
          if (a && isLine(r.first)) push(kind, r.active, { of: a });
          else fail();
        } else {
          const [pa, pb] = [pointOp(r.first, r.firstPos), pointOp(r.second, r.secondPos)];
          if (pa && pb) push(kind, r.active, { of: { points: { a: pa, b: pb } } });
          else fail();
        }
        break;
      }
      case C.parallel:
      case C.equal:
        if (a && b) push(r.type === C.parallel ? 'parallel' : 'equal', r.active, { a, b });
        else fail();
        break;
      case C.tangent:
      case C.perpendicular: {
        if (!a || !b || r.third !== UNDEFINED) {
          fail();
          break;
        }
        if (r.firstPos !== 0 && r.secondPos === 0) {
          const p = pointOp(r.first, r.firstPos);
          if (p) push('pointOnCurve', r.active, { point: p, curve: b });
        }
        if (r.type === C.tangent) push('tangent', r.active, { a, b, internal: w.flag(internal(r.first, r.second)) });
        else push(isLine(r.first) && isLine(r.second) ? 'perpendicular' : 'normal', r.active, { a, b });
        break;
      }
      case C.distance: {
        const length = mm(r.value);
        if (r.second === UNDEFINED && r.firstPos === 0 && a && isLine(r.first)) {
          push('length', r.active, { curve: a, ...dimension(r, length, r.value) });
        } else if (r.firstPos !== 0 && r.second !== UNDEFINED) {
          const pa = pointOp(r.first, r.firstPos);
          const pb = r.secondPos !== 0 ? pointOp(r.second, r.secondPos) : b;
          if (pa && pb) push('distance', r.active, { a: pa, b: pb, ...dimension(r, length, r.value) });
          else fail();
        } else fail();
        break;
      }
      case C.distanceX:
      case C.distanceY: {
        const kind = r.type === C.distanceX ? 'distanceX' : 'distanceY';
        let pa: Json | null;
        let pb: Json | null;
        if (r.second === UNDEFINED && r.firstPos === 0) [pa, pb] = [pointOp(r.first, 1), pointOp(r.first, 2)];
        else if (r.second === UNDEFINED)
          [pa, pb] = [{ sketchStandard: { name: 'origin' } }, pointOp(r.first, r.firstPos)];
        else [pa, pb] = [pointOp(r.first, r.firstPos), pointOp(r.second, r.secondPos)];
        if (pa && pb) push(kind, r.active, { a: pa, b: pb, ...dimension(r, mm(r.value), r.value) });
        else fail();
        break;
      }
      case C.angle: {
        const degrees = (r.value * 180) / Math.PI;
        if (r.third !== UNDEFINED || !a || !isLine(r.first)) {
          fail();
        } else if (r.second === UNDEFINED) {
          // FreeCAD measures a line's angle from the sketch's x axis; here an angle runs from its first operand to its second.
          const v = turn(-degrees);
          push('angle', r.active, { a, b: { sketchX: {} }, ...dimension(r, deg(v), v, 'angle') });
        } else if (b && isLine(r.second)) {
          // At two ends, FreeCAD directs each line away from the end named.
          const flips = (r.firstPos === 2 ? 180 : 0) + (r.secondPos === 2 ? 180 : 0);
          const v = turn(degrees + flips);
          push('angle', r.active, { a, b, ...dimension(r, deg(v), v, 'angle') });
        } else fail();
        break;
      }
      case C.radius:
      case C.diameter: {
        if (a && geos.get(r.first) && isRound(r.first))
          push(r.type === C.radius ? 'radius' : 'diameter', r.active, {
            curve: a,
            ...dimension(r, mm(r.value), r.value),
          });
        else fail();
        break;
      }
      case C.pointOnObject: {
        const p = pointOp(r.first, r.firstPos);
        if (p && b) push('pointOnCurve', r.active, { point: p, curve: b });
        else fail();
        break;
      }
      case C.symmetric: {
        const [pa, pb] = [pointOp(r.first, r.firstPos), pointOp(r.second, r.secondPos)];
        const axis = r.thirdPos === 0 ? curveOp(r.third) : null;
        const center = r.thirdPos !== 0 ? pointOp(r.third, r.thirdPos) : null;
        if (pa && pb && axis && isLine(r.third)) push('symmetric', r.active, { a: pa, b: pb, axis });
        else if (
          pa &&
          pb &&
          center &&
          'point' in pa &&
          'point' in pb &&
          (pa.point as Json).id !== (pb.point as Json).id
        ) {
          // Symmetric about a point is that point at the middle of the two: a construction line between them, and its midpoint.
          const line = w.ids('crv');
          curves.push({
            id: line,
            kind: 'line',
            construction: w.flag(true),
            origin: { drawn: {} },
            start: (pa.point as Json).id,
            end: (pb.point as Json).id,
          });
          push('midpoint', r.active, { point: center, curve: { curve: { id: line } } });
        } else fail();
        break;
      }
      case C.block:
        if (a) push('block', r.active, { curve: a });
        else fail();
        break;
      default:
        fail();
    }
  }
  for (const [what, count] of dropped)
    notes.push({
      severity: 'info',
      message: `${count} ${what} ${count === 1 ? 'constraint was' : 'constraints were'} left out`,
    });

  // Regions, detected on the curves as FreeCAD solved them.
  const { detection, regionRows } = detected(w, points, curves, positions);
  const faces = new Set(faceRegions(detection));
  const inputs: Json = {
    points,
    curves,
    constraints: out,
    regions: regionRows,
    retired: [],
    text: [],
  };
  return {
    inputs,
    faces: detection.regions.flatMap((r, i) => (faces.has(r) ? [(regionRows[i] as Json).id as string] : [])),
    regions: regionRows.map((r) => r.id as string),
    circleCenters,
    axes: axesOut,
    edges: edgesOut,
    notes,
  };
}
