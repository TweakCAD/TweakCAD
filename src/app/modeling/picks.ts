/**
 * Viewport picks as feature panels take them: what a clicked item is, the
 * body a face or edge lies on, a label for the panel's list, and the
 * reference to write, picked against the state the feature starts from.
 *
 * While a part is edited in an assembly's context, a click on another
 * instance names geometry of another part: a panel may read it (a face to
 * extrude to, a plane, an axis), and the pick becomes an in-context
 * reference; geometry the feature would change must be the part's own.
 */
import * as THREE from 'three';
import type { Display, EntityInfo, FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import { matrixOf } from '@tweakcad/worker/src/v2/service/picking';
import { assemblyDisplay, inContextOf, instanceIndex } from '../assembly/focus';
import { featureDisplayName, findFeature } from '../features';
import { isPickedRegion } from '../picking';
import type { SelectionItem, StandardDatum } from '../selection';
import type { AppServices, Measures } from '../services';
import type { FeatureTarget, PickedRef } from './feature';
import { STANDARD_FRAMES } from '../viewport/ModelScene';

/** The entity a key item names in the shown display (for an instance, in its part's definition). */
export function entityOf(display: Display | null, item: SelectionItem | null): EntityInfo | undefined {
  return item && 'key' in item ? display?.entities[item.key] : undefined;
}

/** Whether an item lies in another part: an instance of the assembly the part is edited in. */
export function inOtherPart(item: SelectionItem | null): boolean {
  return !!item && 'key' in item && item.instance !== undefined;
}

/** Why a feature cannot take another part's geometry where it would change it (9.1). */
export const OWN_GEOMETRY = 'Pick geometry of the part being edited';

/**
 * The matrix taking an item's own part frame into the frame the scene
 * shows: for another instance while a part is edited in context, its
 * placement relative to the edited instance; null when the frames agree.
 */
export function sceneMatrix(services: AppServices, item: SelectionItem): THREE.Matrix4 | null {
  if (!('key' in item) || !item.instance) return null;
  const ctx = inContextOf(services.editor.document, services.app.getState().focus);
  const shown = assemblyDisplay(services.display.getState().display, item.instance.assembly);
  const inst = shown?.instances[item.instance.index];
  if (!ctx || !shown || !inst) return null;
  const m = new THREE.Matrix4().fromArray(matrixOf(inst.placement));
  const own = shown.instances[instanceIndex(shown, ctx.at)];
  if (own) m.premultiply(new THREE.Matrix4().fromArray(matrixOf(own.placement)).invert());
  return m;
}

type V3 = [number, number, number];

/** Measures moved by `m`: points and directions, and the box around the moved corners. */
export function movedMeasures(measures: Measures, m: THREE.Matrix4): Measures {
  const point = (p: readonly number[]): V3 => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m).toArray() as V3;
  const direction = (d: readonly number[]): V3 =>
    new THREE.Vector3(d[0], d[1], d[2]).transformDirection(m).toArray() as V3;
  const out: Measures = { ...measures };
  if (measures.centroid) out.centroid = point(measures.centroid);
  if (measures.center) out.center = point(measures.center);
  if (measures.point) out.point = point(measures.point);
  if (measures.normal) out.normal = direction(measures.normal);
  if (measures.axis) out.axis = direction(measures.axis);
  if (measures.bbox) {
    const [lo, hi] = measures.bbox;
    const box = new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi)).applyMatrix4(m);
    out.bbox = [box.min.toArray() as V3, box.max.toArray() as V3];
  }
  return out;
}

/** A model entity's kind and measures in the frame the scene shows (the edited part's, in context). */
export async function propertiesOf(
  services: AppServices,
  item: SelectionItem,
): Promise<{ kind: string; measures: Measures } | null> {
  if (!('key' in item)) return null;
  const p = await services.client.properties(item.key);
  const m = p && sceneMatrix(services, item);
  return p && m ? { kind: p.kind, measures: movedMeasures(p.measures, m) } : p;
}

/**
 * The kind of model entity an item names: face, edge, body, curve, point,
 * region, construction, standard (a standard plane), feature. A standard
 * axis is an `axis` and the origin a `point`, as construction outputs are.
 */
export function kindOf(display: Display | null, item: SelectionItem | null): string | null {
  if (!item) return null;
  if ('standard' in item) return 'standard';
  if ('datum' in item) return item.datum === 'origin' ? 'point' : 'axis';
  if ('feature' in item) return 'feature';
  return entityOf(display, item)?.kind ?? null;
}

/** The body item a face, edge or body item lies on (through the same instance). */
export function bodyItem(display: Display | null, item: SelectionItem | null): SelectionItem | null {
  const info = entityOf(display, item);
  if (!info || info.body === null || !item || !('key' in item)) return null;
  return item.instance ? { key: info.body, instance: item.instance } : { key: info.body };
}

/** The shown name of a body key ("Body 2"). */
export function bodyName(display: Display | null, key: number): string {
  for (const d of display?.definitions ?? []) {
    for (const b of d.bodies) if (b.key === key) return b.name;
  }
  return 'Body';
}

/** A standard axis or the origin as the browser names it. */
export function datumLabel(datum: StandardDatum): string {
  return datum === 'origin' ? 'Origin Point' : `${datum.toUpperCase()} Axis`;
}

/** A feature's name as the browser shows it, or `fallback` when there is no such feature. */
function featureLabel(services: AppServices, id: string, fallback: string): string {
  const feature = findFeature(services.editor.document, id);
  return feature ? featureDisplayName(feature, services.editor.document) : fallback;
}

/** A label for a pick in a panel's list. */
export function labelOf(services: AppServices, item: SelectionItem): string {
  const display = services.display.getState().display;
  if ('standard' in item) return `${item.standard.toUpperCase()} plane`;
  if ('datum' in item) return datumLabel(item.datum);
  if ('feature' in item) return featureLabel(services, item.feature, 'Feature');
  const info = entityOf(display, item);
  switch (info?.kind) {
    case 'body':
      return bodyName(display, item.key);
    case 'face':
      return info.body === null ? 'Face' : `Face of ${bodyName(display, info.body)}`;
    case 'edge':
      return info.body === null ? 'Edge' : `Edge of ${bodyName(display, info.body)}`;
    case 'vertex':
      return 'Vertex';
    case 'point':
    case 'plane':
    case 'axis':
    case 'frame': {
      const feature = findFeature(services.editor.document, info.feature);
      if (feature?.type === 'core.sketch') return `Point of ${featureDisplayName(feature, services.editor.document)}`;
      return feature ? featureDisplayName(feature, services.editor.document) : 'Construction';
    }
    case 'curve':
      return `Curve of ${featureLabel(services, info.feature, 'Sketch')}`;
    default:
      return 'Pick';
  }
}

/**
 * The reference a panel stores for `item`, picked against the state its
 * feature starts from: before the feature when the shown evaluation holds
 * it (a preview, or the feature being edited). Null when the item is no
 * longer shown, or is not there before the feature.
 */
export async function pickFor(
  services: AppServices,
  target: FeatureTarget,
  item: SelectionItem,
  label?: string,
): Promise<PickedRef | null> {
  const holds = services.display.getState().preview || target.base !== undefined;
  const text = label ?? labelOf(services, item);
  const picked = await services.pick(item, holds ? { before: target.feature } : {});
  if (!picked || isPickedRegion(picked)) return null;
  return { reference: picked.reference, names: picked.names, label: text };
}

/**
 * The placement frame of a planar face, as the `plane` attachment mode
 * makes it (7.3): z the outward normal, origin the part origin projected
 * onto the face, x the part's x axis projected (its y axis when x is along
 * the normal). A key is read in its own part's frame; an item in the frame
 * the scene shows, so a face of another part edited in context gives the
 * frame the edited part sees. Null for a face that is not flat.
 */
export async function planarFrame(services: AppServices, at: number | SelectionItem): Promise<FrameDisplay | null> {
  const p = typeof at === 'number' ? await services.client.properties(at) : await propertiesOf(services, at);
  const n = p?.measures.normal;
  const c = p?.measures.centroid;
  if (!p || p.measures.surface !== 'plane' || !n || !c) return null;
  const normal: V3 = [n[0], n[1], n[2]];
  const d = normal[0] * c[0] + normal[1] * c[1] + normal[2] * c[2];
  const origin: V3 = [normal[0] * d, normal[1] * d, normal[2] * d];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const along = (a: V3): V3 => {
    const k = a[0] * normal[0] + a[1] * normal[1] + a[2] * normal[2];
    const v: V3 = [a[0] - normal[0] * k, a[1] - normal[1] * k, a[2] - normal[2] * k];
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const partX: V3 = [1, 0, 0];
  const x = Math.hypot(...cross(partX, normal)) <= 1e-9 ? along([0, 1, 0]) : along(partX);
  return { origin, x, y: cross(normal, x), normal };
}

/**
 * The frame the `plane` attachment mode makes on a picked plane (7.3), in
 * the frame the scene shows: a standard plane's, a construction plane's,
 * or a flat face's (`planarFrame`). Null for anything else.
 */
export async function planeFrameOf(services: AppServices, item: SelectionItem): Promise<FrameDisplay | null> {
  if ('standard' in item) return STANDARD_FRAMES[item.standard];
  if (!('key' in item)) return null;
  const display = services.display.getState().display;
  const kind = kindOf(display, item);
  if (kind === 'plane' && !item.instance) {
    const c = display?.definitions.flatMap((d) => d.construction).find((x) => x.key === item.key);
    return c && c.kind === 'plane' ? c.frame : null;
  }
  return kind === 'face' ? planarFrame(services, item) : null;
}
