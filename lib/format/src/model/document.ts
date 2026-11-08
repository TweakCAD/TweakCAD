import { canonicalize } from '../canonical';
import { isPlainObject } from '../collections';
import { checkNameTable } from '../names';
import { child, type Diagnostic } from './diagnostics';
import { FeatureIndex, readConfiguration, readFeature, readOverride, type ConfigurationInfo } from './features';
import type { ValueTarget } from '../expr';
import { ANGLE, FLAG, LEAD, LENGTH, LIBRARY, PLACEMENT, RATIO, readAttachedFrame, type InputContext } from './shapes';
import { checkIntegrity, type AttributeInfo, type DocumentIndex, type PartInfo } from './integrity';
import { JsonSyntaxError, parseStrictJson } from './json';
import { checkInContextChains, checkUsedNames } from './nameTable';
import { checkInputOverrides } from './overrides';
import { readInstancePath, readReference } from './references';
import { Reader, type Json } from './reader';
import { FORMAT, LIBRARY_KINDS, NAMING_RULES, SCHEMA_VERSION } from './registries';
import { readParameterTables, readValue, ValueIndex } from './values';
// Core feature types register their input readers.
import './sketch';
import './imports';
import './extrude';
import './revolve';
import './loft';
import './sweep';
import './draft';
import './transformChain';
import './coil';
import './fillet';
import './chamfer';
import './hole';
import './thread';
import './shell';
import './pattern';
import './mirror';
import './move';
import './primitive';
import './boolean';
import './construction';
import './measure';
import { checkDeriveCycles } from './derive';
import './assemblyFeatures';
import { assetUse, libraryHash, readAssets, readContexts, readJointStates, readNumericPlacement } from './storage';

export interface ReadResult {
  /** The document as parsed; unknown keys and extensions are kept in place. */
  document: Json | null;
  diagnostics: Diagnostic[];
  /** True when an integrity rule is broken and the document must not open. */
  refused: boolean;
}

const TOP_LEVEL = [
  'format',
  'schemaVersion',
  'namingRules',
  'id',
  'metadata',
  'properties',
  'settings',
  'parameters',
  'parts',
  'assemblies',
  'root',
  'folders',
  'views',
  'library',
  'assets',
  'names',
];

/** Parses and checks a `.cadjson` text. */
export function parseDocument(text: string): ReadResult {
  let parsed;
  try {
    parsed = parseStrictJson(text);
  } catch (e) {
    const message = e instanceof JsonSyntaxError ? e.message : String(e);
    return {
      document: null,
      diagnostics: [{ severity: 'refuse', code: 'wrong-type', path: '', message }],
      refused: true,
    };
  }
  return readDocument(parsed.value, parsed.decoratedIntegers);
}

/** Writes a document in canonical form. */
export function writeDocument(document: Json): string {
  return canonicalize(document);
}

/** How a document is read. */
export interface ReadOptions {
  /** A library document inside a host: its assets carry no `data`. */
  embedded?: boolean;
}

/**
 * Checks a parsed document against the core rules. A document malformed in a
 * way no rule names still comes back refused, never as an exception.
 */
export function readDocument(
  value: unknown,
  decoratedIntegers?: ReadonlySet<string>,
  options: ReadOptions = {},
): ReadResult {
  try {
    return readChecked(value, decoratedIntegers, options);
  } catch (e) {
    if (!(e instanceof TypeError || e instanceof RangeError)) throw e;
    return {
      document: isPlainObject(value) ? value : null,
      diagnostics: [
        { severity: 'refuse', code: 'wrong-type', path: '', message: `the document is malformed: ${e.message}` },
      ],
      refused: true,
    };
  }
}

function readChecked(
  value: unknown,
  decoratedIntegers: ReadonlySet<string> | undefined,
  options: ReadOptions,
): ReadResult {
  const r = new Reader();
  if (decoratedIntegers) r.decoratedIntegers = decoratedIntegers;
  const fail = (): ReadResult => ({
    document: isPlainObject(value) ? value : null,
    diagnostics: r.diagnostics.list,
    refused: true,
  });

  if (!isPlainObject(value)) {
    r.diagnostics.refuse('wrong-type', '', 'a document is a JSON object');
    return fail();
  }
  // `format` and `schemaVersion` are read first; nothing else is read when they are wrong.
  if (value.format !== FORMAT) {
    r.diagnostics.refuse('bad-value', '/format', `not a ${FORMAT} file`);
    return fail();
  }
  const version = value.schemaVersion;
  if (!r.integer(version, '/schemaVersion', 1)) return fail();
  if (version > SCHEMA_VERSION) {
    r.diagnostics.refuse(
      'unknown-version',
      '/schemaVersion',
      `made by a newer version (schema ${version}); update the app`,
    );
    return fail();
  }
  if (version < SCHEMA_VERSION) {
    r.diagnostics.refuse('unknown-version', '/schemaVersion', `schema ${version} is not supported`);
    return fail();
  }

  const doc = r.object(value, '', { required: TOP_LEVEL });
  if (!doc) return fail();
  if (r.integer(doc.namingRules, '/namingRules', 1) && doc.namingRules > NAMING_RULES) {
    // References holding levels this reader cannot compute pause (9.3); the naming engine reports which.
    r.diagnostics.ignore(
      'unknown-version',
      '/namingRules',
      `naming rules ${doc.namingRules} are newer than ${NAMING_RULES}`,
    );
  }
  const docId = r.define(doc.id, '/id', 'doc') ? doc.id : '';

  const values = new ValueIndex();
  const features = new FeatureIndex();
  const index: DocumentIndex = {
    docId,
    values,
    features,
    configurations: [],
    attributes: [],
    parts: new Map(),
    assemblyTimelines: new Map(),
    folders: [],
    captured: new Map(),
    selections: new Map(),
  };

  readMetadata(r, doc.metadata, '/metadata');
  readProperties(r, values, doc.properties, '/properties', docId);
  if (r.map(doc.settings, '/settings')) {
    for (const key of Object.keys(doc.settings)) {
      if (!['displayUnits', 'checks'].includes(key)) {
        r.diagnostics.ignore('unknown-key', child('/settings', key), `unknown setting "${key}" kept`);
      }
    }
  }
  readParameterTables(r, values, doc.parameters, '/parameters', docId);

  if (r.list(doc.parts, '/parts')) {
    doc.parts.forEach((part, i) => readPart(r, index, part, child('/parts', i)));
  }
  const assemblyUses = new Map<string, string[]>();
  if (r.list(doc.assemblies, '/assemblies')) {
    doc.assemblies.forEach((a, i) => readAssembly(r, index, a, child('/assemblies', i), assemblyUses));
  }
  for (const id of assemblyUses.keys()) {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      for (const next of assemblyUses.get(at) ?? []) {
        if (next === id) {
          r.diagnostics.refuse('cycle', '/assemblies', `assembly ${id} contains itself`);
          stack.length = 0;
          break;
        }
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
  }
  checkDeriveCycles(r, doc);
  // Before the document-wide checks, which then cover what the replacements use.
  checkInputOverrides(r, index);
  const root = r.union(doc.root, '/root', ['part', 'assembly', 'parameters']);
  if (root?.tag === 'part') r.idRef(root.payload, root.path, 'part');
  else if (root?.tag === 'assembly') r.idRef(root.payload, root.path, 'asm');
  else if (root) r.object(root.payload, root.path, { required: [] });

  readFolders(r, index, doc.folders, '/folders');
  readViews(r, doc.views, '/views');
  const embeddedAssets = readLibrary(r, doc.library, '/library', decoratedIntegers);
  const assetKeys = readAssets(r, doc.assets, '/assets', options.embedded === true);
  for (const use of [...r.assetUses, ...embeddedAssets]) {
    if (!assetKeys.has(use.id)) r.diagnostics.refuse('dangling', use.path, `asset ${use.id} is not in assets`);
  }

  const names = checkNameTable(doc.names);
  for (const key of names.malformed) r.diagnostics.refuse('bad-hash', child('/names', key), 'malformed name hash');
  for (const key of names.mismatched) {
    r.diagnostics.refuse('bad-hash', child('/names', key), 'entry does not hash to its key');
  }
  let entries: ReturnType<typeof checkUsedNames> = new Map();
  if (isPlainObject(doc.names)) {
    for (const use of r.usedHashes) {
      if (!(use.id in doc.names))
        r.diagnostics.pause('missing-name', use.path, `name ${use.id} is not in the name table`);
    }
    entries = checkUsedNames(r, doc.names);
  }

  // An in-context reference names an instance its context captured, and an
  // entity ref's chain ends with that instance's steps (chapter 20).
  for (const use of r.inContextUses) {
    const paths = index.captured.get(use.context);
    if (paths && !paths.has(use.instance)) {
      r.diagnostics.refuse('dangling', use.path, 'the context did not capture this instance');
    }
  }
  checkInContextChains(r, entries);
  checkIntegrity(r, index);
  return { document: doc, diagnostics: r.diagnostics.list, refused: r.diagnostics.refused };
}

function readMetadata(r: Reader, value: unknown, path: string): void {
  const m = r.object(value, path, {
    required: ['name', 'description', 'createdAt', 'updatedAt', 'writer', 'origin'],
    class: 'presentational',
  });
  if (!m) return;
  r.string(m.name, child(path, 'name'));
  r.string(m.description, child(path, 'description'));
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (r.string(m[key], child(path, key)) && !RFC3339_UTC.test(m[key] as string)) {
      r.diagnostics.refuse('bad-value', child(path, key), 'expected an RFC 3339 UTC time');
    }
  }
  const w = r.object(m.writer, child(path, 'writer'), { required: ['app', 'version'], class: 'presentational' });
  if (w) {
    r.string(w.app, child(child(path, 'writer'), 'app'));
    r.string(w.version, child(child(path, 'writer'), 'version'));
  }
  const origin = r.union(m.origin, child(path, 'origin'), ['original', 'derived', 'imported']);
  if (origin?.tag === 'imported') {
    const im = r.object(origin.payload, origin.path, {
      required: ['format', 'version', 'source', 'report'],
      class: 'presentational',
    });
    if (im) {
      r.string(im.format, child(origin.path, 'format'));
      r.string(im.version, child(origin.path, 'version'));
      assetUse(r, im.source, child(origin.path, 'source'));
      assetUse(r, im.report, child(origin.path, 'report'));
    }
  }
  if (origin?.tag === 'derived') {
    const d = r.object(origin.payload, origin.path, { required: ['document', 'revision'], class: 'presentational' });
    if (d) {
      r.label(d.document, child(origin.path, 'document'), 'doc');
      r.string(d.revision, child(origin.path, 'revision'));
    }
  }
}

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** User properties (16.4): name → {type, quantity, value}. */
function readProperties(r: Reader, values: ValueIndex, value: unknown, path: string, owner: string): void {
  if (!r.map(value, path)) return;
  for (const [name, prop] of Object.entries(value)) {
    const pp = child(path, name);
    const p = r.object(prop, pp, { required: ['type', 'value'], optional: ['quantity'], class: 'presentational' });
    if (!p) continue;
    if (r.string(p.type, child(pp, 'type')) && !['text', 'number', 'boolean', 'date'].includes(p.type)) {
      r.diagnostics.ignore('unknown-variant', child(pp, 'type'), `unknown property type "${p.type}" kept`);
    }
    if (p.type === 'number' && p.quantity === undefined) {
      r.diagnostics.refuse('missing-field', child(pp, 'quantity'), 'a number property has a quantity');
    }
    readValue(r, values, p.value, child(pp, 'value'), { owner });
  }
}

function readPart(r: Reader, index: DocumentIndex, value: unknown, path: string): void {
  const p = r.object(value, path, {
    required: [
      'id',
      'name',
      'parameters',
      'timeline',
      'rollback',
      'groups',
      'sets',
      'contexts',
      'attributes',
      'configurations',
      'notes',
      'properties',
    ],
  });
  if (!p || !r.define(p.id, child(path, 'id'), 'part')) return;
  const owner = p.id;
  const timelineIds: string[] = [];
  const part: PartInfo = { path, timelineIds, groups: [] };
  index.parts.set(owner, part);
  r.string(p.name, child(path, 'name'));
  readParameterTables(r, index.values, p.parameters, child(path, 'parameters'), owner);

  if (r.list(p.timeline, child(path, 'timeline'))) {
    p.timeline.forEach((f, i) => {
      const before = index.features.features.length;
      readFeature(r, index.values, index.features, f, child(child(path, 'timeline'), i), owner);
      // The composite's children are pushed first; the feature itself is last.
      const own = index.features.features.slice(before).at(-1);
      if (own) timelineIds.push(own.id);
    });
  }

  const rollback = r.union(p.rollback, child(path, 'rollback'), ['end', 'before']);
  if (rollback?.tag === 'before') {
    const id = r.idRef(rollback.payload, rollback.path, 'feat');
    if (id) part.rollback = { id, path: rollback.path };
  } else if (rollback) {
    r.object(rollback.payload, rollback.path, { required: [] });
  }

  if (r.list(p.groups, child(path, 'groups'))) {
    p.groups.forEach((g, i) => {
      const gp = child(child(path, 'groups'), i);
      const go = r.object(g, gp, { required: ['id', 'name', 'members'], class: 'presentational' });
      if (!go || !r.define(go.id, child(gp, 'id'), 'grp')) return;
      r.string(go.name, child(gp, 'name'));
      if (r.list(go.members, child(gp, 'members'))) {
        const group: PartInfo['groups'][number] = { path: child(gp, 'members'), members: [] };
        part.groups.push(group);
        go.members.forEach((m, j) => {
          const mp = child(child(gp, 'members'), j);
          if (r.refer(m, mp, 'feat')) group.members.push({ id: m, path: mp });
        });
      }
    });
  }

  if (r.list(p.sets, child(path, 'sets'))) {
    p.sets.forEach((s, i) => {
      const sp = child(child(path, 'sets'), i);
      const so = r.object(s, sp, { required: ['id', 'name', 'members'] });
      if (!so || !r.define(so.id, child(sp, 'id'), 'set')) return;
      r.string(so.name, child(sp, 'name'));
      const members = r.set(so.members, child(sp, 'members'));
      const before = r.selectionUses.length;
      members?.forEach((m, j) => readReference(r, m, child(child(child(sp, 'members'), 'set'), j)));
      index.selections.set(so.id, { path: sp, uses: r.selectionUses.slice(before).map((u) => u.id) });
    });
  }

  for (const [ctx, paths] of readContexts(r, p.contexts, child(path, 'contexts'))) index.captured.set(ctx, paths);

  readAttributes(r, index, p.attributes, child(path, 'attributes'), owner);

  if (r.list(p.configurations, child(path, 'configurations'))) {
    p.configurations.forEach((c, i) => {
      const info: ConfigurationInfo | null = readConfiguration(
        r,
        index.values,
        c,
        child(child(path, 'configurations'), i),
        owner,
      );
      if (info) index.configurations.push(info);
    });
  }

  readNotes(r, p.notes, child(path, 'notes'));
  readProperties(r, index.values, p.properties, child(path, 'properties'), owner);
}

const ATTRIBUTE_PROPERTIES = [
  'color',
  'opacity',
  'appearance',
  'material',
  'name',
  'visible',
  'filamentSlot',
  'locked',
  'properties',
];

/** The properties an attribute on a joint may set (16.1); a joint is not drawn, so only `locked`. */
const JOINT_ATTRIBUTE_PROPERTIES = ['locked'];

/**
 * A joint target, `{"object": {"joint": {"id": jnt_…}}}`, which only an
 * assembly's attributes take (16.1); its id is reference-class, so the
 * joint may be gone. Returns whether `target` is one.
 */
function readJointTarget(r: Reader, target: unknown, path: string): boolean {
  if (
    !isPlainObject(target) ||
    !isPlainObject(target.object) ||
    !('joint' in target.object) ||
    Object.keys(target).length !== 1
  )
    return false;
  const u = r.union(target.object, child(path, 'object'), ['joint']);
  const o = u && r.object(u.payload, u.path, { required: ['id'] });
  if (o) r.label(o.id, child(u.path, 'id'), 'jnt');
  return true;
}

function readAttributes(
  r: Reader,
  index: DocumentIndex,
  value: unknown,
  path: string,
  owner: string,
  joints = false,
): void {
  if (!r.list(value, path)) return;
  value.forEach((a, i) => {
    const ap = child(path, i);
    const ao = r.object(a, ap, { required: ['id', 'target', 'properties'], class: 'presentational' });
    if (!ao || !r.define(ao.id, child(ap, 'id'), 'attr')) return;
    const onJoint = joints && readJointTarget(r, ao.target, child(ap, 'target'));
    if (!onJoint) readReference(r, ao.target, child(ap, 'target'));
    const props = child(ap, 'properties');
    if (!r.map(ao.properties, props)) return;
    const set: string[] = [];
    for (const [key, prop] of Object.entries(ao.properties)) {
      if (!ATTRIBUTE_PROPERTIES.includes(key)) {
        r.diagnostics.ignore('unknown-key', child(props, key), `unknown attribute property "${key}" kept`);
        continue;
      }
      if (onJoint && !JOINT_ATTRIBUTE_PROPERTIES.includes(key)) {
        r.diagnostics.ignore('bad-value', child(props, key), `a joint has no "${key}"; kept`);
        continue;
      }
      set.push(key);
      if (key === 'properties') readProperties(r, index.values, prop, child(props, key), owner);
      else readValue(r, index.values, prop, child(props, key), { owner });
    }
    if (isPlainObject(ao.target)) {
      const info: AttributeInfo = { path: ap, target: canonicalize(ao.target), properties: set };
      index.attributes.push(info);
    }
  });
}

function readNotes(r: Reader, value: unknown, path: string): void {
  if (!r.list(value, path)) return;
  value.forEach((n, i) => {
    const np = child(path, i);
    const no = r.object(n, np, { required: ['id', 'anchor', 'text', 'kind'], class: 'presentational' });
    if (!no || !r.define(no.id, child(np, 'id'), 'note')) return;
    r.string(no.text, child(np, 'text'));
    r.string(no.kind, child(np, 'kind'));
    const anchor = r.union(no.anchor, child(np, 'anchor'), ['ref', 'at']);
    if (anchor?.tag === 'ref') {
      const ro = r.object(anchor.payload, anchor.path, { required: ['ref'] });
      if (ro) readReference(r, ro.ref, child(anchor.path, 'ref'));
    } else if (anchor?.tag === 'at') {
      const ao = r.object(anchor.payload, anchor.path, { required: ['v'] });
      if (ao) readVector(r, ao.v, child(anchor.path, 'v'));
    }
  });
}

function readVector(r: Reader, value: unknown, path: string): void {
  if (!r.list(value, path)) return;
  if (value.length !== 3) r.diagnostics.refuse('wrong-type', path, 'a vector has three numbers');
  value.forEach((c, i) => r.number(c, child(path, i)));
}

function readFolders(r: Reader, index: DocumentIndex, value: unknown, path: string): void {
  if (!r.list(value, path)) return;
  value.forEach((f, i) => {
    const fp = child(path, i);
    const fo = r.object(f, fp, { required: ['id', 'name', 'members', 'parent'], class: 'presentational' });
    if (!fo || !r.define(fo.id, child(fp, 'id'), 'fld')) return;
    r.string(fo.name, child(fp, 'name'));
    if (r.list(fo.members, child(fp, 'members'))) {
      fo.members.forEach((m, j) => {
        const mp = child(child(fp, 'members'), j);
        if (r.refer(m, mp) && !/^(part|asm|lib)_/.test(m)) {
          r.diagnostics.refuse('bad-id', mp, 'a folder holds parts, assemblies and library entries');
        }
      });
    }
    const parent = r.union(fo.parent, child(fp, 'parent'), ['top', 'folder']);
    let parentId: string | undefined;
    if (parent?.tag === 'folder') parentId = r.idRef(parent.payload, parent.path, 'fld') ?? undefined;
    index.folders.push({ id: fo.id, parent: parentId, path: fp });
  });
}

function readViews(r: Reader, value: unknown, path: string): void {
  if (!r.list(value, path)) return;
  value.forEach((v, i) => {
    const vp = child(path, i);
    const vo = r.object(v, vp, { required: ['id', 'name', 'camera', 'position'], class: 'presentational' });
    if (!vo || !r.define(vo.id, child(vp, 'id'), 'view')) return;
    r.string(vo.name, child(vp, 'name'));
    const cp = child(vp, 'camera');
    const camera = r.object(vo.camera, cp, {
      required: ['position', 'target', 'up', 'projection'],
      class: 'presentational',
    });
    if (camera) {
      readVector(r, camera.position, child(cp, 'position'));
      readVector(r, camera.target, child(cp, 'target'));
      readVector(r, camera.up, child(cp, 'up'));
      const proj = r.union(camera.projection, child(cp, 'projection'), ['perspective', 'orthographic']);
      if (proj) {
        const key = proj.tag === 'perspective' ? 'fieldOfView' : 'height';
        const po = r.object(proj.payload, proj.path, { required: [key], class: 'presentational' });
        if (po) r.number(po[key], child(proj.path, key));
      }
    }
    const position = r.union(vo.position, child(vp, 'position'), ['current', 'named']);
    if (position?.tag === 'named') r.idRef(position.payload, position.path, 'pos');
  });
}

/**
 * The library (11). A `document` entry is a complete version-2 document,
 * read with its own id scope; its assets list no data and must be in the
 * host's `assets`, which the returned uses check.
 */
function readLibrary(
  r: Reader,
  value: unknown,
  path: string,
  decoratedIntegers: ReadonlySet<string> | undefined,
): { id: string; path: string }[] {
  const embeddedAssets: { id: string; path: string }[] = [];
  if (!r.list(value, path)) return embeddedAssets;
  value.forEach((entry, i) => {
    const lp = child(path, i);
    const o = r.object(entry, lp, { required: ['id', 'kind', 'content', 'source', 'name'], optional: ['hash'] });
    if (!o || !r.define(o.id, child(lp, 'id'), 'lib')) return;
    r.string(o.name, child(lp, 'name'));
    if (r.string(o.kind, child(lp, 'kind')) && !LIBRARY_KINDS.includes(o.kind)) {
      r.diagnostics.pause('unknown-variant', child(lp, 'kind'), `unknown library kind "${o.kind}"`);
    }
    const source = r.union(o.source, child(lp, 'source'), ['local', 'catalogue']);
    if (source?.tag === 'local') r.object(source.payload, source.path, { required: [] });
    else if (source?.tag === 'catalogue') {
      const c = r.object(source.payload, source.path, { required: ['id', 'version', 'policy'] });
      if (c) {
        r.string(c.id, child(source.path, 'id'));
        r.string(c.version, child(source.path, 'version'));
        if (c.policy !== 'pinned' && c.policy !== 'latest') {
          r.diagnostics.pause('unknown-variant', child(source.path, 'policy'), `unknown policy "${String(c.policy)}"`);
        }
      }
    }
    const content = r.union(o.content, child(lp, 'content'), ['inline', 'missing']);
    if (content?.tag === 'missing') {
      if (o.hash !== undefined) r.diagnostics.refuse('bad-value', child(lp, 'hash'), 'missing content has no hash');
      const m = r.object(content.payload, content.path, { required: ['name'] });
      if (m) r.string(m.name, child(content.path, 'name'));
      return;
    }
    if (!content) return;
    if (o.hash === undefined) {
      r.diagnostics.refuse('missing-field', child(lp, 'hash'), 'inline content has a hash');
    } else if (o.hash !== libraryHash(o.content)) {
      r.diagnostics.refuse('bad-hash', child(lp, 'hash'), 'hash does not match the content');
    }
    if (o.kind === 'font') {
      // A font is its file: `{definition: {asset}}`, the bytes in the assets (13.1).
      const inline = r.object(content.payload, content.path, { required: ['definition'] });
      const dp = child(content.path, 'definition');
      const definition = inline ? r.object(inline.definition, dp, { required: ['asset'] }) : null;
      if (definition && definition.asset !== undefined) assetUse(r, definition.asset, child(dp, 'asset'));
      return;
    }
    if (o.kind !== 'document') return;
    const inline = r.object(content.payload, content.path, { required: ['definition'] });
    if (!inline) return;
    const dp = child(content.path, 'definition');
    const inner = readDocument(inline.definition, decoratedIntegers ? prefixed(decoratedIntegers, dp) : undefined, {
      embedded: true,
    });
    for (const d of inner.diagnostics) r.diagnostics.add(d.severity, d.code, dp + d.path, d.message);
    if (isPlainObject(inline.definition) && isPlainObject(inline.definition.assets)) {
      for (const key of Object.keys(inline.definition.assets)) {
        embeddedAssets.push({ id: key, path: child(child(dp, 'assets'), key) });
      }
    }
  });
  return embeddedAssets;
}

/** The decorated-integer pointers under `prefix`, made relative to it. */
function prefixed(pointers: ReadonlySet<string>, prefix: string): Set<string> {
  const out = new Set<string>();
  for (const p of pointers) if (p.startsWith(`${prefix}/`)) out.add(p.slice(prefix.length));
  return out;
}

/** Initial joint kinds and their degrees of freedom (12.1). */
const JOINT_KINDS: Record<string, readonly string[]> = {
  rigid: [],
  revolute: ['rz'],
  slider: ['tz'],
  cylindrical: ['tz', 'rz'],
  pinSlot: ['tx', 'rz'],
  planar: ['tx', 'ty', 'rz'],
  ball: ['rz', 'ry', 'rx'],
};
const RELATION_KINDS = ['gear', 'rackPinion', 'screw'];
const ASSEMBLY_SOLVERS: readonly number[] = [1];

function readJointEnd(r: Reader, c: InputContext, v: unknown, path: string): void {
  const u = r.union(v, path, ['origin', 'frame']);
  if (u?.tag === 'origin') r.idRef(u.payload, u.path, 'jor');
  else if (u?.tag === 'frame') readAttachedFrame(c, u.payload, u.path);
}

/** An assembly (12.1). `uses` collects which assemblies each one places, for the cycle check. */
function readAssembly(
  r: Reader,
  index: DocumentIndex,
  value: unknown,
  path: string,
  uses: Map<string, string[]>,
): void {
  const a = r.object(value, path, {
    required: [
      'id',
      'name',
      'parameters',
      'configurations',
      'instances',
      'jointOrigins',
      'joints',
      'relations',
      'rigidGroups',
      'contactSets',
      'timeline',
      'positions',
      'activePosition',
      'explodedViews',
      'attributes',
      'notes',
      'properties',
      'solver',
    ],
  });
  if (!a || !r.define(a.id, child(path, 'id'), 'asm')) return;
  const owner = a.id;
  const placed: string[] = [];
  uses.set(owner, placed);
  const c: InputContext = { r, values: index.values, scope: { owner } };
  const p = (f: string) => child(path, f);
  r.string(a.name, p('name'));
  readParameterTables(r, index.values, a.parameters, p('parameters'), owner);

  if (r.list(a.instances, p('instances'))) {
    a.instances.forEach((row, i) => {
      const ip = child(p('instances'), i);
      const o = r.object(row, ip, { required: ['id', 'of', 'placement', 'grounded', 'suppressed', 'overrides'] });
      if (!o || !r.define(o.id, child(ip, 'id'), 'inst')) return;
      const of = r.union(o.of, child(ip, 'of'), ['part', 'assembly', 'component']);
      if (of?.tag === 'part') r.idRef(of.payload, of.path, 'part');
      else if (of?.tag === 'assembly') {
        const target = r.idRef(of.payload, of.path, 'asm');
        if (target) placed.push(target);
      } else if (of?.tag === 'component') {
        const v = r.object(of.payload, of.path, { required: ['value'] });
        if (v) shapeValue(c, v.value, child(of.path, 'value'), LIBRARY);
      }
      readNumericPlacement(r, o.placement, child(ip, 'placement'));
      shapeValue(c, o.grounded, child(ip, 'grounded'), FLAG);
      shapeValue(c, o.suppressed, child(ip, 'suppressed'), FLAG);
      if (r.list(o.overrides, child(ip, 'overrides'))) {
        o.overrides.forEach((ov, j) =>
          readOverride(r, index.values, ov, child(child(ip, 'overrides'), j), owner, o.id as string, -1, false),
        );
      }
    });
  }

  if (r.list(a.jointOrigins, p('jointOrigins'))) {
    a.jointOrigins.forEach((row, i) => {
      const jp = child(p('jointOrigins'), i);
      const o = r.object(row, jp, { required: ['id', 'frame'] });
      if (o && r.define(o.id, child(jp, 'id'), 'jor')) readAttachedFrame(c, o.frame, child(jp, 'frame'));
    });
  }

  if (r.list(a.joints, p('joints'))) {
    a.joints.forEach((row, i) => {
      const jp = child(p('joints'), i);
      // `name` is optional (19): absent, an editor labels the joint by its kind and number.
      const o = r.object(row, jp, {
        required: ['id', 'kind', 'a', 'b', 'limits', 'rest', 'state', 'suppressed'],
        optional: ['name'],
      });
      if (!o || !r.define(o.id, child(jp, 'id'), 'jnt')) return;
      if (o.name !== undefined) r.string(o.name, child(jp, 'name'));
      let dofs: readonly string[] | undefined;
      if (r.string(o.kind, child(jp, 'kind'))) {
        dofs = JOINT_KINDS[o.kind];
        if (!dofs) r.diagnostics.pause('unknown-variant', child(jp, 'kind'), `unknown joint kind "${o.kind}"`);
      }
      readJointEnd(r, c, o.a, child(jp, 'a'));
      readJointEnd(r, c, o.b, child(jp, 'b'));
      const checkDof = (dof: string, at: string) => {
        if (dofs && !dofs.includes(dof))
          r.diagnostics.refuse('bad-value', at, `a ${String(o.kind)} joint has no "${dof}"`);
      };
      if (r.map(o.limits, child(jp, 'limits'))) {
        for (const [dof, limit] of Object.entries(o.limits)) {
          const lp = child(child(jp, 'limits'), dof);
          checkDof(dof, lp);
          const u = r.union(limit, lp, ['free', 'between']);
          if (u?.tag === 'between') {
            const b = r.object(u.payload, u.path, { required: ['min', 'max'] });
            const target = dof.startsWith('r') ? ANGLE : LENGTH;
            if (b) {
              shapeValue(c, b.min, child(u.path, 'min'), target);
              shapeValue(c, b.max, child(u.path, 'max'), target);
            }
          } else if (u) r.object(u.payload, u.path, { required: [] });
        }
      }
      if (r.map(o.rest, child(jp, 'rest'))) {
        for (const [dof, v] of Object.entries(o.rest)) {
          const vp = child(child(jp, 'rest'), dof);
          checkDof(dof, vp);
          shapeValue(c, v, vp, dof.startsWith('r') ? ANGLE : LENGTH);
        }
      }
      if (r.map(o.state, child(jp, 'state'))) {
        for (const [dof, n] of Object.entries(o.state)) {
          checkDof(dof, child(child(jp, 'state'), dof));
          r.number(n, child(child(jp, 'state'), dof));
        }
      }
      shapeValue(c, o.suppressed, child(jp, 'suppressed'), FLAG);
    });
  }

  if (r.list(a.relations, p('relations'))) {
    a.relations.forEach((row, i) => {
      const rp = child(p('relations'), i);
      const o = r.object(row, rp, { required: ['id', 'kind', 'joints', 'ratio'] });
      if (!o || !r.define(o.id, child(rp, 'id'), 'rel')) return;
      if (r.string(o.kind, child(rp, 'kind')) && !RELATION_KINDS.includes(o.kind)) {
        r.diagnostics.pause('unknown-variant', child(rp, 'kind'), `unknown relation kind "${o.kind}"`);
      }
      if (r.list(o.joints, child(rp, 'joints'))) {
        o.joints.forEach((j, k) => r.refer(j, child(child(rp, 'joints'), k), 'jnt'));
      }
      // A gear ratio is a ratio; rack-and-pinion and screw ratios are a lead (mm/deg).
      const ratio = o.kind === 'gear' ? RATIO : o.kind === 'rackPinion' || o.kind === 'screw' ? LEAD : undefined;
      shapeValue(c, o.ratio, child(rp, 'ratio'), ratio);
    });
  }

  for (const table of ['rigidGroups', 'contactSets'] as const) {
    if (!r.list(a[table], p(table))) continue;
    (a[table] as unknown[]).forEach((row, i) => {
      const gp = child(p(table), i);
      const o = r.object(row, gp, { required: ['id', 'members'] });
      if (!o || !r.define(o.id, child(gp, 'id'), table === 'rigidGroups' ? 'grp' : 'set')) return;
      r.set(o.members, child(gp, 'members'))?.forEach((m, j) =>
        readInstancePath(r, m, child(child(child(gp, 'members'), 'set'), j)),
      );
    });
  }

  if (r.list(a.timeline, p('timeline'))) {
    const timelineIds: string[] = [];
    index.assemblyTimelines.set(owner, timelineIds);
    a.timeline.forEach((f, i) => {
      const before = index.features.features.length;
      readFeature(r, index.values, index.features, f, child(p('timeline'), i), owner);
      const own = index.features.features.slice(before).at(-1);
      if (own) timelineIds.push(own.id);
    });
  }

  if (r.list(a.positions, p('positions'))) {
    a.positions.forEach((row, i) => {
      const pp = child(p('positions'), i);
      const o = r.object(row, pp, { required: ['id', 'name', 'state'] });
      if (!o || !r.define(o.id, child(pp, 'id'), 'pos')) return;
      r.string(o.name, child(pp, 'name'));
      readJointStates(r, o.state, child(pp, 'state'));
    });
  }
  const active = r.union(a.activePosition, p('activePosition'), ['current', 'position']);
  if (active?.tag === 'position') r.idRef(active.payload, active.path, 'pos');
  else if (active) r.object(active.payload, active.path, { required: [] });

  if (r.list(a.explodedViews, p('explodedViews'))) {
    a.explodedViews.forEach((row, i) => {
      const ep = child(p('explodedViews'), i);
      const o = r.object(row, ep, { required: ['id', 'name', 'steps'] });
      if (!o || !r.define(o.id, child(ep, 'id'), 'exp')) return;
      r.string(o.name, child(ep, 'name'));
      if (!r.list(o.steps, child(ep, 'steps'))) return;
      o.steps.forEach((step, j) => {
        const sp = child(child(ep, 'steps'), j);
        const so = r.object(step, sp, { required: ['instances', 'transform'] });
        if (!so) return;
        r.set(so.instances, child(sp, 'instances'))?.forEach((m, k) =>
          readInstancePath(r, m, child(child(child(sp, 'instances'), 'set'), k)),
        );
        shapeValue(c, so.transform, child(sp, 'transform'), PLACEMENT);
      });
    });
  }

  readAttributes(r, index, a.attributes, p('attributes'), owner, true);
  readNotes(r, a.notes, p('notes'));
  readProperties(r, index.values, a.properties, p('properties'), owner);
  if (r.integer(a.solver, p('solver'), 1) && !ASSEMBLY_SOLVERS.includes(a.solver)) {
    r.diagnostics.pause('unknown-version', p('solver'), `unknown assembly solver ${a.solver}`);
  }
  if (r.list(a.configurations, p('configurations'))) {
    a.configurations.forEach((cfg, i) => {
      const info = readConfiguration(r, index.values, cfg, child(p('configurations'), i), owner);
      if (info) index.configurations.push(info);
    });
  }
}

/** A value object with an optional expected type. */
function shapeValue(c: InputContext, v: unknown, path: string, target: ValueTarget | undefined): void {
  readValue(c.r, c.values, v, path, c.scope, target);
}
