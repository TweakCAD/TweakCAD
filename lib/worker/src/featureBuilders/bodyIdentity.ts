/**
 * The body-identity rule, in one place, because six builders used to
 * disagree about it.
 *
 * ## The rule
 *
 * **A body id is minted once, by the feature that creates the body, and
 * every feature that modifies that body re-emits the same id.** The id means
 * "this body", for the life of the body — not "the output of feature X".
 *
 * Creators mint: extrude in `newBody` mode, revolve, loft, sweep, imported
 * geometry, imported component, component instance, and the reflected copy a
 * non-join mirror produces. Patterns also mint, because the source body
 * survives alongside them — a pattern adds a body, it does not replace one.
 *
 * Modifiers carry: fillet, chamfer, shell, hole, a joining mirror, and
 * extrude in `join` / `cut` mode.
 *
 * ## Why this way round
 *
 * The other rule — every feature mints an id namespaced to itself — is
 * internally coherent and was what fillet, chamfer and extrude's boolean
 * paths actually did. The problem is what it costs. Body ids are persisted:
 * `BodyRef` lives in `targetBodies`, `sourceBody`, `targetBody`, and inside
 * every `EdgeRef`/`FaceRef`. So under feature-owns-output, inserting a fillet
 * between an extrude and a shell silently invalidates the shell's stored
 * reference, and deleting that fillet invalidates it again in the other
 * direction. Ordinary timeline editing breaks saved references, and the only
 * way out is a rebinding layer — strictly more machinery than the rule.
 *
 * The same gesture already behaved two different ways depending on which
 * builder you happened to use: inserting a hole upstream of a shell was
 * fine, because hole carried the id, while inserting a fillet in the same
 * slot broke it. Both files stated their intent in comments, and the intents
 * contradicted each other.
 *
 * Carrying the id also gives per-body state somewhere to live. A name,
 * material, appearance or visibility flag has to key on something that
 * survives the timeline; `CadPart.bodies` is only meaningful once it does.
 * That is additive once this rule holds, and impossible before it.
 *
 * ## Split and merge
 *
 * These are the two cases that need stating or they drift again.
 *
 * - **Merge** (boolean union, mirror-join, extrude-join): the result carries
 *   the **primary target's** id — `targetBodies[0]`, or the source for
 *   mirror. The other inputs are consumed and their ids retire.
 * - **Split** (a boolean that disconnects a solid): the piece that inherits
 *   identity keeps the id; the rest are new bodies and mint fresh ids. The
 *   inheriting piece is chosen by {@link pickIdentityHeir} rather than by
 *   kernel ordering, which is not stable across rebuilds.
 *
 * `bodyIdentity.test.ts` asserts the invariant across every modifier builder,
 * so a seventh convention cannot appear quietly.
 */

import type { BodyId } from '@tweakcad/core/src/ids.ts';
import { bodyId as bodyIdBrand } from '@tweakcad/core/src/ids.ts';

/**
 * Re-emit the id of a body a modifier consumed.
 *
 * Exists so the intent reads at the call site — `carryBodyId(targetBodyId)`
 * says "this is the same body" where `bodyIdBrand(String(x))` says only
 * "some string became a BodyId". Every modifier should route through it.
 */
export function carryBodyId(consumed: BodyId | string): BodyId {
  return bodyIdBrand(String(consumed));
}

/**
 * Mint an id for a body a feature genuinely creates.
 *
 * @param featureId The creating feature's id — it names the body for life,
 *   which is why the scheme stays `body_<featureId>_<index>` even though the
 *   feature may not be the last to touch it.
 * @param index Position within the bodies this one feature creates.
 */
export function mintBodyId(featureId: string, index = 0): BodyId {
  return bodyIdBrand(`body_${featureId}_${index}`);
}

/**
 * Choose which piece of a split keeps the original body's identity.
 *
 * Largest volume wins, because it is the piece a user would point at and call
 * "the part"; ties break on the lowest `(x, y, z)` centroid purely so the
 * answer is deterministic. Kernel output order is **not** usable here — OCCT
 * makes no ordering guarantee across rebuilds, so relying on it would move
 * identity between pieces as unrelated geometry upstream changes.
 *
 * @returns Index into `pieces`, or `-1` when there is nothing to choose.
 */
export type SplitPiece = {
  volume: number;
  centroid: readonly [number, number, number];
};

/** Lexicographic (x, y, z). Negative when `a` sorts first. */
function compareCentroid(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

export function pickIdentityHeir(pieces: readonly SplitPiece[]): number {
  const first = pieces[0];
  if (!first) return -1;

  let bestIndex = 0;
  let best = first;
  for (let i = 1; i < pieces.length; i++) {
    const candidate = pieces[i];
    if (!candidate) continue;
    const bigger = candidate.volume > best.volume;
    // Equal volume falls through to the centroid so the result does not
    // depend on the order the kernel happened to return the pieces in.
    const tiedButEarlier =
      candidate.volume === best.volume &&
      compareCentroid(candidate.centroid, best.centroid) < 0;
    if (bigger || tiedButEarlier) {
      bestIndex = i;
      best = candidate;
    }
  }
  return bestIndex;
}
