import { isPlainObject } from '../collections';
import { child } from './diagnostics';
import { featureTypeSpec, pointerTokens, type FeatureInfo, type OverrideInfo } from './features';
import type { DocumentIndex } from './integrity';
import { Reader, type IdUse, type Json } from './reader';
import { ValueIndex, type ValueInfo } from './values';

/** Where an `input` override's pointer leads in its feature's inputs. */
export type PointerTarget =
  { found: true; value: unknown; steps: (string | number)[] } | { found: false; refusal?: string | undefined };

/** A list whose every item is a row with an id: a table (2.2). A list of value objects is an ordered list. */
function isTable(list: readonly unknown[]): boolean {
  return (
    list.length > 0 &&
    list.every(
      (item) => isPlainObject(item) && typeof item.id === 'string' && !(item.id.startsWith('val_') && 'def' in item),
    )
  );
}

/**
 * Follows an `input` override's pointer (7.3). A step into a table is a row
 * id, never a position; a step by position goes only into a list the feature
 * type gives fixed positions (`positional`, pointers under the inputs).
 * `steps` is the concrete path, with list positions as numbers.
 */
export function resolvePointer(inputs: unknown, pointer: string, positional: readonly string[] = []): PointerTarget {
  const tokens = pointerTokens(pointer);
  let at: unknown = inputs;
  const steps: (string | number)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (Array.isArray(at)) {
      const position = /^(0|[1-9]\d*)$/.test(token) ? Number(token) : undefined;
      if (isTable(at)) {
        const row = at.findIndex((item) => (item as Json).id === token);
        if (row < 0) {
          return position === undefined
            ? { found: false }
            : { found: false, refusal: 'a step into a table is a row id, never a position' };
        }
        steps.push(row);
        at = at[row];
        continue;
      }
      if (position === undefined) return { found: false };
      const prefix = tokens.slice(0, i).reduce((p: string, t) => child(p, t), '');
      if (!positional.includes(prefix)) {
        return {
          found: false,
          refusal: `the positions of ${prefix || 'the inputs'} have no fixed meaning: the whole list is replaced`,
        };
      }
      if (position >= at.length) return { found: false };
      steps.push(position);
      at = at[position];
      continue;
    }
    if (isPlainObject(at) && Object.prototype.hasOwnProperty.call(at, token)) {
      steps.push(token);
      at = at[token];
      continue;
    }
    return { found: false };
  }
  return { found: true, value: at, steps };
}

/** A copy of `inputs` with the value at `steps` replaced. */
function replaced(inputs: Json, steps: readonly (string | number)[], value: unknown): unknown {
  if (steps.length === 0) return structuredClone(value);
  const copy = structuredClone(inputs) as Json;
  let at: unknown = copy;
  steps.slice(0, -1).forEach((step) => {
    at = (at as Record<string | number, unknown>)[step];
  });
  (at as Record<string | number, unknown>)[steps[steps.length - 1] as string | number] = structuredClone(value);
  return copy;
}

const key = (d: { severity: string; code: string; path: string; message: string }) =>
  `${d.severity}\u0000${d.code}\u0000${d.path}\u0000${d.message}`;

/** Reads a feature's inputs with its type's schema, on a reader of its own. */
function readAlone(
  feature: FeatureInfo,
  inputs: unknown,
  decorated: ReadonlySet<string>,
): { r: Reader; values: ValueIndex } {
  const r = new Reader();
  r.decoratedIntegers = decorated;
  const values = new ValueIndex();
  const spec = featureTypeSpec(feature.type);
  const path = child(feature.path, 'inputs');
  if (!isPlainObject(inputs)) r.diagnostics.refuse('wrong-type', path, 'expected an object');
  else spec?.readInputs(r, values, inputs, path, { owner: feature.owner, feature: feature.id });
  return { r, values };
}

/**
 * Configuration `input` overrides (7.3): each pointer is followed by the
 * table and position rules, and each replacement is read with the feature
 * type's schema as it stands in the resulting inputs. What that reading
 * finds under the replaced part is reported at the override's `with`, its
 * must-exist ids, hashes and assets join the document's, and the value
 * objects inside `with` take the types the schema gives them. Runs before
 * the document-wide checks, which then cover these uses too.
 */
export function checkInputOverrides(r: Reader, index: DocumentIndex): void {
  const features = new Map(index.features.features.map((f) => [f.id, f]));
  const withValues = new Map(index.values.values.filter((v) => v.scope.insideWith).map((v) => [v.id, v]));
  for (const config of index.configurations) {
    for (const o of config.overrides) {
      if (o.kind !== 'input' || o.feature === undefined || o.pointer === undefined) continue;
      const feature = features.get(o.feature);
      if (!feature || feature.owner !== config.owner || !feature.inputs) continue;
      const spec = feature.readBySpec ? featureTypeSpec(feature.type) : undefined;
      const target = resolvePointer(feature.inputs, o.pointer, spec?.positional);
      o.replaced = target;
      if (!target.found) {
        if (target.refusal)
          r.diagnostics.refuse('bad-override', child(child(o.path, 'input'), 'pointer'), target.refusal);
        else r.diagnostics.pause('bad-override', o.path, 'the pointer does not resolve');
        continue;
      }
      if (spec) checkReplacement(r, feature, o, target.steps, withValues);
    }
  }
}

function checkReplacement(
  r: Reader,
  feature: FeatureInfo,
  o: OverrideInfo,
  steps: readonly (string | number)[],
  withValues: ReadonlyMap<string, ValueInfo>,
): void {
  const inputs = feature.inputs as Json;
  const prefix = steps.reduce((p: string, s) => child(p, s), child(feature.path, 'inputs'));
  const withPath = child(child(o.path, 'input'), 'with');
  const under = (path: string) => path === prefix || path.startsWith(`${prefix}/`);
  const mapped = (path: string) => withPath + path.slice(prefix.length);
  const decorated = new Set(r.decoratedIntegers);
  for (const p of r.decoratedIntegers) {
    if (p === withPath || p.startsWith(`${withPath}/`)) decorated.add(prefix + p.slice(withPath.length));
  }

  const before = new Set(readAlone(feature, inputs, decorated).r.diagnostics.list.map(key));
  const known = new Set(r.diagnostics.list.map(key));
  const after = readAlone(feature, replaced(inputs, steps, o.with), decorated);
  for (const d of after.r.diagnostics.list) {
    if (before.has(key(d))) continue;
    const at = under(d.path) ? mapped(d.path) : o.path;
    const message = under(d.path) ? d.message : `with this replacement, ${d.path}: ${d.message}`;
    if (known.has(key({ ...d, path: at, message }))) continue;
    r.diagnostics.add(d.severity, d.code, at, message);
  }
  const carry = (from: readonly IdUse[], into: IdUse[]) => {
    for (const use of from) if (under(use.path)) into.push({ ...use, path: mapped(use.path) });
  };
  carry(after.r.mustExist, r.mustExist);
  carry(after.r.usedHashes, r.usedHashes);
  carry(after.r.assetUses, r.assetUses);
  carry(after.r.selectionUses, r.selectionUses);
  for (const use of after.r.inContextUses) {
    if (under(use.path)) {
      r.inContextUses.push({
        ...use,
        path: mapped(use.path),
        ...(use.ladderPath !== undefined ? { ladderPath: mapped(use.ladderPath) } : {}),
      });
    }
  }
  for (const v of after.values.values) {
    const own = withValues.get(v.id);
    if (own && v.target) own.target = v.target;
  }
}
