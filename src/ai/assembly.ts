/**
 * The assembly tools (chapter 12): an assembly made of parts, instances
 * inserted, joints between their faces or round edges, driven or dragged,
 * motion links, rigid groups and contact sets, positions, exploded views,
 * a part derived from another (11.1), captured contexts brought up to date
 * (12.4), a hole through several parts (12.3), and the assembly features
 * that copy instances: patterns, mirrors and replicates. Each edit runs as the
 * app's assembly commands do: one undo step, with the pose the joints solve
 * to written back.
 */
import { isPlainObject } from '@tweakcad/format';
import type { EditorCommand, Json } from '@tweakcad/editor';
import { partsOf, shownRoot } from '../app/features';
import { ValueSlots, newTarget } from '../app/modeling/feature';
import { planarFrame } from '../app/modeling/picks';
import {
  JOINT_KINDS,
  RELATION_KINDS,
  assemblyOf,
  assembliesOf,
  assemblyView,
  explodedRow,
  indicesOf,
  instanceLabel,
  instanceRow,
  jointLabel,
  jointLocked,
  jointLockCommands,
  libraryOf,
  libraryValue,
  memberRow,
  newAssemblyCommands,
  nextName,
  positionRow,
  relationRow,
  removeInstanceCommands,
  removeJointsCommands,
  renameJointCommand,
  rowsOf,
  storedPlacement,
  type JointKind,
  type RelationKind,
} from '../app/assembly/assembly';
import { commitSolved } from '../app/assembly/commit';
import { outOfDate, updateContext } from '../app/assembly/contexts';
import { buildDerive, newDeriveForm, type DeriveForm } from '../app/assembly/derive';
import { assemblyDisplay, shownAssembly } from '../app/assembly/focus';
import { jointCommands, jointEnd, newJointForm, type JointEnd } from '../app/assembly/joints';
import { writeMultiHole } from '../app/assembly/multiHole';
import {
  asmTimelineRows,
  assemblyFeatureOf,
  buildAsmMirror,
  buildAsmPattern,
  buildAsmReplicate,
  copiesOf,
  newAsmMirrorForm,
  newAsmPatternForm,
  newAsmReplicateForm,
  readAsmMirror,
  readAsmPattern,
  readAsmReplicate,
  type AsmFeatureType,
  type Built as AsmBuilt,
} from '../app/assembly/asmFeatures';
import { endFrame } from '../app/assembly/joints';
import type { AxisChoice } from '../app/modeling/revolve';
import { literal } from '../app/modeling/common';
import { writeFeature } from '../app/modeling/feature';
import {
  added,
  check,
  currentKey,
  entryOf,
  featureStatus,
  optBool,
  optStr,
  round,
  roundVec,
  str,
  strings,
  vec2,
  type Args,
} from './common';
import { ToolError, checkCanEdit, invalid, partArg, settledDisplay, type AiContext } from './context';

/** The assembly a tool works on: the one named, else the one shown, else the root, else the only one. */
function assemblyArg(ctx: AiContext, v: unknown): string {
  const doc = ctx.services.editor.document;
  if (v !== undefined) {
    if (typeof v !== 'string') throw invalid('`assembly` is an assembly id');
    if (!assemblyOf(doc, v)) throw new ToolError('NOT_FOUND', `There is no assembly ${v}`);
    return v;
  }
  const shown = shownAssembly(doc, ctx.services.app.getState().focus);
  if (shown) return shown;
  const root = shownRoot(doc);
  if (root && 'assembly' in root) return root.assembly;
  const all = assembliesOf(doc);
  if (all.length === 1) return all[0]?.id as string;
  throw new ToolError(
    'NOT_FOUND',
    all.length === 0 ? 'The document has no assembly; make one with assembly_create' : 'Name the `assembly`',
  );
}

function rowArg(ctx: AiContext, assembly: string, table: string, v: unknown, field: string): Json {
  if (typeof v !== 'string') throw invalid(`\`${field}\` is an id`);
  const row = rowsOf(assemblyOf(ctx.services.editor.document, assembly), table).find((r) => r.id === v);
  if (!row) throw new ToolError('NOT_FOUND', `There is no ${field} ${v} in the assembly`);
  return row;
}

async function commit(ctx: AiContext, label: string, commands: EditorCommand[]): Promise<void> {
  checkCanEdit(ctx);
  const written = await commitSolved(ctx.services, label, commands);
  if (!written.ok) throw new ToolError('REFUSED', written.message);
}

const numberArg = (v: unknown, field: string, fallback = 0): number => {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`\`${field}\` is a number`);
  return v;
};

function vec3Arg(v: unknown, field: string): [number, number, number] {
  if (v === undefined) return [0, 0, 0];
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n)))
    throw invalid(`\`${field}\` is [x, y, z] in mm`);
  return [v[0] as number, v[1] as number, v[2] as number];
}

/** What an instance or a derive takes: a part, an assembly or a library component of this document. */
function definitionArg(ctx: AiContext, args: Args): Json {
  const doc = ctx.services.editor.document;
  const kinds = ['part', 'assembly', 'component'].filter((k) => args[k] !== undefined);
  if (kinds.length !== 1) throw invalid('Give one of `part`, `assembly` or `component`');
  const id = str(args, kinds[0] as string);
  if (kinds[0] === 'part') {
    if (!partsOf(doc).some((p) => p.id === id)) throw new ToolError('NOT_FOUND', `There is no part ${id}`);
    return { part: { id } };
  }
  if (kinds[0] === 'assembly') {
    if (!assemblyOf(doc, id)) throw new ToolError('NOT_FOUND', `There is no assembly ${id}`);
    return { assembly: { id } };
  }
  if (!libraryOf(doc).some((e) => e.id === id && e.kind === 'document'))
    throw new ToolError('NOT_FOUND', `There is no component ${id} in the library`);
  return { component: { value: libraryValue(ctx.services.editor, id) } };
}

function quarterTurn(deg: number): [number, number, number, number] {
  const h = (deg * Math.PI) / 360;
  return [0, 0, Math.sin(h), Math.cos(h)];
}

/** What `get_assembly` and the edits return: the assembly as the browser shows it, with placements and joint values. */
async function assemblyResult(ctx: AiContext, assembly: string): Promise<Json> {
  const display = await settledDisplay(ctx);
  const doc = ctx.services.editor.document;
  const view = assemblyView(doc, assembly, display);
  if (!view) throw new ToolError('NOT_FOUND', `There is no assembly ${assembly}`);
  const shown = assemblyDisplay(display, assembly);
  return {
    assembly,
    name: view.name,
    root: view.isRoot,
    instances: view.instances.map((i) => {
      const at = shown?.instances[indicesOf(display, assembly, i.id)[0] ?? -1]?.placement;
      return {
        id: i.id,
        label: i.label,
        of: i.of,
        grounded: i.grounded,
        ...(i.suppressed ? { suppressed: true } : {}),
        ...(at ? { position: roundVec(at.position), rotation: roundVec(at.rotation, 6) } : {}),
        ...(i.status === 'failed' ? { paused: i.message } : {}),
      };
    }),
    joints: view.joints.map((j) => ({
      id: j.id,
      label: j.label,
      kind: j.kind,
      values: Object.fromEntries(Object.entries(j.values).map(([d, v]) => [d, round(v, 6)])),
      ...(j.locked ? { locked: true } : {}),
      ...(j.suppressed ? { suppressed: true } : {}),
      ...(j.status === 'failed' ? { paused: j.message } : {}),
    })),
    relations: view.relations.map((r) => ({
      id: r.id,
      label: r.label,
      ...(r.status === 'failed' ? { paused: r.message } : {}),
    })),
    rigidGroups: view.rigidGroups,
    contactSets: view.contactSets,
    positions: view.positions,
    activePosition: view.activePosition,
    explodedViews: view.explodedViews,
    features: asmTimelineRows(doc, assembly, display).map((f) => ({
      id: f.id,
      type: f.type,
      name: f.name,
      copies: copiesOf(display, assembly, f.id),
      ...(f.suppressed ? { suppressed: true } : {}),
      ...(f.status === 'failed' ? { paused: f.message } : {}),
    })),
    outOfDate: outOfDate(doc, display).map((o) => ({
      part: o.part,
      context: o.context,
      policy: o.policy,
      reasons: o.reasons,
    })),
  };
}

export async function getAssembly(ctx: AiContext, args: Args): Promise<Json> {
  return assemblyResult(ctx, assemblyArg(ctx, args.assembly));
}

export async function assemblyCreate(ctx: AiContext, args: Args): Promise<Json> {
  const { editor } = ctx.services;
  const doc = editor.document;
  const parts = (strings(args, 'parts', false) ?? []).map((p) => partArg(ctx, p));
  const name =
    optStr(args, 'name') ??
    nextName(
      assembliesOf(doc).map((a) => a.name),
      'Assembly',
    );
  const root = shownRoot(doc);
  const asRoot = optBool(args, 'root') ?? (root !== null && 'part' in root);
  const made = newAssemblyCommands(editor, name, parts);
  await commit(ctx, `New ${name}`, asRoot ? made.commands : made.commands.filter((c) => c.type !== 'setRoot'));
  return assemblyResult(ctx, made.assembly);
}

export async function assemblyInsert(ctx: AiContext, args: Args): Promise<Json> {
  const assembly = assemblyArg(ctx, args.assembly);
  if ([args.part, args.subassembly, args.component].filter((v) => v !== undefined).length !== 1)
    throw invalid('Give one of `part`, `subassembly` or `component`');
  const of = definitionArg(ctx, { part: args.part, assembly: args.subassembly, component: args.component });
  if (isPlainObject(of.assembly) && of.assembly.id === assembly)
    throw invalid('An assembly does not hold an instance of itself');
  const position = vec3Arg(args.position, 'position');
  const row = instanceRow(ctx.services.editor, of, {
    placement: { position, rotation: quarterTurn(numberArg(args.angle, 'angle')) },
    grounded: optBool(args, 'grounded') ?? false,
  });
  await commit(ctx, 'Insert', [{ type: 'addAssemblyRow', assembly, table: 'instances', row }]);
  const asm = assemblyOf(ctx.services.editor.document, assembly) as Json;
  return {
    instance: row.id,
    label: instanceLabel(ctx.services.editor.document, asm, row.id as string),
    assembly: await assemblyResult(ctx, assembly),
  };
}

/** A joint end: a face or edge handle of the instance's part, seen through the instance; or a standard plane of the assembly. */
async function endArg(ctx: AiContext, assembly: string, v: unknown, field: string): Promise<JointEnd> {
  if (!isPlainObject(v)) throw invalid(`\`${field}\` is {instance, at} or {standard}`);
  if (typeof v.standard === 'string') {
    const name = v.standard.trim().toLowerCase();
    if (name !== 'xy' && name !== 'xz' && name !== 'yz') throw invalid(`\`${field}.standard\` is xy, xz or yz`);
    const end = await jointEnd(ctx.services, { standard: name }, name);
    if ('problem' in end) throw invalid(end.problem);
    return end;
  }
  const at = await instanceItem(ctx, assembly, v, ['face', 'edge'], field);
  const end = await jointEnd(ctx.services, at.item, at.label);
  if ('problem' in end) throw invalid(end.problem);
  return end;
}

/** `{instance, at}`: an entity handle of an instance's part, seen through that instance. */
async function instanceItem(
  ctx: AiContext,
  assembly: string,
  v: unknown,
  kinds: readonly ('face' | 'edge')[],
  field: string,
) {
  if (!isPlainObject(v)) throw invalid(`\`${field}\` is {instance, at}`);
  const instance = rowArg(ctx, assembly, 'instances', v.instance, `${field}.instance`);
  const display = await settledDisplay(ctx);
  const index = indicesOf(display, assembly, instance.id as string)[0];
  if (index === undefined)
    throw new ToolError('NOT_FOUND', `${String(instance.id)} is not placed (suppressed, or it paused)`);
  const e = entryOf(ctx, v.at, kinds, `${field}.at`);
  const of = instance.of as Json;
  if (!isPlainObject(of.part) || of.part.id !== e.part)
    throw invalid(`${e.handle} is not geometry of the part ${String(instance.id)} places`);
  const key = await currentKey(ctx, e, display);
  const asm = assemblyOf(ctx.services.editor.document, assembly) as Json;
  return {
    item: { key, instance: { assembly, index } },
    label: instanceLabel(ctx.services.editor.document, asm, instance.id as string),
  };
}

export async function assemblyJoint(ctx: AiContext, args: Args): Promise<Json> {
  const assembly = assemblyArg(ctx, args.assembly);
  const kind = str(args, 'kind') as JointKind;
  if (!(kind in JOINT_KINDS)) throw invalid(`\`kind\` is one of ${Object.keys(JOINT_KINDS).join(', ')}`);
  const a = await endArg(ctx, assembly, args.a, 'a');
  const b = await endArg(ctx, assembly, args.b, 'b');
  const limits: Record<string, { min: string; max: string }> = {};
  if (args.limits !== undefined) {
    if (!isPlainObject(args.limits)) throw invalid('`limits` maps a degree of freedom to [min, max]');
    for (const [dof, range] of Object.entries(args.limits)) {
      if (!(JOINT_KINDS[kind].dofs as readonly string[]).includes(dof)) throw invalid(`a ${kind} joint has no ${dof}`);
      const [min, max] = vec2(range, `limits.${dof}`);
      limits[dof] = { min: String(min), max: String(max) };
    }
  }
  const form = {
    ...newJointForm(),
    kind,
    a,
    b,
    flip: optBool(args, 'faceToFace') ?? true,
    offset: String(numberArg(args.offset, 'offset')),
    angle: String(numberArg(args.angle, 'angle')),
    limits,
  };
  const built = jointCommands(ctx.services.editor, assembly, form);
  if (!built.ok) throw invalid(built.message);
  await commit(ctx, `Add ${JOINT_KINDS[kind].label} joint`, built.commands);
  const asm = assemblyOf(ctx.services.editor.document, assembly) as Json;
  return { joint: built.joint, label: jointLabel(asm, built.joint), assembly: await assemblyResult(ctx, assembly) };
}

export async function assemblyDrive(ctx: AiContext, args: Args): Promise<Json> {
  const assembly = assemblyArg(ctx, args.assembly);
  const joint = rowArg(ctx, assembly, 'joints', args.joint, 'joint');
  if (!isPlainObject(args.values)) throw invalid('`values` maps each degree of freedom to a number (mm or deg)');
  if (
    jointLocked(ctx.services.editor.document, assemblyOf(ctx.services.editor.document, assembly), joint.id as string)
  ) {
    throw new ToolError('REFUSED', `${String(joint.id)} is locked; unlock it with assembly_set_joint first`);
  }
  const dofs = JOINT_KINDS[joint.kind as JointKind]?.dofs ?? [];
  const solved = assemblyDisplay(await settledDisplay(ctx), assembly)?.joints[joint.id as string] ?? {};
  const state: Record<string, number> = {};
  for (const d of dofs) state[d] = solved[d] ?? 0;
  for (const [dof, v] of Object.entries(args.values)) {
    if (!(dofs as readonly string[]).includes(dof))
      throw invalid(`a ${String(joint.kind)} joint has no ${dof}; it has ${dofs.join(', ') || 'none'}`);
    state[dof] = numberArg(v, `values.${dof}`);
  }
  const asm = assemblyOf(ctx.services.editor.document, assembly) as Json;
  await commit(ctx, `Drive ${jointLabel(asm, joint.id as string)}`, [
    { type: 'editAssemblyRow', row: joint.id as string, set: { state } },
  ]);
  return assemblyResult(ctx, assembly);
}

export async function assemblyMoveInstance(ctx: AiContext, args: Args): Promise<Json> {
  const assembly = assemblyArg(ctx, args.assembly);
  const instance = rowArg(ctx, assembly, 'instances', args.instance, 'instance');
  const position = vec3Arg(args.position, 'position');
  const placement = { position, rotation: quarterTurn(numberArg(args.angle, 'angle')) };
  await commit(ctx, 'Move instance', [
    {
      type: 'editAssemblyRow',
      row: instance.id as string,
      set: { placement: storedPlacement(placement) as unknown as Json },
    },
  ]);
  return assemblyResult(ctx, assembly);
}

export async function assemblySetInstance(ctx: AiContext, args: Args): Promise<Json> {
  const assembly = assemblyArg(ctx, args.assembly);
  const instance = rowArg(ctx, assembly, 'instances', args.instance, 'instance');
  const commands: EditorCommand[] = [];
  for (const field of ['grounded', 'suppressed'] as const) {
    const on = optBool(args, field);
    const value = instance[field] as Json | undefined;
    if (on === undefined || !value) continue;
    commands.push({
      type: 'setValueDef',
      value: value.id as string,
      def: { expr: { text: String(on), grammar: 1, refs: {} } },
    });
  }
  if (commands.length === 0) throw invalid('Give `grounded` or `suppressed`');
  await commit(ctx, 'Instance', commands);
  return assemblyResult(ctx, assembly);
}

/** Renames, locks or unlocks, suppresses or unsuppresses a joint, as one undo step. */
export async function assemblySetJoint(ctx: AiContext, args: Args): Promise<Json> {
  const assembly = assemblyArg(ctx, args.assembly);
  const joint = rowArg(ctx, assembly, 'joints', args.joint, 'joint');
  const { editor } = ctx.services;
  const asm = assemblyOf(editor.document, assembly) as Json;
  const id = joint.id as string;
  const commands: EditorCommand[] = [];
  const name = optStr(args, 'name');
  if (name !== undefined) commands.push(renameJointCommand(id, name));
  const locked = optBool(args, 'locked');
  if (locked !== undefined) commands.push(...jointLockCommands(editor, asm, id, locked));
  const suppressed = optBool(args, 'suppressed');
  const value = joint.suppressed as Json | undefined;
  if (suppressed !== undefined && value)
    commands.push({
      type: 'setValueDef',
      value: value.id as string,
      def: { expr: { text: String(suppressed), grammar: 1, refs: {} } },
    });
  if (name === undefined && locked === undefined && suppressed === undefined)
    throw invalid('Give `name`, `locked` or `suppressed`');
  if (commands.length > 0) await commit(ctx, `Edit ${jointLabel(asm, id)}`, commands);
  return assemblyResult(ctx, assembly);
}

export async function assemblyDelete(ctx: AiContext, args: Args): Promise<Json> {
  const assembly = assemblyArg(ctx, args.assembly);
  const id = str(args, 'row');
  const asm = assemblyOf(ctx.services.editor.document, assembly) as Json;
  const table = ['instances', 'joints', 'relations', 'rigidGroups', 'contactSets', 'positions', 'explodedViews'].find(
    (t) => rowsOf(asm, t).some((r) => r.id === id),
  );
  if (!table) throw new ToolError('NOT_FOUND', `There is no row ${id} in the assembly`);
  const commands: EditorCommand[] =
    table === 'instances'
      ? removeInstanceCommands(ctx.services.editor.document, asm, id)
      : table === 'joints'
        ? removeJointsCommands(asm, [id])
        : table === 'positions' &&
            isPlainObject(asm.activePosition) &&
            isPlainObject(asm.activePosition.position) &&
            asm.activePosition.position.id === id
          ? [
              { type: 'setActivePosition', assembly },
              { type: 'removeAssemblyRow', row: id },
            ]
          : [{ type: 'removeAssemblyRow', row: id }];
  await commit(ctx, 'Delete', commands);
  return assemblyResult(ctx, assembly);
}

export async function assemblyRelation(ctx: AiContext, args: Args): Promise<Json> {
  const assembly = assemblyArg(ctx, args.assembly);
  const kind = str(args, 'kind') as RelationKind;
  if (!(kind in RELATION_KINDS)) throw invalid(`\`kind\` is one of ${Object.keys(RELATION_KINDS).join(', ')}`);
  const joints = (strings(args, 'joints') as string[]).map(
    (j, i) => rowArg(ctx, assembly, 'joints', j, `joints[${i}]`).id as string,
  );
  if (joints.length !== RELATION_KINDS[kind].joints)
    throw invalid(
      `a ${kind} links ${RELATION_KINDS[kind].joints} joint${RELATION_KINDS[kind].joints === 1 ? '' : 's'}`,
    );
  const ratio = numberArg(args.ratio, 'ratio', NaN);
  if (!Number.isFinite(ratio) || ratio === 0) throw invalid('`ratio` is a number other than 0');
  const row = relationRow(
    ctx.services.editor,
    kind,
    joints,
    literal(ctx.services.editor, kind === 'gear' ? String(ratio) : `${ratio} [mm/deg]`),
  );
  await commit(ctx, `Add ${RELATION_KINDS[kind].label}`, [
    { type: 'addAssemblyRow', assembly, table: 'relations', row },
  ]);
  return { relation: row.id, assembly: await assemblyResult(ctx, assembly) };
}

export async function assemblyGroup(ctx: AiContext, args: Args): Promise<Json> {
  const assembly = assemblyArg(ctx, args.assembly);
  const kind = str(args, 'kind');
  if (kind !== 'rigid' && kind !== 'contact') throw invalid('`kind` is rigid or contact');
  const instances = (strings(args, 'instances') as string[]).map(
    (i, n) => rowArg(ctx, assembly, 'instances', i, `instances[${n}]`).id as string,
  );
  if (new Set(instances).size < 2) throw invalid('A group holds at least two instances');
  const table = kind === 'rigid' ? 'rigidGroups' : 'contactSets';
  const row = memberRow(ctx.services.editor, table, [...new Set(instances)]);
  await commit(ctx, kind === 'rigid' ? 'Add Rigid Group' : 'Add Contact Set', [
    { type: 'addAssemblyRow', assembly, table, row },
  ]);
  return { group: row.id, assembly: await assemblyResult(ctx, assembly) };
}

export async function assemblyPosition(ctx: AiContext, args: Args): Promise<Json> {
  const assembly = assemblyArg(ctx, args.assembly);
  const action = str(args, 'action');
  const asm = assemblyOf(ctx.services.editor.document, assembly) as Json;
  if (action === 'capture') {
    const name =
      optStr(args, 'name') ??
      nextName(
        rowsOf(asm, 'positions').map((p) => p.name),
        'Position',
      );
    const row = positionRow(ctx.services.editor, name, assemblyDisplay(await settledDisplay(ctx), assembly));
    await commit(ctx, `Capture ${name}`, [{ type: 'addAssemblyRow', assembly, table: 'positions', row }]);
    return { position: row.id, assembly: await assemblyResult(ctx, assembly) };
  }
  if (action === 'current') {
    await commit(ctx, 'Show current position', [{ type: 'setActivePosition', assembly }]);
    return assemblyResult(ctx, assembly);
  }
  const position = rowArg(ctx, assembly, 'positions', args.position, 'position').id as string;
  if (action === 'activate') await commit(ctx, 'Show position', [{ type: 'setActivePosition', assembly, position }]);
  else if (action === 'update') {
    const state = positionRow(ctx.services.editor, '', assemblyDisplay(await settledDisplay(ctx), assembly))
      .state as Json;
    await commit(ctx, 'Update position', [{ type: 'editAssemblyRow', row: position, set: { state } }]);
  } else throw invalid('`action` is capture, activate, current or update');
  return assemblyResult(ctx, assembly);
}

export async function assemblyExplodedView(ctx: AiContext, args: Args): Promise<Json> {
  const assembly = assemblyArg(ctx, args.assembly);
  const asm = assemblyOf(ctx.services.editor.document, assembly) as Json;
  if (!Array.isArray(args.steps) || args.steps.length === 0) throw invalid('`steps` is a list of {instances, move}');
  const { editor } = ctx.services;
  const steps = (args.steps as unknown[]).map((s, i) => {
    if (!isPlainObject(s)) throw invalid(`\`steps[${i}]\` is {instances, move}`);
    const instances = (strings(s as Args, 'instances') as string[]).map(
      (id, n) => rowArg(ctx, assembly, 'instances', id, `steps[${i}].instances[${n}]`).id as string,
    );
    const [x, y, z] = vec3Arg(s.move, `steps[${i}].move`);
    return {
      instances,
      move: literal(editor, `placement(vector(${x} mm, ${y} mm, ${z} mm), rotate(vector(0, 0, 1), 0 deg))`),
    };
  });
  const name =
    optStr(args, 'name') ??
    nextName(
      rowsOf(asm, 'explodedViews').map((e) => e.name),
      'Exploded View',
    );
  const row = explodedRow(editor, name, steps);
  await commit(ctx, `Add ${name}`, [{ type: 'addAssemblyRow', assembly, table: 'explodedViews', row }]);
  if (optBool(args, 'show') ?? true) ctx.services.app.setState({ exploded: row.id as string });
  return { explodedView: row.id, assembly: await assemblyResult(ctx, assembly) };
}

export async function featureDerive(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const part = partArg(ctx, args.part);
  const from = definitionArg(ctx, {
    ...(args.fromPart !== undefined ? { part: args.fromPart } : {}),
    ...(args.fromAssembly !== undefined ? { assembly: args.fromAssembly } : {}),
    ...(args.fromComponent !== undefined ? { component: args.fromComponent } : {}),
  });
  if (isPlainObject(from.part) && from.part.id === part) throw invalid('A part does not derive from itself');
  const [x, y, z] = vec3Arg(args.offset, 'offset');
  const mirror = optStr(args, 'mirror') ?? 'none';
  if (!['none', 'xy', 'xz', 'yz'].includes(mirror)) throw invalid('`mirror` is none, xy, xz or yz');
  const operation = optStr(args, 'operation') ?? 'new';
  if (operation !== 'new' && operation !== 'join') throw invalid('`operation` is new or join');
  const source: DeriveForm['source'] = isPlainObject(from.part)
    ? { part: String(from.part.id) }
    : isPlainObject(from.assembly)
      ? { assembly: String(from.assembly.id) }
      : { component: str(args, 'fromComponent') };
  const form: DeriveForm = {
    ...newDeriveForm(editor.document, part, editor.newId('inst')),
    source,
    x: String(x),
    y: String(y),
    z: String(z),
    mirror: mirror as DeriveForm['mirror'],
    operation,
  };
  const target = newTarget(editor, part, 'Derive');
  const built = buildDerive(editor.document, target, form, new ValueSlots(() => editor.newId('val')));
  if (!built.ok) throw invalid(built.message);
  check(writeFeature(editor, target, 'core.derive', built, 'Derive'));
  return added(ctx, target.feature, { name: target.name });
}

export async function assemblyUpdateContexts(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const doc = ctx.services.editor.document;
  const display = await settledDisplay(ctx);
  const only = optStr(args, 'context');
  const stale = outOfDate(doc, display).filter((o) => !only || o.context === only);
  const updated: string[] = [];
  for (const s of stale) {
    const written = await updateContext(ctx.services, s.part, s.context);
    if (!written.ok) throw new ToolError('REFUSED', written.message);
    updated.push(s.context);
  }
  const after = outOfDate(ctx.services.editor.document, await settledDisplay(ctx));
  return { updated, outOfDate: after.map((o) => ({ part: o.part, context: o.context, reasons: o.reasons })) };
}

export async function assemblyHoleThrough(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const assembly = assemblyArg(ctx, args.assembly);
  const start = rowArg(ctx, assembly, 'instances', args.instance, 'instance');
  const display = await settledDisplay(ctx);
  const index = indicesOf(display, assembly, start.id as string)[0];
  if (index === undefined) throw new ToolError('NOT_FOUND', `${String(start.id)} is not placed`);
  const e = entryOf(ctx, args.face, ['face'], 'face');
  const of = start.of as Json;
  if (!isPlainObject(of.part) || of.part.id !== e.part)
    throw invalid(`${e.handle} is not a face of the part ${String(start.id)} places`);
  const key = await currentKey(ctx, e, display);
  const frame = await planarFrame(ctx.services, key);
  if (!frame) throw invalid(`${e.handle} is not flat`);
  if (!Array.isArray(args.points) || args.points.length === 0)
    throw invalid('`points` is a list of [x, y] on the face (mm, in its placement frame)');
  const points = (args.points as unknown[]).map((p, i) => {
    const [x, y] = vec2(p, `points[${i}]`);
    return { id: ctx.services.editor.newId('hp'), x, y };
  });
  const through = (strings(args, 'through') as string[]).map((t, i) => {
    const row = rowArg(ctx, assembly, 'instances', t, `through[${i}]`);
    const at = indicesOf(display, assembly, row.id as string)[0];
    if (at === undefined) throw new ToolError('NOT_FOUND', `${String(row.id)} is not placed`);
    return at;
  });
  const diameter = args.diameter;
  if (typeof diameter !== 'number' && typeof diameter !== 'string')
    throw invalid('`diameter` is a number of mm or an expression');
  const written = await writeMultiHole(
    ctx.services,
    { assembly, face: { key, index }, points, diameter: String(diameter), through },
    frame,
  );
  if (!written.ok) throw new ToolError('REFUSED', written.message);
  return assemblyResult(ctx, assembly);
}

// ---- Assembly features ----

/** The assembly feature `v` names in the assembly, of `type`, or undefined when no feature is given. */
function asmFeatureArg(ctx: AiContext, assembly: string, v: unknown, type: AsmFeatureType): Json | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw invalid('`feature` is a feature id');
  const found = assemblyFeatureOf(ctx.services.editor.document, v);
  if (!found || found.assembly !== assembly)
    throw new ToolError('NOT_FOUND', `There is no assembly feature ${v} in the assembly`);
  if (found.row.type !== type) throw invalid(`${v} is a ${String(found.row.type)}`);
  return found.row;
}

function instancesArg(ctx: AiContext, assembly: string, args: Args, editing: boolean): string[] | undefined {
  if (args.instances === undefined) {
    if (editing) return undefined;
    throw invalid('`instances` lists the instances to copy (inst_…)');
  }
  return (strings(args, 'instances') as string[]).map(
    (id, i) => rowArg(ctx, assembly, 'instances', id, `instances[${i}]`).id as string,
  );
}

const textArg = (v: unknown, field: string): string => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim() !== '') return v;
  throw invalid(`\`${field}\` is a number or an expression`);
};

/** An axis of the assembly, or a straight edge of an instance. */
async function lineArg(ctx: AiContext, assembly: string, v: unknown, field: string): Promise<AxisChoice> {
  if (v === 'x' || v === 'y' || v === 'z') return { standard: v };
  if (typeof v === 'string') throw invalid(`\`${field}\` is 'x', 'y', 'z' or {instance, at}`);
  const at = await instanceItem(ctx, assembly, v, ['edge'], field);
  if ((await ctx.services.client.properties(at.item.key))?.measures.curve !== 'line')
    throw invalid(`\`${field}.at\` is not a straight edge`);
  const picked = await ctx.services.pick(at.item);
  if (!picked || 'region' in picked) throw new ToolError('STALE_HANDLE', 'The edge is no longer shown; list it again');
  return { picked: { reference: picked.reference, names: picked.names, label: `Edge of ${at.label}` } };
}

/** Writes a built assembly feature and returns it with how many copies it placed. */
async function writeAsmFeature(ctx: AiContext, assembly: string, feature: string, built: AsmBuilt): Promise<Json> {
  if (!built.ok) throw invalid(built.message);
  await commit(ctx, built.label, built.commands);
  const display = await settledDisplay(ctx);
  return {
    feature,
    copies: copiesOf(display, assembly, feature),
    ...featureStatus(display, feature),
    assembly: await assemblyResult(ctx, assembly),
  };
}

export async function assemblyPattern(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const assembly = assemblyArg(ctx, args.assembly);
  const { editor } = ctx.services;
  const row = asmFeatureArg(ctx, assembly, args.feature, 'core.asm.pattern');
  const form = row ? readAsmPattern(editor, row) : newAsmPatternForm(editor, assembly);
  const instances = instancesArg(ctx, assembly, args, row !== undefined);
  if (instances) form.instances = instances;
  const layout = optStr(args, 'layout');
  if (layout !== undefined && layout !== 'linear' && layout !== 'circular')
    throw invalid('`layout` is linear or circular');
  if (layout) form.layout = layout;
  if (args.directions !== undefined) {
    if (!Array.isArray(args.directions) || args.directions.length < 1 || args.directions.length > 2)
      throw invalid('`directions` lists one or two {axis, count, spacing}');
    form.directions = [];
    for (const [i, d] of (args.directions as unknown[]).entries()) {
      if (!isPlainObject(d)) throw invalid(`\`directions[${i}]\` is {axis, count, spacing}`);
      form.directions.push({
        axis: await lineArg(ctx, assembly, d.axis ?? (i === 0 ? 'x' : 'y'), `directions[${i}].axis`),
        reversed: d.reversed === true,
        count: textArg(d.count, `directions[${i}].count`),
        spacing: textArg(d.spacing, `directions[${i}].spacing`),
        symmetric: d.symmetric === true,
      });
    }
  } else if (form.layout === 'linear' && !row) throw invalid('A linear pattern takes `directions`');
  if (form.layout === 'circular') {
    if (args.axis !== undefined) form.circular.axis = await lineArg(ctx, assembly, args.axis, 'axis');
    if (args.count !== undefined) form.circular.count = textArg(args.count, 'count');
    else if (!row) throw invalid('A circular pattern takes `count`');
    if (args.angle !== undefined) form.circular.angle = textArg(args.angle, 'angle');
    if (args.reversed !== undefined) form.circular.reversed = args.reversed === true;
    // An angle given, or a symmetric spread, is no longer a full turn.
    if (args.symmetric !== undefined) form.circular.distribution = args.symmetric === true ? 'symmetric' : 'partial';
    else if (args.angle !== undefined && form.circular.distribution === 'full') form.circular.distribution = 'partial';
  }
  return writeAsmFeature(ctx, assembly, form.feature, buildAsmPattern(editor, assembly, form));
}

export async function assemblyMirror(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const assembly = assemblyArg(ctx, args.assembly);
  const { editor } = ctx.services;
  const row = asmFeatureArg(ctx, assembly, args.feature, 'core.asm.mirror');
  const form = row ? readAsmMirror(editor, row) : newAsmMirrorForm(editor, assembly);
  const instances = instancesArg(ctx, assembly, args, row !== undefined);
  if (instances) form.instances = instances;
  const plane = args.plane;
  if (plane === 'xy' || plane === 'xz' || plane === 'yz') form.plane = { standard: plane };
  else if (plane !== undefined) {
    if (typeof plane === 'string') throw invalid("`plane` is 'xy', 'xz', 'yz' or {instance, at}");
    const at = await instanceItem(ctx, assembly, plane, ['face'], 'plane');
    if ((await ctx.services.client.properties(at.item.key))?.measures.surface !== 'plane')
      throw invalid('`plane.at` is not a flat face');
    const picked = await ctx.services.pick(at.item);
    if (!picked || 'region' in picked)
      throw new ToolError('STALE_HANDLE', 'The face is no longer shown; list it again');
    form.plane = { picked: { reference: picked.reference, names: picked.names, label: `Face of ${at.label}` } };
  } else if (!row) throw invalid('`plane` is the mirror plane');
  const hand = optStr(args, 'hand');
  if (hand !== undefined && hand !== 'same' && hand !== 'opposite') throw invalid('`hand` is same or opposite');
  if (hand) form.hand = hand;
  return writeAsmFeature(ctx, assembly, form.feature, buildAsmMirror(editor, assembly, form));
}

export async function assemblyReplicate(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const assembly = assemblyArg(ctx, args.assembly);
  const { editor } = ctx.services;
  const row = asmFeatureArg(ctx, assembly, args.feature, 'core.asm.replicate');
  const form = row ? readAsmReplicate(editor, row) : newAsmReplicateForm(editor, assembly);
  const instances = instancesArg(ctx, assembly, args, row !== undefined);
  if (instances) form.instances = instances;
  const frame = async (v: unknown, field: string) => {
    const end = await endArg(ctx, assembly, v, field);
    return { frame: endFrame(editor, end), names: end.names, label: end.label };
  };
  if (args.seed !== undefined) form.seed = await frame(args.seed, 'seed');
  else if (!row) throw invalid('`seed` is where the instances sit');
  if (args.targets !== undefined) {
    if (!Array.isArray(args.targets) || args.targets.length === 0) throw invalid('`targets` lists where the copies go');
    form.targets = [];
    for (const [i, t] of (args.targets as unknown[]).entries()) form.targets.push(await frame(t, `targets[${i}]`));
  } else if (!row) throw invalid('`targets` lists where the copies go');
  return writeAsmFeature(ctx, assembly, form.feature, buildAsmReplicate(editor, assembly, form));
}
