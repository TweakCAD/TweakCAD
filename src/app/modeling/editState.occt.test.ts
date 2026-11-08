/**
 * A panel on a feature works in the part just before that feature, on the
 * real kernel: a wheel-like part (a disc, four window bodies made by one
 * extrude, a cut of the disc by the windows) has its cut edited; the panel
 * lists the target and the tools by their names in the state before the
 * cut, the viewport shows that state with the preview on top and the
 * features after the cut hidden, the browser lists that state while a
 * preview shows, and a stored tool that lands on nothing there reads as
 * missing.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeSet } from '@tweakcad/format';
import { seededIds, type Json } from '@tweakcad/editor';
import { DocBuilder } from '@tweakcad/worker/src/v2/docBuilder';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import type { Display, PickedEntity } from '@tweakcad/worker/src/v2/service/types';
import { bootApp, type AppServiceClient, type AppServices } from '../services';
import { MemoryWorkingCopy } from '../storage/workingCopy';
import { setName } from '../attributes';
import { bodiesOf } from '../features';
import { labelsOfStoredPicks, relabelled } from './beforeState';
import { pickBody, shellOwnersBefore } from './BodyPanels';
import { buildBoolean, readBoolean, readShell, shellBodyOf, withShellFaces } from './bodyFeatures';
import { candidateFeature, editTarget, newTarget, sameReference, ValueSlots } from './feature';

let k: OcctKernel;
let gcs: GcsWrapper;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  const here = dirname(fileURLToPath(import.meta.url));
  const wasm = [3, 4, 5]
    .map((up) =>
      resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
  service = new EvaluationService(k, gcs);
}, 60_000);

afterAll(() => {
  service.release();
  k.releaseAll();
});

function client(s: EvaluationService): AppServiceClient {
  return {
    init: () => Promise.resolve({ loadTimeMs: 0 }),
    evaluate: (doc) => Promise.resolve(s.evaluate(doc as Json)),
    pick: (target, options) => Promise.resolve(s.pick(target, options)),
    exportFile: (format, scope, options) => Promise.resolve(s.exportFile(format, scope, options)),
    properties: (key) => Promise.resolve(s.properties(key)),
    externalCurves: (key, mode, frame) => Promise.resolve(s.externalCurves(key, mode, frame)),
    measure: (kind, targets) => Promise.resolve(s.measure(kind, targets)),
    resolve: (record, scope) => Promise.resolve(s.resolve(record, scope)),
    bodiesBefore: (scope, records, options) => Promise.resolve(s.bodiesBefore(scope, records, options)),
  };
}

async function settled(s: AppServices): Promise<Display> {
  do await s.scheduler.whenIdle();
  while (s.scheduler.busy);
  const display = s.display.getState().display;
  if (!display) throw new Error('nothing shown');
  return display;
}

const WINDOWS: [number, number, number, number][] = [
  [20, -3, 8, 6],
  [-28, -3, 8, 6],
  [-3, 20, 6, 8],
  [-3, -28, 6, 8],
];

/**
 * A disc (Body 1), four windows extruded together as new bodies (Bodies 2 to
 * 5), a cut of the disc by the windows, and a block after it (Body 6).
 * With `stray`, the cut also lists the block among its tools: a stored
 * reference to a body the part does not hold before the cut.
 */
function wheel(stray = false): { doc: Json; part: string; cut: string } {
  const d = new DocBuilder();
  const disc = d.sketch('xy', (x) => x.circle(0, 0, 40));
  d.extrude({ sketch: disc.feature, profiles: [disc.region([0, 0])], sides: [{ distance: '10 mm' }] });
  const windows = d.sketch('xy', (x) => {
    for (const [px, py, w, h] of WINDOWS) x.rect(px, py, w, h);
  });
  d.extrude({
    sketch: windows.feature,
    profiles: WINDOWS.map(([px, py, w, h]) => windows.region([px + w / 2, py + h / 2])),
    sides: [{ distance: '10 mm' }],
  });
  const before = service.evaluate(d.document()).definitions[0]!.bodies;
  const picked = before.map((b) => service.pick({ key: b.key }) as PickedEntity);
  const cut = d.feature('core.boolean', {
    target: picked[0]!.reference,
    tools: { set: picked.slice(1).map((p) => p.reference) },
    op: d.val('"cut"'),
    keepTools: d.val('false'),
  });
  const block = d.sketch('xy', (x) => x.rect(60, 0, 10, 10));
  d.extrude({ sketch: block.feature, profiles: [block.region([61, 1])], sides: [{ distance: '10 mm' }] });
  const doc = d.document();
  for (const p of picked) Object.assign(doc.names as Json, p.names);
  if (stray) {
    const after = service.evaluate(doc).definitions[0]!.bodies;
    const blockPick = service.pick({ key: after.at(-1)!.key }) as PickedEntity;
    const row = ((doc.parts as Json[])[0]!.timeline as Json[]).find((f) => f.id === cut)!;
    const tools = (row.inputs as Json).tools as Json;
    (row.inputs as Json).tools = makeSet([...(tools.set as Json[]), blockPick.reference]) as unknown as Json;
    Object.assign(doc.names as Json, blockPick.names);
  }
  return { doc, part: d.partId, cut };
}

async function boot(doc: Json): Promise<AppServices> {
  const { services: s } = await bootApp({
    client: client(service),
    workingCopy: new MemoryWorkingCopy(),
    localId: null,
    ids: seededIds(31),
    name: () => 'wheel',
  });
  s.editor.store.replace(doc);
  await settled(s);
  return s;
}

describe('editing a feature works in the part just before it', { timeout: 60_000 }, () => {
  it("lists an edited cut's target and tools by their names before the cut, in the panel and the browser", async () => {
    const { doc, part, cut } = wheel();
    const s = await boot(doc);
    const committed = await settled(s);
    expect(committed.pauses).toEqual([]);
    // After the cut the windows are gone; the disc and the block keep their numbers.
    expect(bodiesOf(committed, part).map((b) => b.name)).toEqual(['Body 1', 'Body 6']);

    // The cut opens for editing: its stored picks read back with placeholder labels.
    const target = editTarget(s.editor.document, part, cut, 'core.boolean')!;
    const form = readBoolean(s.editor.document, part, target.base!);
    expect(form.tools.map((t) => t.label)).toEqual(['Tool body', 'Tool body', 'Tool body', 'Tool body']);
    s.scheduler.setBefore({ part, feature: cut });
    const before = await settled(s);
    // The viewport shows the part rolled back to just before the cut: the disc and the windows, not the block after it.
    expect(s.display.getState().preview).toBe(true);
    expect(before.definitions[before.parts[part] as number]?.rollback).toBe(cut);
    expect(bodiesOf(before, part).map((b) => b.name)).toEqual(['Body 1', 'Body 2', 'Body 3', 'Body 4', 'Body 5']);

    // The panel's stored target and tools are named as the state before the cut names them.
    const relabel = relabelled(form, await labelsOfStoredPicks(s, target, form));
    expect([relabel.target?.label, ...relabel.tools.map((t) => t.label)]).toEqual([
      'Body 1',
      'Body 2',
      'Body 3',
      'Body 4',
      'Body 5',
    ]);
    const lists = { target: relabel.target, tools: relabel.tools };

    // The browser lists the part before the cut.
    let state = s.display.getState();
    expect(bodiesOf(state.display, part, state.committed, state.before).map((b) => b.name)).toEqual([
      'Body 1',
      'Body 2',
      'Body 3',
      'Body 4',
      'Body 5',
    ]);

    // A preview that keeps the first window: the browser still lists the state before the cut, no preview body.
    const built = buildBoolean(
      s.editor.document,
      target,
      { ...form, target: lists.target, tools: lists.tools.slice(1) },
      new ValueSlots(() => s.editor.newId('val'), target.base),
    );
    if (!built.ok) throw new Error(built.message);
    const candidate = candidateFeature(s.editor.document, target, 'core.boolean', built, (kind) =>
      s.editor.newId(kind),
    );
    if (!candidate.ok) throw new Error(candidate.message);
    s.scheduler.setPreview(candidate.doc);
    const preview = await settled(s);
    state = s.display.getState();
    expect(state.preview).toBe(true);
    // The preview shows the part just after the cut: the block made after it does not show while the cut is edited.
    expect(bodiesOf(preview, part).map((b) => b.name)).toEqual(['Body 1', 'Body 2']);
    const rows = bodiesOf(state.display, part, state.committed, state.before);
    expect(rows.map((b) => b.name)).toEqual(['Body 1', 'Body 2', 'Body 3', 'Body 4', 'Body 5']);
    expect(rows.every((b) => b.key >= 0)).toBe(true);
    // A body the preview shows keeps its shown key; a window the preview consumes is still picked from its row.
    expect(rows[0]!.key).toBe(bodiesOf(preview, part)[0]!.key);
    const fourth = await pickBody(s, target, { key: rows[3]!.key });
    expect(fourth?.label).toBe('Body 4');
    expect(sameReference(fourth!.reference, lists.tools[2]!.reference)).toBe(true);

    // Closed: the browser lists the committed model again.
    s.scheduler.setPreview(null);
    s.scheduler.setBefore(null);
    await settled(s);
    state = s.display.getState();
    expect(state.before).toBeNull();
    expect(bodiesOf(state.display, part, state.committed, state.before).map((b) => b.name)).toEqual([
      'Body 1',
      'Body 6',
    ]);
    s.dispose();
  });

  it('marks a stored tool that lands on nothing before the cut as missing', async () => {
    const { doc, part, cut } = wheel(true);
    const s = await boot(doc);
    const target = editTarget(s.editor.document, part, cut, 'core.boolean')!;
    const form = readBoolean(s.editor.document, part, target.base!);
    expect(form.tools).toHaveLength(5);
    // The stored set is in canonical order, so the stray block's pick may come anywhere in it.
    const read = (tools: readonly { label: string; missing?: boolean }[]) =>
      tools.map((t) => `${t.label}${t.missing ? ' (missing)' : ''}`).sort();
    const relabel = relabelled(form, await labelsOfStoredPicks(s, target, form));
    expect(read(relabel.tools)).toEqual(['Body 2', 'Body 3', 'Body 4', 'Body 5', 'Missing body (missing)']);
    s.dispose();
  });

  it('lists a new feature against the part at its rollback', async () => {
    const { doc, part, cut } = wheel();
    const s = await boot(doc);
    const at = (feature: string) => {
      s.scheduler.setBefore({ part, feature });
      return settled(s).then(() => s.display.getState().before?.bodies.map((b) => b.name));
    };
    // At the end of the timeline: the committed model.
    expect(await at(newTarget(s.editor, part, 'Pattern').feature)).toEqual(['Body 1', 'Body 6']);
    // Rolled back to before the cut: the disc and the windows.
    s.editor.dispatch({ type: 'setRollback', part, before: cut });
    s.scheduler.setBefore(null);
    await settled(s);
    expect(await at(newTarget(s.editor, part, 'Pattern').feature)).toEqual([
      'Body 1',
      'Body 2',
      'Body 3',
      'Body 4',
      'Body 5',
    ]);
    s.dispose();
  });
});

describe('a stored shell face knows its body from the worker, not from labels', { timeout: 60_000 }, () => {
  it('finds the body of a face to remove on a renamed body, and drops it with its last face', async () => {
    const d = new DocBuilder();
    const s0 = d.sketch('xy', (x) => x.rect(0, 0, 20, 20));
    d.extrude({ sketch: s0.feature, profiles: [s0.region([1, 1])], sides: [{ distance: '20 mm' }] });
    const built = service.evaluate(d.document());
    const bodyKey = built.definitions[0]!.bodies[0]!.key;
    const faces = built.entities.filter((e) => e.kind === 'face');
    const top = faces.find(
      (e) => Math.abs((service.properties(e.key)!.measures.centroid as number[])[2]! - 20) < 1e-6,
    )!;
    const [bodyPick, topPick] = [
      service.pick({ key: bodyKey }) as PickedEntity,
      service.pick({ key: top.key }) as PickedEntity,
    ];
    const shell = d.feature('core.shell', {
      bodies: makeSet([bodyPick.reference]),
      remove: makeSet([topPick.reference]),
      thickness: d.val('2 mm'),
      direction: d.val('"inside"'),
    });
    const doc = d.document();
    Object.assign(doc.names as Json, bodyPick.names, topPick.names);
    const s = await boot(doc);
    // The body is renamed: its label no longer says which faces lie on it.
    expect(
      setName(
        s.editor,
        d.partId,
        { reference: bodyPick.reference as unknown as Json, names: bodyPick.names as unknown as Json },
        'Lid',
      ).ok,
    ).toBe(true);
    await settled(s);

    const target = editTarget(s.editor.document, d.partId, shell, 'core.shell')!;
    const form = readShell(s.editor.document, d.partId, target.base!);
    s.scheduler.setBefore({ part: d.partId, feature: shell });
    await settled(s);
    const labelled = relabelled(form, await labelsOfStoredPicks(s, target, form));
    expect(labelled.bodies.map((b) => b.label)).toEqual(['Lid']);
    expect(labelled.faces.map((f) => f.label)).toEqual(['Face of Lid']);

    const owners = await shellOwnersBefore(s, target, labelled.faces);
    expect(owners).toHaveLength(1);
    // A label that names another body changes nothing: the owner is the worker's.
    const faces2 = [{ ...labelled.faces[0]!, label: 'Face of Body 7' }];
    const withOwners = { ...labelled, faces: faces2, owners };
    expect(shellBodyOf(withOwners, faces2[0]!)).toBe(labelled.bodies[0]);
    expect(withShellFaces(withOwners, [])).toEqual({ faces: [], bodies: [], owners: [] });
    s.dispose();
  });
});
