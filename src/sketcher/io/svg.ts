/**
 * Sketch to a standalone SVG sized to the drawing (in mm, with a 1 mm
 * margin), one element per curve.
 *
 * SVG's y points down, so every y is written as `maxY − y` (maxY the top of
 * the margin-padded bounds) and the drawing reads upright; the viewBox is
 * `minX 0 width height`. Counter-clockwise in the sketch is clockwise in that
 * frame: arcs are written with sweep-flag 0 and ellipse rotations negated.
 *
 * - line → `<line>`; circle → `<circle>`; ellipse → `<ellipse>` with a rotate
 *   transform
 * - arc and ellipticalArc → `<path>` with an A command (a closed arc → `<circle>`)
 * - nurbs (and spline, bezier and conic rows) → `<path>` of its Bézier pieces
 *   (L, Q, C) when it is clamped, polynomial and of degree 3 or less; else a
 *   `<polyline>` through its flattening
 * - glyph contour → `<path>` of its segments, closed with Z
 *
 * Construction curves and point curves are left out; an empty sketch writes a
 * valid SVG with a unit viewBox.
 */
import { prepareCurve, type CurveShape } from '@tweakcad/format';
import type { SketchGeometry } from '../geometry';
import type { P2 } from '../rows';
import { TAU, drawnShapes, ellipseAxes, mod, sameAt } from './exportShapes';

const STROKE = 'black';
/** mm: a hairline, as laser and CNC tools expect. */
const STROKE_WIDTH = 0.1;
/** mm of border around the drawing's bounds. */
const MARGIN = 1;

const fmt = (n: number): string => String(n === 0 ? 0 : n);

export function sketchToSvg(geometry: SketchGeometry, extra: readonly CurveShape[] = []): string {
  const shapes = drawnShapes(geometry, extra);
  if (shapes.length === 0)
    return '<svg xmlns="http://www.w3.org/2000/svg" width="1mm" height="1mm" viewBox="0 0 1 1"></svg>\n';
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (p: P2) => {
    b.minX = Math.min(b.minX, p[0]);
    b.minY = Math.min(b.minY, p[1]);
    b.maxX = Math.max(b.maxX, p[0]);
    b.maxY = Math.max(b.maxY, p[1]);
  };
  for (const s of shapes) bounds(s, add);
  const minX = b.minX - MARGIN;
  const maxY = b.maxY + MARGIN;
  const width = b.maxX + MARGIN - minX;
  const height = maxY - (b.minY - MARGIN);
  const fy = (y: number) => maxY - y;
  const xy = (p: P2) => `${fmt(p[0])} ${fmt(fy(p[1]))}`;
  const elements = shapes.map((s) => element(s, fy, xy)).filter((e): e is string => e !== null);
  const header =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}mm" height="${fmt(height)}mm" ` +
    `viewBox="${fmt(minX)} 0 ${fmt(width)} ${fmt(height)}" fill="none" stroke="${STROKE}" stroke-width="${fmt(STROKE_WIDTH)}">`;
  return `${header}\n${elements.map((e) => `  ${e}`).join('\n')}\n</svg>\n`;
}

/** Adds points whose box holds the curve. */
function bounds(s: CurveShape, add: (p: P2) => void): void {
  switch (s.kind) {
    case 'line':
      add(s.start);
      add(s.end);
      return;
    case 'circle':
      add([s.center[0] - s.radius, s.center[1] - s.radius]);
      add([s.center[0] + s.radius, s.center[1] + s.radius]);
      return;
    case 'arc': {
      const r = Math.hypot(s.start[0] - s.center[0], s.start[1] - s.center[1]);
      add(s.start);
      add(s.end);
      const a = Math.atan2(s.start[1] - s.center[1], s.start[0] - s.center[0]);
      const sweep = sameAt(s.start, s.end)
        ? TAU
        : mod(Math.atan2(s.end[1] - s.center[1], s.end[0] - s.center[0]) - a, TAU);
      // The quadrant points the arc passes.
      for (let q = 0; q < 4; q++) {
        const t = (q * Math.PI) / 2;
        if (mod(t - a, TAU) <= sweep) add([s.center[0] + r * Math.cos(t), s.center[1] + r * Math.sin(t)]);
      }
      return;
    }
    case 'ellipse':
    case 'ellipticalArc': {
      const axes = ellipseAxes(s.center, s.majorEnd, s.minorRadius);
      if (!axes) return;
      const { ux, uy, major, minor } = axes;
      const hx = Math.hypot(major * ux, minor * uy);
      const hy = Math.hypot(major * uy, minor * ux);
      add([s.center[0] - hx, s.center[1] - hy]);
      add([s.center[0] + hx, s.center[1] + hy]);
      return;
    }
    case 'nurbs':
      for (const p of s.poles) add(p);
      return;
    case 'contour':
      for (const seg of s.segments) for (const p of seg) add(p);
  }
}

function element(s: CurveShape, fy: (y: number) => number, xy: (p: P2) => string): string | null {
  switch (s.kind) {
    case 'line':
      return `<line x1="${fmt(s.start[0])}" y1="${fmt(fy(s.start[1]))}" x2="${fmt(s.end[0])}" y2="${fmt(fy(s.end[1]))}" />`;
    case 'circle':
      return `<circle cx="${fmt(s.center[0])}" cy="${fmt(fy(s.center[1]))}" r="${fmt(s.radius)}" />`;
    case 'arc': {
      const r = Math.hypot(s.start[0] - s.center[0], s.start[1] - s.center[1]);
      if (sameAt(s.start, s.end)) return element({ kind: 'circle', center: s.center, radius: r }, fy, xy);
      const angle = (p: P2) => Math.atan2(p[1] - s.center[1], p[0] - s.center[0]);
      const large = mod(angle(s.end) - angle(s.start), TAU) > Math.PI ? 1 : 0;
      return `<path d="M ${xy(s.start)} A ${fmt(r)} ${fmt(r)} 0 ${large} 0 ${xy(s.end)}" />`;
    }
    case 'ellipse':
    case 'ellipticalArc': {
      const axes = ellipseAxes(s.center, s.majorEnd, s.minorRadius);
      if (!axes) return null;
      const rotation = fmt((-Math.atan2(axes.uy, axes.ux) * 180) / Math.PI);
      if (s.kind === 'ellipse' || sameAt(s.start, s.end)) {
        const [cx, cy] = [fmt(s.center[0]), fmt(fy(s.center[1]))];
        return `<ellipse cx="${cx}" cy="${cy}" rx="${fmt(axes.major)}" ry="${fmt(axes.minor)}" transform="rotate(${rotation} ${cx} ${cy})" />`;
      }
      const large = mod(axes.angleOf(s.end) - axes.angleOf(s.start), TAU) > Math.PI ? 1 : 0;
      return `<path d="M ${xy(s.start)} A ${fmt(axes.major)} ${fmt(axes.minor)} ${rotation} ${large} 0 ${xy(s.end)}" />`;
    }
    case 'nurbs': {
      const pieces = bezierPieces(s);
      if (pieces) return `<path d="M ${xy(pieces[0]?.[0] as P2)} ${pieces.map((p) => segment(p, xy)).join(' ')}" />`;
      const curve = prepareCurve(s, false);
      if (!curve) return null;
      const pts = curve.flatten(curve.tMin, curve.tMax, 4);
      return `<polyline points="${pts.map((p) => `${fmt(p[0])},${fmt(fy(p[1]))}`).join(' ')}" fill="none" />`;
    }
    case 'contour': {
      const segs = s.segments.filter((seg) => seg.length >= 2);
      if (segs.length === 0) return null;
      const first = (segs[0] as readonly P2[])[0] as P2;
      const lastSeg = segs[segs.length - 1] as readonly P2[];
      const closed = sameAt(first, lastSeg[lastSeg.length - 1] as P2);
      return `<path d="M ${xy(first)} ${segs.map((seg) => segment(seg, xy)).join(' ')}${closed ? ' Z' : ''}" />`;
    }
  }
}

/** One Bézier piece after its first point as an L, Q or C command. */
function segment(piece: readonly P2[], xy: (p: P2) => string): string {
  const command = piece.length === 2 ? 'L' : piece.length === 3 ? 'Q' : 'C';
  return `${command} ${piece.slice(1).map(xy).join(' ')}`;
}

type Nurbs = Extract<CurveShape, { kind: 'nurbs' }>;

/**
 * The Bézier pieces of a clamped, polynomial B-spline of degree 3 or less, by
 * inserting each inner knot up to the degree; null for any other.
 */
export function bezierPieces(s: Nurbs): P2[][] | null {
  const p = s.degree;
  const m = s.multiplicities;
  const polynomial = s.weights.every((w) => w === s.weights[0]);
  if (s.periodic || !polynomial || p < 1 || p > 3 || m[0] !== p + 1 || m[m.length - 1] !== p + 1) return null;
  let knots = s.knots.flatMap((k, i) => Array.from({ length: m[i] as number }, () => k));
  let poles: P2[] = [...s.poles];
  for (let i = 1; i < s.knots.length - 1; i++) {
    const u = s.knots[i] as number;
    for (let times = m[i] as number; times < p; times++) {
      // The span ending at u's last copy.
      const k = knots.lastIndexOf(u);
      const next: P2[] = [];
      for (let j = 0; j <= poles.length; j++) {
        if (j <= k - p) next.push(poles[j] as P2);
        else if (j > k) next.push(poles[j - 1] as P2);
        else {
          const a = (u - (knots[j] as number)) / ((knots[j + p] as number) - (knots[j] as number));
          const [p0, p1] = [poles[j - 1] as P2, poles[j] as P2];
          next.push([(1 - a) * p0[0] + a * p1[0], (1 - a) * p0[1] + a * p1[1]]);
        }
      }
      poles = next;
      knots = [...knots.slice(0, k + 1), u, ...knots.slice(k + 1)];
    }
  }
  const pieces: P2[][] = [];
  for (let j = 0; j + p < poles.length; j += p) pieces.push(poles.slice(j, j + p + 1));
  return pieces;
}
