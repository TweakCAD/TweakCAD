import { describe, expect, it } from 'vitest';
import { ExprError, type ExprErrorKind } from './errors';
import { MAX_NESTING, parseExpression, parseUnit, type Node } from './parser';
import { tokenize } from './tokenizer';

/** A compact form showing how the text grouped. */
function shape(node: Node): string {
  switch (node.kind) {
    case 'number':
      return node.unit === undefined ? `${node.value}` : `${node.value}u`;
    case 'boolean':
      return `${node.value}`;
    case 'text':
      return JSON.stringify(node.value);
    case 'constant':
    case 'name':
      return node.name;
    case 'call':
      return `${node.name}(${node.args.map(shape).join(' ')})`;
    case 'member':
      return `${shape(node.object)}.${'xyz'.charAt(node.axis)}`;
    case 'unary':
      return `(${node.op}${shape(node.operand)})`;
    case 'binary':
    case 'logical':
      return `(${shape(node.left)} ${node.op} ${shape(node.right)})`;
    case 'conditional':
      return `(${shape(node.test)} ? ${shape(node.then)} : ${shape(node.otherwise)})`;
  }
}

const parsed = (text: string, bound: string[] = []): string => shape(parseExpression(text, bound));

function expectError(kind: ExprErrorKind, run: () => unknown): void {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(ExprError);
    expect((e as ExprError).kind).toBe(kind);
    return;
  }
  expect.unreachable(`expected a ${kind} error`);
}

describe('tokens', () => {
  it('splits numbers, names, texts and symbols', () => {
    expect(tokenize('a<=1.5e3').map((t) => t.type)).toEqual(['name', 'symbol', 'number', 'end']);
    expect(tokenize(' \t\r\n').map((t) => t.type)).toEqual(['end']);
  });

  it('accepts only the two escapes in a text', () => {
    expect(parsed(String.raw`"a\"b\\c"`)).toBe(JSON.stringify('a"b\\c'));
    expect(parsed('"line\nbreak"')).toBe(JSON.stringify('line\nbreak'));
    expectError('syntax', () => parseExpression(String.raw`"a\n"`));
    expectError('syntax', () => parseExpression('"open'));
    expectError('syntax', () => parseExpression('"end\\'));
  });

  it('refuses characters outside the grammar', () => {
    for (const text of ['a = b', 'a & b', 'a | b', '#', 'é', 'a + b', '.5', '5.', '1e']) {
      expectError('syntax', () => parseExpression(text));
    }
  });
});

describe('precedence', () => {
  it('binds ^ tighter than unary minus, and to the right', () => {
    expect(parsed('-2^2')).toBe('(-(2 ^ 2))');
    expect(parsed('2^3^2')).toBe('(2 ^ (3 ^ 2))');
    expect(parsed('2^-1')).toBe('(2 ^ (-1))');
    expect(parsed('2^-3^2')).toBe('(2 ^ (-(3 ^ 2)))');
    expect(parsed('!a')).toBe('(!a)');
    expect(parsed('--a')).toBe('(-(-a))');
  });

  it('orders the binary operators', () => {
    expect(parsed('1 + 2 * 3')).toBe('(1 + (2 * 3))');
    expect(parsed('1 - 2 - 3')).toBe('((1 - 2) - 3)');
    expect(parsed('8 / 2 % 3 * 4')).toBe('(((8 / 2) % 3) * 4)');
    expect(parsed('a + 1 < b * 2')).toBe('((a + 1) < (b * 2))');
    expect(parsed('a < b && c < d || e')).toBe('(((a < b) && (c < d)) || e)');
    expect(parsed('-a * b')).toBe('((-a) * b)');
  });

  it('allows one comparison, without chaining', () => {
    expectError('syntax', () => parseExpression('a < b < c'));
    expectError('syntax', () => parseExpression('a == b == c'));
    expect(parsed('(a < b) == c')).toBe('((a < b) == c)');
  });

  it('nests conditions to the right', () => {
    expect(parsed('a ? b : c ? d : e')).toBe('(a ? b : (c ? d : e))');
    expect(parsed('a ? b ? c : d : e')).toBe('(a ? (b ? c : d) : e)');
    expectError('syntax', () => parseExpression('a ? b'));
  });
});

describe('atoms', () => {
  it('reads true, false, pi and the copy indices apart from names', () => {
    expect(parseExpression('true').kind).toBe('boolean');
    expect(parseExpression('false').kind).toBe('boolean');
    expect(parseExpression('pi').kind).toBe('constant');
    expect(parseExpression('i').kind).toBe('constant');
    expect(parseExpression('j').kind).toBe('constant');
    expect(parseExpression('width').kind).toBe('name');
  });

  it('takes one component after an atom', () => {
    expect(parsed('v.x + w.z')).toBe('(v.x + w.z)');
    expect(parsed('(a + b).y')).toBe('(a + b).y');
    expect(parsed('f(1).z')).toBe('f(1).z');
    expectError('syntax', () => parseExpression('v.w'));
    expectError('syntax', () => parseExpression('v.x.y'));
    expectError('syntax', () => parseExpression('v.1'));
  });

  it('reads calls', () => {
    expect(parsed('f()')).toBe('f()');
    expect(parsed('f(1, g(2), 3)')).toBe('f(1 g(2) 3)');
    expectError('syntax', () => parseExpression('f(1,)'));
    expectError('syntax', () => parseExpression('f(,1)'));
    expectError('syntax', () => parseExpression('f(1'));
  });

  it('refuses empty and unbalanced text', () => {
    for (const text of ['', '(', ')', '(1', '1)', '1 2', 'a b', '1 +', '* 2']) {
      expectError('syntax', () => parseExpression(text));
    }
  });

  it('reads literals to the nearest double', () => {
    const value = (text: string): number => (parseExpression(text) as Node & { kind: 'number' }).value;
    expect(value('0.1')).toBe(0.1);
    expect(value('1.5e3')).toBe(1500);
    expect(value('2E-2')).toBe(0.02);
    expect(value('007')).toBe(7);
    expect(value('1e400')).toBe(Infinity);
    expect(value('1e-400')).toBe(0);
    expect(value('1e99999999999999999999999')).toBe(Infinity);
  });
});

describe('units', () => {
  it('binds a unit only to the number it follows', () => {
    expect(parsed('1000 mm^3')).toBe('(1000u ^ 3)');
    expect(parsed('5 mm + 2')).toBe('(5u + 2)');
    expect(parsed('5mm')).toBe('5u');
    expect(parsed('1.5e3mm')).toBe('1500u');
    expect(parsed('1000 [mm^3]')).toBe('1000u');
    expect(parsed('2 [N/mm]')).toBe('2u');
    expectError('syntax', () => parseExpression('a mm'));
    expectError('syntax', () => parseExpression('(5) mm'));
    expectError('syntax', () => parseExpression('5 mm mm'));
    expectError('syntax', () => parseExpression('a [mm]'));
  });

  it('never reads a bound name as a unit', () => {
    expect(parsed('2 * m', ['m'])).toBe('(2 * m)');
    expectError('syntax', () => parseExpression('2 m', ['m']));
    expectError('syntax', () => parseExpression('2 [m]', ['m']));
    expect(parsed('2 mm', ['m'])).toBe('2u');
  });

  it('leaves a name that is not a unit to fail as a stray token', () => {
    expectError('syntax', () => parseExpression('2 mmm'));
    expectError('syntax', () => parseExpression('2 M'));
    expectError('syntax', () => parseExpression('2 [mmm]'));
  });

  it('reads compound units by the grammar', () => {
    const scale = (text: string): number => parseUnit(text).scale;
    expect(scale('g/cm^3')).toBe(1e-9);
    expect(scale('kg/m^3')).toBe(1e-12);
    expect(scale('N/mm')).toBe(1);
    expect(scale('N*mm')).toBe(1);
    expect(scale('in^2')).toBe(645.16);
    expect(scale('mm^-2')).toBe(1);
    expect(scale('cm^-1')).toBe(0.1);
    expect(scale('mm^0')).toBe(1);
    expect(parseUnit('g/cm^3').dim).toEqual([-3, 1, 0, 0]);
    expect(parseUnit('g/cm/s*mm').dim).toEqual([0, 1, -1, 0]);
    expect(parseUnit('kg*m/s^2').dim).toEqual([1, 1, -2, 0]);
    expect(scale('kg*m/s^2')).toBe(1);
    for (const text of ['', '1/mm', 'mm^', 'mm^1.5', 'mm^2e3', 'mm^+2', 'mm mm', '(mm)', 'mm/', 'mm^x']) {
      expectError('syntax', () => parseUnit(text));
    }
    expectError('syntax', () => parseExpression('1 [mm'));
    expectError('syntax', () => parseExpression('1 []'));
  });

  it('refuses an exponent past the limit', () => {
    expect(parseUnit('mm^4096').dim).toEqual([4096, 0, 0, 0]);
    expectError('syntax', () => parseUnit('mm^4097'));
    expectError('syntax', () => parseUnit('mm^99999999999999999999999'));
  });
});

describe('nesting', () => {
  it('stops before a reader could run out of stack', () => {
    expect(() => parseExpression(`${'('.repeat(MAX_NESTING - 1)}1${')'.repeat(MAX_NESTING - 1)}`)).not.toThrow();
    expectError('syntax', () => parseExpression(`${'('.repeat(100000)}1`));
    expectError('syntax', () => parseExpression(`${'-'.repeat(100000)}1`));
    expectError('syntax', () => parseExpression(`1${'^1'.repeat(100000)}`));
    expectError('syntax', () => parseExpression(`1${'+1'.repeat(100000)}`));
  });
});
