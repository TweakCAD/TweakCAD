import { ExprError, finite } from './errors';
import type { CompiledExpression, ExprRef } from './expression';
import { FUNCTIONS, type FunctionDefinition } from './functions';
import type { LookupTable } from './lookup';
import type { BinaryOperator, Node } from './parser';
import { PI, pow } from './rounded-math';
import { RATIO } from './units';
import {
  binaryType,
  BOOLEAN,
  branchType,
  dimensionOf,
  memberType,
  negationType,
  powerType,
  RATIO_TYPE,
  requireBoolean,
  typeOfValue,
  UNKNOWN,
  type ExprType,
  type ExprValue,
  type Vector3,
} from './values';

/** What the whole-expression check knows about the names in scope. */
export interface TypeEnvironment {
  /** The type of a bound parameter or value, if known without evaluating it. */
  typeOf?: ((name: string, ref: ExprRef) => ExprType | undefined) | undefined;
  /** True inside a pattern's `vary` overrides, where `i` and `j` are valid. */
  inVary?: boolean;
}

export interface EvaluationContext {
  /** The current value of a bound parameter, value or published value. */
  read(name: string, ref: ExprRef): ExprValue;
  typeOf?: TypeEnvironment['typeOf'];
  /** The lookup table stored under an asset hash. */
  table?(asset: string): LookupTable;
  /** The copy indices, from 0 and signed; present only inside a pattern's `vary` overrides. */
  copyIndices?: { i: number; j: number };
}

function outsideVary(name: string, at: number): never {
  throw new ExprError('name', `${name} is valid only inside a pattern's vary overrides`, at);
}

/**
 * The type a reference has whatever the environment says. A published value's
 * type lives in another document, so the check never judges it, and a mismatch
 * there shows only when evaluated.
 */
function fixedType(ref: ExprRef): ExprType | undefined {
  if ('table' in ref) return { kind: 'table' };
  if ('library' in ref) return { kind: 'library' };
  if ('published' in ref) return UNKNOWN;
  return undefined;
}

/** A literal exponent's value, the only one known before evaluation. */
function literalExponent(node: Node): number | undefined {
  if (node.kind === 'number' && node.unit === undefined) return node.value;
  if (node.kind === 'unary' && node.op === '-') {
    const inner = literalExponent(node.operand);
    return inner === undefined ? undefined : -inner;
  }
  return undefined;
}

/**
 * The type of every sub-expression, evaluating nothing. It reaches the
 * operands `&&`, `||` and `?:` skip, so an operand of the wrong type is an
 * error whichever way the condition falls.
 */
function inferType(node: Node, compiled: CompiledExpression, environment: TypeEnvironment): ExprType {
  const infer = (n: Node): ExprType => inferType(n, compiled, environment);
  const at = node.start;
  switch (node.kind) {
    case 'number':
      return { kind: 'scalar', dim: node.unit?.dim ?? RATIO };
    case 'boolean':
      return BOOLEAN;
    case 'text':
      return { kind: 'text' };
    case 'constant':
      if (node.name !== 'pi' && environment.inVary !== true) outsideVary(node.name, at);
      return RATIO_TYPE;
    case 'name': {
      const ref = compiled.refs.get(node.name) as ExprRef;
      return fixedType(ref) ?? environment.typeOf?.(node.name, ref) ?? UNKNOWN;
    }
    case 'member':
      return memberType(infer(node.object), at);
    case 'unary': {
      const operand = infer(node.operand);
      if (node.op === '-') return negationType(operand, at);
      requireBoolean('!', operand, at);
      return BOOLEAN;
    }
    case 'binary':
      if (node.op === '^') {
        return powerType(infer(node.left), infer(node.right), literalExponent(node.right), at);
      }
      return binaryType(node.op, infer(node.left), infer(node.right), at);
    case 'logical':
      requireBoolean(node.op, infer(node.left), at);
      requireBoolean(node.op, infer(node.right), at);
      return BOOLEAN;
    case 'conditional':
      requireBoolean('the condition of ?:', infer(node.test), at);
      return branchType(infer(node.then), infer(node.otherwise), at);
    case 'call':
      return (FUNCTIONS.get(node.name) as FunctionDefinition).type(node.args.map(infer), at);
  }
}

function asNumber(value: ExprValue): number {
  return (value as { value: number }).value;
}

function compare(op: BinaryOperator, a: number, b: number): boolean {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    default:
      return a >= b;
  }
}

function divide(a: number, b: number, at: number): number {
  if (b === 0) throw new ExprError('domain', 'division by zero', at);
  return a / b;
}

function arithmetic(op: BinaryOperator, a: number, b: number, at: number): number {
  switch (op) {
    case '+':
      return finite(a + b, op, at);
    case '-':
      return finite(a - b, op, at);
    case '*':
      return finite(a * b, op, at);
    case '/':
      return finite(divide(a, b, at), op, at);
    default:
      if (b === 0) throw new ExprError('domain', 'remainder of division by zero', at);
      return finite(a % b, op, at);
  }
}

function applyBinary(op: Exclude<BinaryOperator, '^'>, left: ExprValue, right: ExprValue, at: number): ExprValue {
  const type = binaryType(op, typeOfValue(left), typeOfValue(right), at);
  if (op === '==' || op === '!=') {
    const equal = (left as { value: unknown }).value === (right as { value: unknown }).value;
    return { kind: 'boolean', value: equal === (op === '==') };
  }
  if (type.kind === 'boolean') return { kind: 'boolean', value: compare(op, asNumber(left), asNumber(right)) };
  if (type.kind === 'vector') {
    const dim = type.dim;
    if (left.kind === 'vector' && right.kind === 'vector') {
      const [a, b] = [left.value, right.value];
      return { kind: 'vector', dim, value: a.map((c, i) => arithmetic(op, c, b[i] as number, at)) as Vector3 };
    }
    if (left.kind === 'vector') {
      const factor = asNumber(right);
      return { kind: 'vector', dim, value: left.value.map((c) => arithmetic(op, c, factor, at)) as Vector3 };
    }
    const factor = asNumber(left);
    const vector = (right as { value: Vector3 }).value;
    return { kind: 'vector', dim, value: vector.map((c) => arithmetic(op, factor, c, at)) as Vector3 };
  }
  return { kind: 'scalar', dim: dimensionOf(type), value: arithmetic(op, asNumber(left), asNumber(right), at) };
}

function applyPower(left: ExprValue, right: ExprValue, at: number): ExprValue {
  const exponent = right.kind === 'scalar' ? right.value : undefined;
  const type = powerType(typeOfValue(left), typeOfValue(right), exponent, at);
  return { kind: 'scalar', dim: dimensionOf(type), value: finite(pow(asNumber(left), exponent as number), '^', at) };
}

class Evaluator {
  constructor(
    private readonly compiled: CompiledExpression,
    private readonly context: EvaluationContext,
  ) {}

  private condition(node: Node, what: string): boolean {
    const value = this.run(node);
    requireBoolean(what, typeOfValue(value), node.start);
    return (value as { value: boolean }).value;
  }

  private constant(name: 'pi' | 'i' | 'j', at: number): number {
    if (name === 'pi') return PI;
    const indices = this.context.copyIndices;
    return indices === undefined ? outsideVary(name, at) : indices[name];
  }

  private tableOf = (asset: string): LookupTable => {
    if (this.context.table === undefined) throw new ExprError('table', `no table for asset ${asset}`);
    return this.context.table(asset);
  };

  run(node: Node): ExprValue {
    const at = node.start;
    switch (node.kind) {
      case 'number':
        return {
          kind: 'scalar',
          dim: node.unit?.dim ?? RATIO,
          value: finite(node.unit === undefined ? node.value : node.value * node.unit.scale, 'the number', at),
        };
      case 'boolean':
        return { kind: 'boolean', value: node.value };
      case 'text':
        return { kind: 'text', value: node.value };
      case 'constant':
        return { kind: 'scalar', dim: RATIO, value: this.constant(node.name, at) };
      case 'name': {
        const ref = this.compiled.refs.get(node.name) as ExprRef;
        if ('table' in ref) return { kind: 'table', asset: ref.table.asset };
        if ('library' in ref) return { kind: 'library', id: ref.library.id };
        return this.context.read(node.name, ref);
      }
      case 'member': {
        const object = this.run(node.object);
        const type = memberType(typeOfValue(object), at);
        return { kind: 'scalar', dim: dimensionOf(type), value: (object as { value: Vector3 }).value[node.axis] };
      }
      case 'unary': {
        if (node.op === '!') return { kind: 'boolean', value: !this.condition(node.operand, '!') };
        const operand = this.run(node.operand);
        negationType(typeOfValue(operand), at);
        if (operand.kind === 'vector') {
          return { ...operand, value: operand.value.map((c) => finite(-c, '-', at)) as Vector3 };
        }
        return { ...(operand as ExprValue & { kind: 'scalar' }), value: finite(-asNumber(operand), '-', at) };
      }
      case 'binary': {
        const left = this.run(node.left);
        const right = this.run(node.right);
        return node.op === '^' ? applyPower(left, right, at) : applyBinary(node.op, left, right, at);
      }
      case 'logical': {
        const left = this.condition(node.left, node.op);
        if (left === (node.op === '||')) return { kind: 'boolean', value: left };
        return { kind: 'boolean', value: this.condition(node.right, node.op) };
      }
      case 'conditional':
        return this.run(this.condition(node.test, 'the condition of ?:') ? node.then : node.otherwise);
      case 'call': {
        const definition = FUNCTIONS.get(node.name) as FunctionDefinition;
        const args = node.args.map((arg) => this.run(arg));
        definition.type(args.map(typeOfValue), at);
        return definition.run(args, at, this.tableOf);
      }
    }
  }
}

/**
 * The whole-expression check: the type of the result, `unknown` when only
 * evaluation can tell, or a `type` error. It reaches both `?:` branches and
 * both sides of `&&` and `||`.
 */
export function checkTypes(compiled: CompiledExpression, environment: TypeEnvironment = {}): ExprType {
  return inferType(compiled.ast, compiled, environment);
}

/**
 * Evaluates an expression: the whole-expression check first, then only the
 * operands `&&`, `||` and `?:` need. A wrong type the check could not see is a
 * `value` error, since it depends on values.
 */
export function evaluateExpression(compiled: CompiledExpression, context: EvaluationContext): ExprValue {
  checkTypes(compiled, { typeOf: context.typeOf, inVary: context.copyIndices !== undefined });
  try {
    return new Evaluator(compiled, context).run(compiled.ast);
  } catch (e) {
    if (e instanceof ExprError && e.kind === 'type') throw new ExprError('value', e.detail, e.at);
    throw e;
  }
}
