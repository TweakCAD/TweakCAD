import { isPlainObject } from '../collections';
import { parseId } from '../ids';
import { child } from './diagnostics';
import { type ConfigurationInfo, type FeatureIndex, type OverrideInfo } from './features';
import type { Reader } from './reader';
import {
  checkTargetType,
  checkTypes,
  compileExpression,
  ExprError,
  typeOfTarget,
  type ExpressionJson,
  type ExprRef,
  type ExprType,
  type ValueTarget,
} from '../expr';
import { CONFIGURATION_INPUT_TYPES, GRAMMARS, VALUE_TYPES } from './registries';
import type { Json } from './reader';
import { exprRefs, isWellFormedExpr, type ParameterInfo, type ValueIndex, type ValueInfo } from './values';

export interface PartInfo {
  path: string;
  /** Ids of the top-level timeline features, in order. */
  timelineIds: string[];
  rollback?: { id: string; path: string };
  /** Each group's members as listed, with the path of its `members` list. */
  groups: { path: string; members: { id: string; path: string }[] }[];
}

export interface AttributeInfo {
  path: string;
  /** Canonical form of the target reference. */
  target: string;
  properties: string[];
}

export interface DocumentIndex {
  docId: string;
  values: ValueIndex;
  features: FeatureIndex;
  configurations: ConfigurationInfo[];
  attributes: AttributeInfo[];
  parts: Map<string, PartInfo>;
  /** Ids of each assembly's top-level timeline features, in order. */
  assemblyTimelines: Map<string, string[]>;
  folders: { id: string; parent?: string | undefined; path: string }[];
  /** Context id → canonical instance paths it captured. */
  captured: Map<string, Set<string>>;
  /** Selection set id → where it is defined, and the selection sets its members name. */
  selections: Map<string, { path: string; uses: string[] }>;
}

/** Chapter-20 rules that need the whole document. */
export function checkIntegrity(r: Reader, index: DocumentIndex): void {
  checkMustExist(r);
  checkParts(r, index);
  checkFolders(r, index);
  reportCycles(
    r,
    new Map([...index.selections].map(([id, s]) => [id, s.uses])),
    (id) => index.selections.get(id)?.path ?? '',
    'selection sets form a cycle',
  );
  checkNames(r, index);
  checkTableParameters(r, index);
  checkVisibility(r, index);
  checkConfigurations(r, index);
  checkAttributes(r, index);
  checkExpressions(r, index);
}

/** What a parameter's value must evaluate to (6.2). */
function parameterTarget(p: ParameterInfo): ValueTarget | undefined {
  if (!(VALUE_TYPES as readonly string[]).includes(p.type)) return undefined;
  const target: ValueTarget = { type: p.type as ValueTarget['type'] };
  if (p.quantity !== undefined) target.quantity = p.quantity;
  if (p.options !== undefined) target.options = p.options;
  return target;
}

/**
 * Appendix B's text-decidable checks for every expression: grammar, `refs`,
 * functions, and the whole-expression type check with the types of
 * same-document parameters and values. Every value, configuration override,
 * insertion override and `vary` override is checked; a definition must have
 * the type of what it defines, where this document knows it. Text errors
 * refuse the document; the rest pause what uses the value.
 */
function checkExpressions(r: Reader, index: DocumentIndex): void {
  const params = new Map(index.values.parameters.map((p) => [p.id, p]));
  const values = new Map(index.values.values.map((v) => [v.id, v]));
  /** What a value must be: its parameter's type for a parameter's value or bound, else what its schema says. */
  const valueTarget = (id: string): ValueTarget | undefined => {
    const owner = index.values.parameterOf.get(id);
    const p = owner ? params.get(owner) : undefined;
    return p ? parameterTarget(p) : values.get(id)?.target;
  };
  const typeFor = (target: ValueTarget | undefined): ExprType | undefined => {
    if (!target) return undefined;
    try {
      return typeOfTarget(target);
    } catch {
      return undefined;
    }
  };
  const typeOf = (_name: string, ref: ExprRef): ExprType | undefined => {
    if ('parameter' in ref) {
      const p = params.get(ref.parameter.id);
      return typeFor(p ? parameterTarget(p) : undefined);
    }
    if ('value' in ref) return typeFor(valueTarget(ref.value.id));
    return undefined;
  };
  const check = (def: Json, path: string, target: ValueTarget | undefined, inVary = false) => {
    const expr = def.expr;
    // A malformed expression or an unknown grammar is already reported where the def is read.
    if (!isWellFormedExpr(expr) || !GRAMMARS.includes((expr as Json).grammar as number)) return;
    try {
      const compiled = compileExpression(expr as unknown as ExpressionJson);
      const type = checkTypes(compiled, { typeOf, inVary });
      if (target) checkTargetType(type, target);
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      const at = child(path, 'expr');
      if (e.integrity) r.diagnostics.refuse('bad-expression', at, e.message);
      else r.diagnostics.pause('bad-expression', at, e.message);
    }
  };
  for (const v of index.values.values) check(v.def, child(v.path, 'def'), valueTarget(v.id));
  for (const config of index.configurations) {
    for (const o of config.overrides) {
      if (!o.def || o.target === undefined) continue;
      const p = o.targetKind === 'parameter' ? params.get(o.target) : undefined;
      const target = p ? parameterTarget(p) : o.targetKind === 'value' ? valueTarget(o.target) : undefined;
      check(o.def, child(child(o.path, 'value'), 'def'), target);
    }
  }
  // An insertion override's target lives in the inserted document; a vary override's in this one.
  for (const host of index.values.hostDefs) {
    const target = host.vary && host.target !== undefined ? valueTarget(host.target) : undefined;
    check(host.def, host.path, target, host.vary);
  }
}

function checkMustExist(r: Reader): void {
  for (const use of r.mustExist) {
    const def = r.definitions.get(use.id);
    if (!def) {
      r.diagnostics.refuse('dangling', use.path, `${use.id} does not exist`);
    } else if (use.kind !== undefined && parseId(use.id)?.kind !== use.kind) {
      r.diagnostics.refuse('bad-id', use.path, `expected a ${use.kind}_ id`);
    }
  }
}

function checkParts(r: Reader, index: DocumentIndex): void {
  for (const part of index.parts.values()) {
    const timeline = new Set(part.timelineIds);
    if (part.rollback && !timeline.has(part.rollback.id)) {
      r.diagnostics.refuse('dangling', part.rollback.path, 'rollback names a feature outside this timeline');
    }
    const grouped = new Set<string>();
    for (const group of part.groups) {
      if (group.members.length === 0)
        r.diagnostics.refuse('bad-value', group.path, 'a group holds at least one feature');
      const first = part.timelineIds.indexOf(group.members[0]?.id ?? '');
      group.members.forEach((m, k) => {
        if (!timeline.has(m.id)) r.diagnostics.refuse('dangling', m.path, 'a group holds features of its own timeline');
        else if (first >= 0 && part.timelineIds[first + k] !== m.id) {
          r.diagnostics.refuse(
            'bad-value',
            m.path,
            'a group holds features that stand next to each other in the timeline, in timeline order',
          );
        }
        if (grouped.has(m.id)) r.diagnostics.refuse('bad-value', m.path, 'a feature is in at most one group');
        grouped.add(m.id);
      });
    }
  }
}

function checkFolders(r: Reader, index: DocumentIndex): void {
  const parent = new Map(index.folders.map((f) => [f.id, f.parent]));
  for (const folder of index.folders) {
    const seen = new Set<string>([folder.id]);
    let at = folder.parent;
    while (at !== undefined) {
      if (seen.has(at)) {
        r.diagnostics.refuse('cycle', child(folder.path, 'parent'), 'folders form a cycle');
        break;
      }
      seen.add(at);
      at = parent.get(at);
    }
  }
}

/**
 * Parameter names are unique per scope; value names are unique per scope
 * and distinct from every parameter name in scope (the owner's and the
 * document's) (6.2, 6.3).
 */
function checkNames(r: Reader, index: DocumentIndex): void {
  const paramsByOwner = new Map<string, Map<string, ParameterInfo>>();
  for (const p of index.values.parameters) {
    const names = paramsByOwner.get(p.scope.owner) ?? new Map<string, ParameterInfo>();
    paramsByOwner.set(p.scope.owner, names);
    const earlier = names.get(p.name);
    if (earlier) {
      r.diagnostics.refuse(
        'duplicate-name',
        child(p.path, 'name'),
        `parameter name "${p.name}" is also used at ${earlier.path}`,
      );
    } else {
      names.set(p.name, p);
    }
  }
  const docParams = paramsByOwner.get(index.docId) ?? new Map<string, ParameterInfo>();
  const valueNames = new Map<string, Map<string, ValueInfo>>();
  for (const v of index.values.values) {
    if (v.name === undefined) continue;
    const owner = v.scope.owner;
    const names = valueNames.get(owner) ?? new Map<string, ValueInfo>();
    valueNames.set(owner, names);
    const earlier = names.get(v.name);
    if (earlier) {
      r.diagnostics.refuse(
        'duplicate-name',
        child(v.path, 'name'),
        `value name "${v.name}" is also used at ${earlier.path}`,
      );
      continue;
    }
    names.set(v.name, v);
    if (paramsByOwner.get(owner)?.has(v.name) || docParams.has(v.name)) {
      r.diagnostics.refuse(
        'duplicate-name',
        child(v.path, 'name'),
        `value name "${v.name}" is a parameter name in scope`,
      );
    }
  }
}

/**
 * Table parameters use only table parameters of their own or the document's
 * scope and lookup tables, are never measures, and form no cycle (6.4).
 * Library refs appear only in values of type library.
 */
function checkTableParameters(r: Reader, index: DocumentIndex): void {
  const params = new Map(index.values.parameters.map((p) => [p.id, p]));
  const deps = new Map<string, string[]>();
  for (const p of index.values.parameters) {
    const def = p.value?.def;
    if (!isPlainObject(def)) continue;
    const vp = child(p.path, 'value');
    if ('measure' in def) {
      r.diagnostics.refuse('bad-value', child(vp, 'def'), 'a table parameter is never a measure');
      continue;
    }
    const refs = exprRefs(def);
    if (refs.values.length > 0 || refs.published > 0) {
      r.diagnostics.refuse(
        'bad-value',
        child(vp, 'def'),
        'a table parameter uses only table parameters and lookup tables',
      );
    }
    if (refs.library.length > 0 && p.type !== 'library') {
      r.diagnostics.refuse('bad-value', child(vp, 'def'), 'library refs appear only in values of type library');
    }
    for (const id of refs.parameters) {
      const target = params.get(id);
      if (target && target.scope.owner !== p.scope.owner && target.scope.owner !== index.docId) {
        r.diagnostics.refuse('bad-value', child(vp, 'def'), `${id} is not in scope`);
      }
    }
    deps.set(p.id, refs.parameters);
  }
  reportCycles(r, deps, (id) => params.get(id)?.path ?? '', 'table parameters form a cycle');
}

/** Where a definition is evaluated, for visibility (6.4). */
interface Site {
  owner: string;
  feature?: string | undefined;
  /** A feature's `suppressed` flag (7.2). */
  suppressed?: boolean | undefined;
  /** A table parameter's value or range bound. */
  table?: boolean | undefined;
}

/**
 * Visibility of values (6.3, 6.4, 7.2). A definition sees the parameters of
 * its owner and of the document, and values of its own owner only. A
 * feature's value sees its own feature's values and earlier features', never
 * its own feature's measures; a `suppressed` flag sees none of its own
 * feature's values. A configuration override is judged in its target's
 * scope, an insertion or `vary` override where it is written. No cycle among
 * one feature's values.
 */
function checkVisibility(r: Reader, index: DocumentIndex): void {
  const params = new Map(index.values.parameters.map((p) => [p.id, p]));
  const values = new Map(index.values.values.map((v) => [v.id, v]));
  const order = new Map<string, number>();
  for (const part of index.parts.values()) part.timelineIds.forEach((id, i) => order.set(id, i));
  for (const ids of index.assemblyTimelines.values()) ids.forEach((id, i) => order.set(id, i));

  /** The values of `site.feature` the definition uses. */
  const judge = (def: Json, path: string, site: Site): string[] => {
    const refs = exprRefs(def);
    const same: string[] = [];
    if (site.table) {
      if ('measure' in def) r.diagnostics.refuse('bad-value', path, 'a table parameter is never a measure');
      if (refs.values.length > 0 || refs.published > 0) {
        r.diagnostics.refuse('bad-value', path, 'a table parameter uses only table parameters and lookup tables');
      }
    }
    for (const id of refs.parameters) {
      const p = params.get(id);
      if (p && p.scope.owner !== site.owner && p.scope.owner !== index.docId) {
        r.diagnostics.refuse('bad-value', path, `${id} is not in scope`);
      }
    }
    if (site.table) return same;
    for (const id of refs.values) {
      const target = values.get(id);
      if (!target) continue;
      if (target.scope.owner !== site.owner) {
        r.diagnostics.refuse('bad-value', path, `${id} is not in scope`);
      } else if (site.feature === undefined) {
        continue;
      } else if (target.scope.feature === site.feature) {
        same.push(id);
        if (site.suppressed) {
          r.diagnostics.refuse(
            'bad-value',
            path,
            `${id} belongs to this feature, which its suppressed flag never uses`,
          );
        } else if ('measure' in target.def) {
          r.diagnostics.refuse('bad-value', path, `${id} is this feature's own measure`);
        }
      } else if (target.scope.feature !== undefined) {
        const here = order.get(site.feature);
        const there = order.get(target.scope.feature);
        if (here !== undefined && there !== undefined && there >= here) {
          r.diagnostics.refuse('bad-value', path, `${id} belongs to a later feature`);
        }
      }
    }
    return same;
  };

  /** Where a value is evaluated; a parameter's own value is judged with its table (checkTableParameters). */
  const siteOf = (id: string): Site | undefined => {
    const owner = index.values.parameterOf.get(id);
    const p = owner ? params.get(owner) : undefined;
    if (p) return { owner: p.scope.owner, table: true };
    const v = values.get(id);
    return v && { owner: v.scope.owner, feature: v.scope.feature, suppressed: v.scope.suppressed };
  };

  const deps = new Map<string, string[]>();
  for (const v of index.values.values) {
    const owner = index.values.parameterOf.get(v.id);
    if (owner !== undefined && params.get(owner)?.value?.id === v.id) continue;
    const site = siteOf(v.id) as Site;
    const same = judge(v.def, child(v.path, 'def'), site);
    if (site.feature !== undefined) deps.set(v.id, same);
  }
  reportCycles(r, deps, (id) => values.get(id)?.path ?? '', "a feature's values form a cycle");

  for (const config of index.configurations) {
    for (const o of config.overrides) {
      if (o.kind !== 'value' || !o.def || o.target === undefined) continue;
      const p = o.targetKind === 'parameter' ? params.get(o.target) : undefined;
      const site = p ? { owner: p.scope.owner, table: true } : o.targetKind === 'value' ? siteOf(o.target) : undefined;
      if (site) judge(o.def, child(child(o.path, 'value'), 'def'), site);
    }
  }
  for (const host of index.values.hostDefs) judge(host.def, host.path, host.scope);
}

function reportCycles(r: Reader, deps: Map<string, string[]>, pathOf: (id: string) => string, message: string): void {
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 'done') return false;
    if (s === 'open') return true;
    state.set(id, 'open');
    for (const next of deps.get(id) ?? []) {
      if (deps.has(next) && visit(next)) {
        state.set(id, 'done');
        r.diagnostics.refuse('cycle', pathOf(id), message);
        return false;
      }
    }
    state.set(id, 'done');
    return false;
  };
  for (const id of deps.keys()) visit(id);
}

function valueIdsUnder(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => valueIdsUnder(v, out));
  else if (isPlainObject(value)) {
    if (typeof value.id === 'string' && value.id.startsWith('val_') && 'def' in value) out.push(value.id);
    for (const [k, v] of Object.entries(value)) if (k !== 'extensions') valueIdsUnder(v, out);
  }
  return out;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Configuration rules (6.4, 7.3, 7.4). */
function checkConfigurations(r: Reader, index: DocumentIndex): void {
  const params = new Map(index.values.parameters.map((p) => [p.id, p]));
  const values = new Map(index.values.values.map((v) => [v.id, v]));
  const features = new Map(index.features.features.map((f) => [f.id, f]));
  const parameterValueIds = new Set(
    index.values.parameters.map((p) => p.value?.id).filter((id): id is string => typeof id === 'string'),
  );

  const all: OverrideInfo[] = index.configurations.flatMap((c) => c.overrides);
  const overriddenParams = new Set(all.filter((o) => o.targetKind === 'parameter').map((o) => o.target));
  const targetedValues = new Set(all.filter((o) => o.targetKind === 'value').map((o) => o.target));
  const withValueIds = new Set(all.flatMap((o) => o.withValues));
  const inputParams = new Set(index.configurations.map((c) => c.input).filter((id) => id !== undefined));

  for (const config of index.configurations) {
    const input = config.input ? params.get(config.input) : undefined;
    if (input) {
      // An input of a type this reader does not know pauses the configuration, as the type pauses its parameter (18, 19).
      const knownType = (VALUE_TYPES as readonly string[]).includes(input.type);
      if (!knownType) {
        r.diagnostics.pause(
          'unknown-variant',
          child(config.path, 'input'),
          `the input has unknown type "${input.type}"`,
        );
      } else if (!CONFIGURATION_INPUT_TYPES.includes(input.type)) {
        r.diagnostics.refuse(
          'bad-configuration',
          child(config.path, 'input'),
          'a configuration input is a choice, boolean or integer',
        );
      }
      if (overriddenParams.has(input.id)) {
        r.diagnostics.refuse(
          'bad-configuration',
          child(config.path, 'input'),
          'no configuration overrides an input parameter',
        );
      }
      // The input depends only on table parameters no configuration overrides.
      const seen = new Set<string>();
      const stack = [input.id];
      while (stack.length > 0) {
        const id = stack.pop() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        const def = params.get(id)?.value?.def;
        if (!isPlainObject(def)) continue;
        for (const dep of exprRefs(def).parameters) {
          if (overriddenParams.has(dep)) {
            r.diagnostics.refuse(
              'bad-configuration',
              child(config.path, 'input'),
              `the input depends on overridden parameter ${dep}`,
            );
          }
          stack.push(dep);
        }
      }
      // Options match the input's type; no two rows match one value.
      const seenOptions = new Set<string>();
      config.options.forEach((opt, i) => {
        const op = child(child(child(config.path, 'rows'), i), 'option');
        const okType =
          (input.type === 'choice' && typeof opt === 'string') ||
          (input.type === 'boolean' && typeof opt === 'boolean') ||
          (input.type === 'integer' && typeof opt === 'number');
        if (!okType && knownType)
          r.diagnostics.refuse('bad-configuration', op, `the option does not match a ${input.type} input`);
        const key = JSON.stringify(opt);
        if (seenOptions.has(key)) r.diagnostics.refuse('bad-configuration', op, 'two rows match one input value');
        seenOptions.add(key);
      });
    }

    for (const o of config.overrides) {
      if (o.kind === 'value' && o.target) {
        const owner =
          o.targetKind === 'parameter' ? params.get(o.target)?.scope.owner : values.get(o.target)?.scope.owner;
        if (owner === undefined) {
          r.diagnostics.refuse('dangling', o.path, `${o.target} does not exist`);
          continue;
        }
        if (owner !== config.owner) {
          r.diagnostics.refuse('bad-override', o.path, 'a configuration overrides only what its owner defines');
        }
        if (o.targetKind === 'parameter' && inputParams.has(o.target)) {
          r.diagnostics.refuse('bad-override', o.path, 'no configuration overrides an input parameter');
        }
        if (o.targetKind === 'value' && parameterValueIds.has(o.target)) {
          r.diagnostics.refuse('bad-override', o.path, "a parameter's value is targeted as the parameter");
        }
        if (withValueIds.has(o.target)) {
          r.diagnostics.refuse('bad-override', o.path, "the target is defined inside another override's with");
        }
      }
      if (o.kind === 'input' && o.feature && o.pointer !== undefined) {
        const feature = features.get(o.feature);
        if (!feature) continue;
        if (feature.owner !== config.owner) {
          r.diagnostics.refuse('bad-override', o.path, 'a configuration overrides only its own features');
          continue;
        }
        // The pointer was followed, and its failures reported, by checkInputOverrides.
        const at = o.replaced;
        if (!at?.found) continue;
        for (const id of valueIdsUnder(at.value)) {
          if (values.get(id)?.public) {
            r.diagnostics.refuse('bad-override', o.path, `the override replaces public value ${id}`);
          } else if (targetedValues.has(id)) {
            r.diagnostics.refuse('bad-override', o.path, `the override replaces ${id}, which another override targets`);
          }
        }
      }
    }

    // Overlapping input overrides: within one row, and against other configurations.
    const inputs = config.overrides.filter((o) => o.kind === 'input');
    inputs.forEach((a, i) => {
      for (const b of inputs.slice(i + 1)) {
        if (a.row === b.row && a.feature === b.feature && overlaps(a.pointer ?? '', b.pointer ?? '')) {
          r.diagnostics.refuse('bad-override', b.path, 'two input overrides in one row overlap');
        }
      }
    });
  }

  const inputOverrides = all.filter((o) => o.kind === 'input');
  inputOverrides.forEach((a, i) => {
    for (const b of inputOverrides.slice(i + 1)) {
      if (a.holder !== b.holder && a.feature === b.feature && overlaps(a.pointer ?? '', b.pointer ?? '')) {
        r.diagnostics.refuse('bad-override', b.path, 'input overrides of two configurations overlap');
      }
    }
  });
}

/** Two attributes never set the same property on the same target (16.1). */
function checkAttributes(r: Reader, index: DocumentIndex): void {
  const seen = new Map<string, string>();
  for (const a of index.attributes) {
    for (const prop of a.properties) {
      const key = `${a.target}\u0000${prop}`;
      const earlier = seen.get(key);
      if (earlier) {
        r.diagnostics.refuse(
          'bad-value',
          child(child(a.path, 'properties'), prop),
          `"${prop}" is also set on this target at ${earlier}`,
        );
      } else {
        seen.set(key, a.path);
      }
    }
  }
}
