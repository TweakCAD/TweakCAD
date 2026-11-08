/**
 * The thread command's model (appendix A `core.thread`): an ISO metric
 * thread on a cylindrical face, cosmetic or cut into the body, the whole
 * face or a length from one of its circular edges. The size follows the
 * face: a shaft takes the size whose major diameter it is (class 6g), a bore
 * the size whose tap drill it is (class 6H).
 */
import type { Doc, Json } from '@tweakcad/editor';
import type { Display, Key } from '@tweakcad/worker/src/v2/service/types';
import {
  ISO_METRIC,
  ISO_METRIC_DESIGNATIONS,
  ISO_METRIC_SIZES,
  isoDesignations,
  parseIsoDesignation,
  threadSize,
} from '@tweakcad/worker/src/v2/threadTable';
import {
  at,
  boundLength,
  exprText,
  fieldReader,
  fieldText,
  namesOf,
  needsPick,
  type Built,
  type FeatureTarget,
  type PickedRef,
  type ValueSlots,
} from './feature';

export interface ThreadForm {
  face: PickedRef | null;
  designation: string;
  threadClass: string;
  length: 'full' | 'distance';
  distance: string;
  /** The circular edge a partial thread starts from. */
  from: PickedRef | null;
  /** Cut into the body, rather than data on the face. */
  modelled: boolean;
  /** A thread in a bore, rather than on a shaft. */
  internal: boolean;
  hand: ThreadHand;
}

export type ThreadHand = 'right' | 'left';

/** The Direction choices: the thread's hand. */
export const HANDS: { id: ThreadHand; label: string; title: string }[] = [
  { id: 'right', label: 'Right hand', title: 'A right-handed thread' },
  { id: 'left', label: 'Left hand', title: 'A left-handed thread' },
];

/** The hand a thread input gives: left only where its `hand` reads left. */
export function handOf(read: { choice(value: unknown): string }, hand: unknown): ThreadHand {
  return hand !== undefined && read.choice(hand) === 'left' ? 'left' : 'right';
}

/** Writes `hand` into `thread`, the value at `path`: for a left-handed thread, or one that had a `hand` (`had`); a right-handed thread otherwise has none. */
export function writeHand(
  thread: Json,
  values: ValueSlots,
  path: (string | number)[],
  hand: ThreadHand,
  had: boolean,
): void {
  if (hand === 'left' || had) thread.hand = values.choice(path, hand);
  else delete thread.hand;
}

export const EXTERNAL_CLASSES = ['6g', '4g6g', '6e', '6f', '6h'];
export const INTERNAL_CLASSES = ['6H', '5H', '7H', '6G'];

/** Whether a tolerance class is an internal thread's: ISO writes those with capital letters (6H), external ones in lower case (6g). */
export function isInternalClass(threadClass: string): boolean {
  return /[A-Z]/.test(threadClass);
}

/** The classes a thread may take: an internal thread's, or an external one's. */
export function classesFor(internal: boolean): readonly string[] {
  return internal ? INTERNAL_CLASSES : EXTERNAL_CLASSES;
}

/**
 * What picking a face of known kind does to the class: a class of the
 * other kind is replaced by the first class of this kind.
 */
export function classOnFace(threadClass: string, internal: boolean): string {
  return isInternalClass(threadClass) === internal ? threadClass : (classesFor(internal)[0] as string);
}

export function newThreadForm(): ThreadForm {
  return {
    face: null,
    designation: 'M6',
    threadClass: '6g',
    length: 'full',
    distance: '10',
    from: null,
    modelled: false,
    internal: false,
    hand: 'right',
  };
}

/** The sizes the Size list offers, as nominal diameters in mm. */
export const THREAD_SIZES: readonly number[] = ISO_METRIC_SIZES;

/** The size a designation is of (`M8x1` is size 8), or null for text that is not an ISO metric designation. */
export function sizeOf(designation: string): number | null {
  return parseIsoDesignation(designation)?.size ?? null;
}

/** The designations the Designation list offers beside `designation`: those of its size, the coarse one first, then the fine ones. */
export function designationsFor(designation: string): readonly string[] {
  const size = sizeOf(designation);
  return size === null ? [] : isoDesignations(size);
}

/** The designation a size takes when it is picked: its coarse one, or its largest fine pitch for a size with fine pitches only. */
export function designationOfSize(size: number): string {
  return isoDesignations(size)[0] ?? `M${size}`;
}

/**
 * The size and class a cylindrical face of `diameter` mm takes: a shaft
 * the size whose major diameter it is, in its first designation (6g); a
 * bore the designation between whose minor and major diameters it lies,
 * nearest its tap drill, the coarse one of two as near (6H).
 */
export function sizeForDiameter(diameter: number, bore: boolean): { designation: string; threadClass: string } | null {
  if (!bore) {
    let best: { designation: string; off: number } | null = null;
    for (const size of ISO_METRIC_SIZES) {
      const designation = designationOfSize(size);
      const s = threadSize(ISO_METRIC, designation);
      const off = Math.abs(diameter - s.major);
      if (off <= 0.15 * s.pitch && (!best || off < best.off)) best = { designation, off };
    }
    return best ? { designation: best.designation, threadClass: '6g' } : null;
  }
  let best: { designation: string; off: number; coarse: boolean } | null = null;
  for (const designation of ISO_METRIC_DESIGNATIONS) {
    const s = threadSize(ISO_METRIC, designation);
    if (diameter < s.minor - 1e-3 || diameter >= s.major) continue;
    const off = Math.abs(diameter - s.tapDrill);
    const coarse = parseIsoDesignation(designation)?.pitch === null;
    const nearer = !best || off < best.off - 1e-9 || (Math.abs(off - best.off) <= 1e-9 && coarse && !best.coarse);
    if (nearer) best = { designation, off, coarse };
  }
  return best ? { designation: best.designation, threadClass: '6H' } : null;
}

type V3 = [number, number, number];

/**
 * Whether a cylindrical face of radius `radius` is a bore, from its display
 * triangles: the outward normal of a bore points at the axis. Two vertices
 * of the face, moved by the radius against their normals, land on one axis
 * line for a shaft and not for a bore. Null when the display does not show
 * the face.
 */
export function isBore(display: Display | null, face: Key, radius: number, axis: readonly number[]): boolean | null {
  for (const d of display?.definitions ?? []) {
    for (const b of d.bodies) {
      const m = b.mesh;
      for (let i = 0; i + 2 < m.faces.length; i += 3) {
        if (m.faces[i + 2] !== face) continue;
        const first = m.faces[i] as number;
        const count = m.faces[i + 1] as number;
        const vertices = new Set<number>();
        for (let t = first; t < first + count; t++)
          for (let c = 0; c < 3; c++) vertices.add(m.indices[3 * t + c] as number);
        const list = [...vertices];
        const read = (v: number, arr: Float32Array): V3 => [
          arr[3 * v] as number,
          arr[3 * v + 1] as number,
          arr[3 * v + 2] as number,
        ];
        const a = list[0];
        if (a === undefined) return null;
        // The vertex whose normal turns furthest from the first one.
        const na = read(a, m.normals);
        let other = a;
        let least = 2;
        for (const v of list) {
          const n = read(v, m.normals);
          const c = n[0] * na[0] + n[1] * na[1] + n[2] * na[2];
          if (c < least) {
            least = c;
            other = v;
          }
        }
        if (least > 0.99) return null;
        const moved = (v: number, sign: number): V3 => {
          const p = read(v, m.positions);
          const n = read(v, m.normals);
          return [p[0] + sign * radius * n[0], p[1] + sign * radius * n[1], p[2] + sign * radius * n[2]];
        };
        const off = (sign: number): number => {
          const p = moved(a, sign);
          const q = moved(other, sign);
          const d3: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
          const along = d3[0] * (axis[0] as number) + d3[1] * (axis[1] as number) + d3[2] * (axis[2] as number);
          return Math.hypot(
            d3[0] - along * (axis[0] as number),
            d3[1] - along * (axis[1] as number),
            d3[2] - along * (axis[2] as number),
          );
        };
        return off(1) < off(-1);
      }
    }
  }
  return null;
}

export function buildThread(doc: Doc, target: FeatureTarget, form: ThreadForm, values: ValueSlots): Built {
  if (!form.face) return needsPick('Pick a cylindrical face', 'face');
  const inputs: Json = {
    ...(target.base ?? {}),
    faces: { set: [form.face.reference] },
    standard: values.literal(['standard'], `"${ISO_METRIC}"`),
    designation: values.choice(['designation'], form.designation),
    class: values.choice(['class'], form.threadClass),
    modelled: values.flag(['modelled'], form.modelled),
  };
  writeHand(inputs, values, ['hand'], form.hand, at(target.base, 'hand') !== undefined);
  if (form.length === 'distance') {
    if (!form.from) return needsPick('Pick the edge the thread starts from', 'from');
    const d = boundLength(doc, target, values, ['length', 'distance', 'd'], form.distance, 'distance', 'Length');
    if (!d.ok) return d;
    inputs.length = { distance: { d: d.value, from: form.from.reference } };
  } else inputs.length = { full: {} };
  return { ok: true, inputs, names: namesOf([form.face, form.length === 'distance' ? form.from : null]) };
}

export function readThread(doc: Doc, _part: string, inputs: Json): ThreadForm {
  const form = newThreadForm();
  const face = (at(inputs, 'faces', 'set') as Json[] | undefined)?.[0];
  if (face) form.face = { reference: face, names: {}, label: 'Face' };
  const read = fieldReader(doc);
  form.designation = read.choice(inputs.designation) || form.designation;
  form.threadClass = read.choice(inputs.class) || form.threadClass;
  form.internal = isInternalClass(form.threadClass);
  form.modelled = read.flag(inputs.modelled);
  form.hand = handOf(read, inputs.hand);
  const length = inputs.length as Json | undefined;
  if (length && 'distance' in length) {
    form.length = 'distance';
    form.distance = fieldText(exprText(at(length, 'distance', 'd')));
    form.from = { reference: at(length, 'distance', 'from') as Json, names: {}, label: 'Edge' };
  }
  return form;
}
