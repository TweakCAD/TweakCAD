/**
 * The browser's folders (spec 3): the document's `folders` table read as a
 * tree, and the folder command a drop or a menu choice runs. Folders show
 * before the items of their level; an item in no folder shows at the top.
 */
import type { CommandOf, CommandResult, Doc, Editor, Json } from '@tweakcad/editor';
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

/** What the tree runs: folder commands, and the moves that order the part and assembly tables. */
export type TreeCommand = FolderCommand | CommandOf<'movePart' | 'moveAssembly'>;

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
 * on an item (before it in its folder, or at the top level before it among
 * its own kind), on the document's row (the top level, keeping its place) or
 * on the space below the rows (the top level, last of its kind).
 */
export type DropTarget = { folder: string; zone: 'into' | 'before' } | { item: string } | { top: true } | { end: true };

/** The table move of a part or assembly at the top level: before another of its kind, or last. */
function tableMove(id: string, before?: string): TreeCommand | null {
  const at = before !== undefined ? { before } : {};
  if (id.startsWith('part_')) return { type: 'movePart', part: id, ...at };
  if (id.startsWith('asm_')) return { type: 'moveAssembly', assembly: id, ...at };
  return null;
}

const kindOf = (id: string) => id.slice(0, id.indexOf('_'));

/**
 * The commands a drop runs, as one undo step; null when it changes nothing
 * or cannot be done. At the top level, folders come first, then the
 * assemblies, then the parts, each kind in its table's order, so an item
 * goes before another of its kind and a drop on one of the other kind only
 * brings it to the top level.
 */
export function dropCommand(tree: FolderTree, dragged: TreeThing, target: DropTarget): TreeCommand[] | null {
  if ('item' in dragged) {
    const id = dragged.item;
    const from = tree.folderOf.get(id) ?? null;
    const unfile: TreeCommand[] = from === null ? [] : [{ type: 'moveToFolder', items: [id] }];
    if ('folder' in target) {
      if (from === target.folder) return null;
      return [{ type: 'moveToFolder', items: [id], folder: target.folder }];
    }
    if ('item' in target) {
      if (target.item === id) return null;
      const to = tree.folderOf.get(target.item);
      if (to !== undefined) return [{ type: 'moveToFolder', items: [id], folder: to, before: target.item }];
      const move = kindOf(target.item) === kindOf(id) ? tableMove(id, target.item) : null;
      const commands = [...unfile, ...(move ? [move] : [])];
      return commands.length > 0 ? commands : null;
    }
    if ('end' in target) {
      const move = tableMove(id);
      const commands = [...unfile, ...(move ? [move] : [])];
      return commands.length > 0 ? commands : null;
    }
    return unfile.length > 0 ? unfile : null;
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
  // Last among its siblings: a folder dropped on the space below the rows.
  if (before === undefined && parent === self.parent && !('end' in target)) return null;
  return [
    {
      type: 'moveFolder',
      folder: id,
      ...(parent !== null ? { parent } : {}),
      ...(before !== undefined ? { before } : {}),
    },
  ];
}

/** The name a move of `commands` is undone as: the moved thing's. */
function moveLabel(doc: Doc, commands: readonly TreeCommand[]): string {
  const first = commands[0];
  const id =
    first === undefined
      ? undefined
      : 'items' in first
        ? first.items[0]
        : 'part' in first
          ? first.part
          : 'assembly' in first
            ? first.assembly
            : first.folder;
  const rows = [
    ...((doc.parts as Json[] | undefined) ?? []),
    ...((doc.assemblies as Json[] | undefined) ?? []),
    ...((doc.folders as Json[] | undefined) ?? []),
  ];
  const name = rows.find((r) => r.id === id)?.name;
  return typeof name === 'string' && name !== '' ? `Move ${name}` : 'Move';
}

/** Runs a tree's commands as one undo step; a refusal takes back the ones before it. */
export function runTreeCommands(editor: Editor, commands: readonly TreeCommand[]): CommandResult {
  const only = commands[0];
  if (commands.length === 1 && only) return editor.dispatch(only);
  const label = moveLabel(editor.document, commands);
  let refused: CommandResult | undefined;
  try {
    return editor.transaction(label, () => {
      let changed = false;
      for (const command of commands) {
        const r = editor.dispatch(command);
        if (!r.ok) throw (refused = r);
        changed ||= r.changed;
      }
      return { ok: true, label, changed } as CommandResult;
    });
  } catch (e) {
    if (refused && e === refused) return refused;
    throw e;
  }
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
