/**
 * The extrude command's model, apart from its panel: what the panel holds
 * (the profiles and the form), the `core.extrude` inputs they make
 * (appendix A, 7.3), writing them as one undo step, the candidate document
 * a preview evaluates, and reading an existing extrude back for editing.
 *
 * Profiles are region rows of a sketch, referenced as the editor writes a
 * region pick. A detected region no row holds yet carries its loop; the
 * commit adds its row first, in the same undo step.
 */
import { NameTable, isPlainObject, makeSet, type ValueTarget } from '@tweakcad/format';
import {
  CommandError,
  Editor,
  bindExpression,
  formatRefusals,
  withDefaultUnit,
  type CommandResult,
  type Doc,
  type Json,
} from '@tweakcad/editor';
import { findFeature, partOf } from '../features';
import { regionReference } from '../picking';
import { featureBefore, featureRow } from './common';
import {
  ValueSlots,
  at,
  exprText,
  fieldReader,
  hideSketches,
  namesOf,
  readTargets,
  targetsInput,
  type PickedRef,
} from './feature';

export { ValueSlots };

/** How the extrude runs from its start: one way, a different extent each way, or the same both ways (the panel's Direction). */
export type SideMode = 'one' | 'two' | 'symmetric';
/** Where one side ends (appendix A extent): a distance, a face or plane, a body, the next or last face met, or through all. */
export type ExtentKind = 'distance' | 'toFace' | 'toBody' | 'upToNext' | 'upToLast' | 'throughAll';
export type Operation = 'new' | 'join' | 'cut' | 'intersect';

export const SIDE_MODES: readonly SideMode[] = ['one', 'two', 'symmetric'];
export const EXTENT_KINDS: readonly ExtentKind[] = [
  'distance',
  'toFace',
  'toBody',
  'upToNext',
  'upToLast',
  'throughAll',
];
export const OPERATIONS: readonly Operation[] = ['new', 'join', 'cut', 'intersect'];

/** A profile: a region row of a sketch, or a reference the panel keeps as it found it. */
export type ExtrudeProfile =
  | {
      sketch: string;
      /** The region row it references. */
      row: string;
      /** The loops of a detected region no row holds yet. */
      detected?: { loop: Json; holes: Json };
    }
  | { kept: Json };

/** One side of an extrude: where it ends, and its taper. */
export interface SideForm {
  extent: ExtentKind;
  /** Expression text: the side's distance. */
  distance: string;
  /** The face or plane (`toFace`) or body (`toBody`) the side ends at, and a label for it. */
  face: PickedRef | null;
  /** Expression text: how far past the face a `toFace` side ends; absent is 0. */
  offset?: string | undefined;
  /** Expression text: the side's taper angle; absent is 0. */
  taper?: string | undefined;
}

export interface ExtrudeForm {
  /** One side (absent too), two sides, or symmetric. */
  sides?: SideMode;
  /** The first side's extent; a symmetric extrude is a distance. */
  extent: ExtentKind;
  /** Expression text: the first side's distance, or the symmetric distance. */
  distance: string;
  /** Where the first side ends for `toFace` or `toBody`, and a label for it. */
  face: PickedRef | null;
  /** Expression text: how far past its face a `toFace` first side ends; absent is 0. */
  offset?: string | undefined;
  /** Expression text: the first side's taper, or both sides' when symmetric; absent is 0. */
  taper?: string | undefined;
  /** A symmetric distance is the whole length (absent too) or each half. */
  measure?: 'total' | 'half';
  /** The second side of a two-sided extrude; absent: 0 mm. */
  side2?: SideForm;
  /** The extrude runs against the sketch normal. */
  reversed: boolean;
  operation: Operation;
  /** The bodies a join, cut or intersect acts on (none: all bodies); absent keeps an edited extrude's targets. */
  targets?: PickedRef[];
  /** Where the extrude starts: on the sketch plane (absent too), offset from it, or on a face or plane. */
  startType?: StartType;
  /** Expression text: how far the start moves along the direction; absent is 0. */
  startOffset?: string;
  /** The face or plane a `face` start begins on, and a label for it. */
  startFace?: PickedRef | null;
}

export type StartType = 'profile' | 'offset' | 'face';

/** Which feature the form writes: a new one, or an existing one. */
export interface ExtrudeTarget {
  part: string;
  /** The feature's id: the new one's, or the one being edited. */
  feature: string;
  /** The new feature's name; absent when editing. */
  name?: string;
  /** Where a new feature goes (absent: the end). */
  before?: string;
  /** The inputs of the feature being edited; their value ids and the parts the form does not cover are kept. */
  base?: Json;
}

const LENGTH: ValueTarget = { type: 'number', quantity: 'length' };
const ANGLE: ValueTarget = { type: 'number', quantity: 'angle' };

/** Text that is a bare number is millimetres, as the panel's unit says. */
export const withUnit = (text: string): string => withDefaultUnit(text, 'mm');

/** The second side a two-sided form starts with. */
export const newSide = (): SideForm => ({ extent: 'distance', distance: '0', face: null, offset: '0', taper: '0' });

/** The profile's sketch, or null for a kept reference. */
export function profileSketch(p: ExtrudeProfile): string | null {
  return 'kept' in p ? null : p.sketch;
}

/**
 * The flip an extrude of `sketch`'s profiles takes for `operation` when the
 * sketch lies on a face of a body: a cut or intersect runs into the body, a
 * join or new body out of it. The sketch's normal is the face's outward
 * normal, turned over by its frame's flip. Null for a sketch on a plane, or
 * no sketch: the operation leaves its flip alone.
 */
export function faceSketchFlip(doc: Doc, sketch: string | null, operation: Operation): boolean | null {
  if (sketch === null) return null;
  const attach = at(findFeature(doc, sketch), 'inputs', 'frame', 'attach');
  const name = at(attach, 'support', 0, 'entity', 'id', 0);
  if (typeof name !== 'string' || at(doc.names, name, 'kind') !== 'face') return null;
  const inward = operation === 'cut' || operation === 'intersect';
  return inward !== fieldReader(doc).flag(at(attach, 'flip'));
}

export const sameProfile = (a: ExtrudeProfile, b: ExtrudeProfile): boolean =>
  'kept' in a || 'kept' in b ? a === b : a.sketch === b.sketch && a.row === b.row;

/** The form fields a refusal can name, to show it under. */
export type ExtrudeField =
  | 'profiles'
  | 'distance'
  | 'face'
  | 'offset'
  | 'taper'
  | 'second'
  | 'face2'
  | 'offset2'
  | 'taper2'
  | 'startOffset'
  | 'startFace';

export type Built = { ok: true; inputs: Json; names: Json } | { ok: false; message: string; field?: ExtrudeField };

/** Text that reads as no length at all: the start stays on the sketch plane. */
const isZero = (text: string): boolean => /^\s*[-+]?0*\.?0*\s*(mm)?\s*$/i.test(text) && /0/.test(text);

/** Empty text is 0. */
const orZero = (text: string | undefined): string => (text === undefined || text.trim() === '' ? '0' : text);

type SideFields = {
  distance: 'distance' | 'second';
  face: 'face' | 'face2';
  offset: 'offset' | 'offset2';
  taper: 'taper' | 'taper2';
};
type Bound = { ok: true; value: Json; stored: number | null } | { ok: false; message: string; field: ExtrudeField };

/** The inputs `form` and `profiles` make for `target`, with the name-table entries their references use. */
export function buildExtrude(
  doc: Doc,
  target: ExtrudeTarget,
  form: ExtrudeForm,
  profiles: readonly ExtrudeProfile[],
  values: ValueSlots,
): Built {
  if (profiles.length === 0) return { ok: false, message: 'Pick a profile', field: 'profiles' };
  const sketches = new Set(profiles.flatMap((p) => profileSketch(p) ?? []));
  const names = new NameTable();
  const extra: Json = {};
  const refs = profiles.map((p) => {
    if ('kept' in p) return p.kept;
    const r = regionReference(p.sketch, p.row);
    Object.assign(extra, r.names);
    return r.reference;
  });
  const scope = target.base
    ? { part: target.part, feature: target.feature }
    : { part: target.part, feature: featureBefore(doc, target.part, target.before) ?? '' };
  // A stored number of null reads a measured value: it is checked when the geometry is evaluated.
  const bind = (path: (string | number)[], text: string, field: ExtrudeField, as: ValueTarget = LENGTH): Bound => {
    const length = as === LENGTH;
    const slot = values.value(path, { expr: { text: length ? '0 mm' : '0 deg', grammar: 1, refs: {} } });
    const bound = bindExpression(
      doc,
      { ...scope, self: slot.id as string },
      length ? withUnit(text) : withDefaultUnit(text, 'deg'),
      as,
    );
    if (!bound.ok) return { ok: false, message: bound.message, field };
    return { ok: true, value: { ...slot, def: bound.def }, stored: bound.stored as number | null };
  };
  const taper = (i: number, text: string | undefined, field: 'taper' | 'taper2'): Bound => {
    const t = bind(['sides', i, 'taper'], orZero(text), field, ANGLE);
    if (t.ok && t.stored !== null && !(Math.abs(t.stored) < 90))
      return { ok: false, message: 'Enter a taper between -90° and 90°', field };
    return t;
  };
  // One side's extent and taper; `fields` names the form fields it is read from.
  const side = (
    i: number,
    s: SideForm,
    fields: SideFields,
  ): { ok: true; side: Json; stored: number | null } | { ok: false; message: string; field: ExtrudeField } => {
    let extent: Json;
    let stored: number | null = null;
    switch (s.extent) {
      case 'distance': {
        const d = bind(['sides', i, 'extent', 'distance', 'd'], s.distance, fields.distance);
        if (!d.ok) return d;
        extent = { distance: { d: d.value } };
        stored = d.stored;
        break;
      }
      case 'toFace': {
        if (!s.face) return { ok: false, message: 'Pick the face or plane to extrude to', field: fields.face };
        const o = bind(['sides', i, 'extent', 'toFace', 'offset'], orZero(s.offset), fields.offset);
        if (!o.ok) return o;
        Object.assign(extra, s.face.names);
        extent = { toFace: { face: s.face.reference, offset: o.value } };
        break;
      }
      case 'toBody':
        if (!s.face) return { ok: false, message: 'Pick the body to extrude to', field: fields.face };
        Object.assign(extra, s.face.names);
        extent = { toBody: { body: s.face.reference } };
        break;
      default:
        extent = { [s.extent]: {} };
    }
    const t = taper(i, s.taper, fields.taper);
    if (!t.ok) return t;
    return { ok: true, side: { extent, taper: t.value }, stored };
  };

  const mode = form.sides ?? 'one';
  let sides: Json[];
  if (mode === 'symmetric') {
    const d = bind(['sides', 0, 'extent', 'symmetric', 'd'], form.distance, 'distance');
    if (!d.ok) return d;
    if (d.stored !== null && !(d.stored > 0))
      return { ok: false, message: 'Enter a positive number', field: 'distance' };
    const t = taper(0, form.taper, 'taper');
    if (!t.ok) return t;
    sides = [
      {
        extent: {
          symmetric: {
            d: d.value,
            measure: values.choice(['sides', 0, 'extent', 'symmetric', 'measure'], form.measure ?? 'total'),
          },
        },
        taper: t.value,
      },
    ];
  } else {
    const first: SideForm = {
      extent: form.extent,
      distance: form.distance,
      face: form.face,
      offset: form.offset,
      taper: form.taper,
    };
    const a = side(0, first, { distance: 'distance', face: 'face', offset: 'offset', taper: 'taper' });
    if (!a.ok) return a;
    if (a.stored !== null && !(a.stored > 0))
      return { ok: false, message: 'Enter a positive number', field: 'distance' };
    sides = [a.side];
    if (mode === 'two') {
      const b = side(1, form.side2 ?? newSide(), {
        distance: 'second',
        face: 'face2',
        offset: 'offset2',
        taper: 'taper2',
      });
      if (!b.ok) return b;
      if (a.stored !== null && b.stored !== null && !(a.stored + b.stored > 0))
        return { ok: false, message: 'Make the two sides add up to more than 0 mm', field: 'second' };
      sides.push(b.side);
    }
  }

  // Along the profiles' sketch normal; an edited extrude that runs another way keeps its direction, flipped as asked.
  const sketch = [...sketches][0];
  const baseDirection = at(target.base, 'direction');
  const kind = isPlainObject(baseDirection) ? Object.keys(baseDirection)[0] : undefined;
  const ownSketchNormal = kind === 'normal' && isPlainObject(at(baseDirection, 'normal', 'ref', 'object', 'feature'));
  let direction: Json;
  if (sketch && (kind === undefined || ownSketchNormal))
    direction = { normal: { ref: { object: { feature: { id: sketch } } } } };
  else if (isPlainObject(baseDirection)) direction = structuredClone(baseDirection);
  else return { ok: false, message: 'Pick a profile of a sketch', field: 'profiles' };
  const branchKind = Object.keys(direction)[0] as string;
  (direction[branchKind] as Json).reversed = values.literal(
    ['direction', branchKind, 'reversed'],
    String(form.reversed),
  );

  const baseOperation = at(target.base, 'operation');
  if (form.targets && form.operation !== 'new') Object.assign(extra, namesOf(form.targets));
  const operation: Json = {
    op: values.literal(['operation', 'op'], `"${form.operation}"`),
    targets: form.targets
      ? targetsInput(form.operation === 'new' ? [] : form.targets)
      : isPlainObject(baseOperation) && baseOperation.targets !== undefined
        ? structuredClone(baseOperation.targets as Json)
        : { all: {} },
    keepTools:
      isPlainObject(baseOperation) && isPlainObject(baseOperation.keepTools)
        ? baseOperation.keepTools
        : values.literal(['operation', 'keepTools'], 'false'),
  };
  let profileSet: Json;
  try {
    profileSet = makeSet(refs) as unknown as Json;
  } catch {
    return { ok: false, message: 'A profile is picked twice', field: 'profiles' };
  }
  // The start (appendix A): absent on the sketch plane, an offset from it, or a face or plane with an offset.
  const offsetText = form.startOffset ?? '0';
  let start: Json | undefined;
  if (form.startType === 'face') {
    if (!form.startFace) return { ok: false, message: 'Pick the face or plane to start from', field: 'startFace' };
    const offset = bind(['start', 'object', 'offset'], orZero(offsetText), 'startOffset');
    if (!offset.ok) return offset;
    Object.assign(extra, form.startFace.names);
    start = { object: { face: form.startFace.reference, offset: offset.value } };
  } else if (offsetText.trim() !== '' && !isZero(offsetText)) {
    const offset = bind(['start', 'offset', 'd'], offsetText, 'startOffset');
    if (!offset.ok) return offset;
    start = { offset: { d: offset.value } };
  }

  const baseThin = at(target.base, 'thin');
  const inputs: Json = {
    ...(target.base ?? {}),
    profiles: profileSet,
    sides,
    direction,
    thin: isPlainObject(baseThin) ? structuredClone(baseThin) : { solid: {} },
    operation,
  };
  if (start) inputs.start = start;
  else delete inputs.start;
  return { ok: true, inputs, names: { ...names.toJson(), ...extra } as Json };
}

/** Writes built inputs to `target` as one undo step: new region rows, then the feature added or its inputs replaced. */
export function writeExtrude(
  editor: Editor,
  target: ExtrudeTarget,
  built: Extract<Built, { ok: true }>,
  profiles: readonly ExtrudeProfile[],
): CommandResult {
  const label = target.base
    ? `Edit ${String(findFeature(editor.document, target.feature)?.name ?? 'Extrude')}`
    : `Add ${target.name ?? 'Extrude'}`;
  const check = (r: CommandResult): void => {
    if (!r.ok) throw new CommandError(r.error.code, r.error.message);
  };
  try {
    return editor.transaction(label, () => {
      for (const p of profiles) {
        if ('kept' in p || !p.detected) continue;
        check(
          editor.dispatch({
            type: 'pickRegion',
            sketch: p.sketch,
            region: { id: p.row, loop: p.detected.loop, holes: p.detected.holes } as unknown as Json,
          }),
        );
      }
      if (target.base) {
        const r = editor.dispatch({
          type: 'replaceInput',
          feature: target.feature,
          pointer: '',
          with: built.inputs,
          names: built.names,
        });
        check(r);
        return r;
      }
      const row = featureRow(editor, target.feature, 'core.extrude', target.name ?? 'Extrude', built.inputs);
      const r = editor.dispatch({
        type: 'addFeature',
        container: target.part,
        feature: row,
        names: built.names,
        ...(target.before ? { before: target.before } : {}),
      });
      check(r);
      hideSketches(
        editor,
        target.part,
        profiles.flatMap((p) => profileSketch(p) ?? []),
      );
      return r;
    });
  } catch (e) {
    if (e instanceof CommandError) return { ok: false, error: e.toFailure() };
    throw e;
  }
}

/**
 * The document with the extrude written, for a preview, without touching
 * the editor's; null with why when it could not be written or would be
 * refused.
 */
export function candidateDocument(
  doc: Doc,
  target: ExtrudeTarget,
  built: Extract<Built, { ok: true }>,
  profiles: readonly ExtrudeProfile[],
  newId: (kind: string) => string,
): { ok: true; doc: Doc } | { ok: false; message: string } {
  const scratch = new Editor(doc, { validate: () => [], ids: newId });
  const r = writeExtrude(scratch, target, built, profiles);
  if (!r.ok) return { ok: false, message: r.error.message };
  const refusals = formatRefusals(scratch.document);
  if (refusals.length > 0) return { ok: false, message: (refusals[0] as { message: string }).message };
  return { ok: true, doc: scratch.document };
}

/** The region row of `part`'s sketches a profile reference names, by the record a region pick writes. */
export function regionRowOf(doc: Doc, part: string, reference: unknown): { sketch: string; row: string } | null {
  const id = at(reference, 'entity', 'id');
  if (!Array.isArray(id)) return null;
  const key = JSON.stringify(id);
  const timeline = partOf(doc, part)?.timeline;
  for (const f of Array.isArray(timeline) ? (timeline as Json[]) : []) {
    if (f.type !== 'core.sketch') continue;
    for (const r of (at(f, 'inputs', 'regions') as Json[] | undefined) ?? []) {
      const ref = regionReference(f.id as string, r.id as string).reference;
      if (JSON.stringify(at(ref, 'entity', 'id')) === key) return { sketch: f.id as string, row: r.id as string };
    }
  }
  return null;
}

/** A label for the face, plane or body a stored stop or start names. */
function stopLabel(reference: Json, extent: ExtentKind | 'start'): string {
  const plane = at(reference, 'standard', 'name');
  if (typeof plane === 'string') return `${plane.toUpperCase()} plane`;
  return extent === 'toBody' ? 'Body' : 'Face';
}

/** One stored side as the form shows it. */
function readSide(side: unknown): SideForm {
  const extent = at(side, 'extent');
  const tag = (isPlainObject(extent) ? Object.keys(extent)[0] : 'distance') as ExtentKind;
  const out: SideForm = {
    extent: (EXTENT_KINDS as readonly string[]).includes(tag) ? tag : 'distance',
    distance: '10 mm',
    face: null,
    offset: '0 mm',
    taper: exprText(at(side, 'taper')) || '0 deg',
  };
  if (tag === 'distance') out.distance = exprText(at(extent, 'distance', 'd'));
  else if (tag === 'toFace') {
    const face = at(extent, 'toFace', 'face') as Json;
    out.face = { reference: face, names: {}, label: stopLabel(face, 'toFace') };
    out.offset = exprText(at(extent, 'toFace', 'offset'));
  } else if (tag === 'toBody') {
    const body = at(extent, 'toBody', 'body') as Json;
    out.face = { reference: body, names: {}, label: stopLabel(body, 'toBody') };
  }
  return out;
}

/** What the panel shows for an existing extrude: its form and profiles. */
export function readExtrude(
  doc: Doc,
  part: string,
  feature: string,
): { form: ExtrudeForm; profiles: ExtrudeProfile[]; inputs: Json } | null {
  const row = findFeature(doc, feature);
  if (!row || row.type !== 'core.extrude' || !isPlainObject(row.inputs)) return null;
  const inputs = row.inputs;
  const members = (at(inputs, 'profiles', 'set') as unknown[] | undefined) ?? [];
  const profiles: ExtrudeProfile[] = members.map((m) => regionRowOf(doc, part, m) ?? { kept: m as Json });
  const sides = (at(inputs, 'sides') as Json[] | undefined) ?? [];
  const read = fieldReader(doc);
  const form: ExtrudeForm = {
    sides: 'one',
    extent: 'distance',
    distance: '10 mm',
    face: null,
    reversed: false,
    operation: 'new',
  };
  const symmetric = at(sides, 0, 'extent', 'symmetric');
  if (isPlainObject(symmetric)) {
    form.sides = 'symmetric';
    form.distance = exprText(symmetric.d);
    form.measure = read.choice(symmetric.measure) === 'half' ? 'half' : 'total';
    form.taper = exprText(at(sides, 0, 'taper')) || '0 deg';
  } else {
    const first = readSide(sides[0]);
    Object.assign(form, {
      extent: first.extent,
      distance: first.distance,
      face: first.face,
      offset: first.offset,
      taper: first.taper,
    });
    if (sides.length > 1) {
      form.sides = 'two';
      form.side2 = readSide(sides[1]);
    }
  }
  const start = at(inputs, 'start');
  if (isPlainObject(start) && 'offset' in start) {
    form.startType = 'offset';
    form.startOffset = exprText(at(start, 'offset', 'd'));
  } else if (isPlainObject(start) && 'object' in start) {
    const face = at(start, 'object', 'face') as Json;
    form.startType = 'face';
    form.startOffset = exprText(at(start, 'object', 'offset'));
    form.startFace = { reference: face, names: {}, label: stopLabel(face, 'start') };
  }
  form.reversed = read.flag(at(inputs, 'direction', 'normal', 'reversed'));
  const op = read.choice(at(inputs, 'operation', 'op'));
  if ((OPERATIONS as readonly string[]).includes(op)) form.operation = op as Operation;
  form.targets = readTargets(inputs.operation);
  return { form, profiles, inputs };
}
