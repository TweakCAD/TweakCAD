/**
 * The revolve command's model (appendix A `core.revolve`): profiles of one
 * sketch turned about an axis, by an angle, symmetric about the sketch
 * plane, by two angles, or a full turn; joined, cut or kept as new bodies.
 *
 * The axis is one of the part's axes, or a picked straight line: a sketch
 * line, a straight edge or a construction axis.
 */
import { isPlainObject } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import { profileSketch, type ExtrudeProfile, type Operation } from './extrude';
import {
  at,
  measured,
  boundAngle,
  exprText,
  fieldReader,
  fieldText,
  namesOf,
  needsPick,
  operationInput,
  readTargets,
  referenceSet,
  type Built,
  type FeatureTarget,
  type PickedRef,
  type ValueSlots,
} from './feature';
import { profileReferences, readProfiles } from './profiles';

export type RevolveExtent = 'angle' | 'symmetric' | 'twoSides' | 'full' | 'kept';
export type StandardAxis = 'x' | 'y' | 'z';

export type AxisChoice = { standard: StandardAxis } | { picked: PickedRef } | null;

export interface RevolveForm {
  profiles: ExtrudeProfile[];
  axis: AxisChoice;
  /** The turn runs against the right hand about the axis. */
  reversed: boolean;
  extent: RevolveExtent;
  /** Expression text in degrees: the angle, the symmetric total, or the first side. */
  angle: string;
  /** The second side's angle. */
  second: string;
  operation: Operation;
  /** The bodies a join, cut or intersect acts on; none: all bodies. */
  targets: PickedRef[];
}

export const REVOLVE_OPERATIONS: readonly Operation[] = ['new', 'join', 'cut', 'intersect'];

/** A turn short of a full one: a whole turn is the Full extent. */
const partialTurn = (deg: number): boolean => deg > 0 && deg < 360;
const ANGLE_RANGE = 'Enter an angle between 0 and 360°; for a whole turn choose Full';

/** A new revolve: about the Z axis, by half a turn. */
export function newRevolveForm(hasBody: boolean): RevolveForm {
  return {
    profiles: [],
    axis: { standard: 'z' },
    reversed: false,
    extent: 'angle',
    angle: '180',
    second: '0',
    operation: hasBody ? 'join' : 'new',
    targets: [],
  };
}

/** The axis input (7.3 Axis) of an axis choice. */
function axisInput(
  values: ValueSlots,
  axis: Exclude<AxisChoice, null>,
  reversed: boolean,
): { input: Json; names: Json } {
  const reference: Json = 'standard' in axis ? { standard: { name: axis.standard } } : axis.picked.reference;
  return {
    input: { along: { ref: reference, reversed: values.flag(['axis', 'along', 'reversed'], reversed) } },
    names: 'picked' in axis ? axis.picked.names : {},
  };
}

export function buildRevolve(doc: Doc, target: FeatureTarget, form: RevolveForm, values: ValueSlots): Built {
  if (form.profiles.length === 0) return needsPick('Pick a profile', 'profiles');
  if (!form.axis) return needsPick('Pick the axis', 'axis');
  const { refs, names, regions } = profileReferences(form.profiles);
  const set = referenceSet(refs, 'profiles', 'A profile');
  if (!set.ok) return set;
  const axis = axisInput(values, form.axis, form.reversed);

  let sides: Json[];
  switch (form.extent) {
    case 'angle':
    case 'twoSides': {
      const a = boundAngle(doc, target, values, ['sides', 0, 'angle', 'a'], form.angle, 'angle');
      if (!a.ok) return a;
      sides = [{ angle: { a: a.value } }];
      if (form.extent === 'twoSides') {
        const b = boundAngle(doc, target, values, ['sides', 1, 'angle', 'a'], form.second, 'second');
        if (!b.ok) return b;
        sides.push({ angle: { a: b.value } });
        if (!measured(a, b) && !((a.stored as number) >= 0 && (b.stored as number) >= 0))
          return { ok: false, message: 'Enter angles that are not negative', field: 'second' };
        if (!measured(a, b) && !partialTurn((a.stored as number) + (b.stored as number)))
          return { ok: false, message: 'Make the two angles add up to between 0 and 360°', field: 'second' };
      } else if (!measured(a) && !partialTurn(a.stored as number))
        return { ok: false, message: ANGLE_RANGE, field: 'angle' };
      break;
    }
    case 'symmetric': {
      const a = boundAngle(doc, target, values, ['sides', 0, 'symmetric', 'a'], form.angle, 'angle');
      if (!a.ok) return a;
      if (!measured(a) && !partialTurn(a.stored as number)) return { ok: false, message: ANGLE_RANGE, field: 'angle' };
      sides = [{ symmetric: { a: a.value, measure: values.choice(['sides', 0, 'symmetric', 'measure'], 'total') } }];
      break;
    }
    case 'full':
      sides = [{ full: {} }];
      break;
    case 'kept':
      sides = structuredClone(at(target.base, 'sides') as Json[]);
      break;
  }

  const baseThin = at(target.base, 'thin');
  const inputs: Json = {
    ...(target.base ?? {}),
    profiles: set.set,
    axis: axis.input,
    sides,
    thin: isPlainObject(baseThin) ? structuredClone(baseThin) : { solid: {} },
    operation: operationInput(
      values,
      at(target.base, 'operation'),
      form.operation,
      form.operation === 'new' ? [] : form.targets,
    ),
  };
  return {
    ok: true,
    inputs,
    names: { ...names, ...axis.names, ...namesOf(form.targets) },
    regions,
    sketches: form.profiles.flatMap((p) => profileSketch(p) ?? []),
  };
}

export function readRevolve(doc: Doc, part: string, inputs: Json): RevolveForm {
  const read = fieldReader(doc);
  const form = newRevolveForm(false);
  form.profiles = readProfiles(doc, part, inputs.profiles);
  const along = at(inputs, 'axis', 'along');
  if (isPlainObject(along)) {
    const ref = along.ref as Json;
    const name = at(ref, 'standard', 'name');
    form.axis =
      name === 'x' || name === 'y' || name === 'z'
        ? { standard: name }
        : { picked: { reference: ref, names: {}, label: 'Axis' } };
    form.reversed = read.flag(along.reversed);
  } else form.axis = null;
  const sides = (at(inputs, 'sides') as Json[] | undefined) ?? [];
  const [first, second] = sides;
  form.extent = 'kept';
  if (first && 'angle' in first && sides.length === 1) {
    form.extent = 'angle';
    form.angle = fieldText(exprText(at(first, 'angle', 'a')), 'deg');
  } else if (first && 'angle' in first && second && 'angle' in second) {
    form.extent = 'twoSides';
    form.angle = fieldText(exprText(at(first, 'angle', 'a')), 'deg');
    form.second = fieldText(exprText(at(second, 'angle', 'a')), 'deg');
  } else if (first && 'symmetric' in first && read.choice(at(first, 'symmetric', 'measure')) === 'total') {
    form.extent = 'symmetric';
    form.angle = fieldText(exprText(at(first, 'symmetric', 'a')), 'deg');
  } else if (first && 'full' in first) form.extent = 'full';
  const op = read.choice(at(inputs, 'operation', 'op'));
  if ((REVOLVE_OPERATIONS as readonly string[]).includes(op)) form.operation = op as Operation;
  form.targets = readTargets(inputs.operation);
  return form;
}
