/**
 * One decoded sketch as `core.sketch` rows (chapter 8). Curves keep the
 * sketch's own coordinates, in millimetres; the sketch's frame says where they
 * lie. File points that sit together or that a coincident relation joins are
 * one point, because coincidence here is a shared point. Regions are detected
 * on the curves as the file solved them, then profiles find theirs by the
 * curves around them.
 */
import {
  cyclePolyline,
  detectRegions,
  regionSamplePoint,
  type DetectedRegion,
  type Detection,
  type SolvedCurve,
  type SolvedSketch,
} from '@tweakcad/format';
import { curveGeometry } from '@tweakcad/worker/src/v2/sketchCurves';
import {
  convertDimension,
  convertRelation,
  type ConstraintContext,
  type Line,
  type Locus,
  type Pt,
  type Round,
  type SkipReason,
} from './constraints';
import type { ParameterPlan } from './parameters';
import type { F3dCurve, F3dProfileRegion, F3dSketch } from './parser/types';
import { CM_TO_MM, snap } from './placement';
import type { Json, Writer } from './writer';

const TWO_PI = Math.PI * 2;
/** Two points this close are the same point, in mm. */
const COINCIDENT_MM = 1e-6;
/** How far apart a coincident relation may hold two points and still join them, in mm. */
const RELATED_MM = 1e-4;
const CELL_MM = COINCIDENT_MM * 4;
/** An ellipse whose axes differ by less than this share of the longer is a circle. */
const ROUND_ELLIPSE = 1e-9;

type P2 = readonly [number, number];

export interface SketchStats {
  curves: number;
  curvesSkipped: number;
  constraints: number;
  skipped: Record<SkipReason, number>;
}

export interface ConvertedSketch {
  inputs: Json;
  stats: SketchStats;
  /** The region rows bounded by a file region's curves. */
  regionsOf(region: F3dProfileRegion): string[];
}

/** Union-find over file point ids. */
class Joined {
  private readonly parent = new Map<number, number>();
  find(id: number): number {
    let at = id;
    for (let p = this.parent.get(at); p !== undefined && p !== at; p = this.parent.get(at)) at = p;
    return at;
  }
  union(a: number, b: number): void {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/** The sketch's point rows. Points merge through a grid of cells a little wider than the tolerance. */
class Points {
  readonly rows: { id: string; x: number; y: number }[] = [];
  private readonly at = new Map<string, Pt>();
  private readonly cells = new Map<string, Pt[]>();

  constructor(private readonly w: Writer) {}

  private cell(v: number): number {
    return Math.floor(v / CELL_MM);
  }

  /** A new point, whatever is there. */
  add(x: number, y: number): Pt {
    const row = { id: this.w.ids('pt'), x: snap(x), y: snap(y) };
    this.rows.push(row);
    const p: Pt = { id: row.id, x, y };
    this.at.set(row.id, p);
    const key = `${this.cell(x)},${this.cell(y)}`;
    const list = this.cells.get(key);
    if (list) list.push(p);
    else this.cells.set(key, [p]);
    return p;
  }

  /** The point at this position, or a new one. */
  point(x: number, y: number): Pt {
    const [cx, cy] = [this.cell(x), this.cell(y)];
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (const p of this.cells.get(`${i},${j}`) ?? []) {
          if (Math.hypot(p.x - x, p.y - y) <= COINCIDENT_MM) return p;
        }
      }
    }
    return this.add(x, y);
  }

  byId(id: unknown): P2 {
    const p = this.at.get(id as string);
    return p ? [p.x, p.y] : [0, 0];
  }
}

/** Knots written as distinct values and how often each comes. */
function knotRuns(knots: readonly number[]): { values: number[]; multiplicities: number[] } {
  const values: number[] = [];
  const multiplicities: number[] = [];
  for (const k of knots) {
    const last = values[values.length - 1];
    if (last !== undefined && Math.abs(k - last) < 1e-12)
      multiplicities[multiplicities.length - 1] = (multiplicities[multiplicities.length - 1] as number) + 1;
    else {
      values.push(k);
      multiplicities.push(1);
    }
  }
  return { values, multiplicities };
}

/** Shape values as this file writes them: literal numbers and flags. */
function literal(v: unknown): number {
  const text = ((((v as Json).def as Json).expr as Json).text as string).replace(/ mm$/, '');
  return text === 'true' ? 1 : text === 'false' ? 0 : Number(text);
}

export function convertSketch(sketch: F3dSketch, w: Writer, plan: ParameterPlan): ConvertedSketch {
  const stats: SketchStats = {
    curves: 0,
    curvesSkipped: 0,
    constraints: 0,
    skipped: { noCounterpart: 0, notSatisfied: 0, unsupportedGeometry: 0, merged: 0 },
  };
  const points = new Points(w);
  const mm = (v: number) => v * CM_TO_MM;

  // Coincident relations first: the points they join are written as one.
  const joined = new Joined();
  for (const r of sketch.relations) {
    if (r.kind !== 'coincident' || r.loci.length !== 2) continue;
    const [a, b] = [sketch.points.get(r.loci[0] as number), sketch.points.get(r.loci[1] as number)];
    if (a && b && Math.hypot(a.x - b.x, a.y - b.y) * CM_TO_MM <= RELATED_MM) joined.union(a.id, b.id);
  }
  const pointOf = new Map<number, Pt>();
  const rootOf = new Map<number, Pt>();
  for (const p of sketch.points.values()) {
    const root = joined.find(p.id);
    const at = rootOf.get(root) ?? points.point(mm(p.x), mm(p.y));
    rootOf.set(root, at);
    pointOf.set(p.id, at);
  }

  const curves: Json[] = [];
  const curveIds = new Map<number, Locus>();
  const byKey = new Map<string, string[]>();
  const used = new Set<string>();
  const row = (kind: string, construction: boolean, fields: Json): string => {
    const id = w.ids('crv');
    curves.push({ id, kind, construction: w.flag(construction), origin: { drawn: {} }, ...fields });
    stats.curves++;
    return id;
  };
  const remember = (c: F3dCurve, id: string): void => {
    for (const key of [`${c.primaryId}:${c.secondaryId}`, `${c.primaryId}`])
      byKey.set(key, [...(byKey.get(key) ?? []), id]);
  };
  const mark = (...ps: Pt[]): void => ps.forEach((p) => used.add(p.id));

  for (const c of sketch.curves) {
    switch (c.kind) {
      case 'line': {
        const [a, b] = [pointOf.get(c.startId), pointOf.get(c.endId)];
        if (!a || !b || a === b) {
          stats.curvesSkipped++;
          break;
        }
        mark(a, b);
        const id = row('line', c.construction, { start: a.id, end: b.id });
        curveIds.set(c.id, { kind: 'line', line: { id, a, b } satisfies Line });
        remember(c, id);
        break;
      }
      case 'circle': {
        const center = pointOf.get(c.centerId);
        if (!center || c.radius <= 0) {
          stats.curvesSkipped++;
          break;
        }
        mark(center);
        const radius = mm(c.radius);
        const id = row('circle', c.construction, { center: center.id, radius: snap(radius) });
        curveIds.set(c.id, { kind: 'round', round: { id, center, radius } satisfies Round });
        remember(c, id);
        break;
      }
      case 'arc': {
        const center = points.point(mm(c.center[0]), mm(c.center[1]));
        const a = points.point(mm(c.start[0]), mm(c.start[1]));
        const b = points.point(mm(c.end[0]), mm(c.end[1]));
        if (a === b || c.radius <= 0) {
          stats.curvesSkipped++;
          break;
        }
        mark(center, a, b);
        // An arc here runs anticlockwise from its start to its end.
        const [start, end] = c.counterClockwise ? [a, b] : [b, a];
        const id = row('arc', c.construction, { center: center.id, start: start.id, end: end.id });
        curveIds.set(c.id, { kind: 'round', round: { id, center, radius: mm(c.radius) } });
        remember(c, id);
        break;
      }
      case 'ellipse': {
        const center = points.point(mm(c.center[0]), mm(c.center[1]));
        // The file can name the longer axis as its minor one; a major axis here is the longer.
        const swapped = c.minorRadius > c.majorRadius;
        const [axis, length, shorter] = swapped
          ? [c.minorAxis, c.minorRadius, c.majorRadius]
          : [c.majorAxis, c.majorRadius, c.minorRadius];
        const whole = Math.abs(c.endAngle - c.startAngle - TWO_PI) < 1e-9;
        const onAngle = (t: number) =>
          points.point(
            mm(
              c.center[0] + c.majorRadius * Math.cos(t) * c.majorAxis[0] + c.minorRadius * Math.sin(t) * c.minorAxis[0],
            ),
            mm(
              c.center[1] + c.majorRadius * Math.cos(t) * c.majorAxis[1] + c.minorRadius * Math.sin(t) * c.minorAxis[1],
            ),
          );
        // The file's angle runs towards its minor axis, which can be either way round.
        const forward = c.majorAxis[0] * c.minorAxis[1] - c.majorAxis[1] * c.minorAxis[0] > 0;
        // Axes this close have no foci to hold apart: the curve is round.
        if (length - shorter <= ROUND_ELLIPSE * length) {
          mark(center);
          if (whole) remember(c, row('circle', c.construction, { center: center.id, radius: snap(mm(length)) }));
          else {
            const [a, b] = [onAngle(c.startAngle), onAngle(c.endAngle)];
            mark(a, b);
            const [start, end] = forward ? [a, b] : [b, a];
            remember(c, row('arc', c.construction, { center: center.id, start: start.id, end: end.id }));
          }
          break;
        }
        const major = points.point(mm(c.center[0] + axis[0] * length), mm(c.center[1] + axis[1] * length));
        const minorRadius = snap(mm(shorter));
        if (center === major || !(minorRadius > 0)) {
          stats.curvesSkipped++;
          break;
        }
        mark(center, major);
        if (whole) {
          remember(c, row('ellipse', c.construction, { center: center.id, majorEnd: major.id, minorRadius }));
          break;
        }
        const [a, b] = [onAngle(c.startAngle), onAngle(c.endAngle)];
        mark(a, b);
        const [start, end] = forward ? [a, b] : [b, a];
        remember(
          c,
          row('ellipticalArc', c.construction, {
            center: center.id,
            majorEnd: major.id,
            minorRadius,
            start: start.id,
            end: end.id,
          }),
        );
        break;
      }
      case 'spline': {
        if (c.poles.length < 2 || c.knots.length !== c.poles.length + c.degree + 1) {
          stats.curvesSkipped++;
          break;
        }
        const last = c.poles.length - 1;
        // End poles share the points curves meet at; inner poles are the curve's own.
        const poles = c.poles.map((p, i) =>
          i === 0 || i === last ? points.point(mm(p[0]), mm(p[1])) : points.add(mm(p[0]), mm(p[1])),
        );
        mark(...poles);
        const weights = c.weights.length === c.poles.length ? c.weights : c.poles.map(() => 1);
        const knots = knotRuns(c.knots);
        remember(
          c,
          row('nurbs', c.construction, {
            degree: w.val(String(c.degree)),
            poles: poles.map((p) => p.id),
            weights: weights.map((v) => w.val(String(snap(v)))),
            knots: knots.values.map((v) => w.val(String(snap(v)))),
            multiplicities: knots.multiplicities,
            periodic: w.flag(false),
          }),
        );
        break;
      }
    }
  }

  // A point no curve uses is still drawn: hole centres are often just that.
  for (const p of new Set(pointOf.values())) if (!used.has(p.id)) row('point', false, { at: p.id });

  const ctx: ConstraintContext = {
    w,
    plan,
    locus(id) {
      const point = pointOf.get(id);
      return point ? { kind: 'point', point } : (curveIds.get(id) ?? null);
    },
  };
  const constraints: Json[] = [];
  // A point on the sketch's origin stays there.
  for (const p of new Set(pointOf.values())) {
    if (Math.hypot(p.x, p.y) > COINCIDENT_MM) continue;
    for (const kind of ['horizontal', 'vertical']) {
      constraints.push({
        id: w.ids('con'),
        kind,
        active: w.flag(true),
        of: { points: { a: { point: { id: p.id } }, b: { sketchStandard: { name: 'origin' } } } },
      });
    }
  }
  const collect = (outcome: ReturnType<typeof convertRelation>): void => {
    if ('skip' in outcome) stats.skipped[outcome.skip]++;
    else constraints.push(...outcome.rows);
  };
  for (const r of sketch.relations) collect(convertRelation(ctx, r));
  for (const d of sketch.dimensions) collect(convertDimension(ctx, d));
  stats.constraints = constraints.length;

  const solved: SolvedSketch = {
    points: points.rows,
    curves: curves.flatMap((c): SolvedCurve[] => {
      if (literal(c.construction) === 1 || c.kind === 'point') return [];
      try {
        const geometry = curveGeometry(c, {
          point: (id) => points.byId(id),
          number: literal,
          variable: () => undefined,
        });
        return geometry ? [{ key: { drawn: { id: c.id as string } }, ...geometry }] : [];
      } catch {
        return [];
      }
    }),
  };
  const detection = detectRegions(solved);
  const regions = detection.regions.map((r) => ({
    id: w.ids('reg'),
    loop: r.loop,
    holes: r.holes,
    origin: { detected: {} },
  }));
  const stretches = stretchesOf(detection);

  const regionsOf = (region: F3dProfileRegion): string[] => {
    const wanted = new Set<string>();
    for (const c of region.curves)
      for (const id of byKey.get(`${c.primary}:${c.secondary}`) ?? byKey.get(`${c.primary}`) ?? []) wanted.add(id);
    if (wanted.size === 0) return [];
    const found = onCurves(stretches, wanted);
    if (found.length > 0) return found.map((i) => (regions[i] as { id: string }).id);
    // Curves drawn after the feature split its profile: the regions inside the outline the listed curves draw.
    const listed = { points: solved.points, curves: solved.curves.filter((c) => wanted.has(curveIdOf(c.key) ?? '')) };
    const outline = detectRegions(listed);
    const shapes = onCurves(stretchesOf(outline), wanted).map((i) => outline.regions[i] as DetectedRegion);
    if (shapes.length === 0) return [];
    const polygons = shapes.map((r) => ({
      outer: cyclePolyline(outline.arrangement, r.outer, 8),
      inner: r.inner.map((c) => cyclePolyline(outline.arrangement, c, 8)),
    }));
    return detection.regions.flatMap((r, i) => {
      const p = regionSamplePoint(detection.arrangement, r);
      const inside = p && polygons.some((g) => evenOdd(p, g.outer) && !g.inner.some((h) => evenOdd(p, h)));
      return inside ? [(regions[i] as { id: string }).id] : [];
    });
  };

  const inputs: Json = { points: points.rows, curves, constraints, regions, retired: [], text: [] };
  return { inputs, stats, regionsOf };
}

const curveIdOf = (key: unknown): string | undefined => (key as { drawn?: { id: string } }).drawn?.id;

/**
 * Each region's boundary as stretches, each the set of drawn curves lying over it: where two curves
 * overlap, detection keeps one of them, and the file's profile may list the other.
 */
function stretchesOf(detection: Detection): Set<string>[][] {
  const { arrangement } = detection;
  const ends = (e: number): string => {
    const edge = arrangement.edges[e];
    return edge ? [edge.from.vertex, edge.to.vertex].sort((a, b) => a - b).join(',') : '';
  };
  const sameEnds = new Map<string, number[]>();
  arrangement.edges.forEach((_, e) => {
    const group = sameEnds.get(ends(e));
    if (group) group.push(e);
    else sameEnds.set(ends(e), [e]);
  });
  const coveredBy = (e: number): Set<string> => {
    const ids = new Set<string>();
    const edge = arrangement.edges[e];
    if (!edge) return ids;
    const own = curveIdOf(arrangement.curves[edge.curve]?.source.key);
    if (own) ids.add(own);
    const group = sameEnds.get(ends(e)) ?? [];
    // Only when the stretch is the one kept between its ends are the others there copies of it.
    if (group.filter((g) => !arrangement.edges[g]?.duplicate).length !== 1) return ids;
    for (const g of group) {
      const other = arrangement.edges[g];
      const id = other?.duplicate ? curveIdOf(arrangement.curves[other.curve]?.source.key) : undefined;
      if (id) ids.add(id);
    }
    return ids;
  };
  return detection.regions.map((r) =>
    [r.outer, ...r.inner].flatMap((cycle) => cycle.halfEdges.map((h) => coveredBy(h >> 1))),
  );
}

/**
 * The regions whose every stretch lies on a wanted curve: those that use every wanted curve when
 * there are any, else all of them, since trimmed curves bound less than the whole region lists.
 */
function onCurves(stretches: readonly Set<string>[][], wanted: ReadonlySet<string>): number[] {
  const on = stretches.flatMap((region, i) => {
    if (!region.every((ids) => [...ids].some((id) => wanted.has(id)))) return [];
    const used = new Set(region.flatMap((ids) => [...ids].filter((id) => wanted.has(id))));
    return [{ i, exact: used.size === wanted.size }];
  });
  const exact = on.filter((r) => r.exact);
  return (exact.length > 0 ? exact : on).map((r) => r.i);
}

/** Even-odd containment of a point in a closed polygon. */
function evenOdd(p: readonly [number, number], polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 1; i < polygon.length; i++) {
    const a = polygon[i - 1] as readonly [number, number];
    const b = polygon[i] as readonly [number, number];
    if (a[1] > p[1] !== b[1] > p[1] && a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]) > p[0]) inside = !inside;
  }
  return inside;
}
