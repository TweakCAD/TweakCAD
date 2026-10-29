/**
 * Safe expression evaluation for parametric values.
 * Supports: numeric literals, named parameters, + - * / (), function calls,
 * unit conversions.
 * Never uses eval() or Function().
 */

import type { Result } from './result.ts';
import { ok, err } from './result.ts';

/** An expression string to be resolved at build time */
export type Expression = string;

/** Resolved parameter values (name → numeric value) */
export type ResolvedParams = Record<string, number>;

/** Token types for the expression tokenizer */
type TokenType = 'number' | 'identifier' | 'operator' | 'paren' | 'comma';

type Token = {
  type: TokenType;
  value: string;
};

/**
 * Tokenize an expression string.
 * @param expr - Expression string to tokenize
 * @returns Array of tokens
 */
function tokenize(expr: string): Result<Token[], string> {
  const tokens: Token[] = [];
  let i = 0;
  const input = expr.trim();

  while (i < input.length) {
    const ch = input[i]!;

    // Skip whitespace
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }

    // Numbers (including decimals)
    if (ch >= '0' && ch <= '9' || ch === '.') {
      let num = '';
      while (i < input.length && ((input[i]! >= '0' && input[i]! <= '9') || input[i] === '.')) {
        num += input[i]!;
        i++;
      }
      // Reject a second decimal point rather than letting parseFloat take the
      // leading part of it. `1.2.3` used to tokenize whole and evaluate to
      // 1.2, and `2..5` to 2 — a mistyped dimension became a wrong number
      // instead of an error, which is the one outcome this module is supposed
      // to prevent.
      if ((num.match(/\./g)?.length ?? 0) > 1 || num === '.') {
        return err(`Malformed number: '${num}'`);
      }
      tokens.push({ type: 'number', value: num });
      continue;
    }

    // Identifiers (parameter names)
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let ident = '';
      while (
        i < input.length &&
        ((input[i]! >= 'a' && input[i]! <= 'z') ||
          (input[i]! >= 'A' && input[i]! <= 'Z') ||
          (input[i]! >= '0' && input[i]! <= '9') ||
          input[i] === '_')
      ) {
        ident += input[i]!;
        i++;
      }
      tokens.push({ type: 'identifier', value: ident });
      continue;
    }

    // Operators
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'operator', value: ch });
      i++;
      continue;
    }

    // Parentheses
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }

    // Argument separator. Only meaningful inside a function call; anywhere
    // else the parser rejects it, which is why it needs no context here.
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch });
      i++;
      continue;
    }

    return err(`Unexpected character '${ch}' at position ${i}`);
  }

  return ok(tokens);
}

/**
 * Parse and evaluate an expression using a recursive descent parser.
 * Precedence: + - (lowest) → * / → unary - → function call, ( ) (highest)
 *
 * @param tokens - Token array
 * @param params - Resolved parameter values
 * @returns Numeric result
 */
function parseExpression(tokens: Token[], params: ResolvedParams): Result<number, string> {
  let pos = 0;

  function peek(): Token | undefined {
    return tokens[pos];
  }

  function consume(): Token | undefined {
    const t = tokens[pos];
    pos++;
    return t;
  }

  function parseAddSub(): Result<number, string> {
    const leftResult = parseMulDiv();
    if (!leftResult.ok) return leftResult;
    let left = leftResult.value;

    while (peek()?.type === 'operator' && (peek()!.value === '+' || peek()!.value === '-')) {
      const op = consume()!.value;
      const rightResult = parseMulDiv();
      if (!rightResult.ok) return rightResult;
      left = op === '+' ? left + rightResult.value : left - rightResult.value;
    }

    return ok(left);
  }

  function parseMulDiv(): Result<number, string> {
    const leftResult = parseUnary();
    if (!leftResult.ok) return leftResult;
    let left = leftResult.value;

    while (peek()?.type === 'operator' && (peek()!.value === '*' || peek()!.value === '/')) {
      const op = consume()!.value;
      const rightResult = parseUnary();
      if (!rightResult.ok) return rightResult;
      if (op === '/' && rightResult.value === 0) {
        return err('Division by zero');
      }
      left = op === '*' ? left * rightResult.value : left / rightResult.value;
    }

    return ok(left);
  }

  function parseUnary(): Result<number, string> {
    if (peek()?.type === 'operator' && peek()!.value === '-') {
      consume();
      const result = parsePrimary();
      if (!result.ok) return result;
      return ok(-result.value);
    }
    return parsePrimary();
  }

  function parsePrimary(): Result<number, string> {
    const token = peek();

    if (!token) {
      return err('Unexpected end of expression');
    }

    if (token.type === 'number') {
      consume();
      const value = parseFloat(token.value);
      if (isNaN(value)) return err(`Invalid number: ${token.value}`);
      return ok(value);
    }

    if (token.type === 'identifier') {
      consume();
      const name = token.value;

      // An identifier followed by '(' is a call. Checking the NEXT token
      // rather than a name list is what lets a parameter share a name with
      // a function without either shadowing the other.
      if (peek()?.type === 'paren' && peek()!.value === '(') {
        consume(); // '('
        const args: number[] = [];
        if (peek()?.value !== ')') {
          for (;;) {
            const arg = parseAddSub();
            if (!arg.ok) return arg;
            args.push(arg.value);
            if (peek()?.type === 'comma') { consume(); continue; }
            break;
          }
        }
        if (peek()?.value !== ')') {
          return err(`Missing closing parenthesis in ${name}()`);
        }
        consume(); // ')'
        return applyFunction(name, args);
      }

      const value = params[name];
      if (value === undefined) {
        // A known function used without parentheses is a likelier mistake
        // than a parameter nobody declared, so say so.
        if (isBuiltInFunction(name)) {
          return err(`${name} is a function — write ${name}(...)`);
        }
        return err(`Unknown parameter: ${name}`);
      }
      return ok(value);
    }

    if (token.type === 'paren' && token.value === '(') {
      consume();
      const result = parseAddSub();
      if (!result.ok) return result;
      if (peek()?.value !== ')') {
        return err('Missing closing parenthesis');
      }
      consume();
      return result;
    }

    return err(`Unexpected token: ${token.value}`);
  }

  const result = parseAddSub();
  if (!result.ok) return result;

  if (pos < tokens.length) {
    return err(`Unexpected token after expression: ${tokens[pos]!.value}`);
  }

  return result;
}

// --- Built-in functions ----------------------------------------------------

/**
 * Functions callable from an expression.
 *
 * **Trigonometry is in degrees.** Every angle the document stores is already
 * in degrees — a countersink's included angle, a circular pattern's sweep, the
 * rotation fields in the placement panel — so `sin(90)` meaning 1 is the
 * answer that matches the rest of the app. Radians would make the one
 * expression a user is most likely to write silently wrong, and a wrong number
 * is worse than a rejected one.
 *
 * No constants (`pi`, `e`). A bare identifier is a parameter reference, and
 * introducing names that are *sometimes* parameters would mean deciding what
 * happens when a user defines one — shadowing rules that `extractParameterRefs`
 * cannot see, so a dependency would go untracked. Degree-based trig removes
 * most of the need; a user who wants π can declare it.
 */
type BuiltIn = {
  /** Exact argument count, or `'variadic'` for one or more. */
  arity: number | 'variadic';
  apply: (args: number[]) => number;
};

const DEG = Math.PI / 180;

const FUNCTIONS: Record<string, BuiltIn> = {
  abs: { arity: 1, apply: ([x]) => Math.abs(x!) },
  sqrt: { arity: 1, apply: ([x]) => Math.sqrt(x!) },
  floor: { arity: 1, apply: ([x]) => Math.floor(x!) },
  ceil: { arity: 1, apply: ([x]) => Math.ceil(x!) },
  round: { arity: 1, apply: ([x]) => Math.round(x!) },
  sign: { arity: 1, apply: ([x]) => Math.sign(x!) },

  min: { arity: 'variadic', apply: (xs) => Math.min(...xs) },
  max: { arity: 'variadic', apply: (xs) => Math.max(...xs) },
  hypot: { arity: 'variadic', apply: (xs) => Math.hypot(...xs) },
  pow: { arity: 2, apply: ([a, b]) => Math.pow(a!, b!) },

  sin: { arity: 1, apply: ([d]) => Math.sin(d! * DEG) },
  cos: { arity: 1, apply: ([d]) => Math.cos(d! * DEG) },
  tan: { arity: 1, apply: ([d]) => Math.tan(d! * DEG) },
  asin: { arity: 1, apply: ([x]) => Math.asin(x!) / DEG },
  acos: { arity: 1, apply: ([x]) => Math.acos(x!) / DEG },
  atan: { arity: 1, apply: ([x]) => Math.atan(x!) / DEG },
  atan2: { arity: 2, apply: ([y, x]) => Math.atan2(y!, x!) / DEG },
};

/** True when `name` is a built-in rather than a parameter reference. */
export function isBuiltInFunction(name: string): boolean {
  return Object.hasOwn(FUNCTIONS, name);
}

/**
 * Apply a built-in, rejecting the results that would otherwise poison the
 * rest of the expression.
 *
 * `sqrt(-1)` and `asin(2)` are NaN in JavaScript, and NaN propagates silently
 * through every subsequent operation until it reaches the kernel as a
 * dimension. Failing at the call names the function that went wrong.
 */
function applyFunction(name: string, args: number[]): Result<number, string> {
  const fn = FUNCTIONS[name];
  if (!fn) return err(`Unknown function: ${name}`);

  if (fn.arity === 'variadic') {
    if (args.length === 0) return err(`${name}() needs at least one argument`);
  } else if (args.length !== fn.arity) {
    return err(
      `${name}() takes ${fn.arity} argument${fn.arity === 1 ? '' : 's'}, got ${args.length}`,
    );
  }

  const value = fn.apply(args);
  if (!Number.isFinite(value)) {
    return err(`${name}(${args.join(', ')}) is not a finite number`);
  }
  return ok(value);
}

/**
 * Evaluate an expression string with the given parameters.
 * @param expr - Expression string (e.g., "width / 2 + 10")
 * @param params - Map of parameter names to resolved numeric values
 * @returns The numeric result or an error message
 */
export function evaluateExpression(expr: Expression, params: ResolvedParams = {}): Result<number, string> {
  if (expr.trim() === '') return err('Empty expression');

  const tokenResult = tokenize(expr);
  if (!tokenResult.ok) return tokenResult;

  return parseExpression(tokenResult.value, params);
}

/**
 * Extract parameter names referenced in an expression.
 * Used for dependency tracking and circular dependency detection.
 * @param expr - Expression string
 * @returns Set of parameter names referenced
 */
export function extractParameterRefs(expr: Expression): Set<string> {
  const refs = new Set<string>();
  const tokenResult = tokenize(expr);
  if (!tokenResult.ok) return refs;

  const tokens = tokenResult.value;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type !== 'identifier') continue;
    // A call is not a reference. Letting `sqrt` through would put it in the
    // parameter dependency graph as a node nothing defines, and the
    // topological sort would be resolving a parameter that does not exist.
    const next = tokens[i + 1];
    if (next?.type === 'paren' && next.value === '(') continue;
    refs.add(token.value);
  }

  return refs;
}
