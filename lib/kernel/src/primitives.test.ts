/**
 * Sphere and torus against real OCCT.
 *
 * Both are new passthroughs to occt-wasm, so these check the two things a
 * thin wrapper can still get wrong: that the shape has the volume its
 * parameters imply (the arguments reached the kernel in the right order and
 * meaning), and that it ends up where it was asked to be.
 *
 * Volume is the assertion rather than face count because it is sensitive to
 * every parameter at once. A torus built with major and minor radii swapped
 * has the same topology and a very different volume.
 */
import { describe, expect, it } from 'vitest';
import { OcctKernel } from './occtKernel.ts';

async function newKernel(): Promise<OcctKernel> {
  const k = new OcctKernel();
  await k.init();
  return k;
}

const TAU = Math.PI * 2;

/** Volume of a body. `getMassProperties` is optional on the interface but
 *  implemented by OcctKernel, which is what these tests exercise. */
async function volumeOf(k: OcctKernel, body: Parameters<OcctKernel['getBoundingBox']>[0]): Promise<number> {
  const mp = await k.getMassProperties!(body);
  return mp.volume;
}

/** Extent of a body along one axis. */
async function extentOf(k: OcctKernel, body: Parameters<OcctKernel['getBoundingBox']>[0], i: number): Promise<number> {
  const bb = await k.getBoundingBox(body);
  return bb.max[i]! - bb.min[i]!;
}

describe('makeBox', () => {
  it('maps width/height/depth to X/Y/Z from the origin corner', async () => {
    // Nothing pinned this before — every other box test uses a cube, so a
    // transposed mapping would have gone unnoticed until a user typed three
    // different numbers. The primitive builder relies on it.
    const k = await newKernel();
    const r = await k.makeBox({ origin: [1, 2, 3], width: 10, height: 20, depth: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bb = await k.getBoundingBox(r.value);
    expect(bb.min).toEqual([1, 2, 3].map(n => expect.closeTo(n, 4)));
    expect(bb.max).toEqual([11, 22, 33].map(n => expect.closeTo(n, 4)));
  });
});

describe('makeSphere', () => {
  it('builds a sphere of the requested radius', async () => {
    const k = await newKernel();
    const r = await k.makeSphere({ center: [0, 0, 0], radius: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 4/3 π r³ = 523.598…
    expect(await volumeOf(k, r.value)).toBeCloseTo((4 / 3) * Math.PI * 125, 2);
  });

  it('places the sphere at its centre', async () => {
    const k = await newKernel();
    const r = await k.makeSphere({ center: [10, -4, 2], radius: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bbox = await k.getBoundingBox(r.value);
    const mid = (i: number) => (bbox.min[i]! + bbox.max[i]!) / 2;
    expect(mid(0)).toBeCloseTo(10, 4);
    expect(mid(1)).toBeCloseTo(-4, 4);
    expect(mid(2)).toBeCloseTo(2, 4);
  });

  it('rejects a non-positive radius instead of asking OCCT', async () => {
    const k = await newKernel();
    for (const radius of [0, -1]) {
      const r = await k.makeSphere({ center: [0, 0, 0], radius });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('INVALID_RADIUS');
    }
  });
});

describe('makeTorus', () => {
  it('builds a torus with the requested radii', async () => {
    const k = await newKernel();
    const r = await k.makeTorus({
      center: [0, 0, 0], axis: [0, 0, 1], majorRadius: 10, minorRadius: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 2π²Rr² = 2 · π² · 10 · 4
    expect(await volumeOf(k, r.value)).toBeCloseTo(TAU * Math.PI * 10 * 4, 1);
  });

  it('does not silently swap major and minor', async () => {
    // Same topology either way round, very different solid — which is why
    // volume is the assertion and face count is not.
    const k = await newKernel();
    const a = await k.makeTorus({ center: [0, 0, 0], axis: [0, 0, 1], majorRadius: 10, minorRadius: 2 });
    const b = await k.makeTorus({ center: [0, 0, 0], axis: [0, 0, 1], majorRadius: 8, minorRadius: 3 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(await volumeOf(k, a.value)).not.toBeCloseTo(await volumeOf(k, b.value), 1);
    expect(await volumeOf(k, b.value)).toBeCloseTo(TAU * Math.PI * 8 * 9, 1);
  });

  it('orients the ring to its axis', async () => {
    // About +Z the ring is wide in X/Y and thin in Z; about +X that swaps.
    // Catches a transform that was built but never applied.
    const k = await newKernel();
    const spec = { center: [0, 0, 0] as [number, number, number], majorRadius: 10, minorRadius: 2 };
    const flat = await k.makeTorus({ ...spec, axis: [0, 0, 1] });
    const upright = await k.makeTorus({ ...spec, axis: [1, 0, 0] });
    expect(flat.ok && upright.ok).toBe(true);
    if (!flat.ok || !upright.ok) return;

    // Thin axis is Z when flat, X when upright.
    expect(await extentOf(k, flat.value, 2)).toBeCloseTo(4, 2);
    expect(await extentOf(k, flat.value, 0)).toBeCloseTo(24, 2);
    expect(await extentOf(k, upright.value, 0)).toBeCloseTo(4, 2);
    expect(await extentOf(k, upright.value, 2)).toBeCloseTo(24, 2);
  });

  it('rejects a tube that would pass through itself', async () => {
    // OCCT builds this and the failure only surfaces later, inside a
    // boolean, naming neither the torus nor the reason.
    const k = await newKernel();
    for (const minorRadius of [5, 8]) {
      const r = await k.makeTorus({
        center: [0, 0, 0], axis: [0, 0, 1], majorRadius: 5, minorRadius,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('TORUS_SELF_INTERSECTS');
    }
  });

  it('rejects a zero axis', async () => {
    const k = await newKernel();
    const r = await k.makeTorus({
      center: [0, 0, 0], axis: [0, 0, 0], majorRadius: 10, minorRadius: 2,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('ZERO_AXIS');
  });
});
