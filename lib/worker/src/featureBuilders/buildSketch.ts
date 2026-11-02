/**
 * Sketch feature builder.
 * Resolves sketch entities from expressions to concrete geometry.
 * Does not create solid bodies - produces resolved profiles for downstream features.
 *
 * The resolved entity data is stored in featureOutputs so that buildExtrude
 * can read the actual dimensions (center, width, height, diameter) to create
 * the OCCT profile face.
 */

import { sketchBuildGeometry } from '@tweakcad/core/src/sketch/derivedGeometry.ts';
import { sketchHasParametricDimensions } from '@tweakcad/core/src/sketch/derivedFields.ts';
import { editorModelToBuildGeometry } from '@tweakcad/core/src/sketch/serialization.ts';
import { fromSnapshot } from '@tweakcad/core/src/sketch/operations.ts';
import { resolveSketchDimensions } from '../resolveSketchDimensions.ts';
import { ensureSketchSolver } from '../planegcsWorkerLoader.ts';
import type { FeatureNode, SketchFeatureInputs, SketchEntity } from '@tweakcad/core/src/document/schema.ts';
import type { EntityId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { detectSketchRegions } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { resolveSketchPlaneRef } from './resolvePlane.ts';

// ---- Resolved entity types (stored in featureOutputs) ----
//
// `ResolvedRectangle` was retired in task F together with the
// `SketchRectangleEntity` it shadowed (invariant #11 — no composite
// entities). Rectangles arrive here as 4 individual lines and resolve
// through the `'line'` branch in `buildSketch` below.

export type ResolvedCircle = {
  type: 'circle';
  center: [number, number];
  diameter: number;
};

export type ResolvedLine = {
  type: 'line';
  start: [number, number];
  end: [number, number];
};

export type ResolvedSketchEntityData = ResolvedCircle | ResolvedLine;

export type ResolvedSketchRegionData = SketchRegion;

export type ResolvedSketchPlaneData = {
  name: 'XY' | 'XZ' | 'YZ';
  origin: [number, number, number];
  uAxis: [number, number, number];
  vAxis: [number, number, number];
  normal: [number, number, number];
};

/**
 * Build a sketch feature.
 * Resolves entity expressions and stores the resolved sketch data as a feature output.
 * The sketch itself doesn't produce bodies - subsequent extrude/hole features consume the profile.
 */
export async function buildSketch(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as SketchFeatureInputs;

  // Parameter-driven dimensions: resolve each constraint's expression
  // against this rebuild's parameters and re-solve, so the geometry actually
  // moves. Only sketches that reference a parameter pay for a solve; the
  // rest return untouched. Until this existed, a parameter could change how
  // far a profile was extruded but never the profile itself.
  // Stored projection by default — unchanged for every sketch that does not
  // reference a parameter, which keeps the expression-valued coordinates
  // that make an imported component parametric working as they do today.
  let sketchGeometry = sketchBuildGeometry(inputs);
  if (sketchHasParametricDimensions(inputs.editorModel)) {
    await ensureSketchSolver();
    const resolved = resolveSketchDimensions(fromSnapshot(inputs.editorModel), params);
    for (const d of resolved.diagnostics) {
      console.warn(`[buildSketch ${node.id}] ${d}`);
    }
    if (resolved.solved) {
      sketchGeometry = editorModelToBuildGeometry(resolved.state);
    }
  }

  // Resolve all entity expressions to numeric values. We build TWO views
  // of the entities here:
  //   - `resolvedEntities`: stored as featureOutputs; downstream features
  //     (extrude, hole) read this for actual numeric geometry.
  //   - `literalEntities`: a parallel SketchEntity dict with expressions
  //     replaced by their resolved numeric literals, fed to
  //     `detectSketchRegions`. The detector uses `Number(value)` to read
  //     entity dimensions and silently drops anything that doesn't parse
  //     as a number, so passing it raw parameter-name expressions
  //     ('D', 'width * 2') makes it produce zero regions for the entity.
  const resolvedEntities: Record<string, ResolvedSketchEntityData> = {};
  const literalEntities: Record<EntityId, SketchEntity> = {};

  for (const [id, entity] of Object.entries(sketchGeometry)) {
    const eid = id as EntityId;
    if (entity.type === 'circle') {
      const cx = evaluateExpression(entity.center[0], params);
      const cy = evaluateExpression(entity.center[1], params);
      const d = evaluateExpression(entity.diameter, params);

      if (!cx.ok || !cy.ok || !d.ok) {
        throw new Error(`Failed to resolve circle ${id}: expression evaluation error`);
      }

      resolvedEntities[id] = {
        type: 'circle',
        center: [cx.value, cy.value],
        diameter: d.value,
      };
      literalEntities[eid] = {
        ...entity,
        center: [String(cx.value), String(cy.value)],
        diameter: String(d.value),
      };
    } else if (entity.type === 'line') {
      const sx = evaluateExpression(entity.start[0], params);
      const sy = evaluateExpression(entity.start[1], params);
      const ex = evaluateExpression(entity.end[0], params);
      const ey = evaluateExpression(entity.end[1], params);

      if (!sx.ok || !sy.ok || !ex.ok || !ey.ok) {
        throw new Error(`Failed to resolve line ${id}: expression evaluation error`);
      }

      resolvedEntities[id] = {
        type: 'line',
        start: [sx.value, sy.value],
        end: [ex.value, ey.value],
      };
      literalEntities[eid] = {
        ...entity,
        start: [String(sx.value), String(sy.value)],
        end: [String(ex.value), String(ey.value)],
      };
    } else {
      // Arc (and any future primitive curve types): not pre-resolved
      // here; pass through as-is. If the author used parameter
      // expressions for these, region detection will silently drop them
      // — a separate follow-up to extend the pre-resolve loop above to
      // cover all entity kinds.
      literalEntities[eid] = entity;
    }
  }

  // Resolve the sketch plane. Default planes resolve to canonical bases;
  // a sketch authored on a construction plane reads the upstream plane
  // output via the shared resolver — same plane shape regardless of
  // whether the source is a default plane or a Plane feature. A sketch on
  // a body face resolves the face on this rebuild, so it follows the face
  // when upstream dimensions move it, and fails when the face is gone.
  const plane: ResolvedSketchPlaneData = await resolveSketchPlaneRef(inputs.plane, context, params, kernel);

  const resolvedRegions = Object.fromEntries(
    detectSketchRegions(literalEntities).map(region => [region.id, region]),
  ) as Record<string, ResolvedSketchRegionData>;

  // Store resolved data as feature outputs
  // buildExtrude reads this via context.featureOutputs.get(sketchId)
  return {
    bodies: [],
    outputs: {
      faces: Object.fromEntries(
        Object.keys(resolvedEntities).map(eid => [eid, `sketch:${node.id}:${eid}`]),
      ),
      data: {
        resolvedEntities,
        resolvedRegions,
        plane,
        planeNormal: plane.normal,
      },
    },
  };
}
