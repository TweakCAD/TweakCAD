import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Editor, seededIds, type Doc, type Json } from '@tweakcad/editor';
import { standardDocument } from '../../../lib/editor/src/testDocs';
import { editTarget, ValueSlots, type PickedRef } from './feature';
import { buildHole, clickEdge, clickFace, newHoleForm, readHole, removeFace, type HoleForm } from './hole';

const face = (id: string): PickedRef => ({ reference: { entity: { id: id ? [id] : [] } }, names: {}, label: 'Face' });
const at = (id: string, x: string, y: string) => ({ id, x, y });

function formOn(picked: PickedRef | null): HoleForm {
  return { ...newHoleForm(), face: picked, positions: [at('hp_a', '0', '0')] };
}

describe('clickFace', () => {
  it('adds a position on the hole face', () => {
    expect(clickFace(formOn(face('top')), face('top'), at('hp_b', '5', '5'), false)).toEqual({
      positions: [at('hp_a', '0', '0'), at('hp_b', '5', '5')],
    });
  });

  it('moves the hole to another face, at the click', () => {
    expect(clickFace(formOn(face('top')), face('side'), at('hp_b', '5', '5'), false)).toEqual({
      face: face('side'),
      keptPlacement: undefined,
      positions: [at('hp_b', '5', '5')],
    });
  });

  it('keeps the positions when a lost face is picked again', () => {
    const form = formOn(face(''));
    const patch = clickFace(form, face('top'), at('hp_b', '60', '0'), true);
    expect(patch).toEqual({ face: face('top'), keptPlacement: undefined });
    expect({ ...form, ...patch }.positions).toEqual([at('hp_a', '0', '0')]);
  });

  it('takes the click when a lost face had no positions', () => {
    const form = { ...formOn(face('')), positions: [] };
    expect(clickFace(form, face('top'), at('hp_b', '60', '0'), true).positions).toEqual([at('hp_b', '60', '0')]);
  });

  it('keeps the positions with the face taken off, and the face picked next takes them', () => {
    const form = { ...formOn(face('top')), keptPlacement: { frame: {} } };
    const removed = { ...form, ...removeFace() };
    expect(removed.face).toBeNull();
    expect(removed.keptPlacement).toBeUndefined();
    expect(removed.positions).toEqual([at('hp_a', '0', '0')]);
    expect(clickFace(removed, face('top'), at('hp_b', '9', '9'), false)).toEqual({
      face: face('top'),
      keptPlacement: undefined,
    });
  });

  it('takes the click when the face taken off had no positions', () => {
    const removed = { ...formOn(face('top')), positions: [], ...removeFace() };
    expect(clickFace(removed, face('top'), at('hp_b', '1', '2'), false).positions).toEqual([at('hp_b', '1', '2')]);
  });

  it('takes the click on a first pick', () => {
    expect(clickFace({ ...newHoleForm() }, face('top'), at('hp_b', '1', '2'), false)).toEqual({
      face: face('top'),
      keptPlacement: undefined,
      positions: [at('hp_b', '1', '2')],
    });
  });
});

describe('a position measured from edges', () => {
  const edge = (id: string): PickedRef => ({
    reference: { entity: { id: [id] } },
    names: { [id]: { kind: 'edge' } },
    label: `Edge ${id}`,
  });

  it('takes up to two edges a click at a time, and drops one clicked again', () => {
    const p = at('hp_a', '30', '20');
    const one = clickEdge(p, edge('left'), '30');
    expect(one.from).toEqual([{ edge: edge('left'), distance: '30' }]);
    const two = clickEdge(one, edge('front'), '20');
    expect(two.from?.map((f) => f.distance)).toEqual(['30', '20']);
    expect(clickEdge(two, edge('right'), '5')).toBe(two);
    expect(clickEdge(two, edge('left'), '').from).toEqual([{ edge: edge('front'), distance: '20' }]);
    expect(clickEdge(one, edge('left'), '')).toEqual(p);
  });

  it('writes its edges and distances, with their names, and reads them back', () => {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const target = { part: ids.part, feature: editor.newId('feat'), name: 'Hole 1' };
    const form: HoleForm = {
      ...formOn(face('top')),
      positions: [
        {
          ...at('hp_a', '30', '20'),
          from: [
            { edge: edge('left'), distance: '10' },
            { edge: edge('front'), distance: '15 mm' },
          ],
        },
      ],
    };
    const built = buildHole(editor.document, target, form, new ValueSlots(() => editor.newId('val')));
    if (!built.ok) throw new Error(built.message);
    const row = (built.inputs.positions as Json[])[0] as Json;
    expect((row.from as Json[]).map((f) => f.edge)).toEqual([edge('left').reference, edge('front').reference]);
    expect(built.names).toMatchObject({ left: { kind: 'edge' }, front: { kind: 'edge' } });
    const read = readHole(editor.document, ids.part, built.inputs);
    expect(read?.positions[0]?.from?.map((f) => [f.edge.reference, f.distance])).toEqual([
      [edge('left').reference, '10'],
      [edge('front').reference, '15'],
    ]);
    expect(read?.positions[0]).toMatchObject({ x: '30', y: '20' });
    const plain = buildHole(editor.document, target, formOn(face('top')), new ValueSlots(() => editor.newId('val')));
    if (!plain.ok) throw new Error(plain.message);
    expect((plain.inputs.positions as Json[])[0]).not.toHaveProperty('from');
  });

  it('refuses a negative distance', () => {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const target = { part: ids.part, feature: editor.newId('feat'), name: 'Hole 1' };
    const form: HoleForm = {
      ...formOn(face('top')),
      positions: [{ ...at('hp_a', '30', '20'), from: [{ edge: edge('left'), distance: '-1' }] }],
    };
    expect(buildHole(editor.document, target, form, new ValueSlots(() => editor.newId('val')))).toMatchObject({
      ok: false,
      message: 'Distance must not be negative',
    });
  });
});

describe('a tapped hole', () => {
  it('keeps whether its thread is modelled', () => {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const target = { part: ids.part, feature: editor.newId('feat'), name: 'Hole 1' };
    const form = { ...formOn(face('top')), threaded: true, designation: 'M6', threadClass: '6H' };
    for (const modelled of [true, false]) {
      const built = buildHole(
        editor.document,
        target,
        { ...form, modelled },
        new ValueSlots(() => editor.newId('val')),
      );
      if (!built.ok) throw new Error(built.message);
      expect(readHole(editor.document, ids.part, built.inputs)?.modelled).toBe(modelled);
    }
  });

  it('writes a hand for a left-handed thread only, and reads it back', () => {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const target = { part: ids.part, feature: editor.newId('feat'), name: 'Hole 1' };
    const form = { ...formOn(face('top')), threaded: true, designation: 'M8x1', threadClass: '6H' };
    const slots = () => new ValueSlots(() => editor.newId('val'));
    const right = buildHole(editor.document, target, form, slots());
    if (!right.ok) throw new Error(right.message);
    expect(((right.inputs.thread as Json).thread as Json).hand).toBeUndefined();
    const left = buildHole(editor.document, target, { ...form, hand: 'left' }, slots());
    if (!left.ok) throw new Error(left.message);
    expect(readHole(editor.document, ids.part, left.inputs)).toMatchObject({ hand: 'left', designation: 'M8x1' });
    // A thread that had a hand keeps one when it turns right-handed.
    const back = buildHole(
      editor.document,
      { ...target, base: left.inputs },
      form,
      new ValueSlots(() => editor.newId('val'), left.inputs, editor.document),
    );
    if (!back.ok) throw new Error(back.message);
    expect(readHole(editor.document, ids.part, back.inputs)?.hand).toBe('right');
    expect(((back.inputs.thread as Json).thread as Json).hand).toBeDefined();
  });
});

describe('hole checks', () => {
  const build = (patch: Partial<HoleForm>) => {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const target = { part: ids.part, feature: editor.newId('feat'), name: 'Hole 1' };
    return buildHole(
      editor.document,
      target,
      { ...formOn(face('top')), ...patch },
      new ValueSlots(() => editor.newId('val')),
    );
  };

  it('wants a counterbore and a countersink wider than the hole', () => {
    expect(build({ kind: 'counterbore', diameter: '10', counterboreDiameter: '8' })).toMatchObject({
      ok: false,
      message: 'Counterbore diameter must exceed hole diameter',
    });
    expect(build({ kind: 'counterbore', diameter: '5', counterboreDiameter: '8' }).ok).toBe(true);
    expect(build({ kind: 'countersink', diameter: '10', countersinkDiameter: '10' })).toMatchObject({
      ok: false,
      message: 'Countersink diameter must exceed hole diameter',
    });
    expect(build({ kind: 'countersink', diameter: '5', countersinkDiameter: '10' }).ok).toBe(true);
  });

  it('wants a countersink angle under 180 degrees', () => {
    expect(build({ kind: 'countersink', countersinkAngle: '180' })).toMatchObject({
      ok: false,
      message: 'Countersink angle must be in (0, 180) degrees',
    });
  });
});

describe('editing a hole', () => {
  it('keeps referenced positions as they are, and splits plain vectors into x and y', () => {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const linked = {
      of: {
        ref: {
          inContext: { context: { id: 'ctx_1' }, instance: { instance: 'inst_1' }, ref: { entity: { id: ['e'] } } },
        },
      },
    };
    const value = (text: string) => ({ id: editor.newId('val'), def: { expr: { text, grammar: 1, refs: {} } } });
    const inputs = {
      placement: { face: face('top').reference },
      positions: [
        { id: 'hp_a', at: linked },
        { id: 'hp_b', at: { at: { v: value('vector(3 mm, 4 mm, 0 mm)') } } },
        { id: 'hp_c', at: { at: { v: value('vector(1 mm, 2 mm, 5 mm)') } } },
      ],
      kind: value('"simple"'),
      diameter: value('5 mm'),
      depth: { throughAll: {} },
      tip: { flat: {} },
      thread: { none: {} },
    };
    const form = readHole(editor.document, ids.part, inputs as never);
    if (!form) throw new Error('not read');
    expect(form.positions.map((p) => [p.x, p.y, p.kept !== undefined])).toEqual([
      ['', '', true],
      ['3', '4', false],
      ['', '', true],
    ]);
    const target = { part: ids.part, feature: ids.extrude, base: inputs as never };
    const built = buildHole(editor.document, target, form, new ValueSlots(() => editor.newId('val'), inputs as never));
    if (!built.ok) throw new Error(built.message);
    const positions = built.inputs.positions as { id: string; at: unknown }[];
    expect(positions[0]).toEqual({ id: 'hp_a', at: linked });
    expect(positions[2]).toEqual(inputs.positions[2]);
    expect(positions[1]).toMatchObject({
      id: 'hp_b',
      at: { at: { v: { def: { expr: { text: 'vector(3 mm, 4 mm, 0 mm)' } } } } },
    });
  });
});

describe('a tapped hole sized by a parameter', () => {
  const fixtures = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../lib/testing/fixtures/v2');
  /** The fixture nut, its Size configuration set to `size`, and its Hole 1. */
  function nut(size = 'M6') {
    const doc = JSON.parse(readFileSync(resolvePath(fixtures, 'hex-nut-iso4032.cadjson'), 'utf8')) as Doc;
    const part = (doc.parts as Json[])[0] as Json;
    for (const table of part.parameters as Json[]) {
      for (const p of table.parameters as Json[])
        if (p.name === 'Size') ((p.value as Json).def as Json).expr = { grammar: 1, refs: {}, text: `"${size}"` };
    }
    const hole = (part.timeline as Json[]).find((f) => f.name === 'Hole 1') as Json;
    const target = editTarget(doc, part.id as string, hole.id as string, 'core.hole');
    if (!target) throw new Error('no hole');
    return { doc, part: part.id as string, target, stored: hole.inputs as Json };
  }
  const slots = (base: Json, doc: Doc) => {
    let n = 0;
    return new ValueSlots(() => `val_new${n++}`, base, doc);
  };
  const thread = (inputs: Json) => (inputs.thread as Json).thread as Json;

  it('reads the size its parameter gives under the configuration, and the binding', () => {
    const { doc, part, stored } = nut();
    const form = readHole(doc, part, stored);
    expect(form).toMatchObject({
      threaded: true,
      designation: 'M6',
      threadClass: '6H',
      kind: 'simple',
      modelled: false,
    });
    const values = slots(stored, doc);
    expect(values.boundText(['thread', 'thread', 'designation'], 'M6')).toBe('thread');
    expect(values.boundText(['thread', 'thread', 'designation'], 'M8')).toBeNull();
    expect(values.boundText(['thread', 'thread', 'class'], '6H')).toBeNull();
    const m10 = nut('M10');
    expect(readHole(m10.doc, m10.part, m10.stored)?.designation).toBe('M10');
  });

  it('keeps the binding when the size is left alone', () => {
    const { doc, part, target, stored } = nut();
    const form = readHole(doc, part, stored)!;
    const built = buildHole(doc, target, form, slots(stored, doc));
    if (!built.ok) throw new Error(built.message);
    expect(thread(built.inputs).designation).toEqual(thread(stored).designation);
  });

  it('writes a literal once another size is picked, under the same value id', () => {
    const { doc, part, target, stored } = nut();
    const form = readHole(doc, part, stored)!;
    const id = (thread(stored).designation as Json).id;
    const built = buildHole(doc, target, { ...form, designation: 'M8' }, slots(stored, doc));
    if (!built.ok) throw new Error(built.message);
    expect(thread(built.inputs).designation).toEqual({ id, def: { expr: { text: '"M8"', grammar: 1, refs: {} } } });
  });

  it('reads and keeps a bound kind and modelled flag', () => {
    const { doc, part, target, stored } = nut();
    // Edited in place: the panel reads a feature of the document.
    const inputs = stored;
    const table = (((doc.parts as Json[])[0] as Json).parameters as Json[])[0] as Json;
    table.parameters = [
      ...(table.parameters as Json[]),
      {
        id: 'par_flag',
        name: 'f',
        type: 'boolean',
        public: true,
        published: false,
        description: '',
        range: { unbounded: {} },
        value: { id: 'val_flag', def: { expr: { grammar: 1, refs: {}, text: 'true' } } },
      },
    ];
    (inputs.kind as Json).def = {
      expr: { grammar: 1, refs: { f: { parameter: { id: 'par_flag' } } }, text: 'f ? "counterbore" : "simple"' },
    };
    (thread(inputs).modelled as Json).def = {
      expr: { grammar: 1, refs: { f: { parameter: { id: 'par_flag' } } }, text: 'f' },
    };
    const form = readHole(doc, part, inputs)!;
    expect(form).toMatchObject({ kind: 'counterbore', modelled: true });
    const values = slots(inputs, doc);
    expect(values.boundText(['kind'], form.kind)).toBe('f ? "counterbore" : "simple"');
    expect(values.boundText(['thread', 'thread', 'modelled'], form.modelled)).toBe('f');
    const edited = { ...target, base: inputs };
    const built = buildHole(doc, edited, { ...form, counterboreDiameter: '8' }, slots(inputs, doc));
    if (!built.ok) throw new Error(built.message);
    expect(built.inputs.kind).toEqual(inputs.kind);
    expect(thread(built.inputs).modelled).toEqual(thread(inputs).modelled);
    const unticked = buildHole(doc, edited, { ...form, counterboreDiameter: '8', modelled: false }, slots(inputs, doc));
    if (!unticked.ok) throw new Error(unticked.message);
    expect(((thread(unticked.inputs).modelled as Json).def as Json).expr).toEqual({
      text: 'false',
      grammar: 1,
      refs: {},
    });
  });
});
