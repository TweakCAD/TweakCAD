/**
 * Sketch to ASCII DXF: a HEADER declaring mm ($INSUNITS = 4), an ENTITIES
 * section of native curve entities, and EOF. Coordinates are the sketch
 * frame's, in mm, y up as in DXF.
 *
 * - line → LINE; circle → CIRCLE; arc → ARC (degrees, counter-clockwise; a
 *   closed arc → CIRCLE)
 * - ellipse → ELLIPSE (major axis relative to the centre, ratio ≤ 1);
 *   ellipticalArc → ELLIPSE with its start and end parameters
 * - nurbs (and spline, bezier and conic rows, which build to one) → SPLINE
 *   with its knots, and its weights when rational; a periodic one → a closed
 *   LWPOLYLINE through its flattening
 * - glyph contour → a LINE or Bézier SPLINE per segment
 *
 * Construction curves and point curves are left out; an empty sketch writes
 * an empty ENTITIES section.
 */
import { prepareCurve, type CurveShape } from '@tweakcad/format';
import type { SketchGeometry } from '../geometry';
import type { P2 } from '../rows';
import { TAU, drawnShapes, ellipseAxes, mod, sameAt } from './exportShapes';

const DEG = 180 / Math.PI;

class Groups {
  readonly lines: string[] = [];
  add(code: number, value: string | number): void {
    this.lines.push(String(code), typeof value === 'number' ? String(value === 0 ? 0 : value) : value);
  }
  point(x: number, y: number, code = 10): void {
    this.add(code, x);
    this.add(code + 10, y);
    this.add(code + 20, 0);
  }
  entity(type: string): void {
    this.add(0, type);
    this.add(8, '0');
  }
}

export function sketchToDxf(geometry: SketchGeometry, extra: readonly CurveShape[] = []): string {
  const g = new Groups();
  g.add(0, 'SECTION');
  g.add(2, 'HEADER');
  g.add(9, '$INSUNITS');
  g.add(70, 4);
  g.add(0, 'ENDSEC');
  g.add(0, 'SECTION');
  g.add(2, 'ENTITIES');
  for (const shape of drawnShapes(geometry, extra)) write(g, shape);
  g.add(0, 'ENDSEC');
  g.add(0, 'EOF');
  return g.lines.join('\n') + '\n';
}

function write(g: Groups, s: CurveShape): void {
  switch (s.kind) {
    case 'line':
      g.entity('LINE');
      g.point(s.start[0], s.start[1]);
      g.point(s.end[0], s.end[1], 11);
      return;
    case 'circle':
      circle(g, s.center, s.radius);
      return;
    case 'arc': {
      const r = Math.hypot(s.start[0] - s.center[0], s.start[1] - s.center[1]);
      if (sameAt(s.start, s.end)) {
        circle(g, s.center, r);
        return;
      }
      const angle = (p: P2) => Math.atan2(p[1] - s.center[1], p[0] - s.center[0]) * DEG;
      g.entity('ARC');
      g.point(s.center[0], s.center[1]);
      g.add(40, r);
      g.add(50, angle(s.start));
      g.add(51, angle(s.end));
      return;
    }
    case 'ellipse':
    case 'ellipticalArc': {
      const axes = ellipseAxes(s.center, s.majorEnd, s.minorRadius);
      if (!axes) return;
      let [t0, t1] = [0, TAU];
      if (s.kind === 'ellipticalArc' && !sameAt(s.start, s.end)) {
        t0 = axes.angleOf(s.start);
        t1 = t0 + mod(axes.angleOf(s.end) - t0, TAU);
      }
      g.entity('ELLIPSE');
      g.point(s.center[0], s.center[1]);
      g.point(axes.ux * axes.major, axes.uy * axes.major, 11);
      g.add(40, axes.minor / axes.major);
      g.add(41, t0);
      g.add(42, t1);
      return;
    }
    case 'nurbs': {
      if (s.periodic) {
        polyline(g, s);
        return;
      }
      const flat = s.knots.flatMap((k, i) => Array.from({ length: s.multiplicities[i] as number }, () => k));
      spline(g, s.degree, s.poles, flat, s.weights);
      return;
    }
    case 'contour':
      for (const seg of s.segments) {
        if (seg.length === 2) write(g, { kind: 'line', start: seg[0] as P2, end: seg[1] as P2 });
        else if (seg.length > 2) {
          const d = seg.length - 1;
          spline(
            g,
            d,
            seg,
            [...Array.from({ length: d + 1 }, () => 0), ...Array.from({ length: d + 1 }, () => 1)],
            seg.map(() => 1),
          );
        }
      }
      return;
  }
}

function circle(g: Groups, center: P2, r: number): void {
  g.entity('CIRCLE');
  g.point(center[0], center[1]);
  g.add(40, r);
}

function spline(
  g: Groups,
  degree: number,
  poles: readonly P2[],
  flat: readonly number[],
  weights: readonly number[],
): void {
  const rational = weights.some((w) => w !== weights[0]);
  g.entity('SPLINE');
  g.add(70, 8 | (rational ? 4 : 0));
  g.add(71, degree);
  g.add(72, flat.length);
  g.add(73, poles.length);
  g.add(74, 0);
  for (const k of flat) g.add(40, k);
  if (rational) for (const w of weights) g.add(41, w);
  for (const p of poles) g.point(p[0], p[1]);
}

function polyline(g: Groups, s: CurveShape): void {
  const curve = prepareCurve(s, false);
  if (!curve) return;
  const pts = curve.flatten(curve.tMin, curve.tMax, 4);
  if (pts.length > 1 && sameAt(pts[0] as P2, pts[pts.length - 1] as P2)) pts.pop();
  g.entity('LWPOLYLINE');
  g.add(90, pts.length);
  g.add(70, 1);
  for (const p of pts) {
    g.add(10, p[0]);
    g.add(20, p[1]);
  }
}
