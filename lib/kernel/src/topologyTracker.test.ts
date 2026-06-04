/**
 * Unit tests for ShapeEvolutionTracker, focused on the history-driven
 * `recordEvolution` path that consumes occt-wasm `*WithHistory`
 * payloads. The legacy walk-index + hash-match paths
 * (`registerFreshBody`, `propagateIds`) are exercised in integration
 * via `occtKernel.test.ts`; this file isolates the history-driven
 * logic that hash-match silently failed on.
 *
 * No WASM dependency — every test builds a synthetic `EvolutionRecord`
 * by hand using the same run-length encoding the C++ facade emits.
 */

import { describe, expect, it } from 'vitest';
import { ShapeEvolutionTracker, type EvolutionRecord } from './topologyTracker.ts';

describe('ShapeEvolutionTracker.recordEvolution', () => {
  /**
   * Baseline: an op that doesn't change any input face (think mirror,
   * translate, or a fillet on an isolated edge). Every input face hash
   * appears unchanged on the result. recordEvolution should fall back
   * to hash-match and copy IDs forward.
   */
  it('preserves input IDs for unchanged result faces (hash-match fallback)', () => {
    const tracker = new ShapeEvolutionTracker();
    // Input body has two faces, hashes 100 and 200.
    tracker.registerFreshBody('input', [100, 200], [10, 20], 'box_origin');
    const inputIds = [
      tracker.getStableFaceId('input', 100),
      tracker.getStableFaceId('input', 200),
    ];

    // Result has the same two hashes (TShape survived). Empty evolution
    // payload — OCCT didn't report any modified/generated/deleted.
    const evolution: EvolutionRecord = { modified: [], generated: [], deleted: [] };
    tracker.recordEvolution('result', ['input'], [100, 200], evolution, 'mirror_f1');

    expect(tracker.getStableFaceId('result', 100)).toBe(inputIds[0]);
    expect(tracker.getStableFaceId('result', 200)).toBe(inputIds[1]);
  });

  /**
   * The case hash-match silently failed on: a boolean recreates an
   * input face's TShape so the result-side hash is fresh (say 999),
   * but OCCT knows in its history that input-face-100 became
   * result-face-999. recordEvolution should transfer the stable ID
   * across this hash gap.
   */
  it('transfers stable ID across a regenerated TShape via modified[]', () => {
    const tracker = new ShapeEvolutionTracker();
    tracker.registerFreshBody('input', [100], [10], 'box');
    const originalId = tracker.getStableFaceId('input', 100)!;

    // OCCT history says input face 100 became result face 999.
    // Run-length format: [inputHash, count, resultHash, ...]
    const evolution: EvolutionRecord = {
      modified: [100, 1, 999],
      generated: [],
      deleted: [],
    };
    tracker.recordEvolution('result', ['input'], [999], evolution, 'cut');

    expect(tracker.getStableFaceId('result', 999)).toBe(originalId);
  });

  /**
   * Face-split case: a boolean splits one input face into two result
   * faces. Both children should inherit the parent's stable ID. (A
   * future enhancement could add `:0` / `:1` suffixes for selection
   * healing; for now we accept that both halves resolve to the same ID
   * since user's original pick was for the whole.)
   */
  it('shares parent ID across face-split children (1→N modified)', () => {
    const tracker = new ShapeEvolutionTracker();
    tracker.registerFreshBody('input', [100], [10], 'box');
    const parentId = tracker.getStableFaceId('input', 100)!;

    // Input face 100 → result faces 901 and 902 (two halves of a split).
    const evolution: EvolutionRecord = {
      modified: [100, 2, 901, 902],
      generated: [],
      deleted: [],
    };
    tracker.recordEvolution('result', ['input'], [901, 902], evolution, 'cut');

    expect(tracker.getStableFaceId('result', 901)).toBe(parentId);
    expect(tracker.getStableFaceId('result', 902)).toBe(parentId);
  });

  /**
   * Generated faces (with no input parent — e.g. the rounded face a
   * fillet introduces) get fresh walk-index IDs. Same op rebuilding the
   * same geometry must produce the same stable IDs every time, so user-
   * captured FaceRefs on the fillet surface survive rebuilds.
   */
  it('assigns deterministic walk-index IDs to generated faces', () => {
    const tracker = new ShapeEvolutionTracker();
    tracker.registerFreshBody('input', [100, 200], [10, 20], 'box');

    // Input face 100 generated two new faces (think: an edge bevel
    // produces a rounded face shared between two adjacent faces).
    // Encoding: [parentHash, count, generatedHash_0, generatedHash_1].
    const evolution: EvolutionRecord = {
      modified: [],
      generated: [100, 2, 555, 556],
      deleted: [],
    };
    tracker.recordEvolution(
      'result_1',
      ['input'],
      [555, 556],
      evolution,
      'fillet_feat42',
    );

    const id555_first = tracker.getStableFaceId('result_1', 555);
    const id556_first = tracker.getStableFaceId('result_1', 556);
    expect(id555_first).toBeDefined();
    expect(id556_first).toBeDefined();
    expect(id555_first).not.toBe(id556_first); // distinct generated faces

    // Rebuild: same op, same generated faces, same origin → same IDs.
    // This is the regression that a global-counter approach would break.
    tracker.recordEvolution(
      'result_2',
      ['input'],
      [555, 556],
      evolution,
      'fillet_feat42',
    );
    expect(tracker.getStableFaceId('result_2', 555)).toBe(id555_first);
    expect(tracker.getStableFaceId('result_2', 556)).toBe(id556_first);
  });

  /**
   * Multi-input op (boolean fuse of two bodies). Each input contributes
   * its own faces, and history maps each to result faces independently.
   * The tracker must search ALL input bodies when looking up an
   * inputHash from the `modified` payload.
   */
  it('handles modified entries that reference faces on either input body', () => {
    const tracker = new ShapeEvolutionTracker();
    tracker.registerFreshBody('input_a', [100], [10], 'box_a');
    tracker.registerFreshBody('input_b', [200], [20], 'box_b');
    const idA = tracker.getStableFaceId('input_a', 100)!;
    const idB = tracker.getStableFaceId('input_b', 200)!;

    // Both inputs contributed: A's face 100 → result 901, B's face
    // 200 → result 902.
    const evolution: EvolutionRecord = {
      modified: [100, 1, 901, 200, 1, 902],
      generated: [],
      deleted: [],
    };
    tracker.recordEvolution(
      'result',
      ['input_a', 'input_b'],
      [901, 902],
      evolution,
      'fuse',
    );

    expect(tracker.getStableFaceId('result', 901)).toBe(idA);
    expect(tracker.getStableFaceId('result', 902)).toBe(idB);
  });

  /**
   * Deleted faces don't end up on the result. The tracker just doesn't
   * include them in the result body's map — `getStableFaceId` for the
   * old hash on the new body returns undefined.
   */
  it('omits deleted input faces from the result body', () => {
    const tracker = new ShapeEvolutionTracker();
    tracker.registerFreshBody('input', [100, 200], [10, 20], 'box');

    // Input face 100 was eliminated (e.g. consumed entirely by a cut);
    // face 200 survives with new hash 999.
    const evolution: EvolutionRecord = {
      modified: [200, 1, 999],
      generated: [],
      deleted: [100],
    };
    tracker.recordEvolution('result', ['input'], [999], evolution, 'cut');

    // The deleted face's old hash isn't tracked on the result body —
    // there's nothing at hash 100 because the face is gone, and we
    // don't carry over the old hash either.
    expect(tracker.getStableFaceId('result', 100)).toBeUndefined();
    expect(tracker.getStableFaceId('result', 999)).toBeDefined();
  });

  /**
   * Defensive decoding: a truncated run-length encoding (count claims
   * more hashes than the array has) should bail rather than crash.
   * Guards against future facade format drift.
   */
  it('tolerates a truncated run-length payload without crashing', () => {
    const tracker = new ShapeEvolutionTracker();
    tracker.registerFreshBody('input', [100], [10], 'box');

    // Says count=3 but only 1 result hash present — the rest is
    // truncated. Decoder should bail at the bad entry.
    const evolution: EvolutionRecord = {
      modified: [100, 3, 999],
      generated: [],
      deleted: [],
    };
    expect(() =>
      tracker.recordEvolution('result', ['input'], [999], evolution, 'cut'),
    ).not.toThrow();
    // Truncated entry was skipped, so the result face falls back to the
    // hash-match path — which misses since 999 isn't in any input body.
    // It then falls back to walk-index — so we get *some* id, just not
    // the parent's.
    expect(tracker.getStableFaceId('result', 999)).toBeDefined();
  });
});

describe('ShapeEvolutionTracker.recordEdgeEvolution', () => {
  /**
   * Edge history isn't part of occt-wasm's EvolutionData (face-only).
   * recordEdgeEvolution is the hash-match companion the kernel calls
   * after recordEvolution so the result body's edge map gets populated.
   */
  it('copies edge IDs from input bodies via hash-match', () => {
    const tracker = new ShapeEvolutionTracker();
    tracker.registerFreshBody('input', [100], [10, 20], 'box');
    const e10 = tracker.getStableEdgeId('input', 10);
    const e20 = tracker.getStableEdgeId('input', 20);

    // First seed the face map so recordEdgeEvolution doesn't clobber
    // it (the kernel calls recordEvolution then recordEdgeEvolution).
    tracker.recordEvolution('result', ['input'], [100], { modified: [], generated: [], deleted: [] }, 'mirror');
    tracker.recordEdgeEvolution('result', ['input'], [10, 20], 'mirror');

    expect(tracker.getStableEdgeId('result', 10)).toBe(e10);
    expect(tracker.getStableEdgeId('result', 20)).toBe(e20);
  });

  it('mints walk-index IDs for edges with no input parent', () => {
    const tracker = new ShapeEvolutionTracker();
    tracker.registerFreshBody('input', [100], [10], 'box');

    // Result has edge hash 99 that doesn't exist on any input → fresh
    // walk-index ID.
    tracker.recordEvolution('result', ['input'], [100], { modified: [], generated: [], deleted: [] }, 'fillet');
    tracker.recordEdgeEvolution('result', ['input'], [99], 'fillet_feat3');
    const id = tracker.getStableEdgeId('result', 99);
    expect(id).toBeDefined();
    expect(String(id)).toContain('fillet_feat3');
  });
});
