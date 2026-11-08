/** Helpers the service tests share: a raycast through a display mesh, mesh areas and volumes, and store-only ZIP reading. */
import type { BodyMesh, Display } from './types';
import { faceAt } from './picking';

type P = readonly [number, number, number];

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P, b: P): P => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function vertex(mesh: Pick<BodyMesh, 'positions'>, i: number): P {
  return [mesh.positions[3 * i] as number, mesh.positions[3 * i + 1] as number, mesh.positions[3 * i + 2] as number];
}

function triangle(mesh: Pick<BodyMesh, 'positions' | 'indices'>, t: number): [P, P, P] {
  return [
    vertex(mesh, mesh.indices[3 * t] as number),
    vertex(mesh, mesh.indices[3 * t + 1] as number),
    vertex(mesh, mesh.indices[3 * t + 2] as number),
  ];
}

/** The nearest triangle a ray hits, as a viewport's raycast finds it (Möller–Trumbore), and the face key it picks. */
export function raycast(
  display: Display,
  definition: number,
  origin: P,
  direction: P,
): { body: number; triangle: number; key: number } | undefined {
  let best: { body: number; triangle: number; key: number; t: number } | undefined;
  display.definitions[definition]?.bodies.forEach((body, b) => {
    const { mesh } = body;
    for (let t = 0; t < mesh.indices.length / 3; t++) {
      const [a, p, q] = triangle(mesh, t);
      const e1 = sub(p, a);
      const e2 = sub(q, a);
      const h = cross(direction, e2);
      const det = dot(e1, h);
      if (Math.abs(det) < 1e-12) continue;
      const s = sub(origin, a);
      const u = dot(s, h) / det;
      if (u < 0 || u > 1) continue;
      const qv = cross(s, e1);
      const v = dot(direction, qv) / det;
      if (v < 0 || u + v > 1) continue;
      const dist = dot(e2, qv) / det;
      if (dist <= 0 || (best && dist >= best.t)) continue;
      const key = faceAt(mesh, t);
      if (key !== undefined) best = { body: b, triangle: t, key, t: dist };
    }
  });
  return best && { body: best.body, triangle: best.triangle, key: best.key };
}

/** The area of triangles `first` to `first + count`. */
export function meshArea(mesh: Pick<BodyMesh, 'positions' | 'indices'>, first: number, count: number): number {
  let area = 0;
  for (let t = first; t < first + count; t++) {
    const [a, b, c] = triangle(mesh, t);
    const n = cross(sub(b, a), sub(c, a));
    area += Math.hypot(n[0], n[1], n[2]) / 2;
  }
  return area;
}

/** The volume a closed mesh encloses (divergence theorem). */
export function meshVolume(mesh: Pick<BodyMesh, 'positions' | 'indices'>): number {
  let volume = 0;
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const [a, b, c] = triangle(mesh, t);
    volume += dot(a, cross(b, c)) / 6;
  }
  return volume;
}

/** The entries of a store-only ZIP, by name. */
export function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, string>();
  const decoder = new TextDecoder();
  let pos = 0;
  while (pos + 30 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
    const size = view.getUint32(pos + 18, true);
    const nameLength = view.getUint16(pos + 26, true);
    const extra = view.getUint16(pos + 28, true);
    const name = decoder.decode(bytes.subarray(pos + 30, pos + 30 + nameLength));
    const start = pos + 30 + nameLength + extra;
    out.set(name, decoder.decode(bytes.subarray(start, start + size)));
    pos = start + size;
  }
  return out;
}
