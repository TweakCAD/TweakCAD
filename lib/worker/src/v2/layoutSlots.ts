/**
 * The slots of a pattern layout (appendix A, 9.5), shared by body and
 * component patterns. A slot index counts from the seed at 0. A symmetric
 * direction spreads its count, the seed among it, both ways: the copies
 * after the seed at 1, 2 …, those before it at −1, −2 …, an even count's
 * extra copy on the positive side. So the first slots of a one-sided pattern
 * keep their keys when it becomes symmetric.
 */
import { FeaturePause } from './context';

/** How many copies a symmetric direction of `count` puts after the seed; the farthest copy is that many steps away. */
export const symmetricReach = (count: number): number => Math.ceil((count - 1) / 2);

/** The indices along one direction: 0 to count − 1; with `symmetric`, 0 to `symmetricReach` and −1 to −⌊(count − 1) / 2⌋. */
export function sideIndices(count: number, symmetric: boolean): number[] {
  const out: number[] = [];
  const after = symmetric ? symmetricReach(count) : count - 1;
  for (let i = 0; i <= after; i++) out.push(i);
  if (symmetric) for (let i = 1; i <= count - 1 - after; i++) out.push(-i);
  return out;
}

/**
 * Each slot of a circular layout with its turn in degrees, the seed at 0.
 * One-sided, `angle` is the sweep from the seed to the last copy, and a
 * full turn spaces the copies evenly around it; symmetric, it is the whole
 * spread, from the outermost copy one way to the outermost the other, less
 * than a full turn so no copy lands on another.
 */
export function circularTurns(count: number, angle: number, symmetric: boolean): { i: number; degrees: number }[] {
  if (Math.abs(angle) > 360) throw new FeaturePause('a circular pattern sweeps at most a full turn');
  if (symmetric && count > 1 && Math.abs(angle) >= 360)
    throw new FeaturePause('a symmetric circular pattern spreads less than a full turn');
  const full = !symmetric && Math.abs(angle) === 360;
  const step = count === 1 ? 0 : full ? angle / count : angle / (count - 1);
  return sideIndices(count, symmetric).map((i) => ({ i, degrees: i * step }));
}
