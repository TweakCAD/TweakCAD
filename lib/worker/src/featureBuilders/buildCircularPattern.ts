/**
 * Circular (polar) body pattern builder.
 *
 * v1 = body-level: replicates `inputs.sourceBody` around `inputs.axis`
 * `count` times across `fullAngle` degrees (default 360°). This is the
 * body-level "circular pattern" operation.
 *
 * Axis resolution:
 *   - `{ type: 'x' }` → world X axis at origin
 *   - `{ type: 'y' }` → world Y axis at origin
 *   - `{ type: 'z' }` → world Z axis at origin
 *   - `{ type: 'custom'; origin; direction }` → user-supplied
 *     (v1 dialog only emits x/y/z; "axis from edge/face" picker
 *     lights up custom later)
 *
 * Note: our kernel's `circularPattern(body, axis, count)` always
 * sweeps 2π distributed over `count` instances. To honor `fullAngle`
 * we re-derive the per-step angle here and stop OCCT short — but
 * occt-wasm doesn't expose a partial-sweep variant, so v1 forces
 * `fullAngle = 360°` and treats anything else as a v2 follow-up.
 * Reflected at runtime as a warn-log + clamp to 360.
 */

import type {
  FeatureNode,
  CircularPatternInputs,
  AxisSpec,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import { bodyId as bodyIdBrand } from '@tweakcad/core/src/ids.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody, ResolvedAxis } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';

export async function buildCircularPattern(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as CircularPatternInputs;

  // 1. Source body.
  if (!inputs.sourceBody?.bodyId) {
    throw new Error('Circular Pattern requires sourceBody');
  }
  const sourceBodyId = inputs.sourceBody.bodyId;
  const sourceHandle = context.bodies.get(sourceBodyId as BodyId);
  if (!sourceHandle) {
    throw new Error(
      `Circular Pattern source body ${sourceBodyId} not in build context — ` +
      `the upstream feature that produced it may have failed.`,
    );
  }
  const sourceBody = sourceHandle as KernelBody;

  // 2. Rotation axis.
  const axis = resolveAxis(inputs.axis);

  // 3. Count.
  const countResult = evaluateExpression(inputs.count, params);
  if (!countResult.ok) {
    throw new Error(`Failed to resolve pattern count: ${countResult.error}`);
  }
  const count = Math.round(countResult.value);
  if (count < 1) {
    throw new Error(`Pattern count must be at least 1 (got ${count})`);
  }

  // 4. fullAngle. v1 only supports full 360° revolutions because our
  // kernel's circularPattern is fixed-sweep. Warn if the user asked
  // for partial and proceed with 360.
  if (inputs.fullAngle !== undefined) {
    const angleResult = evaluateExpression(inputs.fullAngle, params);
    if (angleResult.ok && Math.abs(angleResult.value - 360) > 0.01) {
      console.warn(
        `[buildCircularPattern] fullAngle=${angleResult.value}° not yet supported; using 360°.`,
      );
    }
  }

  // 5. Kernel call.
  const patternResult = await kernel.circularPattern(sourceBody, axis, count);
  if (!patternResult.ok) {
    throw new Error(`Circular Pattern failed: ${patternResult.error.message}`);
  }

  // 6. Publish — source stays in context, pattern under a fresh id.
  const newBodyId = bodyIdBrand(`body_${node.id}_0`);
  return {
    bodies: [{ bodyId: newBodyId, handle: patternResult.value }],
    outputs: {
      bodies: { main: newBodyId },
    },
  };
}

/**
 * AxisSpec → ResolvedAxis (origin + direction). World-aligned axes
 * pin origin to world (0,0,0); custom passes the user's origin
 * through verbatim. Custom direction is normalized; zero-length
 * falls back to +Z with a warning.
 */
function resolveAxis(axis: AxisSpec): ResolvedAxis {
  if (axis.type === 'x') return { origin: [0, 0, 0], direction: [1, 0, 0] };
  if (axis.type === 'y') return { origin: [0, 0, 0], direction: [0, 1, 0] };
  if (axis.type === 'z') return { origin: [0, 0, 0], direction: [0, 0, 1] };
  // custom
  const [x, y, z] = axis.direction;
  const len = Math.hypot(x, y, z);
  if (len === 0) {
    console.warn('[buildCircularPattern] Custom axis direction has zero length; using +Z');
    return { origin: axis.origin, direction: [0, 0, 1] };
  }
  return {
    origin: axis.origin,
    direction: [x / len, y / len, z / len],
  };
}
