/**
 * The hole command's model (appendix A `core.hole`): one or more positions
 * on a planar face, drilled into the material as a simple, counterbored or
 * countersunk hole, blind with a flat or drill-point tip, or through all;
 * optionally tapped to an ISO metric thread, when the drill is the size's
 * tap drill (the thread table).
 *
 * A position is a vector in the face's placement frame (7.3 `plane` on a
 * face: origin the part origin projected onto it, x the part's x projected),
 * optionally measured from one or two straight edges of the face (`from`):
 * each distance is from the edge's line, into the face.
 */
import { isPlainObject } from '@tweakcad/format';
import { withDefaultUnit, type Doc, type Json } from '@tweakcad/editor';
import { ISO_METRIC, threadSize } from '@tweakcad/worker/src/v2/threadTable';
import {
  at,
  measured,
  bindValue,
  boundAngle,
  boundLength,
  exprText,
  fieldText,
  needsPick,
  namesOf,
  fieldReader,
  sameReference,
  type Built,
  type FeatureTarget,
  type PickedRef,
  type ValueSlots,
} from './feature';
import { handOf, writeHand, type ThreadHand } from './thread';

export type HoleKind = 'simple' | 'counterbore' | 'countersink';

export interface HolePosition {
  id: string;
  /** Expression text of the position's x and y in the face frame. */
  x: string;
  y: string;
  /** A stored position the panel does not split into x and y (a referenced point), kept as found. */
  kept?: Json;
  /** The edges of the face it is measured from, at most two, each with its distance. */
  from?: HoleEdgeDistance[];
}

export interface HoleEdgeDistance {
  edge: PickedRef;
  /** Expression text of the distance from the edge's line. */
  distance: string;
}

/** How many edges a position is measured from at most. */
export const MAX_EDGES = 2;

/**
 * What a click on an edge does to a position: an edge it is measured from
 * is dropped, another is added at `distance` while it has fewer than two.
 */
export function clickEdge(position: HolePosition, picked: PickedRef, distance: string): HolePosition {
  const from = position.from ?? [];
  if (from.some((f) => sameReference(f.edge.reference, picked.reference))) {
    const left = from.filter((f) => !sameReference(f.edge.reference, picked.reference));
    const rest = { ...position };
    delete rest.from;
    return left.length > 0 ? { ...rest, from: left } : rest;
  }
  if (from.length >= MAX_EDGES) return position;
  return { ...position, from: [...from, { edge: picked, distance }] };
}

export interface HoleForm {
  /** The face the hole is drilled into; null while picking. */
  face: PickedRef | null;
  /** A placement the panel does not offer (an attached frame), kept as found. */
  keptPlacement?: Json | undefined;
  positions: HolePosition[];
  kind: HoleKind;
  diameter: string;
  extent: 'distance' | 'throughAll' | 'kept';
  depth: string;
  tip: 'flat' | 'angle';
  tipAngle: string;
  counterboreDiameter: string;
  counterboreDepth: string;
  countersinkDiameter: string;
  countersinkAngle: string;
  threaded: boolean;
  designation: string;
  threadClass: string;
  /** The thread cut into the bore, rather than data on it. */
  modelled: boolean;
  hand: ThreadHand;
}

export function newHoleForm(): HoleForm {
  return {
    face: null,
    positions: [],
    kind: 'simple',
    diameter: '5',
    extent: 'distance',
    depth: '10',
    tip: 'flat',
    tipAngle: '118',
    counterboreDiameter: '10',
    counterboreDepth: '5',
    countersinkDiameter: '10',
    countersinkAngle: '90',
    threaded: false,
    modelled: false,
    designation: 'M5',
    threadClass: '6H',
    hand: 'right',
  };
}

/**
 * What a click on a face does to the form. On the hole's face it adds a
 * position. On another face the hole moves there, with the click as its one
 * position, unless the hole has no face (it was taken off) or its face is
 * lost (`faceLost`): then the clicked face takes its place and the positions
 * stay, so the hole keeps where it was in the face frame.
 */
export function clickFace(
  form: HoleForm,
  picked: PickedRef,
  position: HolePosition,
  faceLost: boolean,
): Partial<HoleForm> {
  if (form.face && sameReference(form.face.reference, picked.reference))
    return { positions: [...form.positions, position] };
  if ((!form.face || faceLost) && form.positions.length > 0) return { face: picked, keptPlacement: undefined };
  return { face: picked, keptPlacement: undefined, positions: [position] };
}

/** The face taken off the hole. The positions stay, so the face picked next takes them where they were. */
export function removeFace(): Partial<HoleForm> {
  return { face: null, keptPlacement: undefined };
}

/** The tap drill of a thread size, in mm, or null for a size the table does not have. */
export function tapDrill(designation: string): number | null {
  try {
    return threadSize(ISO_METRIC, designation).tapDrill;
  } catch {
    return null;
  }
}

/** The parts of a `vector(a, b, c)` text, split at its top-level commas; null for other text. */
export function vectorParts(text: string): string[] | null {
  const m = /^\s*vector\((.*)\)\s*$/s.exec(text);
  if (!m) return null;
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of m[1] as string) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** The text of a length vector from field texts, bare numbers taken as millimetres. */
export function vectorText(parts: readonly string[]): string {
  return `vector(${parts.map((p) => withDefaultUnit(p.trim() === '' ? '0' : p, 'mm')).join(', ')})`;
}

const LENGTH_VECTOR = { type: 'vector', quantity: 'length' } as const;

export function buildHole(doc: Doc, target: FeatureTarget, form: HoleForm, values: ValueSlots): Built {
  if (!form.face && !form.keptPlacement) return needsPick('Pick a face to drill', 'face');
  if (form.positions.length === 0) return needsPick('Click on the face where the hole goes', 'positions');
  const len = (path: (string | number)[], text: string, field: string, label: string) =>
    boundLength(doc, target, values, path, text, field, label);

  const positions: Json[] = [];
  const edges: PickedRef[] = [];
  for (const [i, p] of form.positions.entries()) {
    let row: Json;
    if (p.kept) row = { id: p.id, at: structuredClone(p.kept) };
    else {
      const v = bindValue(
        doc,
        target,
        values,
        ['positions', i, 'at', 'at', 'v'],
        vectorText([p.x, p.y, '0']),
        LENGTH_VECTOR,
        `position${i}`,
      );
      if (!v.ok) return v;
      row = { id: p.id, at: { at: { v: v.value } } };
    }
    if (p.from && p.from.length > 0) {
      const from: Json[] = [];
      for (const [j, f] of p.from.entries()) {
        const d = boundLength(
          doc,
          target,
          values,
          ['positions', i, 'from', j, 'd'],
          f.distance,
          `position${i}from${j}`,
          'Distance',
          { allowZero: true },
        );
        if (!d.ok) return d;
        from.push({ edge: f.edge.reference, d: d.value });
        edges.push(f.edge);
      }
      row.from = from;
    }
    positions.push(row);
  }
  // A tapped hole is drilled at its size's tap drill; the diameter is kept for when the thread is taken off.
  const diameter = len(['diameter'], form.diameter, 'diameter', 'Diameter');
  if (!diameter.ok) return diameter;
  // A counterbore or countersink is wider than the hole drilled under it.
  const drilled = form.threaded ? tapDrill(form.designation) : (diameter.stored as number | null);
  const wider = (d: unknown): boolean | null =>
    typeof d === 'number' && typeof drilled === 'number' ? d > drilled : null;

  let depth: Json;
  if (form.extent === 'throughAll') depth = { throughAll: {} };
  else if (form.extent === 'kept') depth = structuredClone(at(target.base, 'depth') as Json);
  else {
    const d = len(['depth', 'distance', 'd'], form.depth, 'depth', 'Depth');
    if (!d.ok) return d;
    depth = { distance: { d: d.value } };
  }

  let tip: Json = { flat: {} };
  if (form.tip === 'angle') {
    const a = boundAngle(doc, target, values, ['tip', 'angle', 'a'], form.tipAngle, 'tipAngle');
    if (!a.ok) return a;
    if (!measured(a) && !((a.stored as number) > 0 && (a.stored as number) < 180))
      return { ok: false, message: 'Tip angle must be in (0, 180) degrees', field: 'tipAngle' };
    tip = { angle: { a: a.value } };
  }

  const inputs: Json = {
    ...(target.base ?? {}),
    placement: form.face ? { face: form.face.reference } : (form.keptPlacement as Json),
    positions,
    kind: values.choice(['kind'], form.kind),
    diameter: diameter.value,
    depth,
    tip,
  };
  delete inputs.counterbore;
  delete inputs.countersink;
  if (form.kind === 'counterbore') {
    const cd = len(
      ['counterbore', 'diameter'],
      form.counterboreDiameter,
      'counterboreDiameter',
      'Counterbore diameter',
    );
    if (!cd.ok) return cd;
    const ch = len(['counterbore', 'depth'], form.counterboreDepth, 'counterboreDepth', 'Counterbore depth');
    if (!ch.ok) return ch;
    if (wider(cd.stored) === false)
      return { ok: false, message: 'Counterbore diameter must exceed hole diameter', field: 'counterboreDiameter' };
    inputs.counterbore = { diameter: cd.value, depth: ch.value };
  }
  if (form.kind === 'countersink') {
    const sd = len(
      ['countersink', 'diameter'],
      form.countersinkDiameter,
      'countersinkDiameter',
      'Countersink diameter',
    );
    if (!sd.ok) return sd;
    const sa = boundAngle(doc, target, values, ['countersink', 'angle'], form.countersinkAngle, 'countersinkAngle');
    if (!sa.ok) return sa;
    if (!measured(sa) && !((sa.stored as number) > 0 && (sa.stored as number) < 180))
      return { ok: false, message: 'Countersink angle must be in (0, 180) degrees', field: 'countersinkAngle' };
    if (wider(sd.stored) === false)
      return { ok: false, message: 'Countersink diameter must exceed hole diameter', field: 'countersinkDiameter' };
    inputs.countersink = { diameter: sd.value, angle: sa.value };
  }
  if (form.threaded) {
    if (tapDrill(form.designation) === null)
      return { ok: false, message: `${form.designation} is not in the thread table`, field: 'designation' };
    const path = (field: string) => ['thread', 'thread', field];
    inputs.thread = {
      thread: {
        standard: values.literal(path('standard'), `"${ISO_METRIC}"`),
        designation: values.choice(path('designation'), form.designation),
        class: values.choice(path('class'), form.threadClass),
        modelled: values.flag(path('modelled'), form.modelled),
      },
    };
    writeHand(
      (inputs.thread as Json).thread as Json,
      values,
      path('hand'),
      form.hand,
      at(target.base, 'thread', 'thread', 'hand') !== undefined,
    );
  } else inputs.thread = { none: {} };
  return { ok: true, inputs, names: namesOf([form.face, ...edges]) };
}

export function readHole(doc: Doc, _part: string, inputs: Json): HoleForm | null {
  const form = newHoleForm();
  const placement = inputs.placement as Json | undefined;
  if (placement && 'face' in placement) form.face = { reference: placement.face as Json, names: {}, label: 'Face' };
  else if (placement) form.keptPlacement = placement;
  form.positions = ((inputs.positions as Json[] | undefined) ?? []).map((p) => {
    const parts = vectorParts(exprText(at(p, 'at', 'at', 'v')));
    // A vector off the face (z not 0) or any other kind of point is kept whole.
    const from = ((p.from as Json[] | undefined) ?? []).map((f) => ({
      edge: { reference: f.edge as Json, names: {}, label: 'Edge' },
      distance: fieldText(exprText(f.d)),
    }));
    const measured = from.length > 0 ? { from } : {};
    if (!parts || parts.length !== 3 || !/^\s*0*\.?0*\s*(mm)?\s*$/.test(parts[2] as string))
      return { id: String(p.id), x: '', y: '', kept: p.at as Json, ...measured };
    return { id: String(p.id), x: fieldText(parts[0] as string), y: fieldText(parts[1] as string), ...measured };
  });
  const read = fieldReader(doc);
  const kind = read.choice(inputs.kind);
  if (kind === 'simple' || kind === 'counterbore' || kind === 'countersink') form.kind = kind;
  form.diameter = fieldText(exprText(inputs.diameter));
  const depth = inputs.depth as Json | undefined;
  if (depth && 'throughAll' in depth) form.extent = 'throughAll';
  else if (depth && 'distance' in depth) form.depth = fieldText(exprText(at(depth, 'distance', 'd')));
  else form.extent = 'kept';
  const tip = inputs.tip as Json | undefined;
  if (tip && 'angle' in tip) {
    form.tip = 'angle';
    form.tipAngle = fieldText(exprText(at(tip, 'angle', 'a')), 'deg');
  }
  if (isPlainObject(inputs.counterbore)) {
    form.counterboreDiameter = fieldText(exprText(inputs.counterbore.diameter));
    form.counterboreDepth = fieldText(exprText(inputs.counterbore.depth));
  }
  if (isPlainObject(inputs.countersink)) {
    form.countersinkDiameter = fieldText(exprText(inputs.countersink.diameter));
    form.countersinkAngle = fieldText(exprText(inputs.countersink.angle), 'deg');
  }
  const thread = at(inputs, 'thread', 'thread');
  if (isPlainObject(thread)) {
    form.threaded = true;
    form.designation = read.choice(thread.designation) || form.designation;
    form.threadClass = read.choice(thread.class) || form.threadClass;
    form.modelled = read.flag(thread.modelled);
    form.hand = handOf(read, thread.hand);
  }
  return form;
}
