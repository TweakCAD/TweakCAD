/**
 * Body colours in STEP and 3MF export, against the real occt-wasm kernel.
 *
 * STEP: colours go through an XCAF document. Reading the file back into
 * one gives each root part's colour, which is the check that matters: the
 * colour has to survive a STEP reader, not just appear in the text.
 */
import { describe, expect, it } from 'vitest';
import { OcctKernel } from './occtKernel.ts';
import type { KernelBody } from './types.ts';
import type { OcctKernel as UpstreamKernel } from 'occt-wasm';

async function twoBoxes(): Promise<{ kernel: OcctKernel; bodies: KernelBody[] }> {
  const kernel = new OcctKernel();
  await kernel.init();
  const bodies: KernelBody[] = [];
  for (const origin of [[0, 0, 0], [30, 0, 0]] as [number, number, number][]) {
    const r = await kernel.makeBox({ origin, width: 10, height: 10, depth: 10 });
    if (!r.ok) throw new Error(r.error.message);
    bodies.push(r.value);
  }
  return { kernel, bodies };
}

/** Raw occt-wasm kernel, for reading the exported STEP back through XCAF. */
function raw(kernel: OcctKernel) {
  return (kernel as unknown as { getKernel(): UpstreamKernel }).getKernel();
}

describe('STEP export with body colours', () => {
  it('writes each body as a part with its colour, and leaves an uncoloured body uncoloured', async () => {
    const { kernel, bodies } = await twoBoxes();
    const blob = await kernel.exportStep(bodies, { colors: ['#ff0000', undefined] });
    const text = await blob.text();

    const doc = raw(kernel).importXCAFFromSTEP(text);
    try {
      const roots = doc.getRoots();
      expect(roots).toHaveLength(2);
      const colors = roots.map(r => doc.getLabelInfo(r)).map(i => i.hasColor ? i.color : null);
      const red = colors.find(c => c !== null);
      expect(red?.[0]).toBeCloseTo(1, 2);
      expect(red?.[1]).toBeCloseTo(0, 2);
      expect(red?.[2]).toBeCloseTo(0, 2);
      expect(colors.filter(c => c === null)).toHaveLength(1);
    } finally {
      doc.close();
    }
  });

  it('writes the plain compound when no body has a colour', async () => {
    const { kernel, bodies } = await twoBoxes();
    const text = await (await kernel.exportStep(bodies, { colors: [undefined, undefined] })).text();
    expect(text).not.toContain('COLOUR_RGB');
    const plain = await (await kernel.exportStep(bodies)).text();
    // Same structure either way: one shape, no styling entities.
    expect(text.split('\n').length).toBe(plain.split('\n').length);
  });
});

/**
 * Each mesh object in a 3MF model, with its triangles as vertex-index
 * triples. Objects without a mesh (the parent holding components) are left out.
 */
function meshObjects(model: string): { id: string; pid: string | null; triangles: [number, number, number][] }[] {
  const out: { id: string; pid: string | null; triangles: [number, number, number][] }[] = [];
  for (const m of model.matchAll(/<object id="(\d+)"([^>]*)>([\s\S]*?)<\/object>/g)) {
    const body = m[3] ?? '';
    if (!body.includes('<mesh>')) continue;
    const triangles = [...body.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)]
      .map(t => [Number(t[1]), Number(t[2]), Number(t[3])] as [number, number, number]);
    out.push({ id: m[1] ?? '', pid: /pid="(\d+)"/.exec(m[2] ?? '')?.[1] ?? null, triangles });
  }
  return out;
}

/** Edges used by other than exactly two triangles: zero for a closed mesh. */
function openEdges(triangles: [number, number, number][]): number {
  const uses = new Map<string, number>();
  for (const [a, b, c] of triangles) {
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const key = u < v ? `${u}-${v}` : `${v}-${u}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return [...uses.values()].filter(n => n !== 2).length;
}

async function boxAndCylinder(): Promise<{ kernel: OcctKernel; bodies: KernelBody[] }> {
  const kernel = new OcctKernel();
  await kernel.init();
  const box = await kernel.makeBox({ origin: [0, 0, 0], width: 30, height: 30, depth: 10 });
  const cyl = await kernel.makeCylinder({ center: [15, 15, 10], axis: [0, 0, 1], radius: 8, height: 12 });
  if (!box.ok || !cyl.ok) throw new Error('could not make the test bodies');
  return { kernel, bodies: [box.value, cyl.value] };
}

async function modelText(blob: Blob): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
}

describe('3MF export', () => {
  it('writes closed meshes', async () => {
    const { kernel, bodies } = await boxAndCylinder();
    const [plain] = meshObjects(await modelText(await kernel.export3MF(bodies)));
    expect(plain?.triangles.length).toBeGreaterThan(0);
    // Two separate closed bodies in one mesh: still no open edge.
    expect(openEdges(plain?.triangles ?? [])).toBe(0);
  });

  it('writes each coloured body as its own closed, coloured mesh object', async () => {
    const { kernel, bodies } = await boxAndCylinder();
    const text = await modelText(await kernel.export3MF(bodies, { name: 'Two', colors: ['#00ff00', '#0000ff'] }));
    expect(text).toContain('<m:color color="#00FF00" />');
    expect(text).toContain('<m:color color="#0000FF" />');
    const objects = meshObjects(text);
    expect(objects.map(o => o.pid)).toEqual(['1', '2']);
    for (const o of objects) expect(openEdges(o.triangles)).toBe(0);
    // A box is 12 triangles once its faces share their edges.
    expect(objects[0]?.triangles).toHaveLength(12);
    expect(text).toContain('<metadata key="extruder" value="2"/>');
  });
});
