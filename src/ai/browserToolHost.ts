/**
 * Browser-side ToolHost implementation.
 *
 * Wraps the live documentStore + commandBus + viewportStore so the
 * tool layer (`@tweakcad/core/src/ai/toolExecutor.ts`) can execute
 * tool calls against this tab's authoritative state.
 *
 * The ToolHost contract is async (`dispatchCommand`/`beginTransaction`/
 * `endTransaction` return Promises) because at least one transport —
 * the MCP bridge — needs the async option. In the browser those
 * dispatches are synchronous, so we just wrap in `Promise.resolve`.
 *
 * `getDiagnostics` reads from the viewport store's `featureResults`
 * map and converts each `failed`/`blocked` entry to a structured
 * `Diagnostic`. `success`/`suppressed` entries don't produce
 * diagnostics (the former is fine; the latter is an intentional user
 * choice, not a problem). The raw featureResults map is included
 * alongside so the caller can introspect individual feature states if
 * it wants more than the flat diagnostic list.
 */

import type { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import type { CommandBus } from '@tweakcad/core/src/commands/bus.ts';
import type { CadCommand } from '@tweakcad/core/src/commands/types.ts';
import type { ToolHost } from '@tweakcad/core/src/ai/toolExecutor.ts';
import type { ViewportController } from '@tweakcad/viewport/src/ViewportController.ts';
import type { StoreApi } from 'zustand/vanilla';
import type { ViewportState } from '@tweakcad/core/src/store/viewportStore.ts';
import type {
  CadProject,
  Diagnostic,
  FeatureBuildResult,
} from '@tweakcad/core/src/document/schema.ts';
import type { FeatureId, PartId } from '@tweakcad/core/src/ids.ts';
import { synthesizeBodies, findTopology } from './bodyArtifacts.ts';
import { waitForRebuildIdle } from './viewportSync.ts';

export interface BrowserToolHostDeps {
  documentStore: DocumentStore;
  commandBus: CommandBus;
  /**
   * Viewport store — source of truth for per-feature build results.
   * `getDiagnostics()` reads `state.featureResults` and converts the
   * non-success entries into structured Diagnostics for the caller.
   */
  viewportStore: StoreApi<ViewportState>;
  /**
   * Live viewport controller. Optional — when omitted, the view tools
   * (view_fit_all, view_set_standard, view_zoom, view_get_state) error
   * out with UNSUPPORTED_BY_HOST. The canvas mount in Shell creates
   * the controller asynchronously, so the host may be built before it
   * exists; callers can pass `null` to signal "viewport not ready yet".
   */
  viewportController?: ViewportController | null;
}

/**
 * Diagnostics shape returned to the caller. The flat `diagnostics`
 * array is human-readable; `featureResults` carries the raw discriminated
 * union for a caller that wants to introspect a specific feature's state.
 */
export interface DiagnosticsResult {
  diagnostics: Diagnostic[];
  featureResults: Record<FeatureId, FeatureBuildResult>;
}

/**
 * Build the set of feature ids belonging to `partId`. Returns null if
 * the partId doesn't exist in the document — callers treat null as "no
 * such part" and return empty diagnostics.
 */
function partFeatureSet(doc: CadProject, partId: PartId): Set<FeatureId> | null {
  const part = doc.parts[partId];
  if (!part) return null;
  return new Set(part.timeline.map((f) => f.id));
}

/**
 * Convert one `FeatureBuildResult` into a `Diagnostic`, or null if the
 * status doesn't warrant one (success → no problem; suppressed → user
 * choice). The `id` is synthesized from the feature id so the caller can
 * dedupe across turns if needed.
 */
function resultToDiagnostic(result: FeatureBuildResult): Diagnostic | null {
  switch (result.status) {
    case 'success':
    case 'suppressed':
      return null;
    case 'blocked':
      return {
        id: `diag-${result.featureId}-blocked`,
        severity: 'warning',
        code: 'BLOCKED',
        message: `Feature is blocked by upstream failure in ${result.blockedBy}.`,
        featureId: result.featureId,
        recoverable: true,
      };
    case 'failed': {
      const e = result.error;
      const msg = e.suggestion ? `${e.message} — ${e.suggestion}` : e.message;
      return {
        id: `diag-${result.featureId}-failed`,
        severity: 'error',
        code: e.code,
        message: msg,
        featureId: result.featureId,
        recoverable: true,
      };
    }
  }
}

/**
 * Pure builder used by both the in-app chat ToolHost and the MCP bridge
 * client's `getDiagnostics` handler. Lives here (not duplicated) so
 * both consumers always agree on the exact shape returned.
 *
 * - `partId` undefined → diagnostics across the whole project.
 * - `partId` matches a known part → filtered to that part's timeline.
 * - `partId` matches no part → empty (consistent with "no problems").
 */
export function buildDiagnostics(
  featureResults: Record<FeatureId, FeatureBuildResult>,
  doc: CadProject,
  partId?: string,
): DiagnosticsResult {
  let filter: Set<FeatureId> | null = null;
  if (partId !== undefined) {
    const set = partFeatureSet(doc, partId as PartId);
    if (set === null) {
      return { diagnostics: [], featureResults: {} };
    }
    filter = set;
  }

  const diagnostics: Diagnostic[] = [];
  const filteredResults: Record<FeatureId, FeatureBuildResult> = {};
  for (const [fid, result] of Object.entries(featureResults) as Array<
    [FeatureId, FeatureBuildResult]
  >) {
    if (filter !== null && !filter.has(fid)) continue;
    filteredResults[fid] = result;
    const diag = resultToDiagnostic(result);
    if (diag) diagnostics.push(diag);
  }
  return { diagnostics, featureResults: filteredResults };
}

/**
 * Build a ToolHost that drives the live editor.
 *
 * `dispatchCommand` resolves with the post-dispatch document snapshot
 * on success, or rejects with an Error whose message is the validation
 * message from the handler — that surface lets the caller self-correct
 * on the next turn (e.g. "Part not found: part_X" → retry with the
 * right id from get_document).
 */
export function createBrowserToolHost(deps: BrowserToolHostDeps): ToolHost {
  const vc = deps.viewportController ?? null;

  const host: ToolHost = {
    getDocument() {
      return deps.documentStore.getState();
    },
    getDiagnostics(partId?: string): DiagnosticsResult {
      return buildDiagnostics(
        deps.viewportStore.getState().featureResults,
        deps.documentStore.getState(),
        partId,
      );
    },
    async dispatchCommand(command: unknown): Promise<unknown> {
      const result = deps.commandBus.dispatch(command as CadCommand);
      if (!result.ok) {
        const detail = result.error.field ? ` (${result.error.field})` : '';
        throw new Error(`${result.error.code}: ${result.error.message}${detail}`);
      }
      return deps.documentStore.getState();
    },
    async beginTransaction(label: string): Promise<void> {
      deps.commandBus.beginTransaction(label);
    },
    async endTransaction(): Promise<void> {
      deps.commandBus.endTransaction();
    },
  };

  // Conditionally wire view methods. The toolExecutor treats missing
  // methods as UNSUPPORTED_BY_HOST so a caller invoking view tools
  // before the viewport is mounted gets a clean error rather than a
  // crash. The methods themselves don't return anything meaningful
  // (the user sees the camera move) — they behave like
  // begin_transaction: a side-effect tool that just succeeds.
  if (vc !== null) {
    host.viewFitAll = async () => {
      vc.fitToView();
    };
    host.viewSetStandard = async (view) => {
      vc.setStandardView(view);
    };
    host.viewZoom = async (direction) => {
      if (direction === 'in') vc.zoomIn();
      else vc.zoomOut();
    };
    host.captureScreenshot = async () => {
      const { mimeType, data } = vc.captureScreenshot();
      return { kind: 'image', mimeType, data };
    };
  }

  // Build-artifact exposure for list_bodies / list_faces / list_edges.
  //
  // The actual build outputs (displayMeshes / topologyMaps /
  // bodyToFeatureMap) live in viewportStore as flat lists — the
  // partArtifacts field is declared but the rebuilder doesn't populate
  // it today. Synthesis lives in `bodyArtifacts.ts` so the equivalent
  // logic in mcpBridgeClient.ts uses the exact same helper.
  host.listBodies = async (partId: string): Promise<unknown> => {
    const vp = deps.viewportStore.getState();
    return synthesizeBodies(
      deps.documentStore.getState(),
      vp.displayMeshes,
      vp.bodyToFeatureMap,
      partId,
    );
  };
  host.getTopology = async (bodyId: string): Promise<unknown> => {
    return findTopology(deps.viewportStore.getState().topologyMaps, bodyId);
  };

  // Settle-the-worker primitive. Same impl powers the bridge handler
  // in mcpBridgeClient.ts so the in-app chat and external MCP path
  // observe identical timing behavior.
  host.waitForRebuild = (timeoutMs?: number) =>
    waitForRebuildIdle(deps.viewportStore, timeoutMs);

  return host;
}
