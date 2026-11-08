/**
 * The primitive command's model (appendix A `core.primitive`): a box,
 * cylinder, sphere, cone or torus from numbers, on a plane (a standard plane,
 * a construction plane or a flat face; the XY plane until one is picked) with
 * its centre at a position in the plane's frame; new, joined, cut or
 * intersected. A new box, cylinder or cone starts standing on the plane, and
 * one that stands on it keeps standing on it when its height or shape
 * changes: its centre's height above the plane follows. A new primitive's
 * base is drawn in the view (`primitiveDraw.ts`) before anything is
 * previewed, unless a field is typed in first.
 */
import { isPlainObject } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import type { Operation } from './extrude';
import {
  at,
  bindValue,
  boundLength,
  exprText,
  fieldReader,
  fieldText,
  namesOf,
  needsPick,
  operationInput,
  readTargets,
  type Built,
  type FeatureTarget,
  type PickedRef,
  type ValueSlots,
} from './feature';
import { readPlacement, placementText } from './bodyFeatures';

export type PrimitiveShape = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus';

/** Each shape's length fields, in the order the panel shows them, with their labels and defaults. */
export const SHAPE_FIELDS: Record<
  PrimitiveShape,
  readonly { field: string; label: string; initial: string; zero?: boolean }[]
> = {
  box: [
    { field: 'width', label: 'Width', initial: '20' },
    { field: 'depth', label: 'Depth', initial: '20' },
    { field: 'height', label: 'Height', initial: '20' },
  ],
  cylinder: [
    { field: 'radius', label: 'Radius', initial: '10' },
    { field: 'height', label: 'Height', initial: '20' },
  ],
  sphere: [{ field: 'radius', label: 'Radius', initial: '10' }],
  cone: [
    { field: 'bottomRadius', label: 'Bottom R', initial: '10', zero: true },
    { field: 'topRadius', label: 'Top R', initial: '0', zero: true },
    { field: 'height', label: 'Height', initial: '20' },
  ],
  torus: [
    { field: 'majorRadius', label: 'Ring R', initial: '20' },
    { field: 'minorRadius', label: 'Tube R', initial: '5' },
  ],
};

export const SHAPE_NAMES: Record<PrimitiveShape, string> = {
  box: 'Box',
  cylinder: 'Cylinder',
  sphere: 'Sphere',
  cone: 'Cone',
  torus: 'Torus',
};

export interface PrimitiveForm {
  shape: PrimitiveShape;
  /** Expression texts by field, for every shape, so switching shape keeps what was typed. */
  dims: Record<string, string>;
  /** The plane the primitive stands on; x, y and z are in its frame. */
  plane: PickedRef;
  x: string;
  y: string;
  z: string;
  operation: Operation;
  /** The bodies a join, cut or intersect acts on; none: all bodies. */
  targets: PickedRef[];
  /** A frame the panel does not offer (attached to geometry), kept as found. */
  keptFrame?: Json | undefined;
  /** The base is still to be drawn in the view: nothing is previewed or written until it is, or until a field is typed in. */
  drawing?: boolean | undefined;
}

/** The XY plane, where a primitive stands until another plane is picked. */
export const XY_PLANE: PickedRef = { reference: { standard: { name: 'xy' } }, names: {}, label: 'XY plane' };

/** Whether a shape stands on its plane, its base on it: a box, cylinder or cone; a sphere or torus is centred on it. */
export const hasHeight = (shape: PrimitiveShape): boolean =>
  shape === 'box' || shape === 'cylinder' || shape === 'cone';

/**
 * The height of the centre above its plane of a primitive that stands on
 * it: half its height (as an expression when the height is one), or 0 for
 * a shape centred on its plane.
 */
export function standingZ(shape: PrimitiveShape, dims: Record<string, string>): string {
  if (!hasHeight(shape)) return '0';
  const text = (dims.height ?? '').trim();
  const height = text === '' ? NaN : Number(text);
  if (Number.isFinite(height)) return String(height / 2 + 0);
  return text === '' ? '0' : `(${text}) / 2`;
}

/** Whether the centre stands where `standingZ` puts it, so the primitive stands on its plane. */
export function isStanding(form: Pick<PrimitiveForm, 'shape' | 'dims' | 'z'>): boolean {
  const z = form.z.trim() === '' ? '0' : form.z.trim();
  const standing = standingZ(form.shape, form.dims);
  return z === standing || (Number.isFinite(Number(z)) && Number(z) === Number(standing));
}

/** New sizes; a primitive that stood on its plane still stands on it. */
export function withDims(form: PrimitiveForm, dims: Record<string, string>): Partial<PrimitiveForm> {
  return { dims, z: isStanding(form) ? standingZ(form.shape, dims) : form.z };
}

/** Another shape, keeping what was typed; one that stood on its plane stands on it as the new shape does. */
export function withShape(form: PrimitiveForm, shape: PrimitiveShape): Partial<PrimitiveForm> {
  return { shape, z: isStanding(form) ? standingZ(shape, form.dims) : form.z };
}

/** A new primitive: on the XY plane, standing on it where it has a height, a new body. */
export function newPrimitiveForm(shape: PrimitiveShape): PrimitiveForm {
  const dims: Record<string, string> = {};
  for (const fields of Object.values(SHAPE_FIELDS)) for (const f of fields) dims[f.field] ??= f.initial;
  for (const f of SHAPE_FIELDS[shape]) dims[f.field] = f.initial;
  return { shape, dims, plane: XY_PLANE, x: '0', y: '0', z: standingZ(shape, dims), operation: 'new', targets: [] };
}

const PLACEMENT = { type: 'placement' } as const;

export function buildPrimitive(doc: Doc, target: FeatureTarget, form: PrimitiveForm, values: ValueSlots): Built {
  if (form.drawing)
    return needsPick(
      form.shape === 'box'
        ? 'Draw the base: click two corners on the plane'
        : 'Draw the base: click its centre on the plane, then its size',
      'base',
    );
  const shape: Json = {};
  const n: Record<string, number | null> = {};
  for (const f of SHAPE_FIELDS[form.shape]) {
    const b = boundLength(
      doc,
      target,
      values,
      ['shape', form.shape, f.field],
      form.dims[f.field] ?? '',
      f.field,
      f.label,
      { allowZero: f.zero === true },
    );
    if (!b.ok) return b;
    shape[f.field] = b.value;
    n[f.field] = b.stored as number | null;
  }
  if (form.shape === 'cone' && n.bottomRadius === 0 && n.topRadius === 0)
    return { ok: false, message: 'A cone needs at least one non-zero radius', field: 'bottomRadius' };
  if (
    form.shape === 'torus' &&
    typeof n.minorRadius === 'number' &&
    typeof n.majorRadius === 'number' &&
    n.minorRadius >= n.majorRadius
  ) {
    return { ok: false, message: 'Tube radius must be smaller than ring radius', field: 'minorRadius' };
  }
  let frame: Json;
  const placement = placementText({ x: form.x, y: form.y, z: form.z, axis: ['0', '0', '1'], angle: '0' });
  if (form.keptFrame) frame = form.keptFrame;
  else if (isFixedXY(form.plane)) {
    // On the XY plane the frame is the part's own, written as a fixed placement.
    const p = bindValue(doc, target, values, ['frame', 'fixed', 'placement'], placement, PLACEMENT, 'position');
    if (!p.ok) return p;
    frame = { fixed: { placement: p.value } };
  } else {
    const o = bindValue(doc, target, values, ['frame', 'attach', 'offset'], placement, PLACEMENT, 'position');
    if (!o.ok) return o;
    frame = {
      attach: {
        support: [form.plane.reference],
        mode: values.choice(['frame', 'attach', 'mode'], 'plane'),
        offset: o.value,
        flip: values.flag(['frame', 'attach', 'flip'], false),
      },
    };
  }
  return {
    ok: true,
    inputs: {
      ...(target.base ?? {}),
      shape: { [form.shape]: shape },
      frame,
      operation: operationInput(
        values,
        at(target.base, 'operation'),
        form.operation,
        form.operation === 'new' ? [] : form.targets,
      ),
    },
    names: namesOf([form.plane, ...form.targets]),
  };
}

/** Whether a plane pick is the XY standard plane, the part's own frame. */
function isFixedXY(plane: PickedRef): boolean {
  return at(plane.reference, 'standard', 'name') === 'xy';
}

/** A label for a stored plane support. */
function planeLabel(ref: Json): string {
  const name = at(ref, 'standard', 'name');
  return typeof name === 'string' ? `${name.toUpperCase()} plane` : 'Plane';
}

export function readPrimitive(doc: Doc, _part: string, inputs: Json): PrimitiveForm | null {
  const shapeInput = inputs.shape as Json | undefined;
  const shape = shapeInput ? (Object.keys(shapeInput)[0] as PrimitiveShape | undefined) : undefined;
  if (!shape || !(shape in SHAPE_FIELDS)) return null;
  const form = newPrimitiveForm(shape);
  for (const f of SHAPE_FIELDS[shape]) form.dims[f.field] = fieldText(exprText(at(shapeInput, shape, f.field)));
  const frame = inputs.frame as Json | undefined;
  const attach = frame && isPlainObject(frame.attach) ? frame.attach : null;
  const support =
    attach && Array.isArray(attach.support) && attach.support.length === 1 ? (attach.support[0] as Json) : null;
  const onPlane =
    attach &&
    support &&
    fieldReader(doc).choice(attach.mode) === 'plane' &&
    !fieldReader(doc).flag(attach.flip) &&
    attach.xAxis === undefined;
  const fields =
    frame && isPlainObject(frame.fixed)
      ? readPlacement(exprText(frame.fixed.placement))
      : onPlane
        ? readPlacement(exprText(attach.offset))
        : null;
  if (fields && fields.angle === '0') {
    Object.assign(form, { x: fields.x, y: fields.y, z: fields.z });
    if (onPlane && support) form.plane = { reference: support, names: {}, label: planeLabel(support) };
  } else form.keptFrame = frame;
  const op = fieldReader(doc).choice(at(inputs, 'operation', 'op'));
  if (op === 'new' || op === 'join' || op === 'cut' || op === 'intersect') form.operation = op;
  form.targets = readTargets(inputs.operation);
  return form;
}
