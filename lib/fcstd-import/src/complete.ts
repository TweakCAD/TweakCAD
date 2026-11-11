/**
 * Finishing a conversion on the worker service, step by step in timeline
 * order, so each step sees the ones before it:
 * - a fillet, a chamfer or a pad on faces names entities of the shape FreeCAD
 *   built: the document up to it is evaluated, the entities of FreeCAD's
 *   stored shape are found among the live ones by geometry, and their records
 *   become its references;
 * - a shape FreeCAD stored becomes a `core.import`'s stored shape.
 *
 * Then every solid feature is compared with the shape FreeCAD stored for it.
 * One that did not build, or built something else, is replaced by that shape
 * as a `core.import`, the solid features before it are suppressed, and the
 * timeline goes on from there: the model is what the file holds, and the
 * features that did rebuild stay parametric.
 *
 * Nothing is meshed, and the parts built here are taken over by the build of
 * the document opened afterwards.
 */
import type { NameTableJson } from '@tweakcad/format';
import type { BodyStyle, Check, ImportNote, LocateStep, Step } from './convert';
import type { Json } from './writer';

/** A shape's volume and box. */
export interface Measured {
  volume: number;
  center: number[];
  min: number[];
  max: number[];
}

/** What `complete` asks of the worker service. */
export interface LocateClient {
  /** Builds `doc`, which the client may keep and compare the next document with: it must not change afterwards. */
  evaluate(doc: unknown, options?: { meshes?: boolean }): Promise<unknown>;
  locate(
    part: string,
    before: string | undefined,
    brep: string,
    kind: 'edge' | 'face',
    indices: number[] | 'all',
    ofFaces?: number[],
  ): Promise<({ reference: { entity: unknown }; names: NameTableJson } | null)[]>;
  /** The references of the live bodies of a part just before a feature. */
  bodyRecords(
    part: string,
    before: string | undefined,
  ): Promise<{ reference: { entity: unknown }; names: NameTableJson }[]>;
  importFile(
    bytes: Uint8Array,
    format: 'brep',
    name: string,
  ): Promise<{ stored: unknown; assets: Record<string, unknown> }>;
  shapeMeasures(brep: string): Promise<Measured | null>;
  stepMeasures(part: string, feature: string): Promise<Measured | null>;
}

/** How far a rebuilt feature may differ from FreeCAD's shape: relative volume, and box and centre of mass as shares of its diagonal. */
const VOLUME = 1e-3;
const BOX = 0.01;
const CENTER = 2e-4;
/** Replacements in a part before its last feature is taken as stored, whatever comes between. */
const MAX_REPLACED = 6;

const FEATURES_WITHOUT_SOLIDS = new Set([
  'core.sketch',
  'core.constructionPlane',
  'core.constructionAxis',
  'core.constructionPoint',
  'core.constructionFrame',
  'core.measure',
]);

function timelineOf(doc: Json, part: string): Json[] {
  const row = (doc.parts as Json[]).find((p) => p.id === part);
  return (row?.timeline as Json[] | undefined) ?? [];
}

function insert(doc: Json, step: Step, row: Json): void {
  const timeline = timelineOf(doc, step.part);
  const at = step.before === undefined ? -1 : timeline.findIndex((f) => f.id === step.before);
  if (at < 0) timeline.push(row);
  else timeline.splice(at, 0, row);
  if (!step.pastTip) return;
  const part = (doc.parts as Json[]).find((p) => p.id === step.part) as Json;
  const rollback = ((part.rollback as Json | undefined)?.before as Json | undefined)?.id;
  const stop = timeline.findIndex((f) => f.id === rollback);
  if (stop < 0 || timeline.indexOf(row) < stop) part.rollback = { before: { id: row.id } };
}

/** Whether `v` names feature `id` anywhere. */
function names(v: unknown, id: string): boolean {
  if (typeof v === 'string') return v === id;
  if (Array.isArray(v)) return v.some((x) => names(x, id));
  if (v !== null && typeof v === 'object') return Object.values(v).some((x) => names(x, id));
  return false;
}

/** Takes out the features of a part that name `id`, and those naming them, with a note for each. */
function dropDependents(doc: Json, part: string, id: string, notes: ImportNote[]): void {
  const timeline = timelineOf(doc, part);
  const gone = [id];
  for (let i = 0; i < gone.length; i++) {
    const missing = gone[i] as string;
    for (let j = timeline.length - 1; j >= 0; j--) {
      const f = timeline[j] as Json;
      if (!names(f.inputs, missing)) continue;
      timeline.splice(j, 1);
      gone.push(f.id as string);
      notes.push({
        severity: 'warning',
        object: String(f.name),
        message: 'what it builds on was not imported, so it was left out',
      });
    }
  }
  const row = (doc.parts as Json[]).find((p) => p.id === part);
  const rollback = row?.rollback as Json | undefined;
  const before = (rollback?.before as Json | undefined)?.id;
  if (row && typeof before === 'string' && !timeline.some((f) => f.id === before)) row.rollback = { end: {} };
}

function setSuppressed(feature: Json): void {
  const expr = ((feature.suppressed as Json).def as Json).expr as Json;
  expr.text = 'true';
}

function isSuppressed(feature: Json): boolean {
  return (((feature.suppressed as Json).def as Json).expr as Json).text === 'true';
}

/**
 * Suppresses the solid features before `id`, whose result the feature at `id`
 * stands in for. Past a rollback only those past it go too: what the part
 * shows is still what comes before the rollback.
 */
function suppressBefore(doc: Json, part: string, id: string): void {
  const timeline = timelineOf(doc, part);
  const row = (doc.parts as Json[]).find((p) => p.id === part);
  const rollback = ((row?.rollback as Json | undefined)?.before as Json | undefined)?.id;
  const stop = timeline.findIndex((f) => f.id === rollback);
  const at = timeline.findIndex((f) => f.id === id);
  for (const f of timeline.slice(stop >= 0 && stop <= at ? stop : 0, at)) {
    if (!FEATURES_WITHOUT_SOLIDS.has(f.type as string)) setSuppressed(f);
  }
}

/** Evaluations here are for the state and the pauses: only the finished document is drawn. */
const NO_MESHES = { meshes: false };

/** Whether a build agrees with FreeCAD's shape. */
function agrees(want: Measured, got: Measured): boolean {
  if (Math.abs(got.volume / want.volume - 1) > VOLUME) return false;
  const diagonal = Math.hypot(...want.max.map((v, a) => v - (want.min[a] as number)));
  const tolerance = Math.max(0.02, BOX * diagonal);
  if (Math.hypot(...want.center.map((v, a) => v - (got.center[a] as number))) > CENTER * diagonal) return false;
  return (
    want.min.every((v, a) => Math.abs(v - (got.min[a] as number)) <= tolerance) &&
    want.max.every((v, a) => Math.abs(v - (got.max[a] as number)) <= tolerance)
  );
}

/** Puts FreeCAD's stored shape in `check`'s place in the timeline, or where the step it was waiting for goes. */
async function standIn(doc: Json, check: Check, client: LocateClient, at: (row: Json) => void): Promise<boolean> {
  try {
    const shape = await client.importFile(check.brep, 'brep', check.name);
    Object.assign(doc.assets as Json, shape.assets);
    at(check.row(shape.stored as Json));
    suppressBefore(doc, check.part, check.feature);
    return true;
  } catch {
    return false;
  }
}

/** Finds what `step` references again, on the evaluated document, and rewrites its row; false when something is not found. */
async function relocate(doc: Json, step: LocateStep, client: LocateClient): Promise<boolean> {
  try {
    const found = await client.locate(
      step.part,
      step.id,
      step.shape,
      step.entity,
      step.indices === 'all' ? 'all' : [...step.indices],
      step.ofFaces,
    );
    if (found.some((f) => f === null)) return false;
    const refs = [
      ...new Map(
        (found as NonNullable<(typeof found)[number]>[]).map((f) => [JSON.stringify(f.reference), f]),
      ).values(),
    ];
    const live = step.needsBodies ? await client.bodyRecords(step.part, step.id) : [];
    Object.assign(doc.names as Json, {}, ...refs.map((r) => r.names), ...live.map((b) => b.names));
    const timeline = timelineOf(doc, step.part);
    timeline.splice(
      timeline.findIndex((f) => f.id === step.id),
      1,
      step.row(
        refs.map((r) => r.reference),
        live.map((b) => b.reference),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

async function verify(
  doc: Json,
  steps: readonly Step[],
  checks: readonly Check[],
  client: LocateClient,
  notes: ImportNote[],
): Promise<void> {
  const parts = new Set(checks.map((c) => c.part));
  const decoder = new TextDecoder();
  // One evaluation serves every part until the document changes.
  let paused: Set<string> | undefined;
  for (const part of parts) {
    const row = (doc.parts as Json[]).find((p) => p.id === part);
    const rollback = ((row?.rollback as Json | undefined)?.before as Json | undefined)?.id;
    const inTimeline = () => {
      const timeline = timelineOf(doc, part);
      const stop = timeline.findIndex((f) => f.id === rollback);
      const live = stop < 0 ? timeline : timeline.slice(0, stop);
      return live.flatMap((f) => {
        const check = checks.find((c) => c.feature === f.id && c.part === part);
        return check && !isSuppressed(f) && f.type !== 'core.import' ? [check] : [];
      });
    };
    const wants = new Map<Check, Measured | null>();
    const want = async (c: Check) => {
      if (!wants.has(c)) wants.set(c, await client.shapeMeasures(decoder.decode(c.brep)));
      return wants.get(c) ?? null;
    };
    const done = new Set<string>();
    const tried = new Set<string>();
    const relocated = new Set<string>();
    for (let replaced = 0; ;) {
      let bad: Check | undefined;
      // A build that throws has no feature to blame: the Tip's stored shape stands for all of it.
      let failed = false;
      try {
        if (!paused) {
          const display = (await client.evaluate(structuredClone(doc), NO_MESHES)) as {
            pauses?: { feature: string }[];
          };
          paused = new Set((display.pauses ?? []).map((p) => p.feature));
        }
        for (const c of inTimeline()) {
          if (done.has(c.feature)) continue;
          const w = await want(c);
          if (!w || !(w.volume > 0)) continue;
          const got = paused.has(c.feature) ? null : await client.stepMeasures(part, c.feature);
          if (!got || !agrees(w, got)) {
            bad = c;
            break;
          }
          done.add(c.feature);
        }
      } catch {
        failed = true;
      }
      if (!bad && !failed) break;
      // A feature with another reading gets one try at it first.
      if (bad?.alternative && !tried.has(bad.feature)) {
        tried.add(bad.feature);
        const row = timelineOf(doc, part).find((f) => f.id === (bad as Check).feature);
        if (row) {
          bad.alternative(row);
          paused = undefined;
          continue;
        }
      }
      // A stored shape stands where a rebuilt one was: what the features after it reference has other names now.
      if (bad && replaced > 0 && !relocated.has(bad.feature)) {
        relocated.add(bad.feature);
        const step = steps.find((s) => s.id === (bad as Check).feature);
        if (step?.kind === 'locate' && (await relocate(doc, step, client))) {
          paused = undefined;
          continue;
        }
      }
      const all = inTimeline();
      const last = all[all.length - 1];
      if (failed && (!last || replaced > MAX_REPLACED)) {
        notes.push({ severity: 'warning', object: 'document', message: 'the model could not be rebuilt' });
        break;
      }
      const target = (replaced >= MAX_REPLACED || failed ? last : bad) as Check;
      const timeline = timelineOf(doc, part);
      const ok = await standIn(doc, target, client, (r) =>
        timeline.splice(
          timeline.findIndex((f) => f.id === target.feature),
          1,
          r,
        ),
      );
      notes.push({
        severity: 'warning',
        object: target.object,
        message: ok
          ? 'it did not rebuild to the shape FreeCAD stored, so it came in as that shape'
          : 'it did not rebuild to the shape FreeCAD stored, and that shape could not be read',
      });
      if (!ok) done.add(target.feature);
      paused = undefined;
      replaced++;
    }
  }
}

/** Where finishing stands: item `done + 1` of `total` of what `label` says is under way. */
export type FinishProgress = (label: string, done: number, total: number) => void;

/**
 * Writes each step's feature into `doc` (in place), checks the result against
 * FreeCAD's shapes, and returns notes on what could not be finished.
 * `progress` hears of each step as it starts, and of the check.
 */
export async function complete(
  doc: Json,
  steps: readonly Step[],
  client: LocateClient,
  checks: readonly Check[] = [],
  styles: readonly BodyStyle[] = [],
  progress?: FinishProgress,
): Promise<ImportNote[]> {
  const notes: ImportNote[] = [];
  for (const [i, step] of steps.entries()) {
    progress?.(`Finishing ${step.object}`, i, steps.length);
    // A step that goes before a feature taken out goes where that feature was.
    const timeline = timelineOf(doc, step.part);
    if (step.before !== undefined && !timeline.some((f) => f.id === step.before)) step.before = undefined;
    if (step.kind === 'shape') {
      try {
        const shape = await client.importFile(step.brep, 'brep', step.name);
        Object.assign(doc.assets as Json, shape.assets);
        insert(doc, step, step.row(shape.stored as Json));
        if (step.replaces) suppressBefore(doc, step.part, step.id);
      } catch (e) {
        notes.push({
          severity: 'warning',
          object: step.object,
          message: `its shape was not imported: ${e instanceof Error ? e.message : String(e)}`,
        });
        dropDependents(doc, step.part, step.id, notes);
      }
      continue;
    }
    let found: Awaited<ReturnType<LocateClient['locate']>>;
    try {
      await client.evaluate(structuredClone(doc), NO_MESHES);
      found =
        step.indices === 'all' || step.indices.length > 0 || step.ofFaces?.length
          ? await client.locate(
              step.part,
              step.before,
              step.shape,
              step.entity,
              step.indices === 'all' ? 'all' : [...step.indices],
              step.ofFaces,
            )
          : [];
    } catch {
      found = [null];
    }
    const refs = [
      ...new Map(
        found.filter((f): f is NonNullable<typeof f> => f !== null).map((f) => [JSON.stringify(f.reference), f]),
      ).values(),
    ];
    const what = step.entity === 'edge' ? 'edges' : 'faces';
    if (found.some((f) => f === null)) {
      const check = checks.find((c) => c.feature === step.id);
      const stood = check && (await standIn(doc, check, client, (r) => insert(doc, step, r)));
      if (stood) {
        notes.push({
          severity: 'warning',
          object: step.object,
          message: `some of its ${what} were not found in the rebuilt model, so it came in as the shape FreeCAD stored`,
        });
        continue;
      }
    }
    if (refs.length === 0 && (step.indices.length !== 0 || step.ofFaces?.length)) {
      notes.push({
        severity: 'warning',
        object: step.object,
        message: `none of its ${what} were found in the imported model, so it was left out`,
      });
      dropDependents(doc, step.part, step.id, notes);
      continue;
    }
    if (found.some((f) => f === null)) {
      notes.push({
        severity: 'warning',
        object: step.object,
        message: `some of its ${what} were not found in the imported model and were left out`,
      });
    }
    Object.assign(doc.names as Json, {}, ...refs.map((r) => r.names));
    let bodies: Json[] = [];
    if (step.needsBodies) {
      const live = await client.bodyRecords(step.part, step.before);
      Object.assign(doc.names as Json, {}, ...live.map((b) => b.names));
      bodies = live.map((b) => b.reference);
    }
    insert(
      doc,
      step,
      step.row(
        refs.map((r) => r.reference),
        bodies,
      ),
    );
  }
  if (checks.length > 0) progress?.('Checking the shapes FreeCAD stored', 0, 0);
  await verify(doc, steps, checks, client, notes);
  if (styles.length > 0) {
    await client.evaluate(structuredClone(doc), NO_MESHES);
    for (const style of styles) {
      const row = (doc.parts as Json[]).find((p) => p.id === style.part);
      if (!row) continue;
      const bodies = await client.bodyRecords(style.part, undefined);
      Object.assign(doc.names as Json, {}, ...bodies.map((b) => b.names));
      (row.attributes as Json[]).push(...bodies.map((b) => style.row(b.reference)));
    }
  }
  return notes;
}
