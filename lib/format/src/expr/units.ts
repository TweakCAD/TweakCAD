/**
 * Dimensions, the grammar-1 unit list and the quantity registry.
 *
 * Expressions compute in the coherent base units mm, t, s and deg, which are
 * also the stored units. A unit's scale is the factor to those base units:
 * exact for every unit but `rad`, and rounded once to a double, so a compound
 * unit's scale is the double nearest its exact value.
 */

import { ExprError } from './errors';
import { roundRatio } from './dyadic';
import { piFixed } from './rounded-math';

/** Exponents of length, mass, time and angle. */
export type Dimension = readonly [length: number, mass: number, time: number, angle: number];

export const RATIO: Dimension = [0, 0, 0, 0];
export const LENGTH: Dimension = [1, 0, 0, 0];
export const ANGLE: Dimension = [0, 0, 0, 1];

export function sameDimension(a: Dimension, b: Dimension): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function combineDimensions(a: Dimension, b: Dimension, sign: 1 | -1): Dimension {
  return [a[0] + sign * b[0], a[1] + sign * b[1], a[2] + sign * b[2], a[3] + sign * b[3]];
}

export function scaleDimension(a: Dimension, factor: number): Dimension {
  // Adding zero keeps a negative factor from writing negative zeros.
  return [a[0] * factor + 0, a[1] * factor + 0, a[2] * factor + 0, a[3] * factor + 0];
}

export function describeDimension(d: Dimension): string {
  const quantity = quantityOf(d);
  if (quantity !== undefined) return quantity.name;
  const names = ['length', 'mass', 'time', 'angle'];
  return d.flatMap((exponent, i) => (exponent === 0 ? [] : [`${names[i]}^${exponent}`])).join('·');
}

interface UnitDefinition {
  dim: Dimension;
  numerator: bigint;
  denominator: bigint;
  /** The power of 180/π in the scale. */
  radians: number;
}

function exactUnit(dim: Dimension, numerator: bigint, denominator = 1n): UnitDefinition {
  return { dim, numerator, denominator, radians: 0 };
}

const MASS: Dimension = [0, 1, 0, 0];
const FORCE: Dimension = [1, 1, -2, 0];
const PRESSURE: Dimension = [-1, 1, -2, 0];

const UNITS: ReadonlyMap<string, UnitDefinition> = new Map([
  ['mm', exactUnit(LENGTH, 1n)],
  ['cm', exactUnit(LENGTH, 10n)],
  ['m', exactUnit(LENGTH, 1000n)],
  ['um', exactUnit(LENGTH, 1n, 1000n)],
  ['in', exactUnit(LENGTH, 127n, 5n)],
  ['ft', exactUnit(LENGTH, 1524n, 5n)],
  ['deg', exactUnit(ANGLE, 1n)],
  ['rad', { dim: ANGLE, numerator: 1n, denominator: 1n, radians: 1 }],
  ['g', exactUnit(MASS, 1n, 1000000n)],
  ['kg', exactUnit(MASS, 1n, 1000n)],
  ['s', exactUnit([0, 0, 1, 0], 1n)],
  ['N', exactUnit(FORCE, 1n)],
  ['MPa', exactUnit(PRESSURE, 1n)],
]);

export const UNIT_NAMES: readonly string[] = [...UNITS.keys()];

export function isUnitName(name: string): boolean {
  return UNITS.has(name);
}

/** A resolved unit: its dimension and its scale to the base units. */
export interface Unit {
  dim: Dimension;
  scale: number;
}

export interface UnitFactor {
  unit: string;
  exponent: number;
}

/** The largest exponent magnitude in a compound unit. */
export const MAX_UNIT_EXPONENT = 4096;

function radianScale(numerator: bigint, denominator: bigint, radians: number): number {
  const count = BigInt(Math.abs(radians));
  for (let w = 256; ; w *= 2) {
    const circle = (180n ** count) << (BigInt(w) * count);
    const low = (piFixed(w) - 1n) ** count;
    const high = (piFixed(w) + 1n) ** count;
    const [a, b] =
      radians > 0
        ? [roundRatio(numerator * circle, denominator * high), roundRatio(numerator * circle, denominator * low)]
        : [roundRatio(numerator * low, denominator * circle), roundRatio(numerator * high, denominator * circle)];
    if (a === b) return a;
  }
}

/** The dimension and the once-rounded scale of a product of unit powers. */
export function resolveUnit(factors: readonly UnitFactor[]): Unit {
  let dim = RATIO;
  let numerator = 1n;
  let denominator = 1n;
  let radians = 0;
  for (const { unit, exponent } of factors) {
    const definition = UNITS.get(unit);
    if (definition === undefined) throw new ExprError('syntax', `unknown unit ${unit}`);
    if (Math.abs(exponent) > MAX_UNIT_EXPONENT) {
      throw new ExprError('syntax', `unit exponent ${exponent} is too large`);
    }
    dim = combineDimensions(dim, scaleDimension(definition.dim, exponent), 1);
    const power = BigInt(Math.abs(exponent));
    const up = definition.numerator ** power;
    const down = definition.denominator ** power;
    numerator *= exponent >= 0 ? up : down;
    denominator *= exponent >= 0 ? down : up;
    radians += definition.radians * exponent;
  }
  const scale = radians === 0 ? roundRatio(numerator, denominator) : radianScale(numerator, denominator, radians);
  return { dim, scale };
}

/** A registry quantity; its stored unit is its unit in the coherent base. */
export interface Quantity {
  name: string;
  dim: Dimension;
}

export const QUANTITIES: readonly Quantity[] = [
  { name: 'ratio', dim: RATIO },
  { name: 'length', dim: LENGTH },
  { name: 'angle', dim: ANGLE },
  { name: 'area', dim: [2, 0, 0, 0] },
  { name: 'volume', dim: [3, 0, 0, 0] },
  { name: 'mass', dim: MASS },
  { name: 'density', dim: [-3, 1, 0, 0] },
  { name: 'force', dim: FORCE },
  { name: 'torque', dim: [2, 1, -2, 0] },
  { name: 'pressure', dim: PRESSURE },
  { name: 'time', dim: [0, 0, 1, 0] },
  { name: 'lead', dim: [1, 0, 0, -1] },
];

export function quantityNamed(name: string): Quantity | undefined {
  return QUANTITIES.find((q) => q.name === name);
}

export function quantityOf(dim: Dimension): Quantity | undefined {
  return QUANTITIES.find((q) => sameDimension(q.dim, dim));
}
