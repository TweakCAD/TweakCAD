/**
 * Matching a face or edge against the {@link RepairHint} stored with a
 * reference to it.
 *
 * The kernel measures candidates with `describeFace` / `describeEdge` in
 * `occtKernel.ts`, the same functions that fill the hints in the topology
 * map, so the measures taken at pick time and at rebuild are the same ones.
 *
 * Two tolerances. {@link HINT_TOLERANCE} is loose on position, because a
 * hint is a snapshot from pick time and a parametric edit moves geometry; it
 * is what finds a stand-in when the id is not found at all.
 * {@link SAME_TOLERANCE} is what overrides an id that was found: only an
 * entity that still matches the hint to within float noise — untouched by
 * the edit — may take a ref away from the entity its id names. Both are
 * strict on kind: a field the hint has must be on the candidate too, so a
 * planar face never matches a curved one and a line never matches an arc.
 */

import type { RepairHint } from '@tweakcad/core/src/document/schema.ts';
import type { Vec3 } from '@tweakcad/core/src/math.ts';

export type HintTolerance = {
  /** Max distance between centres, mm. */
  centerMm: number;
  /** Max angle between normals (faces) or directions (edges), radians. */
  angleRad: number;
  /** Allowed ratio of candidate to hinted size (faces) or length (edges). */
  ratioMin: number;
  ratioMax: number;
};

/** Close enough to stand in for a ref whose id is gone. */
export const HINT_TOLERANCE: HintTolerance = { centerMm: 10, angleRad: 0.5, ratioMin: 0.5, ratioMax: 2 };

/** The same geometry the hint was taken from, give or take float noise. */
export const SAME_TOLERANCE: HintTolerance = { centerMm: 0.01, angleRad: 1e-3, ratioMin: 1 - 1e-4, ratioMax: 1 + 1e-4 };

function angleBetween(a: Vec3, b: Vec3, ignoreSign: boolean): number {
  const [ax, ay, az] = a;
  const [bx, by, bz] = b;
  const la = Math.hypot(ax, ay, az);
  const lb = Math.hypot(bx, by, bz);
  if (la === 0 || lb === 0) return Math.PI;
  let dot = (ax * bx + ay * by + az * bz) / (la * lb);
  if (ignoreSign) dot = Math.abs(dot);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

function ratioOk(actual: number, hinted: number, tol: HintTolerance): boolean {
  if (hinted <= 0) return true;
  const ratio = actual / hinted;
  return ratio >= tol.ratioMin && ratio <= tol.ratioMax;
}

/**
 * How far `candidate` is from `hint`, or `null` when it does not match.
 *
 * The score is the distance between centres (0 when the hint has none), so
 * among several matches the nearest wins. Only fields present in the hint are
 * checked; a hint with none of them matches anything at score 0.
 */
export function scoreAgainstHint(
  candidate: RepairHint,
  hint: RepairHint,
  tol: HintTolerance = HINT_TOLERANCE,
): number | null {
  let score = 0;
  if (hint.center) {
    if (!candidate.center) return null;
    const [x, y, z] = candidate.center;
    score = Math.hypot(x - hint.center[0], y - hint.center[1], z - hint.center[2]);
    if (score > tol.centerMm) return null;
  }
  if (hint.normal) {
    if (!candidate.normal) return null;
    if (angleBetween(candidate.normal, hint.normal, false) > tol.angleRad) return null;
  }
  if (hint.direction) {
    if (!candidate.direction) return null;
    if (angleBetween(candidate.direction, hint.direction, true) > tol.angleRad) return null;
  }
  if (hint.size !== undefined) {
    if (candidate.size === undefined || !ratioOk(candidate.size, hint.size, tol)) return null;
  }
  if (hint.length !== undefined) {
    if (candidate.length === undefined || !ratioOk(candidate.length, hint.length, tol)) return null;
  }
  return score;
}

/**
 * Which candidate a reference resolves to.
 *
 * @param found Index of the candidate the stable id resolved to, or -1.
 * @param describe Measures candidate `i`; only called when a hint is given.
 * @returns The chosen index, or -1.
 *
 * - No hint: the id's candidate, whatever it is.
 * - The id was found and its candidate is still the hinted geometry: it
 *   stands.
 * - The id was found but another candidate is the hinted geometry
 *   ({@link SAME_TOLERANCE}): that one. The id has come to name something
 *   else while what was picked is still there, untouched — what renumbering
 *   by walk order does when an edit adds or removes a sibling.
 * - Otherwise the id's candidate stands. It differs from the hint because
 *   the edit moved or reshaped it, and a nearby look-alike is no evidence
 *   against the id.
 * - The id was not found: the closest match within {@link HINT_TOLERANCE},
 *   or -1.
 */
export function chooseByHint(
  count: number,
  found: number,
  hint: RepairHint | undefined,
  describe: (index: number) => RepairHint,
): number {
  if (!hint) return found;
  if (found >= 0) {
    if (scoreAgainstHint(describe(found), hint, SAME_TOLERANCE) !== null) return found;
    const same = closestMatch(count, found, hint, describe, SAME_TOLERANCE);
    return same >= 0 ? same : found;
  }
  return closestMatch(count, -1, hint, describe, HINT_TOLERANCE);
}

function closestMatch(
  count: number,
  skip: number,
  hint: RepairHint,
  describe: (index: number) => RepairHint,
  tol: HintTolerance,
): number {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < count; i++) {
    if (i === skip) continue;
    const score = scoreAgainstHint(describe(i), hint, tol);
    if (score !== null && score < bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}
