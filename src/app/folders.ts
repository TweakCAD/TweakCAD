/**
 * The browser's folders (spec 3): the document's `folders` table read as a
 * tree, and the folder command a drop or a menu choice runs. Folders show
 * before the items of their level; an item in no folder shows at the top.
 */
import type { CommandOf, Doc, Editor, Json } from '@tweakcad/editor';
import { isPlainObject } from '@tweakcad/format';
import { nextName } from './assembly/assembly';

export interface TreeFolder {
  id: string;
  name: string;
  /** The folder it stands in; null at the top level. */
  parent: string | null;
  /** Its parts, assemblies and library entries, in order. */
  members: string[];
}

export type FolderCommand = CommandOf<'moveToFolder' | 'moveFolder' | 'renameFolder' | 'removeFolder'>;

/** The document's folders, in table order. */
export function foldersOf(doc: Doc): TreeFolder[] {
  const rows = Array.isArray(doc.folders) ? (doc.folders as Json[]) : [];
  return rows.flatMap((f) => {
    if (!isPlainObject(f) || typeof f.id !== 'string') return [];
    const parent = isPlainObject(f.parent) && isPlainObject(f.parent.folder) ? f.parent.folder.id : undefined;
    return [
      {
        id: f.id,
        name: typeof f.name === 'string' ? f.name : '',
        parent: typeof parent === 'string' ? parent : null,
        members: Array.isArray(f.members) ? f.members.filter((m): m is string => typeof m === 'string') : [],
      },
    ];
  });
}

export interface FolderTree {
  byId: ReadonlyMap<string, TreeFolder>;
  /** The top level's folders, in table order. */
  top: readonly string[];
  /** Each folder's own folders, in table order. */
  children: ReadonlyMap<string, readonly string[]>;
  /** The folder each filed item stands in. */
  folderOf: ReadonlyMap<string, string>;
}

export function folderTree(folders: readonly TreeFolder[]): FolderTree {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const top: string[] = [];
  const children = new Map<string, string[]>();
  const folderOf = new Map<string, string>();
  for (const f of folders) {
    // A folder whose parent is gone shows at the top level.
    if (f.parent !== null && byId.has(f.parent)) {
      const list = children.get(f.parent) ?? [];
      list.push(f.id);
      children.set(f.parent, list);
    } else top.push(f.id);
    for (const m of f.members) if (!folderOf.has(m)) folderOf.set(m, f.id);
  }
  return { byId, top, children, folderOf };
}

/** Whether folder `id` is `ancestor` or lies inside it. */
export function isWithin(tree: FolderTree, id: string | null, ancestor: string): boolean {
  const seen = new Set<string>();
  for (let at = id; at !== null && !seen.has(at); at = tree.byId.get(at)?.parent ?? null) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

/** Every folder in tree order, each with how deep it stands (0 at the top level). */
export function flatFolders(tree: FolderTree): { folder: TreeFolder; level: number }[] {
  const out: { folder: TreeFolder; level: number }[] = [];
  const seen = new Set<string>();
  const walk = (ids: readonly string[], level: number) => {
    for (const id of ids) {
      const folder = tree.byId.get(id);
      if (!folder || seen.has(id)) continue;
      seen.add(id);
      out.push({ folder, level });
      walk(tree.children.get(id) ?? [], level + 1);
    }
  };
  walk(tree.top, 0);
  return out;
}

/** What is dragged or acted on: a part, assembly or library entry, or a folder. */
export type TreeThing = { item: string } | { folder: string };

/**
 * Where a drop lands: on a folder (into it, or before it among its siblings),
 * on an item (before it in its folder), or on the document (the top level).
 */
export type DropTarget = { folder: string; zone: 'into' | 'before' } | { item: string } | { top: true };

/** The command a drop runs; null when it changes nothing or cannot be done. */
export function dropCommand(tree: FolderTree, dragged: TreeThing, target: DropTarget): FolderCommand | null {
  if ('item' in dragged) {
    const id = dragged.item;
    const from = tree.folderOf.get(id) ?? null;
    if ('folder' in target) {
      if (from === target.folder) return null;
      return { type: 'moveToFolder', items: [id], folder: target.folder };
    }
    if ('item' in target) {
      if (target.item === id) return null;
      const to = tree.folderOf.get(target.item);
      if (to === undefined) return from === null ? null : { type: 'moveToFolder', items: [id] };
      return { type: 'moveToFolder', items: [id], folder: to, before: target.item };
    }
    return from === null ? null : { type: 'moveToFolder', items: [id] };
  }
  const id = dragged.folder;
  const self = tree.byId.get(id);
  if (!self) return null;
  let parent: string | null;
  let before: string | undefined;
  if ('folder' in target) {
    if (target.folder === id) return null;
    if (target.zone === 'into') parent = target.folder;
    else {
      parent = tree.byId.get(target.folder)?.parent ?? null;
      before = target.folder;
    }
  } else if ('item' in target) {
    parent = tree.folderOf.get(target.item) ?? null;
  } else parent = null;
  if (parent !== null && isWithin(tree, parent, id)) return null;
  if (before === undefined && parent === self.parent) return null;
  return {
    type: 'moveFolder',
    folder: id,
    ...(parent !== null ? { parent } : {}),
    ...(before !== undefined ? { before } : {}),
  };
}

/** The folders a thing can be moved into from its menu: not where it is, nor (for a folder) inside itself. */
export function moveTargets(tree: FolderTree, thing: TreeThing): { folder: TreeFolder; level: number }[] {
  return flatFolders(tree).filter(({ folder }) =>
    'item' in thing
      ? tree.folderOf.get(thing.item) !== folder.id
      : folder.id !== tree.byId.get(thing.folder)?.parent && !isWithin(tree, folder.id, thing.folder),
  );
}

/** The command that moves a thing into a folder, or with null to the top level. */
export function moveCommand(thing: TreeThing, folder: string | null): FolderCommand {
  if ('item' in thing) return { type: 'moveToFolder', items: [thing.item], ...(folder !== null ? { folder } : {}) };
  return { type: 'moveFolder', folder: thing.folder, ...(folder !== null ? { parent: folder } : {}) };
}

/** Adds a folder named "Folder n" in `parent` (null: the top level) holding `members`; its id, or the refusal. */
export function addFolder(
  editor: Editor,
  parent: string | null,
  members: readonly string[] = [],
): { ok: true; id: string } | { ok: false; message: string } {
  const id = editor.newId('fld');
  const name = nextName(
    foldersOf(editor.document).map((f) => f.name),
    'Folder',
  );
  const result = editor.dispatch({
    type: 'addFolder',
    folder: { id, name, members: [...members], parent: parent === null ? { top: {} } : { folder: { id: parent } } },
  });
  return result.ok ? { ok: true, id } : { ok: false, message: result.error.message };
}
