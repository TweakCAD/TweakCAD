/**
 * Editor-model → build-geometry serialization.
 *
 * The sketch has two parallel representations in a feature's inputs:
 *
 *   1. `editorModel` (`SketchEditorSnapshot`) — point-based with
 *      shared IDs. What the in-browser sketch editor manipulates.
 *      Round-tripped across edit cycles so constraint references survive.
 *
 *   2. `buildGeometry` (`Record<EntityId, SketchEntity>`) — flat per-curve
 *      records with coordinates baked in as `Expression` strings.
 *      What the worker rebuilds from. The region detector
 *      (`profileRegions.detectSketchRegions`) reads this form.
 *
 * Both must be present and consistent. Every command handler that
 * mutates `editorModel` rebuilds `buildGeometry` through this serializer
 * (see [sketchDrawCommands.execute](../commands/handlers/sketchDrawCommands.ts))
 * so they stay in sync without a separate exit-time sync.
 *
 * **Invariant #11 — no composite entities.** This serializer emits one
 * document entity per editor geometry: every `line` becomes a
 * `SketchLineEntity`, every `circle` a `SketchCircleEntity`, every `arc`
 * a `SketchArcEntity`. There is no rectangle / slot / polygon collapse —
 * there are no composite schema types or naming-convention plumbing for
 * them. A rectangle in the document is 4
 * SketchLineEntity records held together by the constraints stored in
 * `editorModel`. The region detector still finds the closed loop and
 * the worker still builds the right face.
 *
 * The projection covers **ellipse, spline, and standalone point** in
 * addition to line/circle/arc — all
 * six primitive curves now have a document-entity counterpart. The
 * worker doesn't tessellate ellipse/spline/point yet (they pass through
 * `buildSketch` as foreign types and are silently dropped by
 * `detectSketchRegions`), but the projection is needed so the document
 * is self-describing, so `list_sketch_elements` reports entity ids
 * consistently, and so future kernel work on these primitives doesn't
 * need a serializer migration.
 */

import type {
  SketchEntity,
  SketchCircleEntity,
  SketchLineEntity,
  SketchArcEntity,
  SketchEllipseEntity,
  SketchSplineEntity,
  SketchBezierEntity,
  SketchPointEntity,
} from '../document/schema.ts';
import type { EntityId } from '../ids.ts';
import { entityId } from '../ids.ts';
import type { EditorState } from './operations.ts';

/**
 * Convert an `EditorState` into the document's flat `buildGeometry` Record.
 * Pure function — produces the same output for the same input.
 *
 * The output map's keys are `EntityId`s matching the source geometry
 * ids. This keeps cross-rebuild identity stable: open a sketch, edit
 * it, save it — the same lines re-emit the same entity ids so
 * downstream `ProfileRef.wireEntityIds` references survive.
 */
/**
 * Serialize a coordinate / dimension to its `buildGeometry` string form.
 *
 * Coordinate strings are evaluated as expressions at build time, and the
 * expression grammar has no exponent notation — so a value that `String()`
 * would render in scientific form (`String(1e-15)` → `"1e-15"`,
 * `String(1e-7)` → `"1e-7"`) must not reach the document, or the entity
 * fails to resolve with "expression evaluation error". This bites geometry
 * with floating-point noise: a coordinate that is geometrically 0 but lands
 * at `-2.66e-15` (FreeCAD's solved sketch coords, or a full arc's
 * `R*sin(π)` endpoint computed in the editor).
 *
 * Sub-nanometre magnitudes are noise — snap them to `0`. Anything else that
 * would stringify to exponent form is expanded to a plain decimal. Normal
 * values pass through `String()` unchanged so existing coordinates serialize
 * byte-for-byte as before.
 */
function coord(n: number): string {
  const s = String(n);
  if (!s.includes('e') && !s.includes('E')) return s;
  if (Math.abs(n) < 1e-9) return '0';
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

export function editorModelToBuildGeometry(
  state: EditorState,
): Record<EntityId, SketchEntity> {
  const result: Record<EntityId, SketchEntity> = {};

  for (const geom of state.geometries.values()) {
    switch (geom.type) {
      case 'line': {
        const start = state.points.get(geom.startId);
        const end = state.points.get(geom.endId);
        if (!start || !end) continue;
        const eId = entityId(String(geom.id));
        const entity: SketchLineEntity = {
          id: eId,
          type: 'line',
          start: [coord(start.x), coord(start.y)],
          end: [coord(end.x), coord(end.y)],
          ...(geom.construction ? { construction: true as const } : {}),
        };
        result[eId] = entity;
        break;
      }
      case 'circle': {
        const center = state.points.get(geom.centerId);
        if (!center) continue;
        const eId = entityId(String(geom.id));
        const entity: SketchCircleEntity = {
          id: eId,
          type: 'circle',
          center: [coord(center.x), coord(center.y)],
          diameter: coord(geom.radius * 2),
          ...(geom.construction ? { construction: true as const } : {}),
        };
        result[eId] = entity;
        break;
      }
      case 'arc': {
        // Document entity stores `startAngle` / `endAngle` (radians)
        // not point refs. Recompute them from the editor point coords
        // — that's the form the worker / region detector expects.
        const center = state.points.get(geom.centerId);
        const startPt = state.points.get(geom.startId);
        const endPt = state.points.get(geom.endId);
        if (!center || !startPt || !endPt) continue;
        const startAngle = Math.atan2(startPt.y - center.y, startPt.x - center.x);
        const endAngle = Math.atan2(endPt.y - center.y, endPt.x - center.x);
        const eId = entityId(String(geom.id));
        const entity: SketchArcEntity = {
          id: eId,
          type: 'arc',
          center: [coord(center.x), coord(center.y)],
          radius: coord(geom.radius),
          startAngle: coord(startAngle),
          endAngle: coord(endAngle),
          ...(geom.construction ? { construction: true as const } : {}),
        };
        result[eId] = entity;
        break;
      }
      case 'ellipse': {
        // Editor stores the major-axis end-point as a SketchPoint
        // reference; the document records the resolved coordinate so
        // the entity is self-contained (no point map to resolve at
        // read time). Same shape choice as line/circle/arc.
        const center = state.points.get(geom.centerId);
        const major = state.points.get(geom.majorId);
        if (!center || !major) continue;
        const eId = entityId(String(geom.id));
        const entity: SketchEllipseEntity = {
          id: eId,
          type: 'ellipse',
          center: [coord(center.x), coord(center.y)],
          majorEnd: [coord(major.x), coord(major.y)],
          minorRadius: coord(geom.minorRadius),
          ...(geom.construction ? { construction: true as const } : {}),
        };
        result[eId] = entity;
        break;
      }
      case 'spline': {
        const pts: [string, string][] = [];
        let missing = false;
        for (const pid of geom.pointIds) {
          const p = state.points.get(pid);
          if (!p) { missing = true; break; }
          pts.push([coord(p.x), coord(p.y)]);
        }
        if (missing || pts.length < 2) continue;
        const eId = entityId(String(geom.id));
        const entity: SketchSplineEntity = {
          id: eId,
          type: 'spline',
          points: pts,
          ...(geom.construction ? { construction: true as const } : {}),
        };
        result[eId] = entity;
        break;
      }
      case 'bezier': {
        const start = state.points.get(geom.startId);
        const cp1 = state.points.get(geom.cp1Id);
        const cp2 = state.points.get(geom.cp2Id);
        const end = state.points.get(geom.endId);
        if (!start || !cp1 || !cp2 || !end) continue;
        const eId = entityId(String(geom.id));
        const entity: SketchBezierEntity = {
          id: eId,
          type: 'bezier',
          start: [coord(start.x), coord(start.y)],
          cp1: [coord(cp1.x), coord(cp1.y)],
          cp2: [coord(cp2.x), coord(cp2.y)],
          end: [coord(end.x), coord(end.y)],
          ...(geom.construction ? { construction: true as const } : {}),
        };
        result[eId] = entity;
        break;
      }
      case 'point': {
        const p = state.points.get(geom.pointId);
        if (!p) continue;
        const eId = entityId(String(geom.id));
        const entity: SketchPointEntity = {
          id: eId,
          type: 'point',
          at: [coord(p.x), coord(p.y)],
          ...(geom.construction ? { construction: true as const } : {}),
        };
        result[eId] = entity;
        break;
      }
      // Any editor-side slot/polygon previews have no document-entity
      // counterpart and round-trip via `editorModel` only.
      default:
        break;
    }
  }

  return result;
}
