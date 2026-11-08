import { isPlainObject } from '../collections';
import { child } from './diagnostics';
import type { Json, Reader } from './reader';
import type { PointerTarget } from './overrides';
import { readFrozen } from './storage';
import { readDef, readValue, type Scope, type ValueIndex } from './values';

/** How one feature type's `inputs` are read (appendix A grows by registering these). */
export interface FeatureTypeSpec {
  /** `typeVersion`s this reader builds. */
  versions: readonly number[];
  readInputs(r: Reader, index: ValueIndex, inputs: Json, path: string, scope: Scope): void;
  /**
   * Pointers under the inputs of lists whose positions have fixed meanings
   * (the first and second of `sides`), so an `input` override may step into
   * them by position (7.3). Every other list is replaced whole.
   */
  positional?: readonly string[];
}

const featureTypes = new Map<string, FeatureTypeSpec>();

export function registerFeatureType(type: string, spec: FeatureTypeSpec): void {
  featureTypes.set(type, spec);
}

export function featureTypeSpec(type: string): FeatureTypeSpec | undefined {
  return featureTypes.get(type);
}

const TYPE_PATTERN = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;

/** Facts about one feature, for the integrity pass. */
export interface FeatureInfo {
  id: string;
  path: string;
  owner: string;
  type: string;
  inputs: Json | null;
  /** Whether its inputs were read with a registered schema (a known type and typeVersion). */
  readBySpec: boolean;
}

export class FeatureIndex {
  readonly features: FeatureInfo[] = [];
}

/**
 * Value objects inside JSON whose schema this reader does not know: any
 * object with a `val_` id and a `def`. Their ids still have to be unique and
 * their names still occupy the scope.
 */
export function discoverValues(r: Reader, values: ValueIndex, value: unknown, path: string, scope: Scope): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => discoverValues(r, values, item, child(path, i), scope));
    return;
  }
  if (!isPlainObject(value)) return;
  if (typeof value.id === 'string' && value.id.startsWith('val_') && 'def' in value) {
    readValue(r, values, value, path, scope);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'extensions') continue;
    discoverValues(r, values, item, child(path, key), scope);
  }
}

/** A feature (7.2). */
export function readFeature(
  r: Reader,
  values: ValueIndex,
  features: FeatureIndex,
  value: unknown,
  path: string,
  owner: string,
): void {
  const o = r.object(value, path, {
    required: ['id', 'type', 'typeVersion', 'name', 'suppressed', 'frozen', 'command', 'inputs'],
    optional: ['children'],
  });
  if (!o) return;
  if (!r.define(o.id, child(path, 'id'), 'feat')) return;
  const id = o.id;
  const scope: Scope = { owner, feature: id };
  r.string(o.name, child(path, 'name'));

  let type = '';
  if (r.string(o.type, child(path, 'type'))) {
    if (TYPE_PATTERN.test(o.type)) type = o.type;
    else r.diagnostics.refuse('bad-value', child(path, 'type'), `"${o.type}" is not a namespaced type`);
  }
  const typeVersionOk = r.integer(o.typeVersion, child(path, 'typeVersion'), 1);

  readValue(r, values, o.suppressed, child(path, 'suppressed'), { ...scope, suppressed: true }, { type: 'boolean' });

  const frozen = r.union(o.frozen, child(path, 'frozen'), ['live', 'frozen']);
  if (frozen?.tag === 'live') r.object(frozen.payload, frozen.path, { required: [] });
  else if (frozen?.tag === 'frozen') readFrozen(r, frozen.payload, frozen.path);

  const command = r.union(o.command, child(path, 'command'), ['alone', 'group']);
  if (command?.tag === 'alone') r.object(command.payload, command.path, { required: [] });
  else if (command?.tag === 'group') {
    const g = r.object(command.payload, command.path, { required: ['id'] });
    if (g) r.label(g.id, child(command.path, 'id'), 'cmd');
  }

  const isComposite = type === 'core.composite';
  if (o.children !== undefined && !isComposite) {
    r.diagnostics.refuse('bad-value', child(path, 'children'), 'only core.composite has children');
  } else if (isComposite) {
    if (o.children === undefined) {
      r.diagnostics.refuse('missing-field', child(path, 'children'), 'a composite has children');
    } else if (r.list(o.children, child(path, 'children'))) {
      o.children.forEach((c, i) => readFeature(r, values, features, c, child(child(path, 'children'), i), owner));
    }
  }

  let inputs: Json | null = null;
  let readBySpec = false;
  const ip = child(path, 'inputs');
  if (isPlainObject(o.inputs)) {
    inputs = o.inputs;
    const spec = type ? featureTypes.get(type) : undefined;
    // A frozen feature replays its stored effect whatever its type (7.2), so nothing pauses for the type.
    const replays = frozen?.tag === 'frozen';
    if (!spec) {
      if (type && !replays)
        r.diagnostics.pause('unknown-variant', child(path, 'type'), `unknown feature type "${type}"`);
      discoverValues(r, values, inputs, ip, scope);
    } else if (typeVersionOk && !spec.versions.includes(o.typeVersion as number)) {
      if (!replays)
        r.diagnostics.pause('unknown-version', child(path, 'typeVersion'), `unknown typeVersion ${o.typeVersion}`);
      discoverValues(r, values, inputs, ip, scope);
    } else {
      spec.readInputs(r, values, inputs, ip, scope);
      readBySpec = true;
    }
  } else {
    r.diagnostics.refuse('wrong-type', ip, 'expected an object');
  }

  features.features.push({ id, path, owner, type, inputs, readBySpec });
}

/** An RFC 6901 pointer: empty, or `/`-separated tokens with only `~0` and `~1` escapes. */
export function isPointer(text: unknown): text is string {
  return typeof text === 'string' && (text === '' || /^(\/([^~/]|~[01])*)+$/.test(text));
}

export function pointerTokens(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Facts about one override, for the integrity pass. */
export interface OverrideInfo {
  path: string;
  /** The configuration (or instance) row holding it. */
  holder: string;
  /** Row index within a configuration, -1 for insertions. */
  row: number;
  kind: 'value' | 'input';
  /** `value` override target id. */
  target?: string | undefined;
  targetKind?: 'parameter' | 'value' | undefined;
  /** `input` override fields. */
  feature?: string | undefined;
  pointer?: string | undefined;
  /** Value ids defined inside `with`. */
  withValues: string[];
  /** An `input` override's replacement. */
  with?: unknown;
  /** Where an `input` override's pointer leads, once followed (7.3). */
  replaced?: PointerTarget | undefined;
  /** A `value` override's new definition. */
  def?: Json | undefined;
}

/** An override (7.3). */
export function readOverride(
  r: Reader,
  values: ValueIndex,
  value: unknown,
  path: string,
  owner: string,
  holder: string,
  row: number,
  allowInput: boolean,
  vary = false,
): OverrideInfo | null {
  const u = r.union(value, path, ['value', 'input']);
  if (!u) return null;
  if (u.tag === 'value') {
    const o = r.object(u.payload, u.path, { required: ['target', 'def'] });
    if (!o) return null;
    const t = r.union(o.target, child(u.path, 'target'), ['parameter', 'value']);
    readDef(r, o.def, child(u.path, 'def'));
    if (!t) return null;
    const tp = r.object(t.payload, t.path, { required: ['id'] });
    if (!tp) return null;
    const kind = t.tag as 'parameter' | 'value';
    if (!allowInput && isPlainObject(o.def)) {
      // Evaluated where it is written: at the holding feature, or in the owner (6.4).
      const feature = holder.startsWith('feat_') ? holder : undefined;
      const target = typeof tp.id === 'string' ? tp.id : undefined;
      values.hostDefs.push({ def: o.def, path: child(u.path, 'def'), scope: { owner, feature }, vary, target });
    }
    if (!r.idShape(tp.id, child(t.path, 'id'), kind === 'parameter' ? 'par' : 'val')) return null;
    return {
      path,
      holder,
      row,
      kind: 'value',
      target: tp.id,
      targetKind: kind,
      withValues: [],
      def: isPlainObject(o.def) ? o.def : undefined,
    };
  }
  if (!allowInput) {
    r.diagnostics.refuse('bad-override', path, 'only configurations may use input overrides');
    return null;
  }
  const o = r.object(u.payload, u.path, { required: ['feature', 'pointer', 'with'] });
  if (!o) return null;
  const feature = r.object(o.feature, child(u.path, 'feature'), { required: ['id'] });
  const featureId =
    feature && r.refer(feature.id, child(child(u.path, 'feature'), 'id'), 'feat') ? feature.id : undefined;
  if (!isPointer(o.pointer)) {
    r.diagnostics.refuse('bad-override', child(u.path, 'pointer'), 'malformed JSON pointer');
    return null;
  }
  const before = values.values.length;
  discoverValues(r, values, o.with, child(u.path, 'with'), { owner, feature: featureId, insideWith: true });
  const withValues = values.values.slice(before).map((v) => v.id);
  return { path, holder, row, kind: 'input', feature: featureId, pointer: o.pointer, withValues, with: o.with };
}

/** Facts about one configuration, for the integrity pass. */
export interface ConfigurationInfo {
  id: string;
  path: string;
  owner: string;
  input?: string | undefined;
  options: unknown[];
  overrides: OverrideInfo[];
}

/** A configuration (7.4). */
export function readConfiguration(
  r: Reader,
  values: ValueIndex,
  value: unknown,
  path: string,
  owner: string,
): ConfigurationInfo | null {
  const o = r.object(value, path, { required: ['id', 'input', 'rows'] });
  if (!o || !r.define(o.id, child(path, 'id'), 'cfg')) return null;
  const info: ConfigurationInfo = { id: o.id, path, owner, options: [], overrides: [] };
  info.input = r.idRef(o.input, child(path, 'input'), 'par') ?? undefined;
  if (!r.list(o.rows, child(path, 'rows'))) return info;
  o.rows.forEach((row, i) => {
    const rp = child(child(path, 'rows'), i);
    const ro = r.object(row, rp, { required: ['option', 'overrides'] });
    if (!ro) return;
    const opt = r.union(ro.option, child(rp, 'option'), ['equals']);
    if (opt) {
      const eq = r.object(opt.payload, opt.path, { required: ['literal'] });
      const lit = eq?.literal;
      if (eq && typeof lit !== 'string' && typeof lit !== 'boolean' && !Number.isInteger(lit)) {
        r.diagnostics.refuse(
          'bad-configuration',
          child(opt.path, 'literal'),
          'a literal is a string, boolean or integer',
        );
      } else if (eq) {
        info.options.push(lit);
      }
    }
    if (r.list(ro.overrides, child(rp, 'overrides'))) {
      ro.overrides.forEach((ov, j) => {
        const parsed = readOverride(r, values, ov, child(child(rp, 'overrides'), j), owner, info.id, i, true);
        if (parsed) info.overrides.push(parsed);
      });
    }
  });
  return info;
}
