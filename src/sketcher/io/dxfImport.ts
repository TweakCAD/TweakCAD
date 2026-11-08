/**
 * ASCII DXF to sketch rows. Reads the ENTITIES section:
 *
 * - LINE → line
 * - LWPOLYLINE, POLYLINE with its VERTEX run → lines, a bulged segment an arc
 * - CIRCLE → circle; ARC → arc (a full turn → circle)
 * - ELLIPSE → ellipse, or ellipticalArc when its parameters span less than a turn
 * - SPLINE → the B-spline of its control points, knots and weights, as the
 *   simplest row that is exactly it (`addBSpline`); a SPLINE of fit points only
 *   → spline through them
 *
 * Every other entity is reported in `skipped`. Coordinates are scaled to mm by
 * the HEADER `$INSUNITS` (missing or unitless: mm), keeping the drawing's real
 * size; a code DXF does not name is refused (thrown), never guessed. DXF y points up, as the sketch's does. Arcs and polylines whose
 * extrusion is −Z are mirrored into the sketch's +Z frame.
 */
import type { P2, RowMaker } from '../rows';
import { ImportRows, addBSpline, clampedUniform, nurbsFromFlat, type SketchImport } from './importRows';

/** $INSUNITS code → mm per drawing unit, for every code DXF names; 0 (unitless) is mm. */
const INSUNITS_TO_MM: Record<number, number> = {
  0: 1,
  1: 25.4,
  2: 304.8,
  3: 1609344,
  4: 1,
  5: 10,
  6: 1000,
  7: 1e6,
  8: 0.0000254,
  9: 0.0254,
  10: 914.4,
  11: 1e-7,
  12: 1e-6,
  13: 1e-3,
  14: 100,
  15: 1e4,
  16: 1e5,
  17: 1e12,
  18: 1.495978707e14,
  19: 9.4607304725808e18,
  20: 3.085677581491367e19,
  21: 1200000 / 3937,
  22: 100000 / 3937,
  23: 3600000 / 3937,
  24: 6336000000 / 3937,
};

const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;

type Pair = readonly [number, string];

interface DxfEntity {
  type: string;
  /** The entity's group codes and values in file order. */
  pairs: Pair[];
}

/** The first value of a group code as a number, or `fallback`. */
function num(e: DxfEntity, code: number, fallback = 0): number {
  const pair = e.pairs.find(([c]) => c === code);
  const n = pair ? Number(pair[1]) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** The points of repeated x / y group codes, in file order. */
function pointsOf(e: DxfEntity, xCode: number): P2[] {
  const out: [number, number][] = [];
  for (const [code, value] of e.pairs) {
    if (code === xCode) out.push([Number(value) || 0, 0]);
    else if (code === xCode + 10 && out.length > 0) (out[out.length - 1] as [number, number])[1] = Number(value) || 0;
  }
  return out;
}

const valuesOf = (e: DxfEntity, code: number): number[] =>
  e.pairs
    .filter(([c]) => c === code)
    .map(([, v]) => Number(v))
    .filter(Number.isFinite);

/** The file's ENTITIES and its `$INSUNITS`. */
function parse(text: string): { entities: DxfEntity[]; insunits: number } {
  const lines = text.split(/\r\n|\r|\n/);
  const entities: DxfEntity[] = [];
  let section = '';
  let current: DxfEntity | null = null;
  let insunits = 0;
  let headerVariable = '';
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number((lines[i] as string).trim());
    const value = (lines[i + 1] as string).trim();
    if (!Number.isInteger(code)) continue;
    if (code === 0) {
      current = null;
      if (value === 'SECTION') section = '';
      else if (value === 'ENDSEC') section = '';
      else if (value === 'EOF') break;
      else if (section === 'ENTITIES') {
        current = { type: value, pairs: [] };
        entities.push(current);
      }
      continue;
    }
    if (code === 2 && section === '' && !current) {
      section = value;
      continue;
    }
    if (section === 'HEADER') {
      if (code === 9) headerVariable = value;
      else if (headerVariable === '$INSUNITS' && code === 70) insunits = Number(value) || 0;
      continue;
    }
    current?.pairs.push([code, value]);
  }
  return { entities, insunits };
}

/** Reads DXF text into sketch rows. Entities it does not read are skipped; only an unknown unit throws. */
export function importDxf(text: string, make: RowMaker): SketchImport {
  const { entities, insunits } = parse(text);
  const f = INSUNITS_TO_MM[insunits];
  if (f === undefined) throw new Error(`its drawing unit ($INSUNITS ${insunits}) is not one DXF names`);
  const rows = new ImportRows(make);
  const scaled = (p: P2): P2 => [p[0] * f, p[1] * f];
  /** −1 when the entity's extrusion is −Z: its object frame has x mirrored. */
  const mirror = (e: DxfEntity): 1 | -1 => (num(e, 230, 1) < 0 ? -1 : 1);

  const polyline = (vertices: { at: P2; bulge: number }[], closed: boolean, m: 1 | -1) => {
    const n = vertices.length;
    if (n < 2) return;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = vertices[i] as { at: P2; bulge: number };
      const b = (vertices[(i + 1) % n] as { at: P2; bulge: number }).at;
      const [pa, pb] = [scaled([a.at[0] * m, a.at[1]]), scaled([b[0] * m, b[1]])];
      bulged(rows, pa, pb, a.bulge * m);
    }
  };

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i] as DxfEntity;
    switch (e.type) {
      case 'LINE':
        rows.line(scaled([num(e, 10), num(e, 20)]), scaled([num(e, 11), num(e, 21)]));
        break;
      case 'CIRCLE': {
        const r = num(e, 40) * f;
        if (r > 0) rows.circle(scaled([num(e, 10) * mirror(e), num(e, 20)]), r);
        break;
      }
      case 'ARC': {
        const m = mirror(e);
        const c = scaled([num(e, 10) * m, num(e, 20)]);
        const r = num(e, 40) * f;
        if (!(r > 0)) break;
        let [a0, a1] = [num(e, 50) * DEG, num(e, 51) * DEG];
        // Counter-clockwise about −Z is clockwise here: the angles mirror and swap.
        if (m < 0) [a0, a1] = [Math.PI - a1, Math.PI - a0];
        const sweep = mod(a1 - a0, TAU);
        const at = (t: number): P2 => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
        if (sweep < 1e-12 || TAU - sweep < 1e-12) rows.circle(c, r);
        else rows.arc(c, at(a0), at(a0 + sweep));
        break;
      }
      case 'ELLIPSE': {
        const c = scaled([num(e, 10), num(e, 20)]);
        const major: P2 = [num(e, 11) * f, num(e, 21) * f];
        const ratio = num(e, 40);
        const a = Math.hypot(major[0], major[1]);
        if (!(a > 0) || !(ratio > 0)) break;
        const minor: P2 = [-major[1] * ratio, major[0] * ratio];
        let [t0, t1] = [num(e, 41, 0), num(e, 42, TAU)];
        if (num(e, 230, 1) < 0) [t0, t1] = [-t1, -t0];
        const sweep = mod(t1 - t0, TAU);
        const majorEnd: P2 = [c[0] + major[0], c[1] + major[1]];
        const at = (t: number): P2 => [
          c[0] + Math.cos(t) * major[0] + Math.sin(t) * minor[0],
          c[1] + Math.cos(t) * major[1] + Math.sin(t) * minor[1],
        ];
        if (sweep < 1e-12 || TAU - sweep < 1e-12) rows.ellipse(c, majorEnd, a * ratio);
        else rows.ellipticalArc(c, majorEnd, a * ratio, at(t0), at(t0 + sweep));
        break;
      }
      case 'LWPOLYLINE': {
        const vertices: { at: P2; bulge: number }[] = [];
        for (const [code, value] of e.pairs) {
          const last = vertices[vertices.length - 1];
          if (code === 10) vertices.push({ at: [Number(value) || 0, 0], bulge: 0 });
          else if (code === 20 && last) last.at = [last.at[0], Number(value) || 0];
          else if (code === 42 && last) last.bulge = Number(value) || 0;
        }
        polyline(vertices, (num(e, 70) & 1) === 1, mirror(e));
        break;
      }
      case 'POLYLINE': {
        const flags = num(e, 70);
        const vertices: { at: P2; bulge: number }[] = [];
        let j = i + 1;
        for (; j < entities.length && (entities[j] as DxfEntity).type === 'VERTEX'; j++) {
          const v = entities[j] as DxfEntity;
          vertices.push({ at: [num(v, 10), num(v, 20)], bulge: num(v, 42) });
        }
        if (j < entities.length && (entities[j] as DxfEntity).type === 'SEQEND') j++;
        i = j - 1;
        // Polygon and polyface meshes are surfaces, not sketch curves.
        if (flags & (16 | 64)) rows.skip('POLYLINE');
        else polyline(vertices, (flags & 1) === 1, mirror(e));
        break;
      }
      case 'SPLINE':
        spline(rows, e, f);
        break;
      case 'VERTEX':
      case 'SEQEND':
        break;
      default:
        rows.skip(e.type);
    }
  }
  return rows.result('Import DXF');
}

function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

/**
 * A polyline segment from `a` to `b` with bulge tan(θ/4), θ its included angle
 * (positive counter-clockwise); bulge 0 is straight.
 */
function bulged(rows: ImportRows, a: P2, b: P2, bulge: number): void {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const chord = Math.hypot(dx, dy);
  const theta = 4 * Math.atan(bulge);
  if (bulge === 0 || chord === 0 || Math.sin(theta / 2) === 0) {
    rows.line(a, b);
    return;
  }
  const radius = chord / (2 * Math.abs(Math.sin(theta / 2)));
  const h = radius * Math.cos(theta / 2) * Math.sign(bulge);
  const center: P2 = [(a[0] + b[0]) / 2 - (dy / chord) * h, (a[1] + b[1]) / 2 + (dx / chord) * h];
  if (bulge > 0) rows.arc(center, a, b);
  else rows.arc(center, b, a);
}

/** A SPLINE: its control points, knots (40) and weights (41), or its fit points (11). */
function spline(rows: ImportRows, e: DxfEntity, f: number): void {
  const poles = pointsOf(e, 10).map((p): P2 => [p[0] * f, p[1] * f]);
  if (poles.length < 2) {
    const fit = pointsOf(e, 11).map((p): P2 => [p[0] * f, p[1] * f]);
    if (fit.length >= 2) rows.spline(fit);
    return;
  }
  const degree = Math.max(1, Math.min(Math.round(num(e, 71, 3)), poles.length - 1));
  const given = valuesOf(e, 41);
  const weights = given.length === poles.length && given.every((w) => w > 0) ? given : poles.map(() => 1);
  const data = nurbsFromFlat(degree, poles, weights, valuesOf(e, 40)) ?? clampedUniform(degree, poles, weights);
  addBSpline(rows, data);
}
