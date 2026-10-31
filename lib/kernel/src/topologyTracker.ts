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
 * Sort key for a result sub-shape, by its walk index. Compared
 * lexicographically, ascending. Used to decide which of several faces that
 * ended up with the same stable ID keeps it unsuffixed.
 */
export type ElementOrderKey = (walkIndex: number) => readonly number[];

function compareKeys(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * Make the IDs in one body unique. `ids[i]` is the ID chosen for the
 * sub-shape at walk index `i`. When several sub-shapes share an ID (a face
 * split into pieces, or two ops minting the same walk-index ID), one keeps
 * it and the rest become `<id>:1`, `<id>:2`, … skipping any suffix another
 * sub-shape already carries. The keeper is the first inherited ID (not
 * marked `fresh`) — refs may already point at it — then the first by
 * `order`, then by walk index.
 *
 * Without this, the reverse lookup in `resolveStableFaceId` returns
 * whichever duplicate it meets first, so an ID reported for one face can
 * resolve to another.
 */
function makeUnique<T extends string>(
  hashes: number[],
  ids: T[],
  brand: (raw: string) => T,
  fresh: boolean[],
  order?: ElementOrderKey,
): Map<number, T> {
  const groups = new Map<T, number[]>();
  ids.forEach((id, i) => {
    const g = groups.get(id);
    if (g) g.push(i);
    else groups.set(id, [i]);
  });
  const used = new Set<string>(ids);
  const result = [...ids];
  for (const [id, members] of groups) {
    if (members.length < 2) continue;
    const ranked = members
      .map(i => ({ i, key: [fresh[i] ? 1 : 0, ...(order ? order(i) : [])] }))
      .sort((a, b) => compareKeys(a.key, b.key) || a.i - b.i)
      .map(m => m.i);
    let suffix = 1;
    for (const i of ranked.slice(1)) {
      while (used.has(`${id}:${suffix}`)) suffix++;
      const next = brand(`${id}:${suffix}`);
      used.add(next);
      result[i] = next;
    }
  }
  const map = new Map<number, T>();
  hashes.forEach((h, i) => map.set(h, result[i]!));
  return map;
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
    const inherited = resultFaceHashes.map(h => this.findInputStable(inputBodyHandles, h));
    const faceIds = inherited.map((id, i) => id ?? indexedFaceStableId(origin, i));
    const faceHashToStable = makeUnique(
      resultFaceHashes,
      faceIds,
      stableFaceId,
      inherited.map(id => id === undefined),
    );
    this.bodies.set(resultBodyHandle, {
      faceHashToStable,
      edgeHashToStable: this.edgeIdsByHashMatch(inputBodyHandles, resultEdgeHashes, origin),
    });
  }

  /**
   * Propagate stable face IDs through an operation that returned OCCT
   * history via `*WithHistory`. Uses the per-input-face → per-result-face
   * mapping in `evolution.modified` to transfer IDs precisely — handles
   * the cases that {@link propagateIds}'s hash-match silently misses
   * (boolean recreates TShape, fillet modifies adjacent faces, etc.).
   *
   * Each result face takes the first of:
   * 1. **Hash-match** — the face's TShape survived the op unchanged, so
   *    it *is* that input face and keeps its ID.
   * 2. **`modified`** — OCCT says an input face became this one. When
   *    several inputs merged into one result face (coplanar faces of a
   *    fuse), the first input in the payload wins; the facade lists the
   *    first operand's faces first, so the target body keeps its names.
   * 3. **`generated`** — a new face OCCT attributes to an input face
   *    (shell's inner walls, a fillet's rounded face). Gets
   *    `sf_<origin>_<n>`, numbered in payload order over the entries that
   *    are result faces with no ID yet. Boolean `generated` lists carry
   *    section edges, not faces; counting only real, unnamed faces keeps
   *    the numbering independent of those entries and of a stray hash
   *    collision between an edge and a named face.
   * 4. **Orphan** — `sf_<origin>_orphan_<walkIndex>`.
   *
   * A face split into N pieces gives all N the parent's ID through step 2;
   * the uniqueness pass then keeps the bare ID on the first piece by
   * `order` (the kernel passes largest area first) and suffixes the rest
   * `:1`, `:2`, … so every ID names exactly one face.
   *
   * Edges are NOT touched here — `EvolutionData` is face-only on the
   * occt-wasm facade. Callers follow up with {@link recordEdgeEvolution}.
   *
   * @param resultBodyHandle - kernel handle of the new result body.
   * @param inputBodyHandles - kernel handles of input bodies fed into op.
   * @param resultFaceHashes - hash of every face on the result body, in
   *   walk order. Caller computes via `kernel.hashCode(face, ...)`.
   * @param evolution - `EvolutionRecord` parsed from the WithHistory call.
   * @param origin - short tag for the op (e.g. `fuse_<featureId>`), used
   *   for debug IDs assigned to generated/fresh faces.
   * @param order - sort key per result walk index, used to pick which of
   *   several faces sharing an ID keeps it. Walk order when omitted.
   */
  recordEvolution(
    resultBodyHandle: string,
    inputBodyHandles: string[],
    resultFaceHashes: number[],
    evolution: EvolutionRecord,
    origin: string,
    order?: ElementOrderKey,
  ): void {
    const resultFaces = new Set(resultFaceHashes);
    const assigned = new Map<number, StableFaceId>();
    // Result faces whose ID is minted by this op rather than carried over.
    const minted = new Set<number>();

    for (const h of resultFaceHashes) {
      const id = this.findInputStable(inputBodyHandles, h);
      if (id !== undefined) assigned.set(h, id);
    }

    for (const [inputHash, resultHashes] of decodeRunLength(evolution.modified)) {
      const inputStable = this.findInputStable(inputBodyHandles, inputHash);
      if (inputStable === undefined) continue; // input face wasn't tracked
      for (const rh of resultHashes) {
        if (resultFaces.has(rh) && !assigned.has(rh)) assigned.set(rh, inputStable);
      }
    }

    let generatedSeq = 0;
    for (const [, generatedHashes] of decodeRunLength(evolution.generated)) {
      for (const gh of generatedHashes) {
        if (!resultFaces.has(gh) || assigned.has(gh)) continue;
        assigned.set(gh, indexedFaceStableId(origin, generatedSeq++));
        minted.add(gh);
      }
    }

    const faceIds = resultFaceHashes.map(
      (h, i) => assigned.get(h) ?? indexedFaceStableId(`${origin}_orphan`, i),
    );
    const faceHashToStable = makeUnique(
      resultFaceHashes,
      faceIds,
      stableFaceId,
      resultFaceHashes.map(h => minted.has(h) || !assigned.has(h)),
      order,
    );

    // Edges are not in EvolutionData — keep the existing per-body edge
    // map here; the caller follows up with recordEdgeEvolution().
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
    const existing = this.bodies.get(resultBodyHandle);
    this.bodies.set(resultBodyHandle, {
      faceHashToStable: existing?.faceHashToStable ?? new Map<number, StableFaceId>(),
      edgeHashToStable: this.edgeIdsByHashMatch(inputBodyHandles, resultEdgeHashes, origin),
    });
  }

  /**
   * Hash-match result edges against the input bodies; unmatched edges get
   * walk-index IDs. Made unique per body: walk-index IDs minted by two
   * steps of the same fold (`se_fuse_3` twice) would otherwise collide.
   */
  private edgeIdsByHashMatch(
    inputBodyHandles: string[],
    resultEdgeHashes: number[],
    origin: string,
  ): Map<number, StableEdgeId> {
    const inherited = resultEdgeHashes.map(h => {
      for (const inHandle of inputBodyHandles) {
        const id = this.bodies.get(inHandle)?.edgeHashToStable.get(h);
        if (id !== undefined) return id;
      }
      return undefined;
    });
    return makeUnique(
      resultEdgeHashes,
      inherited.map((id, i) => id ?? indexedEdgeStableId(origin, i)),
      stableEdgeId,
      inherited.map(id => id === undefined),
    );
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
