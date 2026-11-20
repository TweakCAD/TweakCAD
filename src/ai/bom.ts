/**
 * The bill-of-materials tools: a part's kind (normal, purchased, reference;
 * 16.1), set on parts or on every part in a folder, and the bill of
 * materials the build gives.
 */
import type { Json } from '@tweakcad/editor';
import { BOM_KINDS, setBom, type BomKind } from '../app/attributes';
import { bomLines } from '../app/bom';
import { foldersOf } from '../app/folders';
import { check, strings, type Args } from './common';
import { ToolError, checkCanEdit, invalid, partArg, settledDisplay, type AiContext } from './context';

/** Every part a folder holds, in it or in its folders. */
function partsInFolder(ctx: AiContext, folder: string): string[] {
  const doc = ctx.services.editor.document;
  const folders = foldersOf(doc);
  if (!folders.some((f) => f.id === folder)) throw new ToolError('NOT_FOUND', `There is no folder ${folder}`);
  const out: string[] = [];
  const walk = (id: string, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const f of folders) {
      if (f.id === id) out.push(...f.members.filter((m) => m.startsWith('part_')));
      else if (f.parent === id) walk(f.id, seen);
    }
  };
  walk(folder, new Set());
  return out;
}

export function partSetBom(ctx: AiContext, args: Args): Json {
  checkCanEdit(ctx);
  const kind = args.kind;
  if (typeof kind !== 'string' || !BOM_KINDS.some((k) => k.kind === kind))
    throw invalid('`kind` is "normal", "purchased" or "reference"');
  const given = strings(args, 'parts', false) ?? [];
  const folder = args.folder;
  if (folder !== undefined && typeof folder !== 'string') throw invalid('`folder` is a folder id (fld_…)');
  const parts = [...given.map((p) => partArg(ctx, p)), ...(folder === undefined ? [] : partsInFolder(ctx, folder))];
  if (parts.length === 0) throw invalid('Give `parts` or a `folder` that holds parts');
  const unique = [...new Set(parts)];
  check(setBom(ctx.services.editor, unique, kind as BomKind));
  return { kind, parts: unique };
}

export async function getBom(ctx: AiContext): Promise<Json> {
  await settledDisplay(ctx);
  const lines = await ctx.services.billOfMaterials();
  return {
    lines: bomLines(lines).map((l) => ({
      part: l.part,
      name: l.name,
      kind: l.kind,
      quantity: l.quantity,
      ...(l.library ? { library: true } : {}),
    })),
    reference: lines.filter((l) => l.kind === 'reference').map((l) => ({ part: l.part, name: l.name })),
  };
}
