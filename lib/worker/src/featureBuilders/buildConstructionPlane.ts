/**
 * Construction-plane feature builder.
 *
 * Produces no body — a construction plane is pure reference geometry.
 * The builder evaluates the inputs into a concrete plane basis (origin +
 * uAxis + vAxis + normal) and stashes it on `featureOutputs[featureId]`
 * under `data.plane` using the same shape `buildSketch` writes for its
 * own plane. Downstream consumers (sketches sketched on the plane, Hole
 * faces referencing it) resolve the ref via {@link resolvePlaneRef} and
 * see the same `ResolvedSketchPlaneData` shape regardless of source.
 *
 * v1 supports `kind: 'offsetFromDefault'` (parallel to XY/XZ/YZ with a
 * signed offset). v2 will add `offsetFromFace`, `angleThroughEdge`, and
 * `threePoint` modes once the corresponding pickers ship.
 */

import type { FeatureNode, ConstructionPlaneFeatureInputs } from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import type { ResolvedSketchPlaneData } from './buildSketch.ts';
import {
  evalNumberOrThrow,
  offsetPlaneAlongNormal,
  resolveFacePlaneRef,
  resolvePlaneRef,
} from './resolvePlane.ts';

export async function buildConstructionPlane(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as ConstructionPlaneFeatureInputs;

  let plane: ResolvedSketchPlaneData;
  const extraData: Record<string, unknown> = {};

  if (inputs.kind === 'offsetFromPlane') {
    // basePlane is any PlaneRef — default plane or another construction
    // plane. resolvePlaneRef handles both uniformly so the builder
    // doesn't need to branch on the underlying source.
    const basePlane = resolvePlaneRef(inputs.basePlane, context, params);
    const offset = evalNumberOrThrow(inputs.offset, params, `plane offset (${node.id})`);
    plane = offsetPlaneAlongNormal(basePlane, offset);
    // Surface base-plane-name in the data for UX (timeline label /
    // sketch-on-CP editor orientation hint).
    if (inputs.basePlane.type === 'defaultPlane') {
      extraData['basePlane'] = inputs.basePlane.name;
    }
    extraData['offset'] = offset;
  } else if (inputs.kind === 'offsetFromFace') {
    // Extract the face's tangent plane through the kernel, then walk
    // along its outward normal by `offset` mm. The u/v basis comes from
    // Gram-Schmidt off the normal (same path used by makeCylinder's
    // orientation matrix), so the choice is stable across rebuilds.
    const facePlane = await resolveFacePlaneRef(inputs.face, context, params, kernel);
    const offset = evalNumberOrThrow(inputs.offset, params, `plane offset (${node.id})`);
    plane = offsetPlaneAlongNormal(facePlane, offset);
    extraData['offset'] = offset;
  } else {
    // Exhaustive guard — adding a new union variant trips a compile error here.
    const _exhaustive: never = inputs;
    void _exhaustive;
    throw new Error(`Unsupported construction plane kind: ${(inputs as { kind: string }).kind}`);
  }

  return {
    bodies: [],
    outputs: {
      // The plane goes under `data.plane` to mirror buildSketch's
      // output shape — so resolvePlaneRef can read it back uniformly
      // regardless of whether the upstream feature is a sketch or a
      // construction plane.
      data: {
        plane,
        planeNormal: plane.normal,
        ...extraData,
      },
    },
  };
}
