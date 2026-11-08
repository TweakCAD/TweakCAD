import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../canonical';
import { ExprError, type ExprErrorKind } from './errors';
import { checkTypes, evaluateExpression, type EvaluationContext } from './evaluate';
import { compileExpression, type ExprRef } from './expression';
import { parseLookupTable } from './lookup';
import { fromStored, typeOfTarget, type ValueTarget } from './stored';
import { scalarValue, type ExprValue } from './values';

interface Binding {
  target: ValueTarget;
  literal: JsonValue;
}

const BINDINGS: Record<string, Binding> = {
  len: { target: { type: 'number', quantity: 'length' }, literal: 10 },
  zero: { target: { type: 'number', quantity: 'length' }, literal: 0 },
  mass: { target: { type: 'number', quantity: 'mass' }, literal: 2 },
  rho: { target: { type: 'number', quantity: 'density' }, literal: 7.85 },
  force: { target: { type: 'number', quantity: 'force' }, literal: 3 },
  count: { target: { type: 'integer' }, literal: 4 },
  yes: { target: { type: 'boolean' }, literal: true },
  no: { target: { type: 'boolean' }, literal: false },
  label: { target: { type: 'text' }, literal: 'M6' },
  v: { target: { type: 'vector', quantity: 'length' }, literal: [1, 2, 3] },
  w: { target: { type: 'vector', quantity: 'length' }, literal: [4, 5, 6] },
  f: { target: { type: 'vector', quantity: 'force' }, literal: [1, 0, 0] },
};

const TABLE = 'sha256:table';

function refsFor(text: string): Record<string, ExprRef> {
  const refs: Record<string, ExprRef> = {};
  for (const name of Object.keys(BINDINGS)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) refs[name] = { parameter: { id: `par_${name}` } };
  }
  if (/\bbolts\b/.test(text)) refs.bolts = { table: { asset: TABLE } };
  if (/\bsteel\b/.test(text)) refs.steel = { library: { id: 'lib_steel' } };
  if (/\bbrass\b/.test(text)) refs.brass = { library: { id: 'lib_brass' } };
  return refs;
}

function context(extra: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    read(name) {
      const binding = BINDINGS[name];
      if (binding === undefined) throw new Error(`read ${name}`);
      return fromStored(binding.literal, binding.target);
    },
    typeOf: (name) => {
      const binding = BINDINGS[name];
      return binding === undefined ? undefined : typeOfTarget(binding.target);
    },
    table: () => parseLookupTable('size,pitch[mm],note\r\nM6,1,coarse\r\nM8,1.25,coarse\r\n'),
    ...extra,
  };
}

function run(text: string, extra?: Partial<EvaluationContext>): ExprValue {
  return evaluateExpression(compileExpression({ text, grammar: 1, refs: refsFor(text) }), context(extra));
}

function number(text: string, extra?: Partial<EvaluationContext>): number {
  const result = run(text, extra);
  if (result.kind !== 'scalar') throw new Error(`${text} gave ${result.kind}`);
  return result.value;
}

function dimension(text: string): readonly number[] {
  const result = run(text);
  if (result.kind !== 'scalar' && result.kind !== 'vector') throw new Error(`${text} gave ${result.kind}`);
  return result.dim;
}

function truth(text: string): boolean {
  const result = run(text);
  if (result.kind !== 'boolean') throw new Error(`${text} gave ${result.kind}`);
  return result.value;
}

function expectError(kind: ExprErrorKind, text: string, extra?: Partial<EvaluationContext>): void {
  try {
    run(text, extra);
  } catch (e) {
    expect(e, text).toBeInstanceOf(ExprError);
    expect((e as ExprError).kind, `${text}: ${(e as Error).message}`).toBe(kind);
    return;
  }
  expect.unreachable(`expected ${text} to give a ${kind} error`);
}

function captured(body: () => unknown): ExprError {
  try {
    body();
  } catch (e) {
    expect(e).toBeInstanceOf(ExprError);
    return e as ExprError;
  }
  return expect.unreachable('expected an error');
}

describe('the examples in the grammar', () => {
  it('follows them exactly', () => {
    expect(number('-2^2')).toBe(-4);
    expect(number('-5 % 3')).toBe(-2);
    expect(number('1 [g/cm^3] * 1000 [mm^3]')).toBe(1e-9 * 1000);
    expect(dimension('1 [g/cm^3] * 1000 [mm^3]')).toEqual([0, 1, 0, 0]);
    expect(number('1000 mm^3')).toBe(1e9);
    expect(number('2 [N/mm]')).toBe(2);
    expect(number('round(2.5 mm / 1 mm) * 1 mm')).toBe(3);
    expect(dimension('round(2.5 mm / 1 mm) * 1 mm')).toEqual([1, 0, 0, 0]);
    expect(number('sin(30 deg)')).toBe(0.5);
    expect(number('tan(45 deg)')).toBe(1);
    expectError('domain', 'tan(90 deg)');
    expect(number('0^0')).toBe(1);
    expectError('domain', '0^-1');
    expectError('domain', '(-8)^0.5');
  });

  it('a ratio cannot join a length', () => {
    expectError('type', '5 mm + 2');
    expectError('type', '2 + 5 mm');
    expectError('type', 'len + 1');
  });
});

describe('quantities', () => {
  it('follows from the operands', () => {
    expect(dimension('2 mm * 3 mm')).toEqual([2, 0, 0, 0]);
    expect(dimension('6 [mm^2] / 3 mm')).toEqual([1, 0, 0, 0]);
    expect(dimension('2 mm / 1 mm')).toEqual([0, 0, 0, 0]);
    expect(dimension('2 kg * 3 m / (1 s * 1 s)')).toEqual([1, 1, -2, 0]);
    expect(dimension('(2 mm)^3')).toEqual([3, 0, 0, 0]);
    expect(dimension('(2 mm)^-2')).toEqual([-2, 0, 0, 0]);
    expect(dimension('(2 mm)^0')).toEqual([0, 0, 0, 0]);
  });

  it('converts literals by one multiplication into base units', () => {
    expect(number('1 cm')).toBe(10);
    expect(number('1 m')).toBe(1000);
    expect(number('1 um')).toBe(0.001);
    expect(number('1 in')).toBe(25.4);
    expect(number('1 ft')).toBe(304.8);
    expect(number('1 deg')).toBe(1);
    expect(number('1 rad')).toBe(57.29577951308232);
    expect(number('1 g')).toBe(1e-6);
    expect(number('1 kg')).toBe(0.001);
    expect(number('1 s')).toBe(1);
    expect(number('1 N')).toBe(1);
    expect(number('1 MPa')).toBe(1);
    expect(number('3 in')).toBe(3 * 25.4);
    expect(number('1 [rad^2]')).toBe(3282.8063500117437);
    expect(number('1 [rad^-1]')).toBe(0.017453292519943295);
  });

  it('reads stored values as they are', () => {
    expect(number('rho')).toBe(7.85);
    expect(number('force')).toBe(3);
    expect(number('len')).toBe(10);
  });

  it('holds masses in t, which are not exact', () => {
    expect(number('1 [g/cm^3] * 1000 [mm^3]')).toBeCloseTo(1e-6, 20);
    expect(number('1 [g/cm^3] * 1000 [mm^3]')).not.toBe(1e-6);
    expect(truth('1 g + 5 g == 6 g')).toBe(false);
    expect(truth('abs(1 g + 5 g - 6 g) < 1e-9 g')).toBe(true);
  });

  it('gives force, pressure and torque in N, MPa and N·mm', () => {
    expect(number('2 kg * 3 m / (1 s * 1 s)')).toBe(6);
    expect(dimension('2 kg * 3 m / (1 s * 1 s)')).toEqual([1, 1, -2, 0]);
    expect(number('10 N / 2 [mm^2]')).toBe(5);
    expect(dimension('10 N / 2 [mm^2]')).toEqual([-1, 1, -2, 0]);
    expect(number('5 N * 2 mm')).toBe(10);
  });

  it('keeps unstorable quantities inside an expression', () => {
    expect(dimension('1 mm * 1 s')).toEqual([1, 0, 1, 0]);
    expect(number('(1 mm * 1 s) / 1 s')).toBe(1);
  });

  it('compares across units of one quantity', () => {
    expect(truth('1 in == 25.4 mm')).toBe(true);
    expect(truth('1 m > 99 cm')).toBe(true);
    expect(truth('1 kg == 1000 g')).toBe(true);
    expect(truth('1 MPa == 1 [N/mm^2]')).toBe(true);
  });
});

describe('arithmetic', () => {
  it('rounds after each operation in IEEE double', () => {
    expect(number('0.1 + 0.2')).toBe(0.30000000000000004);
    expect(number('1 / 3')).toBe(1 / 3);
    expect(number('1 + 1e-16 + 1e-16')).toBe(1);
    expect(number('1 + (1e-16 + 1e-16)')).toBe(1.0000000000000002);
  });

  it('gives zero one sign', () => {
    expect(Object.is(number('-0'), 0)).toBe(true);
    expect(Object.is(number('0 * -1'), 0)).toBe(true);
    expect(Object.is(number('round(-0.4)'), 0)).toBe(true);
    expect(Object.is(number('ceil(-0.5)'), 0)).toBe(true);
    expect(Object.is(number('-3 % 3'), 0)).toBe(true);
    expect(number('atan2(-0 mm, -1 mm)')).toBe(180);
  });

  it('refuses division by zero and non-finite results', () => {
    expectError('domain', '1 / 0');
    expectError('domain', '1 mm / zero');
    expectError('domain', '5 mm % zero');
    expectError('domain', 'v / 0');
    expectError('domain', '1e308 * 10');
    expectError('domain', '1e308 + 1e308');
    expectError('domain', '-1e308 - 1e308');
    expectError('domain', '1e999');
    expectError('domain', '1e308 m');
    expectError('domain', '0^-1');
    expectError('domain', '(-8)^0.5');
    expectError('domain', '10^400');
  });

  it('computes powers', () => {
    expect(number('2^10')).toBe(1024);
    expect(number('4^0.5')).toBe(2);
    expect(number('2^-1')).toBe(0.5);
    expect(number('2^3^2')).toBe(512);
    expect(number('(-2)^3')).toBe(-8);
    expect(number('0^0')).toBe(1);
    expect(number('(3 mm)^2')).toBe(9);
    expect(number('count^2')).toBe(16);
    expect(dimension('(3 mm)^count')).toEqual([4, 0, 0, 0]);
  });

  it('holds ^ to a ratio exponent and an integer on a quantity base', () => {
    expectError('type', '(4 [mm^2])^0.5');
    expectError('type', '2^(1 mm)');
    expectError('type', '(1 mm)^(1 mm)');
    expectError('type', 'v^2');
    expectError('type', 'true^2');
    expectError('type', '(1 mm)^1e300');
  });

  it('keeps the sign of the left operand in %', () => {
    expect(number('5 % 3')).toBe(2);
    expect(number('-5 % 3')).toBe(-2);
    expect(number('5 % -3')).toBe(2);
    expect(number('7 mm % 3 mm')).toBe(1);
    expect(number('5.5 % 2')).toBe(1.5);
    expectError('type', '7 mm % 3');
    expectError('type', '7 % 3 mm');
    expectError('type', 'v % w');
  });
});

describe('vectors', () => {
  const vector = (text: string): readonly number[] => {
    const result = run(text);
    if (result.kind !== 'vector') throw new Error(`${text} gave ${result.kind}`);
    return result.value;
  };

  it('adds vectors of one quantity', () => {
    expect(vector('v + w')).toEqual([5, 7, 9]);
    expect(vector('w - v')).toEqual([3, 3, 3]);
    expectError('type', 'v + f');
    expectError('type', 'v + 1 mm');
    expectError('type', '1 mm + v');
  });

  it('scales by a scalar on either side, and divides by one', () => {
    expect(vector('v * 2')).toEqual([2, 4, 6]);
    expect(vector('2 * v')).toEqual([2, 4, 6]);
    expect(vector('v / 2')).toEqual([0.5, 1, 1.5]);
    expect(dimension('v * 2 mm')).toEqual([2, 0, 0, 0]);
    expect(dimension('2 mm * v')).toEqual([2, 0, 0, 0]);
    expect(dimension('v / 2 mm')).toEqual([0, 0, 0, 0]);
    expectError('type', 'v * w');
    expectError('type', 'v / w');
    expectError('type', '2 / v');
  });

  it('reads components', () => {
    expect(number('v.x')).toBe(1);
    expect(number('v.y')).toBe(2);
    expect(number('(v + w).z')).toBe(9);
    expect(number('vector(1 mm, 2 mm, 3 mm).y')).toBe(2);
    expect(dimension('f.x')).toEqual([1, 1, -2, 0]);
    expectError('type', 'len.x');
    expectError('type', 'label.x');
  });

  it('does not compare or negate', () => {
    expectError('type', 'v == w');
    expectError('type', 'v < w');
  });

  it('negates', () => {
    expect(vector('-v')).toEqual([-1, -2, -3]);
    expect(dimension('-f')).toEqual([1, 1, -2, 0]);
    expect(vector('-(v - v)').every((c) => Object.is(c, 0))).toBe(true);
    expectError('type', '-label');
    expectError('type', '-yes');
  });
});

describe('comparisons and logic', () => {
  it('compares scalars of one quantity', () => {
    expect(truth('1 < 2')).toBe(true);
    expect(truth('2 <= 2')).toBe(true);
    expect(truth('1 > 2')).toBe(false);
    expect(truth('2 >= 3')).toBe(false);
    expect(truth('1 mm != 2 mm')).toBe(true);
    expectError('type', '1 mm < 2');
    expectError('type', '1 mm == 2 s');
    expectError('type', 'true < false');
    expectError('type', '"a" < "b"');
  });

  it('tests texts and booleans for equality only', () => {
    expect(truth('label == "M6"')).toBe(true);
    expect(truth('label != "M8"')).toBe(true);
    expect(truth('yes == true')).toBe(true);
    expect(truth('yes != no')).toBe(true);
    expectError('type', 'label == 1');
    expectError('type', 'yes == 1');
    expectError('type', '"true" == true');
  });

  it('takes booleans only', () => {
    expect(truth('!no')).toBe(true);
    expect(truth('yes && !no')).toBe(true);
    expect(truth('no || yes')).toBe(true);
    expectError('type', '!1');
    expectError('type', '1 && yes');
    expectError('type', 'yes || 1');
    expectError('type', '"" || yes');
    expectError('type', '1 ? 2 : 3');
  });

  it('evaluates only the operand it needs', () => {
    expect(truth('no && (1 / 0 == 1)')).toBe(false);
    expect(truth('yes || (1 / 0 == 1)')).toBe(true);
    expect(number('yes ? 1 : 1 / 0')).toBe(1);
    expect(number('no ? 1 / 0 : 2')).toBe(2);
    expect(number('zero > 0 mm ? 1 mm / zero : 0')).toBe(0);
  });

  it('reads only the references it needs', () => {
    const read: string[] = [];
    const base = context();
    number('yes ? count : len / 1 mm', {
      read(name, ref) {
        read.push(name);
        return base.read(name, ref);
      },
    });
    expect(read).toEqual(['yes', 'count']);
  });

  it('checks skipped operands for type, whichever way the condition falls', () => {
    expectError('type', 'yes ? 1 mm : 2');
    expectError('type', 'no ? 1 mm : 2');
    expectError('type', 'yes ? 1 mm : 1 s');
    expectError('type', 'yes ? v : 1 mm');
    expectError('type', 'yes ? "a" : 1');
    expectError('type', 'yes ? len : count');
    expectError('type', 'no && 5');
    expectError('type', 'yes || 5');
    expectError('type', 'yes ? 1 : 1 mm + 2');
    expect(number('yes ? 1 mm : 2 cm')).toBe(1);
  });
});

describe('functions', () => {
  it('abs, min and max', () => {
    expect(number('abs(-3 mm)')).toBe(3);
    expect(dimension('abs(-3 mm)')).toEqual([1, 0, 0, 0]);
    expect(number('min(3 mm, 1 cm, 2 mm)')).toBe(2);
    expect(number('max(3 mm, 1 cm, 2 mm)')).toBe(10);
    expect(number('max(1, 2)')).toBe(2);
    expectError('type', 'min(1 mm)');
    expectError('type', 'max()');
    expectError('type', 'min(1 mm, 2)');
    expectError('type', 'max(v, w)');
    expectError('type', 'abs(v)');
    expectError('type', 'abs("a")');
  });

  it('round half away from zero, floor and ceil', () => {
    expect(number('round(2.5)')).toBe(3);
    expect(number('round(-2.5)')).toBe(-3);
    expect(number('round(2.4)')).toBe(2);
    expect(number('round(-2.4)')).toBe(-2);
    expect(number('round(0.49999999999999994)')).toBe(0);
    expect(number('round(4503599627370497)')).toBe(4503599627370497);
    expect(number('floor(-1.5)')).toBe(-2);
    expect(number('ceil(-1.5)')).toBe(-1);
    expect(number('floor(1.5)')).toBe(1);
    expect(number('ceil(1.5)')).toBe(2);
  });

  it('round, floor, ceil and sqrt take ratios only', () => {
    expectError('type', 'round(1 mm)');
    expectError('type', 'floor(1 mm)');
    expectError('type', 'ceil(1 mm)');
    expectError('type', 'sqrt(4 [mm^2])');
    expect(number('sqrt(4 [mm^2] / 1 [mm^2]) * 1 mm')).toBe(2);
  });

  it('sqrt', () => {
    expect(number('sqrt(2)')).toBe(1.4142135623730951);
    expect(number('sqrt(0)')).toBe(0);
    expectError('domain', 'sqrt(-1)');
  });

  it('trigonometric functions take an angle and return a ratio', () => {
    expect(number('sin(30 deg)')).toBe(0.5);
    expect(number('cos(60 deg)')).toBe(0.5);
    expect(number('tan(45 deg)')).toBe(1);
    expect(number('sin(180 deg)')).toBe(0);
    expect(number('cos(90 deg)')).toBe(0);
    expect(number('sin(45 deg)')).toBe(0.7071067811865476);
    expect(number('asin(sin(30 deg))')).toBe(30);
    expect(number('sin(0 deg)')).toBe(0);
    expect(number('cos(0 deg)')).toBe(1);
    expect(dimension('sin(1 rad)')).toEqual([0, 0, 0, 0]);
    expectError('domain', 'tan(90 deg)');
    expectError('domain', 'tan(-270 deg)');
    expectError('type', 'sin(1)');
    expectError('type', 'cos(1 mm)');
    expectError('type', 'tan(len)');
  });

  it('inverse functions return an angle in degrees', () => {
    expect(number('asin(1)')).toBe(90);
    expect(number('asin(0.5)')).toBe(30);
    expect(number('acos(0.5)')).toBe(60);
    expect(number('acos(-1)')).toBe(180);
    expect(dimension('asin(1)')).toEqual([0, 0, 0, 1]);
    expectError('type', 'asin(30 deg)');
    expectError('type', 'acos(1 mm)');
    expectError('domain', 'asin(1.5)');
    expectError('domain', 'acos(-1.5)');
  });

  it('atan2 takes y first, both of one quantity', () => {
    expect(number('atan2(1 mm, 0 mm)')).toBe(90);
    expect(number('atan2(0, -1)')).toBe(180);
    expect(number('atan2(1 mm, 1 cm)')).toBe(5.710593137499642);
    expect(dimension('atan2(1, 1)')).toEqual([0, 0, 0, 1]);
    expectError('domain', 'atan2(0, 0)');
    expectError('domain', 'atan2(0 mm, 0 cm)');
    expectError('type', 'atan2(1 mm, 1)');
    expectError('type', 'atan2(v, w)');
  });

  it('vector takes three scalars of one quantity', () => {
    const result = run('vector(1 mm, 1 cm, 1 m)');
    expect(result).toEqual({ kind: 'vector', dim: [1, 0, 0, 0], value: [1, 10, 1000] });
    expectError('type', 'vector(1 mm, 2, 3)');
    expectError('type', 'vector(1, 2)');
    expectError('type', 'vector(1, 2, 3, 4)');
    expectError('type', 'vector(v, v, v)');
  });

  it('rotate makes a canonical unit rotation about a direction of any quantity', () => {
    const quaternion = (text: string): number[] => {
      const result = run(text);
      if (result.kind !== 'rotation') throw new Error(`${text} gave ${result.kind}`);
      return [...result.value];
    };
    expect(quaternion('rotate(vector(0, 0, 1), 0 deg)')).toEqual([0, 0, 0, 1]);
    expect(quaternion('rotate(vector(0 mm, 0 mm, 5 mm), 60 deg)')).toEqual([0, 0, 0.5, 0.8660254037844386]);
    expect(quaternion('rotate(vector(0 N, 0 N, -5 N), -60 deg)')).toEqual([0, 0, 0.5, 0.8660254037844386]);
    expect(quaternion('rotate(f, 90 deg)')).toEqual([0.7071067811865476, 0, 0, 0.7071067811865476]);
    expect(quaternion('rotate(vector(1e-200, 0, 0), 90 deg)')).toEqual([0.7071067811865476, 0, 0, 0.7071067811865476]);
    expect(quaternion('rotate(vector(0, -1, 0), 180 deg)')).toEqual([0, 1, 0, 0]);
    // Each component is (component / norm) × sin(half), each operation rounded.
    const s = 0.03489949670250097;
    expect(quaternion('rotate(vector(1, 2, 2), 4 deg)')).toEqual([
      (1 / 3) * s,
      (2 / 3) * s,
      (2 / 3) * s,
      0.9993908270190958,
    ]);
    expect((1 / 3) * s).not.toBe(s / 3);
    expect(quaternion('rotate(vector(1e200, 1e200, 0), 0 deg)')).toEqual([0, 0, 0, 1]);
    expectError('domain', 'rotate(vector(0, 0, 0), 90 deg)');
    expectError('type', 'rotate(vector(0, 0, 1), 90)');
    expectError('type', 'rotate(1 mm, 90 deg)');
  });

  it('placement takes a length vector and a rotation', () => {
    const result = run('placement(vector(1 cm, 2 mm, 3 mm), rotate(vector(0, 0, 1), 0 deg))');
    expect(result).toEqual({ kind: 'placement', position: [10, 2, 3], rotation: [0, 0, 0, 1] });
    expectError('type', 'placement(vector(1, 2, 3), rotate(vector(0, 0, 1), 0 deg))');
    expectError('type', 'placement(v, 1)');
    expectError('type', 'placement(1 mm, rotate(v, 0 deg))');
  });

  it('lookup reads a cell in its column unit', () => {
    expect(number('lookup(bolts, "M8", "pitch")')).toBe(1.25);
    expect(dimension('lookup(bolts, "M8", "pitch")')).toEqual([1, 0, 0, 0]);
    expect(run('lookup(bolts, label, "note")')).toEqual({ kind: 'text', value: 'coarse' });
    expect(run('lookup(bolts, "M6", "size")')).toEqual({ kind: 'text', value: 'M6' });
    expect(number('lookup(yes ? bolts : bolts, "M6", "pitch") * 2')).toBe(2);
    expectError('table', 'lookup(bolts, "M10", "pitch")');
    expectError('table', 'lookup(bolts, "M6", "thread")');
    expectError('type', 'lookup(bolts, 6, "pitch")');
    expectError('type', 'lookup(bolts, "M6", 1)');
    expectError('type', 'lookup("table", "M6", "pitch")');
    expectError('type', 'lookup(bolts, "M6")');
    expectError('table', 'lookup(bolts, "M6", "pitch")', { table: undefined });
  });

  it('a table is only ever an argument of lookup', () => {
    expectError('type', 'bolts + 1');
    expectError('type', 'bolts == bolts');
    expectError('type', 'bolts.x');
  });

  it('a library entry passes through ?: and nothing else', () => {
    expect(run('yes ? steel : brass')).toEqual({ kind: 'library', id: 'lib_steel' });
    expect(run('no ? steel : brass')).toEqual({ kind: 'library', id: 'lib_brass' });
    expectError('type', 'steel == brass');
    expectError('type', 'yes ? steel : 1');
  });
});

describe('constants', () => {
  it('pi is a ratio', () => {
    expect(number('pi')).toBe(3.141592653589793);
    expect(dimension('pi')).toEqual([0, 0, 0, 0]);
    expect(number('pi * 2')).toBe(6.283185307179586);
    expectError('type', 'sin(pi)');
  });

  it('i and j are valid only with copy indices', () => {
    expect(number('i * 2', { copyIndices: { i: 3, j: 0 } })).toBe(6);
    expect(number('i + j', { copyIndices: { i: -3, j: 4 } })).toBe(1);
    expectError('name', 'i');
    expectError('name', 'j');
    expectError('name', 'yes ? 1 : i');
  });
});

describe('refusing or pausing', () => {
  it('refuses a type error the whole-expression check finds', () => {
    const compiled = compileExpression({ text: 'yes ? 1 mm : 2', grammar: 1, refs: refsFor('yes') });
    expect(() => checkTypes(compiled)).toThrow(ExprError);
    const caught = captured(() => checkTypes(compiled));
    expect(caught.kind).toBe('type');
    expect(caught.integrity).toBe(true);
  });

  it('gives the result type without evaluating, unknown when only evaluation can tell', () => {
    const type = (text: string): string => {
      const compiled = compileExpression({ text, grammar: 1, refs: refsFor(text) });
      return checkTypes(compiled, { typeOf: context().typeOf }).kind;
    };
    expect(type('len * 2')).toBe('scalar');
    expect(type('v + w')).toBe('vector');
    expect(type('yes && no')).toBe('boolean');
    expect(type('lookup(bolts, "M6", "pitch")')).toBe('unknown');
    expect(type('(1 mm)^count')).toBe('unknown');
    expect(type('2^count')).toBe('scalar');
  });

  it('checks i and j against the environment', () => {
    const compiled = compileExpression({ text: 'i + j', grammar: 1, refs: {} });
    expect(() => checkTypes(compiled)).toThrow(/vary/);
    expect(checkTypes(compiled, { inVary: true }).kind).toBe('scalar');
  });

  it('pauses on a type only evaluation could show', () => {
    expectError('value', 'lookup(bolts, "M6", "note") + 1 mm');
    expectError('value', 'lookup(bolts, "M6", "pitch") + 1');
    expectError('value', '(1 mm)^(1 / 2)');
    expectError('value', 'yes ? lookup(bolts, "M6", "note") * 2 : 1');
    expect(captured(() => run('(1 mm)^(1 / 2)')).integrity).toBe(false);
  });

  it('skips what is not taken, even a type only evaluation could show', () => {
    expect(number('no ? lookup(bolts, "M6", "note") * 2 : 1')).toBe(1);
  });

  it('pauses on domain errors, a lookup miss and non-finite results', () => {
    for (const text of ['1 / 0', 'asin(2)', 'lookup(bolts, "M99", "pitch")', '1e308 * 10']) {
      expect(captured(() => run(text)).integrity, text).toBe(false);
    }
  });
});

describe('published references', () => {
  const published: ExprRef = { published: { instance: ['ins_a'], id: 'par_a' } };
  const compile = (text: string): ReturnType<typeof compileExpression> =>
    compileExpression({ text, grammar: 1, refs: { p: published } });
  const lengthKnown = { typeOf: () => ({ kind: 'scalar', dim: [1, 0, 0, 0] }) as const };

  it('are not judged by the whole-expression check, even with a known type', () => {
    expect(checkTypes(compile('p'), lengthKnown).kind).toBe('unknown');
    expect(() => checkTypes(compile('p + 1'), lengthKnown)).not.toThrow();
    expect(checkTypes(compile('p ? 1 : 2'), lengthKnown).kind).toBe('scalar');
  });

  it('pause on a mismatch instead of being refused', () => {
    const context = { ...lengthKnown, read: () => scalarValue([1, 0, 0, 0], 5) };
    const caught = captured(() => evaluateExpression(compile('p + 1'), context));
    expect(caught.kind).toBe('value');
    expect(caught.integrity).toBe(false);
  });

  it('evaluate when the types fit', () => {
    const context = { read: () => scalarValue([1, 0, 0, 0], 5) };
    expect(evaluateExpression(compile('p + 1 mm'), context)).toEqual(scalarValue([1, 0, 0, 0], 6));
  });

  it('do not hide a mismatch among same-document operands', () => {
    const compiled = compileExpression({
      text: 'p + (q + 1)',
      grammar: 1,
      refs: { p: published, q: { parameter: { id: 'par_q' } } },
    });
    expect(captured(() => checkTypes(compiled, lengthKnown)).kind).toBe('type');
  });
});

describe('errors from references', () => {
  it('passes on a failure to read', () => {
    const paused = new ExprError('range', 'outside its range');
    expect(() =>
      run('len', {
        read: () => {
          throw paused;
        },
      }),
    ).toThrow(paused);
  });

  it('checks a value without a known type when it is read', () => {
    expectError('value', 'len + 1', { typeOf: undefined });
    expect(number('yes ? 1 mm : len', { typeOf: undefined })).toBe(1);
    expect(number('no ? 1 : len / 1 mm', { typeOf: undefined })).toBe(10);
  });
});
