/**
 * Runs a tool call of the catalogue (`@tweakcad/cad-tools`) against the open
 * editor. The in-app chat and the MCP bridge both run their calls here.
 * A call either returns a value (JSON, or an image) or a refusal with a code
 * and a message the caller can act on; a refusal changes nothing.
 */
import { CAD_TOOLS, findTool } from '@tweakcad/cad-tools';
import type { Json } from '@tweakcad/editor';
import type { Args } from './common';
import { ToolError, isRecord, type AiContext, type ToolErrorCode } from './context';
import {
  getDiagnostics,
  getDocument,
  listFeatures,
  runCommand,
  setParameter,
  setReference,
  setValue,
  type Transactions,
} from './document';
import {
  featureBoolean,
  featureChamfer,
  featureConstruction,
  featureExtrude,
  featureFillet,
  featureHole,
  featureMirror,
  featureMove,
  featurePattern,
  featurePrimitive,
  featureFreeze,
  featureRemoveBody,
  featureRevolve,
  featureLoft,
  featureSweep,
  featureShell,
  featureThread,
} from './features';
import {
  assemblyCreate,
  assemblyDelete,
  assemblyDrive,
  assemblyExplodedView,
  assemblyGroup,
  assemblyHoleThrough,
  assemblyInsert,
  assemblyJoint,
  assemblyMoveInstance,
  assemblyPosition,
  assemblyRelation,
  assemblySetInstance,
  assemblySetJoint,
  assemblyUpdateContexts,
  assemblyPattern,
  assemblyMirror,
  assemblyReplicate,
  featureDerive,
  getAssembly,
} from './assembly';
import { CAD_WORKFLOW_GUIDE } from './guide';
import { listBodies, listConstruction, listEdges, listFaces, listVertices, measure } from './inspect';
import {
  drawArc,
  drawCircle,
  drawEllipse,
  drawLine,
  drawPoint,
  drawPolygon,
  drawRectangle,
  drawSlot,
  drawSpline,
  getSketch,
  movePoints,
  setConstruction,
  setSketchDimension,
  sketchConstrain,
  sketchCreate,
  sketchDelete,
  sketchExtend,
  sketchFillet,
  sketchMirror,
  sketchOffset,
  sketchProject,
  sketchPickGeometry,
  sketchTrim,
} from './sketch';
import { viewFitAll, viewScreenshot, viewSetStandard, viewZoom } from './view';

export type ToolResult = { ok: true; value: unknown } | { ok: false; error: { code: ToolErrorCode; message: string } };

/** What a run needs besides the context: where `begin_transaction` and `end_transaction` go. */
export interface ToolRun {
  ctx: AiContext;
  transactions: Transactions;
}

type Runner = (run: ToolRun, args: Args) => unknown;

const withCtx =
  (f: (ctx: AiContext, args: Args) => unknown): Runner =>
  (run, args) =>
    f(run.ctx, args);

const RUNNERS: Record<string, Runner> = {
  cad_help: () => CAD_WORKFLOW_GUIDE,
  get_document: withCtx(getDocument),
  list_features: withCtx(listFeatures),
  get_diagnostics: withCtx(getDiagnostics),
  run_command: withCtx(runCommand),
  set_reference: withCtx(setReference),
  set_value: withCtx(setValue),
  set_parameter: withCtx(setParameter),
  begin_transaction: (run, args) => {
    const label = args.label;
    if (typeof label !== 'string' || label.trim() === '')
      throw new ToolError('INVALID_INPUT', '`label` is a non-empty string');
    run.transactions.begin(label);
    return { ok: true };
  },
  end_transaction: (run) => {
    run.transactions.end();
    return { ok: true };
  },
  sketch_create: withCtx(sketchCreate),
  sketch_draw_line: withCtx(drawLine),
  sketch_draw_rectangle: withCtx(drawRectangle),
  sketch_draw_circle: withCtx(drawCircle),
  sketch_draw_arc: withCtx(drawArc),
  sketch_draw_slot: withCtx(drawSlot),
  sketch_draw_polygon: withCtx(drawPolygon),
  sketch_draw_ellipse: withCtx(drawEllipse),
  sketch_draw_spline: withCtx(drawSpline),
  sketch_draw_point: withCtx(drawPoint),
  sketch_constrain: withCtx(sketchConstrain),
  sketch_set_dimension: withCtx(setSketchDimension),
  sketch_move_points: withCtx(movePoints),
  sketch_set_construction: withCtx(setConstruction),
  sketch_delete: withCtx(sketchDelete),
  sketch_pick_geometry: withCtx(sketchPickGeometry),
  sketch_trim: withCtx(sketchTrim),
  sketch_extend: withCtx(sketchExtend),
  sketch_fillet: withCtx(sketchFillet),
  sketch_offset: withCtx(sketchOffset),
  sketch_mirror: withCtx(sketchMirror),
  sketch_project: withCtx(sketchProject),
  get_sketch: withCtx(getSketch),
  feature_extrude: withCtx(featureExtrude),
  feature_revolve: withCtx(featureRevolve),
  feature_loft: withCtx(featureLoft),
  feature_sweep: withCtx(featureSweep),
  feature_fillet: withCtx(featureFillet),
  feature_chamfer: withCtx(featureChamfer),
  feature_hole: withCtx(featureHole),
  feature_shell: withCtx(featureShell),
  feature_pattern: withCtx(featurePattern),
  feature_mirror: withCtx(featureMirror),
  feature_move: withCtx(featureMove),
  feature_boolean: withCtx(featureBoolean),
  feature_primitive: withCtx(featurePrimitive),
  feature_thread: withCtx(featureThread),
  feature_construction: withCtx(featureConstruction),
  feature_remove_body: withCtx(featureRemoveBody),
  feature_freeze: withCtx(featureFreeze),
  get_assembly: withCtx(getAssembly),
  assembly_create: withCtx(assemblyCreate),
  assembly_insert: withCtx(assemblyInsert),
  assembly_joint: withCtx(assemblyJoint),
  assembly_drive: withCtx(assemblyDrive),
  assembly_move_instance: withCtx(assemblyMoveInstance),
  assembly_set_instance: withCtx(assemblySetInstance),
  assembly_set_joint: withCtx(assemblySetJoint),
  assembly_delete: withCtx(assemblyDelete),
  assembly_relation: withCtx(assemblyRelation),
  assembly_group: withCtx(assemblyGroup),
  assembly_position: withCtx(assemblyPosition),
  assembly_exploded_view: withCtx(assemblyExplodedView),
  feature_derive: withCtx(featureDerive),
  assembly_update_contexts: withCtx(assemblyUpdateContexts),
  assembly_hole_through: withCtx(assemblyHoleThrough),
  assembly_pattern: withCtx(assemblyPattern),
  assembly_mirror: withCtx(assemblyMirror),
  assembly_replicate: withCtx(assemblyReplicate),
  list_bodies: withCtx(listBodies),
  list_faces: withCtx(listFaces),
  list_edges: withCtx(listEdges),
  list_vertices: withCtx(listVertices),
  list_construction: withCtx(listConstruction),
  measure: withCtx(measure),
  view_fit_all: withCtx(viewFitAll),
  view_set_standard: withCtx(viewSetStandard),
  view_zoom: withCtx(viewZoom),
  view_screenshot: withCtx(viewScreenshot),
};

/** The catalogue's tools that have no runner here; empty when every tool runs. */
export function toolsWithoutRunner(): string[] {
  return CAD_TOOLS.map((t) => t.name).filter((name) => !RUNNERS[name]);
}

/** Runs one tool call. Unknown tools and bad input are refusals, never throws. */
export async function executeTool(name: string, input: unknown, run: ToolRun): Promise<ToolResult> {
  const runner = findTool(name) ? RUNNERS[name] : undefined;
  if (!runner) return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `There is no tool ${name}` } };
  const args = isRecord(input) ? (input as Args) : {};
  try {
    const value = await runner(run, args);
    return { ok: true, value: value as Json };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, error: { code: e.code, message: e.message } };
    return { ok: false, error: { code: 'HOST_ERROR', message: e instanceof Error ? e.message : String(e) } };
  }
}
