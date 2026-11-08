/**
 * Which component a feature works in. A component lists its bodies, and a body
 * link ties a body to the feature that made it, so a feature belongs where its
 * bodies are: those it made, or else those its operands name. The timeline does
 * not say, since one root timeline can hold every component's features.
 */
import type { DesignIndex } from './designIndex';
import { primaryRange, readPrologue, refsIn, secondaryRange } from './designIndex';
import { ByteReader } from './byteReader';

const TYPE_COMPONENT = 'E03784ED';
const TYPE_BODY = 'D3937028';
const TYPE_BODY_LIST = 'CD57BC48';
const TYPE_BODY_LINK = 'D26351F0';
const TYPE_STORED_BODY = 'D7015B81';
const TYPE_INPUT = '2CA5A1CD';
const TYPE_BODY_OPERAND = '9716F783';
const TYPE_OP_TABLE = '5D89B935';
const TYPE_INSTANCE = 'AD719C1A';
const REPEATERS = ['AE12AD3F', '11F1A5CE', 'D1728651'];

export type FeatureBodies = {
  /** The component of a feature's bodies, if it names any. */
  componentOfFeature(id: number): number | null;
  /** The record behind an operation id. */
  recordOfOp(op: number): number | undefined;
  /** Bodies no feature says it made, by component. One stored record can hold many, and a design with no history has no such records. */
  storedBodies(root: number | null): Map<number | null, number>;
};

export function readFeatureBodies(index: DesignIndex): FeatureBodies {
  const typeKey = (id: number) => index.typeOf.get(id)?.key;
  const refsOf = (id: number) => {
    const out: number[] = [];
    for (const range of [primaryRange(index, id), secondaryRange(index, id)]) {
      if (range) out.push(...refsIn(index, range.start, range.end).map((r) => r.id));
    }
    return out;
  };

  const componentOfBody = new Map<number, number>();
  for (const list of index.idsOf.get(TYPE_BODY_LIST) ?? []) {
    const refs = refsOf(list);
    const component = refs.find((r) => typeKey(r) === TYPE_COMPONENT);
    if (component !== undefined) for (const r of refs) if (typeKey(r) === TYPE_BODY) componentOfBody.set(r, component);
  }
  for (const component of index.idsOf.get(TYPE_COMPONENT) ?? []) {
    for (const r of refsOf(component)) {
      if (typeKey(r) !== TYPE_BODY_LIST) continue;
      for (const body of refsOf(r))
        if (typeKey(body) === TYPE_BODY && !componentOfBody.has(body)) componentOfBody.set(body, component);
    }
  }

  const bodyOfLink = (link: number): number | undefined => refsOf(link).find((r) => typeKey(r) === TYPE_BODY);

  // A link names the feature that made its body.
  const made = new Map<number, number>();
  for (const link of index.idsOf.get(TYPE_BODY_LINK) ?? []) {
    const refs = refsOf(link);
    const body = refs.find((r) => typeKey(r) === TYPE_BODY);
    const component = body === undefined ? undefined : componentOfBody.get(body);
    if (component === undefined) continue;
    for (const r of refs) if (typeKey(r) !== TYPE_BODY && !made.has(r)) made.set(r, component);
  }

  const componentOfFeature = (id: number): number | null => {
    const own = made.get(id);
    if (own !== undefined) return own;
    // A join or cut makes no body of its own: its operands name the bodies it changes.
    for (const input of refsOf(id)) {
      if (typeKey(input) !== TYPE_INPUT) continue;
      for (const operand of refsOf(input)) {
        if (typeKey(operand) !== TYPE_BODY_OPERAND) continue;
        for (const link of refsOf(operand)) {
          if (typeKey(link) !== TYPE_BODY_LINK) continue;
          const body = bodyOfLink(link);
          const component = body === undefined ? undefined : componentOfBody.get(body);
          if (component !== undefined) return component;
        }
      }
    }
    return null;
  };
  // Operation tables, in their two layouts: rows of op and record, or a record and its ops.
  const ops = new Map<number, number>();
  for (const id of index.idsOf.get(TYPE_OP_TABLE) ?? []) {
    const range = primaryRange(index, id);
    if (!range) continue;
    const version = index.typeOf.get(id)?.version;
    const r = new ByteReader(index.bulk, readPrologue(index, range).next, range.end);
    const rows = r.u32();
    for (let i = 0; i < rows && r.remaining >= 12; i++) {
      if (version === 0) {
        const op = r.u64();
        ops.set(op, r.u64());
      } else {
        const record = r.u64();
        const count = r.u32();
        for (let k = 0; k < count && r.remaining >= 8; k++) ops.set(r.u64(), record);
      }
    }
  }

  // A copy's operation leads to its instance record, and through its set to the feature that repeats.
  const repeaterOfSet = new Map<number, number>();
  for (const type of REPEATERS) {
    for (const id of index.idsOf.get(type) ?? [])
      for (const r of refsOf(id)) if (!repeaterOfSet.has(r)) repeaterOfSet.set(r, id);
  }
  const recordOfOp = (op: number): number | undefined => {
    const record = ops.get(Math.abs(op));
    if (record === undefined || typeKey(record) !== TYPE_INSTANCE) return record;
    for (const set of refsOf(record)) {
      const repeater = repeaterOfSet.get(set);
      if (repeater !== undefined) return repeater;
    }
    return record;
  };

  const storedBodies = (root: number | null): Map<number | null, number> => {
    const made = new Set<number>();
    for (const link of index.idsOf.get(TYPE_BODY_LINK) ?? []) {
      const refs = refsOf(link);
      if (refs.some((r) => typeKey(r) === TYPE_STORED_BODY)) continue;
      for (const r of refs) if (typeKey(r) === TYPE_BODY) made.add(r);
    }
    const out = new Map<number | null, number>();
    let total = 0;
    for (const body of index.idsOf.get(TYPE_BODY) ?? []) {
      if (made.has(body)) continue;
      const component = componentOfBody.get(body) ?? root;
      out.set(component, (out.get(component) ?? 0) + 1);
      total++;
    }
    const records = index.idsOf.get(TYPE_STORED_BODY)?.length ?? 0;
    if (records > total) out.set(root, (out.get(root) ?? 0) + records - total);
    return out;
  };

  return { componentOfFeature, recordOfOp, storedBodies };
}
