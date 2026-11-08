/**
 * Joint motion read back from a dragged pose: a joint's values (12.1) are
 * `b`'s frame relative to `a`'s, its translations along `a`'s axes, then its
 * turns about the moved axes, z first, then y, then x.
 */
import { compose, inverse, qnormal, type Quat, type Rigid } from '@tweakcad/worker/src/v2/rigid';
import type { Placement } from '@tweakcad/worker/src/v2/service/types';

const DEG = 180 / Math.PI;

export const rigidOf = (p: Placement): Rigid => ({ position: [...p.position], rotation: [...p.rotation] });

/** The angles (deg) of the turn `q` as z, then y, then x about the moved axes. */
export function zyxAngles(q: Quat): { rz: number; ry: number; rx: number } {
  const [x, y, z, w] = qnormal(q);
  const r00 = 1 - 2 * (y * y + z * z);
  const r10 = 2 * (x * y + w * z);
  const r20 = 2 * (x * z - w * y);
  const r21 = 2 * (y * z + w * x);
  const r22 = 1 - 2 * (x * x + y * y);
  const ry = Math.asin(Math.max(-1, Math.min(1, -r20)));
  return { rz: Math.atan2(r10, r00) * DEG, ry: ry * DEG, rx: Math.atan2(r21, r22) * DEG };
}

/** The values of `dofs` that put `b` where it stands from `a`. */
export function jointValues(dofs: readonly string[], a: Placement, b: Placement): Record<string, number> {
  const m = compose(inverse(rigidOf(a)), rigidOf(b));
  const angles = zyxAngles(m.rotation);
  const all: Record<string, number> = { tx: m.position[0], ty: m.position[1], tz: m.position[2], ...angles };
  const tidy = (v: number) => Math.round(v * 1e9) / 1e9 + 0;
  return Object.fromEntries(dofs.map((d) => [d, tidy(all[d] as number)]));
}

/** A placement moved so that its frame `from` lands on `to`: `to ∘ from⁻¹ ∘ p`. */
export function carried(p: Placement, from: Placement, to: Placement): Placement {
  const moved = compose(compose(rigidOf(to), inverse(rigidOf(from))), rigidOf(p));
  return { position: moved.position, rotation: moved.rotation };
}
