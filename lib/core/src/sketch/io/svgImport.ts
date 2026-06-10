/**
 * SVG → sketch geometry import.
 *
 * IMPORT ONLY, 2D-sketch only — the inverse of `./svg.ts` (sketch → SVG
 * export). It produces the SAME normalized `DxfPrimitive[]` the DXF importer
 * uses and hands them to `buildEditorStateFromPrimitives`, so SVG import
 * inherits the editor's junction model (distinct points + removable
 * `coincident` constraints) and the editable-loop result for free. The only
 * SVG-specific work is here: XML walking, the `<path>` `d` mini-language,
 * element transforms, the Y-flip, and unit scaling.
 *
 * Supported elements: `<line>`, `<rect>` (sharp corners), `<circle>`,
 * `<ellipse>`, `<polyline>`, `<polygon>`, `<path>`. Walked through any nesting
 * of `<g>`; each element's accumulated `transform` (translate / scale / rotate
 * / matrix) is applied. Everything else (text, images, gradients, filters) is
 * collected into `skipped`.
 *
 * Conventions — the inverse of `./svg.ts`:
 *   - SVG's Y axis points DOWN; the sketch plane's points UP. Every Y is
 *     flipped around the viewBox (`minY + height - y`), undoing the export's
 *     flip so the drawing comes in upright, not mirrored.
 *   - Coordinates are scaled to mm from the root `width` + `viewBox` (a
 *     `width="100mm"` over a 100-unit viewBox ⇒ 1 unit = 1 mm). Unitless /
 *     px documents are taken as mm (1:1), matching what `./svg.ts` writes.
 *   - Curves (cubic/quadratic beziers) and elliptical arcs are SAMPLED into
 *     points and imported as `spline` primitives — faithful to the drawn
 *     shape without arc-under-transform math. Straight segments stay lines.
 */

import { buildEditorStateFromPrimitives, type DxfPrimitive } from './dxfImport.ts';
import type { EditorState, IdFactory } from '../operations.ts';
import { parseXml, type XmlNode } from '../../xml.ts';

/** Normalized 2D import primitive — shared with the DXF importer. */
type SketchPrimitive = DxfPrimitive;

/** Samples per bezier / arc segment when flattening curves to a spline. */
const CURVE_SAMPLES = 24;

export interface SvgImportResult {
  /** Primitives in sketch space (Y-up, millimetres). */
  primitives: SketchPrimitive[];
  /** De-duplicated list of SVG element names that were skipped. */
  skipped: string[];
  /** mm per SVG user unit applied from width/viewBox (1 = unitless/px ⇒ mm). */
  unitScale: number;
}

// ---- 2D affine transform [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f ----

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function multiply(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Average linear scale of a matrix (sqrt of |determinant|) for radii. */
function scaleOf(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

/** Parse an SVG `transform` attribute (possibly several ops) into one matrix. */
function parseTransform(attr: string | undefined): Mat {
  if (!attr) return IDENTITY;
  let m: Mat = IDENTITY;
  const re = /(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attr)) !== null) {
    const op = match[1]!;
    const a = match[2]!.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
    let t: Mat = IDENTITY;
    switch (op) {
      case 'translate': t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]; break;
      case 'scale': t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'matrix': if (a.length === 6) t = a as Mat; break;
      case 'rotate': {
        const rad = ((a[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const rot: Mat = [cos, sin, -sin, cos, 0, 0];
        if (a.length >= 3) {
          const cx = a[1]!, cy = a[2]!;
          t = multiply([1, 0, 0, 1, cx, cy], multiply(rot, [1, 0, 0, 1, -cx, -cy]));
        } else {
          t = rot;
        }
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = multiply(m, t);
  }
  return m;
}

// ---- Units / viewBox -------------------------------------------------------

/** Parse a length like "100mm" / "96px" / "10" to millimetres, or null. */
function lengthToMm(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*(-?[\d.eE+-]+)\s*([a-z%]*)\s*$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case 'mm': return n;
    case 'cm': return n * 10;
    case 'm': return n * 1000;
    case 'in': return n * 25.4;
    case 'pt': return (n / 72) * 25.4;
    case 'pc': return (n / 6) * 25.4;
    case '':
    case 'px': return n; // user units — caller decides via viewBox ratio
    default: return null; // %, em, … — unsupported
  }
}

// ---- Public API ------------------------------------------------------------

/**
 * Parse SVG text into normalized sketch primitives (Y-up, millimetres) plus
 * the list of skipped element names. Never throws on unsupported content; it
 * collects unknown element names into `skipped`.
 */
export function parseSvg(text: string): SvgImportResult {
  const skippedSet = new Set<string>();
  const parsed = parseXml(text);
  if (!parsed.ok) return { primitives: [], skipped: [], unitScale: 1 };
  const root = parsed.value;
  if (root.name !== 'svg' && root.name.split(':').pop() !== 'svg') {
    return { primitives: [], skipped: [], unitScale: 1 };
  }

  // viewBox = minX minY width height; used for the Y-flip and the unit ratio.
  const vb = (root.attrs['viewBox'] ?? '').split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  const hasVb = vb.length === 4;
  const vbMinY = hasVb ? vb[1]! : 0;
  const vbH = hasVb ? vb[3]! : 0;
  const vbW = hasVb ? vb[2]! : 0;

  // Unit scale: mm-per-user-unit = physical width / viewBox width.
  const widthMm = lengthToMm(root.attrs['width']);
  const heightMm = lengthToMm(root.attrs['height']);
  let unitScale = 1;
  if (widthMm !== null && hasVb && vbW > 0) unitScale = widthMm / vbW;
  else if (heightMm !== null && hasVb && vbH > 0) unitScale = heightMm / vbH;

  // Flip Y around the viewBox top (undo the export's flip). Fall back to the
  // height attribute, then to a plain negate.
  const flipConst = hasVb ? vbMinY + vbH : (heightMm !== null && unitScale > 0 ? heightMm / unitScale : 0);

  // Collect raw primitives in user coordinates (pre flip/scale).
  const raw: SketchPrimitive[] = [];
  // The root may itself carry a transform; walk root + every descendant,
  // accumulating each node's transform from its ancestors.
  walk(root, IDENTITY, raw, skippedSet);

  // Apply the Y-flip and unit scale to every coordinate.
  const primitives = raw.map((p) => finalize(p, flipConst, unitScale));
  return { primitives, skipped: Array.from(skippedSet), unitScale };
}

/**
 * Parse SVG text and build a populated `EditorState` in one call. Returns the
 * state, skipped-element list, and applied unit scale. The state is empty if
 * nothing was supported.
 */
export function svgToEditorState(
  text: string,
  opts: { idFactory?: IdFactory } = {},
): { state: EditorState; skipped: string[]; unitScale: number } {
  const { primitives, skipped, unitScale } = parseSvg(text);
  return { state: buildEditorStateFromPrimitives(primitives, opts), skipped, unitScale };
}

// ---- Tree walk -------------------------------------------------------------

function walk(node: XmlNode, parentMat: Mat, out: SketchPrimitive[], skipped: Set<string>): void {
  // The root <svg>'s own transform (rare) and group transforms accumulate.
  const here = multiply(parentMat, parseTransform(node.attrs['transform']));
  for (const child of node.children) {
    const local = child.name.split(':').pop() ?? child.name;
    if (local === 'g' || local === 'svg' || local === 'a') {
      walk(child, here, out, skipped);
      continue;
    }
    const mat = multiply(here, parseTransform(child.attrs['transform']));
    const before = out.length;
    emitElement(local, child, mat, out);
    // Container/metadata elements legitimately emit nothing; only flag real
    // drawable element names we don't handle.
    if (out.length === before && DRAWABLE_UNHANDLED.has(local)) skipped.add(local);
    else if (out.length === before && !KNOWN_NONDRAWABLE.has(local)) skipped.add(local);
  }
}

const KNOWN_NONDRAWABLE = new Set([
  'title', 'desc', 'metadata', 'defs', 'style', 'clipPath', 'mask', 'symbol',
  'marker', 'pattern', 'linearGradient', 'radialGradient', 'stop', 'filter',
]);
const DRAWABLE_UNHANDLED = new Set(['text', 'image', 'use', 'tspan', 'textPath']);

function emitElement(name: string, el: XmlNode, mat: Mat, out: SketchPrimitive[]): void {
  switch (name) {
    case 'line': {
      const x1 = num(el, 'x1'), y1 = num(el, 'y1'), x2 = num(el, 'x2'), y2 = num(el, 'y2');
      out.push({ kind: 'line', start: apply(mat, x1, y1), end: apply(mat, x2, y2) });
      break;
    }
    case 'rect': {
      const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
      if (w <= 0 || h <= 0) break;
      // Sharp rectangle = 4 lines (rounded rx/ry corners ignored in v1).
      const c: Array<[number, number]> = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      for (let i = 0; i < 4; i++) {
        const a = c[i]!, b = c[(i + 1) % 4]!;
        out.push({ kind: 'line', start: apply(mat, a[0], a[1]), end: apply(mat, b[0], b[1]) });
      }
      break;
    }
    case 'circle': {
      const cx = num(el, 'cx'), cy = num(el, 'cy'), r = num(el, 'r');
      if (r <= 0) break;
      out.push({ kind: 'circle', center: apply(mat, cx, cy), radius: r * scaleOf(mat) });
      break;
    }
    case 'ellipse': {
      const cx = num(el, 'cx'), cy = num(el, 'cy'), rx = num(el, 'rx'), ry = num(el, 'ry');
      if (rx <= 0 || ry <= 0) break;
      const center = apply(mat, cx, cy);
      // Major axis is the longer radius; its endpoint transforms as a point so
      // rotation/translation carry through. minor scales by the avg factor.
      const s = scaleOf(mat);
      if (rx >= ry) {
        out.push({ kind: 'ellipse', center, majorEnd: apply(mat, cx + rx, cy), minorRadius: ry * s });
      } else {
        out.push({ kind: 'ellipse', center, majorEnd: apply(mat, cx, cy + ry), minorRadius: rx * s });
      }
      break;
    }
    case 'polyline':
    case 'polygon': {
      const pts = parsePoints(el.attrs['points']);
      for (let i = 0; i + 1 < pts.length; i++) {
        out.push({ kind: 'line', start: apply(mat, pts[i]![0], pts[i]![1]), end: apply(mat, pts[i + 1]![0], pts[i + 1]![1]) });
      }
      if (name === 'polygon' && pts.length > 2) {
        const a = pts[pts.length - 1]!, b = pts[0]!;
        out.push({ kind: 'line', start: apply(mat, a[0], a[1]), end: apply(mat, b[0], b[1]) });
      }
      break;
    }
    case 'path':
      emitPath(el.attrs['d'] ?? '', mat, out);
      break;
  }
}

function num(el: XmlNode, attr: string): number {
  const n = Number(el.attrs[attr]);
  return Number.isFinite(n) ? n : 0;
}

function parsePoints(s: string | undefined): Array<[number, number]> {
  if (!s) return [];
  const nums = s.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  const pts: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!]);
  return pts;
}

// ---- Path `d` mini-language ------------------------------------------------

/** Tokenize a path `d` string into command groups. */
function tokenizePath(d: string): Array<{ cmd: string; args: number[] }> {
  const out: Array<{ cmd: string; args: number[] }> = [];
  const re = /([a-zA-Z])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;
  let m: RegExpExecArray | null;
  let cur: { cmd: string; args: number[] } | null = null;
  while ((m = re.exec(d)) !== null) {
    if (m[1]) {
      cur = { cmd: m[1], args: [] };
      out.push(cur);
    } else if (cur) {
      cur.args.push(Number(m[2]));
    }
  }
  return out;
}

function emitPath(d: string, mat: Mat, out: SketchPrimitive[]): void {
  const tokens = tokenizePath(d);
  let cx = 0, cy = 0;       // current point (user coords)
  let sx = 0, sy = 0;       // current subpath start
  // Spline accumulator for an in-progress run of curve segments — flushed when
  // a straight segment / close / new subpath interrupts it.
  let curve: Array<[number, number]> = [];

  const flushCurve = (): void => {
    if (curve.length >= 2) out.push({ kind: 'spline', points: curve.map(([x, y]) => apply(mat, x, y)) });
    curve = [];
  };
  const lineTo = (x: number, y: number): void => {
    flushCurve();
    out.push({ kind: 'line', start: apply(mat, cx, cy), end: apply(mat, x, y) });
    cx = x; cy = y;
  };
  const curveThrough = (pts: Array<[number, number]>): void => {
    // Start a curve run at the current point, then append the samples.
    if (curve.length === 0) curve.push([cx, cy]);
    for (const p of pts) curve.push(p);
    const last = pts[pts.length - 1]!;
    cx = last[0]; cy = last[1];
  };

  for (const { cmd, args } of tokens) {
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const rx = (v: number) => (rel ? cx + v : v);
    const ry = (v: number) => (rel ? cy + v : v);
    switch (C) {
      case 'M': {
        // First pair = moveto; subsequent pairs = implicit lineto.
        for (let i = 0; i + 1 < args.length; i += 2) {
          const x = rel ? cx + args[i]! : args[i]!;
          const y = rel ? cy + args[i + 1]! : args[i + 1]!;
          if (i === 0) { flushCurve(); cx = x; cy = y; sx = x; sy = y; }
          else lineTo(x, y);
        }
        break;
      }
      case 'L':
        for (let i = 0; i + 1 < args.length; i += 2) lineTo(rx(args[i]!), ry(args[i + 1]!));
        break;
      case 'H':
        for (const v of args) lineTo(rx(v), cy);
        break;
      case 'V':
        for (const v of args) lineTo(cx, ry(v));
        break;
      case 'Z':
        flushCurve();
        if (cx !== sx || cy !== sy) out.push({ kind: 'line', start: apply(mat, cx, cy), end: apply(mat, sx, sy) });
        cx = sx; cy = sy;
        break;
      case 'C':
        for (let i = 0; i + 5 < args.length; i += 6) {
          const p1: [number, number] = [rx(args[i]!), ry(args[i + 1]!)];
          const p2: [number, number] = [rx(args[i + 2]!), ry(args[i + 3]!)];
          const p3: [number, number] = [rx(args[i + 4]!), ry(args[i + 5]!)];
          curveThrough(sampleCubic([cx, cy], p1, p2, p3));
        }
        break;
      case 'Q':
        for (let i = 0; i + 3 < args.length; i += 4) {
          const p1: [number, number] = [rx(args[i]!), ry(args[i + 1]!)];
          const p2: [number, number] = [rx(args[i + 2]!), ry(args[i + 3]!)];
          curveThrough(sampleQuad([cx, cy], p1, p2));
        }
        break;
      case 'A':
        for (let i = 0; i + 6 < args.length; i += 7) {
          const arx = args[i]!, ary = args[i + 1]!, rot = args[i + 2]!;
          const large = args[i + 3]! !== 0, sweep = args[i + 4]! !== 0;
          const ex = rx(args[i + 5]!), ey = ry(args[i + 6]!);
          curveThrough(sampleArc([cx, cy], arx, ary, rot, large, sweep, [ex, ey]));
        }
        break;
      // S/T (smooth bezier shorthands) are uncommon in CAD output; treat their
      // explicit-control variants only via C/Q above. A bare S/T falls through
      // as an unsupported run, leaving a gap the user can redraw.
      default:
        break;
    }
  }
  flushCurve();
}

function sampleCubic(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    const t = i / CURVE_SAMPLES, u = 1 - t;
    const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
    const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
    out.push([x, y]);
  }
  return out;
}

function sampleQuad(p0: [number, number], p1: [number, number], p2: [number, number]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    const t = i / CURVE_SAMPLES, u = 1 - t;
    const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
    const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
    out.push([x, y]);
  }
  return out;
}

/**
 * Sample an SVG elliptical-arc command into points (endpoint → center
 * parameterization, SVG spec F.6.5). Returns points after `p0` up to and
 * including `p1`.
 */
function sampleArc(
  p0: [number, number],
  rxIn: number,
  ryIn: number,
  xRotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: [number, number],
): Array<[number, number]> {
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [p1]; // degenerate → straight line
  const phi = (xRotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  // Scale radii up if they're too small to span the chord.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const sign = largeArc === sweep ? -1 : 1;
  let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  if (num < 0) num = 0;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(den === 0 ? 0 : num / den);
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (p0[0] + p1[0]) / 2;
  const cy = sinP * cxp + cosP * cyp + (p0[1] + p1[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, len === 0 ? 1 : dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  const out: Array<[number, number]> = [];
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    const t = theta1 + dTheta * (i / CURVE_SAMPLES);
    const ex = cosP * rx * Math.cos(t) - sinP * ry * Math.sin(t) + cx;
    const ey = sinP * rx * Math.cos(t) + cosP * ry * Math.sin(t) + cy;
    out.push([ex, ey]);
  }
  return out;
}

// ---- Final flip + unit scale ----------------------------------------------

function finalize(p: SketchPrimitive, flipConst: number, s: number): SketchPrimitive {
  const f = ([x, y]: [number, number]): [number, number] => [x * s, (flipConst - y) * s];
  switch (p.kind) {
    case 'line':
      return { kind: 'line', start: f(p.start), end: f(p.end) };
    case 'circle':
      return { kind: 'circle', center: f(p.center), radius: p.radius * s };
    case 'arc':
      return { kind: 'arc', center: f(p.center), radius: p.radius * s, startAngle: p.startAngle, endAngle: p.endAngle };
    case 'ellipse':
      return { kind: 'ellipse', center: f(p.center), majorEnd: f(p.majorEnd), minorRadius: p.minorRadius * s };
    case 'spline':
      return { kind: 'spline', points: p.points.map(f) };
  }
}
