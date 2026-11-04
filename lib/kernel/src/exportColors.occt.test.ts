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

describe('3MF export with body colours', () => {
  it('colours every triangle of each body', async () => {
    const { kernel, bodies } = await twoBoxes();
    const blob = await kernel.export3MF(bodies, { name: 'Two', colors: ['#00ff00', '#0000ff'] });
    const text = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
    expect(text).toContain('<m:color color="#00FF00" />');
    expect(text).toContain('<m:color color="#0000FF" />');
    const tris = text.match(/<triangle [^>]*>/g) ?? [];
    expect(tris.length).toBeGreaterThan(0);
    expect(tris.every(t => / pid="1" p1="[01]"/.test(t))).toBe(true);
    // Two boxes of 12 triangles each, one colour per box.
    expect(tris.filter(t => t.includes('p1="0"'))).toHaveLength(tris.length / 2);
  });
});
