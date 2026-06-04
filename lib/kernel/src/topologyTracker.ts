/**
 * ShapeEvolutionTracker — assigns and propagates stable face IDs across
 * kernel ops within a single kernel session.
 *
 * Owned by {@link OcctKernel}. Lifetime equals the worker's kernel lifetime.
 * Not part of the {@link CadKernel} interface — feature builders see stable
 * IDs via {@link TopologyMap.faces[].stableFaceId} and resolve refs via
 * {@link CadKernel.resolveFaceRef}.
 *
 * Identity strategy is history-first with structural fallback:
 *  - Primitive / sketch creation ops assign fresh IDs to every face of the
 *    new body.
 *  - History-aware ops (fuse/cut/fillet/etc.) feed `EvolutionData` to
 *    {@link ShapeEvolutionTracker.recordEvolution}, which propagates IDs
 *    via the modified/generated/deleted mappings.
 *  - When a stable ID can't be resolved on the current rebuild, callers
 *    fall back to {@link RepairHint} matching.
 *
 * Face *hash* (from `kernel.hashCode(face, upperBound)`) is the within-
 * rebuild bridge between runtime handles and stable IDs. It is NOT itself
 * the stable ID — hashes change when geometry changes.
 *
 * Scope: faces only for now. Edge tracking mirrors this same shape.
 */

import type { StableFaceId, StableEdgeId } from '@tweakcad/core/src/ids.ts';
import { stableFaceId, stableEdgeId } from '@tweakcad/core/src/ids.ts';

/**
 * Per-body record of face identity. Keyed by the body's internal kernel
 * handle (string) so the tracker can be queried before a `bodyId` has been
 * minted at the schema level.
 */
type BodyRecord = {
  /**
   * Map from current-rebuild face hash → stable face ID.
   */
  faceHashToStable: Map<number, StableFaceId>;
  /**
   * Map from current-rebuild edge hash → stable edge ID.
   */
  edgeHashToStable: Map<number, StableEdgeId>;
};

/**
 * Walk-index-based stable id.
 *
 * For primitives (`registerFreshBody`) and boolean results
 * (`propagateIds`), the same op rebuilding the same geometry walks its
 * sub-shapes in the same order. Combined with a feature-unique `origin`
 * (passed by the builder as `<op>_<featureId>`), this gives stable IDs
 * that survive OCCT's TShape regeneration between rebuilds — without
 * that, user-captured FaceRef/EdgeRef would break on every rebuild.
 *
 * Why no global counter fallback? A counter makes the same logical face
 * get a different ID on different runs (counter state isn't reset
 * across kernel sessions), which is exactly the bug this module exists
 * to prevent. If two faces in the same body collide on (origin, index),
 * that's a builder bug — the origin needs to be more specific.
 */
function indexedFaceStableId(origin: string, index: number): StableFaceId {
  return stableFaceId(`sf_${origin}_${index}`);
}
function indexedEdgeStableId(origin: string, index: number): StableEdgeId {
  return stableEdgeId(`se_${origin}_${index}`);
}

/**
 * Decode the run-length-encoded `modified` / `generated` arrays from
 * occt-wasm's `EvolutionData`. Format:
 *
 *   `[inputHash, count, resultHash_0, resultHash_1, ...resultHash_{count-1},
 *     inputHash, count, ...]`
 *
 * Yields `[inputHash, resultHashes[]]` tuples. Tolerates an empty array
 * (no entries) and skips trailing garbage if the count would read past
 * the array end — defensive against any future format drift.
 */
function* decodeRunLength(encoded: number[]): Generator<[number, number[]]> {
  let i = 0;
  while (i + 1 < encoded.length) {
    const inputHash = encoded[i]!;
    const count = encoded[i + 1]!;
    const start = i + 2;
    const end = start + count;
    if (end > encoded.length) break; // truncated entry — bail
    yield [inputHash, encoded.slice(start, end)];
    i = end;
  }
}

/**
 * Evolution payload accepted by {@link ShapeEvolutionTracker.recordEvolution}.
 * Structural mirror of `EvolutionData` from `occt-wasm`, but reshaped so the
 * tracker doesn't depend on the upstream type directly (keeps the tracker
 * testable without WASM).
 *
 * `modified` and `generated` use the same run-length encoding as occt-wasm:
 * `[inputHash, count, resultHash_0, resultHash_1, ..., resultHash_{count-1},
 *   inputHash, count, ...]`. This preserves the per-input → N-result mapping
 * needed for face-split cases (one input face → multiple result faces after
 * a boolean) and face-merge cases (multiple inputs share the same result).
 *
 * `deleted` is a flat list of input face hashes.
 *
 * The tracker doesn't care which kernel method produced the payload — it
 * just maps stable IDs forward. The caller (`OcctKernel`) is responsible
 * for invoking the right `*WithHistory` method and converting its output.
 */
export type EvolutionRecord = {
  /** Run-length-encoded input → result mapping for modified faces. */
  modified: number[];
  /** Run-length-encoded input → result mapping for newly generated faces. */
  generated: number[];
  /** Flat list of input face hashes that no longer exist in the result. */
  deleted: number[];
};

export class ShapeEvolutionTracker {
  private bodies = new Map<string, BodyRecord>();

  /**
   * Register a freshly-created body whose faces/edges have no prior history.
   * Used by primitive/sketch creation ops. Each face and edge hash gets a
   * fresh stable ID.
   *
   * @param bodyHandle - kernel-internal body handle (e.g. `body_42`).
   * @param faceHashes - hashCode of every face on the body, in walk order.
   * @param edgeHashes - hashCode of every edge on the body, in walk order.
   * @param origin - short tag for the originating op, used in debug IDs.
   */
  registerFreshBody(
    bodyHandle: string,
    faceHashes: number[],
    edgeHashes: number[],
    origin: string,
  ): void {
    // Walk-index based ids: same op rebuilding the same geometry walks
    // its sub-shapes in the same order, so face/edge indices align across
    // rebuilds. Combined with a feature-unique `origin` (passed by the
    // builder, typically `<op>_<featureId>`), this gives stable IDs that
    // survive OCCT's TShape regeneration between rebuilds.
    const faceHashToStable = new Map<number, StableFaceId>();
    for (let i = 0; i < faceHashes.length; i++) {
      faceHashToStable.set(faceHashes[i]!, indexedFaceStableId(origin, i));
    }
    const edgeHashToStable = new Map<number, StableEdgeId>();
    for (let i = 0; i < edgeHashes.length; i++) {
      edgeHashToStable.set(edgeHashes[i]!, indexedEdgeStableId(origin, i));
    }
    this.bodies.set(bodyHandle, { faceHashToStable, edgeHashToStable });
  }

  /**
   * Propagate stable IDs from input bodies to a freshly-produced result
   * body after a modify op (fuse/cut/fillet/mirror/etc.). The strategy is
   * hash-match: for each face on the result, hash it; if any input body
   * had a face with the same hash, copy that input's stable ID forward.
   * Otherwise assign a fresh ID.
   *
   * Why hash-match instead of `EvolutionData.modified[]`? OCCT's hashCode
   * is identity-based (TShape pointer-driven), so a face that survives
   * unchanged keeps its hash; a face that's geometrically modified gets
   * a fresh hash. The `EvolutionData` payload tells us which inputs were
   * modified vs deleted, but doesn't pair each modified input to its
   * specific result face — so it can't help us transfer IDs for renumbered
   * faces. Hash-match correctly handles every face whose underlying TShape
   * survived the op. Faces with renumbered hashes get fresh IDs here; the
   * RepairHint fallback reconciles those at resolve-time via
   * geometric similarity.
   *
   * @param resultBodyHandle - the kernel handle of the new result body.
   * @param inputBodyHandles - the kernel handles of the bodies fed into
   *   the op (typically 1 for unary, 2 for binary booleans).
   * @param resultFaceHashes - hash of every face on the result body, in
   *   walk order. Caller computes these via `kernel.hashCode(face, ...)`.
   * @param origin - short tag for the op kind (e.g. `fuse`, `fillet`),
   *   used in debug IDs assigned to generated faces.
   */
  propagateIds(
    resultBodyHandle: string,
    inputBodyHandles: string[],
    resultFaceHashes: number[],
    resultEdgeHashes: number[],
    origin: string,
  ): void {
    // For propagation: hash-match transfers the input's stable id. For
    // freshly-generated faces (no input match) we fall back to walk-index
    // ids so the same op rebuilding the same boolean produces the same
    // ids for new faces too (e.g. the rounded face a fillet introduces
    // gets `sf_fillet_<featureId>_<index>` every rebuild).
    const faceHashToStable = new Map<number, StableFaceId>();
    for (let i = 0; i < resultFaceHashes.length; i++) {
      const h = resultFaceHashes[i]!;
      let copied: StableFaceId | undefined;
      for (const inHandle of inputBodyHandles) {
        const id = this.bodies.get(inHandle)?.faceHashToStable.get(h);
        if (id !== undefined) {
          copied = id;
          break;
        }
      }
      faceHashToStable.set(h, copied ?? indexedFaceStableId(origin, i));
    }
    const edgeHashToStable = new Map<number, StableEdgeId>();
    for (let i = 0; i < resultEdgeHashes.length; i++) {
      const h = resultEdgeHashes[i]!;
      let copied: StableEdgeId | undefined;
      for (const inHandle of inputBodyHandles) {
        const id = this.bodies.get(inHandle)?.edgeHashToStable.get(h);
        if (id !== undefined) {
          copied = id;
          break;
        }
      }
      edgeHashToStable.set(h, copied ?? indexedEdgeStableId(origin, i));
    }
    this.bodies.set(resultBodyHandle, { faceHashToStable, edgeHashToStable });
  }

  /**
   * Propagate stable face IDs through an operation that returned OCCT
   * history via `*WithHistory`. Uses the per-input-face → per-result-face
   * mapping in `evolution.modified` to transfer IDs precisely — handles
   * the cases that {@link propagateIds}'s hash-match silently misses
   * (boolean recreates TShape, fillet modifies adjacent faces, etc.).
   *
   * Algorithm:
   * 1. Decode `modified` and `generated`. Build a result-hash → stable-id
   *    map by transferring each input face's stable ID to every result
   *    face it became.
   * 2. Walk every result face hash in `resultFaceHashes`. If a face is
   *    covered by step 1, use that ID. Otherwise fall back to the
   *    inherited hash-match path ({@link propagateIds}) — covers
   *    unchanged faces whose TShape survived.
   * 3. For freshly-generated faces with no input parent
   *    (`generated`-list entries), assign walk-index IDs so the same op
   *    rebuilding the same geometry produces the same IDs every time.
   * 4. Edges are NOT touched here — `EvolutionData` is face-only on the
   *    occt-wasm facade. Callers should still call {@link propagateIds}
   *    (or a future edge-history method) to propagate edge IDs.
   *
   * @param resultBodyHandle - kernel handle of the new result body.
   * @param inputBodyHandles - kernel handles of input bodies fed into op.
   * @param resultFaceHashes - hash of every face on the result body, in
   *   walk order. Caller computes via `kernel.hashCode(face, ...)`.
   * @param evolution - `EvolutionRecord` parsed from the WithHistory call.
   * @param origin - short tag for the op (e.g. `fuse_<featureId>`), used
   *   for debug IDs assigned to generated/fresh faces.
   */
  recordEvolution(
    resultBodyHandle: string,
    inputBodyHandles: string[],
    resultFaceHashes: number[],
    evolution: EvolutionRecord,
    origin: string,
  ): void {
    // Step 1: build resultHash → stableId from the input → result map.
    // For each input face that survived (in `modified`), find its stable
    // ID in any input body, then attach that ID to every result face it
    // became. For input faces that produced *new* output (in `generated`),
    // mint walk-index IDs and attach those to the result faces.
    const resultHashToStable = new Map<number, StableFaceId>();
    let generatedSeq = 0;

    for (const [inputHash, resultHashes] of decodeRunLength(evolution.modified)) {
      const inputStable = this.findInputStable(inputBodyHandles, inputHash);
      if (inputStable === undefined) continue; // input face wasn't tracked
      // Same ID assigned to every result face the input became. For N > 1
      // (face-split case) all children share the parent's ID — selection
      // healing for "I picked the split half" is a future enhancement
      // (would need a `:0` / `:1` suffix scheme; out of scope for now
      // since the user would have picked a single face originally).
      for (const rh of resultHashes) {
        resultHashToStable.set(rh, inputStable);
      }
    }

    for (const [, generatedHashes] of decodeRunLength(evolution.generated)) {
      for (const gh of generatedHashes) {
        // Fresh walk-index ID — same op rebuilding the same boolean
        // produces the same `sf_<origin>_<n>` for this generated face.
        // Doesn't collide with the parent-derived IDs above because the
        // result hashes are distinct from any input hash that was
        // present-and-modified (OCCT differentiates "modified" from
        // "generated" by whether the input survived).
        resultHashToStable.set(gh, indexedFaceStableId(origin, generatedSeq++));
      }
    }

    // Step 2: walk all result faces. Use map first, fall back to
    // hash-match against input bodies, fall back to walk-index. This
    // means an unchanged face whose TShape survived (so its hash is
    // identical to an input's hash) still gets its parent's stable ID —
    // matches the legacy hash-match behavior for that common case.
    const faceHashToStable = new Map<number, StableFaceId>();
    for (let i = 0; i < resultFaceHashes.length; i++) {
      const h = resultFaceHashes[i]!;
      const fromHistory = resultHashToStable.get(h);
      if (fromHistory !== undefined) {
        faceHashToStable.set(h, fromHistory);
        continue;
      }
      // Fallback A: hash-match against any input. Covers faces OCCT
      // didn't bother to report in modified/generated (some makers skip
      // unchanged faces).
      let copied: StableFaceId | undefined;
      for (const inHandle of inputBodyHandles) {
        const id = this.bodies.get(inHandle)?.faceHashToStable.get(h);
        if (id !== undefined) {
          copied = id;
          break;
        }
      }
      // Fallback B: walk-index ID seeded from the op origin + result
      // walk position. Same logic propagateIds() uses for orphan faces.
      faceHashToStable.set(h, copied ?? indexedFaceStableId(`${origin}_orphan`, i));
    }

    // Edges are not in EvolutionData — keep the existing per-body edge
    // map empty here; the caller must invoke propagateIds() afterward to
    // populate edges via the hash-match path. We store an empty edge
    // map so subsequent edge propagation can find this body record.
    const existing = this.bodies.get(resultBodyHandle);
    this.bodies.set(resultBodyHandle, {
      faceHashToStable,
      edgeHashToStable: existing?.edgeHashToStable ?? new Map<number, StableEdgeId>(),
    });
  }

  /**
   * Find the stable face ID for an input face hash across multiple input
   * bodies. Used by {@link recordEvolution} — the `modified` payload's
   * `inputHash` could come from any of the input bodies fed into the op.
   */
  private findInputStable(
    inputBodyHandles: string[],
    inputHash: number,
  ): StableFaceId | undefined {
    for (const handle of inputBodyHandles) {
      const id = this.bodies.get(handle)?.faceHashToStable.get(inputHash);
      if (id !== undefined) return id;
    }
    return undefined;
  }

  /**
   * Propagate ONLY the edge hash-to-stable map for a result body, given
   * inputs to copy from + the result body's edge hashes. Companion to
   * {@link recordEvolution} since `EvolutionData` is face-only.
   *
   * Same hash-match logic as the face fallback in {@link propagateIds},
   * carved into its own method so the kernel can call edges-only after
   * the face-history pass.
   */
  recordEdgeEvolution(
    resultBodyHandle: string,
    inputBodyHandles: string[],
    resultEdgeHashes: number[],
    origin: string,
  ): void {
    const edgeHashToStable = new Map<number, StableEdgeId>();
    for (let i = 0; i < resultEdgeHashes.length; i++) {
      const h = resultEdgeHashes[i]!;
      let copied: StableEdgeId | undefined;
      for (const inHandle of inputBodyHandles) {
        const id = this.bodies.get(inHandle)?.edgeHashToStable.get(h);
        if (id !== undefined) {
          copied = id;
          break;
        }
      }
      edgeHashToStable.set(h, copied ?? indexedEdgeStableId(origin, i));
    }
    const existing = this.bodies.get(resultBodyHandle);
    this.bodies.set(resultBodyHandle, {
      faceHashToStable: existing?.faceHashToStable ?? new Map<number, StableFaceId>(),
      edgeHashToStable,
    });
  }

  /** Look up the stable face ID for a face hash on a given body. */
  getStableFaceId(bodyHandle: string, faceHash: number): StableFaceId | undefined {
    return this.bodies.get(bodyHandle)?.faceHashToStable.get(faceHash);
  }

  /** Look up the stable edge ID for an edge hash on a given body. */
  getStableEdgeId(bodyHandle: string, edgeHash: number): StableEdgeId | undefined {
    return this.bodies.get(bodyHandle)?.edgeHashToStable.get(edgeHash);
  }

  /**
   * Reverse lookup: runtime face hash on a body for a given stable face ID.
   * The caller then walks `kernel.getSubShapes(body, 'face')` to find the
   * face whose `hashCode` matches.
   */
  resolveStableFaceId(bodyHandle: string, id: StableFaceId): number | undefined {
    const map = this.bodies.get(bodyHandle)?.faceHashToStable;
    if (!map) return undefined;
    for (const [hash, sid] of map) {
      if (sid === id) return hash;
    }
    return undefined;
  }

  /** Reverse lookup: runtime edge hash for a given stable edge ID. */
  resolveStableEdgeId(bodyHandle: string, id: StableEdgeId): number | undefined {
    const map = this.bodies.get(bodyHandle)?.edgeHashToStable;
    if (!map) return undefined;
    for (const [hash, sid] of map) {
      if (sid === id) return hash;
    }
    return undefined;
  }

  /** Forget all tracked state for a body (call from kernel.dispose). */
  forgetBody(bodyHandle: string): void {
    this.bodies.delete(bodyHandle);
  }

  /** Forget all bodies — used when a kernel session ends. */
  reset(): void {
    this.bodies.clear();
  }
}
