import { describe, expect, it } from 'vitest';
import { base32Encode } from '../base32';
import { ValueEvaluator, ValuePause } from './values';

type Json = Record<string, unknown>;
const id = (kind: string, n: number) => `${kind}_${base32Encode(new Uint8Array(16).fill(n))}`;
const LENGTH = { type: 'number', quantity: 'length' } as const;
const val = (n: number, text: string, refs: Json = {}): Json => ({
  id: id('val', n),
  def: { expr: { text, grammar: 1, refs } },
});

function doc(parts: Json[], parameters: Json[] = []): Json {
  return { parameters: [{ id: id('tbl', 1), name: 'T', parameters }], parts, assemblies: [] };
}

const param = (n: number, name: string, value: Json, extra: Json = {}): Json => ({
  id: id('par', n),
  name,
  type: 'number',
  quantity: 'length',
  value,
  ...extra,
});

describe('ValueEvaluator', () => {
  it('evaluates parameters and the values that use them, in base units', () => {
    const width = param(1, 'width', val(1, '2 cm'));
    const feature = { inputs: { d: val(2, 'width * 2 + 1 mm', { width: { parameter: { id: id('par', 1) } } }) } };
    const v = new ValueEvaluator(doc([{ timeline: [feature], configurations: [] }], [width]));
    expect(v.number(feature.inputs.d, LENGTH)).toBe(41);
  });

  it('applies the selected configuration row', () => {
    const size = param(1, 'size', val(1, '"large"'), {
      type: 'choice',
      options: ['small', 'large'],
      quantity: undefined,
    });
    const d = val(2, '10 mm');
    const config = {
      input: { id: id('par', 1) },
      rows: [
        { option: { equals: { literal: 'small' } }, overrides: [] },
        {
          option: { equals: { literal: 'large' } },
          overrides: [
            { value: { target: { value: { id: d.id } }, def: { expr: { text: '30 mm', grammar: 1, refs: {} } } } },
          ],
        },
      ],
    };
    const v = new ValueEvaluator(doc([{ timeline: [{ inputs: { d } }], configurations: [config] }], [size]));
    expect(v.number(d, LENGTH)).toBe(30);
  });

  it('pauses a value of the wrong quantity or a cycle, rather than guessing', () => {
    const a = val(1, '3 deg');
    expect(() =>
      new ValueEvaluator(doc([{ timeline: [{ inputs: { a } }], configurations: [] }])).number(a, LENGTH),
    ).toThrow(ValuePause);
    const x = val(2, 'y', { y: { value: { id: id('val', 3) } } });
    const y = val(3, 'x', { x: { value: { id: id('val', 2) } } });
    const v = new ValueEvaluator(doc([{ timeline: [{ inputs: { x, y } }], configurations: [] }]));
    expect(() => v.number(x, LENGTH)).toThrow(/cycle/);
  });

  it('gives a measured value the result it is supplied, and pauses its users until then or when withheld', () => {
    const m = { id: id('val', 1), name: 'gap', def: { measure: { kind: 'distance', of: [] } } };
    const d = val(2, 'gap * 2', { gap: { value: { id: m.id } } });
    const v = new ValueEvaluator(
      doc([{ timeline: [{ inputs: { values: [m] } }, { inputs: { d } }], configurations: [] }]),
    );
    expect(v.definition(m.id)).toEqual(m.def);
    expect(() => v.number(d, LENGTH)).toThrow(/not measured yet/);
    v.withhold(m.id, 'a measured entity is gone');
    expect(() => v.number(d, LENGTH)).toThrow('a measured entity is gone');
    v.supply(m.id, { kind: 'scalar', dim: [1, 0, 0, 0], value: 7 });
    expect(v.number(d, LENGTH)).toBe(14);
    expect(v.targetOf(d.id as string)).toEqual(LENGTH);
  });

  describe('a configuration input with no row', () => {
    const count = param(1, 'count', val(1, '2'), { type: 'integer', quantity: undefined });
    const width = val(2, '10 mm');
    const flag = val(3, 'false');
    const other = val(4, '5 mm');
    const feature = { id: id('feat', 1), suppressed: flag, inputs: { width, other } };
    const config = {
      id: id('cfg', 1),
      input: { id: id('par', 1) },
      rows: [
        {
          option: { equals: { literal: 1 } },
          overrides: [
            { value: { target: { value: { id: width.id } }, def: { expr: { text: '20 mm', grammar: 1, refs: {} } } } },
            { input: { feature: { id: feature.id }, pointer: '/extent', with: { throughAll: {} } } },
          ],
        },
      ],
    };
    const evaluator = () => new ValueEvaluator(doc([{ timeline: [feature], configurations: [config] }], [count]));

    it('pauses the values any row overrides instead of building the base design', () => {
      const v = evaluator();
      expect(() => v.number(width, LENGTH)).toThrow(/has no row for 2/);
      expect(v.number(other, LENGTH)).toBe(5);
      expect(v.inputOverrides).toEqual([]);
    });

    it('pauses a feature an input override of any row targets, at its suppressed flag', () => {
      expect(() => evaluator().literal(flag, { type: 'boolean' })).toThrow(ValuePause);
    });

    it('leaves a target a host inserts alone', () => {
      const v = new ValueEvaluator(
        doc([{ timeline: [feature], configurations: [config] }], [count]),
        new Map([[width.id as string, { kind: 'scalar', dim: [1, 0, 0, 0], value: 7 }]]),
      );
      expect(v.number(width, LENGTH)).toBe(7);
    });

    it('pauses when the input itself does not evaluate', () => {
      const broken = param(1, 'count', val(1, '2 mm'), { type: 'integer', quantity: undefined });
      const v = new ValueEvaluator(doc([{ timeline: [feature], configurations: [config] }], [broken]));
      expect(() => v.number(width, LENGTH)).toThrow(/does not evaluate/);
    });
  });

  describe('a parameter range', () => {
    const ranged = (text: string) =>
      param(1, 'width', val(1, text), { range: { between: { min: val(2, '1 mm'), max: val(3, '10 mm') } } });
    const user = val(4, 'width', { width: { parameter: { id: id('par', 1) } } });
    const build = (p: Json, insertion = new Map()) =>
      new ValueEvaluator(doc([{ timeline: [{ inputs: { user } }], configurations: [] }], [p]), insertion);

    it('holds the bounds inclusively', () => {
      expect(build(ranged('10 mm')).number(user, LENGTH)).toBe(10);
      expect(build(ranged('1 mm')).parameter(id('par', 1))).toMatchObject({ value: 1 });
    });

    it('pauses a value outside it, never clamping', () => {
      expect(() => build(ranged('20 mm')).number(user, LENGTH)).toThrow(/outside its range/);
      expect(() => build(ranged('20 mm')).parameter(id('par', 1))).toThrow(ValuePause);
      expect(() => build(ranged('20 mm')).value(id('val', 1))).toThrow(/outside its range/);
    });

    it('checks a host insertion too', () => {
      const v = build(ranged('5 mm'), new Map([[id('par', 1), { kind: 'scalar', dim: [1, 0, 0, 0], value: 0.5 }]]));
      expect(() => v.number(user, LENGTH)).toThrow(/outside its range/);
    });
  });

  it('reads lookup tables from inline CSV assets', () => {
    const csv = 'size,width[mm]\nM6,12\n';
    const asset = 'A'.repeat(52);
    const d = val(1, 'lookup(sizes, "M6", "width")', { sizes: { table: { asset } } });
    const assets = {
      [asset]: { mediaType: 'text/csv', name: 'sizes.csv', size: csv.length, data: { inline: { base64: btoa(csv) } } },
    };
    const v = new ValueEvaluator({ ...doc([{ timeline: [{ inputs: { d } }], configurations: [] }]), assets });
    expect(v.number(d, LENGTH)).toBe(12);
    const external = { [asset]: { ...assets[asset], data: { external: {} } } };
    const w = new ValueEvaluator({ ...doc([{ timeline: [{ inputs: { d } }], configurations: [] }]), assets: external });
    expect(() => w.number(d, LENGTH)).toThrow(/not loaded/);
  });

  it('reads published values through the host hook, and pauses without one', () => {
    const d = val(1, 'w * 2', { w: { published: { instance: { path: [] }, id: id('par', 9) } } });
    const parts = [{ timeline: [{ inputs: { d } }], configurations: [] }];
    expect(() => new ValueEvaluator(doc(parts)).number(d, LENGTH)).toThrow(ValuePause);
    const v = new ValueEvaluator(doc(parts), new Map(), {
      published: () => ({ kind: 'scalar', dim: [1, 0, 0, 0], value: 3 }),
    });
    expect(v.number(d, LENGTH)).toBe(6);
  });
});
