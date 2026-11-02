/**
 * Executors for the higher-level modeling tools registered in
 * `tools.ts`. These wrap CadCommands with:
 *
 *   1. **Stable input shapes.** Each tool's JSON Schema is the contract.
 *      The wrapper translates from the tool-facing shape (e.g. flat
 *      `distance: number`) to the CadCommand shape (e.g.
 *      `extent: { type: 'distance', value: '5' }`).
 *
 *   2. **Direct id return.** The wrapper diffs the document before
 *      and after dispatch to find the newly-created entity / feature
 *      id and returns it. The caller never has to round-trip
 *      `get_document` just to learn an id it just minted.
 *
 *   3. **Convenience defaults.** `feature_extrude` auto-fills
 *      `profiles` from `detectSketchRegions(sketch.buildGeometry)` when the
 *      caller omits them — the common case where a sketch has exactly
 *      one shape to extrude.
 *
 *   4. **Partid resolution.** Tools that need a `partId` (extrude)
 *      derive it from the `sketchId` by walking the document, so
 *      the caller doesn't have to track that mapping.
 *
 * Each executor lives here (not in toolExecutor.ts) because these
 * touch document schema types directly. toolExecutor.ts deliberately
 * stays schema-free for portability — it just routes.
 */

import { sketchBuildGeometry } from '../sketch/derivedGeometry.ts';
import type { Result } from '../result.ts';
import { ok, err } from '../result.ts';
import type { ToolHost, ToolExecutionError } from './toolExecutor.ts';
import type {
  SketchConstraintInput,
  SketchConstraintId,
  SketchPointId,
  SketchGeometryId,
} from '../sketch/types.ts';
import type {
  CadProject,
  SketchFeatureInputs,
  ExtrudeFeatureInputs,
  FilletFeatureInputs,
  ChamferFeatureInputs,
  HoleFeatureInputs,
  RevolveFeatureInputs,
  MirrorFeatureInputs,
  LinearPatternInputs,
  CircularPatternInputs,
  ShellFeatureInputs,
  SweepFeatureInputs,
  LoftFeatureInputs,
  ProfileRef,
  EdgeRef,
  FaceRef,
  BodyRef,
  PlaneRef,
  AxisSpec,
  FeatureNode,
  BuiltBody,
  TopologyMap,
} from '../document/schema.ts';
import type { PartId, FeatureId, EntityId, BodyId } from '../ids.ts';
import { stableEdgeId, stableFaceId } from '../ids.ts';
import {
  detectSketchRegions,
  regionInteriorPoint,
  regionNetArea,
  regionWireEntityIds,
} from '../sketch/profileRegions.ts';
import { fromSnapshot } from '../sketch/operations.ts';
import { pickGeometryAt } from '../sketch/sketchPicking.ts';
import type { CadCommand } from '../commands/types.ts';
import { CAD_WORKFLOW_GUIDE } from './cadHelp.ts';
import { edgeMatchesFaceFilter } from '../document/edgeQueries.ts';

// ---- Generic helpers -------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isVec2(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1])
  );
}

function invalidInput(message: string): ToolExecutionError {
  return { code: 'INVALID_INPUT', message };
}

/**
 * Optional `targetBodies: string[]` (bodyIds from `list_bodies`) for a
 * join / cut, as BodyRefs in the feature's part. Absent or empty means no
 * pick: the feature joins or cuts the bodies it touches.
 */
function parseTargetBodies(
  args: Record<string, unknown>,
  partId: PartId,
): Result<BodyRef[] | undefined, ToolExecutionError> {
  const raw = args['targetBodies'];
  if (raw === undefined) return ok(undefined);
  if (!Array.isArray(raw) || !raw.every((s) => typeof s === 'string' && s.length > 0)) {
    return err(invalidInput('`targetBodies` must be an array of bodyId strings'));
  }
  if (raw.length === 0) return ok(undefined);
  return ok((raw as string[]).map((id) => ({ partId, bodyId: id as BodyId })));
}

function hostError(message: string): ToolExecutionError {
  return { code: 'HOST_ERROR', message };
}

/**
 * The host returns `getDocument()` as `unknown` because the bridge
 * type-erases. Cast at the seam — these executors are intentionally
 * the ONE place where we trust the document shape.
 */
function asProject(doc: unknown): CadProject {
  return doc as CadProject;
}

// ---- Document inspection helpers -------------------------------------------

/**
 * Walk the document and return `(partId, feature)` for a feature
 * id, or null if not found. Used by the sketch_draw_* tools to
 * locate the sketch they're appending to without trusting the
 * caller to know the partId.
 */
function findFeatureLocation(
  doc: CadProject,
  featureId: string,
): { partId: PartId; feature: FeatureNode } | null {
  for (const [partId, part] of Object.entries(doc.parts)) {
    const feature = part.timeline.find((f) => f.id === featureId);
    if (feature) return { partId: partId as PartId, feature };
  }
  return null;
}

/** Return the part id that owns the given sketch, or null. */
function resolveSketchPart(doc: CadProject, sketchId: string): PartId | null {
  const loc = findFeatureLocation(doc, sketchId);
  if (!loc) return null;
  if (loc.feature.type !== 'sketch') return null;
  return loc.partId;
}

/**
 * Get a sketch's flat `entities` Record. Returns an empty object if
 * the sketch doesn't exist or hasn't been drawn into yet — that's
 * also a valid before-state for a brand-new sketch.
 */
function sketchEntities(
  doc: CadProject,
  sketchId: string,
): Record<EntityId, unknown> {
  const loc = findFeatureLocation(doc, sketchId);
  if (!loc || loc.feature.type !== 'sketch') return {};
  const inputs = loc.feature.inputs as unknown as SketchFeatureInputs;
  return sketchBuildGeometry(inputs);
}

/**
 * Diff two entity maps and return the id of the entity that appears
 * in `after` but not `before`. There should be exactly one — that's
 * the entity the drawing command just created.
 */
function diffNewEntityId(
  before: Record<EntityId, unknown>,
  after: Record<EntityId, unknown>,
): EntityId | null {
  const beforeKeys = new Set(Object.keys(before));
  for (const id of Object.keys(after)) {
    if (!beforeKeys.has(id)) return id as EntityId;
  }
  return null;
}

/**
 * Diff two entity maps and return ALL ids in `after` that aren't in
 * `before`. Used by `sketch_draw_polygon` (which emits N line entities
 * + a construction-point geometry) and any future multi-entity draw
 * tool. Order matches `after`'s iteration order which, per the JS
 * spec, is insertion order — so the result is stable.
 */
function diffNewEntityIds(
  before: Record<EntityId, unknown>,
  after: Record<EntityId, unknown>,
): EntityId[] {
  const beforeKeys = new Set(Object.keys(before));
  const out: EntityId[] = [];
  for (const id of Object.keys(after)) {
    if (!beforeKeys.has(id)) out.push(id as EntityId);
  }
  return out;
}

/**
 * Read the editor-state geometry id set for a sketch. Returns an empty
 * set if the sketch hasn't been drawn into yet. Used by drawing tools
 * to mint per-primitive geometry ids without depending on which side of
 * the document/editor pair allocated them — every editor geometry has a
 * matching entity id, but constraint references still index by editor
 * geometry id so the diff stays here as a thin provenance helper for
 * downstream constraint-aware tooling.
 */
function sketchGeometryIds(
  doc: CadProject,
  sketchId: string,
): Set<string> {
  const loc = findFeatureLocation(doc, sketchId);
  if (!loc || loc.feature.type !== 'sketch') return new Set();
  const inputs = loc.feature.inputs as unknown as SketchFeatureInputs;
  const geoms = (inputs.editorModel?.geometries ?? []) as Array<{ id: string }>;
  return new Set(geoms.map((g) => g.id));
}

/**
 * Diff two editor-state geometry id sets and return the first id new
 * in `after`. Used by primitives that don't have a document-`entities`
 * projection yet (ellipse, spline, point) — see `sketchGeometryIds`.
 */
function diffNewGeometryId(
  before: Set<string>,
  after: Set<string>,
): string | null {
  for (const id of after) {
    if (!before.has(id)) return id;
  }
  return null;
}

/**
 * Diff the feature timeline of a part and return the id of the
 * newly-appended feature. Most timeline writes append to the end, so
 * we just check the last entry isn't in the before-set.
 */
function diffNewFeatureId(
  beforePart: { timeline: ReadonlyArray<FeatureNode> } | undefined,
  afterPart: { timeline: ReadonlyArray<FeatureNode> } | undefined,
): FeatureId | null {
  if (!afterPart) return null;
  const beforeIds = new Set((beforePart?.timeline ?? []).map((f) => f.id));
  for (const f of afterPart.timeline) {
    if (!beforeIds.has(f.id)) return f.id;
  }
  return null;
}

// ---- Tool executors --------------------------------------------------------

/**
 * A `{ bodyId, stableFaceId }` tool argument → a face `PlaneRef` in
 * `partId`. The worker re-resolves the face on every rebuild and fails the
 * feature if it is gone or not planar.
 */
function parseFaceArg(
  v: unknown,
  partId: PartId,
  name: string,
): Result<PlaneRef, ToolExecutionError> {
  if (!isRecord(v) || typeof v['bodyId'] !== 'string' || typeof v['stableFaceId'] !== 'string') {
    return err(invalidInput(`\`${name}\` must be { bodyId: string, stableFaceId: string } (ids from list_bodies / list_faces)`));
  }
  return ok({
    type: 'stableTopology',
    bodyRef: { partId, bodyId: v['bodyId'] as BodyId },
    stableFaceId: stableFaceId(v['stableFaceId']),
  });
}

/**
 * sketch_create — `CreateSketch` on a default plane (`plane` shorthand) or
 * on a planar body face (`face`). Returns `{ sketchId }`.
 */
export async function executeSketchCreate(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ sketchId: FeatureId }, ToolExecutionError>> {
  const partId = args['partId'];
  const plane = args['plane'];
  const face = args['face'];
  if (typeof partId !== 'string') return err(invalidInput('`partId` must be a string'));
  if ((plane === undefined) === (face === undefined)) {
    return err(invalidInput('Pass exactly one of `plane` or `face`'));
  }
  if (plane !== undefined && plane !== 'XY' && plane !== 'XZ' && plane !== 'YZ') {
    return err(invalidInput("`plane` must be one of 'XY', 'XZ', 'YZ'"));
  }

  const before = asProject(host.getDocument());
  if (!before.parts[partId as PartId]) {
    return err({ code: 'INVALID_INPUT', message: `Part not found: ${partId}` });
  }

  let planeRef: PlaneRef;
  if (face !== undefined) {
    const parsed = parseFaceArg(face, partId as PartId, 'face');
    if (!parsed.ok) return parsed;
    planeRef = parsed.value;
  } else {
    planeRef = { type: 'defaultPlane', name: plane as 'XY' | 'XZ' | 'YZ' };
  }

  const cmd: CadCommand = {
    type: 'CreateSketch',
    partId: partId as PartId,
    plane: planeRef,
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewFeatureId(
      before.parts[partId as PartId],
      after.parts[partId as PartId],
    );
    if (!newId) return err(hostError('CreateSketch dispatched but no new feature id found'));
    return ok({ sketchId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_draw_line — `SketchDrawLine` with id-diff return.
 * Returns `{ entityId }`.
 */
export async function executeSketchDrawLine(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ entityId: EntityId }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const from = args['from'];
  const to = args['to'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!isVec2(from)) return err(invalidInput('`from` must be a [number, number]'));
  if (!isVec2(to)) return err(invalidInput('`to` must be a [number, number]'));

  const before = asProject(host.getDocument());
  const beforeEnts = sketchEntities(before, sketchId);

  const cmd: CadCommand = {
    type: 'SketchDrawLine',
    sketchId: sketchId as FeatureId,
    from,
    to,
    ...(typeof args['construction'] === 'boolean' ? { construction: args['construction'] } : {}),
    ...(typeof args['tolerance'] === 'number' ? { tolerance: args['tolerance'] } : {}),
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewEntityId(beforeEnts, sketchEntities(after, sketchId));
    if (!newId) return err(hostError('SketchDrawLine dispatched but no new entity id found'));
    return ok({ entityId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_draw_rectangle — `SketchDrawRectangle` with id-diff return.
 * Returns `{ entityId }` (the single collapsed rectangle entity id).
 */
export async function executeSketchDrawRectangle(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ entityId: EntityId }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const corner = args['corner'];
  const width = args['width'];
  const height = args['height'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!isVec2(corner)) return err(invalidInput('`corner` must be a [number, number]'));
  if (typeof width !== 'number' || !Number.isFinite(width) || width === 0) {
    return err(invalidInput('`width` must be a non-zero finite number'));
  }
  if (typeof height !== 'number' || !Number.isFinite(height) || height === 0) {
    return err(invalidInput('`height` must be a non-zero finite number'));
  }

  const before = asProject(host.getDocument());
  const beforeEnts = sketchEntities(before, sketchId);

  const cmd: CadCommand = {
    type: 'SketchDrawRectangle',
    sketchId: sketchId as FeatureId,
    corner,
    width,
    height,
    ...(typeof args['construction'] === 'boolean' ? { construction: args['construction'] } : {}),
    ...(typeof args['tolerance'] === 'number' ? { tolerance: args['tolerance'] } : {}),
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewEntityId(beforeEnts, sketchEntities(after, sketchId));
    if (!newId) return err(hostError('SketchDrawRectangle dispatched but no new entity id found'));
    return ok({ entityId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_draw_circle — `SketchDrawCircle` with id-diff return.
 * Returns `{ entityId }`.
 */
export async function executeSketchDrawCircle(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ entityId: EntityId }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const center = args['center'];
  const radius = args['radius'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!isVec2(center)) return err(invalidInput('`center` must be a [number, number]'));
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
    return err(invalidInput('`radius` must be a positive finite number'));
  }

  const before = asProject(host.getDocument());
  const beforeEnts = sketchEntities(before, sketchId);

  const cmd: CadCommand = {
    type: 'SketchDrawCircle',
    sketchId: sketchId as FeatureId,
    center,
    radius,
    ...(typeof args['construction'] === 'boolean' ? { construction: args['construction'] } : {}),
    ...(typeof args['tolerance'] === 'number' ? { tolerance: args['tolerance'] } : {}),
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewEntityId(beforeEnts, sketchEntities(after, sketchId));
    if (!newId) return err(hostError('SketchDrawCircle dispatched but no new entity id found'));
    return ok({ entityId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_draw_slot — `SketchDrawSlot` with id-diff return.
 * Returns `{ entityId }`.
 */
export async function executeSketchDrawSlot(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ entityId: EntityId }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const center1 = args['center1'];
  const center2 = args['center2'];
  const width = args['width'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!isVec2(center1)) return err(invalidInput('`center1` must be a [number, number]'));
  if (!isVec2(center2)) return err(invalidInput('`center2` must be a [number, number]'));
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
    return err(invalidInput('`width` must be a positive finite number'));
  }

  const before = asProject(host.getDocument());
  const beforeEnts = sketchEntities(before, sketchId);

  const cmd: CadCommand = {
    type: 'SketchDrawSlot',
    sketchId: sketchId as FeatureId,
    center1,
    center2,
    width,
    ...(typeof args['construction'] === 'boolean' ? { construction: args['construction'] } : {}),
    ...(typeof args['tolerance'] === 'number' ? { tolerance: args['tolerance'] } : {}),
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewEntityId(beforeEnts, sketchEntities(after, sketchId));
    if (!newId) return err(hostError('SketchDrawSlot dispatched but no new entity id found'));
    return ok({ entityId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_draw_arc — `SketchDrawArc` with id-diff return.
 * Returns `{ entityId }`.
 */
export async function executeSketchDrawArc(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ entityId: EntityId }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const center = args['center'];
  const radius = args['radius'];
  const startAngle = args['startAngle'];
  const endAngle = args['endAngle'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!isVec2(center)) return err(invalidInput('`center` must be a [number, number]'));
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
    return err(invalidInput('`radius` must be a positive finite number'));
  }
  if (typeof startAngle !== 'number' || !Number.isFinite(startAngle)) {
    return err(invalidInput('`startAngle` must be a finite number (radians)'));
  }
  if (typeof endAngle !== 'number' || !Number.isFinite(endAngle)) {
    return err(invalidInput('`endAngle` must be a finite number (radians)'));
  }

  const before = asProject(host.getDocument());
  const beforeEnts = sketchEntities(before, sketchId);

  const cmd: CadCommand = {
    type: 'SketchDrawArc',
    sketchId: sketchId as FeatureId,
    center,
    radius,
    startAngle,
    endAngle,
    ...(typeof args['construction'] === 'boolean' ? { construction: args['construction'] } : {}),
    ...(typeof args['tolerance'] === 'number' ? { tolerance: args['tolerance'] } : {}),
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewEntityId(beforeEnts, sketchEntities(after, sketchId));
    if (!newId) return err(hostError('SketchDrawArc dispatched but no new entity id found'));
    return ok({ entityId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_draw_arc3point — `SketchDrawArc3Point` with id-diff return.
 * Delegates internally to drawArc (same arc geometry), so the produced
 * entity is a single SketchArcEntity. Returns `{ entityId }`.
 */
export async function executeSketchDrawArc3Point(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ entityId: EntityId }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const start = args['start'];
  const mid = args['mid'];
  const end = args['end'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!isVec2(start)) return err(invalidInput('`start` must be a [number, number]'));
  if (!isVec2(mid)) return err(invalidInput('`mid` must be a [number, number]'));
  if (!isVec2(end)) return err(invalidInput('`end` must be a [number, number]'));

  const before = asProject(host.getDocument());
  const beforeEnts = sketchEntities(before, sketchId);

  const cmd: CadCommand = {
    type: 'SketchDrawArc3Point',
    sketchId: sketchId as FeatureId,
    start,
    mid,
    end,
    ...(typeof args['construction'] === 'boolean' ? { construction: args['construction'] } : {}),
    ...(typeof args['tolerance'] === 'number' ? { tolerance: args['tolerance'] } : {}),
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewEntityId(beforeEnts, sketchEntities(after, sketchId));
    if (!newId) return err(hostError('SketchDrawArc3Point dispatched but no new entity id found'));
    return ok({ entityId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_draw_polygon — `SketchDrawPolygon` (decomposed N-gon).
 * Emits N SketchLineEntity records (one per side); polygon has no
 * composite document entity (invariant #11). Returns `{ entityIds }`
 * with the N new line ids — the caller passes the whole list as
 * `ProfileRef.wireEntityIds` to extrude the polygon as a single profile.
 */
export async function executeSketchDrawPolygon(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ entityIds: EntityId[] }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const center = args['center'];
  const vertex = args['vertex'];
  const sides = args['sides'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!isVec2(center)) return err(invalidInput('`center` must be a [number, number]'));
  if (!isVec2(vertex)) return err(invalidInput('`vertex` must be a [number, number]'));
  if (typeof sides !== 'number' || !Number.isInteger(sides) || sides < 3 || sides > 64) {
    return err(invalidInput('`sides` must be an integer in [3, 64]'));
  }

  const before = asProject(host.getDocument());
  const beforeEnts = sketchEntities(before, sketchId);

  const cmd: CadCommand = {
    type: 'SketchDrawPolygon',
    sketchId: sketchId as FeatureId,
    center,
    vertex,
    sides,
    ...(typeof args['construction'] === 'boolean' ? { construction: args['construction'] } : {}),
    ...(typeof args['tolerance'] === 'number' ? { tolerance: args['tolerance'] } : {}),
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newIds = diffNewEntityIds(beforeEnts, sketchEntities(after, sketchId));
    if (newIds.length === 0) return err(hostError('SketchDrawPolygon dispatched but no new entity ids found'));
    return ok({ entityIds: newIds });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_draw_ellipse — `SketchDrawEllipse`. Returns the new
 * SketchGeometryId so the caller can reference it in subsequent
 * `sketch_apply_constraint` calls. (The ellipse also appears in the
 * document `entities` projection with a matching id, but constraints
 * index by editor-state geometry id either way.)
 */
export async function executeSketchDrawEllipse(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ geometryId: string }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const center = args['center'];
  const major = args['major'];
  const minorRadius = args['minorRadius'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!isVec2(center)) return err(invalidInput('`center` must be a [number, number]'));
  if (!isVec2(major)) return err(invalidInput('`major` must be a [number, number]'));
  if (typeof minorRadius !== 'number' || !Number.isFinite(minorRadius) || minorRadius <= 0) {
    return err(invalidInput('`minorRadius` must be a positive finite number'));
  }

  const before = asProject(host.getDocument());
  const beforeGeoms = sketchGeometryIds(before, sketchId);

  const cmd: CadCommand = {
    type: 'SketchDrawEllipse',
    sketchId: sketchId as FeatureId,
    center,
    major,
    minorRadius,
    ...(typeof args['construction'] === 'boolean' ? { construction: args['construction'] } : {}),
    ...(typeof args['tolerance'] === 'number' ? { tolerance: args['tolerance'] } : {}),
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewGeometryId(beforeGeoms, sketchGeometryIds(after, sketchId));
    if (!newId) return err(hostError('SketchDrawEllipse dispatched but no new geometry id found'));
    return ok({ geometryId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_draw_spline — `SketchDrawSpline`. Returns the new
 * SketchGeometryId. Also projected into the document `entities` map.
 */
export async function executeSketchDrawSpline(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ geometryId: string }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const points = args['points'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!Array.isArray(points) || points.length < 2 || !points.every(isVec2)) {
    return err(invalidInput('`points` must be an array of ≥2 [number, number] pairs'));
  }

  const before = asProject(host.getDocument());
  const beforeGeoms = sketchGeometryIds(before, sketchId);

  const cmd: CadCommand = {
    type: 'SketchDrawSpline',
    sketchId: sketchId as FeatureId,
    points: points as ReadonlyArray<[number, number]>,
    ...(typeof args['construction'] === 'boolean' ? { construction: args['construction'] } : {}),
    ...(typeof args['tolerance'] === 'number' ? { tolerance: args['tolerance'] } : {}),
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewGeometryId(beforeGeoms, sketchGeometryIds(after, sketchId));
    if (!newId) return err(hostError('SketchDrawSpline dispatched but no new geometry id found'));
    return ok({ geometryId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_draw_point — `SketchDrawPoint` (standalone reference point).
 * Returns the new SketchGeometryId; the underlying SketchPointId is
 * reachable via `list_sketch_elements`. Also projected into the
 * document `entities` map.
 */
export async function executeSketchDrawPoint(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ geometryId: string }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const at = args['at'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!isVec2(at)) return err(invalidInput('`at` must be a [number, number]'));

  const before = asProject(host.getDocument());
  const beforeGeoms = sketchGeometryIds(before, sketchId);

  const cmd: CadCommand = {
    type: 'SketchDrawPoint',
    sketchId: sketchId as FeatureId,
    at,
    ...(typeof args['construction'] === 'boolean' ? { construction: args['construction'] } : {}),
    ...(typeof args['tolerance'] === 'number' ? { tolerance: args['tolerance'] } : {}),
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewGeometryId(beforeGeoms, sketchGeometryIds(after, sketchId));
    if (!newId) return err(hostError('SketchDrawPoint dispatched but no new geometry id found'));
    return ok({ geometryId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * feature_extrude — `CreateExtrude` with:
 *
 *   - **Auto-profile.** When `profiles` is omitted, the wrapper fills
 *     it with every closed region detected in the sketch (each region
 *     becomes one ProfileRef with `wireEntityIds = region.entityIds`
 *     and `interiorPoint` = a point inside the region's material).
 *
 *   - **Partid resolution.** The caller passes only `sketchId`; we
 *     walk the doc to find its part.
 *
 *   - **Shape translation.** The tool-facing shape is flat
 *     (`distance: 5, direction: 'normal'`); the CadCommand shape is
 *     nested (`extent: { type: 'distance', value: '5' }`,
 *     `direction: { type: 'normal' }`). `startFace` / `toFace`
 *     (`{ bodyId, stableFaceId }`) become `startFrom` and a `toPlane`
 *     extent on that face.
 *
 * Returns `{ featureId }` — the new extrude feature in the part timeline.
 */
export async function executeFeatureExtrude(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ featureId: FeatureId }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const distance = args['distance'];
  const toFaceArg = args['toFace'];
  const startFaceArg = args['startFace'];
  const startOffsetArg = args['startOffset'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (toFaceArg !== undefined) {
    if (distance !== undefined) return err(invalidInput('Pass `distance` or `toFace`, not both'));
  } else if (typeof distance !== 'number' || !Number.isFinite(distance) || distance === 0) {
    return err(invalidInput('`distance` must be a non-zero finite number (mm)'));
  }
  if (startOffsetArg !== undefined && (typeof startOffsetArg !== 'number' || !Number.isFinite(startOffsetArg))) {
    return err(invalidInput('`startOffset` must be a finite number (mm)'));
  }

  const opRaw = args['operation'];
  const operation = opRaw === undefined ? 'newBody' : opRaw;
  if (operation !== 'newBody' && operation !== 'join' && operation !== 'cut') {
    return err(invalidInput("`operation` must be 'newBody', 'join', or 'cut'"));
  }

  const dirRaw = args['direction'];
  const direction = dirRaw === undefined ? 'normal' : dirRaw;
  if (direction !== 'normal' && direction !== 'reversed' && direction !== 'symmetric') {
    return err(invalidInput("`direction` must be 'normal', 'reversed', or 'symmetric'"));
  }
  if (direction === 'symmetric' && toFaceArg !== undefined) {
    return err(invalidInput("`toFace` can't be combined with direction 'symmetric'"));
  }

  const before = asProject(host.getDocument());
  const partId = resolveSketchPart(before, sketchId);
  if (!partId) {
    return err(invalidInput(`Sketch not found or not a sketch feature: ${sketchId}`));
  }
  const targets = parseTargetBodies(args, partId);
  if (!targets.ok) return targets;
  let toFace: PlaneRef | undefined;
  if (toFaceArg !== undefined) {
    const parsed = parseFaceArg(toFaceArg, partId, 'toFace');
    if (!parsed.ok) return parsed;
    toFace = parsed.value;
  }
  let startFrom: PlaneRef | undefined;
  if (startFaceArg !== undefined) {
    const parsed = parseFaceArg(startFaceArg, partId, 'startFace');
    if (!parsed.ok) return parsed;
    startFrom = parsed.value;
  }

  // Build profiles: either from the caller's explicit list, or auto-fill
  // from the sketch's detected regions.
  let profiles: ProfileRef[];
  const profilesArg = args['profiles'];
  if (Array.isArray(profilesArg)) {
    if (profilesArg.length === 0) {
      return err(invalidInput('`profiles` (if provided) must contain at least one entry'));
    }
    profiles = [];
    for (const p of profilesArg) {
      if (!isRecord(p)) return err(invalidInput('Each profile must be an object'));
      const wireIds = p['wireEntityIds'];
      if (!Array.isArray(wireIds) || wireIds.length === 0 || !wireIds.every((s) => typeof s === 'string')) {
        return err(invalidInput('Each profile needs `wireEntityIds: string[]` (non-empty)'));
      }
      const ref: ProfileRef = {
        sketchId: sketchId as FeatureId,
        wireEntityIds: wireIds as EntityId[],
      };
      const ip = p['interiorPoint'];
      if (isVec2(ip)) ref.interiorPoint = ip;
      profiles.push(ref);
    }
  } else {
    // Auto-profile: enumerate every closed region in the sketch.
    const entities = sketchEntities(before, sketchId);
    const regions = detectSketchRegions(entities as never);
    if (regions.length === 0) {
      return err(invalidInput(
        `Sketch ${sketchId} has no closed profiles to extrude. ` +
          'Draw at least one closed shape first (rectangle, circle, or a closed loop of lines).',
      ));
    }
    profiles = regions.map((r) => {
      const ref: ProfileRef = {
        sketchId: sketchId as FeatureId,
        wireEntityIds: r.entityIds,
      };
      const interior = regionInteriorPoint(r);
      if (Number.isFinite(interior[0]) && Number.isFinite(interior[1])) ref.interiorPoint = interior;
      return ref;
    });
  }

  // Build the ExtrudeFeatureInputs. 'symmetric' direction maps to a
  // symmetric extent; `toFace` to a toPlane extent on that face;
  // otherwise we use a distance extent with the matching direction.
  const distanceStr = String(distance);
  const inputs: ExtrudeFeatureInputs =
    direction === 'symmetric'
      ? {
          profiles,
          operation: operation as 'newBody' | 'join' | 'cut',
          direction: { type: 'normal' },
          extent: { type: 'symmetric', value: distanceStr },
        }
      : {
          profiles,
          operation: operation as 'newBody' | 'join' | 'cut',
          direction: { type: direction as 'normal' | 'reversed' },
          extent: toFace
            ? { type: 'toPlane', plane: toFace }
            : { type: 'distance', value: distanceStr },
        };
  if (startFrom) inputs.startFrom = startFrom;
  if (startOffsetArg !== undefined) inputs.startOffset = String(startOffsetArg);
  if (targets.value) inputs.targetBodies = targets.value;

  const cmd: CadCommand = {
    type: 'CreateExtrude',
    partId,
    inputs,
  };

  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewFeatureId(before.parts[partId], after.parts[partId]);
    if (!newId) return err(hostError('CreateExtrude dispatched but no new feature id found'));
    return ok({ featureId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

// ---- Edge / face modification executors ----------------------------------
//
// Fillet, chamfer, and hole all touch an existing body via stable
// edge / face references. The wrappers take a flat shape
// (`{ partId, bodyId, stableEdgeIds | stableFaceId, radius/distance }`)
// and build the matching `EdgeRef` / `FaceRef` envelopes that the
// CadCommand expects. The caller discovers the ids via list_edges /
// list_faces — same flow that the in-app UI's edge picker uses.

/**
 * feature_fillet — `CreateFillet` with the flat tool-facing shape:
 *   { partId, bodyId, stableEdgeIds: string[], radius: number }
 *
 * Each id becomes an `EdgeRef.stableTopology` referencing the same
 * `BodyRef`. All edges must belong to the same body — the underlying
 * builder rejects mixed bodies, and we don't try to be smarter.
 *
 * Returns `{ featureId }`.
 */
export async function executeFeatureFillet(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ featureId: FeatureId }, ToolExecutionError>> {
  const partIdArg = args['partId'];
  const bodyIdArg = args['bodyId'];
  const edgeIdsArg = args['stableEdgeIds'];
  const radiusArg = args['radius'];

  if (typeof partIdArg !== 'string') return err(invalidInput('`partId` must be a string'));
  if (typeof bodyIdArg !== 'string') return err(invalidInput('`bodyId` must be a string'));
  if (!Array.isArray(edgeIdsArg) || edgeIdsArg.length === 0 || !edgeIdsArg.every((s) => typeof s === 'string')) {
    return err(invalidInput('`stableEdgeIds` must be a non-empty array of strings'));
  }
  if (typeof radiusArg !== 'number' || !Number.isFinite(radiusArg) || radiusArg <= 0) {
    return err(invalidInput('`radius` must be a positive finite number (mm)'));
  }

  const before = asProject(host.getDocument());
  if (!before.parts[partIdArg as PartId]) {
    return err(invalidInput(`Part not found: ${partIdArg}`));
  }

  const bodyRef: BodyRef = { partId: partIdArg as PartId, bodyId: bodyIdArg as BodyId };
  const edges: EdgeRef[] = (edgeIdsArg as string[]).map((id) => ({
    type: 'stableTopology' as const,
    bodyRef,
    stableEdgeId: stableEdgeId(id),
  }));
  const inputs: FilletFeatureInputs = {
    edges,
    radius: String(radiusArg),
  };

  const cmd: CadCommand = {
    type: 'CreateFillet',
    partId: partIdArg as PartId,
    inputs,
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewFeatureId(
      before.parts[partIdArg as PartId],
      after.parts[partIdArg as PartId],
    );
    if (!newId) return err(hostError('CreateFillet dispatched but no new feature id found'));
    return ok({ featureId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * feature_chamfer — `CreateChamfer`. Field-for-field equivalent of
 * `feature_fillet` but takes `distance` instead of `radius` (setback
 * per face — symmetric chamfer only in v1, matching the schema).
 *
 * Returns `{ featureId }`.
 */
export async function executeFeatureChamfer(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ featureId: FeatureId }, ToolExecutionError>> {
  const partIdArg = args['partId'];
  const bodyIdArg = args['bodyId'];
  const edgeIdsArg = args['stableEdgeIds'];
  const distanceArg = args['distance'];

  if (typeof partIdArg !== 'string') return err(invalidInput('`partId` must be a string'));
  if (typeof bodyIdArg !== 'string') return err(invalidInput('`bodyId` must be a string'));
  if (!Array.isArray(edgeIdsArg) || edgeIdsArg.length === 0 || !edgeIdsArg.every((s) => typeof s === 'string')) {
    return err(invalidInput('`stableEdgeIds` must be a non-empty array of strings'));
  }
  if (typeof distanceArg !== 'number' || !Number.isFinite(distanceArg) || distanceArg <= 0) {
    return err(invalidInput('`distance` must be a positive finite number (mm)'));
  }

  const before = asProject(host.getDocument());
  if (!before.parts[partIdArg as PartId]) {
    return err(invalidInput(`Part not found: ${partIdArg}`));
  }

  const bodyRef: BodyRef = { partId: partIdArg as PartId, bodyId: bodyIdArg as BodyId };
  const edges: EdgeRef[] = (edgeIdsArg as string[]).map((id) => ({
    type: 'stableTopology' as const,
    bodyRef,
    stableEdgeId: stableEdgeId(id),
  }));
  const inputs: ChamferFeatureInputs = {
    edges,
    distance: String(distanceArg),
  };

  const cmd: CadCommand = {
    type: 'CreateChamfer',
    partId: partIdArg as PartId,
    inputs,
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewFeatureId(
      before.parts[partIdArg as PartId],
      after.parts[partIdArg as PartId],
    );
    if (!newId) return err(hostError('CreateChamfer dispatched but no new feature id found'));
    return ok({ featureId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * feature_hole — `CreateHole` with the simple (cylindrical) variant
 * for v1. The caller picks a face via `list_faces` (using its
 * `stableFaceId`), passes 2D center coords on that face, plus
 * `diameter` and `depth`. Counterbore / countersink kinds are exposed
 * via optional fields — present when `kind` selects them.
 *
 * Returns `{ featureId }`.
 */
export async function executeFeatureHole(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ featureId: FeatureId }, ToolExecutionError>> {
  const partIdArg = args['partId'];
  const bodyIdArg = args['bodyId'];
  const faceIdArg = args['stableFaceId'];
  const centerArg = args['center'];
  const diameterArg = args['diameter'];
  const depthArg = args['depth'];
  const kindArg = args['kind'] ?? 'simple';

  if (typeof partIdArg !== 'string') return err(invalidInput('`partId` must be a string'));
  if (typeof bodyIdArg !== 'string') return err(invalidInput('`bodyId` must be a string'));
  if (typeof faceIdArg !== 'string') return err(invalidInput('`stableFaceId` must be a string'));
  if (!isVec2(centerArg)) return err(invalidInput('`center` must be a [number, number] (in face-local coords, mm)'));
  if (typeof diameterArg !== 'number' || !Number.isFinite(diameterArg) || diameterArg <= 0) {
    return err(invalidInput('`diameter` must be a positive finite number (mm)'));
  }
  if (typeof depthArg !== 'number' || !Number.isFinite(depthArg) || depthArg <= 0) {
    return err(invalidInput('`depth` must be a positive finite number (mm). Use a large value for through-hole effect.'));
  }
  if (kindArg !== 'simple' && kindArg !== 'counterbore' && kindArg !== 'countersink') {
    return err(invalidInput("`kind` must be 'simple', 'counterbore', or 'countersink'"));
  }

  const before = asProject(host.getDocument());
  if (!before.parts[partIdArg as PartId]) {
    return err(invalidInput(`Part not found: ${partIdArg}`));
  }

  const bodyRef: BodyRef = { partId: partIdArg as PartId, bodyId: bodyIdArg as BodyId };
  const face: FaceRef = {
    type: 'stableTopology',
    bodyRef,
    stableFaceId: stableFaceId(faceIdArg),
  };

  const inputs: HoleFeatureInputs = {
    face,
    center: [String(centerArg[0]), String(centerArg[1])],
    direction: { type: 'normal' },
    diameter: String(diameterArg),
    extent: { type: 'distance', value: String(depthArg) },
    kind: kindArg as 'simple' | 'counterbore' | 'countersink',
  };

  // Counterbore / countersink optional fields. The schema treats them
  // as required only when `kind` matches; we forward whatever the
  // caller passed and let the builder reject impossible combinations.
  if (kindArg === 'counterbore') {
    const cbDia = args['counterboreDiameter'];
    const cbDepth = args['counterboreDepth'];
    if (typeof cbDia !== 'number' || !Number.isFinite(cbDia) || cbDia <= diameterArg) {
      return err(invalidInput('`counterboreDiameter` must be a positive number larger than `diameter`.'));
    }
    if (typeof cbDepth !== 'number' || !Number.isFinite(cbDepth) || cbDepth <= 0) {
      return err(invalidInput('`counterboreDepth` must be a positive number (mm).'));
    }
    inputs.counterboreDiameter = String(cbDia);
    inputs.counterboreDepth = String(cbDepth);
  } else if (kindArg === 'countersink') {
    const csDia = args['countersinkDiameter'];
    const csAngle = args['countersinkAngle'] ?? 90;
    if (typeof csDia !== 'number' || !Number.isFinite(csDia) || csDia <= diameterArg) {
      return err(invalidInput('`countersinkDiameter` must be a positive number larger than `diameter`.'));
    }
    if (typeof csAngle !== 'number' || !Number.isFinite(csAngle) || csAngle <= 0 || csAngle >= 180) {
      return err(invalidInput('`countersinkAngle` must be a positive number of degrees (0 < a < 180). Default 90.'));
    }
    inputs.countersinkDiameter = String(csDia);
    inputs.countersinkAngle = String(csAngle);
  }

  const cmd: CadCommand = {
    type: 'CreateHole',
    partId: partIdArg as PartId,
    inputs,
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewFeatureId(
      before.parts[partIdArg as PartId],
      after.parts[partIdArg as PartId],
    );
    if (!newId) return err(hostError('CreateHole dispatched but no new feature id found'));
    return ok({ featureId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

// ---- Body-replication executors ------------------------------------------
//
// Revolve, Mirror, Pattern. Each takes a flat tool-facing shape and
// builds the matching CadCommand `inputs` envelope.

/**
 * feature_revolve — `CreateRevolve` with auto-profile + axis shorthand.
 *
 * Mirrors the `feature_extrude` ergonomics:
 *  - `sketchId` resolves to its part; the caller doesn't pass partId.
 *  - When `profile` is omitted, the wrapper picks the FIRST closed
 *    region detected in the sketch (revolve takes one profile, unlike
 *    extrude which can take many).
 *  - `axis` accepts the shorthand 'x' | 'y' | 'z' for the sketch's
 *    own X/Y/Z directions. For custom axes (along a picked edge) use
 *    `dispatch_command` with the full RevolveFeatureInputs shape.
 *
 * Returns `{ featureId }`. CALL `wait_for_rebuild` then
 * `get_diagnostics` afterward.
 */
export async function executeFeatureRevolve(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ featureId: FeatureId }, ToolExecutionError>> {
  const sketchIdArg = args['sketchId'];
  const angleArg = args['angle'];
  const axisArg = args['axis'];

  if (typeof sketchIdArg !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (typeof angleArg !== 'number' || !Number.isFinite(angleArg) || angleArg === 0) {
    return err(invalidInput('`angle` must be a non-zero finite number (degrees)'));
  }
  if (axisArg !== 'x' && axisArg !== 'y' && axisArg !== 'z') {
    return err(invalidInput("`axis` must be 'x', 'y', or 'z'"));
  }

  const opArg = args['operation'] ?? 'newBody';
  if (opArg !== 'newBody' && opArg !== 'join' && opArg !== 'cut') {
    return err(invalidInput("`operation` must be 'newBody', 'join', or 'cut'"));
  }

  const before = asProject(host.getDocument());
  const partId = resolveSketchPart(before, sketchIdArg);
  if (!partId) return err(invalidInput(`Sketch not found or not a sketch feature: ${sketchIdArg}`));
  const targets = parseTargetBodies(args, partId);
  if (!targets.ok) return targets;

  // Build the profile. Prefer the caller's explicit profile if given;
  // otherwise auto-pick the first detected region.
  let profile: ProfileRef;
  const profileArg = args['profile'];
  if (isRecord(profileArg)) {
    const wireIds = profileArg['wireEntityIds'];
    if (!Array.isArray(wireIds) || wireIds.length === 0 || !wireIds.every((s) => typeof s === 'string')) {
      return err(invalidInput('`profile.wireEntityIds` must be a non-empty array of strings'));
    }
    profile = {
      sketchId: sketchIdArg as FeatureId,
      wireEntityIds: wireIds as EntityId[],
    };
    const ip = profileArg['interiorPoint'];
    if (isVec2(ip)) profile.interiorPoint = ip;
  } else {
    const entities = sketchEntities(before, sketchIdArg);
    const regions = detectSketchRegions(entities as never);
    if (regions.length === 0) {
      return err(invalidInput(
        `Sketch ${sketchIdArg} has no closed profile to revolve. Draw at least one closed shape first.`,
      ));
    }
    const first = regions[0]!;
    profile = {
      sketchId: sketchIdArg as FeatureId,
      wireEntityIds: first.entityIds,
    };
    const interior = regionInteriorPoint(first);
    if (Number.isFinite(interior[0]) && Number.isFinite(interior[1])) profile.interiorPoint = interior;
  }

  const inputs: RevolveFeatureInputs = {
    profile,
    axis: { type: axisArg as 'x' | 'y' | 'z' },
    angle: String(angleArg),
    operation: opArg as 'newBody' | 'join' | 'cut',
    ...(targets.value ? { targetBodies: targets.value } : {}),
  };

  const cmd: CadCommand = {
    type: 'CreateRevolve',
    partId,
    inputs,
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewFeatureId(before.parts[partId], after.parts[partId]);
    if (!newId) return err(hostError('CreateRevolve dispatched but no new feature id found'));
    return ok({ featureId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * feature_mirror — `CreateMirror` with a plane shorthand.
 *
 * Agent shape: `{ partId, bodyId, plane: 'XY'|'YZ'|'XZ', operation? }`.
 * The wrapper assembles the `MirrorFeatureInputs` envelope.
 *
 * For mirroring across a construction plane or a body face, fall back
 * to `dispatch_command` — those PlaneRef variants need ids the caller
 * can supply but the wrapper doesn't yet validate.
 *
 * Returns `{ featureId }`.
 */
export async function executeFeatureMirror(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ featureId: FeatureId }, ToolExecutionError>> {
  const partIdArg = args['partId'];
  const bodyIdArg = args['bodyId'];
  const planeArg = args['plane'];
  const opArg = args['operation'] ?? 'newBody';

  if (typeof partIdArg !== 'string') return err(invalidInput('`partId` must be a string'));
  if (typeof bodyIdArg !== 'string') return err(invalidInput('`bodyId` must be a string'));
  if (planeArg !== 'XY' && planeArg !== 'YZ' && planeArg !== 'XZ') {
    return err(invalidInput("`plane` must be one of 'XY', 'YZ', 'XZ'"));
  }
  if (opArg !== 'newBody' && opArg !== 'join') {
    return err(invalidInput("`operation` must be 'newBody' or 'join'"));
  }

  const before = asProject(host.getDocument());
  if (!before.parts[partIdArg as PartId]) {
    return err(invalidInput(`Part not found: ${partIdArg}`));
  }

  const plane: PlaneRef = { type: 'defaultPlane', name: planeArg as 'XY' | 'YZ' | 'XZ' };
  const sourceBody: BodyRef = { partId: partIdArg as PartId, bodyId: bodyIdArg as BodyId };
  const inputs: MirrorFeatureInputs = {
    sourceBody,
    plane,
    operation: opArg as 'newBody' | 'join',
  };

  const cmd: CadCommand = {
    type: 'CreateMirror',
    partId: partIdArg as PartId,
    inputs,
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewFeatureId(
      before.parts[partIdArg as PartId],
      after.parts[partIdArg as PartId],
    );
    if (!newId) return err(hostError('CreateMirror dispatched but no new feature id found'));
    return ok({ featureId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * feature_pattern — `CreatePattern` dispatched as linear or circular.
 *
 * Linear shape:
 *   { partId, bodyId, patternType: 'linear', direction: 'x'|'y'|'z',
 *     count: int, spacing: mm }
 *
 * Circular shape:
 *   { partId, bodyId, patternType: 'circular', axis: 'x'|'y'|'z',
 *     count: int, fullAngle?: degrees (default 360) }
 *
 * Both variants treat the source body as instance #0 (count includes
 * the original). For axes / directions beyond the three Cartesian
 * shorthands, fall back to `dispatch_command`.
 *
 * Returns `{ featureId }`.
 */
export async function executeFeaturePattern(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ featureId: FeatureId }, ToolExecutionError>> {
  const partIdArg = args['partId'];
  const bodyIdArg = args['bodyId'];
  const patternType = args['patternType'];
  const countArg = args['count'];

  if (typeof partIdArg !== 'string') return err(invalidInput('`partId` must be a string'));
  if (typeof bodyIdArg !== 'string') return err(invalidInput('`bodyId` must be a string'));
  if (patternType !== 'linear' && patternType !== 'circular') {
    return err(invalidInput("`patternType` must be 'linear' or 'circular'"));
  }
  if (typeof countArg !== 'number' || !Number.isInteger(countArg) || countArg < 2) {
    return err(invalidInput('`count` must be an integer ≥ 2 (source body counts as instance #1).'));
  }

  const before = asProject(host.getDocument());
  if (!before.parts[partIdArg as PartId]) {
    return err(invalidInput(`Part not found: ${partIdArg}`));
  }

  const sourceBody: BodyRef = { partId: partIdArg as PartId, bodyId: bodyIdArg as BodyId };
  let inputs: LinearPatternInputs | CircularPatternInputs;

  if (patternType === 'linear') {
    const directionArg = args['direction'];
    const spacingArg = args['spacing'];
    if (directionArg !== 'x' && directionArg !== 'y' && directionArg !== 'z') {
      return err(invalidInput("Linear pattern: `direction` must be 'x', 'y', or 'z'"));
    }
    if (typeof spacingArg !== 'number' || !Number.isFinite(spacingArg) || spacingArg === 0) {
      return err(invalidInput('Linear pattern: `spacing` must be a non-zero finite number (mm)'));
    }
    const direction: AxisSpec = { type: directionArg as 'x' | 'y' | 'z' };
    inputs = {
      patternType: 'linear',
      sourceBody,
      direction,
      count: String(countArg),
      spacing: String(spacingArg),
    };
  } else {
    const axisArg = args['axis'];
    const fullAngleArg = args['fullAngle'] ?? 360;
    if (axisArg !== 'x' && axisArg !== 'y' && axisArg !== 'z') {
      return err(invalidInput("Circular pattern: `axis` must be 'x', 'y', or 'z'"));
    }
    if (typeof fullAngleArg !== 'number' || !Number.isFinite(fullAngleArg) || fullAngleArg === 0) {
      return err(invalidInput('Circular pattern: `fullAngle` must be a non-zero finite number (degrees, default 360)'));
    }
    // AxisSpec for circular needs origin + direction in custom; for
    // the cartesian shorthands the kernel pivots about the part origin
    // (matches the dialog's behavior). Use the typed shorthand.
    const axis: AxisSpec = { type: axisArg as 'x' | 'y' | 'z' };
    inputs = {
      patternType: 'circular',
      sourceBody,
      axis,
      count: String(countArg),
      fullAngle: String(fullAngleArg),
    };
  }

  const cmd: CadCommand = {
    type: 'CreatePattern',
    partId: partIdArg as PartId,
    inputs,
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewFeatureId(
      before.parts[partIdArg as PartId],
      after.parts[partIdArg as PartId],
    );
    if (!newId) return err(hostError('CreatePattern dispatched but no new feature id found'));
    return ok({ featureId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * feature_shell — `CreateShell` with a face-id shorthand.
 *
 * Agent shape: `{ partId, bodyId, removedFaceIds: string[], thickness, tolerance? }`.
 * Each id is a `stableFaceId` from `list_faces(bodyId)` and is converted
 * to a `FaceRef.stableTopology`. All faces must belong to the same
 * body (the builder rejects mixed-body inputs). Thickness grows inward
 * — to outward-shell, fall back to dispatch_command (the outward
 * toggle isn't on the schema yet).
 *
 * Returns `{ featureId }`.
 */
export async function executeFeatureShell(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ featureId: FeatureId }, ToolExecutionError>> {
  const partIdArg = args['partId'];
  const bodyIdArg = args['bodyId'];
  const faceIdsArg = args['removedFaceIds'];
  const thicknessArg = args['thickness'];
  const toleranceArg = args['tolerance'];

  if (typeof partIdArg !== 'string') return err(invalidInput('`partId` must be a string'));
  if (typeof bodyIdArg !== 'string') return err(invalidInput('`bodyId` must be a string'));
  if (!Array.isArray(faceIdsArg) || faceIdsArg.length === 0 || !faceIdsArg.every((s) => typeof s === 'string')) {
    return err(invalidInput('`removedFaceIds` must be a non-empty array of stableFaceId strings'));
  }
  if (typeof thicknessArg !== 'number' || !Number.isFinite(thicknessArg) || thicknessArg <= 0) {
    return err(invalidInput('`thickness` must be a positive finite number (mm). Wall grows inward.'));
  }
  if (toleranceArg !== undefined && (typeof toleranceArg !== 'number' || !Number.isFinite(toleranceArg) || toleranceArg <= 0)) {
    return err(invalidInput('`tolerance`, if provided, must be a positive finite number.'));
  }

  const before = asProject(host.getDocument());
  if (!before.parts[partIdArg as PartId]) {
    return err(invalidInput(`Part not found: ${partIdArg}`));
  }

  const bodyRef: BodyRef = { partId: partIdArg as PartId, bodyId: bodyIdArg as BodyId };
  const removedFaces: FaceRef[] = (faceIdsArg as string[]).map((id) => ({
    type: 'stableTopology' as const,
    bodyRef,
    stableFaceId: stableFaceId(id),
  }));

  const inputs: ShellFeatureInputs = {
    sourceBody: bodyRef,
    removedFaces,
    thickness: String(thicknessArg),
    ...(typeof toleranceArg === 'number' ? { tolerance: toleranceArg } : {}),
  };

  const cmd: CadCommand = {
    type: 'CreateShell',
    partId: partIdArg as PartId,
    inputs,
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewFeatureId(
      before.parts[partIdArg as PartId],
      after.parts[partIdArg as PartId],
    );
    if (!newId) return err(hostError('CreateShell dispatched but no new feature id found'));
    return ok({ featureId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * feature_sweep — `CreateSweep`. Both profile and path are closed
 * sketch regions referenced via sketchId + (optional) wireEntityIds.
 * If wireEntityIds is omitted for either, the wrapper picks the first
 * detected region in that sketch.
 *
 * V1 only supports `operation: 'newBody'` (schema-enforced).
 *
 * Returns `{ featureId }`.
 */
export async function executeFeatureSweep(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ featureId: FeatureId }, ToolExecutionError>> {
  const profileArg = args['profile'];
  const pathArg = args['path'];

  if (!isRecord(profileArg) || typeof profileArg['sketchId'] !== 'string') {
    return err(invalidInput('`profile` must be an object with `sketchId: string`'));
  }
  if (!isRecord(pathArg) || typeof pathArg['sketchId'] !== 'string') {
    return err(invalidInput('`path` must be an object with `sketchId: string`'));
  }

  const before = asProject(host.getDocument());

  const resolveProfile = (
    src: Record<string, unknown>,
    label: 'profile' | 'path',
  ): Result<ProfileRef, ToolExecutionError> => {
    const sketchId = src['sketchId'] as string;
    const partId = resolveSketchPart(before, sketchId);
    if (!partId) return err(invalidInput(`${label}.sketchId not found or not a sketch: ${sketchId}`));
    const wireIds = src['wireEntityIds'];
    if (Array.isArray(wireIds) && wireIds.length > 0 && wireIds.every((s) => typeof s === 'string')) {
      const ref: ProfileRef = {
        sketchId: sketchId as FeatureId,
        wireEntityIds: wireIds as EntityId[],
      };
      const ip = src['interiorPoint'];
      if (isVec2(ip)) ref.interiorPoint = ip;
      return ok(ref);
    }
    const entities = sketchEntities(before, sketchId);
    const regions = detectSketchRegions(entities as never);
    if (regions.length === 0) {
      return err(invalidInput(`${label} sketch ${sketchId} has no closed region to use.`));
    }
    const first = regions[0]!;
    const ref: ProfileRef = {
      sketchId: sketchId as FeatureId,
      wireEntityIds: first.entityIds,
    };
    const interior = regionInteriorPoint(first);
    if (Number.isFinite(interior[0]) && Number.isFinite(interior[1])) ref.interiorPoint = interior;
    return ok(ref);
  };

  const profileR = resolveProfile(profileArg, 'profile');
  if (!profileR.ok) return profileR;
  const pathR = resolveProfile(pathArg, 'path');
  if (!pathR.ok) return pathR;

  // Pick the host part — sweep is owned by the part hosting the profile sketch.
  const profilePart = resolveSketchPart(before, profileArg['sketchId'] as string)!;

  const inputs: SweepFeatureInputs = {
    profile: profileR.value,
    path: pathR.value,
    operation: 'newBody',
  };

  const cmd: CadCommand = {
    type: 'CreateSweep',
    partId: profilePart,
    inputs,
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewFeatureId(before.parts[profilePart], after.parts[profilePart]);
    if (!newId) return err(hostError('CreateSweep dispatched but no new feature id found'));
    return ok({ featureId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * feature_loft — `CreateLoft` across 2–16 ordered profile sections.
 *
 * Each profile entry is a `{ sketchId, wireEntityIds?, interiorPoint? }`.
 * Omitting `wireEntityIds` picks the first detected region in that
 * sketch. All profiles must resolve to closed wires (the builder
 * rejects mixed open/closed with a clear diagnostic).
 *
 * Returns `{ featureId }`. The host part is the one hosting profile #0.
 */
export async function executeFeatureLoft(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ featureId: FeatureId }, ToolExecutionError>> {
  const profilesArg = args['profiles'];
  const opArg = args['operation'] ?? 'newBody';
  if (!Array.isArray(profilesArg) || profilesArg.length < 2) {
    return err(invalidInput('`profiles` must be an array of at least 2 entries'));
  }
  if (profilesArg.length > 16) {
    return err(invalidInput('`profiles` accepts at most 16 entries'));
  }
  if (opArg !== 'newBody' && opArg !== 'join' && opArg !== 'cut') {
    return err(invalidInput("`operation` must be 'newBody', 'join', or 'cut'"));
  }

  const before = asProject(host.getDocument());

  const profiles: ProfileRef[] = [];
  for (let i = 0; i < profilesArg.length; i++) {
    const p = profilesArg[i];
    if (!isRecord(p) || typeof p['sketchId'] !== 'string') {
      return err(invalidInput(`profiles[${i}] must be an object with sketchId: string`));
    }
    const sketchId = p['sketchId'] as string;
    if (!resolveSketchPart(before, sketchId)) {
      return err(invalidInput(`profiles[${i}].sketchId not found or not a sketch: ${sketchId}`));
    }
    const wireIds = p['wireEntityIds'];
    if (Array.isArray(wireIds) && wireIds.length > 0 && wireIds.every((s) => typeof s === 'string')) {
      const ref: ProfileRef = {
        sketchId: sketchId as FeatureId,
        wireEntityIds: wireIds as EntityId[],
      };
      const ip = p['interiorPoint'];
      if (isVec2(ip)) ref.interiorPoint = ip;
      profiles.push(ref);
    } else {
      const entities = sketchEntities(before, sketchId);
      const regions = detectSketchRegions(entities as never);
      if (regions.length === 0) {
        return err(invalidInput(`profiles[${i}] sketch ${sketchId} has no closed region.`));
      }
      const first = regions[0]!;
      const ref: ProfileRef = {
        sketchId: sketchId as FeatureId,
        wireEntityIds: first.entityIds,
      };
      const interior = regionInteriorPoint(first);
      if (Number.isFinite(interior[0]) && Number.isFinite(interior[1])) ref.interiorPoint = interior;
      profiles.push(ref);
    }
  }

  const partId = resolveSketchPart(before, profilesArg[0]!['sketchId'] as string)!;
  const targets = parseTargetBodies(args, partId);
  if (!targets.ok) return targets;

  const inputs: LoftFeatureInputs = {
    profiles,
    operation: opArg as 'newBody' | 'join' | 'cut',
    ...(typeof args['ruled'] === 'boolean' ? { ruled: args['ruled'] } : {}),
    ...(typeof args['closed'] === 'boolean' ? { closed: args['closed'] } : {}),
    ...(targets.value ? { targetBodies: targets.value } : {}),
  };

  const cmd: CadCommand = {
    type: 'CreateLoft',
    partId,
    inputs,
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const newId = diffNewFeatureId(before.parts[partId], after.parts[partId]);
    if (!newId) return err(hostError('CreateLoft dispatched but no new feature id found'));
    return ok({ featureId: newId });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

// ---- Discovery executors --------------------------------------------------

/**
 * cad_help — returns the full markdown workflow guide. No inputs, no
 * host calls. The client calls this once at the start of a non-trivial
 * session and gets the canonical "how to use this toolset" doc.
 */
export async function executeCadHelp(
  _args: Record<string, unknown>,
  _host: ToolHost,
): Promise<Result<string, ToolExecutionError>> {
  return ok(CAD_WORKFLOW_GUIDE);
}

/**
 * One `list_sketch_regions` entry. `area` is the fillable (net) area and
 * `center` a point inside the material, so for a ring both describe the
 * ring, not the full outer disc.
 */
export type SketchRegionSummary = {
  id: string;
  type: 'circle' | 'polygon' | 'ellipse' | 'closedSpline';
  area: number;
  center: [number, number];
  wireEntityIds: string[];
  holeEntityIds?: string[];
};

/**
 * list_sketch_regions — pure function over the document. Reads the
 * sketch's flat `entities` Record and runs the same `detectSketchRegions`
 * the worker uses to find profiles for extrude. Returns the same
 * SketchRegion[] but flattened to a model-friendly shape (drops the
 * Float32Array `vertices` and the internal segment metadata).
 */
export async function executeListSketchRegions(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<SketchRegionSummary[], ToolExecutionError>> {
  const sketchId = args['sketchId'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));

  const doc = asProject(host.getDocument());
  const loc = findFeatureLocation(doc, sketchId);
  if (!loc) return err(invalidInput(`Sketch not found: ${sketchId}`));
  if (loc.feature.type !== 'sketch') {
    return err(invalidInput(`Feature is not a sketch: ${sketchId}`));
  }
  const entities = sketchBuildGeometry(loc.feature.inputs as unknown as SketchFeatureInputs);
  const regions = detectSketchRegions(entities);
  return ok(
    regions.map((r) => {
      const entry: SketchRegionSummary = {
        id: r.id,
        type: r.type,
        area: regionNetArea(r),
        center: regionInteriorPoint(r),
        wireEntityIds: r.entityIds.map((id) => String(id)),
      };
      // A ring: `wireEntityIds` is its outer loop, `holeEntityIds` the
      // loops nested inside it (each also listed as its own region).
      const holeIds = regionWireEntityIds(r).slice(r.entityIds.length);
      if (holeIds.length > 0) entry.holeEntityIds = holeIds.map((id) => String(id));
      return entry;
    }),
  );
}

// ---- Build-artifact executors --------------------------------------------
//
// These three (list_bodies / list_faces / list_edges) need build
// artifacts (bodies + topology) — which are NOT in the canonical
// document. They live in the viewport store on the browser side; the
// bridge proxies them via the optional ToolHost methods `listBodies`
// and `getTopology`. Hosts without a build pipeline (the SaaS
// server-side host) leave those undefined → the tools return
// UNSUPPORTED_BY_HOST.

function unsupportedByHost(message: string): ToolExecutionError {
  return { code: 'UNSUPPORTED_BY_HOST', message };
}

/**
 * Narrow `unknown` to `BuiltBody[]` defensively. The host returns
 * `unknown` because the bridge type-erases over JSON. We assume the
 * shape — anything malformed is a bug elsewhere and an empty result
 * is the safe fallback.
 */
function asBodies(v: unknown): BuiltBody[] {
  return Array.isArray(v) ? (v as BuiltBody[]) : [];
}

function asTopology(v: unknown): TopologyMap | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return null;
  return v as TopologyMap;
}

/**
 * list_bodies — returns the BuiltBody list from the host, trimmed to
 * a model-friendly shape (drops the displayMesh which is megabytes of
 * Float32Array). The caller gets bodyId, sourceFeatureId, role,
 * boundingBox, and optional massProperties — enough to pick the body
 * they want for downstream operations.
 */
export async function executeListBodies(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<Array<{
  bodyId: string;
  sourceFeatureId: string;
  role: string;
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  massProperties?: BuiltBody['massProperties'];
}>, ToolExecutionError>> {
  if (!host.listBodies) {
    return err(unsupportedByHost('This host does not expose build artifacts (list_bodies is browser/bridge-only).'));
  }
  const partId = args['partId'];
  if (typeof partId !== 'string') return err(invalidInput('`partId` must be a string'));
  try {
    const bodies = asBodies(await host.listBodies(partId));
    return ok(
      bodies.map((b) => ({
        bodyId: String(b.bodyId),
        sourceFeatureId: String(b.sourceFeatureId),
        role: b.role,
        boundingBox: {
          min: [b.boundingBox.min[0], b.boundingBox.min[1], b.boundingBox.min[2]],
          max: [b.boundingBox.max[0], b.boundingBox.max[1], b.boundingBox.max[2]],
        },
        ...(b.massProperties !== undefined ? { massProperties: b.massProperties } : {}),
      })),
    );
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * list_faces — returns per-face metadata from a body's topology map.
 * Drops triangle ranges (numeric internals); keeps faceId,
 * stableFaceId, kind, area, centroid, and normal (for planar faces).
 *
 * Currently we only have faceId + stableFaceId structurally —
 * derived per-face metadata (kind, area, centroid, normal) is
 * stub-empty until the topology layer surfaces it. The schema is
 * future-proof so adding the metadata later doesn't change the
 * tool signature.
 */
export async function executeListFaces(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<Array<{
  faceId: string;
  stableFaceId?: string;
  triStart: number;
  triEnd: number;
}>, ToolExecutionError>> {
  if (!host.getTopology) {
    return err(unsupportedByHost('This host does not expose build artifacts (list_faces is browser/bridge-only).'));
  }
  const bodyId = args['bodyId'];
  if (typeof bodyId !== 'string') return err(invalidInput('`bodyId` must be a string'));
  try {
    const topo = asTopology(await host.getTopology(bodyId));
    if (!topo) return ok([]);
    return ok(
      topo.faces.map((f) => ({
        faceId: String(f.faceId),
        ...(f.stableFaceId !== undefined ? { stableFaceId: String(f.stableFaceId) } : {}),
        triStart: f.triStart,
        triEnd: f.triEnd,
      })),
    );
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * list_edges — returns per-edge metadata from a body's topology map.
 * Each edge knows its two adjacent face ids so the caller can filter
 * by "edge between face A and face B" without trial-and-error.
 * Drops the raw Float32Array of segment points; we surface a
 * summarized start/end for the caller.
 */
export async function executeListEdges(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<Array<{
  edgeId: string;
  stableEdgeId?: string;
  adjacentFaceIds: [string, string];
  start: [number, number, number];
  end: [number, number, number];
}>, ToolExecutionError>> {
  if (!host.getTopology) {
    return err(unsupportedByHost('This host does not expose build artifacts (list_edges is browser/bridge-only).'));
  }
  const bodyId = args['bodyId'];
  if (typeof bodyId !== 'string') return err(invalidInput('`bodyId` must be a string'));
  try {
    const topo = asTopology(await host.getTopology(bodyId));
    if (!topo) return ok([]);
    return ok(
      topo.edges.map((e) => {
        // `lineSegments` is a Float32Array of [x0,y0,z0, x1,y1,z1, …]
        // when this executor runs in-process (browser path). The MCP
        // bridge JSON-serializes the topology over WS, where Float32Array
        // becomes `{ "0": 0, "1": 0, … }` (numeric-keyed object, no
        // `.length`). normalize once at the boundary so both paths feed
        // the same shape into the start/end extraction below.
        const arr = toNumberArray(e.lineSegments);
        const n = arr.length;
        const start: [number, number, number] = n >= 3
          ? [arr[0]!, arr[1]!, arr[2]!]
          : [0, 0, 0];
        // Build `end` as a SEPARATE array, even when n < 6. Aliasing
        // `start` here caused some MCP clients' response serializers to
        // detect a shared reference and emit `"[Circular]"` instead
        // of the coordinates.
        const end: [number, number, number] = n >= 6
          ? [arr[n - 3]!, arr[n - 2]!, arr[n - 1]!]
          : [start[0], start[1], start[2]];
        return {
          edgeId: String(e.edgeId),
          ...(e.stableEdgeId !== undefined ? { stableEdgeId: String(e.stableEdgeId) } : {}),
          adjacentFaceIds: [String(e.adjacentFaces[0]), String(e.adjacentFaces[1])] as [string, string],
          start,
          end,
        };
      }),
    );
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

// ---- Semantic discovery helpers (find_face, find_edges) -------------------
//
// These are thin filtering wrappers over the topology data the host
// already exposes. They exist so the caller doesn't have to roll its
// own predicate logic on the raw list_faces / list_edges output —
// which led to repeated "list everything → eyeball the result"
// patterns in the smoke tests.
//
// Filter design: each filter field is OPTIONAL; an empty filter
// returns everything. Multiple filters AND together. Where a filter
// is a set ("any of these edges"), match-any semantics apply within
// the set.

/**
 * find_edges — filter a body's edges by topology-level criteria.
 *
 * Filters (all optional, ANDed together):
 *   - `adjacentToFaceIds`: keep edges whose `adjacentFaces` overlap
 *     this set. Useful for "the edges around the top face".
 *   - `betweenFaces: [a, b]`: keep edges whose adjacent faces are
 *     EXACTLY `{a, b}` (order-insensitive). The ergonomic answer to
 *     "the edge between the top and the side".
 *   - `lengthRange: { min?, max? }`: keep edges whose chord length
 *     falls in the range. Useful for "the long vertical edges of
 *     the box" (filter by min length).
 *   - `lengthApprox: { value, tolerance? }`: keep edges whose chord
 *     length matches `value` within `tolerance` (default 1e-3 mm).
 *
 * Length is computed as the straight-line distance between the
 * edge's start and end points — fine for line segments, an
 * approximation for arcs / curves (the caller should fall back to
 * lengthRange with looser bounds in that case).
 *
 * Returns the same shape as `list_edges` so the caller can pipe the
 * result straight into `feature_fillet` / `feature_chamfer`.
 */
export async function executeFindEdges(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<Array<{
  edgeId: string;
  stableEdgeId?: string;
  adjacentFaceIds: [string, string];
  start: [number, number, number];
  end: [number, number, number];
  length: number;
}>, ToolExecutionError>> {
  if (!host.getTopology) {
    return err(unsupportedByHost('This host does not expose build artifacts (find_edges is browser/bridge-only).'));
  }
  const bodyId = args['bodyId'];
  if (typeof bodyId !== 'string') return err(invalidInput('`bodyId` must be a string'));

  // Validate filter shape — each field optional but typed strictly.
  const adjArg = args['adjacentToFaceIds'];
  const adjacentSet = adjArg === undefined ? null
    : Array.isArray(adjArg) && adjArg.every((s) => typeof s === 'string')
    ? new Set(adjArg)
    : null;
  if (adjArg !== undefined && adjacentSet === null) {
    return err(invalidInput('`adjacentToFaceIds` must be an array of strings'));
  }

  const betweenArg = args['betweenFaces'];
  let betweenPair: [string, string] | null = null;
  if (betweenArg !== undefined) {
    if (!Array.isArray(betweenArg) || betweenArg.length !== 2 || !betweenArg.every((s) => typeof s === 'string')) {
      return err(invalidInput('`betweenFaces` must be a 2-element array of strings'));
    }
    betweenPair = [betweenArg[0] as string, betweenArg[1] as string];
  }

  const rangeArg = args['lengthRange'];
  let rangeMin = -Infinity;
  let rangeMax = Infinity;
  if (rangeArg !== undefined) {
    if (!isRecord(rangeArg)) return err(invalidInput('`lengthRange` must be an object with `min` and/or `max`'));
    const min = rangeArg['min'];
    const max = rangeArg['max'];
    if (min !== undefined) {
      if (typeof min !== 'number' || !Number.isFinite(min)) return err(invalidInput('`lengthRange.min` must be a finite number'));
      rangeMin = min;
    }
    if (max !== undefined) {
      if (typeof max !== 'number' || !Number.isFinite(max)) return err(invalidInput('`lengthRange.max` must be a finite number'));
      rangeMax = max;
    }
  }

  const approxArg = args['lengthApprox'];
  let approxValue: number | null = null;
  let approxTol = 1e-3;
  if (approxArg !== undefined) {
    if (!isRecord(approxArg) || typeof approxArg['value'] !== 'number') {
      return err(invalidInput('`lengthApprox` must be `{ value: number, tolerance?: number }`'));
    }
    approxValue = approxArg['value'];
    if (approxArg['tolerance'] !== undefined) {
      if (typeof approxArg['tolerance'] !== 'number' || (approxArg['tolerance'] as number) < 0) {
        return err(invalidInput('`lengthApprox.tolerance` must be a non-negative number'));
      }
      approxTol = approxArg['tolerance'] as number;
    }
  }

  try {
    const topo = asTopology(await host.getTopology(bodyId));
    if (!topo) return ok([]);

    const matched = [];
    for (const e of topo.edges) {
      const adjA = String(e.adjacentFaces[0]);
      const adjB = String(e.adjacentFaces[1]);

      // adjacentToFaceIds (match-ANY) and betweenFaces (exact unordered pair).
      if (!edgeMatchesFaceFilter(e.adjacentFaces, { adjacentToFaceIds: adjacentSet, betweenFaces: betweenPair })) continue;

      // Compute start/end + length.
      const arr = toNumberArray(e.lineSegments);
      const n = arr.length;
      const start: [number, number, number] = n >= 3 ? [arr[0]!, arr[1]!, arr[2]!] : [0, 0, 0];
      const end: [number, number, number] = n >= 6
        ? [arr[n - 3]!, arr[n - 2]!, arr[n - 1]!]
        : [start[0], start[1], start[2]];
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const dz = end[2] - start[2];
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (length < rangeMin || length > rangeMax) continue;
      if (approxValue !== null && Math.abs(length - approxValue) > approxTol) continue;

      matched.push({
        edgeId: String(e.edgeId),
        ...(e.stableEdgeId !== undefined ? { stableEdgeId: String(e.stableEdgeId) } : {}),
        adjacentFaceIds: [adjA, adjB] as [string, string],
        start,
        end,
        length,
      });
    }
    return ok(matched);
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * find_face — filter a body's faces.
 *
 * v1 filters (each optional, ANDed):
 *   - `adjacentToEdgeIds`: faces touching ANY of these edges. Resolved
 *     via the body's edge.adjacentFaces map.
 *   - `withStableIdOnly`: when true, drop faces without a stableFaceId
 *     (e.g. brand-new faces from a feature that hasn't been referenced
 *     yet, where stable naming hasn't run). Lets the caller stick to
 *     references that survive rebuilds.
 *
 * Kind / centroid / normal filtering is deferred: the current
 * `TopologyMap.faces[]` entry only knows faceId + triStart/triEnd +
 * stableFaceId. Computing centroid + normal needs the displayMesh,
 * which isn't yet exposed via ToolHost. Once it is, this tool can
 * grow `kind: 'planar' | 'cylindrical' | ...` and `normalApprox:
 * { vector, tolerance? }` filters without breaking the signature.
 *
 * Returns the same shape as `list_faces`.
 */
export async function executeFindFace(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<Array<{
  faceId: string;
  stableFaceId?: string;
  triStart: number;
  triEnd: number;
}>, ToolExecutionError>> {
  if (!host.getTopology) {
    return err(unsupportedByHost('This host does not expose build artifacts (find_face is browser/bridge-only).'));
  }
  const bodyId = args['bodyId'];
  if (typeof bodyId !== 'string') return err(invalidInput('`bodyId` must be a string'));

  const adjArg = args['adjacentToEdgeIds'];
  let edgeSet: Set<string> | null = null;
  if (adjArg !== undefined) {
    if (!Array.isArray(adjArg) || !adjArg.every((s) => typeof s === 'string')) {
      return err(invalidInput('`adjacentToEdgeIds` must be an array of strings'));
    }
    edgeSet = new Set(adjArg);
  }

  const withStableArg = args['withStableIdOnly'];
  if (withStableArg !== undefined && typeof withStableArg !== 'boolean') {
    return err(invalidInput('`withStableIdOnly` must be a boolean'));
  }
  const withStableOnly = withStableArg === true;

  try {
    const topo = asTopology(await host.getTopology(bodyId));
    if (!topo) return ok([]);

    // Build the set of face ids adjacent to any wanted edge, if the
    // filter requested it. One pass over edges; cheap.
    let allowedFaceIds: Set<string> | null = null;
    if (edgeSet !== null) {
      allowedFaceIds = new Set();
      for (const e of topo.edges) {
        if (edgeSet.has(String(e.edgeId))) {
          allowedFaceIds.add(String(e.adjacentFaces[0]));
          allowedFaceIds.add(String(e.adjacentFaces[1]));
        }
      }
    }

    const matched = [];
    for (const f of topo.faces) {
      if (withStableOnly && f.stableFaceId === undefined) continue;
      if (allowedFaceIds !== null && !allowedFaceIds.has(String(f.faceId))) continue;
      matched.push({
        faceId: String(f.faceId),
        ...(f.stableFaceId !== undefined ? { stableFaceId: String(f.stableFaceId) } : {}),
        triStart: f.triStart,
        triEnd: f.triEnd,
      });
    }
    return ok(matched);
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * Normalize "maybe Float32Array, maybe JSON-deserialized numeric-keyed
 * object, maybe Array" into a plain `number[]`. The MCP bridge sends
 * the topology over WebSocket; `JSON.stringify(new Float32Array([...]))`
 * yields `{ "0": …, "1": …, … }` rather than an array, and the
 * receiving side has no way to revive it without help. This helper
 * runs at the executor boundary so callers downstream always see
 * a real array with a real `.length`.
 */
function toNumberArray(v: unknown): number[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  }
  if (v instanceof Float32Array || v instanceof Float64Array) {
    return Array.from(v);
  }
  if (v && typeof v === 'object') {
    // Numeric-keyed object from JSON-serialized typed array. Read keys
    // 0, 1, … until we hit a gap; that bounds the iteration without
    // relying on a `.length` field the serializer dropped.
    const out: number[] = [];
    const obj = v as Record<string, unknown>;
    for (let i = 0; ; i++) {
      const x = obj[String(i)];
      if (typeof x !== 'number' || !Number.isFinite(x)) break;
      out.push(x);
    }
    return out;
  }
  return [];
}

// ---- Sketch constraint + element-discovery executors ---------------------

/**
 * Read the editor-state snapshot stored on a sketch feature. Returns
 * the arrays directly (typed loosely because the document layer
 * type-erases). Empty arrays for fresh / un-edited sketches.
 */
function readEditorSnapshot(
  doc: CadProject,
  sketchId: string,
): {
  points: ReadonlyArray<{ id: string; x: number; y: number; fixed: boolean }>;
  geometries: ReadonlyArray<Record<string, unknown> & { id: string; type: string }>;
  constraints: ReadonlyArray<Record<string, unknown> & { id: string; type: string }>;
} {
  const loc = findFeatureLocation(doc, sketchId);
  if (!loc || loc.feature.type !== 'sketch') return { points: [], geometries: [], constraints: [] };
  const snap = (loc.feature.inputs as unknown as SketchFeatureInputs).editorModel;
  if (!snap) return { points: [], geometries: [], constraints: [] };
  // Document layer stores these as unknown[] (see SketchEditorSnapshot
  // docstring) — narrow at the boundary.
  return {
    points: (snap.points ?? []) as never,
    geometries: (snap.geometries ?? []) as never,
    constraints: (snap.constraints ?? []) as never,
  };
}

/**
 * sketch_apply_constraint — `SketchApplyConstraint`. The caller passes a
 * SketchConstraintInput shape; the validator inside the handler checks
 * structural correctness. We diff the constraint list before/after to
 * return the newly-allocated `constraintId`.
 */
export async function executeSketchApplyConstraint(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ constraintId: SketchConstraintId }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const constraint = args['constraint'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!isRecord(constraint) || typeof (constraint as { type?: unknown }).type !== 'string') {
    return err(invalidInput('`constraint` must be an object with a string `type` discriminator'));
  }
  const before = asProject(host.getDocument());
  const beforeIds = new Set(readEditorSnapshot(before, sketchId).constraints.map((c) => c.id));

  const cmd: CadCommand = {
    type: 'SketchApplyConstraint',
    sketchId: sketchId as FeatureId,
    constraint: constraint as SketchConstraintInput,
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const afterC = readEditorSnapshot(after, sketchId).constraints;
    for (const c of afterC) {
      if (!beforeIds.has(c.id)) return ok({ constraintId: c.id as SketchConstraintId });
    }
    return err(hostError('SketchApplyConstraint dispatched but no new constraint id found'));
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_remove_constraint — `SketchRemoveConstraint`. Idempotent on the
 * server side. Returns `{ ok: true }`.
 */
export async function executeSketchRemoveConstraint(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ ok: true }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const constraintId = args['constraintId'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (typeof constraintId !== 'string') return err(invalidInput('`constraintId` must be a string'));

  const cmd: CadCommand = {
    type: 'SketchRemoveConstraint',
    sketchId: sketchId as FeatureId,
    constraintId: constraintId as SketchConstraintId,
  };
  try {
    await host.dispatchCommand(cmd);
    return ok({ ok: true });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * list_sketch_elements — surface the editor-state graph (points,
 * geometries, constraints) of a sketch. Pure read over the document
 * snapshot the host already has cached. This is the discovery tool
 * for `sketch_apply_constraint`: every constraint references point or
 * geometry ids that the caller needs to know exist.
 */
export async function executeListSketchElements(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{
  points: Array<{ id: SketchPointId; x: number; y: number; fixed: boolean }>;
  geometries: Array<{ id: SketchGeometryId; type: string; pointIds: SketchPointId[]; construction: boolean; radius?: number; width?: number; sides?: number }>;
  constraints: Array<{ id: SketchConstraintId; type: string; refs: { points?: SketchPointId[]; geometries?: SketchGeometryId[] }; value?: number }>;
}, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));

  const doc = asProject(host.getDocument());
  const loc = findFeatureLocation(doc, sketchId);
  if (!loc) return err(invalidInput(`Sketch not found: ${sketchId}`));
  if (loc.feature.type !== 'sketch') return err(invalidInput(`Feature is not a sketch: ${sketchId}`));

  const snap = readEditorSnapshot(doc, sketchId);

  const points = snap.points.map((p) => ({
    id: p.id as SketchPointId,
    x: p.x,
    y: p.y,
    fixed: p.fixed,
  }));

  const geometries = snap.geometries.map((g) => {
    const out: {
      id: SketchGeometryId;
      type: string;
      pointIds: SketchPointId[];
      construction: boolean;
      radius?: number;
      width?: number;
      sides?: number;
    } = {
      id: g.id as SketchGeometryId,
      type: g.type,
      pointIds: pointIdsForGeometry(g),
      construction: g.construction === true,
    };
    if (typeof g.radius === 'number') out.radius = g.radius;
    if (typeof g.width === 'number') out.width = g.width;
    if (typeof g.sides === 'number') out.sides = g.sides;
    return out;
  });

  const constraints = snap.constraints.map((c) => {
    const refs: { points?: SketchPointId[]; geometries?: SketchGeometryId[] } = {};
    const ptRefs = constraintPointRefs(c);
    if (ptRefs.length > 0) refs.points = ptRefs;
    const geomRefs = constraintGeometryRefs(c);
    if (geomRefs.length > 0) refs.geometries = geomRefs;
    const out: { id: SketchConstraintId; type: string; refs: typeof refs; value?: number } = {
      id: c.id as SketchConstraintId,
      type: c.type,
      refs,
    };
    if (typeof c.value === 'number') out.value = c.value;
    return out;
  });

  return ok({ points, geometries, constraints });
}

function pointIdsForGeometry(g: Record<string, unknown>): SketchPointId[] {
  const ids: string[] = [];
  for (const key of ['startId', 'endId', 'centerId', 'majorId', 'center1Id', 'center2Id', 'vertexId', 'pointId'] as const) {
    const v = g[key];
    if (typeof v === 'string') ids.push(v);
  }
  if (Array.isArray(g['pointIds'])) {
    for (const v of g['pointIds']) if (typeof v === 'string') ids.push(v);
  }
  return ids as SketchPointId[];
}

function constraintPointRefs(c: Record<string, unknown>): SketchPointId[] {
  const ids: string[] = [];
  for (const key of ['pointId', 'pointA', 'pointB'] as const) {
    const v = c[key];
    if (typeof v === 'string') ids.push(v);
  }
  return ids as SketchPointId[];
}

function constraintGeometryRefs(c: Record<string, unknown>): SketchGeometryId[] {
  const ids: string[] = [];
  for (const key of ['geometryId', 'geometryA', 'geometryB', 'circleId', 'secondCircleId', 'lineId'] as const) {
    const v = c[key];
    if (typeof v === 'string') ids.push(v);
  }
  return ids as SketchGeometryId[];
}

// ---- Hit-test + modify + move executors ----------------------------------
//
// All operate on the editor-state sidecar via the existing `fromSnapshot`
// pipeline (the pure-read pick) or by dispatching one of the bus commands.

/**
 * sketch_pick_geometry — pure read over `editorModel`. Wraps `fromSnapshot`
 * (already used by every other editor-state-aware executor) and calls the
 * shared `pickGeometryAt`. Returns the topmost geometry id under (x, y) or
 * null. Same tolerance band as the in-app modify tools.
 */
export async function executeSketchPickGeometry(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{
  geometryId: SketchGeometryId | null;
  type: 'line' | 'circle' | 'arc' | 'ellipse' | null;
}, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const x = args['x'];
  const y = args['y'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (typeof x !== 'number' || !Number.isFinite(x)) return err(invalidInput('`x` must be a finite number'));
  if (typeof y !== 'number' || !Number.isFinite(y)) return err(invalidInput('`y` must be a finite number'));

  const doc = asProject(host.getDocument());
  const loc = findFeatureLocation(doc, sketchId);
  if (!loc) return err(invalidInput(`Sketch not found: ${sketchId}`));
  if (loc.feature.type !== 'sketch') return err(invalidInput(`Feature is not a sketch: ${sketchId}`));

  const inputs = loc.feature.inputs as unknown as SketchFeatureInputs;
  const state = fromSnapshot(inputs.editorModel);
  const gid = pickGeometryAt(state, x, y);
  if (!gid) return ok({ geometryId: null, type: null });
  const geom = state.geometries.get(gid);
  const type = (geom?.type === 'line' || geom?.type === 'circle' ||
                geom?.type === 'arc' || geom?.type === 'ellipse')
    ? geom.type
    : null;
  return ok({ geometryId: gid, type });
}

/**
 * sketch_trim — `SketchTrim`. Returns `{ ok: true }`. The deletion shape
 * depends on the geometry + intersections (see command docstring).
 */
export async function executeSketchTrim(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ ok: true }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const geometryId = args['geometryId'];
  const cursor = args['cursor'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (typeof geometryId !== 'string') return err(invalidInput('`geometryId` must be a string'));
  if (!isVec2(cursor)) return err(invalidInput('`cursor` must be a [x, y] finite-number pair'));

  const cmd: CadCommand = {
    type: 'SketchTrim',
    sketchId: sketchId as FeatureId,
    geometryId: geometryId as SketchGeometryId,
    cursor,
  };
  try {
    await host.dispatchCommand(cmd);
    return ok({ ok: true });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_extend — `SketchExtend`. Returns `{ ok: true }`. No-op if there's
 * no extension target.
 */
export async function executeSketchExtend(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ ok: true }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const geometryId = args['geometryId'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (typeof geometryId !== 'string') return err(invalidInput('`geometryId` must be a string'));

  const cmd: CadCommand = {
    type: 'SketchExtend',
    sketchId: sketchId as FeatureId,
    geometryId: geometryId as SketchGeometryId,
  };
  try {
    await host.dispatchCommand(cmd);
    return ok({ ok: true });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_fillet — `SketchFillet`. Diffs editor-state geometry ids to
 * return the new arc id (or null on no-op — e.g. lines parallel, radius
 * too large for the legs).
 */
export async function executeSketchFillet(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ filletId: SketchGeometryId | null }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const geometryAId = args['geometryAId'];
  const geometryBId = args['geometryBId'];
  const radius = args['radius'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (typeof geometryAId !== 'string') return err(invalidInput('`geometryAId` must be a string'));
  if (typeof geometryBId !== 'string') return err(invalidInput('`geometryBId` must be a string'));
  if (radius !== undefined && (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0)) {
    return err(invalidInput('`radius` (optional) must be a positive finite number'));
  }

  const before = asProject(host.getDocument());
  const beforeIds = sketchGeometryIds(before, sketchId);

  const cmd: CadCommand = {
    type: 'SketchFillet',
    sketchId: sketchId as FeatureId,
    geometryAId: geometryAId as SketchGeometryId,
    geometryBId: geometryBId as SketchGeometryId,
    ...(radius !== undefined ? { radius } : {}),
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const afterIds = sketchGeometryIds(after, sketchId);
    const newId = diffNewGeometryId(beforeIds, afterIds);
    return ok({ filletId: (newId as SketchGeometryId | null) });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_offset — `SketchOffset`. Diffs editor-state geometry ids to
 * return every new offset curve id (empty on no-op).
 */
export async function executeSketchOffset(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ offsetIds: SketchGeometryId[] }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const geometryId = args['geometryId'];
  const distance = args['distance'];
  const cursor = args['cursor'];
  const construction = args['construction'];
  const chain = args['chain'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (typeof geometryId !== 'string') return err(invalidInput('`geometryId` must be a string'));
  if (typeof distance !== 'number' || !Number.isFinite(distance)) {
    return err(invalidInput('`distance` must be a finite number'));
  }
  if (!isVec2(cursor)) return err(invalidInput('`cursor` must be a [x, y] finite-number pair'));
  if (construction !== undefined && typeof construction !== 'boolean') {
    return err(invalidInput('`construction` (optional) must be a boolean'));
  }
  if (chain !== undefined && typeof chain !== 'boolean') {
    return err(invalidInput('`chain` (optional) must be a boolean'));
  }

  const before = asProject(host.getDocument());
  const beforeIds = sketchGeometryIds(before, sketchId);

  const cmd: CadCommand = {
    type: 'SketchOffset',
    sketchId: sketchId as FeatureId,
    geometryId: geometryId as SketchGeometryId,
    distance,
    cursor,
    ...(construction !== undefined ? { construction } : {}),
    ...(chain !== undefined ? { chain } : {}),
  };
  try {
    const after = asProject(await host.dispatchCommand(cmd));
    const afterIds = sketchGeometryIds(after, sketchId);
    const offsetIds = [...afterIds].filter((id) => !beforeIds.has(id)) as SketchGeometryId[];
    return ok({ offsetIds });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_mirror — `SketchMirror`. Returns `{ ok: true }`. Unsupported
 * geometry types (ellipse, spline, point) in `geometryIds` are silently
 * skipped, matching the underlying primitive's behavior.
 */
export async function executeSketchMirror(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ ok: true }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const geometryIds = args['geometryIds'];
  const axisA = args['axisA'];
  const axisB = args['axisB'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!Array.isArray(geometryIds) || !geometryIds.every((s) => typeof s === 'string')) {
    return err(invalidInput('`geometryIds` must be a string[]'));
  }
  if (!isVec2(axisA)) return err(invalidInput('`axisA` must be a [x, y] finite-number pair'));
  if (!isVec2(axisB)) return err(invalidInput('`axisB` must be a [x, y] finite-number pair'));

  const cmd: CadCommand = {
    type: 'SketchMirror',
    sketchId: sketchId as FeatureId,
    geometryIds: geometryIds as SketchGeometryId[],
    axisA,
    axisB,
  };
  try {
    await host.dispatchCommand(cmd);
    return ok({ ok: true });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_move_point — `SketchMovePoint`. One drag-end's worth of motion;
 * one CadCommand = one undo entry.
 */
export async function executeSketchMovePoint(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ ok: true }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const pointId = args['pointId'];
  const to = args['to'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (typeof pointId !== 'string') return err(invalidInput('`pointId` must be a string'));
  if (!isVec2(to)) return err(invalidInput('`to` must be a [x, y] finite-number pair'));

  const cmd: CadCommand = {
    type: 'SketchMovePoint',
    sketchId: sketchId as FeatureId,
    pointId: pointId as SketchPointId,
    to,
  };
  try {
    await host.dispatchCommand(cmd);
    return ok({ ok: true });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * sketch_move_points — `SketchMovePointsBatch`. Atomic multi-point move;
 * one CadCommand = one undo entry regardless of count. Empty `moves` is
 * a no-op (no entry recorded).
 */
export async function executeSketchMovePoints(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<Result<{ ok: true }, ToolExecutionError>> {
  const sketchId = args['sketchId'];
  const moves = args['moves'];
  if (typeof sketchId !== 'string') return err(invalidInput('`sketchId` must be a string'));
  if (!Array.isArray(moves)) return err(invalidInput('`moves` must be an array'));
  const validated: { pointId: SketchPointId; to: [number, number] }[] = [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (!isRecord(m)) return err(invalidInput(`moves[${i}] must be an object`));
    const pid = m['pointId'];
    const to = m['to'];
    if (typeof pid !== 'string') return err(invalidInput(`moves[${i}].pointId must be a string`));
    if (!isVec2(to)) return err(invalidInput(`moves[${i}].to must be a [x, y] finite-number pair`));
    validated.push({ pointId: pid as SketchPointId, to });
  }

  const cmd: CadCommand = {
    type: 'SketchMovePointsBatch',
    sketchId: sketchId as FeatureId,
    moves: validated,
  };
  try {
    await host.dispatchCommand(cmd);
    return ok({ ok: true });
  } catch (e) {
    return err(hostError(e instanceof Error ? e.message : String(e)));
  }
}
