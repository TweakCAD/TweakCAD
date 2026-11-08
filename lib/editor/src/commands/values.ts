import { canonicalize, isPlainObject } from '@tweakcad/format';
import { CommandError } from '../errors';
import {
  findOwner,
  findRow,
  idIndex,
  mergeFields,
  objectAt,
  type Doc,
  type Json,
  type Path,
  type RowAt,
} from '../rows';
import { insertRow, removeRow, renameUses, requireRow, rowName, usesOf, type Handlers } from './common';
import type { Literal } from './types';

function valuePath(doc: Doc, id: string): Path {
  const path = idIndex(doc).get(id);
  if (!path || !id.startsWith('val_')) throw new CommandError('not-found', `no value ${id}`);
  return path;
}

function valueName(doc: Doc, id: string): string {
  try {
    const name = objectAt(doc, valuePath(doc, id)).name;
    return typeof name === 'string' ? name : 'value';
  } catch {
    return 'value';
  }
}

function usedMessage(name: string, count: number): string {
  return `${name} is used by ${count === 1 ? 'an expression' : `${count} expressions`}`;
}

function table(doc: Doc, id: string): RowAt {
  const at = findRow(doc, id, 'parameter table', ['parameters']);
  if (!id.startsWith('tbl_')) throw new CommandError('not-found', `no parameter table ${id}`);
  return at;
}

function parameter(doc: Doc, id: string): RowAt {
  const at = findRow(doc, id, 'parameter', ['parameters']);
  if (!id.startsWith('par_')) throw new CommandError('not-found', `no parameter ${id}`);
  return at;
}

function configuration(doc: Doc, id: string): RowAt {
  return findRow(doc, id, 'configuration', ['configurations']);
}

function literalOf(row: unknown): unknown {
  return isPlainObject(row) && isPlainObject(row.option) && isPlainObject(row.option.equals)
    ? row.option.equals.literal
    : undefined;
}

/** The position of the configuration row whose option takes `literal`. */
function rowIndex(config: Json, literal: Literal): number {
  const rows = Array.isArray(config.rows) ? config.rows : [];
  const index = rows.findIndex((row) => literalOf(row) === literal);
  if (index < 0) throw new CommandError('not-found', `no row for ${JSON.stringify(literal)}`);
  return index;
}

export const valueHandlers: Handlers<
  | 'setValueDef'
  | 'renameValue'
  | 'setValueFlags'
  | 'addParameterTable'
  | 'renameParameterTable'
  | 'removeParameterTable'
  | 'addParameter'
  | 'editParameter'
  | 'removeParameter'
  | 'addConfiguration'
  | 'removeConfiguration'
  | 'setConfigurationInput'
  | 'addConfigurationRow'
  | 'editConfigurationRow'
  | 'removeConfigurationRow'
> = {
  setValueDef: {
    label: (c, doc) => `Edit ${valueName(doc, c.value)}`,
    run(c, ctx) {
      if (!isPlainObject(c.def) || Object.keys(c.def).length !== 1) {
        throw new CommandError('bad-argument', 'a definition is a tagged union with one key');
      }
      const path = valuePath(ctx.doc, c.value);
      const before = objectAt(ctx.doc, path).def;
      if (canonicalize(before) === canonicalize(c.def)) return;
      objectAt(ctx.draft, path).def = c.def;
    },
  },

  renameValue: {
    label: (c, doc) =>
      c.name === undefined ? `Unname ${valueName(doc, c.value)}` : `Rename ${valueName(doc, c.value)}`,
    run(c, ctx) {
      const path = valuePath(ctx.doc, c.value);
      const old = objectAt(ctx.doc, path).name;
      const value = objectAt(ctx.draft, path);
      if (old === c.name) return;
      const target = { value: { id: c.value } };
      if (typeof old === 'string') {
        if (c.name === undefined) {
          const uses = usesOf(ctx.doc, target).filter((u) => u.names.includes(old));
          if (uses.length > 0) throw new CommandError('not-allowed', usedMessage(old, uses.length));
        } else {
          renameUses(ctx, target, old, c.name);
        }
      }
      if (c.name === undefined) delete value.name;
      else value.name = c.name;
    },
  },

  setValueFlags: {
    label: (c, doc) => `Edit ${valueName(doc, c.value)}`,
    run(c, ctx) {
      const value = objectAt(ctx.draft, valuePath(ctx.doc, c.value));
      // The flags are optional; absent means false (6.3), so false is written as absence.
      for (const flag of ['public', 'published'] as const) {
        const set = c[flag];
        if (set === true) value[flag] = true;
        else if (set === false) Reflect.deleteProperty(value, flag);
      }
    },
  },

  addParameterTable: {
    label: (c) => `Add ${typeof c.table.name === 'string' ? c.table.name : 'parameter table'}`,
    run(c, ctx) {
      const owner = findOwner(ctx.doc, c.owner, ['doc', 'part', 'asm']);
      insertRow(
        ctx,
        [...owner, 'parameters'],
        requireRow(c.table, 'tbl', 'parameter table'),
        c.before,
        'parameter table',
      );
    },
  },

  renameParameterTable: {
    label: (c, doc) => `Rename ${rowName(doc, c.table, 'parameter table')}`,
    run(c, ctx) {
      objectAt(ctx.draft, table(ctx.doc, c.table).path).name = c.name;
    },
  },

  removeParameterTable: {
    label: (c, doc) => `Remove ${rowName(doc, c.table, 'parameter table')}`,
    run(c, ctx) {
      const at = table(ctx.doc, c.table);
      for (const p of (at.row.parameters as Json[] | undefined) ?? []) {
        const uses = usesOf(ctx.doc, { parameter: { id: p.id as string } });
        if (uses.length > 0) throw new CommandError('not-allowed', usedMessage(String(p.name), uses.length));
      }
      removeRow(ctx, at);
    },
  },

  addParameter: {
    label: (c) => `Add ${typeof c.parameter.name === 'string' ? c.parameter.name : 'parameter'}`,
    run(c, ctx) {
      const at = table(ctx.doc, c.table);
      insertRow(ctx, [...at.path, 'parameters'], requireRow(c.parameter, 'par', 'parameter'), c.before, 'parameter');
    },
  },

  editParameter: {
    label: (c, doc) => `Edit ${rowName(doc, c.parameter, 'parameter')}`,
    run(c, ctx) {
      const at = parameter(ctx.doc, c.parameter);
      if (c.unset?.includes('name')) throw new CommandError('bad-argument', 'a parameter always has a name');
      const name = c.set?.name;
      if (typeof name === 'string' && typeof at.row.name === 'string') {
        renameUses(ctx, { parameter: { id: c.parameter } }, at.row.name, name);
      }
      mergeFields(objectAt(ctx.draft, at.path), c.set, c.unset);
    },
  },

  removeParameter: {
    label: (c, doc) => `Remove ${rowName(doc, c.parameter, 'parameter')}`,
    run(c, ctx) {
      const at = parameter(ctx.doc, c.parameter);
      const uses = usesOf(ctx.doc, { parameter: { id: c.parameter } });
      if (uses.length > 0) throw new CommandError('not-allowed', usedMessage(String(at.row.name), uses.length));
      removeRow(ctx, at);
    },
  },

  addConfiguration: {
    label: () => 'Add configuration',
    run(c, ctx) {
      const owner = findOwner(ctx.doc, c.owner, ['part', 'asm']);
      insertRow(
        ctx,
        [...owner, 'configurations'],
        requireRow(c.configuration, 'cfg', 'configuration'),
        c.before,
        'configuration',
      );
    },
  },

  removeConfiguration: {
    label: () => 'Remove configuration',
    run(c, ctx) {
      removeRow(ctx, findRow(ctx.doc, c.configuration, 'configuration', ['configurations']));
    },
  },

  setConfigurationInput: {
    label: () => 'Edit configuration',
    run(c, ctx) {
      objectAt(ctx.draft, configuration(ctx.doc, c.configuration).path).input = { id: c.input };
    },
  },

  addConfigurationRow: {
    label: () => 'Add configuration row',
    run(c, ctx) {
      if (!isPlainObject(c.row) || literalOf(c.row) === undefined) {
        throw new CommandError('bad-argument', 'a configuration row has an option and overrides');
      }
      const path = configuration(ctx.doc, c.configuration).path;
      const config = objectAt(ctx.draft, path);
      const rows = config.rows as unknown[];
      const index = c.before === undefined ? rows.length : rowIndex(objectAt(ctx.doc, path), c.before);
      rows.splice(index, 0, c.row);
    },
  },

  editConfigurationRow: {
    label: () => 'Edit configuration row',
    run(c, ctx) {
      const path = configuration(ctx.doc, c.configuration).path;
      const index = rowIndex(objectAt(ctx.doc, path), c.option);
      mergeFields(objectAt(ctx.draft, [...path, 'rows', index]), c.set, c.unset, []);
    },
  },

  removeConfigurationRow: {
    label: () => 'Remove configuration row',
    run(c, ctx) {
      const path = configuration(ctx.doc, c.configuration).path;
      const index = rowIndex(objectAt(ctx.doc, path), c.option);
      (objectAt(ctx.draft, path).rows as unknown[]).splice(index, 1);
    },
  },
};
