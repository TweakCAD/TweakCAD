import { ExprError } from './errors';
import { roundDecimal } from './dyadic';
import { tokenize, type Token } from './tokenizer';
import { isUnitName, resolveUnit, type Unit, type UnitFactor } from './units';

export type BinaryOperator = '+' | '-' | '*' | '/' | '%' | '^' | '==' | '!=' | '<' | '<=' | '>' | '>=';

interface Base {
  start: number;
  end: number;
  /** Longest path below this node; evaluation recurses this deep. */
  height: number;
}

type Fields =
  | { kind: 'number'; value: number; unit?: Unit }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'text'; value: string }
  | { kind: 'constant'; name: 'pi' | 'i' | 'j' }
  | { kind: 'name'; name: string }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'member'; object: Node; axis: 0 | 1 | 2 }
  | { kind: 'unary'; op: '-' | '!'; operand: Node }
  | { kind: 'binary'; op: BinaryOperator; left: Node; right: Node }
  | { kind: 'logical'; op: '&&' | '||'; left: Node; right: Node }
  | { kind: 'conditional'; test: Node; then: Node; otherwise: Node };

export type Node = Base & Fields;

/** Nesting beyond this is refused, so no reader runs out of stack. */
export const MAX_NESTING = 256;

const CONSTANTS = new Set(['pi', 'i', 'j']);
const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);
const ADDITIVE = new Set(['+', '-']);
const MULTIPLICATIVE = new Set(['*', '/', '%']);
const PREFIX = new Set(['-', '!']);

class Parser {
  private at = 0;
  private depth = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly bound: ReadonlySet<string>,
  ) {}

  private get token(): Token {
    return this.tokens[this.at] as Token;
  }

  private isSymbol(text: string): boolean {
    const t = this.token;
    return t.type === 'symbol' && t.text === text;
  }

  private accept(text: string): boolean {
    if (!this.isSymbol(text)) return false;
    this.at += 1;
    return true;
  }

  private expect(text: string): number {
    const { start, end } = this.token;
    if (!this.accept(text)) throw new ExprError('syntax', `expected ${text}`, start);
    return end;
  }

  private symbolIn(symbols: ReadonlySet<string>): string | undefined {
    const t = this.token;
    if (t.type !== 'symbol' || !symbols.has(t.text)) return undefined;
    this.at += 1;
    return t.text;
  }

  private nested<T>(parse: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_NESTING) throw new ExprError('syntax', 'expression is nested too deeply', this.token.start);
    const result = parse();
    this.depth -= 1;
    return result;
  }

  private node(start: number, end: number, children: readonly Node[], fields: Fields): Node {
    const height = 1 + Math.max(0, ...children.map((c) => c.height));
    if (height > MAX_NESTING) throw new ExprError('syntax', 'expression is nested too deeply', start);
    return { start, end, height, ...fields };
  }

  parse(): Node {
    const root = this.expr();
    if (this.token.type !== 'end')
      throw new ExprError('syntax', 'unexpected text after the expression', this.token.start);
    return root;
  }

  private expr(): Node {
    return this.nested(() => this.cond());
  }

  private cond(): Node {
    const test = this.or();
    if (!this.accept('?')) return test;
    const then = this.expr();
    this.expect(':');
    const otherwise = this.expr();
    return this.node(test.start, otherwise.end, [test, then, otherwise], {
      kind: 'conditional',
      test,
      then,
      otherwise,
    });
  }

  private or(): Node {
    let left = this.and();
    while (this.accept('||')) {
      const right = this.and();
      left = this.node(left.start, right.end, [left, right], { kind: 'logical', op: '||', left, right });
    }
    return left;
  }

  private and(): Node {
    let left = this.cmp();
    while (this.accept('&&')) {
      const right = this.cmp();
      left = this.node(left.start, right.end, [left, right], { kind: 'logical', op: '&&', left, right });
    }
    return left;
  }

  private binary(left: Node, op: string, right: Node): Node {
    return this.node(left.start, right.end, [left, right], { kind: 'binary', op: op as BinaryOperator, left, right });
  }

  private cmp(): Node {
    const left = this.add();
    const op = this.symbolIn(COMPARISONS);
    return op === undefined ? left : this.binary(left, op, this.add());
  }

  private add(): Node {
    let left = this.mul();
    for (;;) {
      const op = this.symbolIn(ADDITIVE);
      if (op === undefined) return left;
      left = this.binary(left, op, this.mul());
    }
  }

  private mul(): Node {
    let left = this.unary();
    for (;;) {
      const op = this.symbolIn(MULTIPLICATIVE);
      if (op === undefined) return left;
      left = this.binary(left, op, this.unary());
    }
  }

  private unary(): Node {
    const { start } = this.token;
    const op = this.symbolIn(PREFIX);
    if (op === undefined) return this.pow();
    const operand = this.nested(() => this.unary());
    return this.node(start, operand.end, [operand], { kind: 'unary', op: op as '-' | '!', operand });
  }

  private pow(): Node {
    const base = this.post();
    if (!this.accept('^')) return base;
    return this.binary(
      base,
      '^',
      this.nested(() => this.unary()),
    );
  }

  private post(): Node {
    const object = this.atom();
    if (!this.accept('.')) return object;
    const t = this.token;
    const axis = t.type === 'name' ? ['x', 'y', 'z'].indexOf(t.text) : -1;
    if (axis < 0) throw new ExprError('syntax', 'expected x, y or z', t.start);
    this.at += 1;
    return this.node(object.start, t.end, [object], { kind: 'member', object, axis: axis as 0 | 1 | 2 });
  }

  private atom(): Node {
    const t = this.token;
    switch (t.type) {
      case 'number':
        this.at += 1;
        return this.quantity(t);
      case 'string':
        this.at += 1;
        return this.node(t.start, t.end, [], { kind: 'text', value: t.value });
      case 'name':
        this.at += 1;
        if (t.text === 'true' || t.text === 'false') {
          return this.node(t.start, t.end, [], { kind: 'boolean', value: t.text === 'true' });
        }
        if (this.isSymbol('(')) return this.call(t.text, t.start);
        if (CONSTANTS.has(t.text)) {
          return this.node(t.start, t.end, [], { kind: 'constant', name: t.text as 'pi' | 'i' | 'j' });
        }
        return this.node(t.start, t.end, [], { kind: 'name', name: t.text });
      case 'symbol':
        if (this.accept('(')) {
          const inner = this.expr();
          this.expect(')');
          return inner;
        }
        throw new ExprError('syntax', `unexpected ${t.text}`, t.start);
      case 'end':
        throw new ExprError('syntax', 'unexpected end of the expression', t.start);
    }
  }

  private call(name: string, start: number): Node {
    this.expect('(');
    const args: Node[] = [];
    if (!this.isSymbol(')')) {
      do args.push(this.expr());
      while (this.accept(','));
    }
    const end = this.expect(')');
    return this.node(start, end, args, { kind: 'call', name, args });
  }

  private isUnit(t: Token): t is Token & { type: 'name' } {
    return t.type === 'name' && isUnitName(t.text) && !this.bound.has(t.text);
  }

  private quantity(number: Token & { type: 'number' }): Node {
    const value = roundDecimal(number.digits, number.exponent);
    const t = this.token;
    if (this.isUnit(t)) {
      this.at += 1;
      return this.node(number.start, t.end, [], {
        kind: 'number',
        value,
        unit: resolveUnit([{ unit: t.text, exponent: 1 }]),
      });
    }
    if (this.accept('[')) {
      const unit = this.compoundUnit();
      const end = this.expect(']');
      return this.node(number.start, end, [], { kind: 'number', value, unit });
    }
    return this.node(number.start, number.end, [], { kind: 'number', value });
  }

  /** A whole text that is one compound unit. */
  parseUnit(): Unit {
    const unit = this.compoundUnit();
    if (this.token.type !== 'end') throw new ExprError('syntax', 'unexpected text after the unit', this.token.start);
    return unit;
  }

  private compoundUnit(): Unit {
    const factors: UnitFactor[] = [];
    let sign = 1;
    for (;;) {
      factors.push(this.unitFactor(sign));
      if (this.accept('*')) sign = 1;
      else if (this.accept('/')) sign = -1;
      else return resolveUnit(factors);
    }
  }

  private unitFactor(sign: number): UnitFactor {
    const t = this.token;
    if (!this.isUnit(t)) throw new ExprError('syntax', 'expected a unit', t.start);
    this.at += 1;
    let exponent = 1;
    if (this.accept('^')) {
      const negative = this.accept('-');
      const digits = this.token;
      if (digits.type !== 'number' || !/^\d+$/.test(digits.text)) {
        throw new ExprError('syntax', 'expected whole digits as a unit exponent', digits.start);
      }
      this.at += 1;
      exponent = Number(digits.digits) * (negative ? -1 : 1);
    }
    return { unit: t.text, exponent: exponent * sign };
  }
}

/**
 * Parses expression text. A name in `bound` is always a name: it never reads
 * as a unit, whatever the unit list holds.
 */
export function parseExpression(text: string, bound: Iterable<string> = []): Node {
  return new Parser(tokenize(text), new Set(bound)).parse();
}

/** Parses the text of a unit, as written between brackets. */
export function parseUnit(text: string): Unit {
  return new Parser(tokenize(text), new Set()).parseUnit();
}
