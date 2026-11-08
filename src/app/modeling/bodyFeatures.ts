/**
 * The models of the commands that act on bodies or copy them (appendix A):
 * shell, pattern (linear in one or two directions, circular; of bodies or
 * of features), mirror, move, boolean and remove body.
 *
 * Bodies, faces and planes are picked references; a direction or an axis is
 * one of the part's axes or a picked edge, sketch line or construction axis.
 */
import { isPlainObject, makeSet } from '@tweakcad/format';
import { withDefaultUnit, type Doc, type Json } from '@tweakcad/editor';
import {
  at,
  measured,
  bindValue,
  boundAngle,
  boundCount,
  boundLength,
  fieldReader,
  exprText,
  fieldText,
  namesOf,
  needsPick,
  operationInput,
  referenceSet,
  sameReference,
  type Built,
  type FeatureTarget,
  type FieldReader,
  type PickedRef,
  type ValueSlots,
} from './feature';
import { BLEND_SIZE } from './blends';
import { vectorParts } from './hole';
import type { AxisChoice, StandardAxis } from './revolve';

// ---- shared shapes ----

/** A set input of picked references, or why not. */
function setOf(
  picks: readonly PickedRef[],
  field: string,
  empty: string,
): { ok: true; set: Json } | Extract<Built, { ok: false }> {
  if (picks.length === 0) return needsPick(empty, field) as Extract<Built, { ok: false }>;
  return referenceSet(
    picks.map((p) => p.reference),
    field,
  );
}

/** Picks read back from a stored set, labelled `label` until they are named as the state before the feature names them. */
function picksIn(set: unknown, label: string): PickedRef[] {
  const members = (at(set, 'set') as Json[] | undefined) ?? [];
  return members.map((reference) => ({ reference, names: {}, label: featureLabel(reference) ?? label }));
}

function featureLabel(reference: Json): string | null {
  const id = at(reference, 'object', 'feature', 'id');
  return typeof id === 'string' ? 'Feature' : null;
}

/** A direction input (7.3) along an axis choice: a part axis, or a picked line. */
export function directionInput(
  values: ValueSlots,
  path: (string | number)[],
  axis: Exclude<AxisChoice, null>,
  reversed: boolean,
): Json {
  if ('standard' in axis)
    return {
      axis: {
        axis: values.choice([...path, 'axis', 'axis'], axis.standard),
        reversed: values.flag([...path, 'axis', 'reversed'], reversed),
      },
    };
  return { along: { ref: axis.picked.reference, reversed: values.flag([...path, 'along', 'reversed'], reversed) } };
}

export function readDirection(direction: unknown, read: FieldReader): { axis: AxisChoice; reversed: boolean } {
  if (isPlainObject(direction) && isPlainObject(direction.axis)) {
    const name = read.choice(direction.axis.axis);
    return {
      axis: name === 'x' || name === 'y' || name === 'z' ? { standard: name } : null,
      reversed: read.flag(direction.axis.reversed),
    };
  }
  if (isPlainObject(direction) && isPlainObject(direction.along)) {
    return {
      axis: { picked: { reference: direction.along.ref as Json, names: {}, label: 'Direction' } },
      reversed: read.flag(direction.along.reversed),
    };
  }
  return { axis: null, reversed: false };
}

/** An axis input (7.3 Axis) along a part axis or a picked line. */
export function axisInput(
  values: ValueSlots,
  path: (string | number)[],
  axis: Exclude<AxisChoice, null>,
  reversed: boolean,
): Json {
  const ref: Json = 'standard' in axis ? { standard: { name: axis.standard } } : axis.picked.reference;
  return { along: { ref, reversed: values.flag([...path, 'along', 'reversed'], reversed) } };
}

export function readAxis(axis: unknown, read: FieldReader): { axis: AxisChoice; reversed: boolean } {
  const along = at(axis, 'along');
  if (!isPlainObject(along)) return { axis: null, reversed: false };
  const name = at(along.ref, 'standard', 'name');
  return {
    axis:
      name === 'x' || name === 'y' || name === 'z'
        ? { standard: name as StandardAxis }
        : { picked: { reference: along.ref as Json, names: {}, label: 'Axis' } },
    reversed: read.flag(along.reversed),
  };
}

const axisNames = (axis: AxisChoice): Json => (axis && 'picked' in axis ? axis.picked.names : {});

// ---- shell ----

export type ShellDirection = 'inside' | 'outside' | 'both';

/** The body a face to remove lies on: both references, the face's as the form holds it. */
export interface ShellOwner {
  face: Json;
  body: Json;
}

/**
 * Faces to remove, and the bodies shelled: each face's body, and bodies
 * picked as bodies, which are shelled closed around a sealed void.
 */
export interface ShellForm {
  faces: PickedRef[];
  bodies: PickedRef[];
  /**
   * The body each face lies on, as the pick or the state before the feature
   * gives it; a face not listed yet has no known body.
   */
  owners: ShellOwner[];
  /** The wall thickness; with `both`, the inside wall. */
  thickness: string;
  /** The outside wall of a shell on both sides. */
  outside: string;
  direction: ShellDirection;
}

export const newShellForm = (): ShellForm => ({
  faces: [],
  bodies: [],
  owners: [],
  thickness: BLEND_SIZE,
  outside: BLEND_SIZE,
  direction: 'inside',
});

type ShellPicks = Pick<ShellForm, 'faces' | 'bodies' | 'owners'>;

/** The body `face` lies on, among the form's bodies; undefined while its body is not known. */
export function shellBodyOf(form: Pick<ShellForm, 'bodies' | 'owners'>, face: PickedRef): PickedRef | undefined {
  const owner = form.owners.find((o) => sameReference(o.face, face.reference));
  return owner && form.bodies.find((b) => sameReference(b.reference, owner.body));
}

/**
 * The picks with the faces changed to `faces`: the faces added lie on
 * `body` when it is given, and bring it; a body whose last face went goes
 * with it, as it came with that face.
 */
export function withShellFaces(form: ShellPicks, faces: PickedRef[], body?: PickedRef): ShellPicks {
  const added = faces.filter((f) => !form.faces.some((x) => sameReference(x.reference, f.reference)));
  const owners = [
    ...form.owners.filter((o) => faces.some((f) => sameReference(f.reference, o.face))),
    ...(body ? added.map((f) => ({ face: f.reference, body: body.reference })) : []),
  ];
  const owns = (b: PickedRef, picks: ShellPicks) => picks.faces.some((f) => shellBodyOf(picks, f) === b);
  let bodies = form.bodies.filter((b) => !owns(b, form) || owns(b, { ...form, faces, owners }));
  if (added.length > 0 && body && !bodies.some((b) => sameReference(b.reference, body.reference)))
    bodies = [...bodies, body];
  return { faces, bodies, owners };
}

/** A body picked as a body: added, or dropped with its faces when it is there already. */
export function toggledShellBody(form: ShellPicks, body: PickedRef): ShellPicks {
  const present = form.bodies.find((b) => sameReference(b.reference, body.reference));
  if (!present) return { faces: form.faces, bodies: [...form.bodies, body], owners: form.owners };
  const faces = form.faces.filter((f) => shellBodyOf(form, f) !== present);
  return {
    faces,
    bodies: form.bodies.filter((b) => b !== present),
    owners: form.owners.filter((o) => faces.some((f) => sameReference(f.reference, o.face))),
  };
}

export function buildShell(doc: Doc, target: FeatureTarget, form: ShellForm, values: ValueSlots): Built {
  const bodies = setOf(form.bodies, form.faces.length > 0 ? 'bodies' : 'faces', 'Pick faces to remove, or a body');
  if (!bodies.ok) return bodies;
  const remove = referenceSet(
    form.faces.map((f) => f.reference),
    'faces',
    'A face',
  );
  if (!remove.ok) return remove;
  const both = form.direction === 'both';
  const t = boundLength(
    doc,
    target,
    values,
    ['thickness'],
    form.thickness,
    'thickness',
    both ? 'Inside thickness' : 'Thickness',
  );
  if (!t.ok) return t;
  const inputs: Json = {
    ...(target.base ?? {}),
    bodies: bodies.set,
    remove: remove.set,
    thickness: t.value,
    direction: values.choice(['direction'], form.direction),
  };
  // Absent, there is no outside thickness: only a shell on both sides has one.
  delete inputs.outsideThickness;
  if (both) {
    const o = boundLength(doc, target, values, ['outsideThickness'], form.outside, 'outside', 'Outside thickness');
    if (!o.ok) return o;
    inputs.outsideThickness = o.value;
  }
  return { ok: true, inputs, names: namesOf([...form.faces, ...form.bodies]) };
}

export function readShell(doc: Doc, _part: string, inputs: Json): ShellForm {
  const direction = fieldReader(doc).choice(inputs.direction);
  return {
    faces: picksIn(inputs.remove, 'Face'),
    bodies: picksIn(inputs.bodies, 'Body'),
    thickness: fieldText(exprText(inputs.thickness)),
    owners: [],
    outside: inputs.outsideThickness === undefined ? BLEND_SIZE : fieldText(exprText(inputs.outsideThickness)),
    direction: direction === 'outside' || direction === 'both' ? direction : 'inside',
  };
}

// ---- pattern ----

export type CopiedKind = 'bodies' | 'features';

export interface PatternDirection {
  axis: AxisChoice;
  reversed: boolean;
  count: string;
  spacing: string;
  /** Symmetric: the copies spread both ways from the source, `count` counting them all with it; else One Direction. */
  symmetric: boolean;
}

/**
 * How a circular pattern spreads its copies: Full round the axis, Partial to
 * an angle, Symmetric both ways over an angle.
 */
export type CircularDistribution = 'full' | 'partial' | 'symmetric';

export interface CircularLayoutForm {
  axis: AxisChoice;
  reversed: boolean;
  count: string;
  /** The sweep from the source to the last copy, or Symmetric's whole spread; Full writes a full turn instead. */
  angle: string;
  distribution: CircularDistribution;
}

export interface PatternForm {
  of: CopiedKind;
  items: PickedRef[];
  layout: 'linear' | 'circular' | 'kept';
  directions: PatternDirection[];
  circular: CircularLayoutForm;
  operation: 'new' | 'join';
  /** Whether a linear direction's length field is the distance between copies, or from the first copy to the last. */
  distance: 'spacing' | 'extent';
  /** The copies left out, as `suppressText` writes them. */
  suppress: string;
}

/**
 * A spacing written from an extent, the distance from the source to the
 * farthest copy: shared out over the gaps between `count` copies, or, for a
 * symmetric direction, over those on the side with more of them.
 */
export function extentSpacing(extent: string, count: string, symmetric = false): string {
  const e = withDefaultUnit(extent.trim() === '' ? '0' : extent, 'mm');
  return symmetric ? `(${e}) / ceil((${count.trim()} - 1) / 2)` : `(${e}) / (${count.trim()} - 1)`;
}

/** The extent a spacing written by `extentSpacing` for `count` copies holds, or null for any other spacing. */
export function extentOf(spacing: string, count: string, symmetric = false): string | null {
  const m = (symmetric ? /^\((.*)\) \/ ceil\(\((.*) - 1\) \/ 2\)$/s : /^\((.*)\) \/ \((.*) - 1\)$/s).exec(
    spacing.trim(),
  );
  return m && (m[2] as string).trim() === count.trim() ? fieldText(m[1] as string) : null;
}

type Slot = { i: number; j: number };

/** A copy's number along a direction: the source is 1, the copies after it 2, 3 …, those on a symmetric direction's other side −2, −3 …. */
const numberOf = (index: number): number => (index < 0 ? index - 1 : index + 1);
const indexOf = (n: number): number => (n < 0 ? n + 1 : n - 1);

/**
 * The copies a pattern leaves out, as the panel writes them: each copy by
 * its number along the first direction (`numberOf`), and with a second
 * direction its number along that too (`2:3`).
 */
export function suppressText(slots: readonly Slot[], twoD: boolean): string {
  return [...slots]
    .sort((a, b) => a.i - b.i || a.j - b.j)
    .map((s) => (twoD ? `${numberOf(s.i)}:${numberOf(s.j)}` : String(numberOf(s.i))))
    .join(', ');
}

/** The Suppress field's example: row:column with two directions, a negative number where copies lie on both sides. */
export function suppressHint(form: Pick<PatternForm, 'layout' | 'directions' | 'circular'>): string {
  if (form.layout === 'linear' && form.directions.length > 1)
    return form.directions.some((d) => d.symmetric) ? 'e.g. 2:3, -2:1' : 'e.g. 2:3';
  const twoSided =
    form.layout === 'linear' ? form.directions[0]?.symmetric === true : form.circular.distribution === 'symmetric';
  return twoSided ? 'e.g. 2, -2' : 'e.g. 2, 4';
}

/** The slots `suppressText` text names, or why it names none. */
export function parseSuppress(
  text: string,
  twoD: boolean,
): { ok: true; slots: Slot[] } | { ok: false; message: string } {
  const slots: Slot[] = [];
  for (const part of text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')) {
    const m = twoD ? /^(-?\d+)\s*:\s*(-?\d+)$/.exec(part) : /^(-?\d+)$/.exec(part);
    if (!m)
      return {
        ok: false,
        message: twoD
          ? 'Suppress copies as row:column numbers, e.g. 2:3'
          : 'Suppress copies by their numbers, e.g. 2, 4',
      };
    const [n, k] = [Number(m[1]), twoD ? Number(m[2]) : 1];
    if (n === 0 || k === 0) return { ok: false, message: 'Copies are numbered from 1' };
    const slot = { i: indexOf(n), j: indexOf(k) };
    if (slot.i === 0 && slot.j === 0) return { ok: false, message: 'Copy 1 is the source and stays' };
    if (!slots.some((s) => s.i === slot.i && s.j === slot.j)) slots.push(slot);
  }
  return { ok: true, slots };
}

/** The spacing a new pattern direction starts with, in mm, for bodies, features and components alike. */
export const PATTERN_SPACING = '10';

export const newDirection = (axis: StandardAxis = 'x'): PatternDirection => ({
  axis: { standard: axis },
  reversed: false,
  count: '3',
  spacing: PATTERN_SPACING,
  symmetric: false,
});

/** A Direction Type row's choices. */
export const DIRECTION_TYPES: { id: 'one' | 'symmetric'; label: string; title: string }[] = [
  { id: 'one', label: 'One Direction', title: 'The copies run one way from the source' },
  {
    id: 'symmetric',
    label: 'Symmetric',
    title: 'The copies run both ways from the source, the count taking in them all',
  },
];

/** A circular pattern's Distribution choices. */
export const CIRCULAR_DISTRIBUTIONS: { id: CircularDistribution; label: string; title: string }[] = [
  { id: 'full', label: 'Full', title: 'The copies spread evenly round the axis' },
  { id: 'partial', label: 'Partial', title: 'The copies spread one way to the angle' },
  {
    id: 'symmetric',
    label: 'Symmetric',
    title: 'The copies spread both ways from the source, the angle between the outermost',
  },
];

/** The largest spread of a symmetric circular pattern, exclusive. */
export const SYMMETRIC_TURN_LIMIT = 360;

/**
 * A circular layout's form after picking a distribution. A symmetric one
 * spreads less than a full turn, so an angle that is not starts at 90°.
 */
export function withDistribution(c: CircularLayoutForm, distribution: CircularDistribution): CircularLayoutForm {
  const deg = Number(c.angle.replace(/deg|°/g, '').trim());
  const angle =
    distribution === 'symmetric' && Number.isFinite(deg) && Math.abs(deg) >= SYMMETRIC_TURN_LIMIT ? '90' : c.angle;
  return { ...c, distribution, angle };
}

/**
 * The `angle` and `symmetric` of a circular layout at `path`, as its
 * distribution writes them: Full a full turn, Partial an angle up to a full
 * turn, Symmetric a spread under a full turn.
 */
export function circularSweep(
  doc: Doc,
  target: FeatureTarget,
  values: ValueSlots,
  path: (string | number)[],
  c: CircularLayoutForm,
): { ok: true; angle: Json; symmetric: Json } | { ok: false; message: string; field: string } {
  const angle = boundAngle(
    doc,
    target,
    values,
    [...path, 'angle'],
    c.distribution === 'full' ? '360' : c.angle,
    'angle',
  );
  if (!angle.ok) return angle;
  const deg = angle.stored as number;
  if (!measured(angle)) {
    if (c.distribution === 'symmetric' && !(deg > 0 && deg < SYMMETRIC_TURN_LIMIT))
      return { ok: false, message: 'Enter an angle between 0 and 360°, less than a full turn', field: 'angle' };
    if (!(deg > 0 && deg <= 360)) return { ok: false, message: 'Enter an angle between 0 and 360°', field: 'angle' };
  }
  return {
    ok: true,
    angle: angle.value,
    symmetric: values.flag([...path, 'symmetric'], c.distribution === 'symmetric'),
  };
}

/** The `symmetric` flag of a linear direction: written when on, or when the edited feature has one. */
export function symmetricInput(
  values: ValueSlots,
  base: Json | undefined,
  path: (string | number)[],
  on: boolean,
): Json {
  return on || at(base, ...path) !== undefined ? { symmetric: values.flag(path, on) } : {};
}

/** The form of a stored circular layout. */
export function readCircular(c: Json, read: FieldReader): CircularLayoutForm {
  const angle = fieldText(exprText(c.angle), 'deg');
  const distribution: CircularDistribution = read.flag(c.symmetric)
    ? 'symmetric'
    : angle.trim() === '360'
      ? 'full'
      : 'partial';
  return { ...readAxis(c.axis, read), count: exprText(c.count), angle, distribution };
}

/** The Operation choices of a pattern or mirror of bodies, in one wording and order. */
export const COPY_OPS: { id: 'join' | 'new'; label: string; title: string }[] = [
  { id: 'join', label: 'Join', title: 'The copies are fused with the bodies they touch' },
  { id: 'new', label: 'New Body', title: 'Each copy is a body of its own' },
];

export const newPatternForm = (): PatternForm => ({
  of: 'bodies',
  items: [],
  layout: 'linear',
  directions: [newDirection('x')],
  circular: { axis: { standard: 'z' }, reversed: false, count: '6', angle: '360', distribution: 'full' },
  operation: 'new',
  distance: 'spacing',
  suppress: '',
});

export function buildPattern(doc: Doc, target: FeatureTarget, form: PatternForm, values: ValueSlots): Built {
  const of = setOf(form.items, 'items', form.of === 'bodies' ? 'Pick the bodies to copy' : 'Pick the features to copy');
  if (!of.ok) return of;
  let layout: Json;
  const names: Json = namesOf(form.items);
  if (form.layout === 'kept') layout = structuredClone(at(target.base, 'layout') as Json);
  else if (form.layout === 'linear') {
    const directions: Json[] = [];
    for (const [i, d] of form.directions.entries()) {
      if (!d.axis) return needsPick('Pick a direction', `direction${i}`);
      const path = ['layout', 'linear', 'directions', i];
      const count = boundCount(doc, target, values, [...path, 'count'], d.count, `count${i}`, 'Count', 1);
      if (!count.ok) return count;
      if (form.distance === 'extent' && !measured(count) && (count.stored as number) < 2)
        return { ok: false, message: 'An extent needs at least two copies', field: `count${i}` };
      const spacing = form.distance === 'extent' ? extentSpacing(d.spacing, d.count, d.symmetric) : d.spacing;
      const s = boundLength(
        doc,
        target,
        values,
        [...path, 'spacing', 'equal', 's'],
        spacing,
        `spacing${i}`,
        form.distance === 'extent' ? 'Extent' : 'Spacing',
        { allowNegative: true },
      );
      if (!s.ok) return s;
      directions.push({
        direction: directionInput(values, [...path, 'direction'], d.axis, d.reversed),
        count: count.value,
        spacing: { equal: { s: s.value } },
        ...symmetricInput(values, target.base, [...path, 'symmetric'], d.symmetric),
      });
      Object.assign(names, axisNames(d.axis));
    }
    layout = { linear: { directions } };
  } else {
    const c = form.circular;
    if (!c.axis) return needsPick('Pick the axis', 'axis');
    const path = ['layout', 'circular'];
    const count = boundCount(doc, target, values, [...path, 'count'], c.count, 'count', 'Count', 1);
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
  const inputs: Json = {
    ...(target.base ?? {}),
    of: { [form.of]: of.set },
    layout,
    skip: { set: [] },
    vary: Array.isArray(at(target.base, 'vary')) ? (at(target.base, 'vary') as Json[]) : [],
    operation: operationInput(values, at(target.base, 'operation'), form.operation),
  };
  if (form.layout !== 'kept') {
    const suppressed = parseSuppress(form.suppress, form.layout === 'linear' && form.directions.length > 1);
    if (!suppressed.ok) return { ok: false, message: suppressed.message, field: 'suppress' };
    inputs.skip = makeSet(suppressed.slots.map((slot) => ({ slot }))) as unknown as Json;
  } else if (isPlainObject(at(target.base, 'skip'))) inputs.skip = at(target.base, 'skip') as Json;
  return { ok: true, inputs, names };
}

export function readPattern(doc: Doc, _part: string, inputs: Json): PatternForm {
  const read = fieldReader(doc);
  const form = newPatternForm();
  const of = inputs.of as Json | undefined;
  if (of && 'features' in of) {
    form.of = 'features';
    form.items = picksIn(of.features, 'Feature');
  } else if (of && 'bodies' in of) form.items = picksIn(of.bodies, 'Body');
  const layout = inputs.layout as Json | undefined;
  if (layout && 'linear' in layout) {
    form.directions = ((at(layout, 'linear', 'directions') as Json[] | undefined) ?? []).map((d) => ({
      ...readDirection(d.direction, read),
      count: exprText(d.count),
      spacing: fieldText(exprText(at(d, 'spacing', 'equal', 's'))),
      symmetric: d.symmetric !== undefined && read.flag(d.symmetric),
    }));
    if (
      form.directions.length === 0 ||
      ((at(layout, 'linear', 'directions') as Json[]) ?? []).some((d) => !isPlainObject(at(d, 'spacing', 'equal')))
    )
      form.layout = 'kept';
    const extents = form.directions.map((d) => extentOf(d.spacing, d.count, d.symmetric));
    if (form.directions.length > 0 && extents.every((e) => e !== null)) {
      form.distance = 'extent';
      form.directions = form.directions.map((d, i) => ({ ...d, spacing: extents[i] as string }));
    }
  } else if (layout && 'circular' in layout) {
    form.layout = 'circular';
    form.circular = readCircular(layout.circular as Json, read);
  } else form.layout = 'kept';
  form.operation = read.choice(at(inputs, 'operation', 'op')) === 'join' ? 'join' : 'new';
  const skipped = ((at(inputs, 'skip', 'set') as Json[] | undefined) ?? []).flatMap((m) =>
    isPlainObject(m.slot) ? [m.slot as unknown as Slot] : [],
  );
  form.suppress = suppressText(skipped, form.layout === 'linear' && form.directions.length > 1);
  return form;
}

// ---- mirror ----

export interface MirrorForm {
  of: CopiedKind;
  items: PickedRef[];
  plane: PickedRef | null;
  operation: 'new' | 'join';
}

/** A new mirror: of bodies, in the XY plane, joined back to them. */
export const newMirrorForm = (): MirrorForm => ({
  of: 'bodies',
  items: [],
  plane: { reference: { standard: { name: 'xy' } }, names: {}, label: 'XY plane' },
  operation: 'join',
});

export function buildMirror(_doc: Doc, target: FeatureTarget, form: MirrorForm, values: ValueSlots): Built {
  const of = setOf(
    form.items,
    'items',
    form.of === 'bodies' ? 'Pick the bodies to mirror' : 'Pick the features to mirror',
  );
  if (!of.ok) return of;
  if (!form.plane) return needsPick('Pick the mirror plane', 'plane');
  return {
    ok: true,
    inputs: {
      ...(target.base ?? {}),
      of: { [form.of]: of.set },
      plane: form.plane.reference,
      operation: operationInput(values, at(target.base, 'operation'), form.operation),
    },
    names: namesOf([...form.items, form.plane]),
  };
}

export function readMirror(doc: Doc, _part: string, inputs: Json): MirrorForm {
  const of = inputs.of as Json | undefined;
  const features = of !== undefined && 'features' in of;
  const plane = inputs.plane as Json | undefined;
  const name = at(plane, 'standard', 'name');
  return {
    of: features ? 'features' : 'bodies',
    items: picksIn(features ? of.features : of?.bodies, features ? 'Feature' : 'Body'),
    plane: plane
      ? { reference: plane, names: {}, label: typeof name === 'string' ? `${name.toUpperCase()} plane` : 'Plane' }
      : null,
    operation: fieldReader(doc).choice(at(inputs, 'operation', 'op')) === 'join' ? 'join' : 'new',
  };
}

// ---- move ----

export interface MoveForm {
  /** What moves: bodies, or (kept from a stored move) faces. */
  of: 'bodies' | 'faces';
  bodies: PickedRef[];
  /** Expression texts: the translation, and a turn of `angle` about the direction `axis`, about the part origin before it. */
  x: string;
  y: string;
  z: string;
  axis: [string, string, string];
  angle: string;
  copy: boolean;
  /** A transform the panel cannot show as fields (an alignment, or other text), kept unless the fields change. */
  kept?: Json | undefined;
}

export const newMoveForm = (): MoveForm => ({
  of: 'bodies',
  bodies: [],
  x: '0',
  y: '0',
  z: '0',
  axis: ['0', '0', '1'],
  angle: '0',
  copy: false,
});

/** The placement text of the form's fields. */
export function placementText(form: Pick<MoveForm, 'x' | 'y' | 'z' | 'axis' | 'angle'>): string {
  const mm = (t: string) => withDefaultUnit(t.trim() === '' ? '0' : t, 'mm');
  const plain = (t: string) => (t.trim() === '' ? '0' : t);
  return `placement(vector(${mm(form.x)}, ${mm(form.y)}, ${mm(form.z)}), rotate(vector(${form.axis.map(plain).join(', ')}), ${withDefaultUnit(form.angle.trim() === '' ? '0' : form.angle, 'deg')}))`;
}

/** The arguments of a call `name(…)`, split at its top-level commas; null for other text. */
function callArgs(text: string, name: string): string[] | null {
  const m = new RegExp(`^\\s*${name}\\((.*)\\)\\s*$`, 's').exec(text);
  return m ? (vectorParts(`vector(${m[1] as string})`) ?? null) : null;
}

/** The fields of a placement text as the move form writes it, or null. */
export function readPlacement(text: string): Pick<MoveForm, 'x' | 'y' | 'z' | 'axis' | 'angle'> | null {
  const args = callArgs(text, 'placement');
  if (!args || args.length !== 2) return null;
  const v = vectorParts(args[0] as string);
  const r = callArgs(args[1] as string, 'rotate');
  const axis = r && r.length === 2 ? vectorParts(r[0] as string) : null;
  if (!v || v.length !== 3 || !r || !axis || axis.length !== 3) return null;
  return {
    x: fieldText(v[0] as string),
    y: fieldText(v[1] as string),
    z: fieldText(v[2] as string),
    axis: axis as [string, string, string],
    angle: fieldText(r[1] as string, 'deg'),
  };
}

const PLACEMENT = { type: 'placement' } as const;

export function buildMove(doc: Doc, target: FeatureTarget, form: MoveForm, values: ValueSlots): Built {
  const of = setOf(form.bodies, 'bodies', 'Pick the bodies to move');
  if (!of.ok) return of;
  let transform: Json;
  if (form.kept) transform = form.kept;
  else {
    const t = bindValue(doc, target, values, ['transform'], placementText(form), PLACEMENT, 'transform');
    if (!t.ok) return t;
    transform = t.value;
  }
  return {
    ok: true,
    inputs: { ...(target.base ?? {}), of: { [form.of]: of.set }, transform, copy: values.flag(['copy'], form.copy) },
    names: namesOf(form.bodies),
  };
}

export function readMove(doc: Doc, _part: string, inputs: Json): MoveForm {
  const form = newMoveForm();
  const faces = at(inputs, 'of', 'faces');
  form.of = faces !== undefined ? 'faces' : 'bodies';
  form.bodies = faces !== undefined ? picksIn(faces, 'Face') : picksIn(at(inputs, 'of', 'bodies'), 'Body');
  form.copy = fieldReader(doc).flag(inputs.copy);
  const transform = inputs.transform as Json | undefined;
  const fields = transform && !('align' in transform) ? readPlacement(exprText(transform)) : null;
  if (fields) Object.assign(form, fields);
  else form.kept = transform;
  return form;
}

// ---- boolean ----

export type BooleanOp = 'join' | 'cut' | 'intersect';

export interface BooleanForm {
  target: PickedRef | null;
  tools: PickedRef[];
  op: BooleanOp;
  /** Keep Tools: the tool bodies stay as bodies of their own, rather than being used up. */
  keepTools: boolean;
}

export const newBooleanForm = (op: BooleanOp = 'join'): BooleanForm => ({
  target: null,
  tools: [],
  op,
  keepTools: false,
});

/** The Combine panel's Operation choices. */
export const BOOLEAN_OPS: { id: BooleanOp; label: string; title: string }[] = [
  { id: 'join', label: 'Join', title: 'The tools are fused into the target' },
  { id: 'cut', label: 'Cut', title: 'The tools are removed from the target' },
  { id: 'intersect', label: 'Intersect', title: 'Only the volume the target and the tools share is kept' },
];

/**
 * A body clicked in the Combine panel: with the target slot armed it
 * becomes the target (and leaves the tools); otherwise it is added to the
 * tools, or dropped from them when it is there already. The target is not
 * a tool; a string says why the click changed nothing.
 */
export function clickBooleanBody(
  form: Pick<BooleanForm, 'target' | 'tools'>,
  body: PickedRef,
  armed: 'target' | 'tools',
): Pick<BooleanForm, 'target' | 'tools'> | string {
  if (armed === 'target')
    return { target: body, tools: form.tools.filter((t) => !sameReference(t.reference, body.reference)) };
  if (form.target && sameReference(form.target.reference, body.reference)) return 'That body is the target';
  const present = form.tools.find((t) => sameReference(t.reference, body.reference));
  return { target: form.target, tools: present ? form.tools.filter((t) => t !== present) : [...form.tools, body] };
}

export function buildBoolean(_doc: Doc, target: FeatureTarget, form: BooleanForm, values: ValueSlots): Built {
  if (!form.target) return needsPick('Pick the target body', 'target');
  const tools = setOf(form.tools, 'tools', 'Pick the tool bodies');
  if (!tools.ok) return tools;
  return {
    ok: true,
    inputs: {
      ...(target.base ?? {}),
      target: form.target.reference,
      tools: tools.set,
      op: values.choice(['op'], form.op),
      keepTools: values.flag(['keepTools'], form.keepTools),
    },
    names: namesOf([form.target, ...form.tools]),
  };
}

export function readBoolean(doc: Doc, _part: string, inputs: Json): BooleanForm {
  const read = fieldReader(doc);
  const op = read.choice(inputs.op);
  return {
    target: isPlainObject(inputs.target) ? { reference: inputs.target, names: {}, label: 'Target body' } : null,
    tools: picksIn(inputs.tools, 'Tool body'),
    op: op === 'cut' || op === 'intersect' ? op : 'join',
    keepTools: read.flag(inputs.keepTools),
  };
}

// ---- remove body ----

export interface RemoveBodyForm {
  bodies: PickedRef[];
}

export const newRemoveBodyForm = (): RemoveBodyForm => ({ bodies: [] });

export function buildRemoveBody(_doc: Doc, target: FeatureTarget, form: RemoveBodyForm): Built {
  const bodies = setOf(form.bodies, 'bodies', 'Pick the bodies to remove');
  if (!bodies.ok) return bodies;
  return { ok: true, inputs: { ...(target.base ?? {}), bodies: bodies.set }, names: namesOf(form.bodies) };
}

export function readRemoveBody(_doc: Doc, _part: string, inputs: Json): RemoveBodyForm {
  return { bodies: picksIn(inputs.bodies, 'Body') };
}
