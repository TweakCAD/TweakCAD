/**
 * A `core.sketch` as a `Sketcher::SketchObject`. Geometry comes from the solved
 * sketch; a point here is shared where FreeCAD holds two ends together with a
 * coincident constraint, and FreeCAD addresses a point as a curve and a
 * position (1 start, 2 end, 3 centre). A constraint FreeCAD has no form for is
 * left out: the sketch stays where it was solved.
 */
import type { ValueEvaluator } from '@tweakcad/format';
import { FLAG, type Json, type SketchResult } from '../context';
import { curveGeometry, curveReader } from '../sketchCurves';
import { num, type FcOut } from './file';

type P2 = readonly [number, number];

const COINCIDENT = 1;
const HORIZONTAL = 2;
const VERTICAL = 3;
const PARALLEL = 4;
const TANGENT = 5;
const DISTANCE = 6;
const DISTANCE_X = 7;
const DISTANCE_Y = 8;
const ANGLE = 9;
const PERPENDICULAR = 10;
const RADIUS = 11;
const EQUAL = 12;
const POINT_ON_OBJECT = 13;
const SYMMETRIC = 14;
const BLOCK = 17;
const DIAMETER = 18;
const NONE = -2000;

interface Fc {
  geo: number;
  pos: number;
}

interface Constraint {
  type: number;
  name?: string;
  value?: number;
  a: Fc;
  b?: Fc;
  c?: Fc;
  driving: boolean;
  active: boolean;
  /** The value object a dimension shows, for its expression. */
  bound?: Json;
}

/** What other objects need of a written sketch. */
export interface WrittenSketch {
  /** The geometry index of each curve row. */
  geo: ReadonlyMap<string, number>;
  /** The `n` of FreeCAD's `AxisN` for each construction line row. */
  axes: ReadonlyMap<string, number>;
}

export interface SketchInput {
  row: Json;
  result: SketchResult;
  values: ValueEvaluator;
  /** Curve rows to keep; every live one when absent. Constraints are left out of a part of a sketch. */
  only?: ReadonlySet<string>;
  /** The expression a value object is bound to, in FreeCAD's language, if it can be said there. */
  expression?: (value: Json) => string | undefined;
  note: (message: string) => void;
}

const fixed = (v: number) => num(v);

function extensions(construction: boolean): string {
  const flags = construction ? '00000000000000000000000000000010' : '00000000000000000000000000000000';
  return `<GeoExtensions count="1"><GeoExtension type="Sketcher::SketchGeometryExtension" internalGeometryType="0" geometryModeFlags="${flags}" geometryLayer="0"/></GeoExtensions>`;
}

function geometryXml(type: string, body: string, index: number, construction: boolean): string {
  return `<Geometry type="Part::Geom${type}" id="${index + 1}" migrated="1">${extensions(construction)}${body}<Construction value="${construction ? 1 : 0}"/></Geometry>`;
}

const pointXyz = (prefix: string, p: P2) => `${prefix}X="${fixed(p[0])}" ${prefix}Y="${fixed(p[1])}" ${prefix}Z="0"`;

/** The conic attributes of a circular or elliptic curve in the sketch plane. */
const NORMAL = 'NormalX="0" NormalY="0" NormalZ="1"';

function arcAngles(center: P2, start: P2, end: P2): [number, number] {
  const a = Math.atan2(start[1] - center[1], start[0] - center[0]);
  let b = Math.atan2(end[1] - center[1], end[0] - center[0]);
  while (b <= a) b += 2 * Math.PI;
  return [a, b];
}

/** A curve shape's XML; undefined for one FreeCAD has no element for. */
function curveXml(
  shape: NonNullable<ReturnType<typeof curveGeometry>>['shape'],
  index: number,
  construction: boolean,
): string | undefined {
  switch (shape.kind) {
    case 'line':
      return geometryXml(
        'LineSegment',
        `<LineSegment ${pointXyz('Start', shape.start)} ${pointXyz('End', shape.end)}/>`,
        index,
        construction,
      );
    case 'circle':
      return geometryXml(
        'Circle',
        `<Circle ${pointXyz('Center', shape.center)} ${NORMAL} AngleXU="0" Radius="${fixed(shape.radius)}"/>`,
        index,
        construction,
      );
    case 'arc': {
      const r = Math.hypot(shape.start[0] - shape.center[0], shape.start[1] - shape.center[1]);
      const [a, b] = arcAngles(shape.center, shape.start, shape.end);
      return geometryXml(
        'ArcOfCircle',
        `<ArcOfCircle ${pointXyz('Center', shape.center)} ${NORMAL} AngleXU="0" Radius="${fixed(r)}" StartAngle="${fixed(a)}" EndAngle="${fixed(b)}"/>`,
        index,
        construction,
      );
    }
    case 'ellipse':
    case 'ellipticalArc': {
      const dx = shape.majorEnd[0] - shape.center[0];
      const dy = shape.majorEnd[1] - shape.center[1];
      const major = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const conic = `${pointXyz('Center', shape.center)} ${NORMAL} MajorRadius="${fixed(major)}" MinorRadius="${fixed(shape.minorRadius)}" AngleXU="${fixed(angle)}"`;
      if (shape.kind === 'ellipse') return geometryXml('Ellipse', `<Ellipse ${conic}/>`, index, construction);
      const eccentric = (p: P2) => {
        const [x, y] = [p[0] - shape.center[0], p[1] - shape.center[1]];
        const [u, v] = [x * Math.cos(angle) + y * Math.sin(angle), -x * Math.sin(angle) + y * Math.cos(angle)];
        return Math.atan2(v / shape.minorRadius, u / major);
      };
      const a = eccentric(shape.start);
      let b = eccentric(shape.end);
      while (b <= a) b += 2 * Math.PI;
      return geometryXml(
        'ArcOfEllipse',
        `<ArcOfEllipse ${conic} StartAngle="${fixed(a)}" EndAngle="${fixed(b)}"/>`,
        index,
        construction,
      );
    }
    case 'nurbs': {
      const poles = shape.poles
        .map((p, i) => `<Pole X="${fixed(p[0])}" Y="${fixed(p[1])}" Z="0" Weight="${fixed(shape.weights[i] ?? 1)}"/>`)
        .join('');
      const knots = shape.knots
        .map((k, i) => `<Knot Value="${fixed(k)}" Mult="${shape.multiplicities[i] ?? 1}"/>`)
        .join('');
      const body = `<BSplineCurve PolesCount="${shape.poles.length}" KnotsCount="${shape.knots.length}" Degree="${shape.degree}" IsPeriodic="${shape.periodic ? 1 : 0}">${poles}${knots}</BSplineCurve>`;
      return geometryXml('BSplineCurve', body, index, construction);
    }
    default:
      return undefined;
  }
}

function constraintXml(c: Constraint): string {
  const f = (p: Fc | undefined) => (p ? [p.geo, p.pos] : [NONE, 0]);
  const [first, firstPos] = f(c.a);
  const [second, secondPos] = f(c.b);
  const [third, thirdPos] = f(c.c);
  const name = c.name ?? '';
  return `<Constrain Name="${name}" Type="${c.type}" Value="${fixed(c.value ?? 0)}" LabelDistance="10" LabelPosition="0" IsDriving="${c.driving ? 1 : 0}" IsInVirtualSpace="0" IsVisible="1" IsActive="${c.active ? 1 : 0}" First="${first}" FirstPos="${firstPos}" Second="${second}" SecondPos="${secondPos}" Third="${third}" ThirdPos="${thirdPos}"/>`;
}

/** Union-find over `geo:pos` ends. */
class Joined {
  private readonly parent = new Map<string, string>();
  find(k: string): string {
    let at = k;
    for (let p = this.parent.get(at); p !== undefined && p !== at; p = this.parent.get(at)) at = p;
    return at;
  }
  /** Joins two ends; false when they already were. */
  union(a: string, b: string): boolean {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra === rb) return false;
    this.parent.set(rb, ra);
    return true;
  }
}

/** Writes the sketch's geometry and constraints onto `out`. */
export function writeSketch(out: FcOut, input: SketchInput): WrittenSketch {
  const { row, result, values, only, note } = input;
  const positions = new Map<string, P2>();
  for (const p of (row.points as Json[]) ?? []) positions.set(p.id as string, [p.x as number, p.y as number]);
  for (const p of result.solved.points) positions.set(p.id, [p.x, p.y]);
  const radii = new Map<string, number>();
  const live = [...result.solved.curves, ...result.others];
  for (const c of live) {
    const id = 'drawn' in c.key ? (c.key.drawn as Json).id : undefined;
    if (typeof id !== 'string') continue;
    if (c.shape.kind === 'circle') radii.set(id, c.shape.radius);
    else if (c.shape.kind === 'ellipse' || c.shape.kind === 'ellipticalArc') radii.set(id, c.shape.minorRadius);
  }
  const read = curveReader(values, positions, (curve) => radii.get(curve));

  const xml: string[] = [];
  const geo = new Map<string, number>();
  const axes = new Map<string, number>();
  const pointsOf = new Map<string, Fc[]>();
  const shapes = new Map<number, NonNullable<ReturnType<typeof curveGeometry>>['shape']>();
  const attachTo = (point: unknown, g: number, pos: number) => {
    if (typeof point !== 'string') return;
    const list = pointsOf.get(point) ?? [];
    list.push({ geo: g, pos });
    pointsOf.set(point, list);
  };
  const addPoint = (id: string, construction: boolean): number => {
    const at = positions.get(id) ?? [0, 0];
    const index = xml.length;
    xml.push(geometryXml('Point', `<GeomPoint ${pointXyz('', at)}/>`, index, construction));
    attachTo(id, index, 1);
    return index;
  };
  let lost = 0;
  const held: number[] = [];
  for (const c of (row.curves as Json[]) ?? []) {
    const id = c.id as string;
    if (only && !only.has(id)) continue;
    if (c.kind === 'external') {
      // FreeCAD's own projection names an edge of its shape; here it is held where it was projected.
      const external = result.externals.find((e) => e.id === id);
      const index = xml.length;
      const text = external ? curveXml(external.shape, index, !external.bounds) : undefined;
      if (!external || !text) {
        lost++;
        continue;
      }
      xml.push(text);
      geo.set(id, index);
      shapes.set(index, external.shape);
      held.push(index);
      continue;
    }
    const construction = only ? false : values.literal(c.construction, FLAG) === true;
    if (c.kind === 'point') {
      geo.set(id, addPoint(c.at as string, construction));
      continue;
    }
    const geometry = curveGeometry(c, read);
    const text = geometry ? curveXml(geometry.shape, xml.length, construction) : undefined;
    if (!geometry || !text) {
      lost++;
      continue;
    }
    const index = xml.length;
    xml.push(text);
    geo.set(id, index);
    shapes.set(index, geometry.shape);
    if (c.kind === 'line' && construction) axes.set(id, [...axes.keys()].length);
    if (c.start !== undefined) attachTo(c.start, index, 1);
    if (c.end !== undefined) attachTo(c.end, index, 2);
    if (c.center !== undefined) attachTo(c.center, index, 3);
    if (geometry.anchors.kind === 'points' && c.start === undefined) {
      attachTo(geometry.anchors.start, index, 1);
      attachTo(geometry.anchors.end, index, 2);
    }
  }
  if (lost > 0) note(`${lost} of its curves have no form in FreeCAD and were left out`);

  const constraints: Constraint[] = [];
  const joined = new Joined();
  const key = (p: Fc) => `${p.geo}:${p.pos}`;

  /** A point as FreeCAD addresses it: the root point, or a curve and position. */
  const pointOf = (op: Json): Fc | undefined => {
    if ('sketchStandard' in op) return (op.sketchStandard as Json).name === 'origin' ? { geo: -1, pos: 1 } : undefined;
    const id = (op.point as Json | undefined)?.id as string | undefined;
    if (!id) return undefined;
    const at = pointsOf.get(id)?.[0];
    if (at) return at;
    if (only) return undefined;
    addPoint(id, true);
    return pointsOf.get(id)?.[0];
  };
  const curveOf = (op: Json): number | undefined => {
    if ('sketchStandard' in op) {
      const name = (op.sketchStandard as Json).name;
      return name === 'x' ? -1 : name === 'y' ? -2 : undefined;
    }
    const id = ((op.curve ?? op.external) as Json | undefined)?.id as string | undefined;
    return id ? geo.get(id) : undefined;
  };
  const isPoint = (op: Json) => 'point' in op || (op.sketchStandard as Json | undefined)?.name === 'origin';
  const place = (p: Fc): P2 => {
    if (p.geo === -1 && p.pos === 1) return [0, 0];
    const s = shapes.get(p.geo);
    if (!s) return [0, 0];
    if (p.pos === 3 && 'center' in s) return s.center;
    if ((s.kind === 'line' || s.kind === 'arc' || s.kind === 'ellipticalArc') && p.pos === 1) return s.start;
    if ((s.kind === 'line' || s.kind === 'arc' || s.kind === 'ellipticalArc') && p.pos === 2) return s.end;
    if (s.kind === 'nurbs') return (p.pos === 1 ? s.poles[0] : s.poles[s.poles.length - 1]) ?? [0, 0];
    return [0, 0];
  };
  /** The curve's direction, for angles: the x axis, or a line start to end. */
  const direction = (g: number): P2 | undefined => {
    if (g === -1) return [1, 0];
    if (g === -2) return [0, 1];
    const s = shapes.get(g);
    return s?.kind === 'line' ? [s.end[0] - s.start[0], s.end[1] - s.start[1]] : undefined;
  };
  /** The end two curves share, when they share one. */
  const sharedEnd = (a: number, b: number): [Fc, Fc] | undefined => {
    for (const list of pointsOf.values()) {
      const [pa, pb] = [list.find((p) => p.geo === a && p.pos !== 3), list.find((p) => p.geo === b && p.pos !== 3)];
      if (pa && pb) return [pa, pb];
    }
    return undefined;
  };

  if (!only) {
    for (const g of held) constraints.push({ type: BLOCK, a: { geo: g, pos: 0 }, driving: true, active: true });
    let dropped = 0;
    const drop = () => dropped++;
    for (const c of (row.constraints as Json[]) ?? []) {
      const active = values.literal(c.active, FLAG) === true;
      const kind = c.kind as string;
      const a = c.a as Json | undefined;
      const b = c.b as Json | undefined;
      const value = c.value as Json | undefined;
      const driving = !value || !('measure' in ((value.def as Json) ?? {}));
      const name = value && typeof value.name === 'string' ? value.name : undefined;
      const plain = { driving, active, ...(name ? { name } : {}) };
      const dim = { ...plain, ...(value ? { bound: value } : {}) };
      switch (kind) {
        case 'horizontal':
        case 'vertical': {
          const type = kind === 'horizontal' ? HORIZONTAL : VERTICAL;
          const of = c.of as Json;
          if ('points' in of) {
            const pts = of.points as Json;
            const [pa, pb] = [pointOf(pts.a as Json), pointOf(pts.b as Json)];
            if (pa && pb) constraints.push({ type, a: pa, b: pb, driving: true, active });
            else drop();
          } else {
            const g = curveOf(of);
            if (g !== undefined && g >= 0) constraints.push({ type, a: { geo: g, pos: 0 }, driving: true, active });
            else drop();
          }
          break;
        }
        case 'parallel':
        case 'equal':
        case 'perpendicular':
        case 'normal':
        case 'collinear':
        case 'tangent': {
          const [ga, gb] = [a && curveOf(a), b && curveOf(b)];
          if (ga === undefined || gb === undefined) {
            drop();
            break;
          }
          if (kind === 'parallel' || kind === 'equal') {
            constraints.push({
              type: kind === 'parallel' ? PARALLEL : EQUAL,
              a: { geo: ga, pos: 0 },
              b: { geo: gb, pos: 0 },
              driving: true,
              active,
            });
            break;
          }
          const type = kind === 'perpendicular' || kind === 'normal' ? PERPENDICULAR : TANGENT;
          const ends = kind === 'collinear' ? undefined : sharedEnd(ga, gb);
          if (ends) {
            // At a shared end FreeCAD's constraint holds the ends together as well.
            joined.union(key(ends[0]), key(ends[1]));
            constraints.push({ type, a: ends[0], b: ends[1], driving: true, active });
          } else constraints.push({ type, a: { geo: ga, pos: 0 }, b: { geo: gb, pos: 0 }, driving: true, active });
          break;
        }
        case 'concentric': {
          const [ga, gb] = [a && curveOf(a), b && curveOf(b)];
          if (ga === undefined || gb === undefined) drop();
          else
            constraints.push({
              type: COINCIDENT,
              a: { geo: ga, pos: 3 },
              b: { geo: gb, pos: 3 },
              driving: true,
              active,
            });
          break;
        }
        case 'pointOnCurve': {
          const p = pointOf(c.point as Json);
          const g = curveOf(c.curve as Json);
          if (p && g !== undefined)
            constraints.push({ type: POINT_ON_OBJECT, a: p, b: { geo: g, pos: 0 }, driving: true, active });
          else drop();
          break;
        }
        case 'midpoint': {
          const p = pointOf(c.point as Json);
          const g = curveOf(c.curve as Json);
          if (p && g !== undefined && g >= 0)
            constraints.push({
              type: SYMMETRIC,
              a: { geo: g, pos: 1 },
              b: { geo: g, pos: 2 },
              c: p,
              driving: true,
              active,
            });
          else drop();
          break;
        }
        case 'symmetric': {
          const [pa, pb] = [a && isPoint(a) ? pointOf(a) : undefined, b && isPoint(b) ? pointOf(b) : undefined];
          const axis = curveOf(c.axis as Json);
          if (pa && pb && axis !== undefined)
            constraints.push({ type: SYMMETRIC, a: pa, b: pb, c: { geo: axis, pos: 0 }, driving: true, active });
          else drop();
          break;
        }
        case 'block': {
          const g = curveOf(c.curve as Json);
          if (g !== undefined && g >= 0)
            constraints.push({ type: BLOCK, a: { geo: g, pos: 0 }, driving: true, active });
          else drop();
          break;
        }
        case 'fixed': {
          const p = pointOf(c.point as Json);
          if (!p) {
            drop();
            break;
          }
          const at = place(p);
          constraints.push({ type: DISTANCE_X, a: { geo: -1, pos: 1 }, b: p, value: at[0], driving: true, active });
          constraints.push({ type: DISTANCE_Y, a: { geo: -1, pos: 1 }, b: p, value: at[1], driving: true, active });
          break;
        }
        case 'distance': {
          const pa = a && isPoint(a) ? pointOf(a) : undefined;
          const pb = b && isPoint(b) ? pointOf(b) : undefined;
          const gb = b && !isPoint(b) ? curveOf(b) : undefined;
          const ga = a && !isPoint(a) ? curveOf(a) : undefined;
          const v = c.solved as number;
          if (pa && pb) constraints.push({ type: DISTANCE, a: pa, b: pb, value: v, ...dim });
          else if (pa && gb !== undefined)
            constraints.push({ type: DISTANCE, a: pa, b: { geo: gb, pos: 0 }, value: v, ...dim });
          else if (pb && ga !== undefined)
            constraints.push({ type: DISTANCE, a: pb, b: { geo: ga, pos: 0 }, value: v, ...dim });
          else drop();
          break;
        }
        case 'distanceX':
        case 'distanceY': {
          const [pa, pb] = [a && pointOf(a), b && pointOf(b)];
          if (!pa || !pb) {
            drop();
            break;
          }
          const axis = kind === 'distanceX' ? 0 : 1;
          const d = (place(pb)[axis] as number) - (place(pa)[axis] as number);
          // FreeCAD's value runs from the first point to the second, and reads best positive.
          const [from, to] = d < 0 ? [pb, pa] : [pa, pb];
          constraints.push({
            type: kind === 'distanceX' ? DISTANCE_X : DISTANCE_Y,
            a: from,
            b: to,
            value: Math.abs(d),
            ...(d < 0 ? plain : dim),
          });
          break;
        }
        case 'length':
        case 'radius':
        case 'diameter': {
          const g = curveOf(c.curve as Json);
          if (g === undefined || g < 0) {
            drop();
            break;
          }
          const type = kind === 'length' ? DISTANCE : kind === 'radius' ? RADIUS : DIAMETER;
          constraints.push({ type, a: { geo: g, pos: 0 }, value: c.solved as number, ...dim });
          break;
        }
        case 'angle': {
          const ga = a && curveOf(a);
          const gb = b ? ('sketchX' in b ? -1 : curveOf(b)) : undefined;
          const [da, db] = [ga === undefined ? undefined : direction(ga), gb === undefined ? undefined : direction(gb)];
          if (ga === undefined || gb === undefined || !da || !db) {
            drop();
            break;
          }
          let turn = Math.atan2(db[1], db[0]) - Math.atan2(da[1], da[0]);
          while (turn > Math.PI) turn -= 2 * Math.PI;
          while (turn <= -Math.PI) turn += 2 * Math.PI;
          // A line against the sketch's x is FreeCAD's one-line angle, from x to the line.
          if (b && 'sketchX' in b) constraints.push({ type: ANGLE, a: { geo: ga, pos: 0 }, value: -turn, ...plain });
          else constraints.push({ type: ANGLE, a: { geo: ga, pos: 0 }, b: { geo: gb, pos: 0 }, value: turn, ...plain });
          break;
        }
        default:
          drop();
      }
    }
    if (dropped > 0) note(`${dropped} of its constraints have no form in FreeCAD and were left out`);
  }

  // Shared points as coincidences: a tree over each point's users, past what tangencies at ends already join.
  const coincident: Constraint[] = [];
  for (const list of pointsOf.values()) {
    const first = list[0] as Fc;
    for (const other of list.slice(1)) {
      if (joined.union(key(first), key(other)))
        coincident.push({ type: COINCIDENT, a: first, b: other, driving: true, active: true });
    }
  }
  const all = [...coincident, ...constraints];

  out.raw(
    'Geometry',
    'Part::PropertyGeometryList',
    `<GeometryList count="${xml.length}">${xml.join('')}</GeometryList>`,
  );
  out.raw(
    'Constraints',
    'Sketcher::PropertyConstraintList',
    `<ConstraintList count="${all.length}">${all.map(constraintXml).join('')}</ConstraintList>`,
  );
  all.forEach((c, i) => {
    const text = c.bound && c.driving ? input.expression?.(c.bound) : undefined;
    if (text) out.expression(c.name ? `.Constraints.${c.name}` : `Constraints[${i}]`, text);
  });
  return { geo, axes };
}
