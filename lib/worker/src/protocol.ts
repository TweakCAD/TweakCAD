/**
 * Worker communication protocol types.
 * All data crossing the worker boundary must be structurally cloneable.
 */

import type {
  CadPart,
  CadProject,
  DisplayMesh,
  TopologyMap,
  FeatureBuildResult,
  ConstructionPlaneDisplay,
} from '@tweakcad/core/src/document/schema.ts';
import type { PartId, BodyId } from '@tweakcad/core/src/ids.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';

/** Result of a full or incremental rebuild */
export type RebuildResult = {
  partId: PartId;
  status: 'success' | 'partial' | 'failed';
  featureResults: FeatureBuildResult[];
  meshes: DisplayMesh[];
  topologyMaps: TopologyMap[];
  bodies: { bodyId: BodyId; handle: KernelBody }[];
  /**
   * Construction planes for the viewport to render as translucent
   * rectangles. Populated from `featureOutputs` of every
   * `constructionPlane` feature in the timeline. Always present (may be
   * empty); the viewport replaces its CP layer on every rebuild.
   */
  constructionPlanes: ConstructionPlaneDisplay[];
  /** Mapping from bodyId to the featureId that created it */
  bodyToFeatureMap: Record<string, string>;
  diagnostics: string[];
};

/** Context for a quick preview rebuild (during drag) */
export type PreviewContext = {
  part: CadPart;
  project: CadProject;
  featureIndex: number;
  overrideValue: unknown;
  overridePath: string[];
};

/** Build request sent to worker */
export type BuildPartRequest = {
  part: CadPart;
  project: CadProject;
  fromIndex?: number;
};

/** Export request sent to worker */
export type ExportRequest = {
  format: 'stl' | 'step';
  part: CadPart;
  project: CadProject;
};
