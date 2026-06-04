/**
 * Convert a parsed FreeCAD sketch into a CadProject SketchFeatureInputs.
 *
 * Geometry mapping:
 *   - Part::GeomLineSegment  → SketchLineEntity
 *   - Part::GeomCircle       → SketchCircleEntity (diameter = Radius * 2)
 *   - Part::GeomArcOfCircle  → SketchArcEntity
 * Construction flag preserved verbatim.
 *
 * Plane mapping: Support link target XY_Plane / XZ_Plane / YZ_Plane
 * maps directly to defaultPlane. Anything else falls back to XY with a
 * diagnostic.
 *
 * Constraints are deliberately *not* converted in this phase — the importer
 * emits a single "constraints not imported yet" diagnostic per sketch (see
 * projectConverter). Geometry is fully resolved (coordinates are pre-solved
 * in the file) so the imported model is geometrically correct without them.
 */

import type { EntityId, FeatureId } from '@tweakcad/core/src/ids.ts';
import { entityId, featureId, generateId } from '@tweakcad/core/src/ids.ts';
import type {
  SketchFeatureInputs,
  SketchEntity,
  SketchLineEntity,
  SketchCircleEntity,
  SketchArcEntity,
  PlaneRef,
  FeatureNode,
} from '@tweakcad/core/src/document/schema.ts';
import type { FcSketchObject, FcGeometry } from '../types/fcstdTypes.ts';

export type SketchConversionResult = {
  feature: FeatureNode;
  /** EntityIds of every non-construction geometry, in original geometry index order. */
  wireEntityIds: EntityId[];
  /** Geometry indices in the FreeCAD GeometryList that were skipped (e.g. ellipses, splines). */
  skippedGeometry: { index: number; rawType: string }[];
};

/**
 * Convert a single Sketcher::SketchObject.
 *
 * @param sketch - The parsed sketch object
 * @param createdAt - ISO timestamp used for both createdAt and updatedAt on the resulting feature
 * @returns The sketch feature node plus mapping data needed by the extrude
 *   converter
 */
export function convertSketch(
  sketch: FcSketchObject,
  createdAt: string,
): SketchConversionResult {
  const entities: Record<EntityId, SketchEntity> = {};
  const entityOrder: EntityId[] = [];
  const wireEntityIds: EntityId[] = [];
  const skipped: { index: number; rawType: string }[] = [];

  sketch.geometry.forEach((geom, idx) => {
    const id = entityId(generateId('ent'));
    const entity = geometryToEntity(geom, id);
    if (!entity) {
      skipped.push({ index: idx, rawType: (geom as { rawType?: string }).rawType ?? geom.kind });
      return;
    }
    entities[id] = entity;
    entityOrder.push(id);
    if (entity.construction !== true) wireEntityIds.push(id);
  });

  const inputs: SketchFeatureInputs = {
    plane: planeFromSupport(sketch.supportName),
    entities,
    entityOrder,
  };

  const fid = featureId(generateId('feat'));
  const feature: FeatureNode = {
    id: fid,
    type: 'sketch',
    name: sketch.label ?? sketch.name,
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt,
    updatedAt: createdAt,
  };

  return { feature, wireEntityIds, skippedGeometry: skipped };
}

function geometryToEntity(geom: FcGeometry, id: EntityId): SketchEntity | undefined {
  switch (geom.kind) {
    case 'lineSegment': {
      const line: SketchLineEntity = {
        id,
        type: 'line',
        start: [String(geom.startX), String(geom.startY)],
        end: [String(geom.endX), String(geom.endY)],
      };
      if (geom.construction) line.construction = true;
      return line;
    }
    case 'circle': {
      const diameter = geom.radius * 2;
      const circle: SketchCircleEntity = {
        id,
        type: 'circle',
        center: [String(geom.centerX), String(geom.centerY)],
        diameter: String(diameter),
      };
      if (geom.construction) circle.construction = true;
      return circle;
    }
    case 'arcOfCircle': {
      const arc: SketchArcEntity = {
        id,
        type: 'arc',
        center: [String(geom.centerX), String(geom.centerY)],
        radius: String(geom.radius),
        startAngle: String(geom.startAngle),
        endAngle: String(geom.endAngle),
      };
      if (geom.construction) arc.construction = true;
      return arc;
    }
    case 'unsupported':
      return undefined;
  }
}

/**
 * Map a FreeCAD support link to one of our default planes.
 *
 * Non-default supports (sketches attached to a face on an existing body, or
 * to a DatumPlane) fall through to XY with a warning surfaced by the caller
 * via the returned discriminator.
 */
export function planeFromSupport(supportName: string | undefined): PlaneRef {
  switch (supportName) {
    case 'XY_Plane':
      return { type: 'defaultPlane', name: 'XY' };
    case 'XZ_Plane':
      return { type: 'defaultPlane', name: 'XZ' };
    case 'YZ_Plane':
      return { type: 'defaultPlane', name: 'YZ' };
    default:
      return { type: 'defaultPlane', name: 'XY' };
  }
}

/** True if the support resolves to a known default plane. */
export function isKnownDefaultPlane(supportName: string | undefined): boolean {
  return supportName === 'XY_Plane' || supportName === 'XZ_Plane' || supportName === 'YZ_Plane';
}

export type SketchEntityMapping = {
  sketchFeatureId: FeatureId;
  wireEntityIds: EntityId[];
};
