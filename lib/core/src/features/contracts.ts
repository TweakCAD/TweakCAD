/**
 * Feature builder contracts.
 * These types are defined in core to avoid circular dependencies.
 * The kernel-specific types (KernelBody, CadKernel) are generic -
 * actual kernel implementations are injected at runtime in the worker.
 */

import type { FeatureId, BodyId } from '../ids.ts';
import type { FeatureNode, TopologyMap } from '../document/schema.ts';
import type { ResolvedParams } from '../expressions.ts';

/** Resolved feature inputs (expressions evaluated to numbers) */
export type ResolvedFeature = {
  node: FeatureNode;
  params: ResolvedParams;
};

/** Context available during the build of each feature */
export type BuildContext = {
  /** Current bodies - map of bodyId to opaque kernel handle */
  bodies: Map<BodyId, unknown>;
  /** Topology maps for each body */
  topologyMaps: Map<BodyId, TopologyMap>;
  /** Resolved parameter values */
  params: ResolvedParams;
  /** Outputs from previous features (semantic refs) */
  featureOutputs: Map<FeatureId, FeatureOutputs>;
};

/** Result of building a single feature */
export type BuildResult = {
  bodies: { bodyId: BodyId; handle: unknown }[];
  outputs?: FeatureOutputs;
};

/** Named outputs from a feature (semantic references) */
export type FeatureOutputs = {
  bodies?: Record<string, BodyId>;
  faces?: Record<string, string>;
  /** Custom data from the feature builder (e.g., resolved sketch entities, plane normal) */
  data?: Record<string, unknown>;
};

/**
 * A feature builder function.
 * Takes resolved inputs + build context + kernel (as unknown, cast in worker).
 */
export type FeatureBuilder = (
  resolved: ResolvedFeature,
  context: BuildContext,
  kernel: unknown,
) => Promise<BuildResult>;

/**
 * Create an empty build context.
 * @param params - Resolved parameters
 * @returns Empty BuildContext ready for feature pipeline
 */
export function emptyBuildContext(params: ResolvedParams): BuildContext {
  return {
    bodies: new Map(),
    topologyMaps: new Map(),
    params,
    featureOutputs: new Map(),
  };
}
