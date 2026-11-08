/**
 * The assembly features (12.1, appendix A): copies of instances made by an
 * assembly's timeline, never bodies.
 *
 * - Component Pattern (`core.asm.pattern`): copies along one or two
 *   directions or about an axis; a direction or axis is an axis of the
 *   assembly or a straight edge of an instance.
 * - Component Mirror (`core.asm.mirror`): copies reflected in a default
 *   plane or a flat face of an instance. The same hand places the seed's
 *   own part turned to face the mirror (an identical mirror); the
 *   opposite hand makes a new part per seed, a derive of the seed's part
 *   reflected (11.1), placed where the reflection lands.
 * - Replicate (`core.asm.replicate`): a copy at each target frame,
 *   standing to it as the seeds stand to the seed frame, so a bolt placed
 *   in one hole is placed alike in every other. The frames are picked as
 *   joint ends are: a flat face's centre or a round edge's centre.
 *
 * Each copy follows its seed (12.2): it is not an instance row and has no
 * joints of its own. Every value is bound in the assembly's scope.
 */
import { isPlainObject, makeSet } from '@tweakcad/format';
import type { Doc, Editor, EditorCommand, Json } from '@tweakcad/editor';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { emptyPart } from '../document';
import { flagReader, iconKeyOf, partOf, type FeatureRow } from '../features';
import { featureRow } from '../modeling/common';
import {
  axisInput,
  circularSweep,
  directionInput,
  PATTERN_SPACING,
  readCircular,
  readDirection,
  symmetricInput,
  type CircularLayoutForm,
} from '../modeling/bodyFeatures';
import {
  at,
  boundCount,
  boundLength,
  exprText,
  fieldReader,
  fieldText,
  namesOf,
  ValueSlots,
  type FeatureTarget,
  type PickedRef,
} from '../modeling/feature';
import type { AxisChoice } from '../modeling/revolve';
import {
  assemblyOf,
  assembliesOf,
  definitionName,
  instanceLabel,
  instanceOfPath,
  nextName,
  pathOf,
  rowsOf,
} from './assembly';
import { buildDerive } from './derive';

export type AsmFeatureType = 'core.asm.pattern' | 'core.asm.mirror' | 'core.asm.replicate';

/** Each assembly feature type: its panel and the name new ones are numbered from. */
export const ASM_FEATURES: Readonly<Record<AsmFeatureType, { panel: string; baseName: string; title: string }>> = {
  'core.asm.pattern': { panel: 'assembly.pattern', baseName: 'Pattern', title: 'Component Pattern' },
  'core.asm.mirror': { panel: 'assembly.mirror', baseName: 'Mirror', title: 'Component Mirror' },
  'core.asm.replicate': { panel: 'assembly.replicate', baseName: 'Replicate', title: 'Replicate' },
};

export const isAsmFeatureType = (type: unknown): type is AsmFeatureType =>
  typeof type === 'string' && type in ASM_FEATURES;

/** The assembly whose timeline holds `feature`, with the row. */
export function assemblyFeatureOf(doc: Doc, feature: string): { assembly: string; row: Json } | null {
  for (const asm of assembliesOf(doc)) {
    const row = rowsOf(asm, 'timeline').find((f) => f.id === feature);
    if (row) return { assembly: String(asm.id), row };
  }
  return null;
}

/** The next free "Pattern n" in an assembly's timeline. */
export function nextAsmFeatureName(doc: Doc, assembly: string, base: string): string {
  return nextName(
    rowsOf(assemblyOf(doc, assembly), 'timeline').map((f) => f.name),
    base,
  );
}

/** How many copies a feature placed in the shown solve. */
export function copiesOf(display: Display | null, assembly: string, feature: string): number {
  const shown = display?.assemblies.find((a) => a.id === assembly);
  return (shown?.instances ?? []).filter((inst) => {
    const first = isPlainObject(inst.path) && Array.isArray(inst.path.path) ? (inst.path.path as Json[])[0] : undefined;
    return (
      isPlainObject(first) && isPlainObject(first.copy) && isPlainObject(first.copy.op) && first.copy.op.id === feature
    );
  }).length;
}

/** An assembly's timeline as the browser and the timeline show it. */
export function asmTimelineRows(doc: Doc, assembly: string, display: Display | null): FeatureRow[] {
  const paused = new Map((display?.pauses ?? []).map((p) => [p.feature, p.message]));
  const flag = flagReader(doc);
  return rowsOf(assemblyOf(doc, assembly), 'timeline').map((f) => {
    const id = String(f.id);
    const suppressed = flag(f.suppressed);
    const message = paused.get(id);
    return {
      id,
      name: typeof f.name === 'string' ? f.name : id,
      type: String(f.type),
      iconKey: iconKeyOf(f),
      suppressed,
      frozen: false,
      status: suppressed ? 'suppressed' : message !== undefined ? 'failed' : 'success',
      ...(message !== undefined && !suppressed ? { message } : {}),
      hidden: false,
      children: [],
    };
  });
}

// ---- what every assembly feature form shares ----

interface FeatureFormBase {
  /** The feature's id: the new one's, or the one edited. */
  feature: string;
  /** The new feature's name; null when editing. */
  name: string | null;
  /** The inputs of the feature edited; their value ids and the parts the form does not cover are kept. */
  base: Json | null;
  values: ValueSlots;
  /** The instances copied, top-level instance rows of the assembly. */
  instances: string[];
}

export type Built =
  { ok: true; commands: EditorCommand[]; label: string } | { ok: false; message: string; quiet?: boolean };

function newBase(editor: Editor, assembly: string, type: AsmFeatureType): FeatureFormBase {
  return {
    feature: editor.newId('feat'),
    name: nextAsmFeatureName(editor.document, assembly, ASM_FEATURES[type].baseName),
    base: null,
    values: new ValueSlots(() => editor.newId('val')),
    instances: [],
  };
}

function editBase(editor: Editor, row: Json): FeatureFormBase {
  const inputs = row.inputs as Json;
  const members = (at(inputs, 'of', 'set') as Json[] | undefined) ?? [];
  return {
    feature: String(row.id),
    name: null,
    base: inputs,
    values: new ValueSlots(() => editor.newId('val'), inputs, editor.document),
    instances: members.flatMap((m) => instanceOfPath(m) ?? []),
  };
}

const targetOf = (assembly: string, f: FeatureFormBase): FeatureTarget => ({
  part: assembly,
  feature: f.feature,
  ...(f.base ? { base: f.base } : {}),
});

/** The commands that add the feature, or replace the inputs of the one edited. */
function writeCommands(
  editor: Editor,
  assembly: string,
  type: AsmFeatureType,
  f: FeatureFormBase,
  inputs: Json,
  names: Json,
): { commands: EditorCommand[]; label: string } {
  if (f.base) {
    const name = String(assemblyFeatureOf(editor.document, f.feature)?.row.name ?? ASM_FEATURES[type].baseName);
    return {
      commands: [{ type: 'replaceInput', feature: f.feature, pointer: '', with: inputs, names }],
      label: `Edit ${name}`,
    };
  }
  const name = f.name ?? ASM_FEATURES[type].baseName;
  return {
    commands: [
      { type: 'addFeature', container: assembly, feature: featureRow(editor, f.feature, type, name, inputs), names },
    ],
    label: `Add ${name}`,
  };
}

/** The `of` input: the instances as a set of paths. */
function instancesInput(f: FeatureFormBase): Json | null {
  if (f.instances.length === 0) return null;
  return makeSet([...new Set(f.instances)].map(pathOf)) as unknown as Json;
}

/** The instance a click lands on: added to the list, or dropped when it is there already. */
export function toggleInstance(list: readonly string[], instance: string): string[] {
  return list.includes(instance) ? list.filter((i) => i !== instance) : [...list, instance];
}

/** The labels of the copied instances, for the panel's list. */
export function instanceLabels(doc: Doc, assembly: string, instances: readonly string[]): { label: string }[] {
  const asm = assemblyOf(doc, assembly);
  return instances.map((i) => ({ label: asm ? instanceLabel(doc, asm, i) : 'Instance' }));
}

// ---- Component Pattern ----

export interface AsmPatternDirection {
  axis: AxisChoice;
  reversed: boolean;
  count: string;
  spacing: string;
  /** Symmetric: `count`, the original among them, spread both ways, the extra one of an even count after it. */
  symmetric: boolean;
}

export interface AsmPatternForm extends FeatureFormBase {
  /** `kept`: a layout the panel does not show (path, listed spacing), kept as it is. */
  layout: 'linear' | 'circular' | 'kept';
  directions: AsmPatternDirection[];
  circular: CircularLayoutForm;
}

export const newAsmDirection = (axis: 'x' | 'y' | 'z' = 'x'): AsmPatternDirection => ({
  axis: { standard: axis },
  reversed: false,
  count: '3',
  spacing: PATTERN_SPACING,
  symmetric: false,
});

export function newAsmPatternForm(editor: Editor, assembly: string, instances: readonly string[] = []): AsmPatternForm {
  return {
    ...newBase(editor, assembly, 'core.asm.pattern'),
    instances: [...instances],
    layout: 'linear',
    directions: [newAsmDirection('x')],
    circular: { axis: { standard: 'z' }, reversed: false, count: '4', angle: '360', distribution: 'full' },
  };
}

export function readAsmPattern(editor: Editor, row: Json): AsmPatternForm {
  const form: AsmPatternForm = { ...newAsmPatternForm(editor, ''), ...editBase(editor, row) };
  const read = fieldReader(editor.document);
  const layout = at(row.inputs, 'layout') as Json | undefined;
  if (layout && 'linear' in layout) {
    const directions = (at(layout, 'linear', 'directions') as Json[] | undefined) ?? [];
    form.directions = directions.map((d) => ({
      ...readDirection(d.direction, read),
      count: exprText(d.count),
      spacing: fieldText(exprText(at(d, 'spacing', 'equal', 's'))),
      symmetric: d.symmetric !== undefined && read.flag(d.symmetric),
    }));
    if (directions.length === 0 || directions.some((d) => !isPlainObject(at(d, 'spacing', 'equal'))))
      form.layout = 'kept';
  } else if (layout && 'circular' in layout) {
    form.layout = 'circular';
    form.circular = readCircular(layout.circular as Json, read);
  } else form.layout = 'kept';
  return form;
}

const axisNames = (axis: AxisChoice): Json => (axis && 'picked' in axis ? axis.picked.names : {});

export function buildAsmPattern(editor: Editor, assembly: string, form: AsmPatternForm): Built {
  const doc = editor.document;
  const of = instancesInput(form);
  if (!of) return { ok: false, message: 'Click the instances to copy', quiet: true };
  const target = targetOf(assembly, form);
  const values = form.values;
  const names: Json = {};
  let layout: Json;
  if (form.layout === 'kept') layout = structuredClone(at(form.base, 'layout') as Json);
  else if (form.layout === 'linear') {
    const directions: Json[] = [];
    for (const [i, d] of form.directions.entries()) {
      if (!d.axis) return { ok: false, message: 'Pick a direction', quiet: true };
      const path = ['layout', 'linear', 'directions', i];
      const count = boundCount(doc, target, values, [...path, 'count'], d.count, `count${i}`, 'The count', 1);
      if (!count.ok) return count;
      const s = boundLength(
        doc,
        target,
        values,
        [...path, 'spacing', 'equal', 's'],
        d.spacing,
        `spacing${i}`,
        'The spacing',
        { allowNegative: true },
      );
      if (!s.ok) return s;
      directions.push({
        direction: directionInput(values, [...path, 'direction'], d.axis, d.reversed),
        count: count.value,
        spacing: { equal: { s: s.value } },
        ...symmetricInput(values, form.base ?? undefined, [...path, 'symmetric'], d.symmetric),
      });
      Object.assign(names, axisNames(d.axis));
    }
    layout = { linear: { directions } };
  } else {
    const c = form.circular;
    if (!c.axis) return { ok: false, message: 'Pick the axis', quiet: true };
    const path = ['layout', 'circular'];
    const count = boundCount(doc, target, values, [...path, 'count'], c.count, 'count', 'The count', 1);
    if (!count.ok) return count;
    const sweep = circularSweep(doc, target, values, path, c);
    if (!sweep.ok) return sweep;
    layout = {
      circular: {
        axis: axisInput(values, [...path, 'axis'], c.axis, c.reversed),
        count: count.value,
        angle: sweep.angle,
        symmetric: sweep.symmetric,
      },
    };
    Object.assign(names, axisNames(c.axis));
  }
  const skip = isPlainObject(at(form.base, 'skip')) ? (at(form.base, 'skip') as Json) : { set: [] };
  const inputs: Json = { ...(form.base ?? {}), of, layout, skip };
  return { ok: true, ...writeCommands(editor, assembly, 'core.asm.pattern', form, inputs, names) };
}

// ---- Component Mirror ----

export type MirrorPlane = { standard: 'xy' | 'xz' | 'yz' } | { picked: PickedRef };

export interface AsmMirrorForm extends FeatureFormBase {
  plane: MirrorPlane | null;
  hand: 'same' | 'opposite';
  /** The opposite-hand part of each seed already written: kept when the seed stays. */
  parts: Record<string, string>;
}

export function newAsmMirrorForm(editor: Editor, assembly: string, instances: readonly string[] = []): AsmMirrorForm {
  return {
    ...newBase(editor, assembly, 'core.asm.mirror'),
    instances: [...instances],
    plane: { standard: 'yz' },
    hand: 'same',
    parts: {},
  };
}

export function readAsmMirror(editor: Editor, row: Json): AsmMirrorForm {
  const inputs = row.inputs as Json;
  const plane = inputs.plane as Json | undefined;
  const name = at(plane, 'standard', 'name');
  const hand = inputs.hand as Json | undefined;
  const parts: Record<string, string> = {};
  for (const r of (at(hand, 'opposite', 'parts') as Json[] | undefined) ?? []) {
    const inst = instanceOfPath(r.instance);
    const part = at(r, 'part', 'id');
    if (inst && typeof part === 'string') parts[inst] = part;
  }
  return {
    ...editBase(editor, row),
    plane:
      name === 'xy' || name === 'xz' || name === 'yz'
        ? { standard: name }
        : plane
          ? { picked: { reference: plane, names: {}, label: 'Face' } }
          : null,
    hand: hand && 'opposite' in hand ? 'opposite' : 'same',
    parts,
  };
}

/**
 * The opposite-hand part of a seed (12.1): a new part holding a derive of
 * the seed's part reflected in its YZ plane. The evaluator places it where
 * the seed's reflection lands, whatever plane the derive reflects in.
 */
function oppositePart(editor: Editor, seedPart: string, name: string): { part: string; commands: EditorCommand[] } {
  const part = editor.newId('part');
  const feature = editor.newId('feat');
  const values = new ValueSlots(() => editor.newId('val'));
  const built = buildDerive(
    editor.document,
    { part, feature, name: 'Derive 1' },
    {
      source: { part: seedPart },
      x: '0',
      y: '0',
      z: '0',
      operation: 'new',
      mirror: 'yz',
      instance: editor.newId('inst'),
    },
    values,
  );
  if (!built.ok) throw new Error(built.message);
  return {
    part,
    commands: [
      { type: 'addPart', part: emptyPart(part, name) },
      {
        type: 'addFeature',
        container: part,
        feature: featureRow(editor, feature, 'core.derive', 'Derive 1', built.inputs),
      },
    ],
  };
}

export function buildAsmMirror(editor: Editor, assembly: string, form: AsmMirrorForm): Built {
  const doc = editor.document;
  const of = instancesInput(form);
  if (!of) return { ok: false, message: 'Click the instances to mirror', quiet: true };
  if (!form.plane) return { ok: false, message: 'Pick the mirror plane', quiet: true };
  const plane: Json =
    'standard' in form.plane ? { standard: { name: form.plane.standard } } : form.plane.picked.reference;
  const names: Json = 'picked' in form.plane ? namesOf([form.plane.picked]) : {};
  const before: EditorCommand[] = [];
  let hand: Json = { same: {} };
  if (form.hand === 'opposite') {
    const asm = assemblyOf(doc, assembly);
    const rows: Json[] = [];
    for (const inst of [...new Set(form.instances)]) {
      let part = form.parts[inst];
      if (!part || !partOf(doc, part)) {
        const of = rowsOf(asm, 'instances').find((r) => r.id === inst)?.of as Json | undefined;
        if (!of || !isPlainObject(of.part))
          return { ok: false, message: 'Only a part of this document is mirrored to the opposite hand' };
        const made = oppositePart(editor, String(of.part.id), `${definitionName(doc, of)} (Mirror)`);
        part = made.part;
        before.push(...made.commands);
      }
      rows.push({ instance: pathOf(inst), part: { id: part } });
    }
    hand = { opposite: { parts: rows } };
  }
  const inputs: Json = { ...(form.base ?? {}), of, plane, hand };
  const written = writeCommands(editor, assembly, 'core.asm.mirror', form, inputs, names);
  return { ok: true, commands: [...before, ...written.commands], label: written.label };
}

// ---- Replicate ----

/** An attached frame, as picked (a joint end) or as the feature stores it. */
export interface FrameChoice {
  frame: Json;
  names: Json;
  label: string;
}

export interface AsmReplicateForm extends FeatureFormBase {
  seed: FrameChoice | null;
  targets: FrameChoice[];
}

export function newAsmReplicateForm(
  editor: Editor,
  assembly: string,
  instances: readonly string[] = [],
): AsmReplicateForm {
  return { ...newBase(editor, assembly, 'core.asm.replicate'), instances: [...instances], seed: null, targets: [] };
}

export function readAsmReplicate(editor: Editor, row: Json): AsmReplicateForm {
  const inputs = row.inputs as Json;
  const targets = Array.isArray(inputs.targets) ? (inputs.targets as Json[]) : [];
  return {
    ...editBase(editor, row),
    seed: isPlainObject(inputs.seed) ? { frame: inputs.seed, names: {}, label: 'Seed' } : null,
    targets: targets.map((frame, i) => ({ frame, names: {}, label: `Target ${i + 1}` })),
  };
}

export function buildAsmReplicate(editor: Editor, assembly: string, form: AsmReplicateForm): Built {
  const of = instancesInput(form);
  if (!of) return { ok: false, message: 'Click the instances to replicate', quiet: true };
  if (!form.seed) return { ok: false, message: 'Pick where the instances sit', quiet: true };
  if (form.targets.length === 0) return { ok: false, message: 'Pick where the copies go', quiet: true };
  const names: Json = {};
  for (const f of [form.seed, ...form.targets]) Object.assign(names, f.names);
  const inputs: Json = { ...(form.base ?? {}), of, seed: form.seed.frame, targets: form.targets.map((t) => t.frame) };
  return { ok: true, ...writeCommands(editor, assembly, 'core.asm.replicate', form, inputs, names) };
}
