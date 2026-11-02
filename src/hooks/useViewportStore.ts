/**
 * React hook for subscribing to the ViewportStore.
 * Provides reactive access to display meshes and rebuild status.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { DisplayMesh, TopologyMap, ConstructionPlaneDisplay, FeatureBuildResult, SketchPlaneDisplay } from '@tweakcad/core/src/document/schema.ts';
import type { BodyId, FeatureId } from '@tweakcad/core/src/ids.ts';
import { getAppState } from '../appInit.ts';

/**
 * Subscribe to display meshes from the viewport store.
 * @returns Array of display meshes for rendering
 */
export function useDisplayMeshes(): DisplayMesh[] {
  const { viewportStore } = getAppState();

  return useSyncExternalStore(
    useCallback(
      (callback: () => void) => viewportStore.subscribe(callback),
      [viewportStore],
    ),
    useCallback(() => viewportStore.getState().displayMeshes, [viewportStore]),
  );
}

/**
 * Subscribe to topology maps from the viewport store.
 * @returns Array of topology maps for picking
 */
export function useTopologyMaps(): TopologyMap[] {
  const { viewportStore } = getAppState();

  return useSyncExternalStore(
    useCallback(
      (callback: () => void) => viewportStore.subscribe(callback),
      [viewportStore],
    ),
    useCallback(() => viewportStore.getState().topologyMaps, [viewportStore]),
  );
}

/**
 * Subscribe to rebuild status.
 * @returns Whether a rebuild is in progress
 */
export function useRebuilding(): boolean {
  const { viewportStore } = getAppState();

  return useSyncExternalStore(
    useCallback(
      (callback: () => void) => viewportStore.subscribe(callback),
      [viewportStore],
    ),
    useCallback(() => viewportStore.getState().rebuilding, [viewportStore]),
  );
}

/**
 * Subscribe to the construction-plane display list from the viewport store.
 * @returns Array of construction-plane display entries (may be empty)
 */
export function useConstructionPlanes(): ConstructionPlaneDisplay[] {
  const { viewportStore } = getAppState();

  return useSyncExternalStore(
    useCallback(
      (callback: () => void) => viewportStore.subscribe(callback),
      [viewportStore],
    ),
    useCallback(() => viewportStore.getState().constructionPlanes, [viewportStore]),
  );
}

/**
 * Subscribe to the frames of sketches placed on body faces, as the last
 * rebuild resolved them.
 */
export function useSketchPlanes(): SketchPlaneDisplay[] {
  const { viewportStore } = getAppState();

  return useSyncExternalStore(
    useCallback(
      (callback: () => void) => viewportStore.subscribe(callback),
      [viewportStore],
    ),
    useCallback(() => viewportStore.getState().sketchPlanes, [viewportStore]),
  );
}

/**
 * Subscribe to per-feature build results from the viewport store.
 * @returns Map keyed by featureId, used by ProjectTree to show
 *   failed / blocked / suppressed badges.
 */
export function useFeatureResults(): Record<FeatureId, FeatureBuildResult> {
  const { viewportStore } = getAppState();

  return useSyncExternalStore(
    useCallback(
      (callback: () => void) => viewportStore.subscribe(callback),
      [viewportStore],
    ),
    useCallback(() => viewportStore.getState().featureResults, [viewportStore]),
  );
}

/**
 * Subscribe to the body-to-feature mapping from the viewport store.
 * @returns Mapping of bodyId to the featureId that produced it
 */
export function useBodyToFeatureMap(): Record<BodyId, FeatureId> {
  const { viewportStore } = getAppState();

  return useSyncExternalStore(
    useCallback(
      (callback: () => void) => viewportStore.subscribe(callback),
      [viewportStore],
    ),
    useCallback(() => viewportStore.getState().bodyToFeatureMap, [viewportStore]),
  );
}
