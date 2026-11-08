/**
 * The fillet and chamfer commands' model (appendix A `core.fillet`,
 * `core.chamfer`): picked edges and faces (a face stands for its creased
 * edges, 7.3 Target set) with one size. The panel edits the feature's first
 * set of the kind it shows; any other set is kept as it is.
 */
import { isPlainObject } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import {
  at,
  measured,
  boundAngle,
  boundLength,
  exprText,
  fieldReader,
  fieldText,
  namesOf,
  picksOf,
  referenceSet,
  type Built,
  type FeatureTarget,
  type PickedRef,
  type ValueSlots,
} from './feature';

export interface FilletForm {
  targets: PickedRef[];
  radius: string;
  /** Sets the panel does not show, kept after the first. */
  kept: Json[];
}

export type ChamferSize = 'distance' | 'twoDistances' | 'distanceAngle';

export interface ChamferForm {
  targets: PickedRef[];
  size: ChamferSize;
  /** `d`, or `d1` for two distances. */
  distance: string;
  /** `d2`. */
  second: string;
  angle: string;
  /** A distance and an angle with the distance on the other face. */
  flipped: boolean;
  kept: Json[];
}

/** A new fillet's radius, a new chamfer's distance and a new shell's thickness: one size, in mm. */
export const BLEND_SIZE = '1';

export function newFilletForm(): FilletForm {
  return { targets: [], radius: BLEND_SIZE, kept: [] };
}

/**
 * A chamfer the other way round. Two distances swap faces, as swapping `d1`
 * and `d2` does in the format; a distance and an angle turns `flipped` over,
 * putting the distance on the other face.
 */
export function flipChamfer(form: Pick<ChamferForm, 'size' | 'distance' | 'second' | 'flipped'>): Partial<ChamferForm> {
  if (form.size === 'distanceAngle') return { flipped: !form.flipped };
  return { distance: form.second, second: form.distance };
}

export function newChamferForm(): ChamferForm {
  return {
    targets: [],
    size: 'distance',
    distance: BLEND_SIZE,
    second: BLEND_SIZE,
    angle: '45',
    flipped: false,
    kept: [],
  };
}

function targetSet(
  targets: readonly PickedRef[],
): { ok: true; set: Json } | { ok: false; message: string; field: string; quiet?: boolean } {
  if (targets.length === 0)
    return { ok: false, message: 'Pick at least one edge or face', field: 'targets', quiet: true };
  return referenceSet(
    targets.map((t) => t.reference),
    'targets',
    'An edge',
  );
}

export function buildFillet(doc: Doc, target: FeatureTarget, form: FilletForm, values: ValueSlots): Built {
  const set = targetSet(form.targets);
  if (!set.ok) return set;
  const r = boundLength(doc, target, values, ['sets', 0, 'radius', 'constant', 's'], form.radius, 'radius', 'Radius');
  if (!r.ok) return r;
  const first: Json = {
    targets: set.set,
    radius: { constant: { s: r.value } },
    setback: values.literal(['sets', 0, 'setback'], '0 mm'),
  };
  return { ok: true, inputs: { ...(target.base ?? {}), sets: [first, ...form.kept] }, names: namesOf(form.targets) };
}

export function buildChamfer(doc: Doc, target: FeatureTarget, form: ChamferForm, values: ValueSlots): Built {
  const set = targetSet(form.targets);
  if (!set.ok) return set;
  let size: Json;
  if (form.size === 'twoDistances') {
    const d1 = boundLength(
      doc,
      target,
      values,
      ['sets', 0, 'size', 'twoDistances', 'd1'],
      form.distance,
      'distance',
      'Distance 1',
    );
    if (!d1.ok) return d1;
    const d2 = boundLength(
      doc,
      target,
      values,
      ['sets', 0, 'size', 'twoDistances', 'd2'],
      form.second,
      'second',
      'Distance 2',
    );
    if (!d2.ok) return d2;
    size = { twoDistances: { d1: d1.value, d2: d2.value } };
  } else {
    const d = boundLength(
      doc,
      target,
      values,
      ['sets', 0, 'size', form.size, 'd'],
      form.distance,
      'distance',
      'Distance',
    );
    if (!d.ok) return d;
    if (form.size === 'distanceAngle') {
      const a = boundAngle(doc, target, values, ['sets', 0, 'size', 'distanceAngle', 'angle'], form.angle, 'angle');
      if (!a.ok) return a;
      const deg = a.stored as number;
      if (!measured(a) && !(deg > 0 && deg < 90))
        return { ok: false, message: 'Angle must be between 0 and 90°', field: 'angle' };
      // Absent, `flipped` is off: it is written when on, or when the edited feature stores one.
      const flip = ['sets', 0, 'size', 'distanceAngle', 'flipped'];
      const flipped = form.flipped || values.bound(flip) !== null ? { flipped: values.flag(flip, form.flipped) } : {};
      size = { distanceAngle: { d: d.value, angle: a.value, ...flipped } };
    } else size = { distance: { d: d.value } };
  }
  return {
    ok: true,
    inputs: { ...(target.base ?? {}), sets: [{ targets: set.set, size }, ...form.kept] },
    names: namesOf(form.targets),
  };
}

/** The sets of a stored fillet or chamfer, the first one `shown` accepts first. */
function splitSets(inputs: Json, shown: (set: Json) => boolean): { first: Json | undefined; kept: Json[] } {
  const sets = ((inputs.sets as Json[] | undefined) ?? []).filter(isPlainObject);
  const index = sets.findIndex(shown);
  if (index < 0) return { first: undefined, kept: sets };
  return { first: sets[index], kept: sets.filter((_, i) => i !== index) };
}

export function readFillet(_doc: Doc, _part: string, inputs: Json): FilletForm | null {
  const { first, kept } = splitSets(inputs, (s) => isPlainObject(s.radius) && 'constant' in s.radius);
  if (!first) return null;
  return {
    targets: picksOf(first.targets, 'Edge'),
    radius: fieldText(exprText(at(first, 'radius', 'constant', 's'))),
    kept,
  };
}

export function readChamfer(doc: Doc, _part: string, inputs: Json): ChamferForm | null {
  const { first, kept } = splitSets(inputs, (s) => isPlainObject(s.size));
  if (!first) return null;
  const form = newChamferForm();
  form.targets = picksOf(first.targets, 'Edge');
  form.kept = kept;
  const size = first.size as Json;
  if ('twoDistances' in size) {
    form.size = 'twoDistances';
    form.distance = fieldText(exprText(at(size, 'twoDistances', 'd1')));
    form.second = fieldText(exprText(at(size, 'twoDistances', 'd2')));
  } else if ('distanceAngle' in size) {
    form.size = 'distanceAngle';
    form.distance = fieldText(exprText(at(size, 'distanceAngle', 'd')));
    form.angle = fieldText(exprText(at(size, 'distanceAngle', 'angle')), 'deg');
    const flipped = at(size, 'distanceAngle', 'flipped');
    form.flipped = flipped !== undefined && fieldReader(doc).flag(flipped);
  } else form.distance = fieldText(exprText(at(size, 'distance', 'd')));
  return form;
}
