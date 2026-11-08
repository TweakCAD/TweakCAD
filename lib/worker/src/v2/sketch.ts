/** `core.sketch` (chapter 8): solve, detect regions, match them to the stored table. */
import {
  detectRegions,
  matchRegions,
  type CurveAnchors,
  type RegionRow,
  type RegionTable,
  type RetiredRow,
  type SolvedCurve,
  type SolvedSketch,
  ValuePause,
  type ValueEvaluator,
} from '@tweakcad/format';
import { FLAG, FeaturePause, registerBuilder, type Json, type SketchResult } from './context';
import { frameOf } from './places';
import { curveGeometry, curveReader } from './sketchCurves';
import { buildExternals, type ExternalCurve } from './sketchExternal';
import { solveSketchPositions, type SolvedPositions } from './sketchSolve';
import { buildText } from './sketchText';

/** A curve row's root: the first ancestor through `origin.from`, live or retired. */
export function rootOf(id: string, rows: Map<string, Json>): string {
  let at = id;
  for (let guard = 0; guard < 10000; guard++) {
    const origin = rows.get(at)?.origin as Json | undefined;
    if (!origin || !('from' in origin)) return at;
    at = (origin.from as Json).id as string;
  }
  return at;
}

/** Every curve row, live or retired, by id. */
function curveRows(inputs: Json): Map<string, Json> {
  const rows = new Map<string, Json>();
  for (const c of inputs.curves as Json[]) rows.set(c.id as string, c);
  for (const r of inputs.retired as Json[])
    if ('curve' in (r.was as Json)) rows.set(r.id as string, (r.was as Json).curve as Json);
  return rows;
}

/** The live lines by curve root, construction and external lines included, for references to a line. */
function linesOf(inputs: Json, sketch: SolvedSketch, externals: readonly ExternalCurve[]): SketchResult['lines'] {
  const rows = curveRows(inputs);
  const at = new Map(sketch.points.map((p) => [p.id, [p.x, p.y] as const]));
  const lines: SketchResult['lines'] = new Map();
  for (const c of inputs.curves as Json[]) {
    const [start, end] = [at.get(c.start as string), at.get(c.end as string)];
    if (c.kind !== 'line' || !start || !end) continue;
    const root = rootOf(c.id as string, rows);
    lines.set(root, [...(lines.get(root) ?? []), [start, end]]);
  }
  for (const e of externals) if (e.shape.kind === 'line') lines.set(e.id, [[e.shape.start, e.shape.end]]);
  return lines;
}

/** How an external curve's ends are named: it has no sketch points, so an open one ends at its extremities. */
function externalAnchors(e: ExternalCurve): CurveAnchors {
  const s = e.shape;
  return s.kind === 'circle' || s.kind === 'ellipse' || (s.kind === 'nurbs' && s.periodic)
    ? { kind: 'none' }
    : { kind: 'extremities' };
}

/** A curve row's geometry for display only, or null when it has none or cannot be read. */
function shownGeometry(c: Json, read: ReturnType<typeof curveReader>): ReturnType<typeof curveGeometry> {
  try {
    return curveGeometry(c, read);
  } catch (e) {
    if (e instanceof FeaturePause || e instanceof ValuePause) return null;
    throw e;
  }
}

function solvedSketch(
  values: ValueEvaluator,
  inputs: Json,
  solved: SolvedPositions | null,
  externals: readonly ExternalCurve[],
  glyphs: readonly SolvedCurve[],
): { sketch: SolvedSketch; others: SolvedCurve[] } {
  // With a solver, positions come from solving the constraints; without one,
  // the stored positions (the last solve's result) are used as they are.
  const points = (inputs.points as Json[]).map((p) => {
    const at = solved?.points.get(p.id as string);
    return { id: p.id as string, x: at ? at.x : (p.x as number), y: at ? at.y : (p.y as number) };
  });
  const at = new Map(points.map((p) => [p.id, [p.x, p.y] as const]));
  const read = curveReader(values, at, (curve) => solved?.radii.get(curve));
  const rows = curveRows(inputs);
  const external = new Map(externals.map((e) => [e.id, e]));

  // The curves that bound regions, in table order, then the glyph contours (8.3).
  const curves: SolvedCurve[] = [];
  const others: SolvedCurve[] = [];
  for (const c of inputs.curves as Json[]) {
    const construction = values.literal(c.construction, FLAG) === true;
    const key = { drawn: { id: rootOf(c.id as string, rows) } };
    const e = external.get(c.id as string);
    if (e) {
      (e.bounds && !construction ? curves : others).push({ key, shape: e.shape, anchors: externalAnchors(e) });
      continue;
    }
    if (construction) {
      // A construction curve is only shown: one whose shape cannot be read is left out, never a pause.
      const shown = shownGeometry(c, read);
      if (shown) others.push({ key, ...shown });
      continue;
    }
    const geometry = curveGeometry(c, read);
    if (geometry) curves.push({ key, ...geometry });
  }
  curves.push(...glyphs);
  return { sketch: { points, curves }, others };
}

/** Every string a row holds, at any depth: the ids it names. */
function namedIds(value: unknown, out: Set<string>): Set<string> {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) for (const v of value) namedIds(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) namedIds(v, out);
  return out;
}

/**
 * The degrees of freedom a solve leaves, without the points no curve or
 * constraint names: the ends a trim leaves for retired rows are free in
 * the solve but drawn nowhere.
 */
export function liveDof(inputs: Json, dof: number): number {
  const named = new Set<string>();
  for (const c of inputs.curves as Json[]) namedIds(c, named);
  for (const c of inputs.constraints as Json[]) namedIds(c, named);
  let unused = 0;
  for (const p of inputs.points as Json[]) if (!named.has(p.id as string)) unused++;
  return Math.max(0, dof - 2 * unused);
}

registerBuilder('core.sketch', (ctx) => {
  const { values, solver } = ctx.ev;
  const frame = frameOf(ctx, ctx.inputs.frame as Json);
  const externals = buildExternals(ctx, frame);
  const glyphs = buildText(ctx);
  const positions = solver ? solveSketchPositions(ctx.inputs, values, solver, externals) : null;
  const dof = solver ? liveDof(ctx.inputs, solver.gcs.dof()) : undefined;
  const { sketch: solved, others } = solvedSketch(values, ctx.inputs, positions, externals, glyphs);
  const detection = detectRegions(solved);
  const table: RegionTable = {
    regions: ctx.inputs.regions as unknown as RegionRow[],
    retired: (ctx.inputs.retired as unknown as RetiredRow[]).filter((r) => 'region' in r.was),
  };
  const matching = matchRegions(detection, table.regions);
  const result: SketchResult = {
    frame,
    solved,
    others,
    detection,
    matching,
    table,
    lines: linesOf(ctx.inputs, solved, externals),
    externals,
    ...(dof !== undefined ? { dof } : {}),
  };
  ctx.part.sketches.set(ctx.id, result);
});
