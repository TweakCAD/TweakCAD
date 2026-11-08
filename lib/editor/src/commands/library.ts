import { isPlainObject } from '@tweakcad/format';
import { CommandError } from '../errors';
import { arrayAt, findRow, mergeFields, objectAt, type Doc, type Json, type RowAt } from '../rows';
import { insertRow, mergeAssets, mergeNames, nameOf, removeRow, requireRow, type Handlers } from './common';

/** A library entry (11) by id; the library is outside the document's own row index. */
function libraryEntry(doc: Doc, id: string): { index: number; row: Json } {
  const rows = Array.isArray(doc.library) ? (doc.library as Json[]) : [];
  const index = rows.findIndex((r) => isPlainObject(r) && r.id === id);
  if (index < 0) throw new CommandError('not-found', `no library entry ${id}`);
  return { index, row: rows[index] as Json };
}

/** Every path that names library entry `id`: `{"library": {"id"}}` refs and `lib_` wrappers. */
function usesOfEntry(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((v) => usesOfEntry(v, id));
  if (!isPlainObject(value)) return false;
  const lib = value.library;
  if (isPlainObject(lib) && lib.id === id) return true;
  return Object.entries(value).some(([k, v]) => k !== 'extensions' && usesOfEntry(v, id));
}

function context(doc: Doc, id: string): RowAt {
  const at = findRow(doc, id, 'context', ['contexts']);
  if (at.path[0] !== 'parts') throw new CommandError('not-found', `no context ${id}`);
  return at;
}

/**
 * The library (11) and captured contexts (12.4): removing an entry nothing
 * inserts any more, and adding, re-capturing and removing a part's
 * contexts with the stored shapes and names a capture brings.
 */
export const libraryHandlers: Handlers<'removeLibraryEntry' | 'addContext' | 'editContext' | 'removeContext'> = {
  removeLibraryEntry: {
    label: (c, doc) => {
      try {
        return `Remove ${nameOf(libraryEntry(doc, c.entry).row, 'library entry')}`;
      } catch {
        return 'Remove library entry';
      }
    },
    run(c, ctx) {
      const { index } = libraryEntry(ctx.doc, c.entry);
      if (usesOfEntry({ ...ctx.doc, library: [] }, c.entry))
        throw new CommandError('not-allowed', 'the library entry is still used; remove what inserts it first');
      arrayAt(ctx.draft, ['library']).splice(index, 1);
    },
  },

  addContext: {
    label: () => 'Add context',
    run(c, ctx) {
      const part = findRow(ctx.doc, c.part, 'part', ['parts']);
      const row = requireRow(c.context, 'ctx', 'context');
      mergeAssets(ctx, c.assets);
      mergeNames(ctx, c.names);
      insertRow(ctx, [...part.path, 'contexts'], row, c.before, 'context');
    },
  },

  editContext: {
    label: (c) => c.label ?? 'Update context',
    run(c, ctx) {
      const at = context(ctx.doc, c.context);
      mergeAssets(ctx, c.assets);
      mergeNames(ctx, c.names);
      mergeFields(objectAt(ctx.draft, at.path), c.set, c.unset, ['id', 'assembly', 'at']);
    },
  },

  removeContext: {
    label: () => 'Remove context',
    run(c, ctx) {
      removeRow(ctx, context(ctx.doc, c.context));
    },
  },
};
