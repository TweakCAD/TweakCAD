/**
 * STL writing from triangle meshes: binary, or ASCII on request. Each
 * triangle's normal is worked out from its corners, counter-clockwise
 * outward.
 */

/** One body's mesh: corner positions and three indices per triangle. */
export interface StlMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

function normalOf(p: ArrayLike<number>, a: number, b: number, c: number): [number, number, number] {
  const ux = (p[3 * b] as number) - (p[3 * a] as number);
  const uy = (p[3 * b + 1] as number) - (p[3 * a + 1] as number);
  const uz = (p[3 * b + 2] as number) - (p[3 * a + 2] as number);
  const vx = (p[3 * c] as number) - (p[3 * a] as number);
  const vy = (p[3 * c + 1] as number) - (p[3 * a + 1] as number);
  const vz = (p[3 * c + 2] as number) - (p[3 * a + 2] as number);
  const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const length = Math.hypot(...n);
  return length > 0 ? [n[0] / length, n[1] / length, n[2] / length] : [0, 0, 0];
}

/** Binary STL of every triangle of `meshes`, under an 80-byte header naming `name`. */
export function binaryStl(meshes: readonly StlMesh[], name = 'TweakCAD'): Uint8Array {
  const count = meshes.reduce((n, m) => n + Math.floor(m.indices.length / 3), 0);
  const out = new Uint8Array(84 + 50 * count);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(name.slice(0, 80)));
  view.setUint32(80, count, true);
  let at = 84;
  for (const { positions: p, indices } of meshes) {
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const corners = [indices[t] as number, indices[t + 1] as number, indices[t + 2] as number] as const;
      for (const c of normalOf(p, ...corners)) {
        view.setFloat32(at, c, true);
        at += 4;
      }
      for (const v of corners)
        for (let k = 0; k < 3; k++) {
          view.setFloat32(at, p[3 * v + k] as number, true);
          at += 4;
        }
      at += 2;
    }
  }
  return out;
}

/** ASCII STL of every triangle of `meshes`, as one solid named `name`. */
export function asciiStl(meshes: readonly StlMesh[], name = 'TweakCAD'): string {
  const solid = name.replace(/\s+/g, '_') || 'TweakCAD';
  const lines = [`solid ${solid}`];
  for (const { positions: p, indices } of meshes) {
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const corners = [indices[t] as number, indices[t + 1] as number, indices[t + 2] as number] as const;
      lines.push(`  facet normal ${normalOf(p, ...corners).join(' ')}`, '    outer loop');
      for (const v of corners) lines.push(`      vertex ${p[3 * v]} ${p[3 * v + 1]} ${p[3 * v + 2]}`);
      lines.push('    endloop', '  endfacet');
    }
  }
  lines.push(`endsolid ${solid}`, '');
  return lines.join('\n');
}
