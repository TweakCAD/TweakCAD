/**
 * An assembly exported as STEP keeps its tree: one product per part, placed
 * once per instance, so a part used twice is stored once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { Docs } from '../assemblyDocs';
import { EvaluationService } from './service';

let k: OcctKernel;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  service = new EvaluationService(k);
});
afterAll(() => {
  service.release();
  k.releaseAll();
});

describe('STEP export of an assembly', { timeout: 60_000 }, () => {
  it('writes one product per part and one placed occurrence per instance', () => {
    const d = new Docs();
    const base = d.part('Base');
    base.box('40 mm', '40 mm', '10 mm');
    const pin = d.part('Pin');
    pin.box('4 mm', '4 mm', '20 mm');
    const a = d.assembly('Fixture');
    a.instance({ part: { id: base.id } }, { grounded: true });
    a.instance({ part: { id: pin.id } }, { at: [10, 10, 10], grounded: true });
    a.instance({ part: { id: pin.id } }, { at: [-10, 10, 10], turnZ: 45, grounded: true });
    const display = service.evaluate(d.document({ assembly: { id: a.id } }));
    expect(display.pauses).toEqual([]);

    const step = new TextDecoder().decode(service.exportFile('step', { assembly: a.id }));
    const xcaf = k.importXCAFFromSTEP(step);
    try {
      const [root] = xcaf.getRoots();
      expect(xcaf.getLabelInfo(root as number).name).toBe('Fixture');
      const children = xcaf.getChildren(root as number);
      expect(children.map((c) => xcaf.getLabelInfo(c).name)).toEqual(['Base (1)', 'Pin (2)', 'Pin (3)']);
      const prototypes = children.map((c) => xcaf.getReferredLabel(c));
      expect(prototypes[1]).toBe(prototypes[2]);
      expect(prototypes[0]).not.toBe(prototypes[1]);
      expect(xcaf.getLabelInfo(prototypes[1] as number).name).toBe('Pin');
      const at = xcaf.getLocation(children[2] as number);
      expect([at[3], at[7], at[11]].map((v) => Math.round(v as number))).toEqual([-10, 10, 10]);
    } finally {
      xcaf.close();
    }
    // The pin's solid is written once.
    expect(step.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(2);
    const whole = k.importStep(step);
    expect(k.getVolume(whole)).toBeCloseTo(40 * 40 * 10 + 2 * 4 * 4 * 20, 6);
    k.release(whole);
  });
});
