import { canonicalize } from '../canonical';
import { isPlainObject } from '../collections';
import { child } from './diagnostics';
import type { Reader } from './reader';
import { SKETCH_STANDARD_NAMES, STANDARD_NAMES } from './registries';

/**
 * Structural checks for the chapter-9 reference forms. Resolution (which
 * entity a reference denotes in a build) belongs to the naming engine; this
 * only checks the encoding and records the hashes and ids it uses.
 */

export const REFERENCE_FORMS = ['entity', 'object', 'standard', 'sketchStandard', 'inContext', 'selection'];

/** Ids in reference forms are reference-class (9.1): the target may be gone. */
function referenceId(r: Reader, value: unknown, path: string, kind?: string): void {
  const o = r.object(value, path, { required: ['id'] });
  if (o) r.label(o.id, child(path, 'id'), kind);
}

export function readReference(r: Reader, value: unknown, path: string): void {
  const u = r.union(value, path, REFERENCE_FORMS);
  if (!u) return;
  const { tag, payload, path: p } = u;
  switch (tag) {
    case 'entity':
      readEntityRecord(r, payload, p);
      return;
    case 'object': {
      const o = r.union(payload, p, ['part', 'assembly', 'feature', 'instance']);
      if (!o) return;
      if (o.tag === 'instance') readInstancePath(r, o.payload, o.path);
      else referenceId(r, o.payload, o.path, o.tag === 'assembly' ? 'asm' : o.tag === 'feature' ? 'feat' : 'part');
      return;
    }
    case 'standard':
    case 'sketchStandard': {
      const o = r.object(payload, p, { required: ['name'] });
      const names = tag === 'standard' ? STANDARD_NAMES : SKETCH_STANDARD_NAMES;
      if (o && r.string(o.name, child(p, 'name')) && !names.includes(o.name)) {
        r.diagnostics.pause('unknown-variant', child(p, 'name'), `unknown ${tag} name "${o.name}"`);
      }
      return;
    }
    case 'inContext': {
      const o = r.object(payload, p, { required: ['context', 'instance', 'ref'] });
      if (!o) return;
      const context = r.idRef(o.context, child(p, 'context'), 'ctx');
      readInstancePath(r, o.instance, child(p, 'instance'));
      if (context && isPlainObject(o.instance)) {
        const entity = isPlainObject(o.ref) && isPlainObject(o.ref.entity) ? o.ref.entity : undefined;
        r.inContextUses.push({
          context,
          instance: instanceKey(o.instance.path),
          steps: Array.isArray(o.instance.path) ? o.instance.path : [],
          ...(entity && Array.isArray(entity.id)
            ? { ladder: entity.id, ladderPath: child(child(child(p, 'ref'), 'entity'), 'id') }
            : {}),
          path: child(p, 'instance'),
        });
      }
      readReference(r, o.ref, child(p, 'ref'));
      return;
    }
    case 'selection': {
      const id = r.idRef(payload, p, 'set');
      if (id) r.selectionUses.push({ id, path: p });
      return;
    }
  }
}

/** The entity record (9.2). */
export function readEntityRecord(r: Reader, value: unknown, path: string): void {
  const o = r.object(value, path, { required: ['id', 'branch', 'side', 'nb', 'n', 'snapshot'] });
  if (!o) return;
  if (r.list(o.id, child(path, 'id'))) {
    o.id.forEach((h, i) => r.hash(h, child(child(path, 'id'), i)));
  }
  readEntityRecordBranch(r, o.branch, child(path, 'branch'));
  readSide(r, o.side, child(path, 'side'));
  const nb = r.set(o.nb, child(path, 'nb'));
  nb?.forEach((h, i) => r.hash(h, child(child(child(path, 'nb'), 'set'), i)));
  r.integer(o.n, child(path, 'n'), 1);
  r.map(o.snapshot, child(path, 'snapshot'));
}

/** A `branch` list (9.2): split events, each with its sides. */
export function readEntityRecordBranch(r: Reader, value: unknown, path: string): void {
  if (!r.list(value, path)) return;
  value.forEach((entry, i) => {
    const bp = child(path, i);
    const b = r.object(entry, bp, { required: ['split', 'side'] });
    if (!b) return;
    referenceId(r, b.split, child(bp, 'split'), 'feat');
    readSide(r, b.side, child(bp, 'side'));
  });
}

function readSide(r: Reader, value: unknown, path: string): void {
  if (!r.list(value, path)) return;
  value.forEach((entry, i) => {
    const sp = child(path, i);
    const s = r.object(entry, sp, { required: ['of', 'sign'] });
    if (!s) return;
    r.hash(s.of, child(sp, 'of'));
    if (s.sign !== 1 && s.sign !== -1) r.diagnostics.refuse('bad-value', child(sp, 'sign'), 'sign is 1 or -1');
  });
}

/**
 * An instance path (9.1). Instance ids are reference-class wherever a path
 * appears (2.4). Copy steps are checked with the copy rules (9.5).
 */
export function readInstancePath(r: Reader, value: unknown, path: string): void {
  const o = r.object(value, path, { required: ['path'] });
  if (!o || !r.list(o.path, child(path, 'path'))) return;
  o.path.forEach((step, i) => {
    const sp = child(child(path, 'path'), i);
    const s = r.union(step, sp, ['instance', 'copy']);
    if (!s) return;
    if (s.tag === 'instance') referenceId(r, s.payload, s.path, 'inst');
    else readCopyStep(r, s.payload, s.path);
  });
}

/** Copy keys (9.5); `tool` marks the copy of a kept tool body that its operation uses up. */
export const COPY_KEYS = ['slot', 'mirror', 'instance', 'derive', 'step', 'tool'];

/** A copy step `{op, key}` (9.5), in an instance path or a name's `chain`. Ids in it are labels. */
export function readCopyStep(r: Reader, value: unknown, path: string): void {
  const o = r.object(value, path, { required: ['op', 'key'] });
  if (!o) return;
  const op = r.object(o.op, child(path, 'op'), { required: ['id'] });
  const opPath = child(child(path, 'op'), 'id');
  if (op && r.label(op.id, opPath) && !/^(feat|inst)_/.test(op.id)) {
    r.diagnostics.refuse('bad-id', opPath, "a copy step's op is a feature or an instance");
  }
  const key = r.union(o.key, child(path, 'key'), COPY_KEYS);
  if (!key) return;
  switch (key.tag) {
    case 'slot': {
      const slot = r.object(key.payload, key.path, { required: ['i', 'j'] });
      if (slot) {
        r.integer(slot.i, child(key.path, 'i'));
        r.integer(slot.j, child(key.path, 'j'));
      }
      return;
    }
    case 'instance':
      referenceId(r, key.payload, key.path, 'inst');
      return;
    case 'step':
      referenceId(r, key.payload, key.path);
      return;
    default:
      r.object(key.payload, key.path, { required: [] });
  }
}

/**
 * An instance path's steps in canonical form: two paths are the same path when
 * these agree, whatever order their members were written in (2.1).
 */
export function instanceKey(steps: unknown): string {
  try {
    return canonicalize(steps);
  } catch {
    return '';
  }
}
