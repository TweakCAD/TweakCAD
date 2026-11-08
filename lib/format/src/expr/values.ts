import type { Quaternion } from '../rotation';
import { ExprError } from './errors';
import type { BinaryOperator } from './parser';
import { combineDimensions, describeDimension, RATIO, sameDimension, scaleDimension, type Dimension } from './units';

export type Vector3 = [number, number, number];

/** The type of a value. `unknown` stands for a type only evaluation can tell. */
export type ExprType =
  | { kind: 'scalar'; dim: Dimension }
  | { kind: 'vector'; dim: Dimension }
  | { kind: 'boolean' }
  | { kind: 'text' }
  | { kind: 'rotation' }
  | { kind: 'placement' }
  | { kind: 'table' }
  | { kind: 'library' }
  | { kind: 'unknown' };

/** A value during evaluation. Quantities are held in the coherent base units. */
export type ExprValue =
  | { kind: 'scalar'; dim: Dimension; value: number }
  | { kind: 'vector'; dim: Dimension; value: Vector3 }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'text'; value: string }
  | { kind: 'rotation'; value: Quaternion }
  | { kind: 'placement'; position: Vector3; rotation: Quaternion }
  | { kind: 'table'; asset: string }
  | { kind: 'library'; id: string };

export const UNKNOWN: ExprType = { kind: 'unknown' };
export const BOOLEAN: ExprType = { kind: 'boolean' };
export const RATIO_TYPE: ExprType = { kind: 'scalar', dim: RATIO };

export function scalarValue(dim: Dimension, value: number): ExprValue {
  return { kind: 'scalar', dim, value };
}

/** The dimension of a type known to be a scalar or a vector. */
export function dimensionOf(type: ExprType | ExprValue): Dimension {
  return (type as { dim: Dimension }).dim;
}

export function typeOfValue(value: ExprValue): ExprType {
  return value.kind === 'scalar' || value.kind === 'vector'
    ? { kind: value.kind, dim: value.dim }
    : { kind: value.kind };
}

export function describeType(type: ExprType): string {
  return type.kind === 'scalar' || type.kind === 'vector'
    ? `${type.kind} of ${describeDimension(type.dim)}`
    : type.kind;
}

export function sameType(a: ExprType, b: ExprType): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === 'scalar' || a.kind === 'vector') && a.kind === b.kind) return sameDimension(a.dim, b.dim);
  return true;
}

function typeError(message: string, at: number): never {
  throw new ExprError('type', message, at);
}

/** Whether `type` is unknown or has one of `kinds`. */
function mayBe(type: ExprType, ...kinds: ExprType['kind'][]): boolean {
  return type.kind === 'unknown' || kinds.includes(type.kind);
}

/** The one type two operands agree on, `unknown` standing for either. */
function agreed(a: ExprType, b: ExprType, what: string, at: number): ExprType {
  if (a.kind === 'unknown') return b;
  if (b.kind === 'unknown') return a;
  if (!sameType(a, b))
    typeError(`${what} needs one type and quantity, not ${describeType(a)} and ${describeType(b)}`, at);
  return a;
}

function additiveType(op: string, a: ExprType, b: ExprType, at: number): ExprType {
  if (!mayBe(a, 'scalar', 'vector') || !mayBe(b, 'scalar', 'vector')) {
    typeError(`${op} needs two scalars or two vectors, not ${describeType(a)} and ${describeType(b)}`, at);
  }
  return agreed(a, b, op, at);
}

function productType(op: '*' | '/', a: ExprType, b: ExprType, at: number): ExprType {
  const operands = `${describeType(a)} and ${describeType(b)}`;
  if (!mayBe(a, 'scalar', 'vector') || !mayBe(b, 'scalar', 'vector')) typeError(`${op} cannot take ${operands}`, at);
  if (a.kind === 'vector' && b.kind === 'vector') typeError(`${op} cannot take two vectors`, at);
  if (op === '/' && b.kind === 'vector') typeError('a vector cannot be a divisor', at);
  if (a.kind === 'unknown' || b.kind === 'unknown') return UNKNOWN;
  const dim = combineDimensions(dimensionOf(a), dimensionOf(b), op === '*' ? 1 : -1);
  return { kind: a.kind === 'vector' || b.kind === 'vector' ? 'vector' : 'scalar', dim };
}

function scalarsOfOneQuantity(op: string, a: ExprType, b: ExprType, at: number): ExprType {
  if (!mayBe(a, 'scalar') || !mayBe(b, 'scalar')) {
    typeError(`${op} needs two scalars, not ${describeType(a)} and ${describeType(b)}`, at);
  }
  return agreed(a, b, op, at);
}

/** The result of `base ^ exponent`; `exponent` is its value when known. */
export function powerType(base: ExprType, power: ExprType, exponent: number | undefined, at: number): ExprType {
  if (!mayBe(base, 'scalar')) typeError(`^ needs a scalar base, not ${describeType(base)}`, at);
  if (power.kind !== 'unknown' && !(power.kind === 'scalar' && sameDimension(power.dim, RATIO))) {
    typeError(`the exponent of ^ must be a ratio, not ${describeType(power)}`, at);
  }
  if (base.kind === 'unknown') return UNKNOWN;
  const dim = dimensionOf(base);
  if (sameDimension(dim, RATIO)) return RATIO_TYPE;
  if (exponent === undefined) return UNKNOWN;
  if (!Number.isInteger(exponent)) typeError(`a ${describeDimension(dim)} base needs an integer exponent`, at);
  const scaled = scaleDimension(dim, exponent);
  if (!scaled.every(Number.isSafeInteger)) typeError('the exponent makes the quantity too large', at);
  return { kind: 'scalar', dim: scaled };
}

/** The result of any binary operator but `^`; throws when the rules refuse the operands. */
export function binaryType(op: Exclude<BinaryOperator, '^'>, a: ExprType, b: ExprType, at: number): ExprType {
  switch (op) {
    case '+':
    case '-':
      return additiveType(op, a, b, at);
    case '*':
    case '/':
      return productType(op, a, b, at);
    case '%':
      return scalarsOfOneQuantity(op, a, b, at);
    case '<':
    case '<=':
    case '>':
    case '>=':
      scalarsOfOneQuantity(op, a, b, at);
      return BOOLEAN;
    case '==':
    case '!=':
      if (!mayBe(a, 'scalar', 'text', 'boolean') || !mayBe(b, 'scalar', 'text', 'boolean')) {
        typeError(`${op} cannot take ${describeType(a)} and ${describeType(b)}`, at);
      }
      agreed(a, b, op, at);
      return BOOLEAN;
  }
}

export function negationType(a: ExprType, at: number): ExprType {
  if (!mayBe(a, 'scalar', 'vector')) typeError(`unary - needs a scalar or a vector, not ${describeType(a)}`, at);
  return a;
}

export function requireBoolean(what: string, a: ExprType, at: number): void {
  if (!mayBe(a, 'boolean')) typeError(`${what} needs a boolean, not ${describeType(a)}`, at);
}

export function branchType(a: ExprType, b: ExprType, at: number): ExprType {
  return agreed(a, b, 'the branches of ?:', at);
}

export function memberType(a: ExprType, at: number): ExprType {
  if (a.kind === 'unknown') return UNKNOWN;
  if (a.kind !== 'vector') typeError(`.x, .y and .z need a vector, not ${describeType(a)}`, at);
  return { kind: 'scalar', dim: a.dim };
}
