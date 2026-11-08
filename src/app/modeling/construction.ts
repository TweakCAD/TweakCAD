/**
 * The construction features' model (appendix A, chapter 15): a plane,
 * axis, point or frame from an attached frame (7.3), in one of the
 * attachment modes the evaluator builds, or at fixed coordinates.
 *
 * - Offset (`plane` mode): one plane or flat face, moved along its normal
 *   and turned about its x axis; an axis this way is the plane's normal
 *   through its origin.
 * - At a point (`planeAtPoint`): a plane, then a point projected onto it.
 * - Three points (`threePoints`): origin at the first, x towards the
 *   second, the third on the plane.
 * - Two points (`twoPoints`): origin at the first, z towards the second;
 *   an axis through both.
 * - A point (`point`): origin there, the part's axes.
 * - Along a line (`alongLine`): a straight edge, sketch line or axis; an
 *   axis along it, a plane normal to it at its start.
 * - Midplane (`midplane`): two planes or flat faces; halfway between them,
 *   or bisecting the angle where they meet.
 * - Through a cylinder (`faceAxis`): the axis of a cylindrical, conical or
 *   toroidal face.
 * - At a centre (`center`): a circular edge's centre, or a sphere's or torus's.
 * - Coordinates (`fixed`): a position in the part.
 *
 * An attached frame's offset is a placement in the frame it attaches to: a
 * shift along its x and y, the offset along its normal, and one turn about
 * its x axis, its y axis or its normal. The panel shows all of it.
 */
import { isPlainObject } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import { placementText, readPlacement } from './bodyFeatures';
import {
  at,
  bindValue,
  exprText,
  fieldReader,
  namesOf,
  needsPick,
  type Built,
  type FeatureTarget,
  type PickedRef,
  type ValueSlots,
} from './feature';

export type ConstructionKind = 'plane' | 'axis' | 'point' | 'frame';
export type ConstructionMode =
  | 'plane'
  | 'planeAtPoint'
  | 'threePoints'
  | 'twoPoints'
  | 'point'
  | 'alongLine'
  | 'midplane'
  | 'faceAxis'
  | 'center'
  | 'fixed';
/** What a support slot takes: a plane or flat face, a point, a straight line, a round face (cylinder, cone, torus), or something with a centre (a circular edge, a sphere, a torus). */
export type SupportSlot = 'plane' | 'point' | 'line' | 'round' | 'center';
/** The axis of the frame the offset's turn runs about: x, y or the normal. */
export type TurnAxis = 'x' | 'y' | 'z';

export const CONSTRUCTION_TYPES: Record<ConstructionKind, string> = {
  plane: 'core.constructionPlane',
  axis: 'core.constructionAxis',
  point: 'core.constructionPoint',
  frame: 'core.constructionFrame',
};

export const CONSTRUCTION_NAMES: Record<ConstructionKind, string> = {
  plane: 'Plane',
  axis: 'Axis',
  point: 'Point',
  frame: 'Frame',
};

/** The modes each kind offers, the first its default. */
export const MODES: Record<ConstructionKind, readonly ConstructionMode[]> = {
  plane: ['plane', 'midplane', 'threePoints', 'alongLine'],
  axis: ['alongLine', 'faceAxis', 'twoPoints', 'planeAtPoint', 'plane'],
  point: ['fixed', 'point', 'center', 'planeAtPoint'],
  frame: ['threePoints', 'plane', 'point', 'fixed'],
};

/** What each support slot of a mode takes. */
export const SUPPORTS: Record<ConstructionMode, readonly SupportSlot[]> = {
  plane: ['plane'],
  planeAtPoint: ['plane', 'point'],
  threePoints: ['point', 'point', 'point'],
  twoPoints: ['point', 'point'],
  point: ['point'],
  alongLine: ['line'],
  midplane: ['plane', 'plane'],
  faceAxis: ['round'],
  center: ['center'],
  fixed: [],
};

/** What a slot asks for when it is empty. */
export const SLOT_HINTS: Record<SupportSlot, string> = {
  plane: 'Pick a plane or a flat face',
  point: 'Pick a point',
  line: 'Pick a straight edge, line or axis',
  round: 'Pick a cylindrical, conical or toroidal face',
  center: 'Pick a circular edge, a sphere or a torus',
};

export interface ConstructionForm {
  kind: ConstructionKind;
  mode: ConstructionMode;
  supports: (PickedRef | null)[];
  /** The offset's fields: along the normal, the shift along the frame's x and y, and the turn of `angle` about `about`. */
  offset: string;
  shiftX: string;
  shiftY: string;
  angle: string;
  about: TurnAxis;
  flip: boolean;
  /** Coordinates of a fixed frame. */
  x: string;
  y: string;
  z: string;
  /** Parts of a stored frame the panel does not show (an x direction, another offset), kept. */
  kept?: { offset?: Json; xAxis?: Json; fixed?: Json } | undefined;
}

/** A new form's offset: an offset plane starts 10 mm off its base; the other modes start on what they attach to. */
export const defaultOffset = (kind: ConstructionKind, mode: ConstructionMode): string =>
  kind === 'plane' && mode === 'plane' ? '10' : '0';

export function newConstructionForm(kind: ConstructionKind): ConstructionForm {
  const mode = MODES[kind][0] as ConstructionMode;
  return {
    kind,
    mode,
    supports: SUPPORTS[mode].map(() => null),
    offset: defaultOffset(kind, mode),
    shiftX: '0',
    shiftY: '0',
    angle: '0',
    about: 'x',
    flip: false,
    x: '0',
    y: '0',
    z: '0',
  };
}

/** The form switched to `mode`, keeping the supports that still fit; an offset left at its default takes the new mode's. */
export function withMode(form: ConstructionForm, mode: ConstructionMode): ConstructionForm {
  const slots = SUPPORTS[mode];
  const old = SUPPORTS[form.mode];
  const offset = form.offset === defaultOffset(form.kind, form.mode) ? defaultOffset(form.kind, mode) : form.offset;
  return {
    ...form,
    mode,
    offset,
    supports: slots.map((kind, i) => (old[i] === kind ? (form.supports[i] ?? null) : null)),
  };
}

/**
 * The supports after a click picked `picked` for the armed slot: a support
 * already held is dropped and its slot armed again, as a re-click drops a
 * pick in the other panels; otherwise it fills the armed slot and the next
 * empty slot is armed.
 */
export function clickedSupport<T>(
  supports: readonly (T | null)[],
  armed: number,
  picked: T,
  same: (a: T, b: T) => boolean,
): { supports: (T | null)[]; armed: number } {
  const held = supports.findIndex((s) => s !== null && same(s, picked));
  if (held >= 0) return { supports: supports.map((s, i) => (i === held ? null : s)), armed: held };
  const next = supports.map((s, i) => (i === armed ? picked : s));
  const empty = next.findIndex((s, i) => i !== armed && s === null);
  return { supports: next, armed: empty >= 0 ? empty : armed };
}

const PLACEMENT = { type: 'placement' } as const;

type V3 = readonly [number, number, number];

/**
 * The direction the offset moves an attached frame, from the frame as it
 * shows (`x`, `y`, `normal`, after the turn of `angle` degrees about its
 * `about` axis and the flip): the normal of the frame it is attached to.
 */
export function offsetDirection(
  frame: { x?: V3; y: V3; normal: V3 },
  angle: number,
  flip: boolean,
  about: TurnAxis = 'x',
): [number, number, number] {
  const s = flip ? -1 : 1;
  const a = (angle * Math.PI) / 180;
  const [sin, cos] = [Math.sin(a), Math.cos(a)];
  // The base normal in the turned frame's axes: the turn undone.
  const [cx, cy, cz] = about === 'x' ? [0, sin, cos] : about === 'y' ? [-sin, 0, cos] : [0, 0, 1];
  const x = frame.x ?? [0, 0, 0];
  return [0, 1, 2].map(
    (i) => cx * (x[i] as number) + s * (cy * (frame.y[i] as number) + cz * (frame.normal[i] as number)),
  ) as [number, number, number];
}

const TURN_AXES: Record<TurnAxis, [string, string, string]> = {
  x: ['1', '0', '0'],
  y: ['0', '1', '0'],
  z: ['0', '0', '1'],
};

/** Expression text negated: a plain number flips its sign, anything else is wrapped. */
const negated = (text: string): string => {
  const t = text.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return String(-Number(t) + 0);
  return `-(${t})`;
};

/** A stored turn as the form shows it: about x, y or the normal with a signed angle; null for a turn about another axis. */
export function turnOf(axis: readonly string[], angle: string): { about: TurnAxis; angle: string } | null {
  const v = axis.map((c) => Number(c));
  if (v.some((c) => !Number.isFinite(c))) return null;
  if (Number(angle) === 0) return { about: 'x', angle: '0' };
  const i = v.findIndex((c) => c !== 0);
  if (i < 0 || v.some((c, j) => j !== i && c !== 0)) return null;
  const about = (['x', 'y', 'z'] as const)[i] as TurnAxis;
  return { about, angle: (v[i] as number) < 0 ? negated(angle) : angle };
}

export function buildConstruction(doc: Doc, target: FeatureTarget, form: ConstructionForm, values: ValueSlots): Built {
  const path = ['frame'];
  if (form.mode === 'fixed') {
    if (form.kept?.fixed)
      return {
        ok: true,
        inputs: { ...(target.base ?? {}), frame: { fixed: { placement: form.kept.fixed } } },
        names: {},
      };
    const p = bindValue(
      doc,
      target,
      values,
      [...path, 'fixed', 'placement'],
      placementText({ x: form.x, y: form.y, z: form.z, axis: ['1', '0', '0'], angle: '0' }),
      PLACEMENT,
      'position',
    );
    if (!p.ok) return p;
    return { ok: true, inputs: { ...(target.base ?? {}), frame: { fixed: { placement: p.value } } }, names: {} };
  }
  const slots = SUPPORTS[form.mode];
  for (const [i, kind] of slots.entries()) if (!form.supports[i]) return needsPick(SLOT_HINTS[kind], `support${i}`);
  const supports = form.supports as PickedRef[];
  let offset: Json;
  if (form.kept?.offset) offset = form.kept.offset;
  else {
    const o = bindValue(
      doc,
      target,
      values,
      [...path, 'attach', 'offset'],
      placementText({ x: form.shiftX, y: form.shiftY, z: form.offset, axis: TURN_AXES[form.about], angle: form.angle }),
      PLACEMENT,
      'offset',
    );
    if (!o.ok) return o;
    offset = o.value;
  }
  const attach: Json = {
    support: supports.map((s) => s.reference),
    mode: values.choice([...path, 'attach', 'mode'], form.mode),
    offset,
    flip: values.flag([...path, 'attach', 'flip'], form.flip),
    ...(form.kept?.xAxis ? { xAxis: form.kept.xAxis } : {}),
  };
  return { ok: true, inputs: { ...(target.base ?? {}), frame: { attach } }, names: namesOf(supports) };
}

/** A label for a stored support. */
function supportLabel(ref: Json): string {
  const name = at(ref, 'standard', 'name');
  if (typeof name === 'string')
    return name === 'origin' ? 'Origin' : `${name.toUpperCase()} ${name.length === 1 ? 'axis' : 'plane'}`;
  if (isPlainObject(ref.object)) return 'Construction';
  return 'Picked';
}

export function readConstruction(kind: ConstructionKind) {
  return (doc: Doc, _part: string, inputs: Json): ConstructionForm | null => {
    const form = newConstructionForm(kind);
    const frame = inputs.frame as Json | undefined;
    if (frame && 'fixed' in frame) {
      form.mode = 'fixed';
      form.supports = [];
      const fields = readPlacement(exprText(at(frame, 'fixed', 'placement')));
      if (fields && fields.angle === '0') Object.assign(form, { x: fields.x, y: fields.y, z: fields.z });
      else form.kept = { fixed: at(frame, 'fixed', 'placement') as Json };
      return form;
    }
    const attach = at(frame, 'attach') as Json | undefined;
    if (!attach) return null;
    const read = fieldReader(doc);
    const mode = read.choice(attach.mode) as ConstructionMode;
    if (!(mode in SUPPORTS) || mode === 'fixed') return null;
    form.mode = mode;
    form.supports = ((attach.support as Json[] | undefined) ?? []).map((ref) => ({
      reference: ref,
      names: {},
      label: supportLabel(ref),
    }));
    form.flip = read.flag(attach.flip);
    const fields = readPlacement(exprText(attach.offset));
    const turn = fields ? turnOf(fields.axis, fields.angle) : null;
    if (fields && turn)
      Object.assign(form, {
        offset: fields.z,
        shiftX: fields.x,
        shiftY: fields.y,
        angle: turn.angle,
        about: turn.about,
      });
    else form.kept = { offset: attach.offset as Json };
    if (attach.xAxis !== undefined) form.kept = { ...form.kept, xAxis: attach.xAxis as Json };
    return form;
  };
}
