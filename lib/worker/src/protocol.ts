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
  SketchPlaneDisplay,
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
  /** World frames of the sketches placed on body faces, as resolved this rebuild. */
  sketchPlanes: SketchPlaneDisplay[];
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

/**
 * What to measure. Identified by the same stable ids the rest of the app
 * uses, not by kernel handles — those never leave the worker.
 */
export type MeasureTarget =
  | { kind: 'body'; bodyId: string }
  | { kind: 'face'; bodyId: string; stableFaceId: string }
  | { kind: 'edge'; bodyId: string; stableEdgeId: string };

/** All lengths in mm, areas in mm², volumes in mm³. */
export type MeasureResult =
  | { kind: 'body'; volume: number; surfaceArea: number; centerOfMass: [number, number, number]; boundingBox: { min: [number, number, number]; max: [number, number, number] } }
  | { kind: 'face'; area: number }
  | { kind: 'edge'; length: number };
