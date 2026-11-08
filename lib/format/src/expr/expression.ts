/**
 * The `{text, grammar, refs}` object of a value's `expr` definition: checking
 * it against its `refs`, and renaming.
 */

import { canonicalize } from '../canonical';
import { ExprError } from './errors';
import { FUNCTION_NAMES, FUNCTIONS } from './functions';
import { parseExpression, type Node } from './parser';
import { UNIT_NAMES } from './units';

/** The one expression grammar this reader knows. */
export const GRAMMAR = 1;

export type ExprRef =
  | { parameter: { id: string } }
  | { value: { id: string } }
  | { table: { asset: string } }
  | { library: { id: string } }
  | { published: { instance: unknown; id: string } };

export interface ExpressionJson {
  text: string;
  grammar: number;
  refs: Record<string, ExprRef>;
}

const REF_KINDS = ['parameter', 'value', 'table', 'library', 'published'];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  ...FUNCTION_NAMES,
  ...UNIT_NAMES,
  'true',
  'false',
  'pi',
  'i',
  'j',
]);

export function isReservedWord(name: string): boolean {
  return RESERVED_WORDS.has(name);
}

/** A checked expression, ready to evaluate. */
export interface CompiledExpression {
  ast: Node;
  refs: ReadonlyMap<string, ExprRef>;
}

function children(node: Node): readonly Node[] {
  switch (node.kind) {
    case 'call':
      return node.args;
    case 'member':
      return [node.object];
    case 'unary':
      return [node.operand];
    case 'binary':
    case 'logical':
      return [node.left, node.right];
    case 'conditional':
      return [node.test, node.then, node.otherwise];
    default:
      return [];
  }
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

function checkBinding(name: string, ref: unknown): void {
  if (!NAME.test(name)) throw new ExprError('name', `${JSON.stringify(name)} is not a name`);
  if (isReservedWord(name)) throw new ExprError('name', `${name} is reserved and cannot be in refs`);
  const keys = typeof ref === 'object' && ref !== null ? Object.keys(ref) : [];
  if (keys.length !== 1 || !REF_KINDS.includes(keys[0] as string)) {
    throw new ExprError('unknown', `the reference of ${name} has an unknown shape`);
  }
}

/**
 * Checks what the text alone decides: a known grammar, valid `refs`, every
 * name in the text bound, every `refs` entry used, and every call to a known
 * function with a fitting number of arguments.
 */
export function compileExpression(expression: ExpressionJson): CompiledExpression {
  if (expression.grammar !== GRAMMAR) {
    throw new ExprError('unknown', `unknown expression grammar ${expression.grammar}`);
  }
  const refs = new Map(Object.entries(expression.refs));
  refs.forEach((ref, name) => checkBinding(name, ref));
  const ast = parseExpression(expression.text, refs.keys());
  const used = new Set<string>();
  walk(ast, (node) => {
    if (node.kind === 'name') {
      if (!refs.has(node.name)) throw new ExprError('name', `${node.name} is not in refs`, node.start);
      used.add(node.name);
    }
    if (node.kind === 'call') {
      const definition = FUNCTIONS.get(node.name);
      if (definition === undefined) throw new ExprError('name', `unknown function ${node.name}`, node.start);
      if (node.args.length < definition.min || node.args.length > definition.max) {
        throw new ExprError('type', `${node.name} cannot take ${node.args.length} arguments`, node.start);
      }
    }
  });
  for (const name of refs.keys()) {
    if (!used.has(name)) throw new ExprError('name', `${name} is in refs but not in the text`);
  }
  return { ast, refs };
}

/** Every name the text uses, each once, in order of first use. */
export function expressionNames(compiled: CompiledExpression): string[] {
  const names = new Set<string>();
  walk(compiled.ast, (node) => {
    if (node.kind === 'name') names.add(node.name);
  });
  return [...names];
}

/**
 * Renames a name in an expression: the text is rewritten at every use of the
 * name and nowhere else, and the name's reference is kept under the new name.
 */
export function renameInExpression(expression: ExpressionJson, from: string, to: string): ExpressionJson {
  const { ast, refs } = compileExpression(expression);
  const ref = refs.get(from);
  if (ref === undefined) throw new ExprError('name', `${from} is not in refs`);
  if (from === to) return expression;
  const existing = refs.get(to);
  if (existing !== undefined && canonicalize(existing) !== canonicalize(ref)) {
    throw new ExprError('name', `${to} is already bound to something else`);
  }
  checkBinding(to, ref);

  const uses: Node[] = [];
  walk(ast, (node) => {
    if (node.kind === 'name' && node.name === from) uses.push(node);
  });
  let text = expression.text;
  for (const use of uses.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, use.start) + to + text.slice(use.end);
  }
  const renamed: Record<string, ExprRef> = {};
  for (const [name, target] of refs) renamed[name === from ? to : name] = target;
  return { ...expression, text, refs: renamed };
}
