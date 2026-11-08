import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../canonical';
import { ExprError, type ExprErrorKind } from './errors';
import { evaluateExpression } from './evaluate';
import { compileExpression, type ExprRef } from './expression';
import { checkTargetType, fromStored, toStored, typeOfTarget, type ValueTarget } from './stored';
import { QUANTITIES, quantityNamed, quantityOf } from './units';
import type { ExprType, ExprValue } from './values';

function evaluate(text: string): ExprValue {
  return evaluateExpression(compileExpression({ text, grammar: 1, refs: {} }), {
    read() {
      throw new Error('no references');
    },
  });
}

const store = (text: string, target: ValueTarget): unknown => toStored(evaluate(text), target);

function expectError(kind: ExprErrorKind, text: string, target: ValueTarget): void {
  try {
    store(text, target);
  } catch (e) {
    expect(e).toBeInstanceOf(ExprError);
    expect((e as ExprError).kind).toBe(kind);
    return;
  }
  expect.unreachable(`expected ${text} to give a ${kind} error`);
}

describe('the quantity registry', () => {
  it('holds every quantity in its stored unit', () => {
    expect(QUANTITIES.map((q) => q.name).sort()).toEqual([
      'angle',
      'area',
      'density',
      'force',
      'lead',
      'length',
      'mass',
      'pressure',
      'ratio',
      'time',
      'torque',
      'volume',
    ]);
  });

  it('gives each quantity its own dimension', () => {
    for (const q of QUANTITIES) expect(quantityOf(q.dim)).toBe(q);
    expect(quantityOf([1, 0, 1, 0])).toBeUndefined();
    expect(quantityNamed('colour')).toBeUndefined();
  });

  it('stores each quantity in its registry unit', () => {
    const stored = (text: string, quantity: string): unknown => store(text, { type: 'number', quantity });
    expect(stored('2 cm', 'length')).toBe(20);
    expect(stored('90 deg', 'angle')).toBe(90);
    expect(stored('2 [cm^2]', 'area')).toBe(200);
    expect(stored('2 [cm^3]', 'volume')).toBe(2000);
    expect(stored('2 kg', 'mass')).toBe(0.002);
    expect(stored('2 g', 'mass')).toBe(2e-6);
    expect(stored('7.85 [g/cm^3]', 'density')).toBe(7.85 * 1e-9);
    expect(stored('1 [kg/m^3]', 'density')).toBe(1e-12);
    expect(stored('5 N', 'force')).toBe(5);
    expect(stored('2 kg * 3 m / (1 s * 1 s)', 'force')).toBe(6);
    expect(stored('5 [N*mm]', 'torque')).toBe(5);
    expect(stored('5 MPa', 'pressure')).toBe(5);
    expect(stored('5 [N/mm^2]', 'pressure')).toBe(5);
    expect(stored('3 s', 'time')).toBe(3);
    expect(stored('0.5', 'ratio')).toBe(0.5);
  });
});

describe('storing', () => {
  it('refuses a quantity no registry entry matches', () => {
    expectError('value', '1 mm * 1 s', { type: 'number', quantity: 'length' });
  });

  it('refuses the wrong quantity', () => {
    expectError('value', '1 mm', { type: 'number', quantity: 'angle' });
    expectError('value', '1', { type: 'number', quantity: 'length' });
  });

  it('refuses an unknown quantity as content it does not understand', () => {
    expectError('unknown', '1', { type: 'number', quantity: 'luminosity' });
    expectError('unknown', '1', { type: 'number' });
  });

  it('pauses on an integer that is not whole and a choice not among its options', () => {
    for (const [text, target] of [
      ['5 / 2', { type: 'integer' }],
      ['"Cut"', { type: 'choice', options: ['cut'] }],
    ] as [string, ValueTarget][]) {
      try {
        store(text, target);
        expect.unreachable(text);
      } catch (e) {
        expect((e as ExprError).integrity).toBe(false);
      }
    }
  });

  it('an integer is a ratio that is an exact integer', () => {
    expect(store('6 / 2', { type: 'integer' })).toBe(3);
    expect(store('-4', { type: 'integer' })).toBe(-4);
    expect(store('2^53', { type: 'integer' })).toBe(2 ** 53);
    expectError('value', '5 / 2', { type: 'integer' });
    expectError('value', '3 mm', { type: 'integer' });
    expectError('value', '2^54', { type: 'integer' });
    expectError('value', '"3"', { type: 'integer' });
    expectError('value', 'true', { type: 'integer' });
  });

  it('a choice is a text among its options', () => {
    const target: ValueTarget = { type: 'choice', options: ['join', 'cut'] };
    expect(store('"cut"', target)).toBe('cut');
    expectError('value', '"Cut"', target);
    expectError('value', '1', target);
    expectError('value', 'true', target);
  });

  it('a boolean is a boolean', () => {
    expect(store('1 < 2', { type: 'boolean' })).toBe(true);
    expectError('value', '1', { type: 'boolean' });
    expectError('value', '"true"', { type: 'boolean' });
  });

  it('a text is a text', () => {
    expect(store('"M6"', { type: 'text' })).toBe('M6');
    expectError('value', '1', { type: 'text' });
  });

  it('a date is RFC 3339 text', () => {
    expect(store('"2026-11-05"', { type: 'date' })).toBe('2026-11-05');
    expect(store('"2026-11-05T10:00:00Z"', { type: 'date' })).toBe('2026-11-05T10:00:00Z');
    expect(store('"2026-11-05T10:00:00.5+02:00"', { type: 'date' })).toBe('2026-11-05T10:00:00.5+02:00');
    expectError('value', '"5 Nov 2026"', { type: 'date' });
    expectError('value', '"2026-13-05"', { type: 'date' });
    expectError('value', '1', { type: 'date' });
  });

  it('a vector stores each component', () => {
    expect(store('vector(1 cm, 2 cm, 3 cm)', { type: 'vector', quantity: 'length' })).toEqual([10, 20, 30]);
    expect(store('vector(1 N, 2 N, 3 N)', { type: 'vector', quantity: 'force' })).toEqual([1, 2, 3]);
    expectError('value', 'vector(1, 2, 3)', { type: 'vector', quantity: 'length' });
    expectError('value', '1 mm', { type: 'vector', quantity: 'length' });
  });

  it('a placement stores position and rotation', () => {
    expect(store('placement(vector(1 cm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))', { type: 'placement' })).toEqual(
      {
        position: [10, 0, 0],
        rotation: [0, 0, 0, 1],
      },
    );
    expectError('value', 'rotate(vector(0, 0, 1), 0 deg)', { type: 'placement' });
    expectError('value', '1', { type: 'placement' });
  });

  it('a library value is any expression evaluating to an entry', () => {
    const refs: Record<string, ExprRef> = {
      big: { parameter: { id: 'par_big' } },
      steel: { library: { id: 'lib_steel' } },
      brass: { library: { id: 'lib_brass' } },
    };
    const value = (big: boolean): ExprValue =>
      evaluateExpression(compileExpression({ text: 'big ? steel : brass', grammar: 1, refs }), {
        read: () => ({ kind: 'boolean', value: big }),
      });
    expect(toStored(value(true), { type: 'library' })).toBe('lib_steel');
    expect(toStored(value(false), { type: 'library' })).toBe('lib_brass');
    expect(() => checkTargetType({ kind: 'library' }, { type: 'text' })).toThrow(ExprError);
  });

  it('refuses a rotation or a table, which no value stores', () => {
    expectError('value', 'rotate(vector(0, 0, 1), 0 deg)', { type: 'number', quantity: 'ratio' });
  });

  it('refuses a value type it does not know', () => {
    expectError('unknown', '1', { type: 'colour' as never });
  });
});

describe('ranges', () => {
  const target: ValueTarget = { type: 'number', quantity: 'length', range: { min: 1, max: 10 } };

  it('accepts the bounds', () => {
    expect(store('1 mm', target)).toBe(1);
    expect(store('1 cm', target)).toBe(10);
  });

  it('never clamps', () => {
    expectError('range', '0.5 mm', target);
    expectError('range', '10.5 mm', target);
    expectError('range', '1 m', target);
  });

  it('compares in the stored unit', () => {
    expect(store('1 MPa', { type: 'number', quantity: 'pressure', range: { min: 1, max: 1 } })).toBe(1);
  });

  it('applies to integers', () => {
    expect(store('3', { type: 'integer', range: { min: 1, max: 3 } })).toBe(3);
    expectError('range', '4', { type: 'integer', range: { min: 1, max: 3 } });
  });
});

describe('the whole-expression check against a target', () => {
  it('refuses a known wrong type', () => {
    const refused = (type: ExprType, target: ValueTarget): void => {
      expect(() => checkTargetType(type, target)).toThrow(ExprError);
    };
    refused({ kind: 'scalar', dim: [1, 0, 0, 0] }, { type: 'number', quantity: 'angle' });
    refused({ kind: 'scalar', dim: [1, 0, 1, 0] }, { type: 'number', quantity: 'length' });
    refused({ kind: 'scalar', dim: [1, 0, 0, 0] }, { type: 'integer' });
    refused({ kind: 'text' }, { type: 'boolean' });
    refused({ kind: 'rotation' }, { type: 'placement' });
  });

  it('accepts a fitting or unknown type', () => {
    expect(() =>
      checkTargetType({ kind: 'scalar', dim: [1, 0, 0, 0] }, { type: 'number', quantity: 'length' }),
    ).not.toThrow();
    expect(() => checkTargetType({ kind: 'scalar', dim: [0, 0, 0, 0] }, { type: 'integer' })).not.toThrow();
    expect(() => checkTargetType({ kind: 'text' }, { type: 'choice', options: [] })).not.toThrow();
    expect(() => checkTargetType({ kind: 'unknown' }, { type: 'boolean' })).not.toThrow();
  });
});

describe('reading stored values', () => {
  it('round-trips each type', () => {
    const cases: [ValueTarget, JsonValue][] = [
      [{ type: 'number', quantity: 'length' }, 12.5],
      [{ type: 'number', quantity: 'density' }, 7.85e-9],
      [{ type: 'number', quantity: 'force' }, 0.05],
      [{ type: 'number', quantity: 'force' }, 3],
      [{ type: 'number', quantity: 'torque' }, 7],
      [{ type: 'number', quantity: 'pressure' }, 210],
      [{ type: 'integer' }, 3],
      [{ type: 'boolean' }, true],
      [{ type: 'text' }, 'M6'],
      [{ type: 'choice', options: ['a'] }, 'a'],
      [{ type: 'date' }, '2026-11-05'],
      [{ type: 'vector', quantity: 'force' }, [1, 2, 3]],
      [{ type: 'placement' }, { position: [1, 2, 3], rotation: [0, 0, 0, 1] }],
      [{ type: 'library' }, 'lib_steel'],
    ];
    for (const [target, literal] of cases) {
      expect(toStored(fromStored(literal, target), target)).toEqual(literal);
    }
  });

  it('never changes a stored number', () => {
    for (const quantity of ['force', 'torque', 'pressure', 'density', 'mass']) {
      const target: ValueTarget = { type: 'number', quantity };
      for (let i = 1; i <= 2000; i++) {
        const stored = i / 100;
        expect(toStored(fromStored(stored, target), target)).toBe(stored);
      }
    }
  });

  it('gives a value the type of its target', () => {
    const target: ValueTarget[] = [
      { type: 'number', quantity: 'force' },
      { type: 'integer' },
      { type: 'vector', quantity: 'length' },
      { type: 'boolean' },
      { type: 'text' },
      { type: 'choice', options: [] },
      { type: 'date' },
      { type: 'placement' },
      { type: 'library' },
    ];
    expect(target.map((t) => typeOfTarget(t).kind)).toEqual([
      'scalar',
      'scalar',
      'vector',
      'boolean',
      'text',
      'text',
      'text',
      'placement',
      'library',
    ]);
  });
});
