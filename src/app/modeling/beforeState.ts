/**
 * A panel on a feature works in the part as it stands just before that
 * feature: for a new feature, the part at its rollback; for an edit, the
 * part rolled back to just before the edited feature. Its stored picks are
 * named as that state names them: a body by its name there ("Body 3"), a
 * face or edge by the body it lies on, a feature by its name. A stored
 * reference that lands on nothing there is listed as missing.
 */
import { isPlainObject } from '@tweakcad/format';
import type { Json } from '@tweakcad/editor';
import type { EntityRecord } from '@tweakcad/format';
import type { ListedBody, PlacedReference } from '@tweakcad/worker/src/v2/service/types';
import { findFeature } from '../features';
import type { AppServices } from '../services';
import type { FeatureTarget, PickedRef } from './feature';

/** Whether a form value is a pick a panel holds. */
export function isPickedRef(v: unknown): v is PickedRef {
  return isPlainObject(v) && isPlainObject(v.reference) && isPlainObject(v.names) && typeof v.label === 'string';
}

/** Every pick a form holds, wherever it sits in the form, in a fixed order. */
export function picksInForm(form: unknown, out: PickedRef[] = []): PickedRef[] {
  if (isPickedRef(form)) out.push(form);
  else if (Array.isArray(form)) for (const v of form) picksInForm(v, out);
  else if (isPlainObject(form)) for (const v of Object.values(form)) picksInForm(v, out);
  return out;
}

/** The entity record a reference holds, or null for a standard plane, a feature or anything else. */
export function recordOf(reference: Json): EntityRecord | null {
  const entity = reference.entity;
  return isPlainObject(entity) && Array.isArray(entity.id) ? (entity as unknown as EntityRecord) : null;
}

/** The feature a reference names (`{"object": {"feature": ...}}`), or null. */
function featureOf(reference: Json): string | null {
  const object = reference.object;
  const feature = isPlainObject(object) ? object.feature : undefined;
  return isPlainObject(feature) && typeof feature.id === 'string' ? feature.id : null;
}

export interface PickLabel {
  label: string;
  missing?: boolean;
}

const KIND_NAMES: Record<string, string> = {
  body: 'body',
  face: 'face',
  edge: 'edge',
  vertex: 'vertex',
  curve: 'curve',
  region: 'profile',
  point: 'point',
  plane: 'plane',
  axis: 'axis',
  frame: 'frame',
};

/** How a stored entity pick reads, from where it lands in the state before the feature; null keeps the label it has. */
export function placedLabel(placed: PlacedReference, bodies: readonly ListedBody[]): PickLabel | null {
  if (!placed.found) return { label: `Missing ${KIND_NAMES[placed.kind ?? ''] ?? 'reference'}`, missing: true };
  const body = placed.body === null ? undefined : bodies.find((b) => b.id === placed.body);
  switch (placed.kind) {
    case 'body':
      return body ? { label: body.name } : null;
    case 'face':
      return body ? { label: `Face of ${body.name}` } : null;
    case 'edge':
      return body ? { label: `Edge of ${body.name}` } : null;
    case 'vertex':
      return body ? { label: `Vertex of ${body.name}` } : null;
    default:
      return null;
  }
}

/**
 * The labels of a form's stored picks: entity picks by where `placed` says
 * each of `records` lands (in that order), feature picks by the feature's
 * name, or missing when the document no longer holds it. Keyed by the
 * pick's reference object, which a form keeps while it holds the pick.
 */
export function storedLabels(
  picks: readonly PickedRef[],
  records: readonly Json[],
  placed: readonly PlacedReference[],
  bodies: readonly ListedBody[],
  featureName: (id: string) => string | null,
): Map<Json, PickLabel> {
  const out = new Map<Json, PickLabel>();
  for (const p of picks) {
    const feature = featureOf(p.reference);
    if (feature === null) continue;
    const name = featureName(feature);
    out.set(p.reference, name === null ? { label: 'Missing feature', missing: true } : { label: name });
  }
  records.forEach((reference, i) => {
    const where = placed[i];
    const label = where ? placedLabel(where, bodies) : null;
    if (label) out.set(reference, label);
  });
  return out;
}

/** `form` with each pick whose reference `labels` holds relabelled; the same object when none is. */
export function relabelled<F>(form: F, labels: ReadonlyMap<Json, PickLabel>): F {
  if (labels.size === 0) return form;
  const walk = (v: unknown): unknown => {
    if (isPickedRef(v)) {
      const l = labels.get(v.reference);
      if (!l || (l.label === v.label && !!l.missing === !!v.missing)) return v;
      return {
        reference: v.reference,
        names: v.names,
        label: l.label,
        ...(l.missing ? { missing: true } : {}),
      } satisfies PickedRef;
    }
    if (Array.isArray(v)) {
      const next = v.map(walk);
      return next.some((x, i) => x !== v[i]) ? next : v;
    }
    if (isPlainObject(v)) {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        next[k] = walk(x);
        if (next[k] !== x) changed = true;
      }
      return changed ? next : v;
    }
    return v;
  };
  return walk(form) as F;
}

/** The labels of the stored picks in an edited feature's form, read in the part just before the feature. */
export async function labelsOfStoredPicks(
  services: AppServices,
  target: FeatureTarget,
  form: unknown,
): Promise<Map<Json, PickLabel>> {
  const picks = picksInForm(form);
  const entities = picks.flatMap((p) => {
    const record = recordOf(p.reference);
    return record ? [{ reference: p.reference, record }] : [];
  });
  let placed: PlacedReference[] = [];
  let bodies: ListedBody[] = [];
  if (entities.length > 0 && services.client.bodiesBefore) {
    try {
      const listed = await services.client.bodiesBefore(
        { part: target.part, feature: target.feature },
        entities.map((e) => e.record),
      );
      placed = listed.references;
      bodies = listed.bodies;
    } catch {
      // Nothing evaluated holds the part: the picks keep their labels.
    }
  }
  const featureName = (id: string) => {
    const row = findFeature(services.editor.document, id);
    return row ? String(row.name ?? id) : null;
  };
  return storedLabels(
    picks,
    entities.slice(0, placed.length).map((e) => e.reference),
    placed,
    bodies,
    featureName,
  );
}
