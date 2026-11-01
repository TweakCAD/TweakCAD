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
 * Output: the source body keeps its id and stays in the context. Each of
 * the `count - 1` copies is its own body, `body_<featureId>_<i>` for
 * i = 0 … count - 2 in rotation order, so the bodies list, the viewport
 * and booleans see every instance separately.
 *
 * `fullAngle`: the kernel's `circularPattern(body, axis, count)` always
 * spreads the instances over a full turn (step 360° / count). Partial
 * sweeps are not wired yet, so anything other than 360° logs a warning
 * and builds the full turn.
 */

import type {
  FeatureNode,
  CircularPatternInputs,
  AxisSpec,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody, ResolvedAxis } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { mintBodyId } from './bodyIdentity.ts';

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

  // 4. fullAngle. Only full 360° turns are built; warn if the user
  // asked for a partial sweep and proceed with 360.
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

  // 6. Publish — source stays in context, each copy under its own id.
  const copies = patternResult.value.map((handle, i) => ({ bodyId: mintBodyId(node.id, i), handle }));
  return {
    bodies: copies,
    outputs: {
      bodies: Object.fromEntries(
        copies.map((b, i) => [i === 0 ? 'main' : `body_${i}`, b.bodyId]),
      ) as Record<string, BodyId>,
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
