/**
 * ViewportStore - ephemeral state for display meshes and topology.
 * Uses Zustand. Not persisted, not undoable.
 * These are cached build outputs, not canonical data.
 */

import { createStore } from 'zustand/vanilla';
import type { DisplayMesh, TopologyMap, PartBuildArtifact, ConstructionPlaneDisplay, FeatureBuildResult } from '../document/schema.ts';
import type { PartId, BodyId, FeatureId } from '../ids.ts';

export type ViewportState = {
  /** Current display meshes for rendering */
  displayMeshes: DisplayMesh[];
  /** Topology maps for face/edge picking */
  topologyMaps: TopologyMap[];
  /** Build artifacts per part */
  partArtifacts: Record<PartId, PartBuildArtifact>;
  /** Mapping from bodyId to the featureId that produced it */
  bodyToFeatureMap: Record<BodyId, FeatureId>;
  /**
   * Construction planes to render in the viewport. Always defined (may
   * be empty). Replaced atomically on every rebuild.
   */
  constructionPlanes: ConstructionPlaneDisplay[];
  /**
   * Per-feature build status from the last rebuild, keyed by featureId.
   * The ProjectTree consumes this to surface failed/blocked/suppressed
   * indicators so the user can see at a glance when a feature's build
   * went wrong (instead of having to read the console diagnostics).
   * Empty before the first rebuild completes.
   */
  featureResults: Record<FeatureId, FeatureBuildResult>;
  /** Whether a rebuild is in progress */
  rebuilding: boolean;
  /** Error message if last rebuild failed */
  rebuildError: string | null;

  /** Set the latest rebuild result */
  setRebuildResult: (
    meshes: DisplayMesh[],
    topoMaps: TopologyMap[],
    constructionPlanes: ConstructionPlaneDisplay[],
    featureResults: FeatureBuildResult[],
    bodyToFeature?: Record<BodyId, FeatureId>,
  ) => void;
  /** Set rebuilding status */
  setRebuilding: (rebuilding: boolean) => void;
  /** Set rebuild error */
  setRebuildError: (error: string | null) => void;
  /** Clear all viewport data */
  clear: () => void;
};

export function createViewportStore() {
  return createStore<ViewportState>(set => ({
    displayMeshes: [],
    topologyMaps: [],
    partArtifacts: {} as Record<PartId, PartBuildArtifact>,
    bodyToFeatureMap: {} as Record<BodyId, FeatureId>,
    constructionPlanes: [],
    featureResults: {} as Record<FeatureId, FeatureBuildResult>,
    rebuilding: false,
    rebuildError: null,

    setRebuildResult: (
      meshes: DisplayMesh[],
      topoMaps: TopologyMap[],
      constructionPlanes: ConstructionPlaneDisplay[],
      featureResults: FeatureBuildResult[],
      bodyToFeature?: Record<BodyId, FeatureId>,
    ) => {
      const fr = {} as Record<FeatureId, FeatureBuildResult>;
      for (const r of featureResults) fr[r.featureId] = r;
      set({
        displayMeshes: meshes,
        topologyMaps: topoMaps,
        constructionPlanes,
        featureResults: fr,
        bodyToFeatureMap: bodyToFeature ?? {} as Record<BodyId, FeatureId>,
        rebuilding: false,
        rebuildError: null,
      });
    },

    setRebuilding: (rebuilding: boolean) => set({ rebuilding }),

    setRebuildError: (error: string | null) =>
      set({ rebuildError: error, rebuilding: false }),

    clear: () =>
      set({
        displayMeshes: [],
        topologyMaps: [],
        partArtifacts: {} as Record<PartId, PartBuildArtifact>,
        bodyToFeatureMap: {} as Record<BodyId, FeatureId>,
        constructionPlanes: [],
        featureResults: {} as Record<FeatureId, FeatureBuildResult>,
        rebuilding: false,
        rebuildError: null,
      }),
  }));
}
