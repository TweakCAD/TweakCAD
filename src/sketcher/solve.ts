/**
 * Solving a working copy of a sketch on the main thread with planegcs, as
 * evaluation does (8.2, solver version 1), and the solved sketch an edit
 * command takes to write region fates (8.3).
 */
import type { GcsWrapper } from '@salusoft89/planegcs';
import {
  ExprError,
  ValuePause,
  type CurveShape,
  type SolvedCurve,
  type SolvedSketch,
  type ValueEvaluator,
} from '@tweakcad/format';
import { FeaturePause } from '@tweakcad/worker/src/v2/context';
import { curveGeometry, curveReader } from '@tweakcad/worker/src/v2/sketchCurves';
import { SketchSolvePause, solveSketchPositions } from '@tweakcad/worker/src/v2/sketchSolve';
import { SketchGeometry, flagOn } from './geometry';
import { DIMENSION_KINDS, table, type Json, type P2 } from './rows';

/** An external curve as evaluation built it: fixed geometry in the solve. */
export interface ExternalShape {
  id: string;
  shape: CurveShape;
  /** Whether it bounds regions: `defining` and not construction. */
  bounds: boolean;
}

export type Solved =
  | {
      ok: true;
      /** The inputs with solved positions, radii and dimensions' `solved` numbers. */
      inputs: Json;
      /** Degrees of freedom left; 0 is fully defined. */
      dof: number;
      /** Constraint ids the solver found redundant. */
      redundant: string[];
    }
  | { ok: false; message: string };

/** A solver or value message as the user reads it. */
export function plainMessage(e: unknown): string {
  const text = e instanceof ExprError ? e.detail : e instanceof Error ? e.message : String(e);
  if (text === 'the sketch has conflicting constraints') return 'That would over-constrain the sketch';
  if (text === 'the sketch does not solve with these values') return 'The sketch does not solve with that';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function solverFailure(e: unknown): boolean {
  return (
    e instanceof SketchSolvePause || e instanceof FeaturePause || e instanceof ValuePause || e instanceof ExprError
  );
}

export function solveInputs(
  gcs: GcsWrapper,
  values: ValueEvaluator,
  inputs: Json,
  externals: readonly ExternalShape[] = [],
): Solved {
  let positions;
  try {
    positions = solveSketchPositions(inputs, values, gcs, externals);
  } catch (e) {
    if (solverFailure(e)) return { ok: false, message: plainMessage(e) };
    throw e;
  }
  const dof = gcs.gcs.dof();
  const redundant = gcs.get_gcs_redundant_constraints();
  const points = table(inputs, 'points').map((p) => {
    const at = positions.points.get(p.id as string);
    return at && (at.x !== p.x || at.y !== p.y) ? { ...p, x: at.x, y: at.y } : p;
  });
  const curves = table(inputs, 'curves').map((c) => {
    const r = positions.radii.get(c.id as string);
    if (r === undefined) return c;
    if (c.kind === 'circle' && r !== c.radius) return { ...c, radius: r };
    if ((c.kind === 'ellipse' || c.kind === 'ellipticalArc') && r !== c.minorRadius) return { ...c, minorRadius: r };
    return c;
  });
  const placed: Json = { ...inputs, points, curves };
  const geometry = new SketchGeometry(placed, values, externalShapes(externals));
  const constraints = table(inputs, 'constraints').map((c) => {
    if (!DIMENSION_KINDS.has(c.kind as string)) return c;
    const measured = geometry.measure(c);
    return measured !== null && measured !== c.solved ? { ...c, solved: measured } : c;
  });
  return { ok: true, inputs: { ...placed, constraints }, dof, redundant };
}

/** Lines of no length and circles and arcs of no radius: what a solve can shrink a curve to. */
/** The external shapes by row id, as `SketchGeometry` takes them. */
export function externalShapes(externals: readonly ExternalShape[]): Map<string, CurveShape> {
  return new Map(externals.map((e) => [e.id, e.shape]));
}

export function collapsedCurves(inputs: Json, values: ValueEvaluator): string[] {
  const geometry = new SketchGeometry(inputs, values);
  const out: string[] = [];
  for (const c of geometry.curves.values()) {
    if (c.kind === 'line') {
      const [a, b] = [geometry.point(c.row.start as string), geometry.point(c.row.end as string)];
      if (a && b && Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) out.push(c.id);
    } else if (c.kind === 'circle' || c.kind === 'arc') {
      const r = geometry.radius(c.id);
      if (r !== undefined && r < 1e-6) out.push(c.id);
    }
  }
  return out;
}

function rootOf(id: string, rows: Map<string, Json>): string {
  let at = id;
  for (let guard = 0; guard < 10000; guard++) {
    const origin = rows.get(at)?.origin as Json | undefined;
    if (!origin || !('from' in origin)) return at;
    at = (origin.from as Json).id as string;
  }
  return at;
}

function externalAnchors(e: ExternalShape): SolvedCurve['anchors'] {
  const s = e.shape;
  return s.kind === 'circle' || s.kind === 'ellipse' || (s.kind === 'nurbs' && s.periodic)
    ? { kind: 'none' }
    : { kind: 'extremities' };
}

/**
 * The solved sketch regions are detected on (8.3): the region-bounding
 * curves in table order, then the glyph contours. Null when this editor
 * cannot build it whole: text needs its glyphs (from the fonts the document
 * holds), and a defining external curve its built shape.
 */
export function solvedSketchOf(
  inputs: Json,
  values: ValueEvaluator,
  externals: readonly ExternalShape[] = [],
  glyphs: readonly SolvedCurve[] | null = null,
): SolvedSketch | null {
  if (table(inputs, 'text').length > 0 && glyphs === null) return null;
  const points = table(inputs, 'points').map((p) => ({ id: p.id as string, x: p.x as number, y: p.y as number }));
  const at = new Map<string, P2>(points.map((p) => [p.id, [p.x, p.y]]));
  const read = curveReader(values, at, () => undefined);
  const rows = new Map<string, Json>();
  for (const c of table(inputs, 'curves')) rows.set(c.id as string, c);
  for (const r of table(inputs, 'retired'))
    if ('curve' in (r.was as Json)) rows.set(r.id as string, (r.was as Json).curve as Json);
  const external = new Map(externals.map((e) => [e.id, e]));
  const curves: SolvedCurve[] = [];
  for (const c of table(inputs, 'curves')) {
    if (flagOn(values, c.construction)) continue;
    const key = { drawn: { id: rootOf(c.id as string, rows) } };
    if (c.kind === 'external') {
      const e = external.get(c.id as string);
      // One not built yet bounds nothing unless it is defining.
      if (!e) {
        if (flagOn(values, c.defining)) return null;
        continue;
      }
      if (e.bounds) curves.push({ key, shape: e.shape, anchors: externalAnchors(e) });
      continue;
    }
    try {
      const geometry = curveGeometry(c, read);
      if (geometry) curves.push({ key, ...geometry });
    } catch (e) {
      if (solverFailure(e)) return null;
      throw e;
    }
  }
  curves.push(...(glyphs ?? []));
  return { points, curves };
}
