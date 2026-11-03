/**
 * Primitive feature builder — box, cylinder, sphere, cone, torus.
 *
 * Every shape is built in a canonical local frame and then placed by one
 * `kernel.transform` call:
 *
 *  - centred on the local origin, so `transform.position` is the centre;
 *  - axis of revolution along local +Y, matching the app's Y-up convention
 *    and the default XZ sketch plane.
 *
 * Doing the orientation in the transform rather than per-shape means a box
 * rotates the same way a cylinder does, and the shapes that *do* take an axis
 * in the kernel (`makeCylinder`, `makeCone`, `makeTorus`) are handed the
 * canonical +Y and left alone. Roll about the axis is a no-op for all three,
 * so nothing is lost by not passing a rotated axis through.
 *
 * Dimensions are `Expression`s, so a primitive is parametric: a box driven by
 * `plateWidth` tracks the parameter table like any other feature.
 */

import { releaseShapes } from './releaseShapes.ts';
import type {
  FeatureNode,
  PrimitiveFeatureInputs,
  PrimitiveShape,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { Vec3, Transform3D } from '@tweakcad/core/src/math.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { mintBodyId } from './bodyIdentity.ts';
import { selectTargetCandidates, joinTouchingBodies, cutTouchingBodies } from './bodyOperation.ts';
import type { EmittedBody } from './bodyOperation.ts';

/** Canonical axis of revolution in the primitive's local frame. */
const LOCAL_AXIS: Vec3 = [0, 1, 0];

export async function buildPrimitive(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as PrimitiveFeatureInputs;

  if (!inputs.shape) {
    throw new Error('Primitive feature has no shape');
  }

  const dims = resolveDimensions(inputs.shape, params);
  const local = await makeCanonicalBody(inputs.shape.kind, dims, node.id, kernel);
  const body = await place(local, inputs.transform, kernel, node.id);

  return applyOperation(node.id, inputs, body, context, kernel);
}

// --- Dimensions ---

/**
 * Evaluate every dimension on the shape and reject the ones that cannot
 * produce a solid.
 *
 * The check lives here rather than in the Zod schema because the stored
 * values are expressions — `"wall * 2"` has no sign until the parameter table
 * resolves, and the same document is valid or not depending on a parameter
 * the loader has not evaluated.
 */
function resolveDimensions(shape: PrimitiveShape, params: ResolvedParams): Record<string, number> {
  const read = (label: string, expression: string): number => {
    const result = evaluateExpression(expression, params);
    if (!result.ok) throw new Error(`Primitive ${label}: ${result.error}`);
    return result.value;
  };
  const positive = (label: string, expression: string): number => {
    const value = read(label, expression);
    if (!(value > 0)) throw new Error(`Primitive ${label} must be positive (got ${value})`);
    return value;
  };

  switch (shape.kind) {
    case 'box':
      return {
        width: positive('width', shape.width),
        height: positive('height', shape.height),
        depth: positive('depth', shape.depth),
      };
    case 'cylinder':
      return {
        radius: positive('radius', shape.radius),
        height: positive('height', shape.height),
      };
    case 'sphere':
      return { radius: positive('radius', shape.radius) };
    case 'cone': {
      // A cone may legitimately be pointed, so the top radius is allowed to
      // be zero — but not both ends, which is a line, not a solid.
      const bottomRadius = read('bottom radius', shape.bottomRadius);
      const topRadius = read('top radius', shape.topRadius);
      if (bottomRadius < 0 || topRadius < 0) {
        throw new Error('Primitive cone radii cannot be negative');
      }
      if (bottomRadius === 0 && topRadius === 0) {
        throw new Error('Primitive cone needs at least one non-zero radius');
      }
      return { bottomRadius, topRadius, height: positive('height', shape.height) };
    }
    case 'torus': {
      const majorRadius = positive('major radius', shape.majorRadius);
      const minorRadius = positive('minor radius', shape.minorRadius);
      // The kernel rejects this too, but catching it here names the feature
      // and the numbers; by the time it reaches a boolean the error names
      // neither.
      if (minorRadius >= majorRadius) {
        throw new Error(
          `Primitive torus minor radius (${minorRadius}) must be smaller than its ` +
            `major radius (${majorRadius}); otherwise the tube passes through itself`,
        );
      }
      return { majorRadius, minorRadius };
    }
  }
}

// --- Canonical construction ---

/**
 * Build the shape at the local origin. `featureId` is forwarded as the
 * topology-tracker origin so stable face/edge ids are deterministic per
 * feature across rebuilds.
 */
async function makeCanonicalBody(
  kind: PrimitiveShape['kind'],
  dims: Record<string, number>,
  featureId: string,
  kernel: CadKernel,
): Promise<KernelBody> {
  const d = (name: string): number => dims[name]!;

  switch (kind) {
    case 'box': {
      // `BoxSpec.origin` is the minimum corner, so half the extents back from
      // the local origin centres it.
      const result = await kernel.makeBox(
        {
          origin: [-d('width') / 2, -d('height') / 2, -d('depth') / 2],
          width: d('width'),
          height: d('height'),
          depth: d('depth'),
        },
        featureId,
      );
      return unwrap(result, 'box');
    }
    case 'cylinder': {
      // `CylinderSpec.center` is the base, so start half the height below the
      // local origin to centre it.
      const result = await kernel.makeCylinder(
        {
          center: [0, -d('height') / 2, 0],
          axis: LOCAL_AXIS,
          radius: d('radius'),
          height: d('height'),
        },
        featureId,
      );
      return unwrap(result, 'cylinder');
    }
    case 'sphere': {
      const result = await kernel.makeSphere({ center: [0, 0, 0], radius: d('radius') }, featureId);
      return unwrap(result, 'sphere');
    }
    case 'cone': {
      // `ConeSpec.center` is the base end, same as the cylinder.
      const result = await kernel.makeCone(
        {
          center: [0, -d('height') / 2, 0],
          axis: LOCAL_AXIS,
          radius1: d('bottomRadius'),
          radius2: d('topRadius'),
          height: d('height'),
        },
        featureId,
      );
      return unwrap(result, 'cone');
    }
    case 'torus': {
      const result = await kernel.makeTorus(
        {
          center: [0, 0, 0],
          axis: LOCAL_AXIS,
          majorRadius: d('majorRadius'),
          minorRadius: d('minorRadius'),
        },
        featureId,
      );
      return unwrap(result, 'torus');
    }
  }
}

function unwrap(
  result: { ok: true; value: KernelBody } | { ok: false; error: { message: string } },
  kind: string,
): KernelBody {
  if (!result.ok) throw new Error(`Failed to create ${kind}: ${result.error.message}`);
  return result.value;
}

// --- Placement ---

const IDENTITY_ROTATION: readonly number[] = [0, 0, 0, 1];

/**
 * Whether a transform would move the body at all. Skipping the kernel call
 * for the identity case is not just a speed matter — `kernel.transform`
 * produces a *new* body derived from the input, and the common case of a
 * primitive sitting at the origin has nothing to derive.
 */
function isIdentity(t: Transform3D | undefined): boolean {
  if (!t) return true;
  const [px, py, pz] = t.position;
  if (px !== 0 || py !== 0 || pz !== 0) return false;
  return t.rotation.every((component, i) => component === IDENTITY_ROTATION[i]);
}

async function place(
  body: KernelBody,
  transform: Transform3D | undefined,
  kernel: CadKernel,
  featureId: string,
): Promise<KernelBody> {
  if (isIdentity(transform) || !transform) return body;
  const result = await kernel.transform(body, transform, featureId);
  // `transform` returns a new body; the one at the origin is not used again.
  releaseShapes(kernel, [body]);
  if (!result.ok) throw new Error(`Failed to place primitive: ${result.error.message}`);
  return result.value;
}

// --- Boolean composition ---

/**
 * Same contract as Extrude's (see `bodyOperation.ts`): `newBody` publishes
 * the primitive on its own, `join` fuses it with the picked targets (or
 * without a pick the bodies it touches) and carries the first one's id,
 * publishing it on its own when there is nothing to join; `cut` removes it
 * from every candidate it overlaps.
 */
async function applyOperation(
  featureId: string,
  inputs: PrimitiveFeatureInputs,
  primitive: KernelBody,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const operands = {
    tools: [primitive],
    candidates: selectTargetCandidates(inputs.targetBodies, context),
    context,
    kernel,
    explicitTargets: (inputs.targetBodies?.length ?? 0) > 0,
  };
  let bodies: EmittedBody[];
  if (inputs.operation === 'join') {
    bodies = await joinTouchingBodies({
      ...operands,
      newBodies: async ([tool]) => [{ bodyId: mintBodyId(featureId), handle: tool! }],
      featureId,
    });
  } else if (inputs.operation === 'cut') {
    bodies = await cutTouchingBodies({ ...operands, featureId });
  } else {
    bodies = [{ bodyId: mintBodyId(featureId), handle: primitive }];
  }
  return {
    bodies,
    outputs: {
      bodies: Object.fromEntries(bodies.map((b, i) => [i === 0 ? 'main' : `body_${i}`, b.bodyId])) as Record<string, BodyId>,
    },
  };
}
