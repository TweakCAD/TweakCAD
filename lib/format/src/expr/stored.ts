/**
 * The boundary between evaluation and stored values. Stored units are the
 * coherent base units, so a value crosses it as it is; only the checks apply,
 * and nothing is coerced or clamped.
 */

import { isFormatInteger } from '../collections';
import type { JsonValue } from '../canonical';
import type { Quaternion } from '../rotation';
import { ExprError } from './errors';
import { quantityNamed, RATIO, type Quantity } from './units';
import { describeType, sameType, typeOfValue, type ExprType, type ExprValue, type Vector3 } from './values';

export type ValueType =
  'number' | 'integer' | 'boolean' | 'text' | 'choice' | 'vector' | 'placement' | 'date' | 'library';

/** What a stored value must be. */
export interface ValueTarget {
  type: ValueType;
  /** For `number` and `vector`. */
  quantity?: string;
  /** For `choice`. */
  options?: readonly string[];
  /** Inclusive bounds in the stored unit; absent when unbounded. */
  range?: { min: number; max: number };
}

const RFC_3339 =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[Tt](?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

function targetQuantity(target: ValueTarget): Quantity {
  const quantity = target.quantity === undefined ? undefined : quantityNamed(target.quantity);
  if (quantity === undefined) throw new ExprError('unknown', `unknown quantity ${String(target.quantity)}`);
  return quantity;
}

function describeTarget(target: ValueTarget): string {
  return target.quantity === undefined ? target.type : `${target.type} of ${target.quantity}`;
}

function checkRange(stored: number, range: ValueTarget['range']): void {
  if (range !== undefined && !(stored >= range.min && stored <= range.max)) {
    throw new ExprError('range', `${stored} is outside ${range.min} to ${range.max}`);
  }
}

/** The whole-expression check of a result type against what the value must be. */
export function checkTargetType(type: ExprType, target: ValueTarget): void {
  if (type.kind !== 'unknown' && !sameType(type, typeOfTarget(target))) {
    throw new ExprError('type', `a value of type ${describeTarget(target)} cannot be ${describeType(type)}`);
  }
}

/**
 * The stored literal of an evaluated value, which is the value as it is:
 * refuses a value of the wrong type or quantity, an integer that is not exact,
 * a text that is no option, and any number outside `range`.
 */
export function toStored(value: ExprValue, target: ValueTarget): JsonValue {
  const type = typeOfValue(value);
  if (!sameType(type, typeOfTarget(target))) {
    throw new ExprError('value', `a value of type ${describeTarget(target)} cannot be ${describeType(type)}`);
  }
  switch (value.kind) {
    case 'scalar':
      if (target.type === 'integer' && !isFormatInteger(value.value)) {
        throw new ExprError('value', `${value.value} is not an exact integer`);
      }
      checkRange(value.value, target.range);
      return value.value;
    case 'text':
      if (target.type === 'choice' && !target.options?.includes(value.value)) {
        throw new ExprError('value', `${JSON.stringify(value.value)} is not among the options`);
      }
      if (target.type === 'date' && !RFC_3339.test(value.value)) {
        throw new ExprError('value', `${JSON.stringify(value.value)} is not an RFC 3339 date`);
      }
      return value.value;
    case 'boolean':
      return value.value;
    case 'vector':
      return [...value.value];
    case 'placement':
      return { position: [...value.position], rotation: [...value.rotation] };
    case 'library':
      return value.id;
    default:
      throw new ExprError('value', `a ${value.kind} cannot be stored`);
  }
}

/** The value of a stored literal, read as it is. */
export function fromStored(literal: JsonValue, target: ValueTarget): ExprValue {
  const type = typeOfTarget(target);
  switch (type.kind) {
    case 'scalar':
      return { kind: 'scalar', dim: type.dim, value: literal as number };
    case 'vector':
      return { kind: 'vector', dim: type.dim, value: [...(literal as number[])] as Vector3 };
    case 'boolean':
      return { kind: 'boolean', value: literal as boolean };
    case 'text':
      return { kind: 'text', value: literal as string };
    case 'placement': {
      const { position, rotation } = literal as { position: Vector3; rotation: Quaternion };
      return { kind: 'placement', position: [...position], rotation: [...rotation] };
    }
    default:
      return { kind: 'library', id: literal as string };
  }
}

/** The type a stored value will have, for checking without evaluating it. */
export function typeOfTarget(target: ValueTarget): ExprType {
  switch (target.type) {
    case 'number':
      return { kind: 'scalar', dim: targetQuantity(target).dim };
    case 'integer':
      return { kind: 'scalar', dim: RATIO };
    case 'vector':
      return { kind: 'vector', dim: targetQuantity(target).dim };
    case 'boolean':
    case 'placement':
    case 'library':
      return { kind: target.type };
    case 'text':
    case 'choice':
    case 'date':
      return { kind: 'text' };
    default:
      throw new ExprError('unknown', `unknown value type ${String(target.type)}`);
  }
}
