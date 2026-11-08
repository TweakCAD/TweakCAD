import { at, boundsOverlap, distance, mod, TAU, type Curve, type CurveForm } from './curves';
import type { Vec2 } from './types';

/** Parameters of one place where two curves touch or cross. */
export type Contact = readonly [number, number];

type LineForm = Extract<CurveForm, { kind: 'line' }>;
type CircularForm = Extract<CurveForm, { kind: 'circular' }>;

function onLine(form: LineForm, t: number, tol: number): number | null {
  const slack = tol / distance(form.a, form.b);
  if (t < -slack || t > 1 + slack) return null;
  return Math.min(1, Math.max(0, t));
}

function onCircular(form: CircularForm, theta: number, tol: number): number | null {
  const t = mod(theta - form.start, TAU);
  if (form.sweep >= TAU) return t;
  const slack = tol / form.radius;
  if (t <= form.sweep) return t;
  if (t <= form.sweep + slack) return form.sweep;
  if (t >= TAU - slack) return 0;
  return null;
}

function lineLine(a: LineForm, b: LineForm, tol: number): Contact[] {
  const ax = a.b[0] - a.a[0];
  const ay = a.b[1] - a.a[1];
  const bx = b.b[0] - b.a[0];
  const by = b.b[1] - b.a[1];
  const denom = ax * by - ay * bx;
  if (Math.abs(denom) <= 1e-12 * Math.hypot(ax, ay) * Math.hypot(bx, by)) return [];
  const rx = b.a[0] - a.a[0];
  const ry = b.a[1] - a.a[1];
  const s = onLine(a, (rx * by - ry * bx) / denom, tol);
  const t = onLine(b, (rx * ay - ry * ax) / denom, tol);
  return s === null || t === null ? [] : [[s, t]];
}

function lineCircular(line: LineForm, circle: CircularForm, tol: number): Contact[] {
  const dx = line.b[0] - line.a[0];
  const dy = line.b[1] - line.a[1];
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const cx = circle.center[0] - line.a[0];
  const cy = circle.center[1] - line.a[1];
  const along = cx * ux + cy * uy;
  const off = cx * uy - cy * ux;
  const gap = Math.abs(off) - circle.radius;
  if (gap > tol) return [];
  const half = gap >= -tol ? 0 : Math.sqrt(circle.radius ** 2 - off ** 2);
  const out: Contact[] = [];
  for (const d of half === 0 ? [along] : [along - half, along + half]) {
    const s = onLine(line, d / length, tol);
    if (s === null) continue;
    const x = line.a[0] + d * ux - circle.center[0];
    const y = line.a[1] + d * uy - circle.center[1];
    const t = onCircular(circle, Math.atan2(y, x), tol);
    if (t !== null) out.push([s, t]);
  }
  return out;
}

function circularCircular(a: CircularForm, b: CircularForm, tol: number): Contact[] {
  const dx = b.center[0] - a.center[0];
  const dy = b.center[1] - a.center[1];
  const d = Math.hypot(dx, dy);
  if (d <= tol) return [];
  const inner = Math.abs(a.radius - b.radius);
  if (d > a.radius + b.radius + tol || d < inner - tol) return [];
  const base = Math.atan2(dy, dx);
  const tangent = Math.abs(d - a.radius - b.radius) <= tol || Math.abs(d - inner) <= tol;
  const cosine = (d * d + a.radius ** 2 - b.radius ** 2) / (2 * d * a.radius);
  const spread = Math.acos(Math.min(1, Math.max(-1, cosine)));
  const angles = tangent ? [cosine < 0 ? base + Math.PI : base] : [base - spread, base + spread];
  const out: Contact[] = [];
  for (const angle of angles) {
    const x = a.center[0] + a.radius * Math.cos(angle) - b.center[0];
    const y = a.center[1] + a.radius * Math.sin(angle) - b.center[1];
    const s = onCircular(a, angle, tol);
    const t = onCircular(b, Math.atan2(y, x), tol);
    if (s !== null && t !== null) out.push([s, t]);
  }
  return out;
}

interface Chord {
  index: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function chordsOf(points: readonly Vec2[], margin: number): Chord[] {
  const chords: Chord[] = [];
  for (let i = 1; i < points.length; i++) {
    const p = at(points, i - 1);
    const q = at(points, i);
    chords.push({
      index: i - 1,
      minX: Math.min(p[0], q[0]) - margin,
      maxX: Math.max(p[0], q[0]) + margin,
      minY: Math.min(p[1], q[1]) - margin,
      maxY: Math.max(p[1], q[1]) + margin,
    });
  }
  return chords.sort((x, y) => x.minX - y.minX || x.index - y.index);
}

/** Calls `visit` with every pair of chords whose boxes overlap, sweeping along x. */
function sweepChords(a: Chord[], b: Chord[], visit: (x: Chord, y: Chord) => void): void {
  let start = 0;
  for (const x of a) {
    while (start < b.length && at(b, start).maxX < x.minX) start++;
    for (let j = start; j < b.length; j++) {
      const y = at(b, j);
      if (y.minX > x.maxX) break;
      if (y.maxX >= x.minX && y.minY <= x.maxY && y.maxY >= x.minY) visit(x, y);
    }
  }
}

/** Newton from (s, t); near a tangency, alternating projection. Null if the curves stay apart. */
function refine(a: Curve, b: Curve, s0: number, t0: number, tol: number): Contact | null {
  let s = s0;
  let t = t0;
  for (let i = 0; i < 30; i++) {
    const pa = a.point(s);
    const pb = b.point(t);
    const rx = pb[0] - pa[0];
    const ry = pb[1] - pa[1];
    if (Math.hypot(rx, ry) <= tol * 1e-4) break;
    const [ax, ay] = a.derivative(s);
    const [bx, by] = b.derivative(t);
    const det = ax * by - ay * bx;
    const na = ax * ax + ay * ay;
    const nb = bx * bx + by * by;
    let ds: number;
    let dt: number;
    if (det * det > 1e-10 * na * nb) {
      ds = (rx * by - ry * bx) / det;
      dt = (rx * ay - ry * ax) / det;
    } else {
      ds = (rx * ax + ry * ay) / (na || 1);
      dt = -(rx * bx + ry * by) / (nb || 1);
    }
    s = a.closed ? s + ds : Math.min(a.tMax, Math.max(a.tMin, s + ds));
    t = b.closed ? t + dt : Math.min(b.tMax, Math.max(b.tMin, t + dt));
  }
  if (distance(a.point(s), b.point(t)) > tol) return null;
  return [a.wrap(s), b.wrap(t)];
}

function spanBetween(curve: Curve, s: number, t: number): number {
  const d = Math.abs(curve.lengthTo(s) - curve.lengthTo(t));
  return curve.closed ? Math.min(d, curve.length - d) : d;
}

function addContact(out: Contact[], a: Curve, b: Curve, contact: Contact, tol: number): void {
  for (const c of out) {
    if (spanBetween(a, c[0], contact[0]) <= 4 * tol && spanBetween(b, c[1], contact[1]) <= 4 * tol) {
      return;
    }
  }
  out.push(contact);
}

function generalContacts(a: Curve, b: Curve, tol: number): Contact[] {
  const pa = a.polyline();
  const pb = b.polyline();
  const out: Contact[] = [];
  const margin = (pa.deviation + pb.deviation) / 2 + tol;
  sweepChords(chordsOf(pa.points, margin), chordsOf(pb.points, margin), (x, y) => {
    const s = (at(pa.params, x.index) + at(pa.params, x.index + 1)) / 2;
    const t = (at(pb.params, y.index) + at(pb.params, y.index + 1)) / 2;
    const contact = refine(a, b, s, t, tol);
    if (contact) addContact(out, a, b, contact, tol);
  });
  return out;
}

/** Where an end of `a` lies on `b`. */
function endTouches(a: Curve, b: Curve, tol: number, swap: boolean, out: Contact[]): void {
  if (a.closed) return;
  for (const t of [a.tMin, a.tMax]) {
    const p = a.point(t);
    const near =
      p[0] >= b.bounds.minX - tol &&
      p[0] <= b.bounds.maxX + tol &&
      p[1] >= b.bounds.minY - tol &&
      p[1] <= b.bounds.maxY + tol;
    if (!near) continue;
    for (const hit of b.closest(p)) {
      if (hit.distance <= tol) out.push(swap ? [hit.t, t] : [t, hit.t]);
    }
  }
}

/** Every place two distinct curves touch or cross, the ends of one lying on the other included. */
export function contactsBetween(a: Curve, b: Curve, tol: number): Contact[] {
  if (!boundsOverlap(a.bounds, b.bounds, tol)) return [];
  const fa = a.form;
  const fb = b.form;
  let out: Contact[];
  if (fa.kind === 'line' && fb.kind === 'line') out = lineLine(fa, fb, tol);
  else if (fa.kind === 'line' && fb.kind === 'circular') out = lineCircular(fa, fb, tol);
  else if (fa.kind === 'circular' && fb.kind === 'line') {
    out = lineCircular(fb, fa, tol).map(([s, t]) => [t, s]);
  } else if (fa.kind === 'circular' && fb.kind === 'circular') out = circularCircular(fa, fb, tol);
  else out = generalContacts(a, b, tol);
  endTouches(a, b, tol, false, out);
  endTouches(b, a, tol, true, out);
  return out;
}

/** Every place a general curve crosses or touches itself. */
export function selfContacts(curve: Curve, tol: number): Contact[] {
  if (curve.form.kind !== 'general') return [];
  const line = curve.polyline();
  const chords = chordsOf(line.points, line.deviation / 2 + tol);
  const out: Contact[] = [];
  const last = chords.length - 1;
  sweepChords(chords, chords, (x, y) => {
    if (y.index <= x.index + 1) return;
    if (curve.closed && x.index === 0 && y.index === last) return;
    const s = (at(line.params, x.index) + at(line.params, x.index + 1)) / 2;
    const t = (at(line.params, y.index) + at(line.params, y.index + 1)) / 2;
    const contact = refine(curve, curve, s, t, tol);
    if (!contact || spanBetween(curve, contact[0], contact[1]) <= 16 * tol) return;
    addContact(out, curve, curve, contact, tol);
  });
  return out;
}
