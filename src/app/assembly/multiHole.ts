/**
 * A hole through several parts of an assembly (12.3). The hole is an
 * ordinary `core.hole` in each part's own timeline, so each part keeps it
 * and prints with it:
 *
 * - its diameter is one new document parameter that every part's hole
 *   reads, so one edit changes them all;
 * - it is written into the part it starts in, on the face clicked there,
 *   and evaluated;
 * - every other part's hole is placed on that face and on the rims of the
 *   first hole's bores, through in-context references (12.4), and drilled
 *   through all;
 * - every other part's context captures the start part from that state, in
 *   one pass, holding the joints as they stand; and everything is written
 *   as one undo step.
 *
 * A part with several instances, or a library component, takes no hole:
 * the user makes it its own part first.
 */
import { GRAMMAR, isPlainObject } from '@tweakcad/format';
import { Editor, visibleNames, type Doc, type EditorCommand, type Json } from '@tweakcad/editor';
import type { AppServices } from '../services';
import { insertionPoint, literal, nextFeatureName, featureRow } from '../modeling/common';
import { partOf } from '../features';
import { assemblyOf, instanceOfPath, rowsOf } from './assembly';
import { candidateOf, shownDisplay, type Written } from './commit';
import { contextFor, contextRow, updateCommands } from './contexts';
import { assemblyDisplay } from './focus';

export interface HolePoint {
  id: string;
  /** Position in the start face's placement frame (7.3 `plane` on a face), mm. */
  x: number;
  y: number;
}

export interface MultiHole {
  assembly: string;
  /** The start face: its key in the shown display and the instance it was clicked on. */
  face: { key: number; index: number };
  points: HolePoint[];
  /** The diameter, as typed (a bare number is mm). */
  diameter: string;
  /** Display indices of the other instances the hole goes through. */
  through: number[];
}

/** Why an instance cannot take part in a multi-part hole, or null. */
export function holeProblem(doc: Doc, services: AppServices, assembly: string, index: number): string | null {
  const shown = assemblyDisplay(services.display.getState().display, assembly);
  const inst = shown?.instances[index];
  const id = inst ? instanceOfPath(inst.path) : null;
  const row = id ? rowsOf(assemblyOf(doc, assembly), 'instances').find((r) => r.id === id) : undefined;
  const of = row?.of as Json | undefined;
  if (!row || !of || !isPlainObject(of.part))
    return 'Only parts of this document take the hole; make a component its own part first';
  const part = String(of.part.id);
  const display = services.display.getState().display;
  const placed = (shown?.instances ?? []).filter((i) => display?.definitions[i.definition]?.part === part).length;
  const elsewhere = (display?.assemblies ?? []).some(
    (a) => a.id !== assembly && a.instances.some((i) => display?.definitions[i.definition]?.part === part),
  );
  if (placed > 1 || elsewhere)
    return `${String(partOf(doc, part)?.name ?? 'This part')} is placed more than once; make this one its own part first`;
  return null;
}

/** The part an instance of the shown assembly places. */
function partAt(
  doc: Doc,
  services: AppServices,
  assembly: string,
  index: number,
): { part: string; instance: string; path: Json } {
  const inst = assemblyDisplay(services.display.getState().display, assembly)?.instances[index];
  const id = inst ? instanceOfPath(inst.path) : null;
  const row = id ? rowsOf(assemblyOf(doc, assembly), 'instances').find((r) => r.id === id) : undefined;
  const of = row?.of as Json | undefined;
  if (!inst || !id || !of || !isPlainObject(of.part)) throw new Error('the instance is not a part of this document');
  return { part: String(of.part.id), instance: id, path: inst.path as Json };
}

const valueOf = (editor: Editor, text: string, refs: Json = {}): Json => ({
  id: editor.newId('val'),
  def: { expr: { text, grammar: GRAMMAR, refs } },
});

function holeInputs(editor: Editor, placement: Json, positions: Json[], diameter: { name: string; id: string }): Json {
  return {
    placement,
    positions,
    kind: valueOf(editor, '"simple"'),
    diameter: valueOf(editor, diameter.name, { [diameter.name]: { parameter: { id: diameter.id } } }),
    depth: { throughAll: {} },
    tip: { flat: {} },
    thread: { none: {} },
  };
}

/** A parameter name ("hole1", "hole2", ...) that no part of `parts` sees yet. */
function freeName(doc: Doc, parts: readonly string[]): string {
  const taken = new Set<string>();
  for (const part of parts) {
    const timeline = partOf(doc, part)?.timeline;
    const last = Array.isArray(timeline) ? ((timeline as Json[]).at(-1)?.id as string | undefined) : undefined;
    for (const name of visibleNames(doc, { part, feature: last ?? '' }).keys()) taken.add(name);
  }
  for (let n = 1; ; n++) if (!taken.has(`hole${n}`)) return `hole${n}`;
}

/** The commands that add the document parameter the holes share. */
function diameterCommands(
  editor: Editor,
  doc: Doc,
  name: string,
  text: string,
): { commands: EditorCommand[]; id: string } {
  const id = editor.newId('par');
  const parameter = {
    id,
    name,
    type: 'number',
    quantity: 'length',
    value: valueOf(editor, /^[-+]?(\d+\.?\d*|\.\d+)$/.test(text.trim()) ? `${text.trim()} mm` : text.trim()),
    range: { unbounded: {} },
    public: false,
    published: false,
    description: 'Diameter of a hole through several parts',
  };
  const tables = Array.isArray(doc.parameters) ? (doc.parameters as Json[]) : [];
  const table = tables[0]?.id as string | undefined;
  if (table) return { id, commands: [{ type: 'addParameter', table, parameter }] };
  const newTable = editor.newId('tbl');
  return {
    id,
    commands: [
      { type: 'addParameterTable', owner: String(doc.id), table: { id: newTable, name: 'Parameters', parameters: [] } },
      { type: 'addParameter', table: newTable, parameter },
    ],
  };
}

type V3 = [number, number, number];

/** The circular edges of the start part's bodies whose centres are the hole points (the bores' rims on the start face). */
async function rimsOf(services: AppServices, part: string, points: readonly V3[]): Promise<(number | null)[]> {
  const display = services.display.getState().display;
  const def = display ? display.definitions[display.parts[part] as number] : undefined;
  const edges = (def?.bodies ?? []).flatMap((b) => {
    const out: number[] = [];
    for (let i = 0; i + 2 < b.mesh.edges.length; i += 3) out.push(b.mesh.edges[i + 2] as number);
    return out;
  });
  const centres = await Promise.all(
    edges.map(async (key) => ({ key, m: (await services.client.properties(key))?.measures })),
  );
  return points.map((p) => {
    const hit = centres.find(
      ({ m }) =>
        m?.curve === 'circle' &&
        m.center &&
        Math.hypot(m.center[0] - p[0], m.center[1] - p[1], m.center[2] - p[2]) < 1e-6,
    );
    return hit ? hit.key : null;
  });
}

/**
 * Writes the hole through the start part and every part of `through`, as
 * one undo step. The start face's frame (`frame`, in the start part's
 * coordinates) turns the points into positions in the part.
 */
export async function writeMultiHole(
  services: AppServices,
  hole: MultiHole,
  frame: { origin: V3; x: V3; y: V3 },
): Promise<Written> {
  const { editor, scheduler } = services;
  const doc = editor.document;
  try {
    if (hole.points.length === 0) return { ok: false, message: 'Click on the face where the hole goes' };
    if (hole.through.length === 0) return { ok: false, message: 'Pick the other parts the hole goes through' };
    for (const index of [hole.face.index, ...hole.through]) {
      const problem = holeProblem(doc, services, hole.assembly, index);
      if (problem) return { ok: false, message: problem };
    }
    const start = partAt(doc, services, hole.assembly, hole.face.index);
    const others = hole.through.map((i) => partAt(doc, services, hole.assembly, i));
    if (new Set([start.part, ...others.map((o) => o.part)]).size !== others.length + 1)
      return { ok: false, message: 'Each part takes the hole once' };

    // The start face, in the start part, and the shared diameter.
    const face = await services.pick({ key: hole.face.key });
    if (!face || 'region' in face) return { ok: false, message: 'That face is no longer shown; pick it again' };
    const name = freeName(doc, [start.part, ...others.map((o) => o.part)]);
    const diameter = diameterCommands(editor, doc, name, hole.diameter);
    const startFeature = editor.newId('feat');
    const positions = hole.points.map((p) => ({
      id: p.id,
      at: { at: { v: valueOf(editor, `vector(${p.x} mm, ${p.y} mm, 0 mm)`) } },
    }));
    const startBefore = insertionPoint(doc, start.part);
    const startHole: EditorCommand = {
      type: 'addFeature',
      container: start.part,
      feature: featureRow(
        editor,
        startFeature,
        'core.hole',
        nextFeatureName(doc, start.part, 'Hole'),
        holeInputs(editor, { face: face.reference }, positions, { name, id: diameter.id }),
      ),
      names: face.names,
      ...(startBefore ? { before: startBefore } : {}),
    };
    const first = candidateOf(doc, [...diameter.commands, startHole]);
    if (!first.ok) return first;

    // Evaluated, the first hole's rims and the start face are picked through the start part's instance.
    scheduler.setPreview(first.doc);
    const shown = await shownDisplay(services);
    if (!shown || !services.display.getState().preview)
      return { ok: false, message: 'The hole could not be evaluated' };
    const points: V3[] = hole.points.map(
      (p) =>
        [0, 1, 2].map(
          (c) => (frame.origin[c] as number) + p.x * (frame.x[c] as number) + p.y * (frame.y[c] as number),
        ) as V3,
    );
    const rims = await rimsOf(services, start.part, points);
    if (rims.some((r) => r === null))
      return { ok: false, message: 'The hole does not break through the start face; check its position' };
    const record = (face.reference as Json).entity;
    const faceNow = record
      ? await services.client.resolve(record as never, { part: start.part })
      : { outcome: 'gone' as const };
    if (faceNow.outcome !== 'same' || faceNow.keys.length !== 1)
      return { ok: false, message: 'The start face could not be found after the hole' };
    const index =
      assemblyDisplay(shown, hole.assembly)?.instances.findIndex((i) => instanceOfPath(i.path) === start.instance) ??
      -1;
    const through = async (key: number) => {
      const p = await services.client.pick({ key, instance: { assembly: hole.assembly, index } });
      if (!p || 'region' in p) throw new Error('the start part could not be picked through its instance');
      return { reference: p.reference as unknown as Json, names: p.names as unknown as Json };
    };
    const startFace = await through(faceNow.keys[0] as number);
    const rimRefs = await Promise.all(rims.map((r) => through(r as number)));
    const joints = assemblyDisplay(shown, hole.assembly)?.joints ?? {};
    const held = Object.fromEntries(Object.entries(joints).filter(([, v]) => Object.keys(v).length > 0));

    // Each other part: its context of the assembly, and its hole on the start part's face and rims.
    const contexts: { part: string; context: Json; added: boolean }[] = [];
    const holes: EditorCommand[] = [];
    for (const o of others) {
      const existing = contextFor(first.doc, o.part, hole.assembly, o.path);
      const context = existing ?? {
        ...contextRow(editor.newId('ctx'), hole.assembly, o.path),
        position: { captured: { state: held } },
      };
      contexts.push({ part: o.part, context, added: !existing });
      const inContext = (ref: Json) => ({ inContext: { context: { id: context.id }, instance: start.path, ref } });
      const placement = {
        frame: {
          attach: {
            support: [inContext(startFace.reference)],
            mode: valueOf(editor, '"plane"'),
            offset: valueOf(editor, 'placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))'),
            flip: literal(editor, 'false'),
          },
        },
      };
      const at = rimRefs.map((rim) => ({ id: editor.newId('hp'), at: { of: { ref: inContext(rim.reference) } } }));
      const before = insertionPoint(first.doc, o.part);
      holes.push({
        type: 'addFeature',
        container: o.part,
        feature: featureRow(
          editor,
          editor.newId('feat'),
          'core.hole',
          nextFeatureName(first.doc, o.part, 'Hole'),
          holeInputs(editor, placement, at, { name, id: diameter.id }),
        ),
        names: Object.assign({}, startFace.names, ...rimRefs.map((r) => r.names)),
        ...(before ? { before } : {}),
      });
    }

    // One capture pass from the state with every hole written; then all of it as one step.
    const scratch = new Editor(first.doc, { validate: () => [] });
    for (const c of contexts) if (c.added) scratch.dispatch({ type: 'addContext', part: c.part, context: c.context });
    for (const h of holes) scratch.dispatch(h);
    const capture = services.client.updateContexts;
    if (!capture) return { ok: false, message: 'This worker service cannot capture contexts' };
    const update = await capture.call(
      services.client,
      scratch.document,
      contexts.map((c) => ({ part: c.part, context: c.context.id as string })),
      {},
    );
    if (!update.settled) return { ok: false, message: 'The other parts could not capture the start part' };
    const rowOf = (id: unknown) => update.contexts.find((c) => c.context === id)?.row as Json;
    editor.transaction(`Hole through ${others.length + 1} parts`, () => {
      const run = (c: EditorCommand) => {
        const r = editor.dispatch(c);
        if (!r.ok) throw new Error(r.error.message);
      };
      for (const c of diameter.commands) run(c);
      run(startHole);
      contexts.forEach((c, i) => {
        const extra = i === 0 ? { assets: update.assets as Json, names: update.names as unknown as Json } : {};
        if (c.added) run({ type: 'addContext', part: c.part, context: rowOf(c.context.id), ...extra });
        else
          for (const u of updateCommands({
            ...update,
            contexts: update.contexts.filter((x) => x.context === c.context.id),
          }))
            run({ ...u, ...extra } as EditorCommand);
      });
      for (const h of holes) run(h);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    scheduler.setPreview(null);
  }
}
