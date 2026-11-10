/**
 * A decoded design as a version-2 document: a part for each component, in its
 * own coordinates, and an assembly placing each part wherever the file puts
 * that component. Designs a `.f3z` links to are written the same way and placed
 * at each link. A design with nothing but its root is one part.
 *
 * Fillets and chamfers name faces of the model as it was built, so they are
 * returned as steps for `complete` to finish against the evaluation. What has
 * no counterpart yet is left out and said so in the notes. Bodies with no
 * history become a Base Feature at the start of their component's timeline,
 * which pauses until the file's stored bodies can be read into the kernel.
 */
import type { SurfaceSpec } from '@tweakcad/worker/src/v2/service/onSurfaces';
import type { IdGenerator } from '@tweakcad/editor';
import {
  OPERATIONS,
  chamferFeature,
  extrudeRow,
  isFaceStop,
  filletFeature,
  revolveRow,
  type FeatureContext,
  type LeftOut,
  type PlacedSketch,
  type RoundFeature,
} from './features';
import {
  combineOutcome,
  primitiveOutcome,
  mirrorOutcome,
  moveOutcome,
  patternOutcome,
  removeOutcome,
  shellOutcome,
  type BodyPlan,
  type Outcome,
  type TransformContext,
  type WrittenFeature,
} from './transforms';
import { planParameters, type ParameterPlan } from './parameters';
import { STORED_BODY, UNLINKED } from './parser/types';
import type { F3dComponent, F3dDesign, F3dFeature, F3dSketch } from './parser/types';
import { frameOfMatrix, invertMatrix, multiplyMatrix } from './placement';
import type { FaceIndex } from './parser/brep';
import { convertSketch, type SketchStats } from './sketch';
import { TurnedFaces, turnFeature, Z_UP_TURN } from './turn';
import { Writer, type Json } from './writer';

export interface ImportNote {
  severity: 'info' | 'warning';
  /** What the note is about: `timeline` for why the timeline is short or empty, `document` for the whole file. */
  object: string;
  message: string;
}

interface StepBase {
  part: string;
  /** The feature the new one goes before, or undefined for the end. */
  before: string | undefined;
  object: string;
  id: string;
}

/** A fillet or chamfer: its edges found by surface, then written before `before`. */
export interface RoundStep extends StepBase {
  kind: 'round';
  sets: { pairs: [SurfaceSpec, SurfaceSpec][]; row(refs: Json[]): Json }[];
  row(sets: Json[]): Json;
}

/** A feature on whole bodies: its bodies and faces found in the model as built, then written before `before`. */
export interface BodyStep extends StepBase {
  kind: 'bodies';
  plan: BodyPlan;
}

export type Step = RoundStep | BodyStep;

export interface ImportReport {
  sketches: SketchStats[];
  extrudes: number;
  revolves: number;
  rounds: number;
  bodySteps: number;
  leftOut: Record<string, number>;
  parts: number;
  instances: number;
  /** The file's axis that became the document's y: `z` when a design modelled Z up was turned, (x, y, z) to (x, z, −y). */
  upAxis: 'y' | 'z';
}

export interface Conversion {
  document: Json;
  steps: Step[];
  notes: ImportNote[];
  report: ImportReport;
}

export interface ConvertOptions {
  ids: IdGenerator;
  /** `metadata.writer`. */
  writer: { app: string; version: string };
  /** The document name. */
  name?: string;
  /** `createdAt` and `updatedAt`. */
  now?: string;
  /** The source file, kept as the imported document's origin (13.3) when it is small enough. */
  source?: Uint8Array;
}

/** A larger file stays out of the document, whose assets are inline. */
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

const LEFT_OUT_TEXT: Record<LeftOut, string> = {
  surface: 'surface extrude',
  noProfile: 'extrude or revolve with no profile',
  noRegion: 'extrude or revolve whose profile was not found',
  startsFromFace: 'extrude starting from a face that is not parallel to its sketch',
  toObject: 'extrude up to a face that is not parallel to its sketch',
  noDistance: 'extrude of no length',
  thin: 'thin extrude',
};

/** The stored-shape representation of a Base Feature, which no build reads yet. */
const STORED_REPRESENTATION = { name: 'acis', version: 1 };

const LABELS: Record<string, string> = {
  combine: 'Combine',
  removeBody: 'Remove Body',
  move: 'Move',
  mirror: 'Mirror',
  pattern: 'Pattern',
  primitive: 'Primitive',
  shell: 'Shell',
};

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Whether a matrix turns the frame inside out. */
function isMirror(m: readonly number[]): boolean {
  const at = (i: number) => m[i] as number;
  return (
    at(0) * (at(5) * at(10) - at(6) * at(9)) -
      at(1) * (at(4) * at(10) - at(6) * at(8)) +
      at(2) * (at(4) * at(9) - at(5) * at(8)) <
    0
  );
}

const sketchName = (s: F3dSketch): string => (s.componentName ? `${s.componentName} / ${s.name}` : s.name);

/** A part being written: one per component with anything in it, the root's first. */
interface PartDraft {
  id: string;
  name: string;
  timeline: Json[];
  /** Steps waiting for the next feature row, to know what they go before. */
  pending: Step[];
  /** Model to this part's own coordinates, or null for the root. */
  toPart: number[] | null;
  component: F3dComponent | null;
  /** The part's own parameter rows. */
  parameters: Json[];
}

/** A part at a place in a design's model. */
interface Placed {
  part: string;
  matrix: number[];
}

/** The most instances a document gets: repeated links can multiply without bound in a bad file. */
const MAX_INSTANCES = 200_000;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Of face references, the one whose recorded area is largest. */
function largestFace(faces: readonly Json[]): Json | undefined {
  const area = (f: Json): number =>
    ((f.entity as { snapshot?: { area?: number } } | undefined)?.snapshot?.area as number | undefined) ?? 0;
  return faces.reduce<Json | undefined>((best, f) => (best === undefined || area(f) > area(best) ? f : best), undefined);
}

export function convertDesign(top: F3dDesign, o: ConvertOptions): Conversion {
  const w = new Writer(o.ids);
  const notes: ImportNote[] = [];
  const name = o.name ?? 'Imported design';
  const steps: Step[] = [];
  const stats: SketchStats[] = [];
  const leftOut: Record<string, number> = {};
  const count = (what: string, n = 1): void => {
    leftOut[what] = (leftOut[what] ?? 0) + n;
  };
  let text = 0;
  let unread = 0;
  let lost = 0;
  let extrudes = 0;
  let revolves = 0;
  const allParts: PartDraft[] = [];
  const topTable: Json[] = [];
  const written = new Map<F3dDesign, Placed[]>();
  /** The top design's root part when its contents were turned to stand Y up. */
  let turnedRoot: string | undefined;

  /** Writes a design's parts once; returns where they sit in its model. */
  const writeDesign = (design: F3dDesign, designName: string): Placed[] => {
    const done = written.get(design);
    if (done) return done;
    written.set(design, []);
    const isTop = design === top;
    // A linked design with several parts gives up its parameters: names are unique in the document's table, which the top design has.
    const plan = planParameters(isTop || design.components.length === 0 ? design.parameters : [], w);
    const placed = writeParts(design, designName, plan, isTop);
    for (const link of design.links) {
      const inner = writeDesign(link.design, link.name ?? `Design ${written.size}`);
      for (const at of link.placements) {
        for (const p of inner)
          if (placed.length < MAX_INSTANCES) placed.push({ part: p.part, matrix: multiplyMatrix(at, p.matrix) });
      }
    }
    written.set(design, placed);
    return placed;
  };

  const writeParts = (design: F3dDesign, designName: string, plan: ParameterPlan, isTop: boolean): Placed[] => {
    // A design modelled Z up stands on the app's Y-up axes: its root part's contents turn, and every other part is placed turned.
    const turns = isTop && design.upAxis === 'z';
    const rootPart: PartDraft = {
      id: o.ids('part'),
      name: designName,
      timeline: [],
      pending: [],
      toPart: turns ? Z_UP_TURN : null,
      component: null,
      parameters: [],
    };
    const drafts = new Map<number | null, PartDraft>([[null, rootPart]]);
    const components = new Map(design.components.map((c) => [c.id, c]));
    const partOf = (component: number | null | undefined): PartDraft => {
      const c = component === null || component === undefined ? undefined : components.get(component);
      if (!c) return rootPart;
      let draft = drafts.get(c.id);
      if (!draft) {
        draft = {
          id: o.ids('part'),
          name: c.name ?? `Component ${drafts.size}`,
          timeline: [],
          pending: [],
          toPart: invertMatrix(c.world),
          component: c,
          parameters: [],
        };
        drafts.set(c.id, draft);
      }
      return draft;
    };
    const add = (part: PartDraft, row: Json): void => {
      part.timeline.push(row);
      for (const s of part.pending) s.before = row.id as string;
      part.pending = [];
    };

    const records = new Map(design.sketches.map((s) => [s.id, s]));
    /** Sketches written, by part: a feature can use a sketch of another component, which it gets a copy of. */
    const placed = new Map<string, PlacedSketch>();
    const counted = new Set<number>();
    const emit = (id: number, part: PartDraft): PlacedSketch | undefined => {
      const key = `${id}:${part.id}`;
      const done = placed.get(key);
      if (done) return done;
      const sketch = records.get(id);
      if (!sketch) return undefined;
      if (!counted.has(id)) {
        text += sketch.skipped['text'] ?? 0;
        unread += (sketch.skipped['curve'] ?? 0) + (sketch.skipped['point'] ?? 0);
      }
      counted.add(id);
      const rows = convertSketch(sketch, w, plan);
      stats.push(rows.stats);
      const matrix = sketch.placement ?? IDENTITY;
      const frame = frameOfMatrix(part.toPart ? multiplyMatrix(part.toPart, matrix) : matrix);
      const row = w.feature('core.sketch', sketchName(sketch), {
        frame: w.frame(frame.placement, frame.normal),
        ...rows.inputs,
      });
      add(part, row);
      const out: PlacedSketch = { feature: row.id as string, rows, normal: frame.normal, origin: frame.origin };
      placed.set(key, out);
      return out;
    };

    const turnedFaces = turns ? new TurnedFaces(design.faces) : design.faces;
    const facesOf = (part: PartDraft): FaceIndex => (part === rootPart ? turnedFaces : design.faces);
    const context = (part: PartDraft): FeatureContext => ({
      w,
      plan,
      sketch: (id) => emit(id, part),
      faces: facesOf(part),
    });
    for (const [what, n] of Object.entries(design.leftOut)) count(what, n);

    /** Where a feature goes: the component of its bodies, or of the sketch it starts from. */
    const partOfFeature = (f: F3dFeature): PartDraft => {
      const owner = design.componentOf.get(f.id);
      if (owner !== undefined) return partOf(owner);
      if (f.kind === 'extrude' || f.kind === 'revolve') {
        const sketch = f.profiles[0] && records.get(f.profiles[0].sketchId);
        return partOf(sketch?.componentId);
      }
      return rootPart;
    };

    const features = new Map(design.features.map((f) => [f.id, f]));
    let extrudeLabels = 0;
    let revolveLabels = 0;
    let fillets = 0;
    let chamfers = 0;
    const rows = new Map<number, WrittenFeature>();
    const round = (record: number, part: PartDraft, label: string, id: string, feature: RoundFeature): void => {
      lost += feature.lost;
      if (feature.sets.length === 0) {
        count('fillet or chamfer with no edges found');
        return;
      }
      const step: RoundStep = {
        kind: 'round',
        part: part.id,
        before: undefined,
        object: label,
        id,
        sets: feature.sets,
        row: feature.row,
      };
      steps.push(step);
      part.pending.push(step);
      rows.set(record, { id, part: part.id, op: 'round' });
    };
    const counters: Record<string, number> = {};
    const copiesLeftOut = 'pasted body' in design.leftOut || 'component from bodies' in design.leftOut;
    const transforms: TransformContext = {
      w,
      plan,
      faces: design.faces,
      written: (id) => rows.get(id),
      recordOfOp: design.recordOfOp,
      copiesLeftOut,
    };
    const draftOf = (id: string): PartDraft => [...drafts.values()].find((p) => p.id === id) ?? rootPart;
    const transform = (record: number, label: string, outcome: Outcome): void => {
      if ('leftOut' in outcome) {
        count(outcome.leftOut);
        return;
      }
      const id = o.ids('feat');
      if (outcome.first) add(draftOf('row' in outcome ? outcome.part : outcome.plan.part), outcome.first);
      if ('row' in outcome) {
        const part = draftOf(outcome.part);
        add(part, outcome.row(id));
        rows.set(record, { id, part: part.id, op: 'new' });
        return;
      }
      const part = draftOf(outcome.plan.part);
      const step: BodyStep = {
        kind: 'bodies',
        part: part.id,
        before: undefined,
        object: label,
        id,
        plan: outcome.plan,
      };
      steps.push(step);
      part.pending.push(step);
      rows.set(record, { id, part: part.id, op: 'new' });
    };
    for (const id of design.order) {
      const raw = features.get(id);
      if (!raw) continue;
      if (raw.kind === 'sketch') {
        const sketch = records.get(raw.sketchId);
        if (sketch) emit(raw.sketchId, partOf(sketch.componentId));
        continue;
      }
      const part = partOfFeature(raw);
      const f = turns && part === rootPart ? turnFeature(raw) : raw;
      const ctx = context(part);
      if (f.kind === 'extrude') {
        const row = extrudeRow(ctx, f, `Extrude ${extrudeLabels + 1}`);
        if (typeof row === 'string') count(LEFT_OUT_TEXT[row]);
        else if (isFaceStop(row)) {
          extrudes++;
          extrudeLabels++;
          const stop = row;
          transform(f.id, `Extrude ${extrudeLabels}`, {
            plan: {
              part: part.id,
              groups: [],
              surfaces: [stop.stop],
              // The stop is the face's whole surface, so any face on it will do: the largest, whose name is plainest.
              row: (_groups, faces, id) => {
                const face = largestFace(faces.map((x) => x.face));
                return face ? stop.row(face, id) : null;
              },
            },
          });
          (rows.get(f.id) as { op: string }).op = OPERATIONS[f.operation];
        } else {
          extrudes++;
          extrudeLabels++;
          add(part, row);
          rows.set(f.id, { id: row.id as string, part: part.id, op: OPERATIONS[f.operation] });
        }
      } else if (f.kind === 'revolve') {
        const row = revolveRow(ctx, f, `Revolve ${revolveLabels + 1}`);
        if (typeof row === 'string') count(LEFT_OUT_TEXT[row]);
        else {
          revolves++;
          revolveLabels++;
          add(part, row);
          rows.set(f.id, { id: row.id as string, part: part.id, op: OPERATIONS[f.operation] });
        }
      } else if (f.kind === 'fillet') {
        fillets++;
        const label = `Fillet ${fillets}`;
        const stepId = o.ids('feat');
        round(f.id, part, label, stepId, filletFeature(ctx, f, label, stepId));
      } else if (f.kind === 'chamfer') {
        chamfers++;
        const label = `Chamfer ${chamfers}`;
        const stepId = o.ids('feat');
        const feature = chamferFeature(ctx, f, label, stepId);
        if (feature === 'uneven') count('chamfer of two distances');
        else round(f.id, part, label, stepId, feature);
      } else {
        const label = `${LABELS[f.kind]} ${(counters[f.kind] = (counters[f.kind] ?? 0) + 1)}`;
        const outcomeOf = (g: typeof f, tc: TransformContext): Outcome =>
          g.kind === 'combine'
            ? combineOutcome(tc, g, label)
            : g.kind === 'removeBody'
              ? removeOutcome(tc, g, label)
              : g.kind === 'move'
                ? moveOutcome(tc, g, label)
                : g.kind === 'mirror'
                  ? mirrorOutcome(tc, g, label)
                  : g.kind === 'pattern'
                    ? patternOutcome(tc, g, label)
                    : g.kind === 'primitive'
                      ? primitiveOutcome(tc, g, label, part.id)
                      : shellOutcome(tc, g, label, part.id);
        // A transform lands in the part of what it works on, so it turns only when that is the turned root part.
        const plain = raw as typeof f;
        let outcome = outcomeOf(plain, transforms);
        const lands = 'leftOut' in outcome ? undefined : 'row' in outcome ? outcome.part : outcome.plan.part;
        if (turns && lands === rootPart.id) outcome = outcomeOf(turnFeature(plain), { ...transforms, faces: turnedFaces });
        transform(f.id, label, outcome);
      }
    }
    for (const s of design.sketches) if (!counted.has(s.id)) emit(s.id, partOf(s.componentId));

    // A component's bodies with no history come first, as Fusion's base feature does.
    for (const [component, bodies] of design.storedBodies) {
      const part = partOf(component);
      const asset = w.asset(
        new TextEncoder().encode(JSON.stringify({ format: 'f3d', bodies })),
        'application/json',
        'stored-bodies.json',
      );
      part.timeline.unshift(
        w.feature('core.import', 'Base Feature', {
          source: { kept: {} },
          stored: { asset, representation: { ...STORED_REPRESENTATION }, map: [] },
          importer: { format: 'f3d', version: '' },
          units: w.choice('cm'),
          upAxis: w.choice(turns && part === rootPart ? 'z' : 'y'),
        }),
      );
    }

    // Only parts with something in them are written and placed.
    const filled = [...drafts.values()].filter(
      (p) => p.timeline.length > 0 || p.pending.length > 0 || steps.some((s) => s.part === p.id),
    );
    if (isTop && filled.length === 0 && design.links.length === 0) filled.push(rootPart);
    allParts.push(...filled);
    if (isTop) topTable.push(...plan.rows);
    else if (filled.length === 1) (filled[0] as PartDraft).parameters = plan.rows;
    if (turns) turnedRoot = rootPart.id;
    return filled.flatMap((p) => {
      if (!p.component) return [{ part: p.id, matrix: IDENTITY }];
      const list = p.component.placements.length > 0 ? p.component.placements : [p.component.world];
      return list.map((matrix) => ({ part: p.id, matrix }));
    });
  };

  const placed = writeDesign(top, name).map((p) =>
    top.upAxis === 'z' && p.part !== turnedRoot ? { ...p, matrix: multiplyMatrix(Z_UP_TURN, p.matrix) } : p,
  );
  if (placed.length >= MAX_INSTANCES)
    notes.push({
      severity: 'warning',
      object: 'document',
      message: `only the first ${MAX_INSTANCES} occurrences were placed`,
    });
  const rowCount = allParts.reduce((n, p) => n + p.timeline.length + p.pending.length, 0);
  const stored = leftOut[STORED_BODY] ?? 0;
  const linked = leftOut[UNLINKED] ?? 0;
  const bodyFeature = allParts.some((p) => p.timeline.some((r) => r.type === 'core.primitive'));
  const baseRows = allParts.reduce((n, p) => n + p.timeline.filter((r) => r.type === 'core.import').length, 0);
  const reasons: string[] = [];
  if (stored > 0) {
    const opening =
      rowCount === baseRows
        ? `This design has no history: ${plural(stored, 'body is', 'bodies are')} stored with no timeline`
        : `${plural(stored, 'body has', 'bodies have')} no history`;
    reasons.push(
      `${opening}, kept as ${plural(baseRows, 'Base Feature', 'Base Features')}. Stored bodies can't be read yet, so ${stored === 1 ? 'it is' : 'they are'} not drawn.`,
    );
  }
  if (linked > 0) reasons.push(`${plural(linked, 'linked component is', 'linked components are')} not in this file.`);
  if (extrudes + revolves === 0 && reasons.length === 0 && !bodyFeature)
    reasons.push('This file has nothing on its timeline that builds a body.');
  if (reasons.length > 0) notes.push({ severity: 'warning', object: 'timeline', message: reasons.join(' ') });
  if (allParts.length > 1)
    notes.push({
      severity: 'info',
      object: 'timeline',
      message: `${allParts.length} components, each with its own timeline; the assembly's timeline groups them, and opening one shows its items alone`,
    });

  if (text > 0)
    notes.push({
      severity: 'info',
      object: 'document',
      message: `${text} text ${text === 1 ? 'item' : 'items'} in sketches were left out`,
    });
  if (unread > 0)
    notes.push({
      severity: 'warning',
      object: 'document',
      message: `${unread} sketch points or curves could not be read`,
    });
  if (lost > 0)
    notes.push({
      severity: 'warning',
      object: 'document',
      message: `${lost} rounded ${lost === 1 ? 'edge was' : 'edges were'} not found in the file's stored bodies and left out`,
    });
  for (const [what, n] of Object.entries(leftOut)) {
    if (what !== STORED_BODY && what !== UNLINKED)
      notes.push({
        severity: 'warning',
        object: 'document',
        message: `${n} ${what}${n === 1 ? '' : ' items'} left out`,
      });
  }

  const parts = allParts;
  const instances = placed.map((p) => ({
    part: p.part,
    placement: frameOfMatrix(p.matrix).placement,
    mirrored: isMirror(p.matrix),
  }));
  const mirrored = instances.filter((i) => i.mirrored).length;
  if (mirrored > 0)
    notes.push({
      severity: 'warning',
      object: 'document',
      message: `${mirrored} mirrored ${mirrored === 1 ? 'occurrence was' : 'occurrences were'} placed unmirrored`,
    });
  // A lone part is the document's root, unplaced: only when nothing turns where it is placed.
  const only =
    instances.length === 1 &&
    parts.length === 1 &&
    top.links.length === 0 &&
    (top.upAxis !== 'z' || parts[0]?.id === turnedRoot)
      ? parts[0]
      : undefined;
  const assembly = only ? undefined : w.assembly(name, instances);

  const time = o.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const report: ImportReport = {
    sketches: stats,
    extrudes,
    revolves,
    rounds: steps.filter((s) => s.kind === 'round').length,
    bodySteps: steps.filter((s) => s.kind === 'bodies').length,
    leftOut,
    parts: parts.length,
    instances: instances.length,
    upAxis: top.upAxis === 'z' ? 'z' : 'y',
  };
  const reportBytes = new TextEncoder().encode(JSON.stringify({ format: 'f3d', version: '', notes }, null, 2));
  const kept = o.source !== undefined && o.source.length <= MAX_SOURCE_BYTES ? o.source : undefined;
  const origin = kept
    ? {
        imported: {
          format: 'f3d',
          version: '',
          source: w.asset(kept, 'application/x-f3d', `${name}.f3d`),
          report: w.asset(reportBytes, 'application/json', 'import-report.json'),
        },
      }
    : { original: {} };
  const tableOf = (rows: Json[]): Json[] =>
    rows.length > 0 ? [{ id: o.ids('tbl'), name: 'Parameters', parameters: rows }] : [];
  const document: Json = {
    format: 'tweakcad.document',
    schemaVersion: 2,
    namingRules: 1,
    id: o.ids('doc'),
    metadata: { name, description: '', createdAt: time, updatedAt: time, writer: { ...o.writer }, origin },
    properties: {},
    settings: {},
    // A formula can name a parameter from any part, so several parts share the document's table.
    parameters: only ? [] : tableOf(topTable),
    parts: parts.map((p) => ({
      id: p.id,
      name: p.name,
      parameters: tableOf(p === only ? topTable : p.parameters),
      timeline: p.timeline,
      rollback: { end: {} },
      groups: [],
      sets: [],
      contexts: [],
      attributes: [],
      configurations: [],
      notes: [],
      properties: {},
    })),
    assemblies: assembly ? [assembly] : [],
    root: assembly ? { assembly: { id: assembly.id } } : { part: { id: (only as PartDraft).id } },
    folders: [],
    views: [],
    library: [],
    assets: w.assets,
    names: w.names.toJson(),
  };
  return { document, steps, notes, report };
}
