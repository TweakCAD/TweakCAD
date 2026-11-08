import { canonicalize, isPlainObject, makeSet } from '@tweakcad/format';
import { CommandError } from '../errors';
import { arrayStep, parentAt, parsePointer, valueAt } from '../pointer';
import { arrayAt, findOwner, findRow, getAt, kindOf, objectAt, ownerOf, type Doc, type Json, type Path } from '../rows';
import {
  featureAt,
  insertRow,
  literalDef,
  mergeAssets,
  mergeNames,
  nameOf,
  removeRow,
  requireRow,
  rowIdsIn,
  rowName,
  valueIdsIn,
  type Handlers,
  type RunContext,
} from './common';

/** The array a feature goes into: a part's or assembly's timeline, or a composite's children. */
function containerTable(doc: Doc, container: string): Path {
  const kind = kindOf(container);
  if (kind === 'part' || kind === 'asm') return [...findOwner(doc, container, ['part', 'asm']), 'timeline'];
  if (kind === 'feat') {
    const at = featureAt(doc, container);
    if (at.row.type !== 'core.composite' || !Array.isArray(at.row.children)) {
      throw new CommandError('not-allowed', `${container} is not a composite feature`);
    }
    return [...at.path, 'children'];
  }
  throw new CommandError('not-found', `no part, assembly or composite ${container}`);
}

function featureLabel(doc: Doc, id: string): string {
  return rowName(doc, id, 'feature');
}

/**
 * After features leave a timeline: a rollback naming one of them moves to
 * the next feature that stays (or the end), and groups drop them; a group
 * left empty goes.
 */
function forgetInTimeline(ctx: RunContext, ownerPath: Path, gone: ReadonlySet<string>): void {
  const owner = objectAt(ctx.draft, ownerPath);
  const before = objectAt(ctx.doc, ownerPath);
  const rollback = before.rollback;
  if (isPlainObject(rollback) && isPlainObject(rollback.before) && gone.has(rollback.before.id as string)) {
    const timeline = before.timeline as Json[];
    const from = timeline.findIndex((f) => f.id === (rollback.before as Json).id);
    const next = timeline.slice(from + 1).find((f) => !gone.has(f.id as string));
    owner.rollback = next ? { before: { id: next.id } } : { end: {} };
  }
  if (Array.isArray(owner.groups)) {
    for (const group of owner.groups as Json[]) {
      if (Array.isArray(group.members) && group.members.some((m) => gone.has(m as string))) {
        group.members = (group.members as string[]).filter((m) => !gone.has(m));
      }
    }
    owner.groups = (owner.groups as Json[]).filter((g) => !Array.isArray(g.members) || g.members.length > 0);
  }
}

/**
 * Keeps groups contiguous (7.1) after a feature lands in a part's timeline:
 * between two members of one group it joins that group; otherwise it stays
 * in its own group only while it stands next to another member, and leaves
 * it when not. Members are kept in timeline order.
 */
function placeInGroups(ctx: RunContext, ownerPath: Path, feature: string): void {
  const owner = objectAt(ctx.draft, ownerPath);
  if (!Array.isArray(owner.groups) || owner.groups.length === 0 || !Array.isArray(owner.timeline)) return;
  const order = (owner.timeline as Json[]).map((f) => f.id as string);
  const at = order.indexOf(feature);
  if (at < 0) return;
  const groups = owner.groups as Json[];
  const groupOf = (id: string | undefined) =>
    id === undefined ? undefined : groups.find((g) => (g.members as string[]).includes(id));
  const [before, after, own] = [groupOf(order[at - 1]), groupOf(order[at + 1]), groupOf(feature)];
  const home =
    before && before === after
      ? before
      : own && (before === own || after === own || (own.members as string[]).length === 1)
        ? own
        : undefined;
  if (own && own !== home) own.members = (own.members as string[]).filter((m) => m !== feature);
  if (home && home !== own) home.members = [...(home.members as string[]), feature];
  if (home) home.members = [...(home.members as string[])].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  owner.groups = groups.filter((g) => (g.members as string[]).length > 0);
}

/** Configuration overrides of the owner that target removed features or their values go with them. */
function forgetOverrides(
  ctx: RunContext,
  ownerPath: Path,
  features: ReadonlySet<string>,
  values: ReadonlySet<string>,
): void {
  const owner = objectAt(ctx.draft, ownerPath);
  if (!Array.isArray(owner.configurations)) return;
  const targets = (o: unknown): boolean => {
    if (!isPlainObject(o)) return false;
    if (isPlainObject(o.input) && isPlainObject(o.input.feature)) return features.has(o.input.feature.id as string);
    if (isPlainObject(o.value) && isPlainObject(o.value.target) && isPlainObject(o.value.target.value)) {
      return values.has(o.value.target.value.id as string);
    }
    return false;
  };
  for (const config of owner.configurations as Json[]) {
    for (const row of (config.rows as Json[] | undefined) ?? []) {
      const overrides = row.overrides as unknown[];
      if (Array.isArray(overrides) && overrides.some(targets)) row.overrides = overrides.filter((o) => !targets(o));
    }
  }
}

/** Sets the value at a pointer under `root`; `-` appends to a list, and `undefined` removes. */
function setAt(root: Json, tokens: readonly string[], pointer: string, value: unknown): void {
  const parent = parentAt(root, tokens, pointer);
  const last = tokens[tokens.length - 1] as string;
  if (Array.isArray(parent)) {
    const index = arrayStep(parent, last, pointer, value !== undefined);
    if (value === undefined) parent.splice(index, 1);
    else if (index < 0) parent.push(value);
    else parent[index] = value;
    return;
  }
  if (!isPlainObject(parent)) throw new CommandError('not-found', `${pointer} does not resolve`);
  if (value === undefined) {
    if (!(last in parent)) throw new CommandError('not-found', `${pointer} does not resolve`);
    Reflect.deleteProperty(parent, last);
  } else {
    parent[last] = value;
  }
}

export const featureHandlers: Handlers<
  | 'addFeature'
  | 'removeFeature'
  | 'moveFeature'
  | 'renameFeature'
  | 'setSuppressed'
  | 'setFrozen'
  | 'setRollback'
  | 'replaceInput'
  | 'writeReference'
  | 'addGroup'
  | 'editGroup'
  | 'removeGroup'
> = {
  addFeature: {
    label: (c) => `Add ${nameOf(isPlainObject(c.feature) ? c.feature : undefined, 'feature')}`,
    run(c, ctx) {
      const feature = requireRow(c.feature, 'feat', 'feature');
      mergeNames(ctx, c.names);
      mergeAssets(ctx, c.assets);
      const table = containerTable(ctx.doc, c.container);
      insertRow(ctx, table, feature, c.before, 'feature');
      const owner = ownerOf(ctx.doc, table).path;
      if (table.length === owner.length + 1) placeInGroups(ctx, owner, feature.id as string);
    },
  },

  removeFeature: {
    label: (c, doc) => `Remove ${featureLabel(doc, c.feature)}`,
    run(c, ctx) {
      const at = featureAt(ctx.doc, c.feature);
      const owner = ownerOf(ctx.doc, at.path);
      const features = rowIdsIn(at.row);
      features.add(c.feature);
      forgetInTimeline(ctx, owner.path, features);
      forgetOverrides(ctx, owner.path, features, new Set(valueIdsIn(at.row)));
      removeRow(ctx, at);
    },
  },

  moveFeature: {
    label: (c, doc) => `Move ${featureLabel(doc, c.feature)}`,
    run(c, ctx) {
      const at = featureAt(ctx.doc, c.feature);
      const table = containerTable(ctx.doc, c.container);
      if (ownerOf(ctx.doc, table).id !== ownerOf(ctx.doc, at.path).id) {
        throw new CommandError('not-allowed', 'a feature moves only within its own part or assembly');
      }
      if (c.feature === c.container || rowIdsIn(at.row).has(c.container)) {
        throw new CommandError('not-allowed', 'a composite cannot move into itself');
      }
      if (c.before === c.feature) return;
      // Both arrays are taken before the splice, which can shift the destination's path.
      const source = arrayAt(ctx.draft, at.table);
      const target = arrayAt(ctx.draft, table);
      const [row] = source.splice(at.index, 1);
      const index =
        c.before === undefined ? target.length : target.findIndex((f) => isPlainObject(f) && f.id === c.before);
      if (index < 0) throw new CommandError('not-found', `no feature ${c.before} to insert before`);
      target.splice(index, 0, row);
      // Leaving the top-level timeline for a composite takes the feature out of its group and the rollback.
      const ownerPath = ownerOf(ctx.doc, at.path).path;
      if (table.length > ownerPath.length + 1) forgetInTimeline(ctx, ownerPath, new Set([c.feature]));
      else placeInGroups(ctx, ownerPath, c.feature);
    },
  },

  renameFeature: {
    label: (c, doc) => `Rename ${featureLabel(doc, c.feature)}`,
    run(c, ctx) {
      objectAt(ctx.draft, featureAt(ctx.doc, c.feature).path).name = c.name;
    },
  },

  setSuppressed: {
    label: (c, doc) => `${c.suppressed ? 'Suppress' : 'Unsuppress'} ${featureLabel(doc, c.feature)}`,
    run(c, ctx) {
      const path = featureAt(ctx.doc, c.feature).path;
      const suppressed = getAt(ctx.draft, [...path, 'suppressed']);
      if (!isPlainObject(suppressed)) throw new CommandError('invalid', `${c.feature} has no suppressed value`);
      const def = getAt(ctx.doc, [...path, 'suppressed', 'def']);
      const text = String(c.suppressed);
      const current = isPlainObject(def) && isPlainObject(def.expr) ? def.expr : undefined;
      if (current && current.text === text && isPlainObject(current.refs) && Object.keys(current.refs).length === 0)
        return;
      suppressed.def = literalDef(text);
    },
  },

  setFrozen: {
    label: (c, doc) => `${c.frozen === undefined ? 'Unfreeze' : 'Freeze'} ${featureLabel(doc, c.feature)}`,
    run(c, ctx) {
      const path = featureAt(ctx.doc, c.feature).path;
      const row = objectAt(ctx.doc, path);
      const type = String(row.type);
      if (c.frozen === undefined) {
        if (isPlainObject(row.frozen) && 'live' in row.frozen) return;
        objectAt(ctx.draft, path).frozen = { live: {} };
        return;
      }
      if (type === 'core.sketch' || type === 'core.measure' || type.startsWith('core.asm.')) {
        throw new CommandError('not-allowed', `a ${type} feature cannot be frozen`);
      }
      if (!isPlainObject(c.frozen) || Object.keys(c.frozen).length !== 1 || !isPlainObject(c.frozen.frozen)) {
        throw new CommandError('bad-argument', 'frozen is {"frozen": {effects, construction, values}}');
      }
      mergeNames(ctx, c.names);
      mergeAssets(ctx, c.assets);
      objectAt(ctx.draft, path).frozen = c.frozen;
    },
  },

  setRollback: {
    label: (c) => (c.before === undefined ? 'Roll forward to the end' : 'Roll back'),
    run(c, ctx) {
      const part = objectAt(ctx.draft, findOwner(ctx.doc, c.part, ['part']));
      part.rollback = c.before === undefined ? { end: {} } : { before: { id: c.before } };
    },
  },

  replaceInput: {
    label: (c, doc) => `Edit ${featureLabel(doc, c.feature)}`,
    run(c, ctx) {
      const path = featureAt(ctx.doc, c.feature).path;
      const tokens = parsePointer(c.pointer);
      const feature = objectAt(ctx.draft, path);
      mergeNames(ctx, c.names);
      if (tokens.length === 0) {
        if (!isPlainObject(c.with)) throw new CommandError('bad-argument', "a feature's inputs are an object");
        // Inputs written back unchanged (OK on an edit that changed nothing) change nothing, so they make no undo step.
        if (sameJson(feature.inputs, c.with)) return;
        feature.inputs = c.with;
        return;
      }
      setAt(objectAt(feature, ['inputs']), tokens, c.pointer, c.with);
    },
  },

  writeReference: {
    label: (c, doc) => `Pick for ${featureLabel(doc, c.feature)}`,
    run(c, ctx) {
      if (!isPlainObject(c.reference) || Object.keys(c.reference).length !== 1) {
        throw new CommandError('bad-argument', 'a reference is a tagged union with one key');
      }
      const path = featureAt(ctx.doc, c.feature).path;
      const tokens = parsePointer(c.pointer);
      if (tokens.length === 0)
        throw new CommandError('bad-argument', "a reference does not replace a feature's inputs");
      mergeNames(ctx, c.names);
      const inputs = objectAt(ctx.doc, [...path, 'inputs']);
      let current: unknown;
      try {
        current = valueAt(inputs, tokens, c.pointer);
      } catch {
        current = undefined;
      }
      const target = objectAt(ctx.draft, [...path, 'inputs']);
      if (isPlainObject(current) && Object.keys(current).length === 1 && Array.isArray(current.set)) {
        // A set of references (a profile set, a target set): the record joins it in canonical order.
        let members;
        try {
          members = makeSet([...current.set, c.reference]);
        } catch {
          throw new CommandError('not-allowed', 'the reference is already in the set');
        }
        setAt(target, tokens, c.pointer, members);
        return;
      }
      setAt(target, tokens, c.pointer, c.reference);
    },
  },

  addGroup: {
    label: (c) => {
      // "Group Base", but "Add Group 1" rather than "Group Group 1" for a name that says it is a group.
      const name = nameOf(isPlainObject(c.group) ? c.group : undefined, 'features');
      return /^group\b/i.test(name) ? `Add ${name}` : `Group ${name}`;
    },
    run(c, ctx) {
      const part = findOwner(ctx.doc, c.part, ['part']);
      const group = requireRow(c.group, 'grp', 'group');
      const members = checkMembers(ctx.doc, part, group.members, undefined);
      insertRow(ctx, [...part, 'groups'], { ...group, members }, c.before, 'group');
    },
  },

  editGroup: {
    label: (c, doc) =>
      c.members === undefined ? `Rename ${rowName(doc, c.group, 'group')}` : `Edit ${rowName(doc, c.group, 'group')}`,
    run(c, ctx) {
      const at = findRow(ctx.doc, c.group, 'group', ['groups']);
      const row = objectAt(ctx.draft, at.path);
      if (c.name !== undefined) row.name = c.name;
      if (c.members !== undefined)
        row.members = checkMembers(ctx.doc, ownerOf(ctx.doc, at.path).path, c.members, c.group);
    },
  },

  removeGroup: {
    label: (c, doc) => `Ungroup ${rowName(doc, c.group, 'group')}`,
    run(c, ctx) {
      removeRow(ctx, findRow(ctx.doc, c.group, 'group', ['groups']));
    },
  },
};

/**
 * A group's members (7.1): features of the part's own timeline that stand
 * next to each other, at least one, none twice, none in another group.
 * Returns them in timeline order.
 */
function checkMembers(doc: Doc, part: Path, members: unknown, self: string | undefined): string[] {
  if (!Array.isArray(members) || members.some((m) => typeof m !== 'string'))
    throw new CommandError('bad-argument', 'members are feature ids');
  if (members.length === 0) throw new CommandError('bad-argument', 'a group holds at least one feature');
  const owner = objectAt(doc, part);
  const order = ((owner.timeline as Json[] | undefined) ?? []).map((f) => f.id as string);
  const elsewhere = new Set(
    ((owner.groups as Json[] | undefined) ?? [])
      .filter((g) => g.id !== self)
      .flatMap((g) => (g.members as string[] | undefined) ?? []),
  );
  const seen = new Set<string>();
  for (const m of members as string[]) {
    if (!order.includes(m)) throw new CommandError('not-found', `${m} is not a feature of the part's timeline`);
    if (seen.has(m) || elsewhere.has(m)) throw new CommandError('not-allowed', 'a feature is in one group at most');
    seen.add(m);
  }
  const sorted = [...seen].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const first = order.indexOf(sorted[0] as string);
  if (sorted.some((m, k) => order[first + k] !== m))
    throw new CommandError('not-allowed', 'a group holds features that stand next to each other in the timeline');
  return sorted;
}

/** True when two JSON values are the same, key order aside. */
function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}
