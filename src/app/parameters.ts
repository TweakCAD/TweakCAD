/**
 * Parameters and configurations as the parameters dialog edits them, over
 * the editor's commands (6.1, 6.2, 7.4).
 *
 * - The document and each part have parameter tables; the dialog lists
 *   every parameter of a scope and adds new ones to its first table (made
 *   when there is none). A parameter's value is an expression over the
 *   table parameters it may see (6.4): the document's for a document
 *   parameter, the document's and the part's for a part parameter.
 * - A part's configurations are presets: a choice
 *   parameter (`configuration`) names the rows, and each row overrides some
 *   of the part's parameters. The parameter's value is the active row; the
 *   browser switches it.
 */
import { ValueEvaluator, toStored, type ValueTarget } from '@tweakcad/format';
import {
  CommandError,
  bindExpression,
  withDefaultUnit,
  type CommandResult,
  type Doc,
  type Editor,
  type Json,
} from '@tweakcad/editor';
import { partOf } from './features';

export type ParameterKind = 'length' | 'angle' | 'number' | 'integer' | 'boolean' | 'choice' | 'text';

export const KINDS: { id: ParameterKind; label: string; unit?: string }[] = [
  { id: 'length', label: 'Length', unit: 'mm' },
  { id: 'angle', label: 'Angle', unit: 'deg' },
  { id: 'number', label: 'Number' },
  { id: 'integer', label: 'Count' },
  { id: 'boolean', label: 'Yes / no' },
  { id: 'choice', label: 'Choice' },
  { id: 'text', label: 'Text' },
];

export interface ParameterView {
  id: string;
  table: string;
  name: string;
  kind: ParameterKind;
  /** The value object's id and expression text. */
  value: string;
  text: string;
  options: string[];
  description: string;
  /** An insertion of this document may set it (6.2); shown in Edit Component. */
  public: boolean;
}

/** A scope of the dialog: the document, or a part. */
export type ParameterScope = { document: true } | { part: string };

function tablesOf(doc: Doc, scope: ParameterScope): Json[] {
  const owner = 'document' in scope ? doc : partOf(doc, scope.part);
  return Array.isArray(owner?.parameters) ? (owner.parameters as Json[]) : [];
}

export function kindOf(row: Json): ParameterKind {
  switch (row.type) {
    case 'number':
      return row.quantity === 'length' ? 'length' : row.quantity === 'angle' ? 'angle' : 'number';
    case 'integer':
    case 'boolean':
    case 'choice':
    case 'text':
      return row.type;
    default:
      return 'text';
  }
}

/** The value target of a parameter row, for binding its expressions. */
export function targetOf(row: { type?: unknown; quantity?: unknown; options?: unknown }): {
  type: string;
  quantity?: string;
  options?: string[];
} {
  const type = String(row.type);
  if (type === 'number') return { type, quantity: typeof row.quantity === 'string' ? row.quantity : 'ratio' };
  if (type === 'choice') return { type, options: Array.isArray(row.options) ? (row.options as string[]) : [] };
  return { type };
}

export function parametersOf(doc: Doc, scope: ParameterScope): ParameterView[] {
  return tablesOf(doc, scope).flatMap((t) =>
    (Array.isArray(t.parameters) ? (t.parameters as Json[]) : []).map((p) => {
      const value = p.value as Json;
      const expr = (value.def as Json | undefined)?.expr as Json | undefined;
      return {
        id: String(p.id),
        table: String(t.id),
        name: String(p.name),
        kind: kindOf(p),
        value: String(value.id),
        text: typeof expr?.text === 'string' ? expr.text : '',
        options: Array.isArray(p.options) ? (p.options as string[]) : [],
        description: typeof p.description === 'string' ? p.description : '',
        public: p.public === true,
      };
    }),
  );
}

/** Where a scope's table expressions are bound: a part with no feature, or no part for the document. */
function scopeOf(scope: ParameterScope): { part: string; feature: string } {
  return { part: 'part' in scope ? scope.part : '', feature: '' };
}

/** Field text as an expression of `kind`: a bare number takes the kind's unit; a choice or text is quoted. */
export function expressionText(kind: ParameterKind, text: string): string {
  const unit = KINDS.find((k) => k.id === kind)?.unit;
  if (unit) return withDefaultUnit(text, unit);
  if ((kind === 'choice' || kind === 'text') && !/^\s*".*"\s*$/.test(text)) return JSON.stringify(text.trim());
  return text;
}

export type Evaluated = { ok: true; def: Json; stored: unknown } | { ok: false; message: string };

/** Binds a parameter value's text in its scope, against the parameter's type. */
export function bindParameter(
  doc: Doc,
  scope: ParameterScope,
  row: { type?: unknown; quantity?: unknown; options?: unknown },
  kind: ParameterKind,
  text: string,
): Evaluated {
  const bound = bindExpression(doc, scopeOf(scope), expressionText(kind, text), targetOf(row) as never);
  return bound.ok ? { ok: true, def: bound.def, stored: bound.stored } : bound;
}

/** The value a parameter shows now, as text with its unit, or why it has none. */
export function evaluatedText(doc: Doc, scope: ParameterScope, p: ParameterView): string {
  const b = bindExpression(doc, scopeOf(scope), p.text, kindTarget(p.kind, p.options) as never);
  return b.ok ? storedText(p.kind, b.stored) : '—';
}

/** A parameter as the browser lists it: its value under the selected configurations, and the row that sets it, if one does. */
export interface ShownParameter {
  id: string;
  name: string;
  /** What it comes to now: a number with its unit, a text or choice as itself (no quotes, as the parameter table shows it); '—' when it comes to nothing. */
  value: string;
  /** Its own expression text. */
  text: string;
  /** The configuration row that sets it now (the option's name), or null when its own expression does. */
  configured: string | null;
}

/**
 * The document's parameters and those of `part`, as the browser lists them:
 * each with what it comes to under the configuration rows selected now, as
 * the model is built, and the row that overrides it.
 */
export function shownParameters(doc: Doc, part: string | null): ShownParameter[] {
  let evaluator: ValueEvaluator | null = null;
  try {
    evaluator = new ValueEvaluator(doc);
  } catch {
    evaluator = null;
  }
  const configured = new Map<string, string>();
  for (const c of part ? configurationsOf(doc, part) : []) {
    const row = c.rows.find((r) => r.option === c.active);
    for (const id of row?.overrides.keys() ?? []) configured.set(id, c.active as string);
  }
  const scopes: ParameterScope[] = [{ document: true }, ...(part ? [{ part }] : [])];
  return scopes.flatMap((scope) =>
    parametersOf(doc, scope).map((p) => {
      let value = '—';
      try {
        if (evaluator) {
          const stored = toStored(evaluator.parameter(p.id), kindTarget(p.kind, p.options) as ValueTarget);
          value = storedText(p.kind, stored);
        }
      } catch {
        value = '—';
      }
      return { id: p.id, name: p.name, value, text: p.text, configured: configured.get(p.id) ?? null };
    }),
  );
}

/** A stored value as the dialog shows it: a number with its kind's unit, anything else as itself. */
export function storedText(kind: ParameterKind, stored: unknown): string {
  const unit = KINDS.find((k) => k.id === kind)?.unit;
  if (typeof stored === 'number') return `${Number(stored.toFixed(6))}${unit ? ` ${unit}` : ''}`;
  return String(stored);
}

/** What field text of a parameter of `kind` comes to in `scope`, or why it comes to nothing. */
export function previewText(
  doc: Doc,
  scope: ParameterScope,
  kind: ParameterKind,
  options: readonly string[],
  text: string,
): { ok: true; text: string } | { ok: false; message: string } {
  const b = bindExpression(doc, scopeOf(scope), expressionText(kind, text), kindTarget(kind, options) as never);
  return b.ok ? { ok: true, text: storedText(kind, b.stored) } : b;
}

/** The value target a parameter of `kind` is evaluated against. */
export function kindTarget(
  kind: ParameterKind,
  options: readonly string[] = [],
): { type: string; quantity?: string; options?: string[] } {
  return targetOf({ ...kindToType(kind), options: [...options] });
}

function kindToType(kind: ParameterKind): { type: string; quantity?: string } {
  if (kind === 'length') return { type: 'number', quantity: 'length' };
  if (kind === 'angle') return { type: 'number', quantity: 'angle' };
  if (kind === 'number') return { type: 'number', quantity: 'ratio' };
  return { type: kind };
}

function check(r: CommandResult): CommandResult {
  if (!r.ok) throw new CommandError(r.error.code, r.error.message);
  return r;
}

function asResult(body: () => CommandResult): CommandResult {
  try {
    return body();
  } catch (e) {
    if (e instanceof CommandError) return { ok: false, error: e.toFailure() };
    throw e;
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The first `param_N` no parameter of the scope is named, N counting on from the parameters it has. */
export function suggestedName(params: readonly { name: string }[]): string {
  const taken = new Set(params.map((p) => p.name));
  let n = params.length + 1;
  while (taken.has(`param_${n}`)) n++;
  return `param_${n}`;
}

/** Adds a parameter to the scope's first table (made when there is none), as one undo step. */
export function addParameter(
  editor: Editor,
  scope: ParameterScope,
  name: string,
  kind: ParameterKind,
  text: string,
  options: string[] = [],
  extra: { public?: boolean; description?: string } = {},
): CommandResult {
  if (!NAME.test(name))
    return {
      ok: false,
      error: { code: 'invalid', message: 'A name is letters, digits and _, not starting with a digit' },
    };
  const { type, quantity } = kindToType(kind);
  const row: Json = { type, ...(quantity ? { quantity } : {}), ...(kind === 'choice' ? { options } : {}) };
  const bound = bindParameter(editor.document, scope, row, kind, text);
  if (!bound.ok) return { ok: false, error: { code: 'invalid', message: bound.message } };
  const parameter: Json = {
    id: editor.newId('par'),
    name,
    ...row,
    value: { id: editor.newId('val'), def: bound.def },
    range: { unbounded: {} },
    public: extra.public === true,
    published: false,
    description: extra.description?.trim() ?? '',
  };
  const owner = 'document' in scope ? String(editor.document.id) : scope.part;
  return asResult(() =>
    editor.transaction(`Add ${name}`, () => {
      let table = tablesOf(editor.document, scope)[0]?.id as string | undefined;
      if (!table) {
        table = editor.newId('tbl');
        check(
          editor.dispatch({
            type: 'addParameterTable',
            owner,
            table: { id: table, name: 'Parameters', parameters: [] },
          }),
        );
      }
      return check(editor.dispatch({ type: 'addParameter', table, parameter }));
    }),
  );
}

/** Sets a parameter's value from field text. */
export function setParameterText(editor: Editor, scope: ParameterScope, p: ParameterView, text: string): CommandResult {
  const bound = bindParameter(editor.document, scope, { ...kindToType(p.kind), options: p.options }, p.kind, text);
  if (!bound.ok) return { ok: false, error: { code: 'invalid', message: bound.message } };
  return editor.dispatch({ type: 'setValueDef', value: p.value, def: bound.def });
}

/** Field text of a parameter: a choice or text without its quotes. */
export const fieldOf = (p: { kind: ParameterKind; text: string }): string =>
  p.kind === 'choice' || p.kind === 'text' ? (/^\s*"(.*)"\s*$/.exec(p.text)?.[1] ?? p.text) : p.text;

/** True when a parameter selects the rows of one of its part's configurations: its kind and options are the configuration's. */
export function isConfigurationInput(doc: Doc, p: ParameterView): boolean {
  return [...((doc.parts as Json[] | undefined) ?? [])].some((part) =>
    ((part.configurations as Json[] | undefined) ?? []).some((c) => (c.input as Json | undefined)?.id === p.id),
  );
}

const KIND_DEFAULT: Record<ParameterKind, string> = {
  length: '0',
  angle: '0',
  number: '0',
  integer: '0',
  boolean: 'false',
  choice: 'option_1',
  text: '',
};

/**
 * Changes a parameter's kind, as one undo step. Its value is kept when it
 * reads as the new kind (a length's number as a plain number, say);
 * otherwise it becomes the kind's zero. A new choice has one option, the
 * value as it was (or "option_1").
 */
export function setParameterKind(
  editor: Editor,
  scope: ParameterScope,
  p: ParameterView,
  kind: ParameterKind,
): CommandResult {
  if (kind === p.kind) return { ok: true, label: '', changed: false };
  if (isConfigurationInput(editor.document, p))
    return {
      ok: false,
      error: { code: 'not-allowed', message: `${p.name} chooses a configuration's row, so it stays a choice` },
    };
  // A plain number keeps its number, not its old unit ("25 mm" becomes the choice "25").
  const unit = KINDS.find((k) => k.id === p.kind)?.unit;
  const shown = unit
    ? fieldOf(p).replace(new RegExp(`^\\s*([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?)\\s*${unit}\\s*$`, 'i'), '$1')
    : fieldOf(p);
  const options =
    kind === 'choice' ? [/^[^,]+$/.test(shown.trim()) && shown.trim() !== '' ? shown.trim() : 'option_1'] : [];
  const { type, quantity } = kindToType(kind);
  const row = { type, ...(quantity ? { quantity } : {}), ...(kind === 'choice' ? { options } : {}) };
  const number = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/i.exec(shown)?.[1];
  const candidates =
    kind === 'choice' ? [options[0] as string] : [shown, ...(number ? [number] : []), KIND_DEFAULT[kind]];
  let bound: Evaluated = { ok: false, message: `${p.name} has no value as a ${kind}` };
  for (const text of candidates) {
    bound = bindParameter(editor.document, scope, row, kind, text);
    if (bound.ok) break;
  }
  if (!bound.ok) return { ok: false, error: { code: 'invalid', message: bound.message } };
  const unset = ['quantity', 'options'].filter((f) => !(f in row));
  // The type and the value change together: either alone is a value of the wrong type.
  const stored = tablesOf(editor.document, scope)
    .flatMap((t) => (Array.isArray(t.parameters) ? (t.parameters as Json[]) : []))
    .find((x) => x.id === p.id);
  const value = { ...((stored?.value as Json | undefined) ?? { id: p.value }), def: bound.def };
  const label = `Make ${p.name} ${KINDS.find((k) => k.id === kind)?.label ?? kind}`;
  return asResult(() =>
    editor.transaction(label, () =>
      check(editor.dispatch({ type: 'editParameter', parameter: p.id, set: { ...row, value }, unset })),
    ),
  );
}

/** Sets a choice parameter's options; its value moves to the first when the options drop it. */
export function setParameterOptions(editor: Editor, p: ParameterView, options: readonly string[]): CommandResult {
  const list = [...new Set(options.map((o) => o.trim()).filter((o) => o !== ''))];
  if (list.length === 0) return { ok: false, error: { code: 'invalid', message: 'A choice has one option at least' } };
  if (list.length === p.options.length && list.every((o, i) => o === p.options[i]))
    return { ok: true, label: '', changed: false };
  const current = fieldOf(p);
  return asResult(() =>
    editor.transaction(`Edit ${p.name}`, () => {
      const edited = check(editor.dispatch({ type: 'editParameter', parameter: p.id, set: { options: list } }));
      if (list.includes(current)) return edited;
      return check(
        editor.dispatch({
          type: 'setValueDef',
          value: p.value,
          def: { expr: { text: JSON.stringify(list[0]), grammar: 1, refs: {} } },
        }),
      );
    }),
  );
}

// ---- configurations ----

export interface ConfigurationView {
  id: string;
  /** The choice parameter that selects the row. */
  input: ParameterView;
  rows: { option: string; overrides: Map<string, string> }[];
  /** The row the input's value selects now. */
  active: string | null;
}

/** The preset configurations of a part: those whose input is a choice parameter of the part. */
export function configurationsOf(doc: Doc, part: string): ConfigurationView[] {
  const row = partOf(doc, part);
  const params = parametersOf(doc, { part });
  const configurations = Array.isArray(row?.configurations) ? (row.configurations as Json[]) : [];
  return configurations.flatMap((c) => {
    const input = params.find((p) => p.id === (c.input as Json | undefined)?.id);
    if (!input || input.kind !== 'choice') return [];
    const rows = (Array.isArray(c.rows) ? (c.rows as Json[]) : []).map((r) => {
      const option = String(((r.option as Json).equals as Json).literal);
      const overrides = new Map<string, string>();
      for (const o of (r.overrides as Json[]) ?? []) {
        const v = o.value as Json | undefined;
        const target = ((v?.target as Json | undefined)?.parameter as Json | undefined)?.id;
        const text = ((v?.def as Json | undefined)?.expr as Json | undefined)?.text;
        if (typeof target === 'string' && typeof text === 'string') overrides.set(target, text);
      }
      return { option, overrides };
    });
    const active = /^\s*"(.*)"\s*$/.exec(input.text)?.[1] ?? null;
    return [{ id: String(c.id), input, rows, active }];
  });
}

/**
 * Adds a preset configuration to a part: a choice parameter
 * `configuration` with one option, "Default", and its row, as one step.
 */
export function addConfiguration(editor: Editor, part: string): CommandResult {
  const doc = editor.document;
  const taken = new Set(parametersOf(doc, { part }).map((p) => p.name));
  let name = 'configuration';
  for (let n = 2; taken.has(name); n++) name = `configuration${n}`;
  return asResult(() =>
    editor.transaction('Add configuration', () => {
      check(addParameter(editor, { part }, name, 'choice', '"Default"', ['Default']));
      const input = parametersOf(editor.document, { part }).find((p) => p.name === name) as ParameterView;
      return check(
        editor.dispatch({
          type: 'addConfiguration',
          owner: part,
          configuration: {
            id: editor.newId('cfg'),
            input: { id: input.id },
            rows: [{ option: { equals: { literal: 'Default' } }, overrides: [] }],
          },
        }),
      );
    }),
  );
}

/** Adds a row named `option` (a new option of the input), copying no overrides. */
export function addConfigurationRow(editor: Editor, c: ConfigurationView, option: string): CommandResult {
  if (option.trim() === '' || c.rows.some((r) => r.option === option))
    return { ok: false, error: { code: 'invalid', message: 'Each configuration has its own name' } };
  return asResult(() =>
    editor.transaction(`Add ${option}`, () => {
      check(
        editor.dispatch({
          type: 'editParameter',
          parameter: c.input.id,
          set: { options: [...c.input.options, option] },
        }),
      );
      return check(
        editor.dispatch({
          type: 'addConfigurationRow',
          configuration: c.id,
          row: { option: { equals: { literal: option } }, overrides: [] },
        }),
      );
    }),
  );
}

/** Renames a row: its option in the input parameter, the row, and the input's value when it selects it. */
export function renameConfigurationRow(editor: Editor, c: ConfigurationView, from: string, to: string): CommandResult {
  if (to.trim() === '' || to === from) return { ok: true, label: '', changed: false };
  if (c.rows.some((r) => r.option === to))
    return { ok: false, error: { code: 'invalid', message: 'Each configuration has its own name' } };
  return asResult(() =>
    editor.transaction(`Rename ${from}`, () => {
      check(
        editor.dispatch({
          type: 'editParameter',
          parameter: c.input.id,
          set: { options: c.input.options.map((o) => (o === from ? to : o)) },
        }),
      );
      if (c.active === from)
        check(
          editor.dispatch({
            type: 'setValueDef',
            value: c.input.value,
            def: { expr: { text: JSON.stringify(to), grammar: 1, refs: {} } },
          }),
        );
      return check(
        editor.dispatch({
          type: 'editConfigurationRow',
          configuration: c.id,
          option: from,
          set: { option: { equals: { literal: to } } },
        }),
      );
    }),
  );
}

/** Removes a row and its option; the active one moves to the first that stays. */
export function removeConfigurationRow(editor: Editor, c: ConfigurationView, option: string): CommandResult {
  const rest = c.input.options.filter((o) => o !== option);
  if (rest.length === 0)
    return { ok: false, error: { code: 'not-allowed', message: 'A configuration keeps one row at least' } };
  return asResult(() =>
    editor.transaction(`Remove ${option}`, () => {
      if (c.active === option)
        check(
          editor.dispatch({
            type: 'setValueDef',
            value: c.input.value,
            def: { expr: { text: JSON.stringify(rest[0]), grammar: 1, refs: {} } },
          }),
        );
      check(editor.dispatch({ type: 'removeConfigurationRow', configuration: c.id, option }));
      return check(editor.dispatch({ type: 'editParameter', parameter: c.input.id, set: { options: rest } }));
    }),
  );
}

/** Sets or clears (empty text) a row's override of a part parameter. */
export function setConfigurationOverride(
  editor: Editor,
  part: string,
  c: ConfigurationView,
  option: string,
  p: ParameterView,
  text: string,
): CommandResult {
  const doc = editor.document;
  const configuration = (partOf(doc, part)?.configurations as Json[]).find((x) => x.id === c.id) as Json;
  const row = (configuration.rows as Json[]).find(
    (r) => ((r.option as Json).equals as Json).literal === option,
  ) as Json;
  const others = ((row.overrides as Json[]) ?? []).filter(
    (o) =>
      ((o.value as Json | undefined)?.target as Json | undefined)?.parameter === undefined ||
      (((o.value as Json).target as Json).parameter as Json).id !== p.id,
  );
  let overrides = others;
  if (text.trim() !== '') {
    const bound = bindParameter(doc, { part }, { ...kindToType(p.kind), options: p.options }, p.kind, text);
    if (!bound.ok) return { ok: false, error: { code: 'invalid', message: bound.message } };
    overrides = [...others, { value: { target: { parameter: { id: p.id } }, def: bound.def } }];
  }
  return editor.dispatch({ type: 'editConfigurationRow', configuration: c.id, option, set: { overrides } });
}

/** Selects a configuration row: the input parameter's value. */
export function setActiveConfiguration(editor: Editor, c: ConfigurationView, option: string): CommandResult {
  return editor.dispatch({
    type: 'setValueDef',
    value: c.input.value,
    def: { expr: { text: JSON.stringify(option), grammar: 1, refs: {} } },
  });
}

/**
 * The row "Clear active" selects: the first that overrides nothing, so the
 * part's parameters take their own values; null when the active row
 * already overrides nothing, or no row does.
 */
export function plainRow(c: ConfigurationView): string | null {
  const active = c.rows.find((r) => r.option === c.active);
  if (!active || active.overrides.size === 0) return null;
  return c.rows.find((r) => r.overrides.size === 0)?.option ?? null;
}
