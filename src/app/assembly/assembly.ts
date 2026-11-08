/**
 * The assembly commands' model (chapter 12): assemblies, instances of parts,
 * assemblies and library components, joint origins and joints, relations,
 * rigid groups and contact sets, positions and exploded views, written as
 * rows of the editor's assembly-row commands; and what the browser shows of
 * them, with labels such as "Bracket:1" and "Revolute 1".
 *
 * The pose solve (12.2) runs in the worker. Its results are written back as
 * the stored placements and joint states in the same undo step as the edit
 * that moved them (see `commit.ts`).
 */
import { GRAMMAR, canonicalRotation, isPlainObject, makeSet, type Quaternion } from '@tweakcad/format';
import type { Doc, Editor, EditorCommand, Json } from '@tweakcad/editor';
import type { AssemblyDisplay, Display, Placement } from '@tweakcad/worker/src/v2/service/types';
import { emptyPart } from '../document';
import { flagReader, partOf, partsOf } from '../features';
import { literal } from '../modeling/common';

/** Joint kinds (12.1) with their degrees of freedom, in the order the format names them. */
export const JOINT_KINDS = {
  rigid: { label: 'Rigid', dofs: [] },
  revolute: { label: 'Revolute', dofs: ['rz'] },
  slider: { label: 'Slider', dofs: ['tz'] },
  cylindrical: { label: 'Cylindrical', dofs: ['tz', 'rz'] },
  pinSlot: { label: 'Pin-slot', dofs: ['tx', 'rz'] },
  planar: { label: 'Planar', dofs: ['tx', 'ty', 'rz'] },
  ball: { label: 'Ball', dofs: ['rz', 'ry', 'rx'] },
} as const satisfies Record<string, { label: string; dofs: readonly string[] }>;

export type JointKind = keyof typeof JOINT_KINDS;

export const RELATION_KINDS = {
  gear: { label: 'Gear', joints: 2, unit: '' },
  rackPinion: { label: 'Rack and pinion', joints: 2, unit: 'mm/deg' },
  screw: { label: 'Screw', joints: 1, unit: 'mm/deg' },
} as const;

export type RelationKind = keyof typeof RELATION_KINDS;

/** The label of a degree of freedom. */
export const DOF_LABELS: Record<string, string> = {
  tx: 'Slide X',
  ty: 'Slide Y',
  tz: 'Slide Z',
  rx: 'Turn X',
  ry: 'Turn Y',
  rz: 'Turn Z',
};

export const isTranslation = (dof: string) => dof.startsWith('t');

export const IDENTITY_PLACEMENT: Placement = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

export function assembliesOf(doc: Doc): Json[] {
  return Array.isArray(doc.assemblies) ? (doc.assemblies as Json[]) : [];
}

export function assemblyOf(doc: Doc, id: string): Json | undefined {
  return assembliesOf(doc).find((a) => a.id === id);
}

export function libraryOf(doc: Doc): Json[] {
  return Array.isArray(doc.library) ? (doc.library as Json[]) : [];
}

export function rowsOf(assembly: Json | undefined, table: string): Json[] {
  return assembly && Array.isArray(assembly[table]) ? (assembly[table] as Json[]) : [];
}

/** The library entry a `library` value names directly (`{"library": {"id"}}` in its refs, the whole expression). */
export function libraryEntryOf(doc: Doc, value: unknown): Json | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.def) || !isPlainObject(value.def.expr)) return undefined;
  const expr = value.def.expr;
  const refs = isPlainObject(expr.refs) ? expr.refs : {};
  const ref = refs[String(expr.text).trim()];
  const id = isPlainObject(ref) && isPlainObject(ref.library) ? ref.library.id : undefined;
  return libraryOf(doc).find((e) => e.id === id);
}

/** The name of what an instance places, or a derive brings in: a part, an assembly or a library component. */
export function definitionName(doc: Doc, of: unknown): string {
  if (!isPlainObject(of)) return 'Instance';
  if (isPlainObject(of.part)) return String(partOf(doc, String(of.part.id))?.name ?? 'Part');
  if (isPlainObject(of.assembly)) return String(assemblyOf(doc, String(of.assembly.id))?.name ?? 'Assembly');
  if (isPlainObject(of.component)) return String(libraryEntryOf(doc, of.component.value)?.name ?? 'Component');
  return 'Instance';
}

const sameOf = (a: unknown, b: unknown) => JSON.stringify(definitionKey(a)) === JSON.stringify(definitionKey(b));

function definitionKey(of: unknown): unknown {
  if (!isPlainObject(of)) return null;
  if (isPlainObject(of.part)) return { part: of.part.id };
  if (isPlainObject(of.assembly)) return { assembly: of.assembly.id };
  if (isPlainObject(of.component) && isPlainObject(of.component.value)) {
    const def = of.component.value.def as Json | undefined;
    return { component: (def?.expr as Json | undefined)?.refs ?? null };
  }
  return null;
}

/** "Bracket:2": the definition's name and the instance's number among the assembly's instances of it. */
export function instanceLabel(doc: Doc, assembly: Json, instance: string): string {
  const rows = rowsOf(assembly, 'instances');
  const row = rows.find((r) => r.id === instance);
  if (!row) return 'Instance';
  const same = rows.filter((r) => sameOf(r.of, row.of));
  return `${definitionName(doc, row.of)}:${same.indexOf(row) + 1}`;
}

/** A joint's name; without one, "Revolute 2": the joint kind and the joint's number among the assembly's joints of that kind. */
export function jointLabel(assembly: Json, joint: string): string {
  const rows = rowsOf(assembly, 'joints');
  const row = rows.find((r) => r.id === joint);
  if (!row) return 'Joint';
  if (typeof row.name === 'string' && row.name.trim() !== '') return row.name;
  const kind = JOINT_KINDS[row.kind as JointKind]?.label ?? String(row.kind);
  return `${kind} ${rows.filter((r) => r.kind === row.kind).indexOf(row) + 1}`;
}

/** Renames a joint; an empty name gives it its numbered label again. */
export function renameJointCommand(joint: string, name: string): EditorCommand {
  const text = name.trim();
  return text === ''
    ? { type: 'editAssemblyRow', row: joint, unset: ['name'] }
    : { type: 'editAssemblyRow', row: joint, set: { name: text } };
}

/** Whether an attribute targets `joint` (16.1). */
const targetsJoint = (attribute: Json, joint: string) => {
  const target = attribute.target as Json | undefined;
  return isPlainObject(target?.object) && isPlainObject(target.object.joint) && target.object.joint.id === joint;
};

/** The assembly's attribute on `joint`, if any. */
export function jointAttribute(assembly: Json | undefined, joint: string): Json | undefined {
  const attributes = Array.isArray(assembly?.attributes) ? (assembly.attributes as Json[]) : [];
  return attributes.find((a) => targetsJoint(a, joint));
}

/** Whether a joint is locked (16.1): it holds where it stands, and neither Drive nor a drag moves it. */
export function jointLocked(doc: Doc, assembly: Json | undefined, joint: string): boolean {
  const lock = (jointAttribute(assembly, joint)?.properties as Json | undefined)?.locked;
  return lock !== undefined && flagReader(doc)(lock);
}

/**
 * Locks or unlocks a joint, as an attribute of its assembly: locking sets
 * `locked` on the joint's attribute, or adds one; unlocking clears it, and
 * removes the attribute when it sets nothing else.
 */
export function jointLockCommands(editor: Editor, assembly: Json, joint: string, on: boolean): EditorCommand[] {
  const existing = jointAttribute(assembly, joint);
  const props = (existing?.properties as Json | undefined) ?? {};
  if (on) {
    if (existing)
      return [{ type: 'editAttribute', attribute: String(existing.id), set: { locked: literal(editor, 'true') } }];
    const attribute = {
      id: editor.newId('attr'),
      target: { object: { joint: { id: joint } } },
      properties: { locked: literal(editor, 'true') },
    };
    return [{ type: 'addAttribute', owner: String(assembly.id), attribute }];
  }
  if (!existing || !('locked' in props)) return [];
  if (Object.keys(props).length === 1) return [{ type: 'removeAttribute', attribute: String(existing.id) }];
  return [{ type: 'editAttribute', attribute: String(existing.id), unset: ['locked'] }];
}

export function relationLabel(assembly: Json, relation: string): string {
  const rows = rowsOf(assembly, 'relations');
  const row = rows.find((r) => r.id === relation);
  if (!row) return 'Relation';
  const kind = RELATION_KINDS[row.kind as RelationKind]?.label ?? String(row.kind);
  return `${kind} ${rows.filter((r) => r.kind === row.kind).indexOf(row) + 1}`;
}

/** The next free "Base n" among names already taken. */
export function nextName(taken: readonly unknown[], base: string): string {
  const used = new Set(taken.map(String));
  let n = 1;
  while (used.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** A placement as the format stores it (2.7): a unit quaternion in its canonical sign. */
export function storedPlacement(p: Placement): Placement {
  const [x, y, z, w] = p.rotation;
  const n = Math.hypot(x, y, z, w) || 1;
  const rotation = canonicalRotation([x / n, y / n, z / n, w / n] as Quaternion) as Placement['rotation'];
  return {
    position: [p.position[0] + 0, p.position[1] + 0, p.position[2] + 0],
    rotation: rotation.map((c) => c + 0) as Placement['rotation'],
  };
}

/** A path of one instance (9.1). */
export const pathOf = (instance: string): Json => ({ path: [{ instance: { id: instance } }] });

/** The instance id a top-level path names, or null for a nested one or a copy. */
export function instanceOfPath(path: unknown): string | null {
  const steps = isPlainObject(path) && Array.isArray(path.path) ? (path.path as Json[]) : [];
  const only = steps.length === 1 ? steps[0] : undefined;
  return isPlainObject(only) && isPlainObject(only.instance) && typeof only.instance.id === 'string'
    ? only.instance.id
    : null;
}

// ---- rows ----

/** An empty assembly row (12.1). */
export function assemblyRow(editor: Editor, name: string): Json {
  return {
    id: editor.newId('asm'),
    name,
    parameters: [],
    configurations: [],
    instances: [],
    jointOrigins: [],
    joints: [],
    relations: [],
    rigidGroups: [],
    contactSets: [],
    timeline: [],
    positions: [],
    activePosition: { current: {} },
    explodedViews: [],
    attributes: [],
    notes: [],
    properties: {},
    solver: 1,
  };
}

export interface InstanceOptions {
  placement?: Placement;
  grounded?: boolean;
  overrides?: Json[];
}

/** An instance row of `of` (a part, an assembly or a library component). */
export function instanceRow(editor: Editor, of: Json, o: InstanceOptions = {}): Json {
  return {
    id: editor.newId('inst'),
    of,
    placement: storedPlacement(o.placement ?? IDENTITY_PLACEMENT),
    grounded: literal(editor, o.grounded ? 'true' : 'false'),
    suppressed: literal(editor, 'false'),
    overrides: o.overrides ?? [],
  };
}

/** A value object of a library entry, as an instance's `of.component.value` or a derive's `from.component.value`. */
export function libraryValue(editor: Editor, entry: string): Json {
  return {
    id: editor.newId('val'),
    def: { expr: { text: 'component', grammar: GRAMMAR, refs: { component: { library: { id: entry } } } } },
  };
}

/** The commands that make a new assembly holding `parts` (the first grounded), as the document's root. */
export function newAssemblyCommands(
  editor: Editor,
  name: string,
  parts: readonly string[],
): { commands: EditorCommand[]; assembly: string } {
  const row = assemblyRow(editor, name);
  parts.forEach((part, i) =>
    (row.instances as Json[]).push(instanceRow(editor, { part: { id: part } }, { grounded: i === 0 })),
  );
  return {
    assembly: row.id as string,
    commands: [
      { type: 'addAssembly', assembly: row },
      { type: 'setRoot', root: { assembly: { id: row.id } } },
    ],
  };
}

/** The commands that add an empty part and an instance of it to `assembly`. */
export function newPartCommands(
  editor: Editor,
  assembly: string,
  name: string,
): { commands: EditorCommand[]; part: string; instance: string } {
  const part = editor.newId('part');
  const instance = instanceRow(editor, { part: { id: part } });
  return {
    part,
    instance: instance.id as string,
    commands: [
      { type: 'addPart', part: emptyPart(part, name) },
      { type: 'addAssemblyRow', assembly, table: 'instances', row: instance },
    ],
  };
}

/** A part name not taken yet: "Part n". */
export function nextPartName(doc: Doc): string {
  return nextName(
    partsOf(doc).map((p) => p.name),
    'Part',
  );
}

/** Whether an attached frame or joint end mentions instance `instance` anywhere in its references. */
export function mentionsInstance(value: unknown, instance: string): boolean {
  if (Array.isArray(value)) return value.some((v) => mentionsInstance(v, instance));
  if (!isPlainObject(value)) return false;
  if (isPlainObject(value.instance) && value.instance.id === instance) return true;
  return Object.values(value).some((v) => mentionsInstance(v, instance));
}

/** Whether a reference record's names chain through `instance`: the `chain` in its name table entries says so. */
function recordThrough(doc: Doc, value: unknown, instance: string): boolean {
  const names = isPlainObject(doc.names) ? doc.names : {};
  const hashes: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isPlainObject(v)) {
      if (isPlainObject(v.entity) && Array.isArray(v.entity.id)) hashes.push(...(v.entity.id as string[]));
      else Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return hashes.some((h) => mentionsInstance((names[h] as Json | undefined)?.chain, instance));
}

/**
 * Removing an instance removes what stands on it: joint origins attached to
 * its geometry, joints that use those origins or frames on it, relations of
 * those joints, and its membership of groups, contact sets and
 * exploded-view steps.
 */
export function removeInstanceCommands(doc: Doc, assembly: Json, instance: string): EditorCommand[] {
  const commands: EditorCommand[] = [];
  const origins = rowsOf(assembly, 'jointOrigins')
    .filter((o) => recordThrough(doc, o.frame, instance))
    .map((o) => o.id as string);
  const joints = rowsOf(assembly, 'joints')
    .filter((j) =>
      [j.a, j.b].some((end) =>
        isPlainObject(end) && isPlainObject(end.origin)
          ? origins.includes(String(end.origin.id))
          : recordThrough(doc, end, instance),
      ),
    )
    .map((j) => j.id as string);
  commands.push(...removeJointsCommands(assembly, joints, origins));
  for (const table of ['rigidGroups', 'contactSets'] as const) {
    for (const g of rowsOf(assembly, table)) {
      const members = (((g.members as Json | undefined)?.set as Json[] | undefined) ?? []).filter(
        (m) => !mentionsInstance(m, instance),
      );
      const before = ((g.members as Json | undefined)?.set as Json[] | undefined)?.length ?? 0;
      if (members.length === before) continue;
      commands.push(
        members.length < 2
          ? { type: 'removeAssemblyRow', row: g.id as string }
          : { type: 'editAssemblyRow', row: g.id as string, set: { members: makeSet(members) as unknown as Json } },
      );
    }
  }
  for (const e of rowsOf(assembly, 'explodedViews')) {
    const steps = (Array.isArray(e.steps) ? (e.steps as Json[]) : [])
      .map((s) => ({
        ...s,
        instances: makeSet(
          (((s.instances as Json).set as Json[]) ?? []).filter((m) => !mentionsInstance(m, instance)),
        ) as unknown as Json,
      }))
      .filter((s) => ((s.instances as Json).set as Json[]).length > 0);
    if (JSON.stringify(steps) !== JSON.stringify(e.steps))
      commands.push({ type: 'editAssemblyRow', row: e.id as string, set: { steps } });
  }
  commands.push({ type: 'removeAssemblyRow', row: instance });
  return commands;
}

/**
 * Removing joints removes the relations between them, their attributes (a lock),
 * and the joint origins no remaining joint uses (with `origins`, those too).
 */
export function removeJointsCommands(
  assembly: Json,
  joints: readonly string[],
  origins: readonly string[] = [],
): EditorCommand[] {
  const commands: EditorCommand[] = [];
  for (const r of rowsOf(assembly, 'relations')) {
    if (Array.isArray(r.joints) && (r.joints as string[]).some((j) => joints.includes(j)))
      commands.push({ type: 'removeAssemblyRow', row: r.id as string });
  }
  for (const j of joints) {
    const attribute = jointAttribute(assembly, j);
    if (attribute) commands.push({ type: 'removeAttribute', attribute: String(attribute.id) });
    commands.push({ type: 'removeAssemblyRow', row: j });
  }
  const originOf = (end: unknown) => (isPlainObject(end) && isPlainObject(end.origin) ? String(end.origin.id) : null);
  const kept = new Set(
    rowsOf(assembly, 'joints')
      .filter((j) => !joints.includes(j.id as string))
      .flatMap((j) => [originOf(j.a), originOf(j.b)]),
  );
  const used = new Set(
    rowsOf(assembly, 'joints')
      .filter((j) => joints.includes(j.id as string))
      .flatMap((j) => [originOf(j.a), originOf(j.b)]),
  );
  for (const o of rowsOf(assembly, 'jointOrigins')) {
    const id = o.id as string;
    if (origins.includes(id) || (used.has(id) && !kept.has(id))) commands.push({ type: 'removeAssemblyRow', row: id });
  }
  return commands;
}

/** A joint origin row on an attached frame. */
export function jointOriginRow(editor: Editor, frame: Json): Json {
  return { id: editor.newId('jor'), frame };
}

export interface JointOptions {
  /** Limits per degree of freedom, as value texts (mm, deg); absent: free. */
  limits?: Record<string, { min: Json; max: Json }>;
  state?: Record<string, number>;
}

/** A joint row between two joint origins. */
export function jointRow(editor: Editor, kind: JointKind, a: string, b: string, o: JointOptions = {}): Json {
  const limits: Json = {};
  for (const [dof, range] of Object.entries(o.limits ?? {}))
    limits[dof] = { between: { min: range.min, max: range.max } };
  return {
    id: editor.newId('jnt'),
    kind,
    a: { origin: { id: a } },
    b: { origin: { id: b } },
    limits,
    rest: {},
    state: o.state ?? {},
    suppressed: literal(editor, 'false'),
  };
}

/** A relation row between joints. */
export function relationRow(editor: Editor, kind: RelationKind, joints: readonly string[], ratio: Json): Json {
  return { id: editor.newId('rel'), kind, joints: [...joints], ratio };
}

/** A rigid group or contact set of instances. */
export function memberRow(editor: Editor, table: 'rigidGroups' | 'contactSets', instances: readonly string[]): Json {
  return { id: editor.newId(table === 'rigidGroups' ? 'grp' : 'set'), members: makeSet(instances.map(pathOf)) };
}

/** A position holding every joint's current values, from the shown solve. */
export function positionRow(editor: Editor, name: string, solved: AssemblyDisplay | undefined): Json {
  const state: Json = {};
  for (const [joint, values] of Object.entries(solved?.joints ?? {}))
    if (Object.keys(values).length > 0) state[joint] = { ...values };
  return { id: editor.newId('pos'), name, state };
}

/** An exploded view: each step moves its instances by a translation. */
export function explodedRow(
  editor: Editor,
  name: string,
  steps: readonly { instances: readonly string[]; move: Json }[],
): Json {
  return {
    id: editor.newId('exp'),
    name,
    steps: steps.map((s) => ({ instances: makeSet(s.instances.map(pathOf)), transform: s.move })),
  };
}

/** The stored joint state that differs from the solved one by more than this does not stay as it is. */
const SOLVED_TOLERANCE = 1e-7;

function differs(a: readonly number[], b: readonly number[]): boolean {
  return a.some((v, i) => Math.abs(v - (b[i] ?? NaN)) > SOLVED_TOLERANCE || Number.isNaN(b[i] ?? NaN));
}

/**
 * The edits that write a solve back (12.2): each top-level instance's
 * placement and each joint's state, where they differ from what is stored.
 * Copies, and instances inside nested assemblies, are their own rows'
 * business and are left as they are.
 */
export function solvedCommands(doc: Doc, display: Display): EditorCommand[] {
  const out: EditorCommand[] = [];
  for (const shown of display.assemblies) {
    const row = assemblyOf(doc, shown.id);
    if (!row) continue;
    const instances = new Map(rowsOf(row, 'instances').map((r) => [r.id as string, r]));
    const done = new Set<string>();
    for (const inst of shown.instances) {
      const steps = isPlainObject(inst.path) && Array.isArray(inst.path.path) ? (inst.path.path as Json[]) : [];
      const first = steps[0];
      const id = isPlainObject(first) && isPlainObject(first.instance) ? String(first.instance.id) : null;
      // A leaf of a nested assembly carries the placement of its own part, not of the instance row.
      if (!id || steps.length !== 1 || done.has(id)) continue;
      done.add(id);
      const stored = instances.get(id)?.placement as Placement | undefined;
      const solved = storedPlacement(inst.placement);
      if (!stored || differs([...stored.position, ...stored.rotation], [...solved.position, ...solved.rotation])) {
        out.push({ type: 'editAssemblyRow', row: id, set: { placement: solved as unknown as Json } });
      }
    }
    for (const joint of rowsOf(row, 'joints')) {
      const values = shown.joints[joint.id as string];
      if (!values || Object.keys(values).length === 0) continue;
      const state = isPlainObject(joint.state) ? (joint.state as Record<string, number>) : {};
      const dofs = Object.keys(values);
      if (
        dofs.some((d) => typeof state[d] !== 'number') ||
        differs(
          dofs.map((d) => state[d] as number),
          dofs.map((d) => values[d] as number),
        )
      ) {
        out.push({
          type: 'editAssemblyRow',
          row: joint.id as string,
          set: { state: Object.fromEntries(dofs.map((d) => [d, (values[d] as number) + 0])) },
        });
      }
    }
  }
  return out;
}

/** What the browser shows of an assembly. */
export interface AssemblyView {
  id: string;
  name: string;
  isRoot: boolean;
  instances: {
    id: string;
    label: string;
    grounded: boolean;
    suppressed: boolean;
    status: 'success' | 'failed';
    message?: string;
    of: Json;
    part: string | null;
  }[];
  joints: {
    id: string;
    label: string;
    kind: string;
    suppressed: boolean;
    locked: boolean;
    status: 'success' | 'failed';
    message?: string;
    values: Record<string, number>;
  }[];
  relations: { id: string; label: string; status: 'success' | 'failed'; message?: string }[];
  rigidGroups: { id: string; label: string; members: string[] }[];
  contactSets: { id: string; label: string; members: string[] }[];
  positions: { id: string; name: string }[];
  activePosition: string | null;
  explodedViews: { id: string; name: string }[];
}

export function assemblyView(doc: Doc, id: string, display: Display | null): AssemblyView | null {
  const row = assemblyOf(doc, id);
  if (!row) return null;
  const paused = new Map((display?.pauses ?? []).map((p) => [p.feature, p.message]));
  const shown = display?.assemblies.find((a) => a.id === id);
  const status = (row: string) =>
    paused.has(row)
      ? { status: 'failed' as const, message: paused.get(row) as string }
      : { status: 'success' as const };
  const root = isPlainObject(doc.root) && isPlainObject(doc.root.assembly) ? doc.root.assembly.id : null;
  const flag = flagReader(doc);
  const membersOf = (g: Json) =>
    (((g.members as Json | undefined)?.set as Json[] | undefined) ?? []).flatMap((m) => {
      const inst = instanceOfPath(m);
      return inst ? [instanceLabel(doc, row, inst)] : [];
    });
  return {
    id,
    name: String(row.name ?? 'Assembly'),
    isRoot: root === id,
    instances: rowsOf(row, 'instances').map((r) => ({
      id: r.id as string,
      label: instanceLabel(doc, row, r.id as string),
      grounded: flag(r.grounded),
      suppressed: flag(r.suppressed),
      of: r.of as Json,
      part: isPlainObject(r.of) && isPlainObject((r.of as Json).part) ? String(((r.of as Json).part as Json).id) : null,
      ...status(r.id as string),
    })),
    joints: rowsOf(row, 'joints').map((j) => ({
      id: j.id as string,
      label: jointLabel(row, j.id as string),
      kind: String(j.kind),
      suppressed: flag(j.suppressed),
      locked: jointLocked(doc, row, j.id as string),
      values: shown?.joints[j.id as string] ?? {},
      ...status(j.id as string),
    })),
    relations: rowsOf(row, 'relations').map((r) => ({
      id: r.id as string,
      label: relationLabel(row, r.id as string),
      ...status(r.id as string),
    })),
    rigidGroups: rowsOf(row, 'rigidGroups').map((g, i) => ({
      id: g.id as string,
      label: `Rigid Group ${i + 1}`,
      members: membersOf(g),
    })),
    contactSets: rowsOf(row, 'contactSets').map((g, i) => ({
      id: g.id as string,
      label: `Contact Set ${i + 1}`,
      members: membersOf(g),
    })),
    positions: rowsOf(row, 'positions').map((p) => ({ id: p.id as string, name: String(p.name) })),
    activePosition:
      isPlainObject(row.activePosition) && isPlainObject(row.activePosition.position)
        ? String(row.activePosition.position.id)
        : null,
    explodedViews: rowsOf(row, 'explodedViews').map((e) => ({ id: e.id as string, name: String(e.name) })),
  };
}

/** The instance a display index stands for, when it is a top-level instance row. */
export function instanceAt(display: Display | null, assembly: string, index: number): string | null {
  const inst = display?.assemblies.find((a) => a.id === assembly)?.instances[index];
  return inst ? instanceOfPath(inst.path) : null;
}

/** The display indices of an instance row's placed copies (one for a part, several for a nested assembly). */
export function indicesOf(display: Display | null, assembly: string, instance: string): number[] {
  const shown = display?.assemblies.find((a) => a.id === assembly);
  return (shown?.instances ?? []).flatMap((inst, i) => {
    const first = isPlainObject(inst.path) && Array.isArray(inst.path.path) ? (inst.path.path as Json[])[0] : undefined;
    return isPlainObject(first) && isPlainObject(first.instance) && first.instance.id === instance ? [i] : [];
  });
}
