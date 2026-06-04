/**
 * Tool executor — runs a tool call against a host-provided context.
 *
 * The ToolHost abstraction is the seam between "what a tool can do" and
 * "where the document + commands actually live":
 *
 *   - Browser chat panel: host wraps the live documentStore + commandBus +
 *     viewportStore (sync dispatch — the implementation returns a resolved
 *     Promise to satisfy the async contract).
 *   - Server: host wraps a per-request DocumentStore + CommandBus clone.
 *   - MCP bridge: host forwards calls over a WebSocket to the browser; the
 *     async contract is essential since WS is round-trip.
 *
 * Same executor, three transports. Tests use a fake in-memory host.
 *
 * Async contract: `dispatchCommand`, `beginTransaction`, `endTransaction`
 * return Promises because at least one transport (MCP bridge) needs them.
 * Sync hosts (browser direct) just `return Promise.resolve(...)`.
 *
 * Sync contract for reads (`getDocument`, `getDiagnostics`): these are
 * called inside the tool loop where awaiting a network round-trip per
 * read would balloon latency. Async hosts (the bridge) maintain a
 * push-fed cache so sync reads return the latest-known snapshot without
 * a round-trip.
 */

import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import { findTool } from '@tweakcad/cad-tools';
import {
  executeSketchCreate,
  executeSketchDrawLine,
  executeSketchDrawRectangle,
  executeSketchDrawCircle,
  executeSketchDrawSlot,
  executeSketchDrawArc,
  executeSketchDrawArc3Point,
  executeSketchDrawPolygon,
  executeSketchDrawEllipse,
  executeSketchDrawSpline,
  executeSketchDrawPoint,
  executeSketchApplyConstraint,
  executeSketchRemoveConstraint,
  executeListSketchElements,
  executeFeatureExtrude,
  executeFeatureFillet,
  executeFeatureChamfer,
  executeFeatureHole,
  executeFeatureRevolve,
  executeFeatureMirror,
  executeFeaturePattern,
  executeFeatureShell,
  executeFeatureSweep,
  executeFeatureLoft,
  executeFindEdges,
  executeFindFace,
  executeCadHelp,
  executeListSketchRegions,
  executeListBodies,
  executeListFaces,
  executeListEdges,
  executeSketchPickGeometry,
  executeSketchTrim,
  executeSketchExtend,
  executeSketchFillet,
  executeSketchOffset,
  executeSketchMirror,
  executeSketchMovePoint,
  executeSketchMovePoints,
} from './modelingTools.ts';

/**
 * Capability surface a tool executor needs.
 *
 * `getDocument` and `getDiagnostics` are intentionally synchronous: the
 * tool layer is called inside a tool loop where blocking on the
 * network for read-only state would balloon latency. Async hosts
 * (e.g. the MCP bridge) satisfy this by maintaining a locally-cached
 * snapshot kept in sync via push events.
 */
export interface ToolHost {
  /** Snapshot of the live document. Cheap; safe to call per tool turn. */
  getDocument(): unknown;
  /** Diagnostics for a part, or the whole project if `partId` is omitted. */
  getDiagnostics(partId?: string): unknown;
  /** Dispatch a single command. Resolves with the resulting doc snapshot. */
  dispatchCommand(command: unknown): Promise<unknown>;
  /** Open an undo-grouped transaction. */
  beginTransaction(label: string): Promise<void>;
  /** Close the currently open undo-grouped transaction. */
  endTransaction(): Promise<void>;

  // ---- Viewport ----
  //
  // Hosts without a live viewport (e.g. the server-side per-request
  // clone) should throw on these — they should never be called
  // outside the browser-driven loop. The browser ToolHost wires them
  // to `ViewportController` methods.

  /** Frame the camera so all visible bodies fit on screen. */
  viewFitAll?(): Promise<void>;
  /** Snap to a named standard view. */
  viewSetStandard?(view: 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | 'home'): Promise<void>;
  /** Zoom in or out by one step. */
  viewZoom?(direction: 'in' | 'out'): Promise<void>;
  // viewGetState was removed. See the note in `tools.ts` next to
  // where the `view_get_state` tool used to be registered. The browser
  // ViewportController still has `getViewState()` — call it directly
  // from app code if you need camera state. Bring this method back if
  // a real tool-facing use case appears.
  /**
   * Capture a JPEG screenshot of the viewport. Returns a base64-encoded
   * image payload tagged with `kind: 'image'` so the tool loop can
   * route it as a multi-modal tool_result block instead of stringifying.
   *
   * Implementations should downscale to a reasonable size (~1024px max)
   * to keep token cost predictable.
   */
  captureScreenshot?(): Promise<ToolImageValue>;

  // ---- Build artifacts (bodies / topology) ----
  //
  // These expose the kernel's output — bodies produced by build, plus
  // the face/edge topology for each — to the caller. Without them the
  // caller can't discover faceIds / edgeIds it needs for fillet, chamfer,
  // hole, and sketch-on-face flows.
  //
  // Async because the bridge proxies them over WebSocket. Browser
  // implementations resolve immediately (they read from viewportStore).
  // Hosts without a live build pipeline (the SaaS server-side host)
  // should leave these undefined → list tools return UNSUPPORTED_BY_HOST.

  /** Return the bodies a part has produced (most recent rebuild). */
  listBodies?(partId: string): Promise<unknown>;
  /** Return the topology (faces + edges) of one body. */
  getTopology?(bodyId: string): Promise<unknown>;

  /**
   * Block until the worker has finished its current rebuild.
   *
   * Use case: after `dispatch_command(CreateExtrude)` returns, the worker
   * is still building in the background. A caller that invokes
   * `get_diagnostics` immediately will see stale results. Calling
   * `wait_for_rebuild` first guarantees the next read sees the post-build
   * state — eliminating the race without forcing every dispatch to
   * synchronously block.
   *
   * Hosts without a build pipeline (the SaaS server-side host) should
   * leave this undefined → the tool returns UNSUPPORTED_BY_HOST.
   *
   * Rejects with a timeout error if the rebuild doesn't settle within
   * `timeoutMs` (default 10000). Resolves with the number of ms actually
   * waited so the caller can spot a hung worker.
   */
  waitForRebuild?(timeoutMs?: number): Promise<{ waitedMs: number }>;
}

/**
 * Special-shaped tool return value: an image to be passed back to the
 * caller. The tool loop's serializer checks for `kind === 'image'` and
 * builds a tool_result block with an image content type. Plain tool
 * returns (objects, strings) are stringified instead.
 */
export type ToolImageValue = {
  kind: 'image';
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Base64-encoded image data (no data: URL prefix). */
  data: string;
};

/** Type guard for the image-shaped tool return value. */
export function isToolImageValue(v: unknown): v is ToolImageValue {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<ToolImageValue>;
  return (
    o.kind === 'image' &&
    typeof o.mimeType === 'string' &&
    typeof o.data === 'string'
  );
}

/** Failure shape returned by `executeTool`. */
export type ToolExecutionError = {
  code:
    | 'UNKNOWN_TOOL'
    | 'INVALID_INPUT'
    | 'HOST_ERROR'
    | 'NO_SESSION'
    | 'UNSUPPORTED_BY_HOST';
  message: string;
};

/**
 * Execute a tool call by name.
 *
 * - Validates the tool exists.
 * - Routes to the appropriate `ToolHost` method.
 * - Wraps host failures in a structured error (never throws for
 *   expected failures — only programmer errors propagate).
 *
 * Unknown tool names return UNKNOWN_TOOL rather than throwing, so a
 * caller that requests a non-existent tool just gets a "no such tool"
 * reply and can try again.
 */
export async function executeTool(
  name: string,
  input: unknown,
  host: ToolHost,
): Promise<Result<unknown, ToolExecutionError>> {
  const tool = findTool(name);
  if (!tool) {
    return err({
      code: 'UNKNOWN_TOOL',
      message: `unknown tool: ${name}`,
    });
  }

  const args = isRecord(input) ? input : {};

  try {
    switch (name) {
      case 'get_document':
        return ok(host.getDocument());

      case 'dispatch_command': {
        if (!('command' in args)) {
          return err({
            code: 'INVALID_INPUT',
            message: '`command` is required',
          });
        }
        const cmd = args['command'];
        if (!isRecord(cmd) || typeof (cmd as { type?: unknown }).type !== 'string') {
          return err({
            code: 'INVALID_INPUT',
            message: '`command` must be an object with a string `type` discriminator',
          });
        }
        const result = await host.dispatchCommand(cmd);
        return ok(result);
      }

      case 'begin_transaction': {
        const label = args['label'];
        if (typeof label !== 'string' || label.trim() === '') {
          return err({
            code: 'INVALID_INPUT',
            message: '`label` must be a non-empty string',
          });
        }
        await host.beginTransaction(label);
        return ok({ ok: true });
      }

      case 'end_transaction':
        await host.endTransaction();
        return ok({ ok: true });

      case 'query_features': {
        const partId = args['partId'];
        if (partId !== undefined && typeof partId !== 'string') {
          return err({
            code: 'INVALID_INPUT',
            message: '`partId` must be a string when provided',
          });
        }
        return ok(summarizeFeatures(host.getDocument(), partId));
      }

      case 'get_diagnostics': {
        const partId = args['partId'];
        if (partId !== undefined && typeof partId !== 'string') {
          return err({
            code: 'INVALID_INPUT',
            message: '`partId` must be a string when provided',
          });
        }
        return ok(
          partId === undefined
            ? host.getDiagnostics()
            : host.getDiagnostics(partId),
        );
      }

      case 'view_fit_all': {
        if (!host.viewFitAll) {
          return err({
            code: 'UNSUPPORTED_BY_HOST',
            message: 'This host has no viewport (view tools are browser-only).',
          });
        }
        await host.viewFitAll();
        return ok({ ok: true });
      }

      case 'view_set_standard': {
        if (!host.viewSetStandard) {
          return err({
            code: 'UNSUPPORTED_BY_HOST',
            message: 'This host has no viewport (view tools are browser-only).',
          });
        }
        const view = args['view'];
        const allowed = ['front', 'back', 'top', 'bottom', 'left', 'right', 'home'] as const;
        if (typeof view !== 'string' || !(allowed as readonly string[]).includes(view)) {
          return err({
            code: 'INVALID_INPUT',
            message: `\`view\` must be one of: ${allowed.join(', ')}`,
          });
        }
        await host.viewSetStandard(view as (typeof allowed)[number]);
        return ok({ ok: true });
      }

      case 'view_zoom': {
        if (!host.viewZoom) {
          return err({
            code: 'UNSUPPORTED_BY_HOST',
            message: 'This host has no viewport (view tools are browser-only).',
          });
        }
        const direction = args['direction'];
        if (direction !== 'in' && direction !== 'out') {
          return err({
            code: 'INVALID_INPUT',
            message: "`direction` must be 'in' or 'out'",
          });
        }
        await host.viewZoom(direction);
        return ok({ ok: true });
      }


      case 'wait_for_rebuild': {
        if (!host.waitForRebuild) {
          return err({
            code: 'UNSUPPORTED_BY_HOST',
            message: 'This host has no build pipeline (wait_for_rebuild is browser/bridge-only).',
          });
        }
        const tm = args['timeoutMs'];
        if (tm !== undefined && (typeof tm !== 'number' || !Number.isFinite(tm) || tm <= 0)) {
          return err({
            code: 'INVALID_INPUT',
            message: '`timeoutMs` must be a positive finite number when provided.',
          });
        }
        const result = await host.waitForRebuild(typeof tm === 'number' ? tm : undefined);
        return ok(result);
      }

      case 'view_screenshot': {
        if (!host.captureScreenshot) {
          return err({
            code: 'UNSUPPORTED_BY_HOST',
            message: 'This host cannot capture screenshots (browser-only).',
          });
        }
        const image = await host.captureScreenshot();
        return ok(image);
      }

      // ---- Higher-level modeling tools (modelingTools.ts) ----
      // These wrap CadCommands with full JSON schemas + return new ids
      // directly so the caller doesn't have to read source or round-trip
      // get_document. Implementations live in `./modelingTools.ts`
      // because they touch document schema types — keeping toolExecutor
      // schema-free for portability.
      case 'sketch_create': {
        const r = await executeSketchCreate(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_draw_line': {
        const r = await executeSketchDrawLine(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_draw_rectangle': {
        const r = await executeSketchDrawRectangle(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_draw_circle': {
        const r = await executeSketchDrawCircle(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_draw_slot': {
        const r = await executeSketchDrawSlot(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_draw_arc': {
        const r = await executeSketchDrawArc(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_draw_arc3point': {
        const r = await executeSketchDrawArc3Point(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_draw_polygon': {
        const r = await executeSketchDrawPolygon(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_draw_ellipse': {
        const r = await executeSketchDrawEllipse(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_draw_spline': {
        const r = await executeSketchDrawSpline(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_draw_point': {
        const r = await executeSketchDrawPoint(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_apply_constraint': {
        const r = await executeSketchApplyConstraint(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_remove_constraint': {
        const r = await executeSketchRemoveConstraint(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'list_sketch_elements': {
        const r = await executeListSketchElements(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'feature_extrude': {
        const r = await executeFeatureExtrude(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'feature_fillet': {
        const r = await executeFeatureFillet(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'feature_chamfer': {
        const r = await executeFeatureChamfer(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'feature_hole': {
        const r = await executeFeatureHole(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'feature_revolve': {
        const r = await executeFeatureRevolve(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'feature_mirror': {
        const r = await executeFeatureMirror(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'feature_pattern': {
        const r = await executeFeaturePattern(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'feature_shell': {
        const r = await executeFeatureShell(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'feature_sweep': {
        const r = await executeFeatureSweep(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'feature_loft': {
        const r = await executeFeatureLoft(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'cad_help': {
        const r = await executeCadHelp(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'list_sketch_regions': {
        const r = await executeListSketchRegions(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'list_bodies': {
        const r = await executeListBodies(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'list_faces': {
        const r = await executeListFaces(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'list_edges': {
        const r = await executeListEdges(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'find_edges': {
        const r = await executeFindEdges(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'find_face': {
        const r = await executeFindFace(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_pick_geometry': {
        const r = await executeSketchPickGeometry(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_trim': {
        const r = await executeSketchTrim(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_extend': {
        const r = await executeSketchExtend(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_fillet': {
        const r = await executeSketchFillet(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_offset': {
        const r = await executeSketchOffset(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_mirror': {
        const r = await executeSketchMirror(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_move_point': {
        const r = await executeSketchMovePoint(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }
      case 'sketch_move_points': {
        const r = await executeSketchMovePoints(args, host);
        return r.ok ? ok(r.value) : err(r.error);
      }

      default:
        // The tool exists in the catalogue but the executor doesn't yet
        // know how to route it. Treat as a programmer error.
        return err({
          code: 'UNKNOWN_TOOL',
          message: `tool ${name} is registered but has no executor`,
        });
    }
  } catch (e) {
    return err({
      code: 'HOST_ERROR',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---- Internal helpers ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Walk an opaque CadProject snapshot and produce a compact feature list.
 * Typed as `unknown` because the snapshot crosses the bridge as JSON; we
 * defensively duck-type rather than importing CadProject (this module
 * shouldn't depend on schema types — keeps it portable).
 */
function summarizeFeatures(
  doc: unknown,
  wantedPart: string | undefined,
): { parts: Array<{ partId: string; partName: string; features: Array<{ id: string; type: string; name: string; enabled: boolean; visible: boolean }> }> } | { error: string } {
  if (!isRecord(doc)) return { parts: [] };
  const parts = doc['parts'];
  if (!isRecord(parts)) return { parts: [] };
  const out: Array<{ partId: string; partName: string; features: Array<{ id: string; type: string; name: string; enabled: boolean; visible: boolean }> }> = [];
  for (const [pid, partVal] of Object.entries(parts)) {
    if (wantedPart !== undefined && pid !== wantedPart) continue;
    if (!isRecord(partVal)) continue;
    const timeline = partVal['timeline'];
    const features = Array.isArray(timeline) ? timeline : [];
    out.push({
      partId: pid,
      partName: typeof partVal['name'] === 'string' ? partVal['name'] : pid,
      features: features.map((f) => {
        const fr = isRecord(f) ? f : {};
        return {
          id: typeof fr['id'] === 'string' ? fr['id'] : '',
          type: typeof fr['type'] === 'string' ? fr['type'] : 'unknown',
          name: typeof fr['name'] === 'string' ? fr['name'] : '',
          enabled: fr['enabled'] !== false,
          visible: fr['visible'] !== false,
        };
      }),
    });
  }
  if (wantedPart !== undefined && out.length === 0) {
    return { error: `Part not found: ${wantedPart}` };
  }
  return { parts: out };
}
