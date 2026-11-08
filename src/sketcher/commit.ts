/**
 * Writing one sketch edit: the rows a `Change` adds, removes, retires and
 * updates are applied to the stored sketch, the result is solved with
 * planegcs, and one `editSketch` command carries the solved rows and the
 * solved sketch, so region fates are written (8.3). The sketch session and
 * the AI tools both write their edits through here.
 */
import type { GcsWrapper } from '@salusoft89/planegcs';
import { ValuePause, isPlainObject, type SolvedCurve } from '@tweakcad/format';
import type { CommandResult, Doc, EditSketch, Editor, EditorCommand } from '@tweakcad/editor';
import { applyLocally, withoutConstraints, type Change, type RowUpdate } from './change';
import { DIMENSION_KINDS, table, type Json } from './rows';
import { collapsedCurves, plainMessage, solveInputs, solvedSketchOf, type ExternalShape } from './solve';
import { WorkingValues } from './values';

export interface SketchCommitTarget {
  doc: Doc;
  gcs: GcsWrapper;
  /** The `core.sketch` feature edited. */
  feature: string;
  /** Its inputs as stored. */
  stored: Json;
  /** External curves as the display built them, held in the solve. */
  externals?: readonly ExternalShape[];
  /**
   * The glyph contours of the sketch's text for a solved state, or null when
   * they cannot be laid out (the solved sketch is then left out, and regions
   * are matched at the next evaluation).
   */
  glyphs?: (inputs: Json, values: WorkingValues) => readonly SolvedCurve[] | null;
}

export type PlannedSketchCommit =
  | { ok: true; command: EditSketch; before: readonly EditorCommand[]; dof: number }
  | { ok: false; message: string; code: 'not-allowed' | 'bad-argument' };

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Solves the sketch as `change` leaves it and builds the command that
 * writes it. New constraints the solver finds conflicting or redundant
 * refuse the change; optional ones (from snaps and inference) are left out
 * instead.
 */
export function planSketchCommit(target: SketchCommitTarget, change: Change): PlannedSketchCommit {
  const { doc, gcs, stored } = target;
  const externals = target.externals ?? [];
  const known = new Set(table(stored, 'constraints').map((c) => c.id as string));
  const collapsedBefore = new Set(collapsedCurves(stored, new WorkingValues(doc)));
  let attempt = change;
  for (;;) {
    let values: WorkingValues;
    try {
      values = new WorkingValues(
        doc,
        attempt.overrides,
        [attempt.add?.constraints ?? [], attempt.add?.curves ?? []],
        updatedDefinitions(attempt),
      );
    } catch (e) {
      if (e instanceof ValuePause) return { ok: false, message: plainMessage(e), code: 'bad-argument' };
      throw e;
    }
    const next = applyLocally(stored, attempt);
    const solved = solveInputs(gcs, values, next, externals);
    const optional = attempt.optional ?? new Set<string>();
    const added = (attempt.add?.constraints ?? []).map((c) => c.id as string).filter((id) => !known.has(id));
    const redundant = solved.ok ? new Set(solved.redundant.map((id) => id.split(':')[0] as string)) : new Set<string>();
    const optionalRedundant = added.filter((id) => redundant.has(id) && optional.has(id));
    let failure: string | null = null;
    if (!solved.ok) failure = solved.message;
    else if (added.some((id) => redundant.has(id) && !optional.has(id)))
      failure = 'That would over-constrain the sketch';
    else if (collapsedCurves(solved.inputs, values).some((id) => !collapsedBefore.has(id)))
      failure = 'That would shrink a curve to nothing';
    if (solved.ok && failure === null) {
      if (optionalRedundant.length === 0) {
        const glyphs =
          table(solved.inputs, 'text').length === 0 ? [] : (target.glyphs?.(solved.inputs, values) ?? null);
        const command = sketchCommand(
          target.feature,
          stored,
          attempt,
          solved.inputs,
          solvedSketchOf(solved.inputs, values, externals, glyphs),
        );
        return { ok: true, command, before: attempt.before ?? [], dof: solved.dof };
      }
      attempt = withoutConstraints(attempt, new Set(optionalRedundant));
      continue;
    }
    const leftOut = added.filter((id) => optional.has(id));
    if (leftOut.length > 0) {
      attempt = { ...withoutConstraints(attempt, new Set(leftOut)), optional: new Set() };
      continue;
    }
    return { ok: false, message: failure ?? 'The sketch does not solve with that', code: 'not-allowed' };
  }
}

/** The definitions of the value objects an edit's row updates write, by value id: what the solve and the glyphs read for them. */
function updatedDefinitions(change: Change): Map<string, Json> {
  const out = new Map<string, Json>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (isPlainObject(v)) {
      if (typeof v.id === 'string' && v.id.startsWith('val_') && isPlainObject(v.def)) out.set(v.id, v.def);
      for (const [k, inner] of Object.entries(v)) if (k !== 'def') visit(inner);
    }
  };
  for (const u of change.update ?? []) visit(u.set);
  return out;
}

/** Runs a planned edit: the commands it needs first, then the edit, as one undo step; the first refusal undoes them all. */
export function dispatchSketchCommit(
  editor: Editor,
  plan: { command: EditSketch; before: readonly EditorCommand[] },
): CommandResult {
  const { command, before } = plan;
  if (before.length === 0) return editor.dispatch(command);
  let refused: CommandResult | null = null;
  try {
    return editor.transaction(command.label ?? 'Edit sketch', () => {
      for (const c of [...before, command]) {
        const r = editor.dispatch(c);
        if (!r.ok) {
          refused = r;
          throw new Error(r.error.message);
        }
      }
      return { ok: true, label: command.label ?? 'Edit sketch', changed: true } as CommandResult;
    });
  } catch (e) {
    if (refused) return refused;
    throw e;
  }
}

/** The `editSketch` command for a solved change: its rows as solved, and every stored row the solve moved. */
function sketchCommand(
  feature: string,
  stored: Json,
  change: Change,
  solved: Json,
  sketch: ReturnType<typeof solvedSketchOf>,
): EditSketch {
  const byId = new Map<string, Json>();
  for (const name of ['points', 'curves', 'constraints'])
    for (const row of table(solved, name)) byId.set(row.id as string, row);
  const addedIds = new Set<string>();
  const add: NonNullable<EditSketch['add']> = {};
  for (const name of ['points', 'curves', 'constraints', 'text'] as const) {
    const rows = change.add?.[name] ?? [];
    if (rows.length === 0) continue;
    add[name] = rows.map((r) => {
      addedIds.add(r.id as string);
      return byId.get(r.id as string) ?? r;
    });
  }
  const updates = new Map<string, Json>();
  const unsets = new Map<string, string[]>();
  for (const u of change.update ?? []) {
    if (addedIds.has(u.id)) continue;
    updates.set(u.id, { ...(updates.get(u.id) ?? {}), ...(u.set ?? {}) });
    if (u.unset) unsets.set(u.id, [...(unsets.get(u.id) ?? []), ...u.unset]);
  }
  // A solved number is written where the solve moved it from the stored one.
  const note = (id: string, field: string, before: unknown, after: unknown) => {
    const set = updates.get(id) ?? {};
    if (typeof after === 'number' && !(typeof before === 'number' && same(before, after))) set[field] = after;
    else Reflect.deleteProperty(set, field);
    updates.set(id, set);
  };
  const removed = new Set([
    ...(change.remove ?? []),
    ...(change.retire ?? []).map((r) => r.id),
    ...(change.merge ?? []).map((m) => m.from),
  ]);
  for (const name of ['points', 'curves', 'constraints']) {
    for (const row of table(stored, name)) {
      const id = row.id as string;
      const after = byId.get(id);
      if (!after || removed.has(id) || addedIds.has(id)) continue;
      if (name === 'points') {
        note(id, 'x', row.x, after.x);
        note(id, 'y', row.y, after.y);
      } else if (name === 'curves') {
        if (row.kind === 'circle') note(id, 'radius', row.radius, after.radius);
        if (row.kind === 'ellipse' || row.kind === 'ellipticalArc')
          note(id, 'minorRadius', row.minorRadius, after.minorRadius);
      } else if (DIMENSION_KINDS.has(row.kind as string)) note(id, 'solved', row.solved, after.solved);
    }
  }
  const update: RowUpdate[] = [];
  for (const [id, set] of updates) {
    const unset = unsets.get(id);
    if (Object.keys(set).length === 0 && !unset) continue;
    update.push({ id, ...(Object.keys(set).length > 0 ? { set } : {}), ...(unset ? { unset } : {}) });
  }
  return {
    type: 'editSketch',
    sketch: feature,
    label: change.label,
    ...(change.merge && change.merge.length > 0 ? { merge: change.merge } : {}),
    ...(change.remove && change.remove.length > 0 ? { remove: change.remove } : {}),
    ...(change.retire && change.retire.length > 0 ? { retire: change.retire } : {}),
    ...(Object.keys(add).length > 0 ? { add } : {}),
    ...(update.length > 0 ? { update } : {}),
    ...(sketch ? { solved: sketch } : {}),
    ...(change.names ? { names: change.names } : {}),
  };
}
