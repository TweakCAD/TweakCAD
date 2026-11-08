import { isPlainObject } from '../collections';
import { contentHash, isContentHash, nameHash } from '../hash';
import { isUnitQuaternion, hasCanonicalSign, type Quaternion } from '../rotation';
import { child } from './diagnostics';
import type { Json, Reader } from './reader';
import { instanceKey, readEntityRecordBranch, readInstancePath } from './references';

/** Assets, stored shapes, shape maps, imports, frozen effects and captured contexts (7.2, 12.4, 13). */

export function assetUse(r: Reader, v: unknown, path: string): void {
  if (isContentHash(v)) r.assetUses.push({ id: v, path });
  else r.diagnostics.refuse('bad-hash', path, 'malformed asset hash');
}

/** Representations this reader decodes (13.2). */
const REPRESENTATIONS: Record<string, readonly number[]> = { brep: [1] };

/** Inline asset bytes (13.1); null when `text` is not base64. */
export function decodeBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Inline bytes found to hash to their key lately, by key: a document read again holds the same megabytes, which compare faster than they hash. */
const verified = new Map<string, string>();
const VERIFIED_ROWS = 256;

/** Whether base64 `text` holds `size` bytes hashing to `key`; a refusal's message when not. */
function inlineProblem(
  key: string,
  text: string,
  size: unknown,
): { field: 'base64' | 'size' | 'hash'; message: string } | null {
  if (verified.get(key) === text && typeof size === 'number' && size === base64Length(text)) return null;
  const bytes = decodeBase64(text);
  if (!bytes) return { field: 'base64', message: 'malformed base64' };
  if (bytes.length !== size) return { field: 'size', message: 'size does not match the data' };
  if (contentHash(bytes) !== key) return { field: 'hash', message: 'data does not hash to its key' };
  if (verified.size >= VERIFIED_ROWS) verified.clear();
  verified.set(key, text);
  return null;
}

/** The byte count of well-formed base64 text. */
function base64Length(text: string): number {
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - pad;
}

/**
 * The `assets` table (13.1). `embedded` documents list their assets without
 * `data`: the host holds the bytes.
 */
export function readAssets(r: Reader, v: unknown, path: string, embedded: boolean): Set<string> {
  const keys = new Set<string>();
  if (!r.map(v, path)) return keys;
  for (const [key, row] of Object.entries(v)) {
    const ap = child(path, key);
    if (!isContentHash(key)) {
      r.diagnostics.refuse('bad-hash', ap, 'an asset is keyed by its content hash');
      continue;
    }
    keys.add(key);
    const o = r.object(row, ap, {
      required: ['mediaType', 'name', 'size'],
      optional: ['data'],
    });
    if (!o) continue;
    r.string(o.mediaType, child(ap, 'mediaType'));
    r.string(o.name, child(ap, 'name'));
    r.integer(o.size, child(ap, 'size'), 0);
    if (embedded) {
      // An embedded document's rows hold metadata only; its host holds the bytes (11).
      if (o.data !== undefined)
        r.diagnostics.refuse('bad-value', child(ap, 'data'), "an embedded document's asset row has no data");
      continue;
    }
    if (o.data === undefined) {
      r.diagnostics.refuse('missing-field', child(ap, 'data'), 'missing field "data"');
      continue;
    }
    const data = r.union(o.data, child(ap, 'data'), ['external', 'inline']);
    if (data?.tag === 'external') r.object(data.payload, data.path, { required: [] });
    else if (data?.tag === 'inline') {
      const d = r.object(data.payload, data.path, { required: ['base64'] });
      if (!d || !r.string(d.base64, child(data.path, 'base64'))) continue;
      const problem = inlineProblem(key, d.base64, o.size);
      if (problem?.field === 'base64') r.diagnostics.refuse('bad-value', child(data.path, 'base64'), problem.message);
      else if (problem?.field === 'size') r.diagnostics.refuse('bad-value', child(ap, 'size'), problem.message);
      else if (problem) r.diagnostics.refuse('bad-hash', ap, problem.message);
    }
  }
  return keys;
}

/** An entity key `{hash, branch}` (7.2, 9.6). */
function readEntityKey(r: Reader, v: unknown, path: string): void {
  const o = r.object(v, path, { required: ['hash', 'branch'] });
  if (!o) return;
  r.hash(o.hash, child(path, 'hash'));
  readEntityRecordBranch(r, o.branch, child(path, 'branch'));
}

function readLadder(r: Reader, v: unknown, path: string): void {
  if (r.list(v, path)) v.forEach((h, i) => r.hash(h, child(path, i)));
}

/** A shape map (13.2): one entry per sub-shape in index order. */
function readShapeMap(r: Reader, v: unknown, path: string): void {
  if (!r.list(v, path)) return;
  const count = v.length;
  v.forEach((entry, i) => {
    const ep = child(path, i);
    const o = r.object(entry, ep, { required: ['ladder', 'aliases', 'branch', 'snapshot', 'children'] });
    if (!o) return;
    readLadder(r, o.ladder, child(ep, 'ladder'));
    r.set(o.aliases, child(ep, 'aliases'))?.forEach((a, j) =>
      readEntityKey(r, a, child(child(child(ep, 'aliases'), 'set'), j)),
    );
    readEntityRecordBranch(r, o.branch, child(ep, 'branch'));
    r.map(o.snapshot, child(ep, 'snapshot'));
    r.set(o.children, child(ep, 'children'))?.forEach((c, j) => {
      const cp = child(child(child(ep, 'children'), 'set'), j);
      if (r.integer(c, cp, 0) && (c >= count || c === i)) {
        r.diagnostics.refuse('bad-value', cp, 'a child index names another entry of this map');
      }
    });
  });
}

/** A stored shape (13.2). */
export function readStoredShape(r: Reader, v: unknown, path: string): void {
  const o = r.object(v, path, { required: ['asset', 'representation', 'map'] });
  if (!o) return;
  assetUse(r, o.asset, child(path, 'asset'));
  const rep = r.object(o.representation, child(path, 'representation'), { required: ['name', 'version'] });
  if (
    rep &&
    r.string(rep.name, child(path, 'representation/name')) &&
    r.integer(rep.version, child(path, 'representation/version'), 1)
  ) {
    if (!REPRESENTATIONS[rep.name]?.includes(rep.version)) {
      r.diagnostics.pause(
        'unknown-version',
        child(path, 'representation'),
        `unknown representation ${rep.name} ${rep.version}`,
      );
    }
  }
  readShapeMap(r, o.map, child(path, 'map'));
}

/** A numeric placement `{position, rotation}` (2.7). */
export function readNumericPlacement(r: Reader, v: unknown, path: string): void {
  const o = r.object(v, path, { required: ['position', 'rotation'] });
  if (!o) return;
  if (r.list(o.position, child(path, 'position'))) {
    if (o.position.length !== 3)
      r.diagnostics.refuse('wrong-type', child(path, 'position'), 'a position has three numbers');
    o.position.forEach((n, i) => r.number(n, child(child(path, 'position'), i)));
  }
  if (!isUnitQuaternion(o.rotation)) {
    r.diagnostics.refuse('bad-rotation', child(path, 'rotation'), 'a rotation is a unit quaternion [x, y, z, w]');
  } else if (!hasCanonicalSign(o.rotation as Quaternion)) {
    r.diagnostics.refuse('bad-rotation', child(path, 'rotation'), 'a rotation has the canonical sign');
  }
}

function readNumbers(r: Reader, v: unknown, path: string, n: number): void {
  if (!r.list(v, path)) return;
  if (v.length !== n) r.diagnostics.refuse('wrong-type', path, `expected ${n} numbers`);
  v.forEach((x, i) => r.number(x, child(path, i)));
}

/** Captured construction outputs (12.4), also used by frozen features. */
function readConstruction(r: Reader, v: unknown, path: string): void {
  if (!r.list(v, path)) return;
  v.forEach((entry, i) => {
    const ep = child(path, i);
    const o = r.object(entry, ep, { required: ['ladder', 'aliases', 'geometry'] });
    if (!o) return;
    readLadder(r, o.ladder, child(ep, 'ladder'));
    r.set(o.aliases, child(ep, 'aliases'))?.forEach((a, j) =>
      readEntityKey(r, a, child(child(child(ep, 'aliases'), 'set'), j)),
    );
    const g = r.union(o.geometry, child(ep, 'geometry'), ['plane', 'axis', 'point', 'frame']);
    if (!g) return;
    const fields: Record<string, string[]> = {
      plane: ['origin', 'normal', 'x'],
      axis: ['origin', 'direction'],
      point: ['at'],
    };
    if (g.tag === 'frame') {
      readNumericPlacement(r, g.payload, g.path);
      return;
    }
    const keys = fields[g.tag] ?? [];
    const go = r.object(g.payload, g.path, { required: keys });
    if (go) for (const k of keys) readNumbers(r, go[k], child(g.path, k), 3);
  });
}

const LITERAL_TYPES = ['number', 'integer', 'boolean', 'text', 'choice', 'vector', 'placement', 'date', 'library'];

/** A typed literal (7.2): a value's last result. */
function readTypedLiteral(r: Reader, v: unknown, path: string): void {
  const o = r.object(v, path, { required: ['type', 'value'], optional: ['quantity'] });
  if (!o || !r.string(o.type, child(path, 'type'))) return;
  if (!LITERAL_TYPES.includes(o.type)) {
    r.diagnostics.pause('unknown-variant', child(path, 'type'), `unknown value type "${o.type}"`);
    return;
  }
  const vp = child(path, 'value');
  switch (o.type) {
    case 'number':
    case 'integer':
      if (o.type === 'number' && o.quantity === undefined) {
        r.diagnostics.refuse('missing-field', child(path, 'quantity'), 'a number literal has a quantity');
      }
      if (o.type === 'integer') r.integer(o.value, vp);
      else r.number(o.value, vp);
      return;
    case 'boolean':
      r.boolean(o.value, vp);
      return;
    case 'vector':
      readNumbers(r, o.value, vp, 3);
      return;
    case 'placement':
      readNumericPlacement(r, o.value, vp);
      return;
    case 'library':
      r.refer(o.value, vp, 'lib');
      return;
    default:
      r.string(o.value, vp);
  }
}

const THREAD_FIELDS = [
  'faces',
  'standard',
  'designation',
  'class',
  'internal',
  'pitch',
  'major',
  'pitchDiameter',
  'minor',
  'start',
  'direction',
  'length',
];

/** One of a frozen feature's other outputs (7.2 `outputs`): a cosmetic thread, or the tool its operation applied. */
function readFrozenOutput(r: Reader, v: unknown, path: string): void {
  const u = r.union(v, path, ['thread', 'tool']);
  if (u?.tag === 'thread') {
    const t = r.object(u.payload, u.path, { required: THREAD_FIELDS, optional: ['hand'] });
    if (t && t.hand !== undefined && t.hand !== 'left')
      r.diagnostics.refuse(
        'bad-value',
        child(u.path, 'hand'),
        'a stored thread is right-handed without `hand`, or has `hand` "left"',
      );
    const faces = t ? r.set(t.faces, child(u.path, 'faces')) : null;
    faces?.forEach((k, i) => readEntityKey(r, k, child(child(child(u.path, 'faces'), 'set'), i)));
  } else if (u?.tag === 'tool') {
    const t = r.object(u.payload, u.path, { required: ['stored', 'op', 'targets'] });
    if (t) readStoredShape(r, t.stored, child(u.path, 'stored'));
  }
}

/** A frozen feature's `{"frozen": {effects, construction, values, outputs}}` payload (7.2). */
export function readFrozen(r: Reader, payload: Json, path: string): void {
  const o = r.object(payload, path, { required: ['effects', 'construction', 'values'], optional: ['outputs'] });
  if (!o) return;
  if (r.list(o.effects, child(path, 'effects'))) {
    o.effects.forEach((effect, i) => {
      const ep = child(child(path, 'effects'), i);
      const u = r.union(effect, ep, ['create', 'modify', 'remove']);
      if (!u) return;
      if (u.tag === 'create') {
        const c = r.object(u.payload, u.path, { required: ['ladder', 'branch', 'stored'] });
        if (!c) return;
        readLadder(r, c.ladder, child(u.path, 'ladder'));
        readEntityRecordBranch(r, c.branch, child(u.path, 'branch'));
        readStoredShape(r, c.stored, child(u.path, 'stored'));
      } else if (u.tag === 'modify') {
        const m = r.object(u.payload, u.path, { required: ['body', 'stored'], optional: ['input'] });
        if (!m) return;
        readEntityKey(r, m.body, child(u.path, 'body'));
        readStoredShape(r, m.stored, child(u.path, 'stored'));
        if (m.input !== undefined && !isContentHash(m.input)) {
          r.diagnostics.refuse('bad-hash', child(u.path, 'input'), 'malformed asset hash');
        }
      } else {
        const m = r.object(u.payload, u.path, { required: ['body'] });
        if (m) readEntityKey(r, m.body, child(u.path, 'body'));
      }
    });
  }
  readConstruction(r, o.construction, child(path, 'construction'));
  if (o.outputs !== undefined && r.list(o.outputs, child(path, 'outputs'))) {
    o.outputs.forEach((output, i) => readFrozenOutput(r, output, child(child(path, 'outputs'), i)));
  }
  if (r.map(o.values, child(path, 'values'))) {
    for (const [key, literal] of Object.entries(o.values)) {
      const lp = child(child(path, 'values'), key);
      if (r.refer(key, lp, 'val')) readTypedLiteral(r, literal, lp);
    }
  }
}

/** Captured contexts of a part (12.4). Returns each context's captured instance paths, canonical. */
export function readContexts(r: Reader, v: unknown, path: string): Map<string, Set<string>> {
  const captured = new Map<string, Set<string>>();
  if (!r.list(v, path)) return captured;
  v.forEach((row, i) => {
    const cp = child(path, i);
    const o = r.object(row, cp, {
      required: ['id', 'assembly', 'at', 'captured', 'source', 'policy', 'capturedAt'],
      optional: ['position'],
    });
    if (!o || !r.define(o.id, child(cp, 'id'), 'ctx')) return;
    r.idRef(o.assembly, child(cp, 'assembly'), 'asm');
    readInstancePath(r, o.at, child(cp, 'at'));
    const paths = new Set<string>();
    r.set(o.captured, child(cp, 'captured'))?.forEach((entry, j) => {
      const ep = child(child(child(cp, 'captured'), 'set'), j);
      const e = r.object(entry, ep, { required: ['instance', 'stored', 'construction', 'placement'] });
      if (!e) return;
      readInstancePath(r, e.instance, child(ep, 'instance'));
      if (isPlainObject(e.instance)) paths.add(instanceKey(e.instance.path));
      readStoredShape(r, e.stored, child(ep, 'stored'));
      readConstruction(r, e.construction, child(ep, 'construction'));
      readNumericPlacement(r, e.placement, child(ep, 'placement'));
    });
    captured.set(o.id, paths);
    // A manifest is never stored, so its hash is not one `names` holds (20).
    r.hashOnly(o.source, child(cp, 'source'));
    if (o.policy !== 'manual' && o.policy !== 'automatic') {
      r.diagnostics.pause('unknown-variant', child(cp, 'policy'), `unknown context policy "${String(o.policy)}"`);
    }
    if (o.position !== undefined) {
      const pos = r.union(o.position, child(cp, 'position'), ['current', 'position', 'captured']);
      if (pos?.tag === 'position') r.idRef(pos.payload, pos.path, 'pos');
      else if (pos?.tag === 'captured') {
        const c = r.object(pos.payload, pos.path, { required: ['state'] });
        if (c) readJointStates(r, c.state, child(pos.path, 'state'));
      } else if (pos) r.object(pos.payload, pos.path, { required: [] });
    }
    if (
      r.string(o.capturedAt, child(cp, 'capturedAt')) &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(o.capturedAt)
    ) {
      r.diagnostics.refuse('bad-value', child(cp, 'capturedAt'), 'expected an RFC 3339 UTC time');
    }
  });
  return captured;
}

/** A map from `jnt_…` (reference-class, 2.4) to degree-of-freedom name to number. */
export function readJointStates(r: Reader, v: unknown, path: string): void {
  if (!r.map(v, path)) return;
  for (const [joint, dofs] of Object.entries(v)) {
    const jp = child(path, joint);
    r.label(joint, jp, 'jnt');
    if (r.map(dofs, jp)) for (const [dof, n] of Object.entries(dofs)) r.number(n, child(jp, dof));
  }
}

/** Library content hash check (11): `hash` is the name hash of `content`. */
export function libraryHash(content: unknown): string {
  return nameHash(content);
}
