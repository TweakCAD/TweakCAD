/**
 * The sketches a profile-based feature's panel shows while it is open, hidden
 * or not, so their regions can be clicked: the sketches its profiles come
 * from; with none found, the sketches its other inputs name (a direction or
 * an axis taken from a sketch line); failing that, the sketch it was started
 * from. A feature that runs along other sketches (a sweep's path, a loft's
 * rails) shows those with them. They show through the app state the viewport draws from, so nothing
 * is written to the document, and each sketch's own visibility returns when
 * the panel closes.
 */
import { useEffect, useMemo } from 'react';
import { isPlainObject } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import type { AppStore } from '../appState';
import { findFeature, partOfFeature } from '../features';
import { useDocument } from '../hooks';
import type { AppServices } from '../services';
import type { ExtrudeProfile } from './extrude';

/** True when `id` is a sketch of `part`. */
function isSketchOf(doc: Doc, part: string, id: string): boolean {
  return findFeature(doc, id)?.type === 'core.sketch' && partOfFeature(doc, id) === part;
}

/**
 * The sketch a reference names, or null: a whole sketch (`object.feature`),
 * or a curve, point or region of one, by the feature of its name. `names`
 * holds names not yet written to the document (a pick the form holds).
 */
export function sketchOfReference(doc: Doc, part: string, reference: unknown, names: Json = {}): string | null {
  if (!isPlainObject(reference)) return null;
  const whole =
    isPlainObject(reference.object) && isPlainObject(reference.object.feature)
      ? reference.object.feature.id
      : undefined;
  if (typeof whole === 'string') return isSketchOf(doc, part, whole) ? whole : null;
  const id = isPlainObject(reference.entity) ? reference.entity.id : undefined;
  const hash = Array.isArray(id) ? id[0] : undefined;
  if (typeof hash !== 'string') return null;
  const table = isPlainObject(doc.names) ? (doc.names as Json) : {};
  const level = (table[hash] ?? names[hash]) as unknown;
  const feature = isPlainObject(level) && isPlainObject(level.feature) ? level.feature.id : undefined;
  return typeof feature === 'string' && isSketchOf(doc, part, feature) ? feature : null;
}

/** The sketches the references anywhere inside `value` name, in the order found. */
export function sketchesNamedIn(doc: Doc, part: string, value: unknown, names: Json = {}): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isPlainObject(v)) return;
    const sketch = sketchOfReference(doc, part, v, names);
    if (sketch !== null) {
      if (!out.includes(sketch)) out.push(sketch);
      return;
    }
    for (const child of Object.values(v)) walk(child);
  };
  walk(value);
  return out;
}

/**
 * Which sketches to show, from the sketches the profiles come from (null for
 * a profile that names none), the sketches the feature's other inputs name,
 * and the sketch it was started from: the first of those three that gives
 * any, without repeats.
 */
export function sketchesToShow(
  profileSketches: readonly (string | null)[],
  otherSketches: readonly string[],
  from?: string | null,
): string[] {
  const unique = (ids: readonly (string | null | undefined)[]) => [
    ...new Set(ids.filter((s): s is string => typeof s === 'string')),
  ];
  const fromProfiles = unique(profileSketches);
  if (fromProfiles.length > 0) return fromProfiles;
  const fromOthers = unique(otherSketches);
  if (fromOthers.length > 0) return fromOthers;
  return unique([from]);
}

/** What a profile-based panel shows sketches from. */
export interface ProfileSketchInputs {
  profiles: readonly ExtrudeProfile[];
  /** The feature's other inputs and picks (direction, axis, path, guides), searched for references to sketches. */
  references?: readonly unknown[] | undefined;
  /** Inputs and picks whose sketches show with the profiles' rather than in place of them (a path, a guide, a rail). */
  alongside?: readonly unknown[] | undefined;
  /** Names of picks the form holds that are not in the document yet. */
  names?: Json | undefined;
  /** The sketch the panel was started from. */
  from?: string | null | undefined;
}

/** The sketches a profile-based panel shows, for its current inputs. */
export function profileSketches(doc: Doc, part: string, inputs: ProfileSketchInputs): string[] {
  const names = inputs.names ?? {};
  const ofProfiles = inputs.profiles.map((p) => ('kept' in p ? sketchOfReference(doc, part, p.kept, names) : p.sketch));
  const shown = sketchesToShow(ofProfiles, sketchesNamedIn(doc, part, inputs.references ?? [], names), inputs.from);
  return [...new Set([...shown, ...sketchesNamedIn(doc, part, inputs.alongside ?? [], names)])];
}

/** Shows `sketches` whatever their visibility, until the returned function is called. */
export function showSketches(app: AppStore, sketches: readonly string[]): () => void {
  const shown = [...sketches];
  app.setState({ shownSketches: shown });
  return () => {
    if (app.getState().shownSketches === shown) app.setState({ shownSketches: [] });
  };
}

/**
 * While a profile-based panel (Extrude, Revolve, Loft, Sweep) is open, its
 * sketches show as `profileSketches` chooses them, following its inputs;
 * closing it restores each sketch's own visibility.
 */
export function useProfileSketches(services: AppServices, part: string | null, inputs: ProfileSketchInputs): void {
  const doc = useDocument(services.editor);
  const sketches = part ? profileSketches(doc, part, inputs) : [];
  const key = sketches.join(',');
  // Keyed by the ids: the list is built on each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => sketches, [key]);
  useEffect(() => showSketches(services.app, stable), [services.app, stable]);
}
