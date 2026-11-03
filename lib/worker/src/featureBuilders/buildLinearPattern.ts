/**
 * Linear (rectangular) body pattern builder.
 *
 * v1 = body-level: replicates `inputs.sourceBody` along `inputs.direction`
 * `count` times at `spacing` mm intervals. This is the body-level
 * "rectangular pattern" operation.
 *
 * Output: the source body keeps its id and stays in the context so other
 * features can reference it. Each of the `count - 1` copies is its own
 * body, `body_<featureId>_<i>` for i = 0 … count - 2 in order along the
 * direction, so the bodies list, the viewport and booleans see every
 * instance separately.
 *
 * Direction resolution:
 *   - `{ type: 'x' }` → world +X
 *   - `{ type: 'y' }` → world +Y
 *   - `{ type: 'z' }` → world +Z
 *   - `{ type: 'custom'; direction }` → the user-supplied direction
 *     (origin is ignored — linear pattern only consumes a direction
 *     vector). v1 dialog only emits x/y/z; custom lights up when a
 *     "direction from edge" picker lands.
 *
 * Topology naming: each copy is a `translateWithHistory` of the source,
 * so every face on a copy carries its source face's stable ID.
 */

import type {
  FeatureNode,
  LinearPatternInputs,
  AxisSpec,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { Vec3 } from '@tweakcad/core/src/math.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { mintBodyId } from './bodyIdentity.ts';

export async function buildLinearPattern(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as LinearPatternInputs;

  // 1. Source body.
  if (!inputs.sourceBody?.bodyId) {
    throw new Error('Linear Pattern requires sourceBody');
  }
  const sourceBodyId = inputs.sourceBody.bodyId;
  const sourceHandle = context.bodies.get(sourceBodyId as BodyId);
  if (!sourceHandle) {
    throw new Error(
      `Linear Pattern source body ${sourceBodyId} not in build context — ` +
      `the upstream feature that produced it may have failed.`,
    );
  }
  const sourceBody = sourceHandle as KernelBody;

  // 2. Direction vector.
  const direction = resolveDirection(inputs.direction);

  // 3. Count + spacing.
  const countResult = evaluateExpression(inputs.count, params);
  if (!countResult.ok) {
    throw new Error(`Failed to resolve pattern count: ${countResult.error}`);
  }
  const count = Math.round(countResult.value);
  if (count < 1) {
    throw new Error(`Pattern count must be at least 1 (got ${count})`);
  }

  const spacingResult = evaluateExpression(inputs.spacing, params);
  if (!spacingResult.ok) {
    throw new Error(`Failed to resolve pattern spacing: ${spacingResult.error}`);
  }
  if (spacingResult.value <= 0) {
    throw new Error(`Pattern spacing must be positive (got ${spacingResult.value})`);
  }

  // 4. Kernel call.
  const patternResult = await kernel.linearPattern(
    sourceBody,
    direction,
    count,
    spacingResult.value,
    node.id,
  );
  if (!patternResult.ok) {
    throw new Error(`Linear Pattern failed: ${patternResult.error.message}`);
  }

  // 5. Publish each copy as a new body. Source stays in context so
  // downstream features can reference it (newBody-like semantics —
  // pattern doesn't consume the source).
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
 * AxisSpec → Vec3 direction. Origin is dropped (linear pattern only
 * consumes the direction component). Custom directions are normalized;
 * zero-length custom vectors fall back to +X with a console warning
 * (rather than throwing — the dialog should have validated, but a
 * paranoid kernel call is cheap insurance).
 */
function resolveDirection(axis: AxisSpec): Vec3 {
  if (axis.type === 'x') return [1, 0, 0];
  if (axis.type === 'y') return [0, 1, 0];
  if (axis.type === 'z') return [0, 0, 1];
  // custom
  const [x, y, z] = axis.direction;
  const len = Math.hypot(x, y, z);
  if (len === 0) {
    console.warn('[buildLinearPattern] Custom direction has zero length; using +X');
    return [1, 0, 0];
  }
  return [x / len, y / len, z / len];
}
