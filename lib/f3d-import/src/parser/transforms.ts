/**
 * Features that work on whole bodies or repeat other features: combine, remove
 * body, move, mirror and patterns, and shell.
 *
 * A feature's inputs are slots in order, each holding operands. A body operand's
 * recipe lists the operations that made the body. A direct operand names a
 * record: a feature, a body or a plane. Directions carry the line they were
 * picked on. A count is an integer owner beside the parameters.
 */
import type { DesignIndex } from './designIndex';
import { primaryRange, readPrologue, refAt, refsIn, secondaryRange } from './designIndex';
import { ByteReader } from './byteReader';
import { rigidMatrixAt } from './components';
import type {
  F3dBodyOps,
  F3dCombine,
  F3dCopySource,
  F3dFaceName,
  F3dFeature,
  F3dLine3,
  F3dMirror,
  F3dMove,
  F3dParameter,
  F3dPattern,
  F3dPlane,
  F3dRemoveBody,
  F3dShell,
} from './types';

const TYPE_INPUT = '2CA5A1CD';
const TYPE_DIRECTION_INPUT = 'F2A7590D';
const TYPE_BODY_OPERAND = '9716F783';
const TYPE_DIRECT_OPERAND = '5A1BF548';
const TYPE_FACE_OPERAND = '5662F619';
const TYPE_DIRECT = '90055C05';
const TYPE_RECIPE = '7ACC2A03';
const TYPE_MODEL_LINE = '50AEE8B4';
const TYPE_MOVE_MATRIX = '84E6245F';
const TYPE_PLANE = '8D424E29';
const TYPE_PLANE_SNAPSHOT = 'CC54ECAD';
const TYPE_BODY = 'D3937028';
const MATRIX_BYTES = 128;

const TYPE_COMBINE = '2A94257F';
const TYPE_REMOVE_BODY = '4A782808';
const TYPE_MOVE = '64E40C8E';
const TYPE_MOVE_BODY = '74479086';
const TYPE_MIRROR = 'D1728651';
const TYPE_RECTANGULAR = 'AE12AD3F';
const TYPE_CIRCULAR = '11F1A5CE';
const TYPE_SHELL = 'E8063467';

const COMBINE_OPERATIONS = ['join', 'cut', 'intersect'] as const;
const PLANE_NAMES: Record<string, 'xy' | 'xz' | 'yz'> = { XY: 'xy', XZ: 'xz', YZ: 'yz' };

const typeKey = (index: DesignIndex, id: number) => index.typeOf.get(id)?.key;

function refsOf(index: DesignIndex, id: number): number[] {
  const out: number[] = [];
  for (const range of [primaryRange(index, id), secondaryRange(index, id)]) {
    if (range) out.push(...refsIn(index, range.start, range.end).map((r) => r.id));
  }
  return [...new Set(out)];
}

const slots = (index: DesignIndex, id: number, type = TYPE_INPUT): number[] =>
  refsOf(index, id).filter((r) => typeKey(index, r) === type);

/** A recipe's slots of tags. A body's are its operations, written as tokens. */
function recipeTags(index: DesignIndex, id: number): F3dFaceName[][] {
  const range = primaryRange(index, id);
  if (!range) return [];
  const r = new ByteReader(index.bulk, readPrologue(index, range).next, range.end);
  r.skip(8);
  const count = r.count(4);
  const out: F3dFaceName[][] = [];
  for (let i = 0; i < count; i++) {
    const tags = r.count(4);
    const slot: F3dFaceName[] = [];
    for (let t = 0; t < tags; t++) {
      const token = r.str8();
      r.skip(4);
      const ops = r.count(4);
      const list: number[] = [];
      for (let k = 0; k < ops; k++) list.push(r.u32() | 0);
      r.skip(4);
      slot.push({ token, ops: list });
    }
    out.push(slot);
  }
  return out;
}

const recipeOf = (index: DesignIndex, operand: number): number | undefined =>
  refsOf(index, operand).find((r) => typeKey(index, r) === TYPE_RECIPE);

/** The operations named by the body operands of a slot, one list per body. */
function bodiesIn(index: DesignIndex, slot: number): F3dBodyOps[] {
  const out: F3dBodyOps[] = [];
  for (const operand of refsOf(index, slot)) {
    if (typeKey(index, operand) !== TYPE_BODY_OPERAND) continue;
    const recipe = recipeOf(index, operand);
    if (recipe === undefined) continue;
    try {
      const ops = recipeTags(index, recipe)
        .flat()
        .map((t) => Number(t.token))
        .filter((n) => Number.isInteger(n) && n !== 0);
      if (ops.length > 0) out.push({ ops });
    } catch {
      // An unreadable recipe only loses its own body.
    }
  }
  return out;
}

/** The record a direct operand names: u16, then its id. */
function directTarget(index: DesignIndex, operand: number): number | undefined {
  const direct = refsOf(index, operand).find((r) => typeKey(index, r) === TYPE_DIRECT);
  const range = direct === undefined ? null : primaryRange(index, direct);
  if (!range) return undefined;
  const r = new ByteReader(index.bulk, readPrologue(index, range).next, range.end);
  if (r.remaining < 8) return undefined;
  const id = r.u64();
  return index.typeOf.has(id) ? id : undefined;
}

const directsIn = (index: DesignIndex, slot: number): number[] =>
  refsOf(index, slot)
    .filter((o) => typeKey(index, o) === TYPE_DIRECT_OPERAND)
    .flatMap((o) => directTarget(index, o) ?? []);

/** What a mirror or pattern copies: bodies, or the features it repeats. */
function sourceOf(index: DesignIndex, slot: number | undefined): F3dCopySource {
  if (slot === undefined) return { bodies: [], features: [], other: true };
  const bodies = bodiesIn(index, slot);
  const features: number[] = [];
  let other = refsOf(index, slot).some((o) => typeKey(index, o) === TYPE_FACE_OPERAND);
  for (const target of directsIn(index, slot)) {
    if (typeKey(index, target) === TYPE_BODY || typeKey(index, target) === TYPE_PLANE) other = true;
    else features.push(target);
  }
  return { bodies, features, other };
}

/** The first stored line under a record: an origin and a vector, in centimetres. */
function lineUnder(index: DesignIndex, id: number, depth = 0): F3dLine3 | null {
  for (const ref of refsOf(index, id)) {
    const key = typeKey(index, ref);
    if (key === TYPE_MODEL_LINE) {
      const range = primaryRange(index, ref);
      if (!range) continue;
      const r = new ByteReader(index.bulk, readPrologue(index, range).next, range.end);
      return { origin: [r.f64(), r.f64(), r.f64()], direction: [r.f64(), r.f64(), r.f64()] };
    }
    if ((key === TYPE_DIRECT_OPERAND || key === TYPE_FACE_OPERAND) && depth < 3) {
      const found = lineUnder(index, ref, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** A plane's name, when it is one of the origin's: a two-letter wide string. */
function originPlane(index: DesignIndex, plane: number): 'xy' | 'xz' | 'yz' | null {
  const range = primaryRange(index, plane);
  if (!range) return null;
  const bytes = index.bulk;
  for (let p = range.start; p + 8 <= range.end; p++) {
    if (
      bytes[p] !== 2 ||
      bytes[p + 1] !== 0 ||
      bytes[p + 2] !== 0 ||
      bytes[p + 3] !== 0 ||
      bytes[p + 5] !== 0 ||
      bytes[p + 7] !== 0
    )
      continue;
    const name = PLANE_NAMES[String.fromCharCode(bytes[p + 4] as number, bytes[p + 6] as number)];
    if (name) return name;
  }
  return null;
}

function readCombine(index: DesignIndex, id: number): F3dCombine | null {
  const range = primaryRange(index, id);
  if (!range) return null;
  const { next } = readPrologue(index, range);
  const r = new ByteReader(index.bulk, next, range.end);
  const op = COMBINE_OPERATIONS[r.u32()];
  if (!op) return null;
  // Remove Body features this one made, then its two options.
  const removals = r.u32();
  for (let i = 0; i < removals; i++) {
    const ref = refAt(index.bulk, r.pos, range.end);
    if (!ref) return null;
    r.pos = ref.next;
  }
  const keepTools = r.u8() === 1;
  const newComponent = r.u8() === 1;
  const inputs = slots(index, id)
    .map((s) => bodiesIn(index, s))
    .filter((b) => b.length > 0);
  const [target, ...tools] = inputs;
  if (!target) return null;
  return {
    kind: 'combine',
    id,
    op,
    keepTools,
    newComponent,
    target: target[0] as F3dBodyOps,
    tools: [...target.slice(1), ...tools.flat()],
  };
}

function readRemoveBody(index: DesignIndex, id: number): F3dRemoveBody {
  return { kind: 'removeBody', id, bodies: slots(index, id).flatMap((s) => bodiesIn(index, s)) };
}

function readMove(index: DesignIndex, id: number): F3dMove {
  const view = new DataView(index.bulk.buffer, index.bulk.byteOffset, index.bulk.byteLength);
  let matrix: number[] | null = null;
  const holder = refsOf(index, id).find((r) => typeKey(index, r) === TYPE_MOVE_MATRIX);
  const range = holder === undefined ? null : primaryRange(index, holder);
  if (range) {
    for (let p = range.start; p + MATRIX_BYTES <= range.end && !matrix; p++) matrix = rigidMatrixAt(view, p);
  }
  return { kind: 'move', id, matrix, bodies: slots(index, id).flatMap((s) => bodiesIn(index, s)) };
}

/** A stored plane under a slot: origin, normal, then x axis, after the prologue. */
function planeUnder(index: DesignIndex, slot: number): F3dPlane | null {
  for (const operand of refsOf(index, slot)) {
    if (typeKey(index, operand) !== TYPE_DIRECT_OPERAND) continue;
    const plane = refsOf(index, operand).find((r) => typeKey(index, r) === TYPE_PLANE_SNAPSHOT);
    const range = plane === undefined ? null : primaryRange(index, plane);
    if (!range) continue;
    const r = new ByteReader(index.bulk, readPrologue(index, range).next, range.end);
    return { origin: [r.f64(), r.f64(), r.f64()], normal: [r.f64(), r.f64(), r.f64()], x: [r.f64(), r.f64(), r.f64()] };
  }
  return null;
}

/** The first tag of each face operand under a slot. */
function facesIn(index: DesignIndex, slot: number): F3dFaceName[] {
  const out: F3dFaceName[] = [];
  for (const operand of refsOf(index, slot)) {
    if (typeKey(index, operand) !== TYPE_FACE_OPERAND) continue;
    const recipe = recipeOf(index, operand);
    if (recipe === undefined) continue;
    try {
      const first = recipeTags(index, recipe)[0]?.[0];
      if (first) out.push(first);
    } catch {
      // An unreadable recipe only loses its own face.
    }
  }
  return out;
}

function readMirror(index: DesignIndex, id: number): F3dMirror {
  const inputs = slots(index, id);
  const planeSlot = inputs[inputs.length - 1];
  const target =
    planeSlot === undefined ? undefined : directsIn(index, planeSlot).find((t) => typeKey(index, t) === TYPE_PLANE);
  return {
    kind: 'mirror',
    id,
    of: sourceOf(index, inputs[0]),
    plane: target === undefined ? null : originPlane(index, target),
    frame: planeSlot === undefined ? null : planeUnder(index, planeSlot),
    planeFace: planeSlot === undefined ? null : (facesIn(index, planeSlot)[0] ?? null),
  };
}

function readPattern(
  index: DesignIndex,
  id: number,
  owned: readonly F3dParameter[],
  kind: 'rectangular' | 'circular',
): F3dPattern {
  const directions = slots(index, id, TYPE_DIRECTION_INPUT).map((s) => lineUnder(index, s));
  const role = (name: string) => owned.find((p) => p.role === name) ?? null;
  return {
    kind: 'pattern',
    id,
    layout: kind,
    of: sourceOf(index, slots(index, id)[0]),
    directions,
    counts: owned
      .filter((p) => /count/i.test(p.role))
      .sort((a, b) => (a.role.toLowerCase() < b.role.toLowerCase() ? -1 : 1))
      .map((p) => Math.round(p.value)),
    uSpacing: role('uSpaceDistance') ?? role('USpaceDistance'),
    vSpacing: role('vSpaceDistance') ?? role('VSpaceDistance'),
    angle: role('TotalAngle'),
  };
}

function readShell(index: DesignIndex, id: number, owned: readonly F3dParameter[]): F3dShell {
  const faces: F3dFaceName[] = [];
  const bodies: F3dBodyOps[] = [];
  for (const slot of slots(index, id)) {
    bodies.push(...bodiesIn(index, slot));
    faces.push(...facesIn(index, slot));
  }
  return {
    kind: 'shell',
    id,
    faces,
    bodies,
    inner: owned.find((p) => /inner/i.test(p.role) || /inner/i.test(p.name)) ?? owned[0] ?? null,
  };
}

/** The body and repeat features of a design. */
export function readTransforms(index: DesignIndex, ownedBy: (id: number) => readonly F3dParameter[]): F3dFeature[] {
  const out: F3dFeature[] = [];
  const each = (type: string, read: (id: number) => F3dFeature | null): void => {
    for (const id of index.idsOf.get(type) ?? []) {
      try {
        const f = read(id);
        if (f) out.push(f);
      } catch {
        // An unreadable record stays on the timeline as left out.
      }
    }
  };
  each(TYPE_COMBINE, (id) => readCombine(index, id));
  each(TYPE_REMOVE_BODY, (id) => readRemoveBody(index, id));
  each(TYPE_MOVE, (id) => readMove(index, id));
  each(TYPE_MOVE_BODY, (id) => readMove(index, id));
  each(TYPE_MIRROR, (id) => readMirror(index, id));
  each(TYPE_RECTANGULAR, (id) => readPattern(index, id, ownedBy(id), 'rectangular'));
  each(TYPE_CIRCULAR, (id) => readPattern(index, id, ownedBy(id), 'circular'));
  each(TYPE_SHELL, (id) => readShell(index, id, ownedBy(id)));
  return out;
}
