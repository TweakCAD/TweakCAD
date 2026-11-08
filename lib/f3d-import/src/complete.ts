/**
 * Finishing a conversion on the worker service:
 * - each sketch keeps the constraints the solver can hold with nothing moving,
 *   since a sketch that does not solve pauses what is built on it;
 * - each fillet and chamfer finds its edges, and each feature on whole bodies
 *   its bodies and faces, in the document as built so far, step by step in
 *   timeline order, so each step sees the ones before it.
 * A step whose inputs cannot be found is left out, with what names it.
 * Nothing is meshed. Sketches are vetted against the document's values, so
 * a file with no steps is not built here at all, and the parts built for
 * steps are taken over by the build of the document opened afterwards.
 */
import type { NameTableJson } from '@tweakcad/format';
import type { SurfaceSpec } from '@tweakcad/worker/src/v2/service/onSurfaces';
import type { BodyStep, ImportNote, RoundStep, Step } from './convert';
import type { Json } from './writer';

interface Found {
  reference: { entity: unknown };
  names: NameTableJson;
}

/** What `complete` asks of the worker service. */
export interface F3dClient {
  /**
   * Builds `doc` for the questions below; `meshes: false` asks for no display
   * meshes, which finishing never draws. The client may keep `doc` and compare
   * the next document with it, so it must not change afterwards.
   */
  evaluate(doc: unknown, options?: { meshes?: boolean }): Promise<unknown>;
  /** The constraints of a sketch's inputs that the solver cannot hold still, by id, against the values of the build before. Evaluates nothing itself. */
  vetSketch(inputs: unknown): Promise<string[]>;
  /** The same for sketch features of `doc`, against its values alone, with no build; null for a sketch whose values need one. */
  vetSketches(doc: unknown, features: string[]): Promise<(string[] | null)[]>;
  /** For each pair of surfaces, the edges of the part as built before `before` that lie on both. */
  locateOnSurfaces(part: string, before: string | undefined, pairs: [SurfaceSpec, SurfaceSpec][]): Promise<Found[][]>;
  /** The live bodies of the part as built before `before` that any of these features made. */
  bodiesMadeBy(part: string, before: string | undefined, features: string[]): Promise<Found[]>;
  /** For each surface, the faces of the part as built before `before` lying on it, with their bodies. */
  locateFacesOnSurfaces(
    part: string,
    before: string | undefined,
    surfaces: SurfaceSpec[],
  ): Promise<{ face: Found; body: Found }[][]>;
}

function timelineOf(doc: Json, part: string): Json[] {
  const row = (doc.parts as Json[]).find((p) => p.id === part);
  return (row?.timeline as Json[] | undefined) ?? [];
}

/**
 * The document as built before a step. Earlier features' results carry over
 * from one evaluation to the next, so a part with many fillets is not rebuilt
 * for each, and the document opened afterwards takes the parts' builds over.
 * The assets come along: a stored shape is built from them.
 */
function upTo(doc: Json, step: Step): Json {
  const part = (doc.parts as Json[]).find((p) => p.id === step.part) as Json;
  const timeline = part.timeline as Json[];
  const at = step.before === undefined ? timeline.length : timeline.findIndex((f) => f.id === step.before);
  return {
    ...doc,
    parts: [{ ...part, timeline: at < 0 ? timeline : timeline.slice(0, at) }],
    assemblies: [],
    root: { part: { id: step.part } },
  };
}

/** Finishing never draws what it builds. */
const UNMESHED = { meshes: false };

function insert(doc: Json, step: Step, row: Json): void {
  const timeline = timelineOf(doc, step.part);
  const at = step.before === undefined ? -1 : timeline.findIndex((f) => f.id === step.before);
  if (at < 0) timeline.push(row);
  else timeline.splice(at, 0, row);
}

async function finishRound(doc: Json, step: RoundStep, client: F3dClient, notes: ImportNote[]): Promise<void> {
  const sets: Json[] = [];
  let missing = 0;
  let total = 0;
  for (const set of step.sets) {
    const found = await client.locateOnSurfaces(step.part, undefined, set.pairs);
    total += found.length;
    missing += found.filter((f) => f.length === 0).length;
    // Two pairs can name one edge.
    const edges = [...new Map(found.flat().map((e) => [JSON.stringify(e.reference), e])).values()];
    if (edges.length === 0) continue;
    Object.assign(doc.names as Json, ...edges.map((e) => e.names));
    sets.push(set.row(edges.map((e) => e.reference)));
  }
  if (sets.length === 0) {
    notes.push({
      severity: 'warning',
      object: step.object,
      message: 'none of its edges were found in the imported model, so it was left out',
    });
    return;
  }
  if (missing > 0)
    notes.push({
      severity: 'warning',
      object: step.object,
      message: `${missing} of its ${total} edges were not found in the imported model and were left out`,
    });
  insert(doc, step, step.row(sets));
}

async function finishBodies(doc: Json, step: BodyStep, client: F3dClient, notes: ImportNote[]): Promise<void> {
  const { plan } = step;
  const groups: Json[][] = [];
  for (const group of plan.groups) {
    const found = await client.bodiesMadeBy(step.part, undefined, group);
    Object.assign(doc.names as Json, ...found.map((b) => b.names));
    groups.push(found.map((b) => b.reference));
  }
  const faces: { face: Json; body: Json }[] = [];
  if (plan.surfaces.length > 0) {
    for (const list of await client.locateFacesOnSurfaces(step.part, undefined, plan.surfaces)) {
      for (const f of list) {
        Object.assign(doc.names as Json, f.face.names, f.body.names);
        faces.push({ face: f.face.reference, body: f.body.reference });
      }
    }
  }
  const row = plan.row(groups, faces, step.id);
  if (row) insert(doc, step, row);
  else if (!plan.quiet)
    notes.push({
      severity: 'warning',
      object: step.object,
      message: 'what it works on was not found in the imported model, so it was left out',
    });
}

/** Where finishing stands: item `done + 1` of `total` of what `label` says is under way. */
export type FinishProgress = (label: string, done: number, total: number) => void;

/**
 * Writes each step's feature into `doc` (in place) and returns the notes on
 * what could not be finished. `progress` hears of each sketch vetted and
 * each step finished.
 */
export async function complete(
  doc: Json,
  steps: readonly Step[],
  client: F3dClient,
  progress?: FinishProgress,
): Promise<ImportNote[]> {
  const notes: ImportNote[] = [];
  let dropped = 0;
  const sketches = (doc.parts as Json[]).flatMap((part) =>
    (part.timeline as Json[]).filter(
      (f) => f.type === 'core.sketch' && ((f.inputs as Json).constraints as Json[]).length > 0,
    ),
  );
  // Sketches are vetted against the document's values, with nothing built; one whose values need the parts built is vetted after.
  progress?.('Checking sketches', 0, 0);
  const vetted =
    sketches.length > 0
      ? await client.vetSketches(
          doc,
          sketches.map((f) => f.id as string),
        )
      : [];
  let built = false;
  for (const [i, feature] of sketches.entries()) {
    const inputs = feature.inputs as Json;
    let unheld = vetted[i];
    if (unheld === null || unheld === undefined) {
      progress?.('Checking sketches', i, sketches.length);
      if (!built) {
        // The parts, without placing them: what the sketches need.
        const first = (doc.parts as Json[])[0] as Json;
        await client.evaluate(structuredClone({ ...doc, assemblies: [], root: { part: { id: first.id } } }), UNMESHED);
        built = true;
      }
      unheld = await client.vetSketch(inputs);
    }
    const out = new Set(unheld);
    if (out.size === 0) continue;
    inputs.constraints = (inputs.constraints as Json[]).filter((c) => !out.has(c.id as string));
    dropped += out.size;
  }
  if (dropped > 0)
    notes.push({
      severity: 'info',
      object: 'document',
      message: `${dropped} sketch ${dropped === 1 ? 'constraint' : 'constraints'} the solver could not hold ${dropped === 1 ? 'was' : 'were'} left out; the geometry is unchanged`,
    });

  // A part's steps run together, so each evaluation resumes from the one before.
  const order = [...steps].sort((a, b) => (a.part < b.part ? -1 : a.part > b.part ? 1 : 0));
  for (const [i, step] of order.entries()) {
    progress?.(`Finishing ${step.object}`, i, order.length);
    try {
      await client.evaluate(structuredClone(upTo(doc, step)), UNMESHED);
      if (step.kind === 'round') await finishRound(doc, step, client, notes);
      else await finishBodies(doc, step, client, notes);
    } catch (e) {
      // One feature that cannot be finished does not cost the rest of the file.
      notes.push({
        severity: 'warning',
        object: step.object,
        message: `it could not be finished, so it was left out: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return notes;
}
