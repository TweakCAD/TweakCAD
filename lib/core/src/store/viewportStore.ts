/**
 * ViewportStore - ephemeral state for display meshes and topology.
 * Uses Zustand. Not persisted, not undoable.
 * These are cached build outputs, not canonical data.
 */

import { createStore } from 'zustand/vanilla';
import type { DisplayMesh, TopologyMap, PartBuildArtifact, ConstructionPlaneDisplay, FeatureBuildResult, SketchPlaneDisplay } from '../document/schema.ts';
import type { PartId, BodyId, FeatureId } from '../ids.ts';

/** One part's slice of a rebuild, kept so the others survive its republish. */
export type PartRebuildResult = {
  meshes: DisplayMesh[];
  topoMaps: TopologyMap[];
  constructionPlanes: ConstructionPlaneDisplay[];
  sketchPlanes: SketchPlaneDisplay[];
  featureResults: FeatureBuildResult[];
  bodyToFeature: Record<BodyId, FeatureId>;
};

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
   * World frames of the sketches placed on body faces, as the last rebuild
   * resolved them. The editor draws such a sketch here; it can't resolve
   * the face itself.
   */
  sketchPlanes: SketchPlaneDisplay[];
  /**
   * The last rebuild result per part. The flat fields above are the
   * concatenation of these, which is what the viewport, the tree and
   * the pickers all read.
   *
   * Parts rebuild one at a time — the scheduler walks them, and a
   * dirty feature only re-runs its own part — so a publish that
   * replaced the flat lists wholesale showed the part that happened to
   * finish last and nothing else.
   */
  resultsByPart: Record<PartId, PartRebuildResult>;
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

  /** Publish one part's rebuild result, merging it with the others. */
  setRebuildResult: (
    partId: PartId,
    meshes: DisplayMesh[],
    topoMaps: TopologyMap[],
    constructionPlanes: ConstructionPlaneDisplay[],
    featureResults: FeatureBuildResult[],
    bodyToFeature?: Record<BodyId, FeatureId>,
    sketchPlanes?: SketchPlaneDisplay[],
  ) => void;
  /**
   * Drop results for parts that are no longer in the document — an undo
   * of `CreatePart`, say. Without it their bodies would stay on screen
   * with no feature behind them.
   */
  retainParts: (partIds: readonly PartId[]) => void;
  /** Set rebuilding status */
  setRebuilding: (rebuilding: boolean) => void;
  /** Set rebuild error */
  setRebuildError: (error: string | null) => void;
  /** Clear all viewport data */
  clear: () => void;
};

/** Flatten the per-part results into the fields every consumer reads. */
function flatten(resultsByPart: Record<PartId, PartRebuildResult>) {
  const displayMeshes: DisplayMesh[] = [];
  const topologyMaps: TopologyMap[] = [];
  const constructionPlanes: ConstructionPlaneDisplay[] = [];
  const sketchPlanes: SketchPlaneDisplay[] = [];
  const featureResults = {} as Record<FeatureId, FeatureBuildResult>;
  const bodyToFeatureMap = {} as Record<BodyId, FeatureId>;
  for (const part of Object.values(resultsByPart)) {
    displayMeshes.push(...part.meshes);
    topologyMaps.push(...part.topoMaps);
    constructionPlanes.push(...part.constructionPlanes);
    sketchPlanes.push(...part.sketchPlanes);
    for (const r of part.featureResults) featureResults[r.featureId] = r;
    Object.assign(bodyToFeatureMap, part.bodyToFeature);
  }
  return { displayMeshes, topologyMaps, constructionPlanes, sketchPlanes, featureResults, bodyToFeatureMap };
}

export function createViewportStore() {
  return createStore<ViewportState>(set => ({
    displayMeshes: [],
    topologyMaps: [],
    partArtifacts: {} as Record<PartId, PartBuildArtifact>,
    bodyToFeatureMap: {} as Record<BodyId, FeatureId>,
    constructionPlanes: [],
    sketchPlanes: [],
    resultsByPart: {} as Record<PartId, PartRebuildResult>,
    featureResults: {} as Record<FeatureId, FeatureBuildResult>,
    rebuilding: false,
    rebuildError: null,

    setRebuildResult: (
      partId: PartId,
      meshes: DisplayMesh[],
      topoMaps: TopologyMap[],
      constructionPlanes: ConstructionPlaneDisplay[],
      featureResults: FeatureBuildResult[],
      bodyToFeature?: Record<BodyId, FeatureId>,
      sketchPlanes?: SketchPlaneDisplay[],
    ) => {
      set(state => {
        const resultsByPart = {
          ...state.resultsByPart,
          [partId]: {
            meshes,
            topoMaps,
            constructionPlanes,
            sketchPlanes: sketchPlanes ?? [],
            featureResults,
            bodyToFeature: bodyToFeature ?? {},
          },
        };
        return {
          resultsByPart,
          ...flatten(resultsByPart),
          rebuilding: false,
          rebuildError: null,
        };
      });
    },

    retainParts: (partIds: readonly PartId[]) => {
      set(state => {
        const keep = new Set<string>(partIds);
        const resultsByPart = {} as Record<PartId, PartRebuildResult>;
        let dropped = false;
        for (const [id, result] of Object.entries(state.resultsByPart) as [PartId, PartRebuildResult][]) {
          if (keep.has(id)) resultsByPart[id] = result;
          else dropped = true;
        }
        if (!dropped) return state;
        return { resultsByPart, ...flatten(resultsByPart) };
      });
    },

    setRebuilding: (rebuilding: boolean) => set({ rebuilding }),

    setRebuildError: (error: string | null) =>
      set({ rebuildError: error, rebuilding: false }),

    clear: () =>
      set({
        resultsByPart: {} as Record<PartId, PartRebuildResult>,
        displayMeshes: [],
        topologyMaps: [],
        partArtifacts: {} as Record<PartId, PartBuildArtifact>,
        bodyToFeatureMap: {} as Record<BodyId, FeatureId>,
        constructionPlanes: [],
        sketchPlanes: [],
        featureResults: {} as Record<FeatureId, FeatureBuildResult>,
        rebuilding: false,
        rebuildError: null,
      }),
  }));
}
