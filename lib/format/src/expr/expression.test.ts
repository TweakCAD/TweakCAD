import { describe, expect, it } from 'vitest';
import { ExprError, type ExprErrorKind } from './errors';
import {
  compileExpression,
  expressionNames,
  isReservedWord,
  renameInExpression,
  RESERVED_WORDS,
  type ExpressionJson,
  type ExprRef,
} from './expression';

const WIDTH: ExprRef = { parameter: { id: 'par_width' } };
const D7: ExprRef = { value: { id: 'val_d7' } };

function expr(text: string, refs: Record<string, ExprRef> = {}, grammar = 1): ExpressionJson {
  return { text, grammar, refs };
}

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

describe('refs', () => {
  it('accepts every reference kind', () => {
    const kinds: ExprRef[] = [
      WIDTH,
      D7,
      { table: { asset: 'sha256:x' } },
      { library: { id: 'lib_x' } },
      { published: { instance: ['ins_x'], id: 'par_x' } },
    ];
    for (const ref of kinds) expect(() => compileExpression(expr('a', { a: ref }))).not.toThrow();
  });

  it('refuses an unused entry', () => {
    expectError('name', () => compileExpression(expr('a', { a: WIDTH, b: D7 })));
    expectError('name', () => compileExpression(expr('1', { a: WIDTH })));
    expectError('name', () => compileExpression(expr('"a"', { a: WIDTH })));
    expectError('name', () => compileExpression(expr('v.x', { v: WIDTH, x: D7 })));
  });

  it('refuses a name missing from refs', () => {
    expect(() => compileExpression(expr('width * 2 + d7', { width: WIDTH, d7: D7 }))).not.toThrow();
    expectError('name', () => compileExpression(expr('width * 2 + d7', { width: WIDTH })));
    expectError('name', () => compileExpression(expr('width')));
  });

  it('does not take a reserved word for a name, and refuses one used as a name', () => {
    expect(() => compileExpression(expr('pi + 1'))).not.toThrow();
    expect(() => compileExpression(expr('true'))).not.toThrow();
    expect(() => compileExpression(expr('sin(1 deg)'))).not.toThrow();
    expectError('name', () => compileExpression(expr('sin')));
    expectError('name', () => compileExpression(expr('mm')));
  });

  it('does not find a name through the object prototype', () => {
    expectError('name', () => compileExpression(expr('constructor')));
    expectError('name', () => compileExpression(expr('toString')));
    expectError('name', () => compileExpression(expr('toString(1)')));
  });

  it('refuses a reserved word or a malformed name in refs', () => {
    for (const name of ['mm', 'm', 'sin', 'lookup', 'true', 'false', 'pi', 'i', 'j']) {
      expectError('name', () => compileExpression(expr('1', { [name]: WIDTH })));
    }
    expectError('name', () => compileExpression(expr('1', { '1a': WIDTH })));
    expectError('name', () => compileExpression(expr('1', { 'a b': WIDTH })));
  });

  it('pauses on an unknown grammar or reference shape', () => {
    expectError('unknown', () => compileExpression(expr('1', {}, 2)));
    expectError('unknown', () => compileExpression(expr('a', { a: { sensor: { id: 'x' } } as never })));
    expectError('unknown', () => compileExpression(expr('a', { a: { value: { id: 'x' }, table: {} } as never })));
    expectError('unknown', () => compileExpression(expr('a', { a: 'par_x' as never })));
  });

  it('refuses unknown functions and wrong argument counts', () => {
    expectError('name', () => compileExpression(expr('frob(1)')));
    expectError('name', () => compileExpression(expr('width(1)', { width: WIDTH })));
    expectError('name', () => compileExpression(expr('pi(1)')));
    expectError('type', () => compileExpression(expr('sin()')));
    expectError('type', () => compileExpression(expr('sin(1 deg, 2 deg)')));
    expectError('type', () => compileExpression(expr('vector(1, 2)')));
  });

  it('refuses text outside the grammar', () => {
    expectError('syntax', () => compileExpression(expr('1 +')));
  });

  it('lists the names the text uses', () => {
    const compiled = compileExpression(expr('b + a * b.x + sin(1 deg) + pi', { a: WIDTH, b: D7 }));
    expect(expressionNames(compiled)).toEqual(['b', 'a']);
  });

  it('holds every reserved word of the grammar', () => {
    const words = ['abs', 'min', 'max', 'round', 'floor', 'ceil', 'sqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan2'];
    words.push('vector', 'rotate', 'placement', 'lookup', 'true', 'false', 'pi', 'i', 'j');
    words.push('mm', 'cm', 'm', 'um', 'in', 'ft', 'deg', 'rad', 'g', 'kg', 's', 'N', 'MPa');
    expect([...RESERVED_WORDS].sort()).toEqual(words.sort());
    expect(isReservedWord('width')).toBe(false);
    expect(isReservedWord('e')).toBe(false);
  });
});

describe('integrity errors', () => {
  it('holds everything the text alone decides', () => {
    const refused = (text: string, refs: Record<string, ExprRef> = {}): void => {
      try {
        compileExpression(expr(text, refs));
      } catch (e) {
        expect((e as ExprError).integrity, text).toBe(true);
        return;
      }
      expect.unreachable(`expected ${text} to be refused`);
    };
    refused('1 +');
    refused('frob(1)');
    refused('sin()');
    refused('width');
    refused('1', { mm: WIDTH });
    refused('1', { unused: WIDTH });
    refused(`${'('.repeat(300)}1${')'.repeat(300)}`);
    refused('1 [mm^4097]');
  });

  it('leaves what is not understood to pause', () => {
    expect(new ExprError('unknown', 'x').integrity).toBe(false);
    expect(new ExprError('domain', 'x').integrity).toBe(false);
    expect(new ExprError('range', 'x').integrity).toBe(false);
    expect(new ExprError('table', 'x').integrity).toBe(false);
    expect(new ExprError('value', 'x').integrity).toBe(false);
  });
});

describe('renaming', () => {
  it('rewrites the text and keeps the reference', () => {
    const renamed = renameInExpression(expr('width * 2 + d7', { width: WIDTH, d7: D7 }), 'width', 'span');
    expect(renamed).toEqual({ text: 'span * 2 + d7', grammar: 1, refs: { span: WIDTH, d7: D7 } });
  });

  it('touches every use and nothing else', () => {
    const source = expr('x+x.x+"x"+max(x,x)+x/x', { x: WIDTH });
    expect(renameInExpression(source, 'x', 'longer').text).toBe('longer+longer.x+"x"+max(longer,longer)+longer/longer');
  });

  it('keeps the rest of the text byte for byte', () => {
    const source = expr('  a   *\n 2 ', { a: WIDTH });
    expect(renameInExpression(source, 'a', 'b').text).toBe('  b   *\n 2 ');
  });

  it('leaves a name that contains the old one', () => {
    const source = expr('a + aa + a_b', { a: WIDTH, aa: D7, a_b: D7 });
    expect(renameInExpression(source, 'a', 'c').text).toBe('c + aa + a_b');
  });

  it('refuses a clash, a reserved word and a malformed name', () => {
    const source = expr('a + b', { a: WIDTH, b: D7 });
    expectError('name', () => renameInExpression(source, 'a', 'b'));
    expectError('name', () => renameInExpression(source, 'a', 'mm'));
    expectError('name', () => renameInExpression(source, 'a', 'sin'));
    expectError('name', () => renameInExpression(source, 'a', '2x'));
    expectError('name', () => renameInExpression(source, 'c', 'd'));
  });

  it('merges into a name bound to the same target', () => {
    const source = expr('a + b', { a: WIDTH, b: { parameter: { id: 'par_width' } } });
    expect(renameInExpression(source, 'a', 'b')).toEqual(expr('b + b', { b: WIDTH }));
  });

  it('leaves the expression alone when the name does not change', () => {
    const source = expr('a', { a: WIDTH });
    expect(renameInExpression(source, 'a', 'a')).toEqual(source);
  });

  it('refuses to rename in an expression that is not valid', () => {
    expectError('name', () => renameInExpression(expr('1', { a: WIDTH }), 'a', 'b'));
  });
});
