/**
 * Joint origins from picks (12.1): a flat face of an instance gives a frame
 * at the face's centre with z its outward normal; a circular edge gives a
 * frame at the circle's centre on the flat face it bounds; a default plane of
 * the assembly gives that plane's frame. The frames are attached to the
 * picked geometry by name, so they follow the parts; they are read in the
 * instance's own frame (12.2).
 *
 * With every degree of freedom at 0, `b`'s frame coincides with `a`'s. The
 * second end is flipped by default, so two faces picked with their outward
 * normals end up face to face.
 *
 * A joint made this way can be edited afterwards (Edit Joint): its frames
 * read back into the form (ends, face to face, offset, angle, kind and
 * limits), and the edit rewrites the joint and the joint origins whose end
 * changed.
 */
import type { EditorCommand, Json } from '@tweakcad/editor';
import { withDefaultUnit } from '@tweakcad/editor';
import { GRAMMAR, isPlainObject } from '@tweakcad/format';
import type { Editor } from '@tweakcad/editor';
import type { SelectionItem } from '../selection';
import type { AppServices } from '../services';
import { planarFrame } from '../modeling/picks';
import { literal } from '../modeling/common';
import { exprText, fieldReader, fieldText, optionOf } from '../modeling/feature';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import {
  JOINT_KINDS,
  instanceLabel,
  jointOriginRow,
  jointRow,
  mentionsInstance,
  rowsOf,
  assemblyOf,
  type JointKind,
} from './assembly';
import { assemblyDisplay, instanceIndex } from './focus';

type V3 = [number, number, number];

/** One picked end of a joint. */
export interface JointEnd {
  /** How the frame is attached: a face's centre, a circle's centre, or a default plane. */
  mode: 'face' | 'circle' | 'standard';
  /** The supports to write, in order, with the names they need. */
  supports: Json[];
  names: Json;
  /** For a face: the centre in the face's placement frame (mm). */
  centre?: [number, number];
  /** The display index of the instance it lies on; null for the assembly's own default geometry. */
  index: number | null;
  label: string;
}

const sub = (a: readonly number[], b: readonly number[]): V3 => [
  (a[0] as number) - (b[0] as number),
  (a[1] as number) - (b[1] as number),
  (a[2] as number) - (b[2] as number),
];
const dot = (a: readonly number[], b: readonly number[]) =>
  (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number);

/** The joint end a click gives, or why it gives none. */
export async function jointEnd(
  services: AppServices,
  item: SelectionItem,
  label: string,
): Promise<JointEnd | { problem: string }> {
  if ('standard' in item) {
    return {
      mode: 'standard',
      supports: [{ standard: { name: item.standard } }],
      names: {},
      index: null,
      label: `${item.standard.toUpperCase()} plane`,
    };
  }
  if (!('key' in item) || !item.instance) return { problem: 'Click a flat face or a round edge of an instance' };
  const info = services.display.getState().display?.entities[item.key];
  const index = item.instance.index;
  if (info?.kind === 'face') {
    const frame = await planarFrame(services, item.key);
    const centroid = (await services.client.properties(item.key))?.measures.centroid;
    if (!frame || !centroid) return { problem: 'This face is not flat; click a flat face or a round edge' };
    const picked = await services.pick(item);
    if (!picked || 'region' in picked) return { problem: 'That face is no longer shown; click it again' };
    const d = sub(centroid, frame.origin);
    return {
      mode: 'face',
      supports: [picked.reference],
      names: picked.names,
      centre: [round(dot(d, frame.x)), round(dot(d, frame.y))],
      index,
      label: `Face of ${label}`,
    };
  }
  if (info?.kind === 'edge') {
    const m = (await services.client.properties(item.key))?.measures;
    const centre = m?.center;
    if (m?.curve !== 'circle' || !centre)
      return { problem: 'This edge is not round; click a round edge or a flat face' };
    const faces = (await services.client.neighbours?.(item.key)) ?? [];
    let flat: number | null = null;
    for (const f of faces) {
      const fm = (await services.client.properties(f))?.measures;
      if (
        fm?.surface === 'plane' &&
        fm.normal &&
        fm.centroid &&
        Math.abs(dot(sub(centre, fm.centroid), fm.normal)) < 1e-6
      ) {
        flat = f;
        break;
      }
    }
    if (flat === null) return { problem: 'This round edge bounds no flat face; click a flat face instead' };
    const face = await services.pick({ key: flat, instance: item.instance });
    const edge = await services.pick(item);
    if (!face || 'region' in face || !edge || 'region' in edge)
      return { problem: 'That edge is no longer shown; click it again' };
    return {
      mode: 'circle',
      supports: [face.reference, edge.reference],
      names: { ...face.names, ...edge.names },
      index,
      label: `Circle of ${label}`,
    };
  }
  return { problem: 'Click a flat face or a round edge of an instance' };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6 + 0;

/** A number field's text as a number, or null. */
export function numberOf(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The attached frame of a joint end, moved along its z by `offset` mm and turned about it by `angle` deg. */
export function endFrame(
  editor: Editor,
  end: JointEnd,
  o: { flip?: boolean; offset?: number; angle?: number } = {},
): Json {
  const [u, v] = end.mode === 'face' ? (end.centre ?? [0, 0]) : [0, 0];
  const text = `placement(vector(${u} mm, ${v} mm, ${o.offset ?? 0} mm), rotate(vector(0, 0, 1), ${o.angle ?? 0} deg))`;
  return {
    attach: {
      support: end.supports,
      mode: literal(editor, end.mode === 'circle' ? '"planeAtPoint"' : '"plane"'),
      offset: { id: editor.newId('val'), def: { expr: { text, grammar: GRAMMAR, refs: {} } } },
      flip: literal(editor, o.flip ? 'true' : 'false'),
    },
  };
}

export interface JointForm {
  kind: JointKind;
  a: JointEnd | null;
  b: JointEnd | null;
  /** The second end is turned to face the first. */
  flip: boolean;
  offset: string;
  angle: string;
  /** Limits per degree of freedom, as number texts; both empty: free. */
  limits: Record<string, { min: string; max: string }>;
  /** The joint the form edits, as it read back; absent for a new joint. */
  editing?: JointEditing;
}

/** A joint being edited: its row, its two joint origins, and the form it read back as. */
export interface JointEditing {
  joint: string;
  a: string;
  b: string;
  read: {
    a: JointEnd;
    b: JointEnd;
    flip: boolean;
    offset: string;
    angle: string;
    /** The expression the second end's flip is stored as, when it is not a literal. */
    flipBound?: string;
  };
}

const NUMBER = '(-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)';
const OFFSET = new RegExp(
  `^placement\\(vector\\(${NUMBER} mm, ${NUMBER} mm, ${NUMBER} mm\\), rotate\\(vector\\(0, 0, 1\\), ${NUMBER} deg\\)\\)$`,
);

/**
 * The end, offset, angle and flip a joint origin's frame was written with
 * by `endFrame`; null for a frame written another way (another attachment
 * mode, a hand-written offset).
 */
function readEnd(
  doc: Json,
  display: Display | null,
  assembly: string,
  frame: unknown,
): { end: JointEnd; flip: boolean; offset: number; angle: number; flipBound?: string } | null {
  if (!isPlainObject(frame) || !isPlainObject(frame.attach)) return null;
  const attach = frame.attach;
  const supports = Array.isArray(attach.support) ? (attach.support as Json[]) : [];
  // The mode and flip as they evaluate: either may be an expression over parameters.
  const read = fieldReader(doc);
  const mode = read.choice(attach.mode);
  const bound = read.bound(attach.flip);
  const flip = bound ? optionOf(bound.value) : read.choice(attach.flip);
  const m = OFFSET.exec(exprText(attach.offset).trim());
  if (!m || (flip !== 'true' && flip !== 'false')) return null;
  const [u, v, offset, angle] = m.slice(1).map(Number) as [number, number, number, number];
  const asm = assemblyOf(doc, assembly);
  const instances = rowsOf(asm, 'instances').map((r) => r.id as string);
  const id = endInstance(doc, assembly, frame, instances);
  const index = id ? instanceIndex(assemblyDisplay(display, assembly), { path: [{ instance: { id } }] }) : -1;
  const label = asm && id ? instanceLabel(doc, asm, id) : 'instance';
  const base = {
    supports,
    names: {},
    flip: flip === 'true',
    offset,
    angle,
    ...(bound ? { flipBound: bound.text } : {}),
  };
  if (supports.length === 1 && isPlainObject(supports[0]?.standard) && mode === 'plane' && u === 0 && v === 0) {
    const name = String((supports[0].standard as Json).name);
    return {
      ...base,
      end: { mode: 'standard', supports, names: {}, index: null, label: `${name.toUpperCase()} plane` },
    };
  }
  if (index < 0) return null;
  if (supports.length === 1 && isPlainObject(supports[0]?.entity) && mode === 'plane') {
    return { ...base, end: { mode: 'face', supports, names: {}, centre: [u, v], index, label: `Face of ${label}` } };
  }
  if (supports.length === 2 && mode === 'planeAtPoint' && u === 0 && v === 0) {
    return { ...base, end: { mode: 'circle', supports, names: {}, index, label: `Circle of ${label}` } };
  }
  return null;
}

/** A number as a field shows it. */
const shown = (n: number) => String(Math.round(n * 1e6) / 1e6 + 0);

/**
 * The form an existing joint reads back as, for editing; null when its
 * frames were not written the way the panel writes them.
 */
export function readJoint(doc: Json, display: Display | null, assembly: string, joint: string): JointForm | null {
  const asm = assemblyOf(doc, assembly);
  const row = rowsOf(asm, 'joints').find((j) => j.id === joint);
  const kind = row?.kind as JointKind | undefined;
  if (!row || !kind || !JOINT_KINDS[kind]) return null;
  const originOf = (end: unknown) => (isPlainObject(end) && isPlainObject(end.origin) ? String(end.origin.id) : null);
  const aId = originOf(row.a);
  const bId = originOf(row.b);
  const origins = rowsOf(asm, 'jointOrigins');
  const aRow = origins.find((o) => o.id === aId);
  const bRow = origins.find((o) => o.id === bId);
  if (!aId || !bId || !aRow || !bRow) return null;
  const a = readEnd(doc, display, assembly, aRow.frame);
  const b = readEnd(doc, display, assembly, bRow.frame);
  // The first end carries the offset and angle; the second only the flip.
  if (!a || !b || a.flip || b.offset !== 0 || b.angle !== 0) return null;
  const limits: JointForm['limits'] = {};
  const stored = isPlainObject(row.limits) ? row.limits : {};
  for (const dof of JOINT_KINDS[kind].dofs) {
    const between = isPlainObject(stored[dof]) ? (stored[dof] as Json).between : undefined;
    if (!isPlainObject(between)) continue;
    const unit = dof.startsWith('t') ? 'mm' : 'deg';
    limits[dof] = { min: fieldText(exprText(between.min), unit), max: fieldText(exprText(between.max), unit) };
  }
  const offset = shown(a.offset);
  const angle = shown(a.angle);
  return {
    kind,
    a: a.end,
    b: b.end,
    flip: b.flip,
    offset,
    angle,
    limits,
    editing: {
      joint,
      a: aId,
      b: bId,
      read: {
        a: a.end,
        b: b.end,
        flip: b.flip,
        offset,
        angle,
        ...(b.flipBound !== undefined ? { flipBound: b.flipBound } : {}),
      },
    },
  };
}

export function newJointForm(): JointForm {
  return { kind: 'revolute', a: null, b: null, flip: true, offset: '0', angle: '0', limits: {} };
}

/** The commands that add a joint from the form: two joint origins and the joint; or why the form is not ready. */
export function jointCommands(
  editor: Editor,
  assembly: string,
  form: JointForm,
): { ok: true; commands: EditorCommand[]; joint: string } | { ok: false; message: string } {
  if (!form.a) return { ok: false, message: 'Click where the first instance joins' };
  if (!form.b) return { ok: false, message: 'Click where the second instance joins' };
  if (form.a.index !== null && form.a.index === form.b.index)
    return { ok: false, message: 'The two ends lie on the same instance' };
  const offset = numberOf(form.offset);
  const angle = numberOf(form.angle);
  if (offset === null) return { ok: false, message: 'The offset is a number of mm' };
  if (angle === null) return { ok: false, message: 'The angle is a number of degrees' };
  const limits: Record<string, { min: Json; max: Json }> = {};
  for (const dof of JOINT_KINDS[form.kind].dofs) {
    const l = form.limits[dof];
    if (!l || (l.min.trim() === '' && l.max.trim() === '')) continue;
    const min = Number(l.min);
    const max = Number(l.max);
    if (l.min.trim() === '' || l.max.trim() === '' || !Number.isFinite(min) || !Number.isFinite(max))
      return { ok: false, message: 'A limit has a lowest and a highest number' };
    if (min > max) return { ok: false, message: "A limit's lowest value is above its highest" };
    const unit = dof.startsWith('t') ? 'mm' : 'deg';
    limits[dof] = {
      min: literal(editor, withDefaultUnit(String(min), unit)),
      max: literal(editor, withDefaultUnit(String(max), unit)),
    };
  }
  if (form.editing)
    return editCommands(
      editor,
      assembly,
      form as JointForm & { a: JointEnd; b: JointEnd; editing: JointEditing },
      offset,
      angle,
      limits,
    );
  const a = jointOriginRow(editor, endFrame(editor, form.a, { offset, angle }));
  const b = jointOriginRow(editor, endFrame(editor, form.b, { flip: form.flip }));
  const joint = jointRow(editor, form.kind, a.id as string, b.id as string, { limits });
  const names = { ...form.a.names, ...form.b.names };
  return {
    ok: true,
    joint: joint.id as string,
    commands: [
      { type: 'addAssemblyRow', assembly, table: 'jointOrigins', row: a, names },
      { type: 'addAssemblyRow', assembly, table: 'jointOrigins', row: b },
      { type: 'addAssemblyRow', assembly, table: 'joints', row: joint },
    ],
  };
}

/**
 * The commands that rewrite an edited joint: each joint origin whose end,
 * offset, angle or flip changed is written again (a new origin when
 * another joint shares it), then the joint's kind and limits. A changed
 * kind starts its state afresh, as its degrees of freedom differ.
 */
function editCommands(
  editor: Editor,
  assembly: string,
  form: JointForm & { a: JointEnd; b: JointEnd; editing: JointEditing },
  offset: number,
  angle: number,
  limits: Record<string, { min: Json; max: Json }>,
): { ok: true; commands: EditorCommand[]; joint: string } {
  const { editing } = form;
  const asm = assemblyOf(editor.document, assembly);
  const row = rowsOf(asm, 'joints').find((j) => j.id === editing.joint) as Json;
  const shared = (origin: string) =>
    rowsOf(asm, 'joints').some(
      (j) =>
        j.id !== editing.joint &&
        [j.a, j.b].some((e) => isPlainObject(e) && isPlainObject(e.origin) && e.origin.id === origin),
    );
  const commands: EditorCommand[] = [];
  const set: Json = {
    kind: form.kind,
    limits: Object.fromEntries(Object.entries(limits).map(([dof, r]) => [dof, { between: r }])),
  };
  if (form.kind !== row.kind) set.state = {};
  const end = (side: 'a' | 'b', changed: boolean, frame: () => Json, names: Json) => {
    if (!changed) return;
    const origin = editing[side];
    if (shared(origin)) {
      const added = jointOriginRow(editor, frame());
      commands.push({ type: 'addAssemblyRow', assembly, table: 'jointOrigins', row: added, names });
      set[side] = { origin: { id: added.id } };
    } else commands.push({ type: 'editAssemblyRow', row: origin, set: { frame: frame() }, names });
  };
  const read = editing.read;
  end(
    'a',
    form.a !== read.a || form.offset !== read.offset || form.angle !== read.angle,
    () => endFrame(editor, form.a, { offset, angle }),
    form.a.names,
  );
  end(
    'b',
    form.b !== read.b || form.flip !== read.flip,
    () => endFrame(editor, form.b, { flip: form.flip }),
    form.b.names,
  );
  commands.push({ type: 'editAssemblyRow', row: editing.joint, set });
  return { ok: true, commands, joint: editing.joint };
}

/** The instance a joint end stands on (by the chain of its references' names), or null for the assembly's ground. */
export function endInstance(doc: Json, assembly: string, end: unknown, instances: readonly string[]): string | null {
  const row = assemblyOf(doc, assembly);
  let frame: unknown = end;
  if (isPlainObject(end) && isPlainObject(end.origin))
    frame = rowsOf(row, 'jointOrigins').find((o) => o.id === (end.origin as Json).id)?.frame;
  const names = isPlainObject(doc.names) ? doc.names : {};
  const hashes: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isPlainObject(v)) {
      if (isPlainObject(v.entity) && Array.isArray(v.entity.id)) hashes.push(...(v.entity.id as string[]));
      else Object.values(v).forEach(walk);
    }
  };
  walk(frame);
  return instances.find((i) => hashes.some((h) => mentionsInstance((names[h] as Json | undefined)?.chain, i))) ?? null;
}

/** The joints an instance moves in: each with the end it stands on. */
export function jointsOf(doc: Json, assembly: string, instance: string): { joint: Json; side: 'a' | 'b' }[] {
  const row = assemblyOf(doc, assembly);
  const instances = rowsOf(row, 'instances').map((r) => r.id as string);
  return rowsOf(row, 'joints').flatMap((j): { joint: Json; side: 'a' | 'b' }[] => {
    const a = endInstance(doc, assembly, j.a, instances);
    const b = endInstance(doc, assembly, j.b, instances);
    return b === instance
      ? [{ joint: j, side: 'b' as const }]
      : a === instance
        ? [{ joint: j, side: 'a' as const }]
        : [];
  });
}
