import { isPlainObject } from '@tweakcad/format';
import { CommandError } from '../errors';
import { findRow, idIndex, kindOf, type Doc, type Json } from '../rows';
import { nameOf, requireRow, type Handlers, type RunContext } from './common';

/**
 * The browser's folders (spec 3): presentational rows that hold parts,
 * assemblies and library entries in order, and nest under one another. An
 * item stands in one folder at most; an item in none shows at the top level.
 */

const MEMBER_KINDS = new Set(['part', 'asm', 'lib']);

function foldersOf(doc: Doc): Json[] {
  return Array.isArray(doc.folders) ? (doc.folders as Json[]) : [];
}

/** The draft's folder table, made when the document has none. */
function draftFolders(ctx: RunContext): Json[] {
  if (!Array.isArray(ctx.draft.folders)) ctx.draft.folders = [];
  return ctx.draft.folders as Json[];
}

/** A folder row by id among `rows` (the document's or the draft's), with its index. */
function findFolder(rows: Json[], id: string): { index: number; row: Json } {
  const index = rows.findIndex((f) => isPlainObject(f) && f.id === id);
  const row = rows[index];
  if (!row) throw new CommandError('not-found', `no folder ${id}`);
  return { index, row };
}

/** The folder a folder row stands in; undefined at the top level. */
function parentOf(folder: Json): string | undefined {
  const parent = folder.parent;
  if (isPlainObject(parent) && isPlainObject(parent.folder) && typeof parent.folder.id === 'string')
    return parent.folder.id;
  return undefined;
}

function parentField(parent: string | undefined): Json {
  return parent === undefined ? { top: {} } : { folder: { id: parent } };
}

/** Whether `id` is `folder` or lies inside it. */
function within(doc: Doc, id: string, folder: string): boolean {
  const byId = new Map(foldersOf(doc).map((f) => [f.id as string, f]));
  const seen = new Set<string>();
  for (let at: string | undefined = id; at !== undefined && !seen.has(at);) {
    if (at === folder) return true;
    seen.add(at);
    const row = byId.get(at);
    at = row ? parentOf(row) : undefined;
  }
  return false;
}

/** Checks that an item a folder can hold exists: a part, an assembly or a library entry. */
function requireMember(doc: Doc, id: unknown): string {
  if (typeof id !== 'string' || !MEMBER_KINDS.has(kindOf(id)))
    throw new CommandError('bad-argument', 'a folder holds parts, assemblies and library entries');
  const kind = kindOf(id);
  if (kind === 'lib') {
    const library = Array.isArray(doc.library) ? (doc.library as Json[]) : [];
    if (!library.some((e) => isPlainObject(e) && e.id === id))
      throw new CommandError('not-found', `no library entry ${id}`);
  } else {
    findRow(doc, id, kind === 'part' ? 'part' : 'assembly', [kind === 'part' ? 'parts' : 'assemblies']);
  }
  return id;
}

function requireMembers(doc: Doc, ids: unknown): string[] {
  if (!Array.isArray(ids)) throw new CommandError('bad-argument', 'members are a list of ids');
  return [...new Set(ids.map((id) => requireMember(doc, id)))];
}

/** Takes items out of every folder of the draft. */
export function dropFromFolders(ctx: RunContext, ids: readonly string[]): void {
  if (!Array.isArray(ctx.draft.folders)) return;
  const gone = new Set(ids);
  for (const folder of ctx.draft.folders as Json[]) {
    const members = folder.members;
    if (Array.isArray(members) && members.some((m) => gone.has(m as string))) {
      folder.members = (members as string[]).filter((m) => !gone.has(m));
    }
  }
}

function folderName(doc: Doc, id: string): string {
  return nameOf(
    foldersOf(doc).find((f) => f.id === id),
    'folder',
  );
}

export const folderHandlers: Handlers<'addFolder' | 'renameFolder' | 'removeFolder' | 'moveFolder' | 'moveToFolder'> = {
  addFolder: {
    label: (c) => `New ${nameOf(isPlainObject(c.folder) ? c.folder : undefined, 'folder')}`,
    run(c, ctx) {
      const given = requireRow(c.folder, 'fld', 'folder');
      const id = given.id as string;
      if (idIndex(ctx.doc).has(id)) throw new CommandError('bad-argument', `${id} is already used`);
      if (typeof given.name !== 'string') throw new CommandError('bad-argument', 'a folder has a name');
      const members = requireMembers(ctx.doc, given.members ?? []);
      let parent: string | undefined;
      if (given.parent !== undefined) {
        if (!isPlainObject(given.parent))
          throw new CommandError('bad-argument', 'a folder parent is {top} or {folder}');
        if (!('top' in given.parent)) {
          parent = parentOf(given);
          if (parent === undefined) throw new CommandError('bad-argument', 'a folder parent is {top} or {folder}');
          findFolder(foldersOf(ctx.doc), parent);
        }
      }
      dropFromFolders(ctx, members);
      const folders = draftFolders(ctx);
      const row: Json = { ...given, members, parent: parentField(parent) };
      let at = folders.length;
      if (c.before !== undefined) at = findFolder(foldersOf(ctx.doc), c.before).index;
      folders.splice(at, 0, row);
    },
  },

  renameFolder: {
    label: (c, doc) => `Rename ${folderName(doc, c.folder)}`,
    run(c, ctx) {
      if (typeof c.name !== 'string') throw new CommandError('bad-argument', 'a folder name is a string');
      findFolder(draftFolders(ctx), c.folder).row.name = c.name;
    },
  },

  /** A removed folder's items and folders go to its parent; nothing else is removed. */
  removeFolder: {
    label: (c, doc) => `Remove ${folderName(doc, c.folder)}`,
    run(c, ctx) {
      const folders = draftFolders(ctx);
      const { index, row } = findFolder(folders, c.folder);
      const parent = parentOf(row);
      for (const f of folders) if (parentOf(f) === c.folder) f.parent = parentField(parent);
      if (parent !== undefined) {
        const into = findFolder(folders, parent).row;
        const members = Array.isArray(into.members) ? (into.members as string[]) : [];
        into.members = [...members, ...((row.members as string[] | undefined) ?? [])];
      }
      folders.splice(index, 1);
    },
  },

  /** Puts a folder in another (absent: the top level), before a sibling folder or after the last. */
  moveFolder: {
    label: (c, doc) => `Move ${folderName(doc, c.folder)}`,
    run(c, ctx) {
      const { index, row } = findFolder(draftFolders(ctx), c.folder);
      if (c.parent !== undefined) {
        findFolder(foldersOf(ctx.doc), c.parent);
        if (within(ctx.doc, c.parent, c.folder))
          throw new CommandError('not-allowed', 'a folder cannot go inside itself');
      }
      if (c.before === c.folder) throw new CommandError('bad-argument', 'a folder cannot go before itself');
      if (c.before !== undefined) findFolder(foldersOf(ctx.doc), c.before);
      const folders = draftFolders(ctx);
      folders.splice(index, 1);
      row.parent = parentField(c.parent);
      const at = c.before === undefined ? folders.length : findFolder(folders, c.before).index;
      folders.splice(at, 0, row);
    },
  },

  /**
   * Puts items in a folder, before one of its items or after the last, and
   * out of any other; with no folder, they go back to the top level.
   */
  moveToFolder: {
    label: (c, doc) => (c.folder === undefined ? 'Move to top level' : `Move to ${folderName(doc, c.folder)}`),
    run(c, ctx) {
      const items = requireMembers(ctx.doc, c.items);
      if (items.length === 0) throw new CommandError('bad-argument', 'give the items to move');
      if (c.folder === undefined) {
        if (c.before !== undefined) throw new CommandError('bad-argument', 'before needs a folder');
        dropFromFolders(ctx, items);
        return;
      }
      const members = findFolder(foldersOf(ctx.doc), c.folder).row.members;
      if (c.before !== undefined) {
        if (items.includes(c.before)) throw new CommandError('bad-argument', 'an item cannot go before itself');
        if (!Array.isArray(members) || !members.includes(c.before))
          throw new CommandError('not-found', `${c.before} is not in folder ${c.folder}`);
      }
      dropFromFolders(ctx, items);
      const row = findFolder(draftFolders(ctx), c.folder).row;
      const list = Array.isArray(row.members) ? [...(row.members as string[])] : [];
      const at = c.before === undefined ? list.length : list.indexOf(c.before);
      list.splice(at, 0, ...items);
      row.members = list;
    },
  },
};
