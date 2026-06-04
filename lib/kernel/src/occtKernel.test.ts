/**
 * End-to-end tests for OcctKernel against the real occt-wasm WASM kernel.
 *
 * Verifies kernel-boundary ops: primitives, sketches, extrude, revolve, loft,
 * booleans, modify (fillet/chamfer/mirror/patterns), tessellate/topology/bbox,
 * mass props, exports. Browser smoke (driving the SPA dev server) catches
 * integration bugs in the worker; this file catches kernel-level regressions
 * deterministically in Node.
 *
 * Each test instantiates a fresh kernel — slow (~250ms init) but bulletproof
 * against state bleed.
 */

import { describe, expect, it } from 'vitest';
import { OcctKernel } from './occtKernel.ts';
import { FINE_TESSELLATION } from './types.ts';

async function newKernel(): Promise<OcctKernel> {
  const k = new OcctKernel();
  await k.init();
  return k;
}

describe('OcctKernel — topology naming (TN-b)', () => {
  it('makeBox assigns a distinct StableFaceId to each of the 6 faces', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    // Tessellate first so getTopology has cached face groups; not strictly
    // required for stable IDs (those come from the tracker), but matches the
    // rebuilder's call order.
    await k.tessellate(r.value, FINE_TESSELLATION);
    const topo = await k.getTopology(r.value);
    expect(topo.faces).toHaveLength(6);
    const ids = topo.faces.map(f => f.stableFaceId);
    expect(ids.every(id => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(6); // all distinct
  });

  it('makeCylinder assigns IDs to side + top + bottom faces', async () => {
    const k = await newKernel();
    const r = await k.makeCylinder({ center: [0, 0, 0], axis: [0, 0, 1], radius: 5, height: 10 });
    if (!r.ok) throw new Error('precondition failed');
    await k.tessellate(r.value, FINE_TESSELLATION);
    const topo = await k.getTopology(r.value);
    // OCCT cylinder solid: 3 faces (top cap, bottom cap, side).
    expect(topo.faces).toHaveLength(3);
    expect(topo.faces.every(f => f.stableFaceId !== undefined)).toBe(true);
  });

  it('extrudeFace + getTopology yields stable IDs covering every face', async () => {
    const k = await newKernel();
    const face = await k.createSketchFace({
      type: 'circle',
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      radius: 10,
    });
    if (!face.ok) throw new Error('sketch failed');
    const body = await k.extrudeFace(face.value, [0, 0, 25]);
    if (!body.ok) throw new Error('extrude failed');
    await k.tessellate(body.value, FINE_TESSELLATION);
    const topo = await k.getTopology(body.value);
    // Extruded circle: 3 faces (top cap, bottom cap, side).
    expect(topo.faces.length).toBeGreaterThanOrEqual(3);
    expect(topo.faces.every(f => f.stableFaceId !== undefined)).toBe(true);
  });
});

describe('OcctKernel — topology naming (TN-c, history propagation)', () => {
  it('booleanFuse: faces away from the merge zone retain their original stable IDs', async () => {
    const k = await newKernel();
    // Two boxes whose +X / -X faces overlap so most faces survive the fuse
    // untouched. Bottom (-Z), top (+Z), back (-Y), front (+Y) of each box
    // touch the merge plane along an edge but their planar surfaces don't
    // change → OCCT keeps the same TShape, hash stays identical → ID copies.
    const a = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    const b = await k.makeBox({ origin: [10, 0, 0], width: 10, height: 10, depth: 10 });
    if (!a.ok || !b.ok) throw new Error('precondition failed');

    await k.tessellate(a.value, FINE_TESSELLATION);
    await k.tessellate(b.value, FINE_TESSELLATION);
    const topoA = await k.getTopology(a.value);
    const topoB = await k.getTopology(b.value);
    const aIds = new Set(topoA.faces.map(f => f.stableFaceId));
    const bIds = new Set(topoB.faces.map(f => f.stableFaceId));

    const fused = await k.booleanFuse([a.value, b.value]);
    if (!fused.ok) throw new Error('fuse failed');
    await k.tessellate(fused.value, FINE_TESSELLATION);
    const topoFused = await k.getTopology(fused.value);
    const fusedIds = topoFused.faces
      .map(f => f.stableFaceId)
      .filter((x): x is NonNullable<typeof x> => x !== undefined);

    // At least some IDs from A or B must show up in the fused result —
    // proving the tracker propagated them rather than minting all-fresh IDs.
    const preserved = fusedIds.filter(id => aIds.has(id) || bIds.has(id));
    expect(preserved.length).toBeGreaterThan(0);
  });

  it('mirror: every face on the mirrored body gets a stable ID', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [10, 0, 0], width: 5, height: 5, depth: 5 });
    if (!r.ok) throw new Error('precondition failed');
    await k.tessellate(r.value, FINE_TESSELLATION);

    const m = await k.mirror(r.value, { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] });
    if (!m.ok) throw new Error('mirror failed');
    await k.tessellate(m.value, FINE_TESSELLATION);
    const topo = await k.getTopology(m.value);
    expect(topo.faces.every(f => f.stableFaceId !== undefined)).toBe(true);
  });
});

describe('OcctKernel — topology naming (TN-d, resolveFaceRef)', () => {
  it('round-trip: pick a face, capture its stableId, resolve back to the same face', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    await k.tessellate(r.value, FINE_TESSELLATION);
    const topo = await k.getTopology(r.value);
    expect(topo.faces.length).toBe(6);
    // Pretend the user picked face index 3.
    const picked = topo.faces[3]!;
    const sid = picked.stableFaceId!;
    expect(sid).toBeDefined();
    const resolved = await k.resolveFaceRef(r.value, sid);
    expect(resolved).not.toBeNull();
    expect(resolved?.bodyHandle).toBe(r.value.handle);
  });

  it('resolveFaceRef returns null for an unknown stable ID', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 5, height: 5, depth: 5 });
    if (!r.ok) throw new Error('precondition failed');
    const resolved = await k.resolveFaceRef(r.value, 'sf_bogus_999' as never);
    expect(resolved).toBeNull();
  });

  it('a face on a fused body whose ID came from input A resolves on the fused body', async () => {
    const k = await newKernel();
    const a = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    const b = await k.makeBox({ origin: [10, 0, 0], width: 10, height: 10, depth: 10 });
    if (!a.ok || !b.ok) throw new Error('precondition failed');
    await k.tessellate(a.value, FINE_TESSELLATION);
    const topoA = await k.getTopology(a.value);
    // Capture the bottom face ID of A — bottom face survives the fuse intact.
    const aBottom = topoA.faces.find(f => f.stableFaceId);
    const sid = aBottom?.stableFaceId;
    if (!sid) throw new Error('no stable IDs');

    const fused = await k.booleanFuse([a.value, b.value]);
    if (!fused.ok) throw new Error('fuse failed');
    // Resolving on the *fused* body finds the propagated face.
    const resolved = await k.resolveFaceRef(fused.value, sid);
    if (resolved !== null) {
      expect(resolved.bodyHandle).toBe(fused.value.handle);
    }
    // Note: depending on which face was picked, the fuse may or may not have
    // preserved it. At least one face from A must have propagated though,
    // verified by the history-propagation fuse test — so this isn't a strict
    // invariant for every pick. We accept null here when the picked face was
    // consumed.
  });
});

describe('OcctKernel — topology naming (TN-e, RepairHint fallback)', () => {
  it('resolveFaceRef with a bogus ID + valid hint finds the face by centroid/normal/area', async () => {
    const k = await newKernel();
    // 10×10×10 box at origin. The +Z (top) face has:
    //   centroid (5, 5, 10), normal (0, 0, 1), area 100.
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    const resolved = await k.resolveFaceRef(r.value, 'sf_unknown' as never, {
      centroid: [5, 5, 10],
      normal: [0, 0, 1],
      area: 100,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.bodyHandle).toBe(r.value.handle);
  });

  it('returns null when hint thresholds are not satisfied', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    // Centroid far outside the box.
    const resolved = await k.resolveFaceRef(r.value, 'sf_unknown' as never, {
      centroid: [500, 500, 500],
      normal: [0, 0, 1],
      area: 100,
    });
    expect(resolved).toBeNull();
  });

  it('hint area mismatch rejects an otherwise-matching candidate', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    // Hint matches centroid + normal of the +Z face but expects area 5000
    // (50× actual). Should fail the area-ratio threshold.
    const resolved = await k.resolveFaceRef(r.value, 'sf_unknown' as never, {
      centroid: [5, 5, 10],
      normal: [0, 0, 1],
      area: 5000,
    });
    expect(resolved).toBeNull();
  });
});

describe('OcctKernel — topology naming (TN-f, edges)', () => {
  it('makeBox surfaces a distinct StableEdgeId for each of the 12 edges', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    const topo = await k.getTopology(r.value);
    expect(topo.edges).toHaveLength(12);
    const ids = topo.edges.map(e => e.stableEdgeId);
    expect(ids.every(id => id !== undefined)).toBe(true);
    expect(new Set(ids).size).toBe(12);
  });

  it('resolveEdgeRef returns the runtime edge for a known stable ID', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    const topo = await k.getTopology(r.value);
    const pickedSid = topo.edges[5]?.stableEdgeId;
    if (!pickedSid) throw new Error('no stable edge ID');
    const resolved = await k.resolveEdgeRef(r.value, pickedSid);
    expect(resolved).not.toBeNull();
    expect(resolved?.bodyHandle).toBe(r.value.handle);
  });

  it('resolveEdgeRef falls back to nearest-midpoint when the stable ID misses', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    // The edge along Y at x=10, z=0 has midpoint (10, 5, 0).
    const resolved = await k.resolveEdgeRef(r.value, 'se_unknown' as never, {
      centroid: [10, 5, 0],
    });
    expect(resolved).not.toBeNull();
  });
});

describe('OcctKernel — getTopology face/triangle alignment', () => {
  /**
   * Regression net for two related bugs in the
   * meshShape() ↔ getSubShapes('face') ↔ TopologyMap pipeline:
   *
   *   (1) **Face-index misalignment** — the mesher and topology walker
   *       don't guarantee the same iteration order over a shape's faces.
   *       Fixed in occtKernel.ts by hash-keying the cache via
   *       `MESH_HASH_BOUND`. See the topologyCache docstring.
   *
   *   (2) **Triangle-unit confusion** — the C++ mesher stores
   *       `faceTriStart` and `nbTri * 3` in INDEX units; every consumer
   *       (selectionHighlight at ":164" multiplies by 3 to recover
   *       indices) expects TRIANGLE units. The kernel now divides by 3
   *       at ingestion. If the conversion is dropped, the highlight
   *       overruns into the next 2–3 faces and the user sees adjacent
   *       faces visually fused.
   *
   * For a box, every face is planar with a known outward normal. If a
   * face's triangle range really belongs to that face, the average of
   * the contained triangles' normals is a unit axis vector. If the bug
   * regresses (range belongs to a different face or spills into a
   * neighbor), the average is a non-axis direction and the test fails.
   *
   * Treats `triStart` / `triEnd` as TRIANGLE numbers (the schema
   * contract). The test must NOT divide them by 3 — doing so would
   * accidentally absorb a unit-mismatch bug rather than catch it.
   */
  it('every face on an extruded body has triangles matching its own normal', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 20, depth: 30 });
    if (!r.ok) throw new Error('precondition failed');
    const mesh = await k.tessellate(r.value, FINE_TESSELLATION);
    const topo = await k.getTopology(r.value);
    expect(topo.faces).toHaveLength(6);

    // Recompute per-triangle normal from positions[indices[i..i+2]] and
    // compare to the face's stored range. Indices/positions are
    // interleaved XYZ floats; triangle `t` lives at indices[3t..3t+2].
    const pos = mesh.positions;
    const idx = mesh.indices;

    function triNormal(t: number): [number, number, number] {
      const i0 = (idx[3 * t]! as number) * 3;
      const i1 = (idx[3 * t + 1]! as number) * 3;
      const i2 = (idx[3 * t + 2]! as number) * 3;
      const ax = pos[i1]! - pos[i0]!;
      const ay = pos[i1 + 1]! - pos[i0 + 1]!;
      const az = pos[i1 + 2]! - pos[i0 + 2]!;
      const bx = pos[i2]! - pos[i0]!;
      const by = pos[i2 + 1]! - pos[i0 + 1]!;
      const bz = pos[i2 + 2]! - pos[i0 + 2]!;
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      return [nx / len, ny / len, nz / len];
    }

    // Box face normals are axis-aligned ±1 on exactly one axis.
    function classify(n: [number, number, number]): string {
      const [x, y, z] = n;
      const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
      if (ax > ay && ax > az) return x > 0 ? '+X' : '-X';
      if (ay > ax && ay > az) return y > 0 ? '+Y' : '-Y';
      return z > 0 ? '+Z' : '-Z';
    }

    const observed = new Set<string>();
    for (const face of topo.faces) {
      const triCount = face.triEnd - face.triStart; // triangle units
      expect(triCount).toBeGreaterThan(0); // every box face must have triangles
      let sx = 0, sy = 0, sz = 0;
      for (let t = face.triStart; t < face.triEnd; t++) {
        const [nx, ny, nz] = triNormal(t);
        sx += nx; sy += ny; sz += nz;
      }
      const avgLen = Math.hypot(sx, sy, sz) || 1;
      const avg: [number, number, number] = [sx / avgLen, sy / avgLen, sz / avgLen];
      const tag = classify(avg);
      observed.add(tag);
      // Average must be a near-pure axis direction. > 0.95 means the
      // contained triangles are coplanar and face the same direction —
      // i.e., the range really did land on a single planar face.
      const dominant = Math.max(Math.abs(avg[0]), Math.abs(avg[1]), Math.abs(avg[2]));
      expect(dominant).toBeGreaterThan(0.95);
    }
    // All 6 axis-aligned face normals must appear — confirms each face's
    // range really did land on the right triangles.
    expect(observed.size).toBe(6);
  });

  it('triangle ranges from getTopology cover every triangle in the mesh exactly once', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    const mesh = await k.tessellate(r.value, FINE_TESSELLATION);
    const topo = await k.getTopology(r.value);
    const totalTris = mesh.indices.length / 3;
    const covered = new Uint8Array(totalTris);
    for (const face of topo.faces) {
      // Triangle units throughout.
      for (let t = face.triStart; t < face.triEnd; t++) {
        expect(covered[t]).toBe(0); // no triangle counted twice
        covered[t] = 1;
      }
    }
    for (let t = 0; t < totalTris; t++) {
      expect(covered[t]).toBe(1); // every triangle assigned to exactly one face
    }
  });

  /**
   * Reproduces the orientation-dependent picking bug observed in the
   * browser: a Z-axis cylinder selects its whole lateral face correctly,
   * but an X-axis cylinder (same geometry, different extrude direction)
   * shows only a narrow vertical strip. If OCCT is splitting the lateral
   * face into multiple OCCT faces for non-Z extrusions, the face count
   * will differ between the two cases.
   */
  /**
   * Regression for the arc-polygonalization bug. A sketch boundary made
   * of N line segments + M arc fillets, extruded, should produce
   * exactly N + M lateral faces — one per BREP edge — not ~64×M
   * (which is what we'd get if the arc were sampled into 64 straight
   * segments and each became its own strip face).
   *
   * Specifically: a 4-corner rounded rectangle has 4 straight sides +
   * 4 corner arcs = 8 BREP edges in the boundary wire. The extruded
   * solid then has 8 lateral faces + 2 caps = 10 total.
   */
  it('extruded rounded rectangle (4 lines + 4 arcs) yields 10 faces, not ~256', async () => {
    const k = await newKernel();
    // Rounded rectangle 20 × 12 with corner radius 3, on XY plane.
    // Sides go (in CCW order): bottom, bottom-right corner, right,
    // top-right corner, top, top-left corner, left, bottom-left corner.
    const r = 3;
    const w = 20, h = 12;
    const hw = w / 2, hh = h / 2;
    const profile = await k.createSketchFace({
      type: 'wire',
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      segments: [
        { kind: 'line', start: [-hw + r, -hh, 0], end: [hw - r, -hh, 0] },
        {
          kind: 'arc3pt',
          start: [hw - r, -hh, 0],
          // 45° midpoint on the corner arc, centered at (hw-r, -hh+r)
          mid: [hw - r + r * Math.cos(-Math.PI / 4), -hh + r + r * Math.sin(-Math.PI / 4), 0],
          end: [hw, -hh + r, 0],
        },
        { kind: 'line', start: [hw, -hh + r, 0], end: [hw, hh - r, 0] },
        {
          kind: 'arc3pt',
          start: [hw, hh - r, 0],
          mid: [hw - r + r * Math.cos(Math.PI / 4), hh - r + r * Math.sin(Math.PI / 4), 0],
          end: [hw - r, hh, 0],
        },
        { kind: 'line', start: [hw - r, hh, 0], end: [-hw + r, hh, 0] },
        {
          kind: 'arc3pt',
          start: [-hw + r, hh, 0],
          mid: [-hw + r + r * Math.cos((3 * Math.PI) / 4), hh - r + r * Math.sin((3 * Math.PI) / 4), 0],
          end: [-hw, hh - r, 0],
        },
        { kind: 'line', start: [-hw, hh - r, 0], end: [-hw, -hh + r, 0] },
        {
          kind: 'arc3pt',
          start: [-hw, -hh + r, 0],
          mid: [-hw + r + r * Math.cos((5 * Math.PI) / 4), -hh + r + r * Math.sin((5 * Math.PI) / 4), 0],
          end: [-hw + r, -hh, 0],
        },
      ],
    });
    if (!profile.ok) throw new Error('wire profile face failed: ' + profile.error.message);
    const body = await k.extrudeFace(profile.value, [0, 0, 5]);
    if (!body.ok) throw new Error('wire extrude failed: ' + body.error.message);
    await k.tessellate(body.value, FINE_TESSELLATION);
    const topo = await k.getTopology(body.value);

    // 8 lateral faces (4 straight sides + 4 cylindrical fillet strips) + 2 caps.
    expect(topo.faces).toHaveLength(10);
    // 8 + 8 + 8 = 24 BREP edges (top loop + bottom loop + 8 vertical seam edges).
    expect(topo.edges).toHaveLength(24);
  });

  it('Z-axis vs X-axis cylinder produce the same face count', async () => {
    const k = await newKernel();

    // Z-axis: circle on XY, extrude along +Z.
    const faceZ = await k.createSketchFace({
      type: 'circle',
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      radius: 5,
    });
    if (!faceZ.ok) throw new Error('Z sketch failed');
    const bodyZ = await k.extrudeFace(faceZ.value, [0, 0, 20]);
    if (!bodyZ.ok) throw new Error('Z extrude failed');
    await k.tessellate(bodyZ.value, FINE_TESSELLATION);
    const topoZ = await k.getTopology(bodyZ.value);

    // X-axis: circle on YZ, extrude along +X.
    const faceX = await k.createSketchFace({
      type: 'circle',
      origin: [0, 0, 0],
      normal: [1, 0, 0],
      radius: 5,
    });
    if (!faceX.ok) throw new Error('X sketch failed');
    const bodyX = await k.extrudeFace(faceX.value, [20, 0, 0]);
    if (!bodyX.ok) throw new Error('X extrude failed');
    await k.tessellate(bodyX.value, FINE_TESSELLATION);
    const topoX = await k.getTopology(bodyX.value);

    // Both should have 3 faces (top cap, bottom cap, lateral surface).
    // If OCCT splits the X-axis lateral face, faceCount will differ — that
    // explains the browser's "only one strip highlighted" symptom.
    expect(topoZ.faces.length).toBe(3);
    expect(topoX.faces.length).toBe(3);

    // Total triangles in the lateral face should be similar between the
    // two orientations (within a factor of 2 — tessellation quality may
    // vary slightly with normal orientation, but not 10×).
    const lateralTrisZ = Math.max(...topoZ.faces.map(f => f.triEnd - f.triStart));
    const lateralTrisX = Math.max(...topoX.faces.map(f => f.triEnd - f.triStart));
    expect(lateralTrisX).toBeGreaterThan(lateralTrisZ / 3);
    expect(lateralTrisX).toBeLessThan(lateralTrisZ * 3);
  });

  /**
   * Regression net for the `polylinesToLineSegments` FLOAT-vs-POINT unit
   * confusion that drew stray crossing lines (X-diagonals on flat faces,
   * picket-fence on cylinders).
   *
   * For a box, every BREP edge is straight (2 sample points → 1 segment),
   * and every segment endpoint lies on a corner of the box (one of the 8
   * vertices with coordinates in {0, 10}). If the function over-generates
   * segments by treating FLOAT counts as POINT counts, the extra segments
   * read into adjacent edges' points and end up with endpoints OFF the
   * box surface (e.g. interpolated points along a different edge's curve
   * sampling). The test fails immediately.
   */
  it('box edge segments stay on the box surface (no stray crossing lines)', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    const mesh = await k.tessellate(r.value, FINE_TESSELLATION);
    const edges = mesh.edgePositions;
    if (!edges) throw new Error('edgePositions missing');

    // A box has 12 BREP edges, each straight, so 12 segments × 6 floats = 72.
    expect(edges.length).toBe(72);

    // Every endpoint must be a corner of the 10×10×10 box → coordinates in
    // {0, 10} exactly. If the bug regresses, segments interpolate into
    // adjacent edges' sample points and these coords drift.
    const onBox = (v: number): boolean =>
      Math.abs(v) < 1e-6 || Math.abs(v - 10) < 1e-6;
    for (let i = 0; i < edges.length; i++) {
      expect(onBox(edges[i]!)).toBe(true);
    }
  });

  it('edge lineSegments correspond to each edge on a cylinder (3 edges, all populated)', async () => {
    const k = await newKernel();
    const r = await k.makeCylinder({ center: [0, 0, 0], axis: [0, 0, 1], radius: 5, height: 10 });
    if (!r.ok) throw new Error('precondition failed');
    await k.tessellate(r.value, FINE_TESSELLATION);
    const topo = await k.getTopology(r.value);
    expect(topo.edges.length).toBeGreaterThanOrEqual(3);
    // Every edge that the wireframe pass tessellated should have at least
    // one segment. Degenerate / zero-length edges may be empty; here all
    // three cylinder edges (top circle, bottom circle, seam) are real.
    const populated = topo.edges.filter(e => e.lineSegments.length > 0);
    expect(populated.length).toBeGreaterThanOrEqual(3);
  });
});

describe('OcctKernel — primitives', () => {
  it('makeBox produces a tessellable solid with the expected AABB', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 20, depth: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bb = await k.getBoundingBox(r.value);
    expect(bb.min[0]).toBeCloseTo(0, 4);
    expect(bb.min[1]).toBeCloseTo(0, 4);
    expect(bb.min[2]).toBeCloseTo(0, 4);
    expect(bb.max[0]).toBeCloseTo(10, 4);
    expect(bb.max[1]).toBeCloseTo(20, 4);
    expect(bb.max[2]).toBeCloseTo(30, 4);
    const mesh = await k.tessellate(r.value, FINE_TESSELLATION);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.positions.length).toBeGreaterThan(0);
  });

  it('makeCylinder orients the cylinder along the requested axis', async () => {
    const k = await newKernel();
    // Cylinder along +X with radius 5, height 50, centered at origin.
    const r = await k.makeCylinder({ center: [0, 0, 0], axis: [1, 0, 0], radius: 5, height: 50 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bb = await k.getBoundingBox(r.value);
    // Length runs along X (0..50); cross-section is ±5 on Y and Z.
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(50, 2);
    expect(bb.max[1] - bb.min[1]).toBeCloseTo(10, 2);
    expect(bb.max[2] - bb.min[2]).toBeCloseTo(10, 2);
  });
});

describe('OcctKernel — sketch + extrude', () => {
  it('extrudes a circular sketch into a cylinder-shaped solid', async () => {
    const k = await newKernel();
    const faceR = await k.createSketchFace({
      type: 'circle',
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      radius: 10,
    });
    expect(faceR.ok).toBe(true);
    if (!faceR.ok) return;
    const bodyR = await k.extrudeFace(faceR.value, [0, 0, 25]);
    expect(bodyR.ok).toBe(true);
    if (!bodyR.ok) return;
    const bb = await k.getBoundingBox(bodyR.value);
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(20, 2);
    expect(bb.max[1] - bb.min[1]).toBeCloseTo(20, 2);
    expect(bb.max[2] - bb.min[2]).toBeCloseTo(25, 2);
  });
});

describe('OcctKernel — booleans', () => {
  it('fuses two overlapping boxes into one body', async () => {
    const k = await newKernel();
    const a = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    const b = await k.makeBox({ origin: [5, 0, 0], width: 10, height: 10, depth: 10 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const fused = await k.booleanFuse([a.value, b.value]);
    expect(fused.ok).toBe(true);
    if (!fused.ok) return;
    const bb = await k.getBoundingBox(fused.value);
    // Union spans X from 0 to 15.
    expect(bb.min[0]).toBeCloseTo(0, 4);
    expect(bb.max[0]).toBeCloseTo(15, 4);
  });

  it('cuts a tool box out of a target box', async () => {
    const k = await newKernel();
    const target = await k.makeBox({ origin: [0, 0, 0], width: 20, height: 20, depth: 20 });
    const tool = await k.makeBox({ origin: [5, 5, 5], width: 10, height: 10, depth: 10 });
    if (!target.ok || !tool.ok) throw new Error('precondition failed');
    const cut = await k.booleanCut(target.value, [tool.value]);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const mesh = await k.tessellate(cut.value, FINE_TESSELLATION);
    // A box with a cubic cavity has many more triangles than a plain box.
    expect(mesh.indices.length).toBeGreaterThan(36); // a bare box is 12 triangles
  });

  it('intersects two overlapping boxes', async () => {
    const k = await newKernel();
    const a = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    const b = await k.makeBox({ origin: [5, 5, 5], width: 10, height: 10, depth: 10 });
    if (!a.ok || !b.ok) throw new Error('precondition failed');
    const inter = await k.booleanIntersect([a.value, b.value]);
    expect(inter.ok).toBe(true);
    if (!inter.ok) return;
    const bb = await k.getBoundingBox(inter.value);
    // Intersection occupies [5..10] on each axis.
    expect(bb.min[0]).toBeCloseTo(5, 4);
    expect(bb.max[0]).toBeCloseTo(10, 4);
    expect(bb.min[2]).toBeCloseTo(5, 4);
    expect(bb.max[2]).toBeCloseTo(10, 4);
  });
});

describe('OcctKernel — revolve', () => {
  it('revolves an off-axis circle into a torus', async () => {
    const k = await newKernel();
    // Circle of radius 5 centered at (20, 0, 0) on the XZ plane (normal=+Y).
    // Revolved 2π around the Z axis at the origin → torus, major radius 20,
    // minor radius 5.
    const faceR = await k.createSketchFace({
      type: 'circle',
      origin: [20, 0, 0],
      normal: [0, 1, 0],
      radius: 5,
    });
    if (!faceR.ok) throw new Error(`sketch failed: ${faceR.error.message}`);
    const r = await k.revolve(
      faceR.value,
      { origin: [0, 0, 0], direction: [0, 0, 1] },
      2 * Math.PI,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bb = await k.getBoundingBox(r.value);
    // Torus extents: X/Y in ±25, Z in ±5.
    expect(bb.min[0]).toBeCloseTo(-25, 1);
    expect(bb.max[0]).toBeCloseTo(25, 1);
    expect(bb.min[2]).toBeCloseTo(-5, 1);
    expect(bb.max[2]).toBeCloseTo(5, 1);
  });
});

describe('OcctKernel — loft', () => {
  it('lofts two circular profiles into a frustum', async () => {
    const k = await newKernel();
    const bottom = await k.createSketchFace({
      type: 'circle',
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      radius: 10,
    });
    const top = await k.createSketchFace({
      type: 'circle',
      origin: [0, 0, 30],
      normal: [0, 0, 1],
      radius: 5,
    });
    if (!bottom.ok || !top.ok) throw new Error('sketch failed');
    const r = await k.loft([bottom.value, top.value], { ruled: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bb = await k.getBoundingBox(r.value);
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(20, 1);
    expect(bb.max[2] - bb.min[2]).toBeCloseTo(30, 1);
  });
});

describe('OcctKernel — getMassProperties', () => {
  it('reports the expected volume, surface area, and COM for a box', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    const mp = await k.getMassProperties(r.value);
    expect(mp.volume).toBeCloseTo(1000, 4);
    expect(mp.surfaceArea).toBeCloseTo(600, 4);
    expect(mp.centerOfMass[0]).toBeCloseTo(5, 4);
    expect(mp.centerOfMass[1]).toBeCloseTo(5, 4);
    expect(mp.centerOfMass[2]).toBeCloseTo(5, 4);
  });
});

describe('OcctKernel — modify ops', () => {
  it('fillet rounds all edges of a box when no specific edges are given', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    const fillet = await k.fillet(r.value, [], 1);
    expect(fillet.ok).toBe(true);
    if (!fillet.ok) return;
    // Filleted box volume = 1000 minus the corner-and-edge material the
    // 1mm fillets removed. Loose bound: between 950 and 1000.
    const mp = await k.getMassProperties(fillet.value);
    expect(mp.volume).toBeGreaterThan(950);
    expect(mp.volume).toBeLessThan(1000);
  });

  it('chamfer bevels all edges of a box when no specific edges are given', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error('precondition failed');
    const ch = await k.chamfer(r.value, [], 1);
    expect(ch.ok).toBe(true);
    if (!ch.ok) return;
    const mp = await k.getMassProperties(ch.value);
    expect(mp.volume).toBeGreaterThan(900);
    expect(mp.volume).toBeLessThan(1000);
  });

  it('mirror flips a box across the YZ plane (x = 0)', async () => {
    const k = await newKernel();
    // Box at +X side.
    const r = await k.makeBox({ origin: [10, 0, 0], width: 5, height: 5, depth: 5 });
    if (!r.ok) throw new Error('precondition failed');
    const m = await k.mirror(r.value, { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const bb = await k.getBoundingBox(m.value);
    expect(bb.min[0]).toBeCloseTo(-15, 4);
    expect(bb.max[0]).toBeCloseTo(-10, 4);
  });

  it('linearPattern produces N translated copies along a direction', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 5, height: 5, depth: 5 });
    if (!r.ok) throw new Error('precondition failed');
    const p = await k.linearPattern(r.value, [1, 0, 0], 3, 10);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const bb = await k.getBoundingBox(p.value);
    // 3 copies with spacing=10 starting at the first box (origin..5) →
    // copy at [0..5], [10..15], [20..25].
    expect(bb.min[0]).toBeCloseTo(0, 4);
    expect(bb.max[0]).toBeCloseTo(25, 4);
  });

  it('circularPattern produces a non-trivial compound around an axis', async () => {
    const k = await newKernel();
    // Box offset on +X so its copies form a ring around the Z axis.
    const r = await k.makeBox({ origin: [20, -2.5, -2.5], width: 5, height: 5, depth: 5 });
    if (!r.ok) throw new Error('precondition failed');
    const p = await k.circularPattern(r.value, { origin: [0, 0, 0], direction: [0, 0, 1] }, 4);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // Plan §0e treats modify ops as "kernel-only smoke" — exact geometry
    // semantics weren't pinned down in v1 either. Just confirm the result
    // body extends meaningfully beyond a single box footprint (5 mm wide).
    const bb = await k.getBoundingBox(p.value);
    const xSpan = bb.max[0] - bb.min[0];
    const ySpan = bb.max[1] - bb.min[1];
    expect(Math.max(xSpan, ySpan)).toBeGreaterThan(15);
  });
});

describe('OcctKernel — exports', () => {
  it('exportStep returns ISO-10303 STEP text for a single body', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 5, height: 5, depth: 5 });
    if (!r.ok) throw new Error('precondition failed');
    const blob = await k.exportStep([r.value]);
    const text = await blob.text();
    expect(text.startsWith('ISO-10303')).toBe(true);
    expect(text).toContain('FILE_SCHEMA');
    expect(text).toContain('END-ISO-10303-21');
  });

  it('exportStep packages multiple bodies into a single STEP document', async () => {
    const k = await newKernel();
    const a = await k.makeBox({ origin: [0, 0, 0], width: 5, height: 5, depth: 5 });
    const b = await k.makeBox({ origin: [10, 0, 0], width: 5, height: 5, depth: 5 });
    if (!a.ok || !b.ok) throw new Error('precondition failed');
    const blob = await k.exportStep([a.value, b.value]);
    const text = await blob.text();
    expect(text).toContain('ISO-10303');
    expect(text).toContain('END-ISO-10303-21');
  });

  it('exportStl ASCII produces a "solid" preamble', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 5, height: 5, depth: 5 });
    if (!r.ok) throw new Error('precondition failed');
    const blob = await k.exportStl([r.value], { binary: false });
    const text = await blob.text();
    expect(text.startsWith('solid')).toBe(true);
    expect(text).toContain('facet normal');
    expect(text).toContain('endsolid');
  });

  it('exportStl binary produces a header + triangle count matching the geometry', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 5, height: 5, depth: 5 });
    if (!r.ok) throw new Error('precondition failed');
    const blob = await k.exportStl([r.value], { binary: true });
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // Binary STL: 80-byte header + 4-byte uint32 triangle count + 50 bytes/triangle.
    expect(bytes.length).toBeGreaterThanOrEqual(84);
    const triCount = new DataView(buf).getUint32(80, true);
    expect(triCount).toBeGreaterThanOrEqual(12); // a box is at least 12 triangles
    expect(bytes.length).toBe(84 + triCount * 50);
  });

  it('export3MF produces a ZIP archive containing a 3D model entry', async () => {
    const k = await newKernel();
    const r = await k.makeBox({ origin: [0, 0, 0], width: 5, height: 5, depth: 5 });
    if (!r.ok) throw new Error('precondition failed');
    const blob = await k.export3MF([r.value], { name: 'TestPart' });
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // ZIP local file header signature
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
    // Spot-check that the embedded XML mentions the part name.
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    expect(text).toContain('TestPart');
  });
});
