/**
 * The assembly commands as the ribbon and the browser start them: a new
 * assembly or part, opening a part or an assembly, editing a part in an
 * assembly's context, grounding, suppressing and removing instances;
 * renaming, locking, suppressing and removing joints; rigid groups and
 * contact sets from the selection, positions and exploded views. Each edit
 * goes through `commitSolved`, so the pose its solve gives is written with
 * it.
 */
import { GRAMMAR, isPlainObject } from '@tweakcad/format';
import type { EditorCommand, Json } from '@tweakcad/editor';
import { enqueueToast } from '../../components/toastStore.ts';
import { consoleLog } from '../console';
import { partOf, shownRoot } from '../features';
import { clearSelection } from '../selection';
import type { AppServices } from '../services';
import {
  assemblyOf,
  assembliesOf,
  instanceAt,
  instanceLabel,
  jointLabel,
  jointLockCommands,
  memberRow,
  newAssemblyCommands,
  newPartCommands,
  nextName,
  nextPartName,
  pathOf,
  positionRow,
  removeInstanceCommands,
  removeJointsCommands,
  renameJointCommand,
  rowsOf,
} from './assembly';
import { commitSolved, type Written } from './commit';
import { activePartOf, assemblyDisplay, inContextOf, shownAssembly } from './focus';

export function warn(title: string, message: string): Written {
  consoleLog('warn', message, 'assembly');
  enqueueToast({ tone: 'warning', title, message });
  return { ok: false, message };
}

/** Reports a refused edit, and passes the outcome on. */
export function reported(title: string, written: Written): Written {
  if (!written.ok) warn(title, written.message);
  return written;
}

/** The assembly the window shows, or null. */
export function currentAssembly(services: AppServices): string | null {
  return shownAssembly(services.editor.document, services.app.getState().focus);
}

/** Opens a part or an assembly: the window works on it (the document's root needs no focus). */
export function open(services: AppServices, what: { part: string } | { assembly: string }): void {
  const root = shownRoot(services.editor.document);
  const isRoot = root && JSON.stringify(root) === JSON.stringify(what);
  clearSelection(services.selection);
  services.app.setState({ focus: isRoot ? null : what, panel: null, mode: { kind: 'model' }, exploded: null });
}

/** Edits the part of an instance in the assembly's context (12.4): the assembly shows, features go into the part. */
export function editInPlace(services: AppServices, assembly: string, instance: string): Written {
  const row = rowsOf(assemblyOf(services.editor.document, assembly), 'instances').find((r) => r.id === instance);
  const of = row?.of as Json | undefined;
  if (!of || !isPlainObject(of.part))
    return warn(
      'Edit in Place',
      'Only a part of this document is edited in place; open a component in its own document',
    );
  clearSelection(services.selection);
  services.app.setState({
    focus: { part: String(of.part.id), context: { assembly, at: pathOf(instance) } },
    panel: null,
    mode: { kind: 'model' },
    exploded: null,
  });
  return { ok: true };
}

/** Leaves in-context editing, back to the assembly. */
export function finishInPlace(services: AppServices): void {
  const focus = services.app.getState().focus;
  if (!focus || !('part' in focus) || !focus.context) return;
  open(services, { assembly: focus.context.assembly });
}

/**
 * New Assembly: an assembly holding the part the window shows, grounded.
 * In a document whose root is a part, the assembly becomes the root, so the
 * document's top level is an assembly; otherwise it is opened.
 */
export async function newAssembly(services: AppServices): Promise<Written> {
  const { editor, app } = services;
  const doc = editor.document;
  const part = activePartOf(doc, app.getState().focus);
  const root = shownRoot(doc);
  const name = nextName(
    assembliesOf(doc).map((a) => a.name),
    'Assembly',
  );
  const made = newAssemblyCommands(editor, name, part ? [part] : []);
  const commands = root && 'part' in root ? made.commands : made.commands.filter((c) => c.type !== 'setRoot');
  const written = reported('New Assembly', await commitSolved(services, `New ${name}`, commands));
  if (written.ok) open(services, { assembly: made.assembly });
  return written;
}

/** New Part: an empty part placed in the shown assembly, then edited there in place. */
export async function newPart(services: AppServices): Promise<Written> {
  const assembly = currentAssembly(services);
  if (!assembly) return warn('New Part', 'Open an assembly to add a part to it');
  const name = nextPartName(services.editor.document);
  const made = newPartCommands(services.editor, assembly, name);
  const written = reported('New Part', await commitSolved(services, `New ${name}`, made.commands));
  if (written.ok) editInPlace(services, assembly, made.instance);
  return written;
}

/** A flag value of a row set to `on`, keeping the value's id. */
function flagCommand(row: Json | undefined, field: string, on: boolean): EditorCommand | null {
  const value = row?.[field] as Json | undefined;
  if (!value || typeof value.id !== 'string') return null;
  return {
    type: 'setValueDef',
    value: value.id,
    def: { expr: { text: on ? 'true' : 'false', grammar: GRAMMAR, refs: {} } },
  };
}

export async function setInstanceFlag(
  services: AppServices,
  assembly: string,
  instance: string,
  field: 'grounded' | 'suppressed',
  on: boolean,
): Promise<Written> {
  const asm = assemblyOf(services.editor.document, assembly);
  const row = rowsOf(asm, 'instances').find((r) => r.id === instance);
  const command = flagCommand(row, field, on);
  if (!asm || !command) return warn('Instance', 'There is no such instance');
  const label = `${field === 'grounded' ? (on ? 'Ground' : 'Unground') : on ? 'Suppress' : 'Unsuppress'} ${instanceLabel(services.editor.document, asm, instance)}`;
  return reported(label, await commitSolved(services, label, [command]));
}

export async function removeInstance(services: AppServices, assembly: string, instance: string): Promise<Written> {
  const asm = assemblyOf(services.editor.document, assembly);
  if (!asm) return warn('Delete', 'There is no such assembly');
  clearSelection(services.selection);
  const label = `Delete ${instanceLabel(services.editor.document, asm, instance)}`;
  return reported(
    label,
    await commitSolved(services, label, removeInstanceCommands(services.editor.document, asm, instance)),
  );
}

export async function setJointSuppressed(
  services: AppServices,
  assembly: string,
  joint: string,
  on: boolean,
): Promise<Written> {
  const asm = assemblyOf(services.editor.document, assembly);
  const command = flagCommand(
    rowsOf(asm, 'joints').find((j) => j.id === joint),
    'suppressed',
    on,
  );
  if (!asm || !command) return warn('Joint', 'There is no such joint');
  const label = `${on ? 'Suppress' : 'Unsuppress'} ${jointLabel(asm, joint)}`;
  return reported(label, await commitSolved(services, label, [command]));
}

/** Renames a joint, as one undo step; an empty name gives it its numbered label again. */
export async function renameJoint(
  services: AppServices,
  assembly: string,
  joint: string,
  name: string,
): Promise<Written> {
  const asm = assemblyOf(services.editor.document, assembly);
  if (!asm || !rowsOf(asm, 'joints').some((j) => j.id === joint)) return warn('Rename', 'There is no such joint');
  return reported(
    'Rename',
    await commitSolved(services, `Rename ${jointLabel(asm, joint)}`, [renameJointCommand(joint, name)]),
  );
}

/** Locks or unlocks a joint, as one undo step (Lock Motion): a locked joint holds where it stands. */
export async function setJointLocked(
  services: AppServices,
  assembly: string,
  joint: string,
  on: boolean,
): Promise<Written> {
  const { editor } = services;
  const asm = assemblyOf(editor.document, assembly);
  if (!asm || !rowsOf(asm, 'joints').some((j) => j.id === joint)) return warn('Joint', 'There is no such joint');
  const commands = jointLockCommands(editor, asm, joint, on);
  if (commands.length === 0) return { ok: true };
  const label = `${on ? 'Lock' : 'Unlock'} ${jointLabel(asm, joint)}`;
  return reported(label, await commitSolved(services, label, commands));
}

export async function removeJoint(services: AppServices, assembly: string, joint: string): Promise<Written> {
  const asm = assemblyOf(services.editor.document, assembly);
  if (!asm) return warn('Delete', 'There is no such assembly');
  const label = `Delete ${jointLabel(asm, joint)}`;
  return reported(label, await commitSolved(services, label, removeJointsCommands(asm, [joint])));
}

/** Removes a row with nothing standing on it (a relation, group, contact set or exploded view). */
export async function removeRow(services: AppServices, row: string, label: string): Promise<Written> {
  if (services.app.getState().exploded === row) services.app.setState({ exploded: null });
  return reported(label, await commitSolved(services, label, [{ type: 'removeAssemblyRow', row }]));
}

/** The top-level instances the selection's picks lie on, in the shown assembly, each once. */
export function selectedInstances(services: AppServices, assembly: string): string[] {
  const display = services.display.getState().display;
  const out: string[] = [];
  for (const item of services.selection.getState().items) {
    if (!('key' in item) || item.instance?.assembly !== assembly) continue;
    const id = instanceAt(display, assembly, item.instance.index);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Rigid Group or Contact Set from the instances the selection lies on. */
export async function groupSelected(services: AppServices, table: 'rigidGroups' | 'contactSets'): Promise<Written> {
  const title = table === 'rigidGroups' ? 'Rigid Group' : 'Contact Set';
  const assembly = currentAssembly(services);
  if (!assembly) return warn(title, `Open an assembly to make a ${title.toLowerCase()} in it`);
  const instances = selectedInstances(services, assembly);
  if (instances.length < 2) return warn(title, 'Select faces of at least two instances first');
  const written = reported(
    title,
    await commitSolved(services, `Add ${title}`, [
      { type: 'addAssemblyRow', assembly, table, row: memberRow(services.editor, table, instances) },
    ]),
  );
  if (written.ok) clearSelection(services.selection);
  return written;
}

/** Capture Position: a position of every joint as the shown solve has it. */
export async function capturePosition(services: AppServices): Promise<Written> {
  const assembly = currentAssembly(services);
  if (!assembly) return warn('Position', 'Open an assembly to capture a position of it');
  const asm = assemblyOf(services.editor.document, assembly);
  const name = nextName(
    rowsOf(asm, 'positions').map((p) => p.name),
    'Position',
  );
  const row = positionRow(services.editor, name, assemblyDisplay(services.display.getState().display, assembly));
  return reported(
    'Position',
    await commitSolved(services, `Capture ${name}`, [{ type: 'addAssemblyRow', assembly, table: 'positions', row }]),
  );
}

/** Makes a position the active one, or (without one) the current pose; the solve's joint values are written back. */
export async function activatePosition(services: AppServices, assembly: string, position?: string): Promise<Written> {
  const label = position
    ? `Show ${String(rowsOf(assemblyOf(services.editor.document, assembly), 'positions').find((p) => p.id === position)?.name ?? 'position')}`
    : 'Show current position';
  return reported(
    'Position',
    await commitSolved(services, label, [{ type: 'setActivePosition', assembly, ...(position ? { position } : {}) }]),
  );
}

/** Overwrites a position with the joints as they stand now. */
export async function updatePosition(services: AppServices, assembly: string, position: string): Promise<Written> {
  const solved = assemblyDisplay(services.display.getState().display, assembly);
  const state = positionRow(services.editor, '', solved).state as Json;
  const name = String(
    rowsOf(assemblyOf(services.editor.document, assembly), 'positions').find((p) => p.id === position)?.name ??
      'position',
  );
  return reported(
    'Position',
    await commitSolved(services, `Update ${name}`, [{ type: 'editAssemblyRow', row: position, set: { state } }]),
  );
}

export async function removePosition(services: AppServices, assembly: string, position: string): Promise<Written> {
  const asm = assemblyOf(services.editor.document, assembly);
  const active =
    isPlainObject(asm?.activePosition) && isPlainObject(asm.activePosition.position)
      ? asm.activePosition.position.id
      : null;
  const commands: EditorCommand[] = [
    ...(active === position ? [{ type: 'setActivePosition' as const, assembly }] : []),
    { type: 'removeAssemblyRow', row: position },
  ];
  return reported('Delete', await commitSolved(services, 'Delete position', commands));
}

/** Shows an exploded view of the shown assembly, or its pose again. */
export function showExploded(services: AppServices, exploded: string | null): void {
  services.app.setState({ exploded: services.app.getState().exploded === exploded ? null : exploded });
}

/** Opens an assembly panel, which needs an assembly shown. */
export function startAssemblyPanel(services: AppServices, kind: string, label: string, from?: string): Written {
  if (!currentAssembly(services)) return warn(label, `Open an assembly to use ${label}`);
  if (inContextOf(services.editor.document, services.app.getState().focus))
    return warn(label, `Finish editing in place to use ${label}`);
  if (services.app.getState().mode.kind === 'sketch') services.app.setState({ mode: { kind: 'model' } });
  services.app.setState({ panel: { kind, ...(from ? { from } : {}) } });
  return { ok: true };
}

/** The part of an instance, for Open from its menu. */
export function partOfInstance(services: AppServices, assembly: string, instance: string): string | null {
  const of = rowsOf(assemblyOf(services.editor.document, assembly), 'instances').find((r) => r.id === instance)?.of as
    Json | undefined;
  return of && isPlainObject(of.part) && partOf(services.editor.document, String(of.part.id))
    ? String(of.part.id)
    : null;
}
