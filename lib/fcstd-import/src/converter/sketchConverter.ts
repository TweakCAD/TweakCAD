/**
 * Convert a parsed FreeCAD sketch into a CadProject SketchFeatureInputs.
 *
 * Geometry is built through the editor's `operations.ts` builders (the same
 * path the DXF importer and the live editor use), so the sketch carries a
 * full `editorModel` (editing source of truth) and a derived `buildGeometry`:
 *   - Part::GeomLineSegment  → drawLine   → line
 *   - Part::GeomCircle       → drawCircle → circle (diameter = Radius * 2)
 *   - Part::GeomArcOfCircle  → drawArc    → arc
 * Construction flag preserved verbatim. Ellipse / spline / point geometry is
 * not yet imported (FreeCAD-import follow-up); such geometry is skipped.
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
  PlaneRef,
  FeatureNode,
  SketchEditorSnapshot,
} from '@tweakcad/core/src/document/schema.ts';
import {
  emptyEditorState,
  drawLine,
  drawCircle,
  drawArc,
  toSnapshot,
  type EditorState,
} from '@tweakcad/core/src/sketch/operations.ts';
import type { FcSketchObject, FcGeometry } from '../types/fcstdTypes.ts';

export type SketchConversionResult = {
  feature: FeatureNode;
  /** EntityIds of every non-construction geometry, in original geometry index order. */
  wireEntityIds: EntityId[];
  /** Geometry indices in the FreeCAD GeometryList that were skipped (e.g. ellipses, splines). */
  skippedGeometry: { index: number; rawType: string }[];
  /** FreeCAD geometry type → how many of that type were imported. */
  importedGeometry: Record<string, number>;
};

const FC_GEOMETRY_TYPE: Record<Exclude<FcGeometry['kind'], 'unsupported'>, string> = {
  lineSegment: 'Part::GeomLineSegment',
  circle: 'Part::GeomCircle',
  arcOfCircle: 'Part::GeomArcOfCircle',
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
  // Build the editor model (the editing source of truth) by routing each
  // FreeCAD geometry through the same `operations.ts` builders the editor and
  // the DXF importer use, then derive `buildGeometry` from it. Shared
  // endpoints merge via the builders' `findOrCreatePoint`, so a closed
  // FreeCAD profile imports as a connected, editable loop.
  let state: EditorState = emptyEditorState();
  const wireEntityIds: EntityId[] = [];
  const skipped: { index: number; rawType: string }[] = [];
  const importedGeometry: Record<string, number> = {};

  sketch.geometry.forEach((geom, idx) => {
    const drawn = drawFcGeometry(state, geom);
    if (!drawn) {
      skipped.push({ index: idx, rawType: (geom as { rawType?: string }).rawType ?? geom.kind });
      return;
    }
    state = drawn.state;
    if (geom.kind !== 'unsupported') {
      const type = FC_GEOMETRY_TYPE[geom.kind];
      importedGeometry[type] = (importedGeometry[type] ?? 0) + 1;
    }
    // `editorModelToBuildGeometry` keys each entity by its geometry id, so the
    // wire / order references use that same id.
    const eid = entityId(String(drawn.geometryId));
    if (geom.construction !== true) wireEntityIds.push(eid);
  });

  const inputs: SketchFeatureInputs = {
    plane: planeFromSupport(sketch.supportName),
    editorModel: toSnapshot(state) as unknown as SketchEditorSnapshot,
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

  return { feature, wireEntityIds, skippedGeometry: skipped, importedGeometry };
}

/**
 * Route one FreeCAD geometry through the matching editor builder. Returns the
 * updated state plus the new geometry's id, or `undefined` for an unsupported
 * kind or degenerate input (the builders throw on zero radius / zero-length,
 * which we treat as "skip and keep importing the rest").
 *
 * Ellipse / spline / point geometry and FreeCAD constraints are not yet
 * imported — that's the FreeCAD-import follow-up.
 */
function drawFcGeometry(
  state: EditorState,
  geom: FcGeometry,
): { state: EditorState; geometryId: string } | undefined {
  const construction = geom.construction === true;
  try {
    switch (geom.kind) {
      case 'lineSegment': {
        const r = drawLine(state, [geom.startX, geom.startY], [geom.endX, geom.endY], { construction });
        return { state: r.state, geometryId: r.lineId };
      }
      case 'circle': {
        const r = drawCircle(state, { center: [geom.centerX, geom.centerY], radius: geom.radius }, { construction });
        return { state: r.state, geometryId: r.circleId };
      }
      case 'arcOfCircle': {
        const r = drawArc(
          state,
          {
            center: [geom.centerX, geom.centerY],
            radius: geom.radius,
            startAngle: geom.startAngle,
            endAngle: geom.endAngle,
          },
          { construction },
        );
        return { state: r.state, geometryId: r.arcId };
      }
      case 'unsupported':
        return undefined;
    }
  } catch {
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
