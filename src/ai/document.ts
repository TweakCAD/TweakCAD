/**
 * The document tools: reading it, its outline and what the rebuild could not
 * do; running editor commands; writing a picked reference; values,
 * parameters and undo groups.
 */
import {
  ID_KINDS,
  ValueEvaluator,
  isPlainObject,
  quantityOf,
  type ExprValue,
  type ValueTarget,
} from '@tweakcad/format';
import { bindExpression, idIndex, type Doc, type EditorCommand, type Json } from '@tweakcad/editor';
import { findFeature, partOf, partOfFeature, partView, partsOf, type FeatureRow } from '../app/features';
import { isPickedRegion, writePicked, type PickResult } from '../app/picking';
import { check, entryOf, exprArg, objectArg, optStr, str, type Args } from './common';
import { ToolError, checkCanEdit, invalid, partArg, settledDisplay, type AiContext } from './context';
import { setSketchDimension } from './sketch';

export function getDocument(ctx: AiContext, args: Args): Json {
  const doc = ctx.services.editor.document;
  if (args.part === undefined) return doc;
  const part = partOf(doc, partArg(ctx, args.part));
  return part ?? {};
}

function outlineOf(f: FeatureRow): Json {
  return {
    id: f.id,
    type: f.type,
    name: f.name,
    ...(f.suppressed ? { suppressed: true } : {}),
    ...(f.frozen ? { frozen: true } : {}),
    // A frozen feature replaying over a changed body is listed as blocked by the change, as `featureStatus` reports it.
    status:
      f.status === 'failed' ? 'paused' : f.warning !== undefined ? 'blocked' : f.status === 'success' ? 'ok' : f.status,
    ...(f.message ? { message: f.message } : f.warning !== undefined ? { message: f.warning } : {}),
    ...(f.children.length > 0 ? { children: f.children.map(outlineOf) } : {}),
  };
}

/** A value's result as plain data: a number in its stored unit with the quantity, or the literal. */
function shownValue(result: ExprValue): Json {
  switch (result.kind) {
    case 'scalar':
      return { value: result.value, quantity: quantityOf(result.dim)?.name ?? 'number' };
    case 'vector':
      return { value: [...result.value], quantity: quantityOf(result.dim)?.name ?? 'number' };
    case 'boolean':
    case 'text':
      return { value: result.value };
    default:
      return {};
  }
}

function parametersOf(doc: Doc, tables: unknown): Json[] {
  if (!Array.isArray(tables)) return [];
  const values = new ValueEvaluator(doc);
  return (tables as Json[]).flatMap((t) =>
    ((t.parameters as Json[] | undefined) ?? []).map((p) => {
      let result: Json;
      try {
        result = shownValue(values.parameter(p.id as string));
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      const value = p.value as Json | undefined;
      const text = isPlainObject(value?.def) && isPlainObject(value.def.expr) ? value.def.expr.text : undefined;
      return { id: p.id, name: p.name, valueId: value?.id, expression: text, ...result };
    }),
  );
}

export async function listFeatures(ctx: AiContext, args: Args): Promise<Json> {
  const display = await settledDisplay(ctx);
  const doc = ctx.services.editor.document;
  const wanted = args.part === undefined ? null : partArg(ctx, args.part);
  const parts = partsOf(doc).flatMap((p) => {
    const id = p.id as string;
    if (wanted && id !== wanted) return [];
    const view = partView(doc, id, display);
    if (!view) return [];
    const rollback =
      view.rollbackIndex < view.features.length ? { rollbackBefore: view.features[view.rollbackIndex]?.id } : {};
    return [
      {
        id,
        name: view.name,
        ...rollback,
        features: view.features.map(outlineOf),
        parameters: parametersOf(doc, p.parameters),
      },
    ];
  });
  const root = doc.root as Json | undefined;
  return {
    name: (doc.metadata as Json | undefined)?.name,
    root,
    parameters: parametersOf(doc, doc.parameters),
    parts,
    assemblies: (Array.isArray(doc.assemblies) ? (doc.assemblies as Json[]) : []).map((a) => ({
      id: a.id,
      name: a.name,
      instances: Array.isArray(a.instances) ? a.instances.length : 0,
    })),
  };
}

export async function getDiagnostics(ctx: AiContext, args: Args): Promise<Json> {
  // A failed rebuild leaves the display before it, listed with the error.
  const display = await settledDisplay(ctx, true);
  const doc = ctx.services.editor.document;
  const wanted = args.part === undefined ? null : partArg(ctx, args.part);
  const inPart = (feature: string) => wanted === null || partOfFeature(doc, feature) === wanted;
  const named = (feature: string) => ({ feature, name: findFeature(doc, feature)?.name });
  const error = ctx.services.display.getState().error;
  return {
    paused: display.pauses
      .filter((p) => inPart(p.feature))
      .map((p) => ({ ...named(p.feature), message: p.message, ...(p.through ? { blocks: p.through } : {}) })),
    stale: display.stale.filter((p) => inPart(p.feature)).map((p) => ({ ...named(p.feature), message: p.message })),
    outOfDate: display.outOfDate.filter((o) => wanted === null || o.part === wanted),
    ...(error ? { rebuildError: error } : {}),
  };
}

export function runCommand(ctx: AiContext, args: Args): Json {
  checkCanEdit(ctx);
  const command = objectArg(args, 'command');
  if (typeof command.type !== 'string') throw invalid('`command` has a string `type`');
  if (command.type === 'writeReference' || 'names' in command) {
    throw invalid('References are made by picking: use set_reference, or a feature tool, with handles');
  }
  const made = new Map<string, string>();
  const filled = withNewIds(command, (kind, token) => {
    let id = made.get(token);
    if (!id) made.set(token, (id = ctx.services.editor.newId(kind)));
    return id;
  });
  const result = check(ctx.services.editor.dispatch(filled as unknown as EditorCommand));
  return { label: result.label, changed: result.changed, ...(made.size > 0 ? { ids: Object.fromEntries(made) } : {}) };
}

const NEW_ID = /^new:([a-z]+)(?::.*)?$/;

/** The command with every `"new:<kind>"` string (or `"new:<kind>:<label>"`) replaced by a new id of that kind; one token, one id. */
function withNewIds(value: unknown, make: (kind: string, token: string) => string): unknown {
  if (typeof value === 'string') {
    const m = NEW_ID.exec(value);
    if (!m) return value;
    if (!(ID_KINDS as readonly string[]).includes(m[1] as string))
      throw invalid(`${value}: ${m[1]} is not an id kind (${ID_KINDS.join(', ')})`);
    return make(m[1] as string, value);
  }
  if (Array.isArray(value)) return value.map((v) => withNewIds(v, make));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withNewIds(v, make)]));
}

export function setReference(ctx: AiContext, args: Args): Json {
  checkCanEdit(ctx);
  const feature = str(args, 'feature');
  const pointer = str(args, 'pointer');
  if (!findFeature(ctx.services.editor.document, feature))
    throw new ToolError('NOT_FOUND', `There is no feature ${feature}`);
  const given = ['entity', 'standard', 'ofFeature'].filter((k) => args[k] !== undefined);
  if (given.length !== 1) throw invalid('Give one of `entity`, `standard` or `ofFeature`');
  let picked: PickResult;
  if (args.entity !== undefined) {
    picked = entryOf(
      ctx,
      args.entity,
      ['body', 'face', 'edge', 'vertex', 'region', 'curve', 'point', 'construction'],
      'entity',
    ).picked;
  } else if (args.standard !== undefined) {
    picked = { reference: { standard: { name: str(args, 'standard') } }, names: {} };
  } else {
    const id = str(args, 'ofFeature');
    if (!findFeature(ctx.services.editor.document, id)) throw new ToolError('NOT_FOUND', `There is no feature ${id}`);
    picked = { reference: { object: { feature: { id } } }, names: {} };
  }
  const result = check(writePicked(ctx.services.editor, feature, pointer, picked));
  return {
    label: result.label,
    changed: result.changed,
    ...(isPickedRegion(picked) ? { region: 'a region row was added for it' } : {}),
  };
}

/** Where a value object lies: its part or assembly and feature (or none, for a document parameter), and the row it is a field of. */
function valueOwner(
  doc: Doc,
  id: string,
): { part: string; feature: string; path: readonly (string | number)[] } | null {
  const path = idIndex(doc).get(id);
  if (!path) return null;
  if (path[0] !== 'parts' && path[0] !== 'assemblies') return { part: '', feature: '', path };
  const part = (doc[path[0]] as Json[])[path[1] as number];
  let feature = '';
  let rows: unknown = part?.timeline;
  for (let i = 2; i < path.length; i++) {
    if (path[i] === 'timeline' || path[i] === 'children') {
      const row = (rows as Json[] | undefined)?.[path[i + 1] as number];
      if (!row) break;
      feature = row.id as string;
      rows = row.children;
    }
  }
  return { part: (part?.id as string) ?? '', feature, path };
}

/** The type a value's expression is checked against, read from what it is now. */
function targetOf(doc: Doc, id: string): ValueTarget | null {
  try {
    const result = new ValueEvaluator(doc).value(id);
    switch (result.kind) {
      case 'scalar':
        return { type: 'number', quantity: quantityOf(result.dim)?.name ?? 'ratio' };
      case 'vector':
        return { type: 'vector', quantity: quantityOf(result.dim)?.name ?? 'ratio' };
      case 'boolean':
        return { type: 'boolean' };
      case 'text':
        return { type: 'text' };
      case 'placement':
        return { type: 'placement' };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const UNIT_OF: Record<string, string> = { length: 'mm', angle: 'deg' };

export async function setValue(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const id = str(args, 'value');
  const doc = ctx.services.editor.document;
  const owner = valueOwner(doc, id);
  if (!owner || !id.startsWith('val_')) throw new ToolError('NOT_FOUND', `There is no value ${id}`);
  const feature = owner.feature ? findFeature(doc, owner.feature) : undefined;
  // A sketch dimension is solved with the sketch, so the stored geometry and region fates follow.
  if (feature?.type === 'core.sketch') {
    const constraints = ((feature.inputs as Json | undefined)?.constraints as Json[] | undefined) ?? [];
    const row = constraints.find((c) => isPlainObject(c.value) && c.value.id === id);
    if (row) return setSketchDimension(ctx, { sketch: owner.feature, constraint: row.id, value: args.expression });
  }
  const target = targetOf(doc, id) ?? { type: 'number', quantity: 'length' };
  const text = exprArg(args, 'expression', UNIT_OF[target.quantity ?? ''] ?? '');
  const bound = bindExpression(doc, { part: owner.part, feature: owner.feature, self: id }, text, target);
  if (!bound.ok) throw invalid(bound.message);
  const result = check(ctx.services.editor.dispatch({ type: 'setValueDef', value: id, def: bound.def }));
  return { label: result.label, changed: result.changed, stored: bound.stored };
}

const QUANTITY_OF_UNIT: Record<string, { quantity: string; unit: string }> = {
  mm: { quantity: 'length', unit: 'mm' },
  deg: { quantity: 'angle', unit: 'deg' },
  none: { quantity: 'ratio', unit: '' },
};

export function setParameter(ctx: AiContext, args: Args): Json {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const doc = editor.document;
  const name = str(args, 'name');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw invalid(`${name} is not a parameter name: a letter or _, then letters, digits or _`);
  const part = args.part === undefined ? null : partArg(ctx, args.part);
  const ownerRow: Json = part ? (partOf(doc, part) as Json) : doc;
  const ownerId = part ?? (doc.id as string);
  const tables = Array.isArray(ownerRow.parameters) ? (ownerRow.parameters as Json[]) : [];
  const existing = tables.flatMap((t) => (t.parameters as Json[] | undefined) ?? []).find((p) => p.name === name);
  const unitArg = optStr(args, 'unit');
  const kind = QUANTITY_OF_UNIT[unitArg ?? (existing ? quantityUnit(existing.quantity) : 'mm')];
  if (!kind) throw invalid("`unit` is 'mm', 'deg' or 'none'");
  const text = exprArg(args, 'expression', kind.unit);
  const target: ValueTarget = { type: 'number', quantity: kind.quantity };
  const valueId = existing ? ((existing.value as Json).id as string) : editor.newId('val');
  const bound = bindExpression(doc, { part: part ?? '', feature: '', self: valueId }, text, target);
  if (!bound.ok) throw invalid(bound.message);
  if (existing) {
    const set: Json = { value: { ...(existing.value as Json), def: bound.def } };
    if (unitArg !== undefined) set.quantity = kind.quantity;
    if (args.description !== undefined) set.description = optStr(args, 'description') ?? '';
    check(editor.dispatch({ type: 'editParameter', parameter: existing.id as string, set }));
    return { parameter: existing.id, stored: bound.stored };
  }
  const id = editor.newId('par');
  const parameter: Json = {
    id,
    name,
    type: 'number',
    quantity: kind.quantity,
    value: { id: valueId, def: bound.def },
    range: { unbounded: {} },
    public: false,
    published: false,
    description: optStr(args, 'description') ?? '',
  };
  editor.transaction(`Add ${name}`, () => {
    let table = tables[0]?.id as string | undefined;
    if (!table) {
      table = editor.newId('tbl');
      check(
        editor.dispatch({
          type: 'addParameterTable',
          owner: ownerId,
          table: { id: table, name: 'Parameters', parameters: [] },
        }),
      );
    }
    check(editor.dispatch({ type: 'addParameter', table, parameter }));
  });
  return { parameter: id, stored: bound.stored };
}

function quantityUnit(quantity: unknown): string {
  return quantity === 'angle' ? 'deg' : quantity === 'length' ? 'mm' : 'none';
}

/** Undo groups through the editor's store, so the tools of one group are one undo step. */
export interface Transactions {
  begin(label: string): void;
  end(): void;
}

export function storeTransactions(ctx: AiContext): Transactions {
  const store = ctx.services.editor.store;
  return {
    begin: (label) => store.beginTransaction(label),
    end: () => {
      if (store.inTransaction) store.endTransaction();
    },
  };
}
