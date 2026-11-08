/**
 * Component placement. A component's occurrence records say where it sits in
 * its parent, as a row-major 4 × 4 rigid matrix in centimetres. The matrix has
 * no fixed offset across generations, so it is found by its shape: orthonormal
 * rotation, last row 0 0 0 1.
 */

import type { DesignIndex } from './designIndex';
import { primaryRange, refsIn, secondaryRange } from './designIndex';
import type { F3dMatrix } from './types';

const TYPE_COMPONENT = 'E03784ED';
const TYPE_OCCURRENCE = 'CE2913AA';
const TYPE_OCCURRENCE_LIST = '904F885E';
const MATRIX_BYTES = 128;
const GUID_CHARS = 36;
const GUID_BYTES = GUID_CHARS * 2;
const MAX_DEPTH = 64;
/** Enough for any design seen; a cycle in a bad file stops here. */
const MAX_PLACEMENTS = 200_000;

export function rigidMatrixAt(view: DataView, pos: number): F3dMatrix | null {
  const m: number[] = [];
  for (let i = 0; i < 16; i++) {
    const v = view.getFloat64(pos + i * 8, true);
    if (!Number.isFinite(v)) return null;
    m.push(v);
  }
  if (
    Math.abs(m[12] as number) + Math.abs(m[13] as number) + Math.abs(m[14] as number) > 1e-9 ||
    Math.abs((m[15] as number) - 1) > 1e-9
  )
    return null;
  for (let i = 0; i < 3; i++) {
    for (let j = i; j < 3; j++) {
      const dot =
        (m[i] as number) * (m[j] as number) +
        (m[4 + i] as number) * (m[4 + j] as number) +
        (m[8 + i] as number) * (m[8 + j] as number);
      if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-6) return null;
    }
  }
  return m;
}

export function multiply(a: F3dMatrix, b: F3dMatrix): F3dMatrix {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[r * 4 + k] as number) * (b[k * 4 + c] as number);
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

const IDENTITY: F3dMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export type ComponentPlacement = {
  /** Component to model, through its first occurrence. Identity for the root. */
  worldOf(componentId: number): F3dMatrix;
  /** Component to model at each place the design puts it, walking down from the root. */
  placementsOf(): Map<number, F3dMatrix[]>;
  /** Each linked design's places in the model, by the member its role opens. */
  linksOf(): Map<string, F3dMatrix[]>;
  /** How many occurrences link to a design this file does not hold. */
  unresolved: number;
  nameOf(componentId: number): string | null;
  rootId: number | null;
  ids: readonly number[];
};

const bothLevels = (index: DesignIndex, id: number) => {
  const out = [];
  for (const range of [primaryRange(index, id), secondaryRange(index, id)]) {
    if (range) out.push(...refsIn(index, range.start, range.end));
  }
  return out;
};

/** The member an occurrence links to: the role among its wide strings. */
function linkedMember(
  index: DesignIndex,
  view: DataView,
  start: number,
  end: number,
  roles: ReadonlyMap<string, string>,
): string | undefined {
  for (let p = start; p + 4 + GUID_BYTES <= end; p++) {
    if (view.getUint32(p, true) !== GUID_CHARS) continue;
    const text = new TextDecoder('utf-16le').decode(index.bulk.subarray(p + 4, p + 4 + GUID_BYTES)).toLowerCase();
    const member = roles.get(text);
    if (member !== undefined) return member;
  }
  return undefined;
}

export function readComponentPlacement(
  index: DesignIndex,
  roles: ReadonlyMap<string, string> = new Map(),
): ComponentPlacement {
  const view = new DataView(index.bulk.buffer, index.bulk.byteOffset, index.bulk.byteLength);
  const typeKey = (id: number) => index.typeOf.get(id)?.key;

  // Component → the occurrences of its children, through its occurrence list.
  const parentOf = new Map<number, number>();
  for (const component of index.idsOf.get(TYPE_COMPONENT) ?? []) {
    for (const list of bothLevels(index, component).filter((r) => typeKey(r.id) === TYPE_OCCURRENCE_LIST)) {
      const range = primaryRange(index, list.id);
      if (!range) continue;
      for (const child of refsIn(index, range.start, range.end)) {
        if (typeKey(child.id) === TYPE_OCCURRENCE) parentOf.set(child.id, component);
      }
    }
  }

  const firstOccurrence = new Map<number, { parent: number | undefined; matrix: F3dMatrix }>();
  /** Each component's child occurrences. */
  const childrenOf = new Map<number, { component: number; matrix: F3dMatrix }[]>();
  /** Each component's occurrences of linked designs. */
  const linkedIn = new Map<number, { member: string; matrix: F3dMatrix }[]>();
  let unresolved = 0;
  for (const occurrence of index.idsOf.get(TYPE_OCCURRENCE) ?? []) {
    const range = primaryRange(index, occurrence);
    if (!range) continue;
    const refs = refsIn(index, range.start, range.end);
    const component = refs.find((r) => typeKey(r.id) === TYPE_COMPONENT)?.id;
    let matrix: F3dMatrix = IDENTITY;
    for (let p = range.start; p + MATRIX_BYTES <= range.end; p++) {
      const found = rigidMatrixAt(view, p);
      if (found) {
        matrix = found;
        break;
      }
    }
    const parent = parentOf.get(occurrence);
    if (component === undefined) {
      const member = linkedMember(index, view, range.start, range.end, roles);
      if (member === undefined) unresolved++;
      else if (parent !== undefined) linkedIn.set(parent, [...(linkedIn.get(parent) ?? []), { member, matrix }]);
      continue;
    }
    if (parent !== undefined) {
      const list = childrenOf.get(parent);
      if (list) list.push({ component, matrix });
      else childrenOf.set(parent, [{ component, matrix }]);
    }
    if (!firstOccurrence.has(component)) firstOccurrence.set(component, { parent, matrix });
  }

  const worldOf = (componentId: number): F3dMatrix => {
    let world = IDENTITY;
    let current: number | undefined = componentId;
    for (let depth = 0; current !== undefined && depth < MAX_DEPTH; depth++) {
      const occurrence = firstOccurrence.get(current);
      if (!occurrence) break;
      world = multiply(occurrence.matrix, world);
      current = occurrence.parent;
    }
    return world;
  };

  const components = index.idsOf.get(TYPE_COMPONENT) ?? [];
  const children = new Set<number>();
  for (const [component, occurrence] of firstOccurrence) {
    if (occurrence.parent !== undefined) children.add(component);
  }
  const rootId = components.find((c) => !children.has(c)) ?? null;

  const nameOf = (componentId: number): string | null => {
    const range = secondaryRange(index, componentId);
    if (!range) return null;
    // The base level ends in a GUID and the name, both wide strings; a component can have no name.
    const bytes = index.bulk;
    let last: string | null = null;
    for (let p = range.start; p + 6 < range.end; p++) {
      const n = view.getUint32(p, true);
      if (n < 1 || n > 200 || p + 4 + n * 2 > range.end) continue;
      const text = new TextDecoder('utf-16le').decode(bytes.subarray(p + 4, p + 4 + n * 2));
      if ([...text].every((ch) => ch >= ' ' && ch !== '￿')) {
        last = /^[0-9a-f-]{36}$/i.test(text) ? null : text;
        p += 3 + n * 2;
      }
    }
    return last;
  };

  const walkFromRoot = (): { out: Map<number, F3dMatrix[]>; links: Map<string, F3dMatrix[]> } => {
    const out = new Map<number, F3dMatrix[]>();
    const links = new Map<string, F3dMatrix[]>();
    let count = 0;
    const walk = (component: number, world: F3dMatrix, depth: number): void => {
      if (depth > MAX_DEPTH || count >= MAX_PLACEMENTS) return;
      count++;
      const list = out.get(component);
      if (list) list.push(world);
      else out.set(component, [world]);
      for (const child of childrenOf.get(component) ?? [])
        walk(child.component, multiply(world, child.matrix), depth + 1);
      for (const link of linkedIn.get(component) ?? []) {
        const at = multiply(world, link.matrix);
        const list = links.get(link.member);
        if (list) list.push(at);
        else links.set(link.member, [at]);
      }
    };
    if (rootId !== null) walk(rootId, IDENTITY, 0);
    return { out, links };
  };

  return {
    worldOf,
    placementsOf: () => walkFromRoot().out,
    linksOf: () => walkFromRoot().links,
    unresolved,
    nameOf,
    rootId,
    ids: components,
  };
}
