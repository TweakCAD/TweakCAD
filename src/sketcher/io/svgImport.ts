/**
 * SVG to sketch rows. Reads `<line>`, `<rect>` (rounded corners as arcs),
 * `<circle>`, `<ellipse>`, `<polyline>`, `<polygon>` and `<path>` through any
 * nesting of `<g>`, `<a>`, `<switch>` and inner `<svg>`, with every element's
 * accumulated `transform`. Path segments: lines; cubic Béziers → bezier;
 * quadratics → conic with rho 1/2, which is exactly the quadratic; elliptical
 * arcs → arc, or ellipticalArc when the transformed arc is not round. Under a
 * transform that does not keep circles round, a circle becomes an ellipse.
 *
 * SVG's y points down and the sketch's up: y is flipped about the bottom of
 * the viewBox, so the drawing comes in upright with that edge on the x axis.
 * User units are scaled to mm by the root `width` (or `height`) over the
 * viewBox; unitless and px sizes count as mm.
 *
 * Text, images, `<use>` and other drawable elements are reported in
 * `skipped`; metadata, definitions and elements of other namespaces are passed
 * over.
 */
import type { P2, RowMaker } from '../rows';
import { ImportRows, type SketchImport } from './importRows';
import { parseXml, type XmlNode } from './xml';

/**
 * How many curves an SVG may bring into one sketch. Detailed artwork and
 * traced logos make thousands, which a parametric sketch is slow to solve and
 * edit; the caller refuses an import beyond this.
 */
export const MAX_SVG_IMPORT_CURVES = 500;

/** x' = a x + c y + e, y' = b x + d y + f. */
type Mat = readonly [number, number, number, number, number, number];
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

const apply = (m: Mat, p: P2): P2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const linear = (m: Mat, v: P2): P2 => [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];

/** An SVG `transform` attribute as one matrix. */
function parseTransform(attr: string | undefined): Mat {
  if (!attr) return IDENTITY;
  let m = IDENTITY;
  const re = /(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]*)\)/g;
  for (let match = re.exec(attr); match; match = re.exec(attr)) {
    const a = (match[2] as string)
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite);
    const deg = ((a[0] ?? 0) * Math.PI) / 180;
    let t: Mat = IDENTITY;
    switch (match[1]) {
      case 'translate':
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case 'scale':
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case 'matrix':
        if (a.length === 6) t = a as unknown as Mat;
        break;
      case 'rotate': {
        const rot: Mat = [Math.cos(deg), Math.sin(deg), -Math.sin(deg), Math.cos(deg), 0, 0];
        const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
        t = multiply([1, 0, 0, 1, cx, cy], multiply(rot, [1, 0, 0, 1, -cx, -cy]));
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(deg), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(deg), 0, 1, 0, 0];
        break;
    }
    m = multiply(m, t);
  }
  return m;
}

/** A length such as "100mm" in mm; user units and px as given. Null for %, em and the like. */
function lengthToMm(v: string | undefined): number | null {
  const m = v ? /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-z%]*)\s*$/.exec(v) : null;
  if (!m) return null;
  const n = Number(m[1]);
  const per: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 1, '': 1 };
  const f = per[m[2] as string];
  return f === undefined ? null : n * f;
}

const CONTAINERS = new Set(['g', 'svg', 'a', 'switch']);
const PASSED_OVER = new Set([
  'title',
  'desc',
  'metadata',
  'defs',
  'style',
  'script',
  'clipPath',
  'mask',
  'symbol',
  'marker',
  'pattern',
  'linearGradient',
  'radialGradient',
  'stop',
  'filter',
]);

/** Reads SVG text into sketch rows. Never throws on content it does not read. */
export function importSvg(text: string, make: RowMaker): SketchImport {
  const rows = new ImportRows(make);
  const root = parseXml(text);
  if (!root || localName(root.name) !== 'svg') return rows.result('Import SVG');

  const vb = (root.attrs.viewBox ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  const hasViewBox = vb.length === 4 && vb.every(Number.isFinite);
  const [, vbMinY = 0, vbWidth = 0, vbHeight = 0] = hasViewBox ? vb : [];
  const width = lengthToMm(root.attrs.width);
  const height = lengthToMm(root.attrs.height);
  let s = 1;
  if (width !== null && hasViewBox && vbWidth > 0) s = width / vbWidth;
  else if (height !== null && hasViewBox && vbHeight > 0) s = height / vbHeight;
  const bottom = hasViewBox ? vbMinY + vbHeight : height !== null ? height / s : 0;
  walk(rows, root, [s, 0, 0, -s, 0, bottom * s]);
  return rows.result('Import SVG');
}

function localName(name: string): string {
  return name.startsWith('svg:') ? name.slice(4) : name;
}

function walk(rows: ImportRows, node: XmlNode, parent: Mat): void {
  const here = multiply(parent, parseTransform(node.attrs.transform));
  for (const child of node.children) {
    if (child.name.includes(':') && !child.name.startsWith('svg:')) continue;
    const name = localName(child.name);
    if (CONTAINERS.has(name)) walk(rows, child, here);
    else if (
      !PASSED_OVER.has(name) &&
      !element(rows, name, child, multiply(here, parseTransform(child.attrs.transform)))
    )
      rows.skip(name);
  }
}

function attr(el: XmlNode, name: string): number {
  const n = parseFloat(el.attrs[name] ?? '');
  return Number.isFinite(n) ? n : 0;
}

function pointList(s: string | undefined): P2[] {
  const nums = (s ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
  const out: P2[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i] as number, nums[i + 1] as number]);
  return out;
}

/** Adds one element's curves; false when it is no element import reads. */
function element(rows: ImportRows, name: string, el: XmlNode, m: Mat): boolean {
  switch (name) {
    case 'line':
      rows.line(apply(m, [attr(el, 'x1'), attr(el, 'y1')]), apply(m, [attr(el, 'x2'), attr(el, 'y2')]));
      return true;
    case 'polyline':
    case 'polygon': {
      const pts = pointList(el.attrs.points).map((p) => apply(m, p));
      for (let i = 0; i + 1 < pts.length; i++) rows.line(pts[i] as P2, pts[i + 1] as P2);
      if (name === 'polygon' && pts.length > 2) rows.line(pts[pts.length - 1] as P2, pts[0] as P2);
      return true;
    }
    case 'rect': {
      const [x, y, w, h] = [attr(el, 'x'), attr(el, 'y'), attr(el, 'width'), attr(el, 'height')];
      if (w <= 0 || h <= 0) return true;
      const given = (a: string) => (el.attrs[a] !== undefined && attr(el, a) > 0 ? attr(el, a) : undefined);
      const rx = Math.min(given('rx') ?? given('ry') ?? 0, w / 2);
      const ry = Math.min(given('ry') ?? given('rx') ?? 0, h / 2);
      const corner = (ex: number, ey: number) => `A ${rx} ${ry} 0 0 1 ${ex} ${ey}`;
      const d =
        rx > 0 && ry > 0
          ? `M ${x + rx} ${y} H ${x + w - rx} ${corner(x + w, y + ry)} V ${y + h - ry} ${corner(x + w - rx, y + h)} ` +
            `H ${x + rx} ${corner(x, y + h - ry)} V ${y + ry} ${corner(x + rx, y)} Z`
          : `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
      path(rows, d, m);
      return true;
    }
    case 'circle': {
      const r = attr(el, 'r');
      if (r > 0) round(rows, m, [attr(el, 'cx'), attr(el, 'cy')], [r, 0], [0, r]);
      return true;
    }
    case 'ellipse': {
      const [rx, ry] = [attr(el, 'rx'), attr(el, 'ry')];
      if (rx > 0 && ry > 0) round(rows, m, [attr(el, 'cx'), attr(el, 'cy')], [rx, 0], [0, ry]);
      return true;
    }
    case 'path':
      path(rows, el.attrs.d ?? '', m);
      return true;
    default:
      return false;
  }
}

/**
 * The ellipse c + u cos t + v sin t (u, v conjugate semi-diameters) under `m`,
 * whole or, given `arc`, from `start` to `end` with t increasing when
 * `arc.increasing`.
 */
function round(rows: ImportRows, m: Mat, c: P2, u: P2, v: P2, arc?: { start: P2; end: P2; increasing: boolean }): void {
  const center = apply(m, c);
  const [mu, mv] = [linear(m, u), linear(m, v)];
  // The principal axes: eigenvectors of u uᵀ + v vᵀ.
  const a = mu[0] * mu[0] + mv[0] * mv[0];
  const b = mu[0] * mu[1] + mv[0] * mv[1];
  const d = mu[1] * mu[1] + mv[1] * mv[1];
  const mean = (a + d) / 2;
  const spread = Math.hypot((a - d) / 2, b);
  const [major, minor] = [Math.sqrt(mean + spread), Math.sqrt(Math.max(0, mean - spread))];
  // The major axis end with the larger x, then the larger y.
  let [ux, uy] = [Math.cos(Math.atan2(2 * b, a - d) / 2), Math.sin(Math.atan2(2 * b, a - d) / 2)];
  if (ux < -1e-12 || (Math.abs(ux) <= 1e-12 && uy < 0)) [ux, uy] = [-ux, -uy];
  const majorEnd: P2 = [center[0] + major * ux, center[1] + major * uy];
  const circular = major - minor <= 1e-9 * major;
  if (!arc) {
    if (circular) rows.circle(center, major);
    else rows.ellipse(center, majorEnd, minor);
    return;
  }
  // t increasing is counter-clockwise where the mapped semi-diameters keep their turn.
  const ccw = arc.increasing === mu[0] * mv[1] - mu[1] * mv[0] > 0;
  const [from, to] = ccw ? [apply(m, arc.start), apply(m, arc.end)] : [apply(m, arc.end), apply(m, arc.start)];
  if (circular) rows.arc(center, from, to);
  else rows.ellipticalArc(center, majorEnd, minor, from, to);
}

/** An SVG elliptical arc segment (endpoint form) from `p0` to `p1`. */
function arcSegment(
  rows: ImportRows,
  m: Mat,
  p0: P2,
  rxIn: number,
  ryIn: number,
  rotation: number,
  large: boolean,
  sweep: boolean,
  p1: P2,
): void {
  if (p0[0] === p1[0] && p0[1] === p1[1]) return;
  let [rx, ry] = [Math.abs(rxIn), Math.abs(ryIn)];
  if (rx === 0 || ry === 0) {
    rows.line(apply(m, p0), apply(m, p1));
    return;
  }
  const phi = (rotation * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const [dx, dy] = [(p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2];
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = Math.max(0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1);
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(den === 0 ? 0 : num / den);
  const [cxp, cyp] = [(k * rx * y1) / ry, (-k * ry * x1) / rx];
  const c: P2 = [cos * cxp - sin * cyp + (p0[0] + p1[0]) / 2, sin * cxp + cos * cyp + (p0[1] + p1[1]) / 2];
  // With the sweep flag set the angle increases from p0 to p1.
  round(rows, m, c, [rx * cos, rx * sin], [-ry * sin, ry * cos], { start: p0, end: p1, increasing: sweep });
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** A path's `d`, up to its first error as SVG renders it. */
function path(rows: ImportRows, d: string, m: Mat): void {
  let i = 0;
  const separators = () => {
    while (i < d.length && /[\s,]/.test(d[i] as string)) i++;
  };
  const number = (): number | null => {
    separators();
    NUMBER.lastIndex = i;
    const found = NUMBER.exec(d);
    if (!found) return null;
    i += found[0].length;
    return Number(found[0]);
  };
  const flag = (): boolean | null => {
    separators();
    const ch = d[i];
    if (ch !== '0' && ch !== '1') return null;
    i++;
    return ch === '1';
  };
  const more = () => {
    separators();
    return i < d.length && /[+\-.\d]/.test(d[i] as string);
  };
  const T = (p: P2) => apply(m, p);

  let cur: P2 = [0, 0];
  let start: P2 = [0, 0];
  // The last control point of a cubic or quadratic segment, for S and T.
  let lastCubic: P2 | null = null;
  let lastQuad: P2 | null = null;
  const reflect = (c: P2 | null): P2 => (c ? [2 * cur[0] - c[0], 2 * cur[1] - c[1]] : cur);

  for (;;) {
    separators();
    const cmd = d[i];
    if (cmd === undefined || !/[a-zA-Z]/.test(cmd)) return;
    i++;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const read = (): P2 | null => {
      const x = number();
      const y = x === null ? null : number();
      return x === null || y === null ? null : rel ? [cur[0] + x, cur[1] + y] : [x, y];
    };
    if (C === 'Z') {
      rows.line(T(cur), T(start));
      cur = start;
      lastCubic = lastQuad = null;
      continue;
    }
    let first = true;
    do {
      let cubic: P2 | null = null;
      let quad: P2 | null = null;
      switch (C) {
        case 'M': {
          const p = read();
          if (!p) return;
          if (first) start = p;
          else rows.line(T(cur), T(p));
          cur = p;
          break;
        }
        case 'L': {
          const p = read();
          if (!p) return;
          rows.line(T(cur), T(p));
          cur = p;
          break;
        }
        case 'H':
        case 'V': {
          const v = number();
          if (v === null) return;
          const p: P2 = C === 'H' ? [rel ? cur[0] + v : v, cur[1]] : [cur[0], rel ? cur[1] + v : v];
          rows.line(T(cur), T(p));
          cur = p;
          break;
        }
        case 'C':
        case 'S': {
          const c1: P2 | null = C === 'C' ? read() : reflect(lastCubic);
          const c2: P2 | null = c1 && read();
          const p = c2 && read();
          if (!c1 || !c2 || !p) return;
          rows.bezier(T(cur), T(c1), T(c2), T(p));
          cubic = c2;
          cur = p;
          break;
        }
        case 'Q':
        case 'T': {
          const q: P2 | null = C === 'Q' ? read() : reflect(lastQuad);
          const p = q && read();
          if (!q || !p) return;
          rows.conic(T(cur), T(q), T(p), 0.5);
          quad = q;
          cur = p;
          break;
        }
        case 'A': {
          const rx = number();
          const ry = rx === null ? null : number();
          const rotation = ry === null ? null : number();
          const large = rotation === null ? null : flag();
          const sweep = large === null ? null : flag();
          const p = sweep === null ? null : read();
          if (rx === null || ry === null || rotation === null || large === null || sweep === null || !p) return;
          arcSegment(rows, m, cur, rx, ry, rotation, large, sweep, p);
          cur = p;
          break;
        }
        default:
          return;
      }
      lastCubic = cubic;
      lastQuad = quad;
      first = false;
    } while (more());
  }
}
