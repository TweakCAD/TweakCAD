/**
 * What the tools share: reading their arguments, refusals from editor
 * commands, the feature status a rebuild gives, and the entities a handle
 * names in the shown evaluation.
 */
import { isPlainObject } from '@tweakcad/format';
import { withDefaultUnit, type CommandResult, type Doc, type Json } from '@tweakcad/editor';
import { partOfFeature, partView } from '../app/features';
import type { Display, Key } from '@tweakcad/worker/src/v2/service/types';
import { isPickedRegion, type PickedReference, type PickResult } from '../app/picking';
import { ToolError, invalid, settledDisplay, type AiContext } from './context';
import { recordOf, type HandleEntry, type HandleKind } from './handles';

export type Args = Record<string, unknown>;

export function str(args: Args, field: string): string {
  const v = args[field];
  if (typeof v !== 'string' || v.trim() === '') throw invalid(`\`${field}\` is a non-empty string`);
  return v;
}

export function optStr(args: Args, field: string): string | undefined {
  const v = args[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw invalid(`\`${field}\` is a string`);
  return v;
}

export function num(args: Args, field: string): number {
  const v = args[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`\`${field}\` is a number`);
  return v;
}

export function optBool(args: Args, field: string): boolean | undefined {
  const v = args[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw invalid(`\`${field}\` is true or false`);
  return v;
}

export function strings(args: Args, field: string, required = true): string[] | undefined {
  const v = args[field];
  if (v === undefined && !required) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.some((s) => typeof s !== 'string'))
    throw invalid(`\`${field}\` is a list of strings`);
  return v as string[];
}

export function vec2(v: unknown, field: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n)))
    throw invalid(`\`${field}\` is [x, y]`);
  return [v[0] as number, v[1] as number];
}

/** An expression argument as text: a bare number takes `unit`. */
export function exprArg(args: Args, field: string, unit: string, fallback?: string): string {
  const v = args[field];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw invalid(`\`${field}\` is required`);
  }
  if (typeof v === 'number' && Number.isFinite(v)) return unit === '' ? String(v) : `${v} ${unit}`;
  if (typeof v === 'string' && v.trim() !== '') return unit === '' ? v.trim() : withDefaultUnit(v, unit);
  throw invalid(`\`${field}\` is a number or an expression`);
}

/** Three expression arguments `[x, y, z]` as vector text in `unit`. */
export function vectorArg(args: Args, field: string, unit: string, fallback: [string, string, string]): string[] {
  const v = args[field];
  if (v === undefined) return [...fallback];
  if (!Array.isArray(v) || v.length !== 3) throw invalid(`\`${field}\` is [x, y, z]`);
  return v.map((item, i) => exprArg({ c: item }, 'c', unit, fallback[i]));
}

/** Throws a command's refusal as the tool's. */
export function check(result: CommandResult): Extract<CommandResult, { ok: true }> {
  if (!result.ok) throw new ToolError('REFUSED', result.error.message);
  return result;
}

export interface FeatureStatus {
  status: 'ok' | 'paused' | 'blocked' | 'notBuilt';
  message?: string;
}

/** How a feature fared in a display: built, paused with why, or blocked by an earlier pause. */
export function featureStatus(display: Display, feature: string): FeatureStatus {
  const paused = display.pauses.find((p) => p.feature === feature);
  if (paused) return { status: 'paused', message: paused.message };
  const through = display.pauses.find((p) => p.through?.includes(feature));
  if (through) return { status: 'blocked', message: `${through.feature}: ${through.message}` };
  const stale = display.stale.find((p) => p.feature === feature);
  if (stale) return { status: 'blocked', message: stale.message };
  return { status: 'ok' };
}

/** Why a feature of a part's timeline is left out of the evaluation (suppressed, or after the rollback marker), or null. */
function notBuilt(doc: Doc, feature: string): string | null {
  const part = partOfFeature(doc, feature);
  const view = part ? partView(doc, part, null) : null;
  if (!view) return null;
  const at = view.features.findIndex((f) => f.id === feature);
  if (at < 0) return null;
  if (view.features[at]?.suppressed) return 'It is suppressed';
  if (at >= view.rollbackIndex) return 'It is after the rollback marker';
  return null;
}

/** The result of an added feature, once the rebuild of the document holding it is done. */
export async function added(ctx: AiContext, feature: string, extra: Json = {}): Promise<Json> {
  const display = await settledDisplay(ctx);
  const skipped = notBuilt(ctx.services.editor.document, feature);
  const status: FeatureStatus = skipped ? { status: 'notBuilt', message: skipped } : featureStatus(display, feature);
  return { feature, ...status, ...extra };
}

// ---- Handles ----

/** The handle's entry, of one of `kinds`; refused when it is unknown or of another kind. */
export function entryOf(ctx: AiContext, handle: unknown, kinds: readonly HandleKind[], field: string): HandleEntry {
  if (typeof handle !== 'string') throw invalid(`\`${field}\` is a handle`);
  const e = ctx.handles.get(handle);
  if (!e) throw new ToolError('NOT_FOUND', `${handle} is not a handle of this session; list the entities again`);
  if (!kinds.includes(e.kind)) throw invalid(`${handle} is a ${e.kind}; \`${field}\` takes ${kinds.join(' or ')}`);
  return e;
}

/** The reference to store for an entity handle; a detected region is refused here (it needs its row first). */
export function referenceOf(e: HandleEntry): PickedReference {
  if (isPickedRegion(e.picked)) throw invalid(`${e.handle} is a sketch region; use it as a profile`);
  return e.picked;
}

const STANDARD = new Set(['xy', 'xz', 'yz', 'x', 'y', 'z']);

/** A plane or axis argument: a standard name, or a handle of one of `kinds`. */
export function planeOrAxis(ctx: AiContext, v: unknown, kinds: readonly HandleKind[], field: string): PickedReference {
  if (typeof v === 'string' && STANDARD.has(v.trim().toLowerCase()))
    return { reference: { standard: { name: v.trim().toLowerCase() } }, names: {} };
  return referenceOf(entryOf(ctx, v, kinds, field));
}

/**
 * The key a handle names in the shown evaluation: its own when it was listed
 * from it, otherwise its stored record resolved there again (9.6).
 */
export async function currentKey(ctx: AiContext, e: HandleEntry, display?: Display): Promise<Key> {
  const shown = display ?? (await settledDisplay(ctx));
  if (e.generation === shown.generation) return e.key;
  const record = recordOf(e.picked);
  if (!record) throw new ToolError('STALE_HANDLE', `${e.handle} was listed before the last change; list it again`);
  const found = await ctx.client.resolve(record, { part: e.part });
  if (found.outcome === 'gone') throw new ToolError('NOT_FOUND', `${e.handle} no longer exists in the model`);
  if (found.outcome === 'ask')
    throw new ToolError(
      'STALE_HANDLE',
      `${e.handle} no longer names one entity (an edit split or merged it); list again`,
    );
  const key = found.keys[0];
  if (found.keys.length !== 1 || key === undefined)
    throw new ToolError('STALE_HANDLE', `${e.handle} now lands on ${found.keys.length} entities; list again`);
  ctx.handles.moved(e, shown.generation, key);
  return key;
}

/** The handle of a key of the shown display, picked now unless it was listed already. */
export async function handleOf(
  ctx: AiContext,
  display: Display,
  part: string,
  key: Key,
  kind: HandleKind,
  feature: string,
): Promise<string | null> {
  const known = ctx.handles.known(display.generation, key);
  if (known) return known.handle;
  const picked: PickResult | null = await ctx.services.pick({ key });
  if (!picked) return null;
  return ctx.handles.add({ kind, part, generation: display.generation, key, feature, picked });
}

/** A JSON object argument. */
export function objectArg(args: Args, field: string): Json {
  const v = args[field];
  if (!isPlainObject(v)) throw invalid(`\`${field}\` is an object`);
  return v as Json;
}

export const round = (v: number, digits = 4): number => {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

export const roundVec = (v: readonly number[] | undefined, digits = 4): number[] | undefined =>
  v?.map((x) => round(x, digits));
