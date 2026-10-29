/**
 * Expression evaluation, with an emphasis on the function calls that were the
 * gap: before these, `2 * length + 5` worked but `sqrt(2) * length` failed at
 * the `(`, which rules out most of the arithmetic a real parametric part
 * needs.
 */
import { describe, expect, it } from 'vitest';
import { evaluateExpression, extractParameterRefs } from './expressions.ts';

const P = { width: 10, height: 4, len: 100 };

/** Value of an expression, or the error string if it failed. */
function value(expr: string, params = P): number | string {
  const r = evaluateExpression(expr, params);
  return r.ok ? r.value : r.error;
}

describe('arithmetic (unchanged behaviour)', () => {
  it.each([
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['-width', -10],
    ['width / height', 2.5],
    ['width * 2 + 5', 25],
  ])('%s = %s', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  it('still rejects division by zero rather than returning Infinity', () => {
    expect(value('width / 0')).toMatch(/Division by zero/);
  });
});

describe('function calls', () => {
  it('evaluates the case that used to fail at the paren', () => {
    expect(value('sqrt(2) * 100')).toBeCloseTo(141.42135, 4);
  });

  it.each([
    ['abs(-7)', 7],
    ['sqrt(16)', 4],
    ['floor(7.9)', 7],
    ['ceil(7.1)', 8],
    ['round(7.5)', 8],
    ['sign(-3)', -1],
    ['pow(2, 10)', 1024],
    ['hypot(3, 4)', 5],
  ])('%s = %s', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  it('takes any number of arguments for min/max/hypot', () => {
    expect(value('min(5, 2, 9)')).toBe(2);
    expect(value('max(5, 2, 9)')).toBe(9);
    expect(value('hypot(2, 3, 6)')).toBe(7);
  });

  it('nests calls and mixes them with arithmetic and parameters', () => {
    expect(value('max(width, height) * 2 + sqrt(pow(3, 2))')).toBe(23);
  });

  it('allows an expression as an argument', () => {
    expect(value('sqrt(width * 10)')).toBe(10);
  });
});

describe('trigonometry is in degrees', () => {
  // Every angle the document stores is in degrees, so radians here would make
  // the most likely expression a user writes silently wrong.
  it.each([
    ['sin(90)', 1],
    ['cos(0)', 1],
    ['sin(30)', 0.5],
    ['atan2(1, 1)', 45],
    ['asin(1)', 90],
    ['acos(0)', 90],
  ])('%s ≈ %s', (expr, expected) => {
    expect(value(expr) as number).toBeCloseTo(expected, 9);
  });

  it('round-trips an angle through tan and atan', () => {
    expect(value('atan(tan(35))') as number).toBeCloseTo(35, 9);
  });
});

describe('failures name what went wrong', () => {
  it('rejects a NaN result instead of letting it propagate', () => {
    // sqrt(-1) is NaN in JavaScript, and NaN survives every subsequent
    // operation — it would reach the kernel as a dimension.
    expect(value('sqrt(-1)')).toMatch(/not a finite number/);
    expect(value('asin(2) + 5')).toMatch(/not a finite number/);
  });

  it('rejects the wrong argument count, saying how many it wanted', () => {
    expect(value('pow(2)')).toMatch(/takes 2 arguments, got 1/);
    expect(value('sqrt(1, 2)')).toMatch(/takes 1 argument, got 2/);
    expect(value('min()')).toMatch(/at least one argument/);
  });

  it('names an unknown function as a function, not a parameter', () => {
    expect(value('wobble(2)')).toMatch(/Unknown function: wobble/);
  });

  it('suggests parentheses when a function is used bare', () => {
    // The likelier mistake than a parameter nobody declared.
    expect(value('sqrt * 2')).toMatch(/sqrt is a function/);
  });

  it('still reports a genuinely unknown parameter as one', () => {
    expect(value('wibble * 2')).toMatch(/Unknown parameter: wibble/);
  });

  it('rejects a missing closing paren inside a call', () => {
    expect(value('sqrt(4')).toMatch(/Missing closing parenthesis/);
  });

  it('rejects a stray comma outside a call', () => {
    expect(value('width, height')).toMatch(/Unexpected token/);
  });
});

describe('extractParameterRefs', () => {
  it('collects parameter names', () => {
    expect([...extractParameterRefs('width * 2 + height')]).toEqual(['width', 'height']);
  });

  it('does not treat function names as parameters', () => {
    // These feed the parameter dependency graph and its topological sort.
    // Leaking `sqrt` in would make the resolver look for a parameter that
    // nothing declares.
    expect([...extractParameterRefs('sqrt(width) + max(height, 2)')])
      .toEqual(['width', 'height']);
  });

  it('keeps a parameter that merely shares a prefix with a function', () => {
    expect([...extractParameterRefs('minimum + maxWidth')])
      .toEqual(['minimum', 'maxWidth']);
  });

  it('lets a parameter and a function share a name', () => {
    // The call is decided by the following `(`, not by a reserved-word list,
    // so a parameter called `round` stays usable.
    expect([...extractParameterRefs('round + round(1.5)')]).toEqual(['round']);
    expect(evaluateExpression('round + round(1.4)', { round: 10 })).toEqual({
      ok: true, value: 11,
    });
  });
});

describe('malformed numbers are rejected, not silently truncated', () => {
  // The tokenizer consumed any run of digits and dots and handed the result
  // to parseFloat, so a typo became a plausible wrong number rather than an
  // error — the one failure mode a parameter expression must not have.
  it.each(['1.2.3', '2..5', '1.2.3.4', '.'])('rejects %s', (expr) => {
    const result = evaluateExpression(expr, {});
    expect(result.ok).toBe(false);
  });

  it('names the offending token', () => {
    const result = evaluateExpression('1.2.3', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Malformed number/);
  });

  it('still accepts the forms that are genuinely numbers', () => {
    expect(evaluateExpression('1.5', {})).toEqual({ ok: true, value: 1.5 });
    expect(evaluateExpression('.5', {})).toEqual({ ok: true, value: 0.5 });
    expect(evaluateExpression('42', {})).toEqual({ ok: true, value: 42 });
    expect(evaluateExpression('2.0 * 3.5', {})).toEqual({ ok: true, value: 7 });
  });

  it('rejects a malformed number nested in a larger expression', () => {
    // Where it would actually bite: a dimension typed into a dialog.
    expect(evaluateExpression('width * 1.2.3', { width: 10 }).ok).toBe(false);
  });
});
