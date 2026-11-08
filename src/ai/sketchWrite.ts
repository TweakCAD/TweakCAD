/**
 * One sketch edit from a tool, written through the sketch editor's own
 * commit (`sketcher/commit.ts`): solved with planegcs, external curves held
 * as the display built them, one `editSketch` command with the solved
 * sketch. An edit the solver cannot meet changes nothing.
 */
import type { GcsWrapper } from '@salusoft89/planegcs';
import type { Doc, Editor, Json } from '@tweakcad/editor';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { findFeature, partOfFeature } from '../app/features';
import { sketchesOf } from '../app/modeling/profiles';
import type { Change } from '../sketcher/change';
import { dispatchSketchCommit, planSketchCommit } from '../sketcher/commit';
import { solveInputs, type ExternalShape } from '../sketcher/solve';
import { WorkingValues } from '../sketcher/values';
import { ToolError } from './context';

export interface SketchAt {
  part: string;
  feature: string;
  inputs: Json;
}

/** The sketch feature `id` and its part, or a refusal. */
export function sketchAt(doc: Doc, id: unknown): SketchAt {
  if (typeof id !== 'string') throw new ToolError('INVALID_INPUT', '`sketch` is a sketch feature id');
  const row = findFeature(doc, id);
  if (!row) throw new ToolError('NOT_FOUND', `There is no feature ${id}`);
  if (row.type !== 'core.sketch') throw new ToolError('INVALID_INPUT', `${id} is a ${String(row.type)}, not a sketch`);
  const part = partOfFeature(doc, id);
  if (!part || typeof row.inputs !== 'object' || row.inputs === null)
    throw new ToolError('NOT_FOUND', `${id} is not in a part`);
  return { part, feature: id, inputs: row.inputs as Json };
}

/** The sketch's external curves as the display built them, for the solve. */
export function externalsOf(display: Display | null, at: SketchAt): ExternalShape[] {
  return sketchesOf(display, at.part).find((s) => s.feature === at.feature)?.externals ?? [];
}

/**
 * Solves the sketch as `change` leaves it and writes it as one command. New
 * constraints the solver finds conflicting or redundant refuse the change;
 * optional ones (a point held at the origin, a repeated tangent) are left
 * out instead. Returns the degrees of freedom left.
 */
export function commitSketch(
  editor: Editor,
  gcs: GcsWrapper,
  at: SketchAt,
  change: Change,
  externals: readonly ExternalShape[] = [],
): { dof: number; changed: boolean } {
  // A sketch with text: its glyph contours need the fonts evaluation loads, so its regions are matched at the next evaluation.
  const plan = planSketchCommit(
    { doc: editor.document, gcs, feature: at.feature, stored: at.inputs, externals, glyphs: () => null },
    change,
  );
  if (!plan.ok) throw new ToolError(plan.code === 'bad-argument' ? 'INVALID_INPUT' : 'REFUSED', plan.message);
  const result = dispatchSketchCommit(editor, plan);
  if (!result.ok) throw new ToolError('REFUSED', result.error.message);
  return { dof: plan.dof, changed: result.changed };
}

/**
 * The sketch solved from what is stored, against the values the document
 * has now: its inputs with the solved positions, radii and dimensions, and
 * the degrees of freedom left. When it does not solve, the stored inputs,
 * a null `dof` and why.
 */
export function solvedSketch(
  doc: Doc,
  gcs: GcsWrapper,
  at: SketchAt,
  externals: readonly ExternalShape[] = [],
): { inputs: Json; dof: number | null; message?: string } {
  const solved = solveInputs(gcs, new WorkingValues(doc), at.inputs, externals);
  return solved.ok
    ? { inputs: solved.inputs, dof: solved.dof }
    : { inputs: at.inputs, dof: null, message: solved.message };
}
