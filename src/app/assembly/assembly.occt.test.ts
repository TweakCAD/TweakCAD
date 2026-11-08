/**
 * Assemblies in the app, headless, on the real kernel: a document of two
 * parts becomes an assembly; the second part is inserted, joined to the
 * first by a revolute joint picked on their faces, driven, held in a
 * position and exploded, each edit with the pose its solve gives written
 * back; a part derives another; a part edited in the assembly's context
 * references the other part through a captured context; a hole goes
 * through both parts with one diameter, and the second part's hole follows
 * the first through automatic context updates, undone in one step.
 */
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, readDocument } from '@tweakcad/format';
import { seededIds, type Json } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import { raycast } from '@tweakcad/worker/src/v2/service/testKit';
import type { Display, Placement } from '@tweakcad/worker/src/v2/service/types';
import { Docs } from '@tweakcad/worker/src/v2/assemblyDocs';
import { bootApp, type AppServiceClient, type AppServices } from '../services';
import { MemoryWorkingCopy } from '../storage/workingCopy';
import { newTarget, ValueSlots, writeFeature } from '../modeling/feature';
import {
  explodedRow,
  instanceRow,
  newAssemblyCommands,
  positionRow,
  removeInstanceCommands,
  assemblyView,
  assemblyOf,
  rowsOf,
} from './assembly';
import { commitSolved } from './commit';
import { followContextUpdates, inContextPick, contextsOf } from './contexts';
import { buildDerive, newDeriveForm } from './derive';
import { jointCommands, jointEnd, newJointForm, jointsOf, readJoint } from './joints';
import { writeMultiHole } from './multiHole';
import { jointValues } from './pose';
import { jointTimelineRows } from './jointActions';
import { activePartOf, shownOf } from './focus';
import { planeProblem, sketchOn } from '../modeling/commands';
import { sketchesOf } from '../modeling/profiles';
import { embedDocument, insertComponentCommands, overridesFrom, publicParameters } from './library';
import { Editor, saveDocument } from '@tweakcad/editor';
import { partView } from '../features';
import {
  addConfiguration,
  addConfigurationRow,
  configurationsOf,
  parametersOf,
  setConfigurationOverride,
} from '../parameters';
import { componentEditCommands, readComponentEdit } from './componentEdit';
import { importComponent } from './importComponent';
import { buildHole, newHoleForm } from '../modeling/hole';
import { kindOf, pickFor, planarFrame } from '../modeling/picks';
import { pickBody } from '../modeling/BodyPanels';

let k: OcctKernel;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  service = new EvaluationService(k);
}, 60_000);

afterAll(() => {
  service.release();
  k.releaseAll();
});

function client(): AppServiceClient {
  return {
    init: () => Promise.resolve({ loadTimeMs: 0 }),
    evaluate: (doc) => Promise.resolve(service.evaluate(doc as Json)),
    pick: (target, options) => Promise.resolve(service.pick(target, options)),
    exportFile: (format, scope, options) => Promise.resolve(service.exportFile(format, scope, options)),
    properties: (key) => Promise.resolve(service.properties(key)),
    measure: (kind, targets) => Promise.resolve(service.measure(kind, targets)),
    resolve: (record, scope) => Promise.resolve(service.resolve(record, scope)),
    externalCurves: (key, mode, frame) => Promise.resolve(service.externalCurves(key, mode, frame)),
    neighbours: (key) => Promise.resolve(service.neighbours(key)),
    updateContexts: (doc, requests, options) => Promise.resolve(service.updateContexts(doc as Json, requests, options)),
  };
}

async function settled(s: AppServices): Promise<Display> {
  do await s.scheduler.whenIdle();
  while (s.scheduler.busy);
  const display = s.display.getState().display;
  if (!display) throw new Error('nothing shown');
  return display;
}

/** A document of two parts: a 60 × 40 × 10 base on the XY plane and a 40 × 10 × 6 arm, the base its root. */
function twoParts(): { doc: Json; base: string; arm: string; baseBox: string; armBox: string } {
  const d = new Docs(7);
  const base = d.part('Base');
  const baseBox = base.box('60 mm', '40 mm', '10 mm', [0, 0, 5]);
  const arm = d.part('Arm');
  const armBox = arm.box('40 mm', '10 mm', '6 mm', [0, 0, 3]);
  return { doc: d.document({ part: { id: base.id } }), base: base.id, arm: arm.id, baseBox, armBox };
}

async function boot(): Promise<{ s: AppServices } & ReturnType<typeof twoParts>> {
  const { services: s } = await bootApp({
    client: client(),
    workingCopy: new MemoryWorkingCopy(),
    localId: null,
    ids: seededIds(31),
    name: () => 'assembly',
  });
  const parts = twoParts();
  s.editor.store.replace(parts.doc);
  await settled(s);
  return { s, ...parts };
}

const asmOf = (s: AppServices) => ((s.editor.document.root as Json).assembly as Json).id as string;
const placements = (d: Display, assembly: string) =>
  (d.assemblies.find((a) => a.id === assembly)?.instances ?? []).map((i) => i.placement);
const near = (a: readonly number[], b: readonly number[], tol = 1e-6) =>
  a.every((v, i) => Math.abs(v - (b[i] as number)) <= tol);
const stored = (s: AppServices, instance: string) =>
  (((assemblyOf(s.editor.document, asmOf(s)) as Json).instances as Json[]).find((r) => r.id === instance) as Json)
    .placement as Placement;

/** The face key of a part's definition hit by a ray. */
function faceOf(
  d: Display,
  part: string,
  origin: [number, number, number],
  direction: [number, number, number],
): number {
  const hit = raycast(d, d.parts[part] as number, origin, direction);
  if (!hit) throw new Error('no face there');
  return hit.key;
}

/** Bore faces of a part: cylinders, with their centroid and radius. */
function bores(d: Display, part: string): { x: number; y: number; area: number }[] {
  const def = d.definitions[d.parts[part] as number];
  const out: { x: number; y: number; area: number }[] = [];
  for (const b of def?.bodies ?? []) {
    for (let i = 0; i + 2 < b.mesh.faces.length; i += 3) {
      const key = b.mesh.faces[i + 2] as number;
      const m = service.properties(key)?.measures as
        { surface?: string; centroid?: number[]; area?: number } | undefined;
      if (m?.surface === 'cylinder' && m.centroid)
        out.push({ x: m.centroid[0] as number, y: m.centroid[1] as number, area: m.area as number });
    }
  }
  return out;
}

/** Makes an assembly of the base (grounded), inserts the arm, and joins the arm's underside to the base's top by a revolute joint. */
async function hinged(
  s: AppServices,
  base: string,
  arm: string,
): Promise<{ assembly: string; armInstance: string; joint: string }> {
  const made = newAssemblyCommands(s.editor, 'Assembly 1', [base]);
  expect(await commitSolved(s, 'New Assembly', made.commands)).toEqual({ ok: true });
  const assembly = made.assembly;
  const row = instanceRow(
    s.editor,
    { part: { id: arm } },
    { placement: { position: [100, 0, 0], rotation: [0, 0, 0, 1] } },
  );
  expect(await commitSolved(s, 'Insert Arm', [{ type: 'addAssemblyRow', assembly, table: 'instances', row }])).toEqual({
    ok: true,
  });
  const d = await settled(s);
  const top = faceOf(d, base, [10, 5, 50], [0, 0, -1]);
  const under = faceOf(d, arm, [5, 2, -50], [0, 0, 1]);
  const a = await jointEnd(s, { key: top, instance: { assembly, index: 0 } }, 'Base:1');
  const b = await jointEnd(s, { key: under, instance: { assembly, index: 1 } }, 'Arm:1');
  if ('problem' in a || 'problem' in b) throw new Error('no joint end');
  const built = jointCommands(s.editor, assembly, { ...newJointForm(), kind: 'revolute', a, b });
  if (!built.ok) throw new Error(built.message);
  expect(await commitSolved(s, 'Joint', built.commands)).toEqual({ ok: true });
  return { assembly, armInstance: row.id as string, joint: built.joint };
}

describe('assemblies in the app', { timeout: 120_000 }, () => {
  it('makes an assembly, inserts a part, joins it and writes the solved pose back', async () => {
    const { s, base, arm } = await boot();
    const { assembly, armInstance, joint } = await hinged(s, base, arm);
    expect(shownOf(s.editor.document, null)).toEqual({ assembly });
    expect(activePartOf(s.editor.document, null)).toBeNull();
    const d = await settled(s);
    expect(d.pauses).toEqual([]);
    // The joint is in the assembly's timeline.
    expect(jointTimelineRows(s.editor.document, assembly, d).map((r) => [r.id, r.name, r.joint, r.status])).toEqual([
      [joint, 'Revolute 1', true, 'success'],
    ]);
    // The arm's underside sits on the base's top, centre on centre.
    const [, armAt] = placements(d, assembly);
    expect(near(armAt?.position ?? [], [0, 0, 10])).toBe(true);
    expect(near(stored(s, armInstance).position, [0, 0, 10])).toBe(true);
    const shown = d.assemblies[0];
    const frames = shown?.jointFrames[joint];
    expect(frames && jointValues(['rz'], frames.a, frames.b).rz).toBeCloseTo(0, 9);
    expect(jointsOf(s.editor.document, assembly, armInstance).map((j) => j.side)).toEqual(['b']);
    expect(readDocument(s.editor.document).refused).toBe(false);

    // Driving the joint turns the arm and stores the turn; one undo puts it back.
    expect(
      await commitSolved(s, 'Drive', [{ type: 'editAssemblyRow', row: joint, set: { state: { rz: 90 } } }]),
    ).toEqual({ ok: true });
    const turned = await settled(s);
    expect(near(placements(turned, assembly)[1]?.rotation ?? [], [0, 0, Math.SQRT1_2, Math.SQRT1_2], 1e-9)).toBe(true);
    expect(near(stored(s, armInstance).rotation, [0, 0, Math.SQRT1_2, Math.SQRT1_2], 1e-9)).toBe(true);
    s.editor.undo();
    expect(near(stored(s, armInstance).rotation, [0, 0, 0, 1])).toBe(true);
    s.editor.redo();

    // A position holds the turn; going back to 0 and then to the position turns the arm again, its state written back.
    const position = positionRow(s.editor, 'Open', (await settled(s)).assemblies[0]);
    expect(
      await commitSolved(s, 'Capture Position', [
        { type: 'addAssemblyRow', assembly, table: 'positions', row: position },
      ]),
    ).toEqual({ ok: true });
    expect(
      await commitSolved(s, 'Drive', [{ type: 'editAssemblyRow', row: joint, set: { state: { rz: 0 } } }]),
    ).toEqual({ ok: true });
    expect(
      await commitSolved(s, 'Position', [{ type: 'setActivePosition', assembly, position: position.id as string }]),
    ).toEqual({ ok: true });
    const held = await settled(s);
    expect(held.assemblies[0]?.activePosition).toBe(position.id);
    expect(
      ((((assemblyOf(s.editor.document, assembly) as Json).joints as Json[])[0] as Json).state as Json).rz,
    ).toBeCloseTo(90, 9);

    // An exploded view lifts the arm 50 mm; the pose itself stays.
    const exploded = explodedRow(s.editor, 'Exploded', [
      {
        instances: [armInstance],
        move: {
          id: s.editor.newId('val'),
          def: {
            expr: {
              text: 'placement(vector(0 mm, 0 mm, 50 mm), rotate(vector(0, 0, 1), 0 deg))',
              grammar: 1,
              refs: {},
            },
          },
        },
      },
    ]);
    expect(
      await commitSolved(s, 'Exploded View', [
        { type: 'addAssemblyRow', assembly, table: 'explodedViews', row: exploded },
      ]),
    ).toEqual({ ok: true });
    const view = await settled(s);
    expect(view.assemblies[0]?.exploded[exploded.id as string]?.[1]?.position[2]).toBeCloseTo(60, 9);
    expect(placements(view, assembly)[1]?.position[2]).toBeCloseTo(10, 9);
    expect(assemblyView(s.editor.document, assembly, view)?.instances.map((i) => i.label)).toEqual(['Base:1', 'Arm:1']);

    // Removing the arm takes its joint and joint origins with it.
    const removal = removeInstanceCommands(
      s.editor.document,
      assemblyOf(s.editor.document, assembly) as Json,
      armInstance,
    );
    expect(await commitSolved(s, 'Delete Arm:1', removal)).toEqual({ ok: true });
    const left = assemblyOf(s.editor.document, assembly) as Json;
    expect([
      (left.instances as Json[]).length,
      (left.joints as Json[]).length,
      (left.jointOrigins as Json[]).length,
    ]).toEqual([1, 0, 0]);
    expect(readDocument(s.editor.document).refused).toBe(false);
  });

  it('inserts a library component with a public parameter set, as an instance and derived into a part', async () => {
    const { s, base } = await boot();
    // A component: one part, a box whose width is a public parameter.
    const c = new Docs(9);
    const block = c.part('Block');
    const width = block.parameter('width', '20 mm');
    block.box(width, '10 mm', '10 mm', [0, 0, 5]);
    const component = c.document({ part: { id: block.id } });
    const params = publicParameters(component);
    expect(params.map((p) => [p.name, p.text, p.unit])).toEqual([['width', '20 mm', 'mm']]);
    const overrides = overridesFrom(params, { [width]: '30' });
    expect(overridesFrom(params, { [width]: '20 mm' })).toEqual([]);

    const made = newAssemblyCommands(s.editor, 'Assembly 1', [base]);
    expect(await commitSolved(s, 'New Assembly', made.commands)).toEqual({ ok: true });
    const embedded = embedDocument(component, 'Block', s.editor.newId('lib'), {
      catalogue: { id: 'block', version: '1', policy: 'pinned' },
    });
    expect(
      await commitSolved(
        s,
        'Insert Block',
        insertComponentCommands(s.editor, embedded, { assembly: made.assembly }, overrides),
      ),
    ).toEqual({ ok: true });
    // A second insertion of the same content reuses the library entry.
    expect(
      await commitSolved(s, 'Insert Block', insertComponentCommands(s.editor, embedded, { part: base }, overrides)),
    ).toEqual({ ok: true });
    expect((s.editor.document.library as Json[]).length).toBe(1);
    expect(readDocument(s.editor.document).refused).toBe(false);
    const d = await settled(s);
    expect(d.pauses).toEqual([]);
    const placed = d.assemblies[0]?.instances[1];
    const def = placed ? d.definitions[placed.definition] : undefined;
    const xs = Array.from(def?.bodies[0]?.mesh.positions ?? []).filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(30, 6);
    expect(d.definitions[d.parts[base] as number]?.bodies).toHaveLength(2);
  });

  it('edits an inserted component: its public values and configuration row, and the operation of a derive; imports one from a file', async () => {
    const { s, base } = await boot();
    // A component: a box whose width is public, with a configuration (its input made public) whose Wide row widens it.
    const c = new Docs(11);
    const block = c.part('Block');
    const width = block.parameter('width', '20 mm');
    block.box(width, '10 mm', '10 mm', [0, 0, 5]);
    const author = new Editor(c.document({ part: { id: block.id } }), { ids: seededIds(12) });
    expect(addConfiguration(author, block.id).ok).toBe(true);
    const input = parametersOf(author.document, { part: block.id }).find((p) => p.name === 'configuration')!;
    expect(author.dispatch({ type: 'editParameter', parameter: input.id, set: { public: true } }).ok).toBe(true);
    expect(addConfigurationRow(author, configurationsOf(author.document, block.id)[0]!, 'Wide').ok).toBe(true);
    const widthRow = parametersOf(author.document, { part: block.id }).find((p) => p.name === 'width')!;
    expect(
      setConfigurationOverride(
        author,
        block.id,
        configurationsOf(author.document, block.id)[0]!,
        'Wide',
        widthRow,
        '40',
      ).ok,
    ).toBe(true);
    const component = author.document;

    const made = newAssemblyCommands(s.editor, 'Assembly 1', [base]);
    expect(await commitSolved(s, 'New Assembly', made.commands)).toEqual({ ok: true });
    const embedded = embedDocument(component, 'Block', s.editor.newId('lib'), { local: {} });
    expect(
      await commitSolved(
        s,
        'Insert Block',
        insertComponentCommands(s.editor, embedded, { assembly: made.assembly }, []),
      ),
    ).toEqual({ ok: true });
    const instance = String((rowsOf(assemblyOf(s.editor.document, made.assembly), 'instances')[1] as Json).id);
    const site = { assembly: made.assembly, instance };
    const widthOf = async () => {
      const d = await settled(s);
      expect(d.pauses).toEqual([]);
      const placed = d.assemblies[0]?.instances[1];
      const xs = Array.from(
        (placed ? d.definitions[placed.definition] : undefined)?.bodies[0]?.mesh.positions ?? [],
      ).filter((_, i) => i % 3 === 0);
      return Math.round(Math.max(...xs) - Math.min(...xs));
    };
    expect(await widthOf()).toBe(20);

    const edit = readComponentEdit(s.editor.document, site)!;
    expect(edit.params.map((p) => p.name)).toEqual(['width']);
    // Nothing set for this insertion: the field is empty, and the panel greys in what the component gives.
    expect(edit.values).toEqual({ [width]: '' });
    expect(edit.configurations.map((x) => [x.input.name, x.options, x.own])).toEqual([
      ['configuration', ['Default', 'Wide'], 'Default'],
    ]);
    expect(edit.operation).toBeUndefined();

    // The Wide row, chosen by overriding the configuration's input.
    const wide = { ...edit, rows: { [input.id]: 'Wide' } };
    expect(await commitSolved(s, 'Edit Block:1', componentEditCommands(s.editor.document, site, wide))).toEqual({
      ok: true,
    });
    expect(await widthOf()).toBe(40);
    expect(readComponentEdit(s.editor.document, site)?.rows).toEqual({ [input.id]: 'Wide' });
    // A value of its own, with the component's own row again; undo goes back to Wide.
    const own = { ...edit, values: { [width]: '30' } };
    expect(await commitSolved(s, 'Edit Block:1', componentEditCommands(s.editor.document, site, own))).toEqual({
      ok: true,
    });
    expect(await widthOf()).toBe(30);
    expect(readComponentEdit(s.editor.document, site)?.values).toEqual({ [width]: '30 mm' });
    s.editor.undo();
    expect(await widthOf()).toBe(40);
    expect(readDocument(s.editor.document).refused).toBe(false);

    // Derived into the base part: Edit Component edits its overrides and operation.
    expect(
      await commitSolved(s, 'Insert Block', insertComponentCommands(s.editor, embedded, { part: base }, [])),
    ).toEqual({ ok: true });
    const derive = (partView(s.editor.document, base, null)?.features ?? []).find((f) => f.component)!;
    expect(derive.type).toBe('core.derive');
    const derived = readComponentEdit(s.editor.document, { feature: derive.id })!;
    expect(derived.operation).toBe('new');
    expect(
      await commitSolved(
        s,
        'Edit Block 1',
        componentEditCommands(
          s.editor.document,
          { feature: derive.id },
          { ...derived, operation: 'join', values: { [width]: '25' } },
        ),
      ),
    ).toEqual({ ok: true });
    expect(readComponentEdit(s.editor.document, { feature: derive.id })).toMatchObject({
      operation: 'join',
      values: { [width]: '25 mm' },
    });
    expect((await settled(s)).pauses).toEqual([]);

    // The component as a file, imported into the shown assembly: the same content reuses its library entry.
    const bytes = new TextEncoder().encode(saveDocument(component));
    expect(await importComponent(s, { name: 'block.cadjson', bytes })).toMatchObject({ ok: true, into: 'assembly' });
    expect(rowsOf(assemblyOf(s.editor.document, made.assembly), 'instances')).toHaveLength(3);
    expect((s.editor.document.library as Json[]).length).toBe(1);
    expect(await importComponent(s, { name: 'bad.cadjson', bytes: new TextEncoder().encode('{') })).toMatchObject({
      ok: false,
    });
    expect(readDocument(s.editor.document).refused).toBe(false);
  });

  it('derives one part from another', async () => {
    const { s, base, arm } = await boot();
    const target = newTarget(s.editor, base, 'Derive');
    const form = { ...newDeriveForm(s.editor.document, base, s.editor.newId('inst')), source: { part: arm }, z: '20' };
    const built = buildDerive(s.editor.document, target, form, new ValueSlots(() => s.editor.newId('val')));
    if (!built.ok) throw new Error(built.message);
    expect(writeFeature(s.editor, target, 'core.derive', built, 'Derive').ok).toBe(true);
    const d = await settled(s);
    expect(d.pauses).toEqual([]);
    expect(d.definitions[d.parts[base] as number]?.bodies).toHaveLength(2);
  });

  it('references another instance in context through a captured context', async () => {
    const { s, base, arm } = await boot();
    const { assembly } = await hinged(s, base, arm);
    s.app.setState({
      focus: {
        part: base,
        context: {
          assembly,
          at: {
            path: [
              { instance: { id: ((assemblyOf(s.editor.document, assembly) as Json).instances as Json[])[0]?.id } },
            ],
          },
        },
      },
    });
    expect(activePartOf(s.editor.document, s.app.getState().focus)).toBe(base);
    const d = await settled(s);
    const armTop = faceOf(d, arm, [5, 2, 50], [0, 0, -1]);
    const item = { key: armTop, instance: { assembly, index: 1 } };
    const picked = await inContextPick(s, item);
    expect(picked && 'reference' in picked && 'inContext' in picked.reference).toBe(true);
    const [context] = contextsOf(s.editor.document, base);
    expect((((context as Json).captured as Json).set as Json[]).length).toBe(1);
    expect(readDocument(s.editor.document).refused).toBe(false);
    expect(s.editor.store.undoLabel()).toBe('Capture Arm:1');

    // A sketch of the base on the arm's top face, through the context: its plane is where the arm's top stands.
    expect(await planeProblem(s, item)).toBeNull();
    expect(await sketchOn(s, item)).toEqual({ ok: true });
    const shown = await settled(s);
    expect(shown.pauses).toEqual([]);
    const sketch = sketchesOf(shown, base).at(-1);
    expect(sketch?.frame.origin[2]).toBeCloseTo(16, 9);
    expect(sketch?.frame.normal).toEqual([0, 0, 1]);
    s.app.setState({ mode: { kind: 'model' } });
  });

  it("edits a joint's offset, kind and second end after it is made", async () => {
    const { s, base, arm } = await boot();
    const { assembly, armInstance, joint } = await hinged(s, base, arm);
    const origins = () => rowsOf(assemblyOf(s.editor.document, assembly), 'jointOrigins').length;
    let d = await settled(s);
    const read = readJoint(s.editor.document, d, assembly, joint);
    expect(read).toMatchObject({
      kind: 'revolute',
      flip: true,
      offset: '0',
      angle: '0',
      a: { mode: 'face', index: 0 },
      b: { mode: 'face', index: 1 },
    });
    if (!read) throw new Error('not read');

    // Unchanged, the edit writes the joint only.
    const same = jointCommands(s.editor, assembly, read);
    expect(same.ok && same.commands.map((c) => c.type)).toEqual(['editAssemblyRow']);

    // A second end whose flip is a parameter reads as what it comes to, shows it, and is kept by an unchanged edit.
    const bound = structuredClone(s.editor.document);
    const asm = assemblyOf(bound, assembly) as Json;
    const flip = {
      id: newId('par'),
      name: 'facing',
      type: 'boolean',
      public: false,
      published: false,
      description: '',
      range: { unbounded: {} },
      value: { id: newId('val'), def: { expr: { grammar: 1, refs: {}, text: 'true' } } },
    };
    ((asm.parameters ??= []) as Json[]).push({ id: newId('tbl'), name: 'Parameters', parameters: [flip] });
    const originB = rowsOf(asm, 'jointOrigins').find((o) => o.id === read.editing?.b) as Json;
    (((originB.frame as Json).attach as Json).flip as Json).def = {
      expr: { grammar: 1, refs: { facing: { parameter: { id: flip.id } } }, text: 'facing' },
    };
    const boundEditor = new Editor(bound, { ids: seededIds(43) });
    const boundRead = readJoint(boundEditor.document, d, assembly, joint);
    expect(boundRead).toMatchObject({ flip: true, editing: { read: { flip: true, flipBound: 'facing' } } });
    const kept = jointCommands(boundEditor, assembly, boundRead!);
    expect(kept.ok && kept.commands.map((c) => c.type)).toEqual(['editAssemblyRow']);
    const unflipped = jointCommands(boundEditor, assembly, { ...boundRead!, flip: false });
    expect(unflipped.ok && unflipped.commands.map((c) => c.type)).toEqual(['editAssemblyRow', 'editAssemblyRow']);

    // An offset of 5 mm lifts the arm off the base: the first end's origin is rewritten, no new rows.
    const lifted = jointCommands(s.editor, assembly, { ...read, offset: '5', kind: 'slider' });
    if (!lifted.ok) throw new Error(lifted.message);
    expect(await commitSolved(s, 'Edit Joint', lifted.commands)).toEqual({ ok: true });
    d = await settled(s);
    expect(d.pauses).toEqual([]);
    expect(near(stored(s, armInstance).position, [0, 0, 15])).toBe(true);
    expect(origins()).toBe(2);
    const again = readJoint(s.editor.document, d, assembly, joint);
    expect(again).toMatchObject({ kind: 'slider', offset: '5', flip: true });

    // A new second end, the arm's top: the arm turns over, its top face 5 mm over the base's top, facing it.
    const top = faceOf(d, arm, [5, 2, 50], [0, 0, -1]);
    const end = await jointEnd(s, { key: top, instance: { assembly, index: 1 } }, 'Arm:1');
    if ('problem' in end || !again) throw new Error('no joint end');
    const moved = jointCommands(s.editor, assembly, { ...again, b: end });
    if (!moved.ok) throw new Error(moved.message);
    expect(await commitSolved(s, 'Edit Joint', moved.commands)).toEqual({ ok: true });
    expect(stored(s, armInstance).position).toEqual([
      expect.closeTo(0, 6),
      expect.closeTo(0, 6),
      expect.closeTo(15 + 6, 6),
    ]);
    expect(readDocument(s.editor.document).refused).toBe(false);

    // Undo takes the edit back.
    s.editor.undo();
    await settled(s);
    expect(near(stored(s, armInstance).position, [0, 0, 15])).toBe(true);
  });

  it('writes an in-context pick in the frame of the part edited, away from the assembly origin', async () => {
    const { s, base, arm } = await boot();
    const { assembly, armInstance, joint } = await hinged(s, base, arm);
    // The arm stands on the base's top (z = 10), turned 30 degrees about z.
    expect(
      await commitSolved(s, 'Drive', [{ type: 'editAssemblyRow', row: joint, set: { state: { rz: 30 } } }]),
    ).toEqual({ ok: true });
    s.app.setState({ focus: { part: arm, context: { assembly, at: { path: [{ instance: { id: armInstance } }] } } } });
    const d = await settled(s);
    // The base's +x side: centroid (30, 0, 5), normal +x in the assembly, the base standing at its origin.
    const side = faceOf(d, base, [50, 0, 5], [-1, 0, 0]);
    const item = { key: side, instance: { assembly, index: 0 } };
    const picked = await inContextPick(s, item);
    const ic = picked && 'reference' in picked ? ((picked.reference as Json).inContext as Json | undefined) : undefined;
    const snapshot = ((ic?.ref as Json | undefined)?.entity as Json | undefined)?.snapshot as
      { centroid: number[]; normal: number[]; bbox: number[][] } | undefined;
    if (!snapshot) throw new Error('no in-context record');
    // In the arm's frame: p_arm = Rz(-30°) · (p - (0, 0, 10)).
    const c = Math.cos(Math.PI / 6);
    const sn = Math.sin(Math.PI / 6);
    expect(near(snapshot.centroid, [30 * c, -30 * sn, -5], 1e-6)).toBe(true);
    expect(near(snapshot.normal, [c, -sn, 0], 1e-9)).toBe(true);
    // The box is the face's own, in the arm's frame: its z runs 10 below the base's.
    expect(snapshot.bbox[0]?.[2]).toBeCloseTo(-10, 6);
    expect(snapshot.bbox[1]?.[2]).toBeCloseTo(0, 6);

    // A sketch of the arm on that face, through the context, builds where the face stands in the arm.
    expect(await sketchOn(s, item)).toEqual({ ok: true });
    const shown = await settled(s);
    expect(shown.pauses).toEqual([]);
    const sketch = sketchesOf(shown, arm).at(-1);
    expect(near(sketch?.frame.normal ?? [], [c, -sn, 0], 1e-9)).toBe(true);
    s.app.setState({ mode: { kind: 'model' } });
  });

  it("places a hole of the part edited in context on another part's face, read in the edited part's frame", async () => {
    const { s, base, arm } = await boot();
    const { assembly, joint } = await hinged(s, base, arm);
    expect(
      await commitSolved(s, 'Drive', [{ type: 'editAssemblyRow', row: joint, set: { state: { rz: 30 } } }]),
    ).toEqual({ ok: true });
    const baseInstance = ((assemblyOf(s.editor.document, assembly) as Json).instances as Json[])[0]?.id as string;
    s.app.setState({
      focus: { part: base, context: { assembly, at: { path: [{ instance: { id: baseInstance } }] } } },
    });
    const d = await settled(s);
    // The arm's top, z = 6 in the arm, stands at z = 16 over the base.
    const item = { key: faceOf(d, arm, [5, 2, 50], [0, 0, -1]), instance: { assembly, index: 1 } };
    expect(kindOf(d, item)).toBe('face');
    const frame = await planarFrame(s, item);
    expect(near(frame?.origin ?? [], [0, 0, 16], 1e-6)).toBe(true);
    expect(near(frame?.normal ?? [], [0, 0, 1], 1e-9)).toBe(true);

    const target = newTarget(s.editor, base, 'Hole');
    const face = await pickFor(s, target, item);
    expect(face && 'inContext' in face.reference).toBe(true);
    const form = {
      ...newHoleForm(),
      face,
      positions: [{ id: s.editor.newId('hp'), x: '5', y: '0' }],
      diameter: '4',
      extent: 'throughAll' as const,
    };
    const built = buildHole(s.editor.document, target, form, new ValueSlots(() => s.editor.newId('val')));
    if (!built.ok) throw new Error(built.message);
    expect(writeFeature(s.editor, target, 'core.hole', built, 'Hole').ok).toBe(true);
    const after = await settled(s);
    expect(after.pauses).toEqual([]);
    const [bore] = bores(after, base);
    expect(bore?.x).toBeCloseTo(5, 6);
    expect(bore?.y).toBeCloseTo(0, 6);

    // A body of the other part is refused: a feature reads another part's geometry, never changes it.
    expect(await pickBody(s, target, item)).toBeNull();
  });

  it('drills one hole through two parts, sized by one parameter, and keeps the second on the first through context updates', async () => {
    const { s, base, arm } = await boot();
    const { assembly } = await hinged(s, base, arm);
    const stop = followContextUpdates(s);
    try {
      const d = await settled(s);
      // The arm's top face, at z = 6 in the arm: its frame is the arm's origin projected, x along the arm's x.
      const armTop = faceOf(d, arm, [5, 2, 50], [0, 0, -1]);
      const written = await writeMultiHole(
        s,
        {
          assembly,
          face: { key: armTop, index: 1 },
          points: [{ id: s.editor.newId('hp'), x: 12, y: 0 }],
          diameter: '4',
          through: [0],
        },
        { origin: [0, 0, 6], x: [1, 0, 0], y: [0, 1, 0] },
      );
      expect(written).toEqual({ ok: true });
      expect(s.editor.store.undoLabel()).toBe('Hole through 2 parts');
      const after = await settled(s);
      expect(after.pauses).toEqual([]);
      expect(readDocument(s.editor.document).refused).toBe(false);
      const [armBore] = bores(after, arm);
      const [baseBore] = bores(after, base);
      expect(armBore?.x).toBeCloseTo(12, 6);
      expect(baseBore?.x).toBeCloseTo(12, 6);
      // 4 mm through 10 mm: area π · 4 · 10.
      expect(baseBore?.area).toBeCloseTo(Math.PI * 4 * 10, 3);

      // One diameter: changing the parameter widens both.
      const parameter = ((s.editor.document.parameters as Json[])[0]?.parameters as Json[])[0] as Json;
      expect(
        s.editor.dispatch({
          type: 'setValueDef',
          value: (parameter.value as Json).id as string,
          def: { expr: { text: '6 mm', grammar: 1, refs: {} } },
        }).ok,
      ).toBe(true);
      await settled(s);
      const wider = await settled(s);
      expect(bores(wider, base)[0]?.area).toBeCloseTo(Math.PI * 6 * 10, 3);
      expect(bores(wider, arm)[0]?.area).toBeCloseTo(Math.PI * 6 * 6, 3);

      // Moving the arm's hole changes the assembly; the base's automatic context follows in the same undo step.
      const armHole = ((s.editor.document.parts as Json[]).find((p) => p.id === arm)?.timeline as Json[]).find(
        (f) => f.type === 'core.hole',
      ) as Json;
      const position = (((armHole.inputs as Json).positions as Json[])[0]?.at as Json).at as Json;
      const before = s.editor.store.revision;
      expect(
        s.editor.dispatch({
          type: 'setValueDef',
          value: (position.v as Json).id as string,
          def: { expr: { text: 'vector(-8 mm, 0 mm, 0 mm)', grammar: 1, refs: {} } },
        }).ok,
      ).toBe(true);
      for (let i = 0; i < 4 && s.editor.store.revision === before + 1; i++) await settled(s);
      const moved = await settled(s);
      expect(moved.outOfDate).toEqual([]);
      expect(bores(moved, base)[0]?.x).toBeCloseTo(-8, 6);
      expect(bores(moved, arm)[0]?.x).toBeCloseTo(-8, 6);
      s.editor.undo();
      const back = await settled(s);
      expect(bores(back, base)[0]?.x).toBeCloseTo(12, 6);
      expect(back.outOfDate).toEqual([]);
    } finally {
      stop();
    }
  });
});
