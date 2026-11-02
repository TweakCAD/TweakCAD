/**
 * Multi-tool booleans against the real occt-wasm kernel.
 *
 * `*WithHistory` is binary, so fuse, cut and intersect fold their inputs
 * pairwise. Each step's result is consumed by the next step; once it has
 * been, the kernel disposes it. These tests check that only the inputs and
 * the final result stay in the body arena, and that disposing the
 * intermediates leaves the result's stable face IDs as they were when the
 * intermediates were kept.
 *
 * Layout: a 20 mm cube at the origin and three 30 mm cubes, each offset to
 * +2 on one axis and −5 on the other two, so every tool overlaps the cube
 * and all the others. Fuse, cut and intersect all give a non-empty solid.
 */
import { describe, expect, it, vi } from 'vitest';
import { OcctKernel } from './occtKernel.ts';
import type { KernelBody } from './types.ts';

type Op = 'fuse' | 'cut' | 'intersect';

async function setup(): Promise<{ kernel: OcctKernel; inputs: KernelBody[] }> {
  const kernel = new OcctKernel();
  await kernel.init();
  const specs: Array<{ origin: [number, number, number]; size: number }> = [
    { origin: [0, 0, 0], size: 20 },
    { origin: [2, -5, -5], size: 30 },
    { origin: [-5, 2, -5], size: 30 },
    { origin: [-5, -5, 2], size: 30 },
  ];
  const inputs: KernelBody[] = [];
  for (const { origin, size } of specs) {
    const r = await kernel.makeBox({ origin, width: size, height: size, depth: size });
    if (!r.ok) throw new Error(r.error.message);
    inputs.push(r.value);
  }
  return { kernel, inputs };
}

async function run(kernel: OcctKernel, op: Op, inputs: KernelBody[]): Promise<KernelBody> {
  const [first, ...rest] = inputs;
  const r = op === 'fuse'
    ? await kernel.booleanFuse(inputs)
    : op === 'cut'
      ? await kernel.booleanCut(first!, rest)
      : await kernel.booleanIntersect(inputs);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

async function stableFaceIds(kernel: OcctKernel, body: KernelBody): Promise<(string | undefined)[]> {
  const topo = await kernel.getTopology(body);
  return topo.faces.map(f => f.stableFaceId);
}

function arenaSize(kernel: OcctKernel): number {
  return (kernel as unknown as { bodies: Map<string, unknown> }).bodies.size;
}

describe.each<Op>(['fuse', 'cut', 'intersect'])('OcctKernel — %s of four bodies', op => {
  it('disposes every intermediate and keeps the inputs and the result', async () => {
    const { kernel, inputs } = await setup();
    const disposeSpy = vi.spyOn(kernel, 'dispose');

    const result = await run(kernel, op, inputs);

    const disposed = disposeSpy.mock.calls.map(([h]) => h.handle);
    expect(disposed).toHaveLength(inputs.length - 2);
    const kept = new Set([...inputs, result].map(b => b.handle));
    expect(disposed.some(h => kept.has(h))).toBe(false);
    for (const handle of disposed) {
      await expect(kernel.getTopology({ handle, source: op })).rejects.toThrow('Unknown kernel body handle');
    }
    expect(arenaSize(kernel)).toBe(inputs.length + 1);
    for (const body of [...inputs, result]) {
      await expect(kernel.getTopology(body)).resolves.toBeDefined();
    }
  });

  it('gives the result the same stable face IDs as when intermediates are kept', async () => {
    const { kernel, inputs } = await setup();

    const disposeSpy = vi.spyOn(kernel, 'dispose').mockImplementation(() => {});
    const keptResult = await run(kernel, op, inputs);
    disposeSpy.mockRestore();
    const keptIds = await stableFaceIds(kernel, keptResult);

    const result = await run(kernel, op, inputs);
    const ids = await stableFaceIds(kernel, result);

    expect(ids.every(id => id !== undefined)).toBe(true);
    expect(ids).toEqual(keptIds);
  });
});
