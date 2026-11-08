/**
 * Hole positions measured from edges (appendix A `core.hole`, a position's
 * `from`), as the panel reads them off the shown display: a straight edge
 * of the hole's face is a line in the face frame with the side the face
 * lies on, and a position lies its distance from each line on that side.
 * The evaluator places the hole the same way from the kernel's geometry.
 */
import type { BodyMesh, Display, FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import { inFrame, type Vec2 } from './holeSnap';

/** A reference edge in the face frame: a point of its line, its direction, and the unit normal pointing into the face. */
export interface EdgeLine {
  point: Vec2;
  direction: Vec2;
  inward: Vec2;
  /** Its ends, for drawing. */
  ends: [Vec2, Vec2];
}

/** Millimetres off the face's plane, or off a straight line, a mesh point may lie and still count as on it. */
const ON = 1e-3;

function bodyMeshes(display: Display | null): BodyMesh[] {
  return (display?.definitions ?? []).flatMap((d) => d.bodies.map((b) => b.mesh));
}

/** The polyline points of edge `key` in the face frame, with their heights off the face's plane. */
function edgePoints(display: Display | null, key: number, frame: FrameDisplay): { uv: Vec2; height: number }[] {
  for (const mesh of bodyMeshes(display)) {
    for (let e = 0; e + 2 < mesh.edges.length; e += 3) {
      if (mesh.edges[e + 2] !== key) continue;
      const first = mesh.edges[e] as number;
      const count = mesh.edges[e + 1] as number;
      const out: { uv: Vec2; height: number }[] = [];
      for (let s = first * 2; s < (first + count) * 2; s++)
        out.push(
          inFrame(frame, [
            mesh.segments[s * 3] as number,
            mesh.segments[s * 3 + 1] as number,
            mesh.segments[s * 3 + 2] as number,
          ]),
        );
      return out;
    }
  }
  return [];
}

const inTriangle = (p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean => {
  const side = (u: Vec2, v: Vec2) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
  const [d1, d2, d3] = [side(a, b), side(b, c), side(c, a)];
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

/** Whether `uv` lies on face `key`'s shown triangles, in the face frame. */
export function onFace(display: Display | null, key: number, frame: FrameDisplay, uv: Vec2): boolean {
  for (const mesh of bodyMeshes(display)) {
    for (let i = 0; i + 2 < mesh.faces.length; i += 3) {
      if (mesh.faces[i + 2] !== key) continue;
      const first = mesh.faces[i] as number;
      const count = mesh.faces[i + 1] as number;
      for (let t = first; t < first + count; t++) {
        const corner = (c: number) => {
          const v = mesh.indices[3 * t + c] as number;
          return inFrame(frame, [
            mesh.positions[3 * v] as number,
            mesh.positions[3 * v + 1] as number,
            mesh.positions[3 * v + 2] as number,
          ]).uv;
        };
        if (inTriangle(uv, corner(0), corner(1), corner(2))) return true;
      }
    }
  }
  return false;
}

/**
 * Edge `edge` as a reference of a hole on face `face`: null when the
 * display does not show it, it is not straight or not in the face's plane,
 * or the face does not lie on one side of it beside its middle.
 */
export function edgeLineOf(display: Display | null, edge: number, face: number, frame: FrameDisplay): EdgeLine | null {
  const points = edgePoints(display, edge, frame);
  if (points.length < 2 || points.some((p) => Math.abs(p.height) > ON)) return null;
  const a = (points[0] as { uv: Vec2 }).uv;
  const b = (points[points.length - 1] as { uv: Vec2 }).uv;
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length <= ON) return null;
  const direction: Vec2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  const normal: Vec2 = [-direction[1], direction[0]];
  if (points.some(({ uv }) => Math.abs((uv[0] - a[0]) * normal[0] + (uv[1] - a[1]) * normal[1]) > ON)) return null;
  const middle: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const step = 1e-3 * length;
  const ahead = onFace(display, face, frame, [middle[0] + step * normal[0], middle[1] + step * normal[1]]);
  const behind = onFace(display, face, frame, [middle[0] - step * normal[0], middle[1] - step * normal[1]]);
  if (ahead === behind) return null;
  return { point: a, direction, inward: ahead ? normal : [-normal[0], -normal[1]], ends: [a, b] };
}

/** How far `uv` lies from the line, into the face; negative on the other side. */
export function distanceFrom(line: EdgeLine, uv: Vec2): number {
  return (uv[0] - line.point[0]) * line.inward[0] + (uv[1] - line.point[1]) * line.inward[1];
}

/** Where a position given at `uv` lies when measured `d` from each line: one line sets the coordinate across it, two set both; null for two parallel lines. */
export function measuredAt(uv: Vec2, from: readonly { line: EdgeLine; d: number }[]): Vec2 | null {
  const [first, second] = from;
  if (!first) return uv;
  const c = (f: { line: EdgeLine; d: number }) =>
    f.d + f.line.inward[0] * f.line.point[0] + f.line.inward[1] * f.line.point[1];
  if (!second) {
    const off = c(first) - (first.line.inward[0] * uv[0] + first.line.inward[1] * uv[1]);
    return [uv[0] + off * first.line.inward[0], uv[1] + off * first.line.inward[1]];
  }
  const [n, m] = [first.line.inward, second.line.inward];
  const det = n[0] * m[1] - n[1] * m[0];
  if (Math.abs(det) < 1e-9) return null;
  return [(c(first) * m[1] - c(second) * n[1]) / det, (n[0] * c(second) - m[0] * c(first)) / det];
}

/** A field's number of millimetres, or null for text that is not a plain number (an expression). */
export function fieldNumber(text: string): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*(mm)?\s*$/.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Where a position lies in the face frame, from its X and Y and the lines
 * of the edges it is measured from (`lines[j]` for `from[j]`, null where the
 * display does not show one); null when that cannot be read off the fields.
 */
export function shownAt(
  p: { x: string; y: string; kept?: unknown; from?: readonly { distance: string }[] },
  lines: readonly (EdgeLine | null)[],
): Vec2 | null {
  const from = (p.from ?? []).flatMap((f, j) => {
    const line = lines[j];
    const d = fieldNumber(f.distance);
    return line && d !== null ? [{ line, d }] : [];
  });
  const [x, y] = [fieldNumber(p.x), fieldNumber(p.y)];
  if (from.length < 2 && (p.kept !== undefined || x === null || y === null)) return null;
  return measuredAt([x ?? 0, y ?? 0], from);
}

/** The foot of the perpendicular from `uv` to the line: where a distance dimension meets its edge. */
export function footOn(line: EdgeLine, uv: Vec2): Vec2 {
  const t = (uv[0] - line.point[0]) * line.direction[0] + (uv[1] - line.point[1]) * line.direction[1];
  return [line.point[0] + t * line.direction[0], line.point[1] + t * line.direction[1]];
}
