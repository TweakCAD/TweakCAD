/**
 * The bill of materials as a file: the parts the document's build places,
 * each with how many, made parts first, then purchased ones. Reference parts
 * are there only for fit, so they are left out, as CAD bills of materials
 * leave out reference components. A part of the document carries the path of
 * the browser folder holding it.
 */
import type { Doc } from '@tweakcad/editor';
import type { BomLine } from '@tweakcad/worker/src/v2/service/types';
import { BOM_KINDS } from './attributes';
import { folderTree, foldersOf } from './folders';

/** The lines a bill of materials lists, in its order. */
export function bomLines(lines: readonly BomLine[]): BomLine[] {
  return [...lines.filter((l) => l.kind === 'normal'), ...lines.filter((l) => l.kind === 'purchased')];
}

/** The browser folder path of a part of the document ("Arm / Hardware"); empty when no folder holds it. */
function folderPath(doc: Doc, part: string): string {
  const tree = folderTree(foldersOf(doc));
  const names: string[] = [];
  const seen = new Set<string>();
  for (let at = tree.folderOf.get(part) ?? null; at !== null && !seen.has(at);) {
    seen.add(at);
    const folder = tree.byId.get(at);
    if (!folder) break;
    names.unshift(folder.name);
    at = folder.parent;
  }
  return names.join(' / ');
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The bill of materials as CSV: item number, part, kind, quantity, folder, source. */
export function bomCsv(doc: Doc, lines: readonly BomLine[]): string {
  const label = (kind: BomLine['kind']) => BOM_KINDS.find((k) => k.kind === kind)?.label ?? kind;
  const rows = bomLines(lines).map((l, i) => [
    i + 1,
    l.name,
    label(l.kind),
    l.quantity,
    l.library ? '' : folderPath(doc, l.part),
    l.library ? 'Library' : 'Document',
  ]);
  return [['Item', 'Part', 'Kind', 'Quantity', 'Folder', 'Source'], ...rows]
    .map((r) => r.map(csvField).join(','))
    .join('\r\n')
    .concat('\r\n');
}
