/**
 * The folder tools: the browser's folders (spec 3) that hold parts,
 * assemblies and library entries, nested. They change no geometry.
 */
import type { EditorCommand, Json } from '@tweakcad/editor';
import { addFolder, foldersOf } from '../app/folders';
import { check, optStr, strings, type Args } from './common';
import { ToolError, checkCanEdit, invalid, type AiContext } from './context';

/** A folder id argument that names one of the document's folders. */
function folderArg(ctx: AiContext, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`\`${field}\` is a folder id (fld_…)`);
  if (!foldersOf(ctx.services.editor.document).some((f) => f.id === value))
    throw new ToolError('NOT_FOUND', `There is no folder ${value}; list_features lists the folders`);
  return value;
}

/** A parent argument: a folder id, or "top" (or absent) for the top level. */
function parentArg(ctx: AiContext, value: unknown): string | null {
  if (value === undefined || value === 'top') return null;
  return folderArg(ctx, value, 'parent');
}

/** The folders as `list_features` lists them. */
export function folderOutline(ctx: AiContext): Json[] {
  return foldersOf(ctx.services.editor.document).map((f) => ({
    id: f.id,
    name: f.name,
    parent: f.parent,
    items: f.members,
  }));
}

/** Runs commands as one undo step, refused as a whole. */
function runAll(ctx: AiContext, label: string, commands: EditorCommand[]): void {
  const { editor } = ctx.services;
  if (commands.length === 1) {
    check(editor.dispatch(commands[0] as EditorCommand));
    return;
  }
  editor.transaction(label, () => {
    for (const command of commands) check(editor.dispatch(command));
  });
}

export function folderCreate(ctx: AiContext, args: Args): Json {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const parent = parentArg(ctx, args.parent);
  const items = strings(args, 'items', false) ?? [];
  const before = args.before === undefined ? undefined : folderArg(ctx, args.before, 'before');
  const name = optStr(args, 'name');
  // The folder, its name and its place among its siblings are one undo step.
  const id = editor.transaction('New folder', () => {
    const added = addFolder(editor, parent, items);
    if (!added.ok) throw new ToolError('REFUSED', added.message);
    if (name !== undefined && name.trim() !== '')
      check(editor.dispatch({ type: 'renameFolder', folder: added.id, name: name.trim() }));
    if (before !== undefined)
      check(editor.dispatch({ type: 'moveFolder', folder: added.id, ...(parent !== null ? { parent } : {}), before }));
    return added.id;
  });
  return { folder: id, name: foldersOf(editor.document).find((f) => f.id === id)?.name };
}

export function folderEdit(ctx: AiContext, args: Args): Json {
  checkCanEdit(ctx);
  const folder = folderArg(ctx, args.folder, 'folder');
  const commands: EditorCommand[] = [];
  const name = optStr(args, 'name');
  if (name !== undefined) {
    if (name.trim() === '') throw invalid('`name` is a non-empty string');
    commands.push({ type: 'renameFolder', folder, name: name.trim() });
  }
  if (args.parent !== undefined || args.before !== undefined) {
    const current = foldersOf(ctx.services.editor.document).find((f) => f.id === folder)?.parent ?? null;
    const parent = args.parent === undefined ? current : parentArg(ctx, args.parent);
    const before = args.before === undefined ? undefined : folderArg(ctx, args.before, 'before');
    commands.push({
      type: 'moveFolder',
      folder,
      ...(parent !== null ? { parent } : {}),
      ...(before !== undefined ? { before } : {}),
    });
  }
  if (commands.length === 0) throw invalid('Give `name`, `parent` or `before`');
  runAll(ctx, 'Edit folder', commands);
  return { folder, folders: folderOutline(ctx) };
}

export function folderDelete(ctx: AiContext, args: Args): Json {
  checkCanEdit(ctx);
  const folder = folderArg(ctx, args.folder, 'folder');
  check(ctx.services.editor.dispatch({ type: 'removeFolder', folder }));
  return { removed: folder, folders: folderOutline(ctx) };
}

export function folderMoveItems(ctx: AiContext, args: Args): Json {
  checkCanEdit(ctx);
  const items = strings(args, 'items') as string[];
  const folder = args.folder === undefined || args.folder === 'top' ? null : folderArg(ctx, args.folder, 'folder');
  const before = optStr(args, 'before');
  if (before !== undefined && folder === null) throw invalid('`before` needs a `folder`');
  check(
    ctx.services.editor.dispatch({
      type: 'moveToFolder',
      items,
      ...(folder !== null ? { folder } : {}),
      ...(before !== undefined ? { before } : {}),
    }),
  );
  return { folder: folder ?? 'top', folders: folderOutline(ctx) };
}
