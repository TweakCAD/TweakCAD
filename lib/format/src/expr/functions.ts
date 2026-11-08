import { canonicalRotation } from '../rotation';
import { ExprError, finite } from './errors';
import type { LookupTable } from './lookup';
import {
  acosDegrees,
  asinDegrees,
  atan2Degrees,
  cosDegrees,
  norm3,
  sinDegrees,
  sqrt,
  tanDegrees,
} from './rounded-math';
import { ANGLE, LENGTH, RATIO, sameDimension, type Dimension } from './units';
import { describeType, dimensionOf, sameType, UNKNOWN, type ExprType, type ExprValue, type Vector3 } from './values';

export interface FunctionDefinition {
  min: number;
  max: number;
  /** The result type; throws when the rules refuse the arguments. */
  type(args: readonly ExprType[], at: number): ExprType;
  run(args: readonly ExprValue[], at: number, tables: (asset: string) => LookupTable): ExprValue;
}

function argumentError(name: string, args: readonly ExprType[], at: number): never {
  throw new ExprError('type', `${name} cannot take ${args.map(describeType).join(', ')}`, at);
}

function isScalarOf(type: ExprType, dim: Dimension): boolean {
  return type.kind === 'unknown' || (type.kind === 'scalar' && sameDimension(type.dim, dim));
}

function scalarOf(value: ExprValue | undefined): number {
  return (value as { value: number }).value;
}

/** A function from one scalar of `from` to one scalar of `to`. */
function mapping(
  name: string,
  from: Dimension,
  to: Dimension,
  compute: (x: number, at: number) => number,
): FunctionDefinition {
  return {
    min: 1,
    max: 1,
    type(args, at) {
      if (!isScalarOf(args[0] as ExprType, from)) argumentError(name, args, at);
      return { kind: 'scalar', dim: to };
    },
    run: (args, at) => ({ kind: 'scalar', dim: to, value: finite(compute(scalarOf(args[0]), at), name, at) }),
  };
}

function bounded(x: number, at: number): number {
  if (Math.abs(x) > 1) throw new ExprError('domain', `${x} is outside -1 to 1`, at);
  return x;
}

/** The scalars of one quantity that `min`, `max` and `atan2` take, and their shared type. */
function sharedQuantity(name: string, args: readonly ExprType[], at: number): ExprType {
  let shared: ExprType = UNKNOWN;
  for (const arg of args) {
    if (arg.kind === 'unknown') continue;
    if (arg.kind !== 'scalar' || (shared.kind !== 'unknown' && !sameType(shared, arg))) argumentError(name, args, at);
    shared = arg;
  }
  return shared;
}

function extreme(name: string, pick: (...x: number[]) => number): FunctionDefinition {
  return {
    min: 2,
    max: Infinity,
    type: (args, at) => sharedQuantity(name, args, at),
    run: (args) => ({ kind: 'scalar', dim: dimensionOf(args[0] as ExprValue), value: pick(...args.map(scalarOf)) }),
  };
}

function roundHalfAwayFromZero(x: number): number {
  const whole = Math.trunc(x);
  return Math.abs(x - whole) >= 0.5 ? whole + Math.sign(x) : whole;
}

function rotation(args: readonly ExprValue[], at: number): ExprValue {
  const axis = (args[0] as { value: Vector3 }).value;
  const length = norm3(axis[0], axis[1], axis[2]);
  if (length === 0) throw new ExprError('domain', 'a zero vector has no direction', at);
  const half = scalarOf(args[1]) / 2;
  const s = sinDegrees(half);
  const c = cosDegrees(half);
  return {
    kind: 'rotation',
    value: canonicalRotation([(axis[0] / length) * s, (axis[1] / length) * s, (axis[2] / length) * s, c]),
  };
}

export const FUNCTIONS: ReadonlyMap<string, FunctionDefinition> = new Map<string, FunctionDefinition>([
  [
    'abs',
    {
      min: 1,
      max: 1,
      type(args, at) {
        const [a] = args as [ExprType];
        if (a.kind !== 'unknown' && a.kind !== 'scalar') argumentError('abs', args, at);
        return a;
      },
      run: (args) => ({ ...(args[0] as ExprValue & { kind: 'scalar' }), value: Math.abs(scalarOf(args[0])) }),
    },
  ],
  ['min', extreme('min', Math.min)],
  ['max', extreme('max', Math.max)],
  ['round', mapping('round', RATIO, RATIO, roundHalfAwayFromZero)],
  ['floor', mapping('floor', RATIO, RATIO, Math.floor)],
  ['ceil', mapping('ceil', RATIO, RATIO, Math.ceil)],
  [
    'sqrt',
    mapping('sqrt', RATIO, RATIO, (x, at) => {
      if (x < 0) throw new ExprError('domain', `${x} has no square root`, at);
      return sqrt(x);
    }),
  ],
  ['sin', mapping('sin', ANGLE, RATIO, sinDegrees)],
  ['cos', mapping('cos', ANGLE, RATIO, cosDegrees)],
  ['tan', mapping('tan', ANGLE, RATIO, tanDegrees)],
  ['asin', mapping('asin', RATIO, ANGLE, (x, at) => asinDegrees(bounded(x, at)))],
  ['acos', mapping('acos', RATIO, ANGLE, (x, at) => acosDegrees(bounded(x, at)))],
  [
    'atan2',
    {
      min: 2,
      max: 2,
      type(args, at) {
        sharedQuantity('atan2', args, at);
        return { kind: 'scalar', dim: ANGLE };
      },
      run(args, at) {
        const y = scalarOf(args[0]);
        const x = scalarOf(args[1]);
        if (y === 0 && x === 0) throw new ExprError('domain', 'atan2(0, 0) has no angle', at);
        return { kind: 'scalar', dim: ANGLE, value: finite(atan2Degrees(y, x), 'atan2', at) };
      },
    },
  ],
  [
    'vector',
    {
      min: 3,
      max: 3,
      type(args, at) {
        const shared = sharedQuantity('vector', args, at);
        return shared.kind === 'scalar' ? { kind: 'vector', dim: shared.dim } : UNKNOWN;
      },
      run: (args) => ({
        kind: 'vector',
        dim: dimensionOf(args[0] as ExprValue),
        value: [scalarOf(args[0]), scalarOf(args[1]), scalarOf(args[2])],
      }),
    },
  ],
  [
    'rotate',
    {
      min: 2,
      max: 2,
      type(args, at) {
        const [axis, angle] = args as [ExprType, ExprType];
        if ((axis.kind !== 'unknown' && axis.kind !== 'vector') || !isScalarOf(angle, ANGLE))
          argumentError('rotate', args, at);
        return { kind: 'rotation' };
      },
      run: (args, at) => rotation(args, at),
    },
  ],
  [
    'placement',
    {
      min: 2,
      max: 2,
      type(args, at) {
        const [position, turn] = args as [ExprType, ExprType];
        const isLengthVector =
          position.kind === 'unknown' || (position.kind === 'vector' && sameDimension(position.dim, LENGTH));
        if (!isLengthVector || (turn.kind !== 'unknown' && turn.kind !== 'rotation'))
          argumentError('placement', args, at);
        return { kind: 'placement' };
      },
      run: (args) => ({
        kind: 'placement',
        position: (args[0] as { value: Vector3 }).value,
        rotation: (args[1] as ExprValue & { kind: 'rotation' }).value,
      }),
    },
  ],
  [
    'lookup',
    {
      min: 3,
      max: 3,
      type(args, at) {
        const [table, key, column] = args as [ExprType, ExprType, ExprType];
        const isText = (t: ExprType): boolean => t.kind === 'unknown' || t.kind === 'text';
        if ((table.kind !== 'unknown' && table.kind !== 'table') || !isText(key) || !isText(column)) {
          argumentError('lookup', args, at);
        }
        return UNKNOWN;
      },
      run(args, _at, tables) {
        const { asset } = args[0] as ExprValue & { kind: 'table' };
        const key = (args[1] as ExprValue & { kind: 'text' }).value;
        const column = (args[2] as ExprValue & { kind: 'text' }).value;
        return tables(asset).get(key, column);
      },
    },
  ],
]);

export const FUNCTION_NAMES: readonly string[] = [...FUNCTIONS.keys()];
