import {
  canonicalize,
  detectRegions,
  isPlainObject,
  writeRegionFates,
  type CurveKey,
  type RegionRow,
  type RetiredRow,
} from '@tweakcad/format';
import { CommandError } from '../errors';
import { mergeFields, objectAt, type Doc, type Json } from '../rows';
import { featureAt, mergeNames, requireRow, rowName, type Handlers, type RunContext } from './common';
import type { EditSketch, SketchTable } from './types';

const ROW_KINDS: Record<SketchTable, string> = { points: 'pt', curves: 'crv', constraints: 'con', text: 'txt' };
/** Curve fields that are solver state (8.1): a solve changing them is no boundary change. */
const SOLVER_FIELDS = new Set(['radius', 'minorRadius']);
const TABLES = Object.keys(ROW_KINDS) as SketchTable[];

function sketchAt(doc: Doc, id: string): { path: readonly (string | number)[]; inputs: Json } {
  const at = featureAt(doc, id);
  if (at.row.type !== 'core.sketch' || !isPlainObject(at.row.inputs)) {
    throw new CommandError('not-allowed', `${id} is not a sketch`);
  }
  return { path: at.path, inputs: at.row.inputs };
}

function rows(inputs: Json, table: string): Json[] {
  const value = inputs[table];
  if (!Array.isArray(value)) throw new CommandError('invalid', `the sketch has no ${table} table`);
  return value as Json[];
}

/** Every id in `ids` that `value` names: as a `{"id"}` object or a string in a list. */
function named(value: unknown, ids: ReadonlySet<string>, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && ids.has(item)) out.add(item);
      else named(item, ids, out);
    }
  } else if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'id' && typeof value.id === 'string' && ids.has(value.id)) out.add(value.id);
    for (const [k, v] of Object.entries(value)) if (k !== 'extensions') named(v, ids, out);
  }
  return out;
}

/** Every string value under `value` that is in `ids`, at any key. */
function mentioned(value: unknown, ids: ReadonlySet<string>, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (ids.has(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) mentioned(item, ids, out);
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) if (k !== 'extensions') mentioned(v, ids, out);
  }
  return out;
}

/** The sketch point ids a curve row uses. */
function pointsOf(curve: Json): string[] {
  return stringsUnder(curve).filter((s) => s.startsWith('pt_'));
}

/** A retired row for a curve leaving the live table: the row as it was, without its id (8). */
function retiredCurve(row: Json, fate: string): Json {
  const was: Json = { ...row };
  delete was.id;
  return { id: row.id, was: { curve: was }, fate: { [fate]: {} } };
}

function stringsUnder(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsUnder(v, out));
  else if (isPlainObject(value))
    for (const [k, v] of Object.entries(value)) if (k !== 'extensions') stringsUnder(v, out);
  return out;
}

function originId(curve: unknown): string | undefined {
  if (!isPlainObject(curve) || !isPlainObject(curve.origin) || !isPlainObject(curve.origin.from)) return undefined;
  const id = curve.origin.from.id;
  return typeof id === 'string' ? id : undefined;
}

/** A curve's root (8): its first ancestor, through live and retired curves. */
function rootOf(id: string, parents: ReadonlyMap<string, string>): string {
  const seen = new Set<string>();
  let at = id;
  for (let next = parents.get(at); next !== undefined && !seen.has(next); next = parents.get(at)) {
    seen.add(at);
    at = next;
  }
  return at;
}

function glyphText(key: CurveKey): string | undefined {
  return 'glyph' in key ? key.glyph.text : undefined;
}

/** The curve keys a region's stored uses are on. */
function regionKeys(fields: { loop?: unknown; holes?: unknown }): CurveKey[] {
  const uses = [
    ...(Array.isArray(fields.loop) ? fields.loop : []),
    ...(isPlainObject(fields.holes) && Array.isArray(fields.holes.set) ? (fields.holes.set as unknown[][]).flat() : []),
  ];
  return uses.flatMap((use): CurveKey[] => {
    if (!isPlainObject(use)) return [];
    const payload = (use.open ?? use.closed) as Json | undefined;
    return payload && isPlainObject(payload.curve) ? [payload.curve as unknown as CurveKey] : [];
  });
}

/** Every string under `value` that `ids` maps, replaced; a new copy. */
function replaced(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => replaced(v, ids));
  if (!isPlainObject(value)) return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) out[k] = k === 'extensions' ? v : replaced(v, ids);
  return out;
}

const MERGED_TABLES = ['curves', 'constraints', 'text', 'regions', 'retired'];

/** The point merges of an edit, checked: each `from` a live point merged into another live point that is not merged itself. */
function mergesOf(c: EditSketch, base: Json): Map<string, string> {
  const points = new Set(rows(base, 'points').map((p) => p.id as string));
  const merges = new Map<string, string>();
  for (const m of c.merge ?? []) {
    if (!points.has(m.from) || !points.has(m.into))
      throw new CommandError('not-found', `no point ${points.has(m.from) ? m.into : m.from} in this sketch`);
    if (m.from === m.into || merges.has(m.from))
      throw new CommandError('bad-argument', `${m.from} is merged twice, or into itself`);
    merges.set(m.from, m.into);
  }
  for (const into of merges.values())
    if (merges.has(into)) throw new CommandError('bad-argument', `${into} is merged, so nothing merges into it`);
  return merges;
}

function runEditSketch(c: EditSketch, ctx: RunContext): void {
  mergeNames(ctx, c.names);
  const at = sketchAt(ctx.doc, c.sketch);
  const { path } = at;
  let base = at.inputs;
  const inputs = objectAt(ctx.draft, [...path, 'inputs']);

  // Merges come first: every row naming a merged point names the point it merged into (8.1), and the point goes.
  const merges = mergesOf(c, base);
  const mergedCurves = rows(base, 'curves')
    .filter((r) => pointsOf(r).some((p) => merges.has(p)))
    .map((r) => r.id as string);
  if (merges.size > 0) {
    const merged: Json = { ...base, points: rows(base, 'points').filter((p) => !merges.has(p.id as string)) };
    for (const table of MERGED_TABLES) merged[table] = replaced(rows(base, table), merges);
    for (const table of ['points', ...MERGED_TABLES]) inputs[table] = JSON.parse(JSON.stringify(merged[table]));
    base = merged;
  }
  const tableOf = new Map<string, SketchTable>();
  for (const table of TABLES) for (const row of rows(base, table)) tableOf.set(row.id as string, table);

  // Removals and retirements name live rows.
  const remove = new Set(c.remove ?? []);
  for (const id of remove)
    if (!tableOf.has(id))
      throw new CommandError('not-found', `no point, curve, constraint or text ${id} in this sketch`);
  const retire = new Map((c.retire ?? []).map((r) => [r.id, r.fate]));
  for (const [id, fate] of retire) {
    if (tableOf.get(id) !== 'curves') throw new CommandError('not-found', `no curve ${id} to retire`);
    if (remove.has(id)) throw new CommandError('bad-argument', `${id} is both removed and retired`);
    if (fate !== 'split' && fate !== 'deleted')
      throw new CommandError('bad-argument', `a retired curve's fate is split or deleted`);
  }

  // Constraints on removed points and curves go with them.
  const geometry = new Set([...remove].filter((id) => tableOf.get(id) === 'points' || tableOf.get(id) === 'curves'));
  for (const con of rows(base, 'constraints')) {
    if (named(con, geometry).size > 0) remove.add(con.id as string);
  }

  const removedCurves = new Map<string, Json>();
  for (const table of TABLES) {
    const live = rows(inputs, table);
    for (let i = live.length - 1; i >= 0; i--) {
      const id = (live[i] as Json).id as string;
      if (remove.has(id) || retire.has(id)) {
        if (table === 'curves') removedCurves.set(id, rows(base, 'curves').find((r) => r.id === id) as Json);
        live.splice(i, 1);
      }
    }
  }
  const retired = rows(inputs, 'retired');
  for (const [id, fate] of retire) {
    retired.push(retiredCurve(removedCurves.get(id) as Json, fate));
    removedCurves.delete(id);
  }

  const added = new Map<SketchTable, Json[]>();
  for (const table of TABLES) {
    const list = c.add?.[table] ?? [];
    if (!Array.isArray(list)) throw new CommandError('bad-argument', `add.${table} is a list of rows`);
    const live = rows(inputs, table);
    for (const row of list)
      live.push(requireRow(row, ROW_KINDS[table], table === 'text' ? 'text row' : `${table.slice(0, -1)} row`));
    added.set(table, list);
  }

  for (const update of c.update ?? []) {
    const table = tableOf.get(update.id);
    const row =
      table && !remove.has(update.id) && !retire.has(update.id)
        ? rows(inputs, table).find((r) => r.id === update.id)
        : undefined;
    if (!row) throw new CommandError('not-found', `no live row ${update.id} in this sketch`);
    mergeFields(row, update.set, update.unset);
  }

  if (c.solved) writeFates(c, ctx, base, inputs, added, removedCurves, retire, mergedCurves);

  // A removed curve something still names is retired, not dropped.
  const stillNamed = named([inputs.curves, inputs.regions, inputs.retired, inputs.text], new Set(removedCurves.keys()));
  for (const id of stillNamed) {
    retired.push(retiredCurve(removedCurves.get(id) as Json, 'deleted'));
    removedCurves.delete(id);
  }

  // Points only the dropped curves used go with them.
  const candidates = new Set([...removedCurves.values()].flatMap(pointsOf).filter((id) => !remove.has(id)));
  if (candidates.size > 0) {
    const used = mentioned(
      [inputs.curves, inputs.constraints, inputs.regions, inputs.retired, inputs.text],
      candidates,
    );
    const points = rows(inputs, 'points');
    for (let i = points.length - 1; i >= 0; i--) {
      const id = (points[i] as Json).id as string;
      if (candidates.has(id) && !used.has(id)) points.splice(i, 1);
    }
  }

  // Text rows cannot be retired, so text a region still names stays.
  const removedText = new Set([...remove].filter((id) => tableOf.get(id) === 'text'));
  if (removedText.size > 0) {
    for (const region of [
      ...rows(inputs, 'regions'),
      ...rows(inputs, 'retired').map((r) => (isPlainObject(r.was) ? r.was.region : undefined)),
    ]) {
      if (!isPlainObject(region)) continue;
      const text = regionKeys(region)
        .map(glyphText)
        .find((t) => t !== undefined && removedText.has(t));
      if (text) throw new CommandError('not-allowed', `text ${text} bounds a region, so it cannot be removed`);
    }
  }
}

/** Region fates (8.3) for the boundary curves the edit added, removed, retired, reshaped or merged onto other points. */
function writeFates(
  c: EditSketch,
  ctx: { newId: (kind: string) => string },
  base: Json,
  inputs: Json,
  added: ReadonlyMap<SketchTable, Json[]>,
  removedCurves: ReadonlyMap<string, Json>,
  retire: ReadonlyMap<string, string>,
  mergedCurves: readonly string[],
): void {
  const solved = c.solved;
  if (!solved) return;
  const parents = new Map<string, string>();
  const note = (id: unknown, row: unknown) => {
    const from = originId(row);
    if (typeof id === 'string' && from) parents.set(id, from);
  };
  for (const row of rows(base, 'curves')) note(row.id, row);
  for (const row of added.get('curves') ?? []) note(row.id, row);
  for (const row of rows(base, 'retired')) if (isPlainObject(row.was)) note(row.id, row.was.curve);

  const keys = new Map<string, CurveKey>();
  const addKey = (key: CurveKey) => keys.set(canonicalize(key), key);
  // A curve made construction or not, or moved onto other points, leaves or joins the boundary as an added or removed one does.
  const reshaped = (c.update ?? [])
    .filter((u) => rows(base, 'curves').some((r) => r.id === u.id))
    .filter((u) => (u.unset ?? []).length > 0 || Object.keys(u.set ?? {}).some((k) => !SOLVER_FIELDS.has(k)))
    .map((u) => u.id)
    .concat(mergedCurves);
  for (const id of [
    ...(added.get('curves') ?? []).map((r) => r.id as string),
    ...removedCurves.keys(),
    ...retire.keys(),
    ...reshaped,
  ]) {
    addKey({ drawn: { id: rootOf(id, parents) } });
  }
  // A text row whose fields changed has new glyphs: they count as removed and added back, as a reshaped curve does.
  const changedText = (c.update ?? []).map((u) => u.id).filter((id) => rows(base, 'text').some((r) => r.id === id));
  const addedText = new Set([...(added.get('text') ?? []).map((r) => r.id as string), ...changedText]);
  for (const curve of solved.curves) {
    const text = glyphText(curve.key);
    if (text && addedText.has(text)) addKey(curve.key);
  }
  const removedText = new Set([
    ...rows(base, 'text')
      .map((r) => r.id as string)
      .filter((id) => !rows(inputs, 'text').some((r) => r.id === id)),
    ...changedText,
  ]);
  for (const region of rows(base, 'regions')) {
    for (const key of regionKeys(region)) {
      const text = glyphText(key);
      if (text && removedText.has(text)) addKey(key);
    }
  }
  if (keys.size === 0) return;

  const regionRetired = rows(base, 'retired').filter((r) => isPlainObject(r.was) && 'region' in r.was);
  const table = {
    regions: rows(base, 'regions') as unknown as RegionRow[],
    retired: regionRetired as unknown as RetiredRow[],
  };
  const result = writeRegionFates(table, detectRegions(solved), {
    commandCurves: [...keys.values()],
    newRegionId: () => ctx.newId('reg'),
  });
  if (canonicalize(result.regions) !== canonicalize(table.regions))
    inputs.regions = result.regions as unknown as Json[];
  rows(inputs, 'retired').push(...(result.retired.slice(table.retired.length) as unknown as Json[]));
}

export const sketchHandlers: Handlers<'editSketch' | 'pickRegion'> = {
  editSketch: {
    label: (c) => c.label ?? 'Edit sketch',
    run: runEditSketch,
  },

  pickRegion: {
    label: (c, doc) => `Pick region in ${rowName(doc, c.sketch, 'sketch')}`,
    run(c, ctx) {
      const { path } = sketchAt(ctx.doc, c.sketch);
      const region = requireRow(c.region, 'reg', 'region');
      // A detected region the table does not hold yet, written as the editor's pick (8.3).
      const row: Json = { id: region.id, loop: region.loop, holes: region.holes, origin: { detected: {} } };
      rows(objectAt(ctx.draft, [...path, 'inputs']), 'regions').push(row);
    },
  },
};
