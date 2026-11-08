/**
 * Timeline features. The root timeline lists features in run order; features of
 * containers (a PCB's board, its packages) sit in the design without being on
 * it, so they are merged in by record id, which follows creation order.
 *
 * A feature's dimensions are parameters it owns: a parameter names an owner
 * record, and the owner's first reference is the feature.
 */

import type { DesignIndex } from './designIndex';
import { primaryRange, readPrologue, refAt, refsIn } from './designIndex';
import { readPrimitives } from './primitives';
import { ByteReader } from './byteReader';
import { readTransforms } from './transforms';
import type {
  F3dChamfer,
  F3dEdgeRecipe,
  F3dExtrude,
  F3dFaceName,
  F3dFeature,
  F3dFillet,
  F3dParameter,
  F3dProfile,
  F3dProfileRegion,
  F3dRevolve,
} from './types';

const TYPE_TIMELINE = '2F4C1849';
const TYPE_TIMELINE_CONTEXT = 'C3423E04';
const TYPE_SKETCH = '44A64366';
const TYPE_SKETCH_FEATURE = '8DA771B7';
const TYPE_EXTRUDE = 'DD405BC2';
const TYPE_PARAMETER_OWNER = 'D91D429C';
const TYPE_OPERAND_GROUP = '2CA5A1CD';
const TYPE_SKETCH_PROFILE = '4BD53E5A';
const TYPE_PROFILE_REGIONS = '0D57BD2F';
const TYPE_REVOLVE = 'E3849A15';
const TYPE_GEOMETRY_OPERAND = '5A1BF548';
const TYPE_MODEL_LINE = '50AEE8B4';
const TYPE_FILLET = 'A07D5F17';
const TYPE_CHAMFER = 'F757D611';
const TYPE_FACE_OPERAND = '5662F619';
const TYPE_RECIPE = '7ACC2A03';

const REGION_MEMBER_BYTES = 40;
/** Records tying a parameter to its feature: a dimension's, and an integer's. */
const OWNERS = new Set([TYPE_PARAMETER_OWNER, 'A085449A']);

/** Timeline items that change the model and are not read yet, by class. */
const LEFT_OUT: Record<string, string> = {
  B1E5B971: 'derived body',
  '2A94257F': 'combine',
  '65CA3206': 'split body',
  '7C5886AE': 'split face',
  '64E40C8E': 'move',
  '74479086': 'move',
  '21B67709': 'move face',
  D087EFE5: 'offset face',
  '29EF07D3': 'delete face',
  '4A782808': 'remove body',
  E8063467: 'shell',
  '1C037A07': 'hole',
  '584D9526': 'thread',
  FCBB1707: 'sweep',
  B6678572: 'loft',
  '73615646': 'pipe',
  DB2E4EDC: 'coil',
  F4163A07: 'draft',
  D45FD6C4: 'scale',
  BCE0AD0E: 'thicken',
  FF1741AE: 'surface trim',
  '3ADC8F37': 'rib',
  C3A9ECCE: 'emboss',
  AE12AD3F: 'rectangular pattern',
  '11F1A5CE': 'circular pattern',
  B0B3D9E5: 'path pattern',
  D1728651: 'mirror',
  BA3059E4: 'pasted body',
  '56225BC7': 'component from bodies',
  '7AFA0A65': 'flange',
  '1CF7B9E3': 'bend',
  ACE707B5: 'convert to sheet metal',
  '6C90740C': 'form',
  '6050B41C': 'mesh',
  '99F6967E': 'mesh',
  '62B85DC3': 'mesh conversion',
  '8ACBA2E5': 'derived design',
};

const typeKey = (index: DesignIndex, id: number) => index.typeOf.get(id)?.key;

function refsOf(index: DesignIndex, id: number) {
  const range = primaryRange(index, id);
  return range ? refsIn(index, range.start, range.end) : [];
}

/** Root timeline: the longest timeline list, in run order. */
function readRootTimeline(index: DesignIndex): number[] {
  let longest: number[] = [];
  for (const id of index.idsOf.get(TYPE_TIMELINE) ?? []) {
    const items = refsOf(index, id)
      .map((r) => r.id)
      .filter((r) => typeKey(index, r) !== TYPE_TIMELINE_CONTEXT);
    if (items.length > longest.length) longest = items;
  }
  return longest;
}

/** Parameters by the feature that owns them. */
function parametersByFeature(index: DesignIndex, parameters: readonly F3dParameter[]): Map<number, F3dParameter[]> {
  const out = new Map<number, F3dParameter[]>();
  for (const p of parameters) {
    if (p.ownerId === null || !OWNERS.has(typeKey(index, p.ownerId) ?? '')) continue;
    const feature = refsOf(index, p.ownerId)[0]?.id;
    if (feature === undefined) continue;
    const list = out.get(feature);
    if (list) list.push(p);
    else out.set(feature, [p]);
  }
  return out;
}

function readRegion(r: ByteReader): F3dProfileRegion {
  const loopCount = r.count(4);
  const curves: { primary: number; secondary: number }[] = [];
  for (let i = 0; i < loopCount; i++) {
    const members = r.count(REGION_MEMBER_BYTES);
    for (let j = 0; j < members; j++) {
      r.skip(4); // kind
      const low = r.u32();
      const high = r.u32();
      const secondaryLow = r.u32();
      const secondaryHigh = r.u32();
      r.skip(20); // direction, piece, pieces, padding
      curves.push({ primary: high * 2 ** 32 + low, secondary: secondaryHigh * 2 ** 32 + secondaryLow });
    }
    // The very last loop of a record can end without its byte.
    if (r.remaining > 0) r.skip(1);
  }
  return { curves };
}

function readRegions(index: DesignIndex, id: number): F3dProfileRegion[] {
  const range = primaryRange(index, id);
  if (!range) return [];
  const { next } = readPrologue(index, range);
  const operand = refAt(index.bulk, next, range.end);
  if (!operand) return [];
  const r = new ByteReader(index.bulk, operand.next, range.end);
  const groups = r.count(4);
  const regions: F3dProfileRegion[] = [];
  for (let g = 0; g < groups; g++) {
    const outline = readRegion(r);
    const parts = r.remaining >= 4 ? r.count(4) : 0;
    // With parts listed, the first region is only their outline.
    if (parts === 0) regions.push(outline);
    for (let i = 0; i < parts; i++) regions.push(readRegion(r));
  }
  return regions;
}

function readProfile(index: DesignIndex, id: number): F3dProfile | null {
  const range = primaryRange(index, id);
  if (!range) return null;
  const refs = refsIn(index, range.start, range.end);
  const regionsId = refs.find((r) => typeKey(index, r.id) === TYPE_PROFILE_REGIONS)?.id;

  // The sketch is named by its record number, written out in digits.
  let sketchId: number | null = null;
  const view = new DataView(index.bulk.buffer, index.bulk.byteOffset, index.bulk.byteLength);
  for (let p = range.start; p + 6 < range.end && sketchId === null; p++) {
    const n = view.getUint32(p, true);
    if (n < 1 || n > 12 || p + 4 + n * 2 > range.end) continue;
    let digits = '';
    for (let i = 0; i < n; i++) {
      const c = view.getUint16(p + 4 + i * 2, true);
      if (c < 0x30 || c > 0x39) {
        digits = '';
        break;
      }
      digits += String.fromCharCode(c);
    }
    if (digits && typeKey(index, Number(digits)) === TYPE_SKETCH) sketchId = Number(digits);
  }
  if (sketchId === null) return null;

  try {
    return { sketchId, regions: regionsId === undefined ? [] : readRegions(index, regionsId) };
  } catch {
    return { sketchId, regions: [] };
  }
}

/** Profile operands of a feature, directly or inside its operand groups. */
function readProfiles(index: DesignIndex, id: number): F3dProfile[] {
  const seen = new Set<number>();
  const profiles: F3dProfile[] = [];
  const visit = (recordId: number, depth: number): void => {
    for (const ref of refsOf(index, recordId)) {
      const key = typeKey(index, ref.id);
      if (seen.has(ref.id)) continue;
      if (key === TYPE_SKETCH_PROFILE) {
        seen.add(ref.id);
        const profile = readProfile(index, ref.id);
        if (profile) profiles.push(profile);
      } else if (key === TYPE_OPERAND_GROUP && depth < 3) {
        seen.add(ref.id);
        visit(ref.id, depth + 1);
      }
    }
  };
  visit(id, 0);
  return profiles;
}

const OPERATIONS: Record<number, F3dExtrude['operation']> = { 1: 'join', 2: 'cut', 3: 'intersect', 4: 'newBody' };
const DIRECTIONS: Record<number, F3dExtrude['sides']> = { 1: 'one', 2: 'two', 3: 'symmetric' };

/**
 * The block of an extrude: u32 operation, u32 direction, u32 face-extend, then
 * reversed, solid and start bytes, three zero bytes and the extrude vector. The
 * unit vector anchors the read, because what comes before it varies.
 */
function readExtrude(index: DesignIndex, id: number, owned: readonly F3dParameter[]): F3dExtrude | null {
  const range = primaryRange(index, id);
  if (!range) return null;
  const view = new DataView(index.bulk.buffer, index.bulk.byteOffset, index.bulk.byteLength);
  const limit = Math.min(range.end - 24, range.start + 400);
  for (let p = range.start + 18; p < limit; p++) {
    const x = view.getFloat64(p, true);
    const y = view.getFloat64(p + 8, true);
    const z = view.getFloat64(p + 16, true);
    if (Math.abs(x * x + y * y + z * z - 1) > 1e-9) continue;
    if (index.bulk[p - 1] !== 0 || index.bulk[p - 2] !== 0 || index.bulk[p - 3] !== 0) continue;
    const operation = OPERATIONS[view.getUint32(p - 18, true)];
    const sides = DIRECTIONS[view.getUint32(p - 14, true)];
    if (!operation || !sides) continue;
    const role = (name: string) => owned.find((q) => q.role === name) ?? null;
    return {
      kind: 'extrude',
      id,
      operation,
      sides,
      reversed: index.bulk[p - 6] === 1,
      solid: index.bulk[p - 5] === 1,
      start: index.bulk[p - 4] === 2 ? 'face' : index.bulk[p - 4] === 1 ? 'offset' : 'plane',
      vector: [x, y, z],
      profiles: readProfiles(index, id),
      along: role('AlongDistance'),
      against: role('AgainstDistance'),
      side1Offset: role('Side1Offset'),
      side2Offset: role('Side2Offset'),
      profileOffset: role('ProfileOffset'),
      taper: role('TaperAngle'),
      side2Taper: role('Side2TaperAngle'),
      wall: role('Side1WallThickness'),
      faces: readFaceOperands(index, id),
    };
  }
  return null;
}

/** The model-space line a feature's geometry operands name, if any. */
function readAxis(index: DesignIndex, id: number): F3dRevolve['axis'] {
  const seen = new Set<number>();
  const search = (recordId: number, depth: number): F3dRevolve['axis'] => {
    for (const ref of refsOf(index, recordId)) {
      const key = typeKey(index, ref.id);
      if (seen.has(ref.id)) continue;
      if (key === TYPE_MODEL_LINE) {
        const range = primaryRange(index, ref.id);
        if (!range) continue;
        const r = new ByteReader(index.bulk, readPrologue(index, range).next, range.end);
        const origin: [number, number, number] = [r.f64(), r.f64(), r.f64()];
        const direction: [number, number, number] = [r.f64(), r.f64(), r.f64()];
        return { origin, direction };
      }
      if ((key === TYPE_GEOMETRY_OPERAND || key === TYPE_OPERAND_GROUP) && depth < 3) {
        seen.add(ref.id);
        const found = search(ref.id, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return search(id, 0);
}

/** `u32 operation, u32 2` opens a revolve's members. */
function readRevolve(index: DesignIndex, id: number, owned: readonly F3dParameter[]): F3dRevolve | null {
  const range = primaryRange(index, id);
  if (!range) return null;
  const { next } = readPrologue(index, range);
  const view = new DataView(index.bulk.buffer, index.bulk.byteOffset, index.bulk.byteLength);
  for (let p = next; p + 8 < Math.min(range.end, next + 64); p++) {
    const operation = OPERATIONS[view.getUint32(p, true)];
    if (!operation || view.getUint32(p + 4, true) !== 2) continue;
    return {
      kind: 'revolve',
      id,
      operation,
      profiles: readProfiles(index, id),
      axis: readAxis(index, id),
      angle: owned.find((q) => q.role === 'AlongAngle') ?? null,
    };
  }
  return null;
}

/**
 * A recipe: u32 1, u32 3, u32 faces; per face a u32 tag count; per tag a token,
 * u32 0, u32 count, that many i32 operation ids, u32 0. An edge lists its two
 * faces first. A negative first token is the edge's own tag, not a face: the
 * edge runs between the second face and the third.
 */
function readRecipe(index: DesignIndex, id: number): F3dFaceName[] {
  const range = primaryRange(index, id);
  if (!range) return [];
  const r = new ByteReader(index.bulk, readPrologue(index, range).next, range.end);
  r.skip(8);
  const faceCount = r.count(4);
  const faces: F3dFaceName[] = [];
  for (let i = 0; i < faceCount; i++) {
    const tags = r.count(4);
    for (let t = 0; t < tags; t++) {
      const token = r.str8();
      r.skip(4);
      const count = r.count(4);
      const ops: number[] = [];
      for (let k = 0; k < count; k++) ops.push(r.u32() | 0);
      r.skip(4);
      if (t === 0) faces.push({ token, ops });
    }
  }
  return faces[0]?.token.startsWith('-') ? faces.slice(1) : faces;
}

function recipesUnder(index: DesignIndex, groupId: number): F3dEdgeRecipe[] {
  const out: F3dEdgeRecipe[] = [];
  for (const ref of refsOf(index, groupId)) {
    if (typeKey(index, ref.id) !== TYPE_FACE_OPERAND) continue;
    const recipe = refsOf(index, ref.id).find((r) => typeKey(index, r.id) === TYPE_RECIPE);
    if (!recipe) continue;
    try {
      const faces = readRecipe(index, recipe.id);
      if (faces.length >= 2) out.push({ faces });
    } catch {
      // An unreadable recipe only loses its own edge.
    }
  }
  return out;
}

/** Edge groups of a fillet or chamfer, paired in order with the sizes it owns. */
function readRoundSets(index: DesignIndex, id: number, sizes: readonly F3dParameter[]) {
  const groups = refsOf(index, id).filter((r) => typeKey(index, r.id) === TYPE_OPERAND_GROUP);
  const seen = new Set<number>();
  const sets: { size: F3dParameter | null; edges: F3dEdgeRecipe[] }[] = [];
  for (const group of groups) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    const edges = recipesUnder(index, group.id);
    if (edges.length > 0) sets.push({ size: sizes[sets.length] ?? sizes[0] ?? null, edges });
  }
  return sets;
}

function readFillet(index: DesignIndex, id: number, owned: readonly F3dParameter[]): F3dFillet {
  const sizes = owned.filter((p) => p.role === 'Radius').sort((a, b) => a.id - b.id);
  return { kind: 'fillet', id, sets: readRoundSets(index, id, sizes) };
}

function readChamfer(index: DesignIndex, id: number, owned: readonly F3dParameter[]): F3dChamfer {
  const sizes = owned.filter((p) => p.role === 'leftDistance').sort((a, b) => a.id - b.id);
  const uneven = owned.some((p) => p.role === 'rightDistance' || p.role === 'rotateAngle');
  return { kind: 'chamfer', id, sets: readRoundSets(index, id, sizes), uneven };
}

/** Faces an extrude names, for its start and its end. */
function readFaceOperands(index: DesignIndex, id: number): F3dFaceName[] {
  const names: F3dFaceName[] = [];
  const seen = new Set<number>();
  const visit = (recordId: number, depth: number): void => {
    for (const ref of refsOf(index, recordId)) {
      if (seen.has(ref.id)) continue;
      const key = typeKey(index, ref.id);
      if (key === TYPE_FACE_OPERAND) {
        seen.add(ref.id);
        const recipe = refsOf(index, ref.id).find((r) => typeKey(index, r.id) === TYPE_RECIPE);
        if (!recipe) continue;
        try {
          const faces = readRecipe(index, recipe.id);
          if (faces[0]) names.push(faces[0]);
        } catch {
          // Left out; the extrude reports what it lacks.
        }
      } else if (key === TYPE_OPERAND_GROUP && depth < 3) {
        seen.add(ref.id);
        visit(ref.id, depth + 1);
      }
    }
  };
  visit(id, 0);
  return names;
}

export type FeatureRead = {
  features: F3dFeature[];
  order: number[];
  unreadable: Record<string, number>;
  leftOut: Record<string, number>;
};

export function readFeatures(index: DesignIndex, parameters: readonly F3dParameter[]): FeatureRead {
  const owned = parametersByFeature(index, parameters);
  const features: F3dFeature[] = [];
  const unreadable: Record<string, number> = {};

  for (const id of index.idsOf.get(TYPE_SKETCH_FEATURE) ?? []) {
    const sketchId = refsOf(index, id).find((r) => typeKey(index, r.id) === TYPE_SKETCH)?.id;
    if (sketchId !== undefined) features.push({ kind: 'sketch', id, sketchId });
  }
  for (const id of index.idsOf.get(TYPE_EXTRUDE) ?? []) {
    const extrude = readExtrude(index, id, owned.get(id) ?? []);
    if (extrude) features.push(extrude);
    else unreadable['extrude'] = (unreadable['extrude'] ?? 0) + 1;
  }

  for (const id of index.idsOf.get(TYPE_REVOLVE) ?? []) {
    const revolve = readRevolve(index, id, owned.get(id) ?? []);
    if (revolve) features.push(revolve);
    else unreadable['revolve'] = (unreadable['revolve'] ?? 0) + 1;
  }

  features.push(...readTransforms(index, (id) => owned.get(id) ?? []));

  const { primitives, unread } = readPrimitives(index, OPERATIONS, (id) => owned.get(id) ?? []);
  features.push(...primitives);
  if (unread > 0) unreadable['primitive'] = unread;

  for (const id of index.idsOf.get(TYPE_FILLET) ?? []) features.push(readFillet(index, id, owned.get(id) ?? []));
  for (const id of index.idsOf.get(TYPE_CHAMFER) ?? []) features.push(readChamfer(index, id, owned.get(id) ?? []));

  const known = new Set(features.map((f) => f.id));
  const timeline = readRootTimeline(index).filter((id) => known.has(id));
  const onTimeline = new Set(timeline);
  const off = [...known].filter((id) => !onTimeline.has(id)).sort((a, b) => a - b);

  // Each off-timeline feature goes before the first timeline item made after it.
  const order: number[] = [];
  let next = 0;
  for (const id of timeline) {
    while (next < off.length && (off[next] as number) < id) order.push(off[next++] as number);
    order.push(id);
  }
  while (next < off.length) order.push(off[next++] as number);

  const leftOut: Record<string, number> = {};
  for (const [key, what] of Object.entries(LEFT_OUT)) {
    const left = (index.idsOf.get(key) ?? []).filter((id) => !known.has(id)).length;
    if (left > 0) leftOut[what] = (leftOut[what] ?? 0) + left;
  }

  return { features, order, unreadable, leftOut };
}
