/**
 * Deleting a part or an assembly from the browser. What uses it decides how:
 * - nothing: it goes at once, one undo step;
 * - instances in assemblies: they go with it (with their joints, groups
 *   and exploded steps), once the user agrees, one undo step;
 * - anything else (the document's root, a derive in another part, an
 *   assembly feature): nothing goes, and the user is told what uses it.
 */
import { isPlainObject } from '@tweakcad/format';
import { Editor, type Doc, type EditorCommand, type Json } from '@tweakcad/editor';
import { assemblyOf, instanceLabel, removeInstanceCommands, rowsOf } from './assembly/assembly';
import { candidateOf, commitSolved, type Written } from './assembly/commit';
import { clearSelection } from './selection';
import type { AppServices } from './services';

/** One place that names a part or assembly. */
export type Use =
  | { kind: 'root' }
  | { kind: 'instance'; assembly: string; instance: string; label: string; assemblyName: string }
  | { kind: 'feature'; owner: string; ownerName: string; feature: string; featureName: string }
  | { kind: 'other'; path: string };

const nameOf = (row: Json | undefined, fallback: string) =>
  typeof row?.name === 'string' && row.name !== '' ? row.name : fallback;

/** Whether `o` is the wrapper `{"part": {"id"}}` or `{"assembly": {"id"}}` naming `id`. */
function names(o: Json, id: string): boolean {
  const keys = Object.keys(o);
  if (keys.length !== 1 || (keys[0] !== 'part' && keys[0] !== 'assembly')) return false;
  const inner = o[keys[0]];
  return isPlainObject(inner) && inner.id === id;
}

/**
 * Every place outside the item's own row that names part or assembly `id`:
 * the root, instances, features (a part's derive, an assembly's features),
 * and anything else by path. Attributes are presentational and left out;
 * folders are tidied by the removal itself.
 */
export function usesOf(doc: Doc, id: string): Use[] {
  const out: Use[] = [];
  const skip = new Set(['library', 'names', 'assets', 'folders', 'extensions', 'attributes']);
  const walk = (value: unknown, path: (string | number)[]): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...path, i]));
      return;
    }
    if (!isPlainObject(value)) return;
    // The item's own row.
    if (path.length === 2 && value.id === id) return;
    if (names(value, id)) {
      out.push(classify(doc, path));
      return;
    }
    for (const [k, v] of Object.entries(value)) if (!skip.has(k)) walk(v, [...path, k]);
  };
  walk(doc, []);
  // A row names its target more than once (an instance's `of` and its records): once per row.
  const seen = new Set<string>();
  return out.filter((u) => {
    const key = JSON.stringify(u);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classify(doc: Doc, path: (string | number)[]): Use {
  if (path[0] === 'root') return { kind: 'root' };
  const table = path[0];
  const owner = typeof path[1] === 'number' ? (doc[table as string] as Json[] | undefined)?.[path[1]] : undefined;
  if ((table === 'parts' || table === 'assemblies') && owner) {
    if (table === 'assemblies' && path[2] === 'instances' && typeof path[3] === 'number') {
      const row = rowsOf(owner, 'instances')[path[3]];
      if (row)
        return {
          kind: 'instance',
          assembly: owner.id as string,
          instance: row.id as string,
          label: instanceLabel(doc, owner, row.id as string),
          assemblyName: nameOf(owner, 'Assembly'),
        };
    }
    if (path[2] === 'timeline' && typeof path[3] === 'number') {
      const feature = (owner.timeline as Json[] | undefined)?.[path[3]];
      if (feature)
        return {
          kind: 'feature',
          owner: owner.id as string,
          ownerName: nameOf(owner, table === 'parts' ? 'Part' : 'Assembly'),
          feature: feature.id as string,
          featureName: nameOf(feature, 'Feature'),
        };
    }
  }
  return { kind: 'other', path: `/${path.join('/')}` };
}

/** What deleting `id` would do. */
export type DeletePlan =
  | { kind: 'now'; label: string; commands: EditorCommand[] }
  | { kind: 'confirm'; label: string; commands: EditorCommand[]; instances: Extract<Use, { kind: 'instance' }>[] }
  | { kind: 'blocked'; message: string };

/** The sentence that says why `name` cannot be deleted. */
function blockedMessage(name: string, uses: Use[]): string {
  const why = uses.flatMap((u) =>
    u.kind === 'root'
      ? [`it is the document's root; make another part or assembly the root first`]
      : u.kind === 'feature'
        ? [`${u.featureName} in ${u.ownerName} uses it; remove or change that first`]
        : u.kind === 'other'
          ? [`it is used at ${u.path}`]
          : [],
  );
  return `${name} cannot be deleted: ${why.join('; ')}.`;
}

/** How to delete part or assembly `id`: the commands, and whether the user must agree first. */
export function deletePlan(doc: Doc, id: string): DeletePlan {
  const isPart = id.startsWith('part_');
  const rows = (doc[isPart ? 'parts' : 'assemblies'] as Json[] | undefined) ?? [];
  const row = rows.find((r) => r.id === id);
  if (!row) return { kind: 'blocked', message: `There is no ${isPart ? 'part' : 'assembly'} ${id}.` };
  const name = nameOf(row, isPart ? 'Part' : 'Assembly');
  const uses = usesOf(doc, id);
  const blocking = uses.filter((u) => u.kind !== 'instance');
  if (blocking.length > 0) return { kind: 'blocked', message: blockedMessage(name, blocking) };
  const instances = uses.filter((u): u is Extract<Use, { kind: 'instance' }> => u.kind === 'instance');
  // Each instance's removal is worked out on the document the removals before it leave, so shared joints go once.
  const scratch = new Editor(doc, { validate: () => [] });
  const commands: EditorCommand[] = [];
  try {
    for (const use of instances) {
      const asm = assemblyOf(scratch.document, use.assembly);
      if (!asm) continue;
      for (const c of removeInstanceCommands(scratch.document, asm, use.instance)) {
        const r = scratch.dispatch(c);
        if (!r.ok) throw new Error(r.error.message);
        commands.push(c);
      }
    }
  } catch (e) {
    return { kind: 'blocked', message: `${name} cannot be deleted: ${e instanceof Error ? e.message : String(e)}` };
  }
  commands.push(isPart ? { type: 'removePart', part: id } : { type: 'removeAssembly', assembly: id });
  const label = `Delete ${name}`;
  return instances.length === 0 ? { kind: 'now', label, commands } : { kind: 'confirm', label, commands, instances };
}

/** The question asked before deleting an item its instances place. */
export function confirmMessage(name: string, instances: readonly Extract<Use, { kind: 'instance' }>[]): string {
  const byAssembly = new Map<string, number>();
  for (const u of instances) byAssembly.set(u.assemblyName, (byAssembly.get(u.assemblyName) ?? 0) + 1);
  const where = [...byAssembly].map(([a, n]) => `${n} ${n === 1 ? 'time' : 'times'} in ${a}`).join(', ');
  const them = instances.length === 1 ? 'that instance and its joints' : 'those instances and their joints';
  return `${name} is placed ${where}. Deleting it also removes ${them}.`;
}

/**
 * Deletes part or assembly `id` as one undo step: at once when nothing
 * places it, after `ask` agrees when instances do (the pose is solved again
 * without them). The window stops showing what goes.
 */
export async function deleteItem(
  services: AppServices,
  id: string,
  ask: (title: string, message: string) => Promise<boolean>,
): Promise<Written> {
  const { editor, app, selection } = services;
  const plan = deletePlan(editor.document, id);
  if (plan.kind === 'blocked') return { ok: false, message: plan.message };
  if (plan.kind === 'confirm') {
    const name = plan.label.replace(/^Delete /, '');
    if (!(await ask(`Delete ${name}?`, confirmMessage(name, plan.instances)))) return { ok: true };
  }
  clearSelection(selection);
  if (JSON.stringify(app.getState().focus ?? null).includes(id)) app.setState({ focus: null });
  if (plan.kind === 'confirm') return commitSolved(services, plan.label, plan.commands);
  const candidate = candidateOf(editor.document, plan.commands);
  if (!candidate.ok) return candidate;
  try {
    editor.transaction(plan.label, () => {
      for (const c of plan.commands) {
        const r = editor.dispatch(c);
        if (!r.ok) throw new Error(r.error.message);
      }
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true };
}
