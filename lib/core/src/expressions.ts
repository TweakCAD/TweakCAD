/**
 * Safe expression evaluation for parametric values.
 * Supports: numeric literals, named parameters, + - * / (), unit conversions.
 * Never uses eval() or Function().
 */

import type { Result } from './result.ts';
import { ok, err } from './result.ts';

/** An expression string to be resolved at build time */
export type Expression = string;

/** Resolved parameter values (name → numeric value) */
export type ResolvedParams = Record<string, number>;

/** Token types for the expression tokenizer */
type TokenType = 'number' | 'identifier' | 'operator' | 'paren';

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

    return err(`Unexpected character '${ch}' at position ${i}`);
  }

  return ok(tokens);
}

/**
 * Parse and evaluate an expression using a recursive descent parser.
 * Precedence: + - (lowest) → * / → unary - → ( ) (highest)
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
      const value = params[token.value];
      if (value === undefined) {
        return err(`Unknown parameter: ${token.value}`);
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

  for (const token of tokenResult.value) {
    if (token.type === 'identifier') {
      refs.add(token.value);
    }
  }

  return refs;
}
