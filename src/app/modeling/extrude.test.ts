import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { standardDocument } from '../../../lib/editor/src/testDocs';
import { featureHidden, setVisible } from '../attributes';
import { findFeature } from '../features';
import { regionReference } from '../picking';
import { featureBefore, insertionPoint, nextFeatureName } from './common';
import {
  buildExtrude,
  candidateDocument,
  readExtrude,
  ValueSlots,
  writeExtrude,
  type ExtrudeForm,
  type ExtrudeProfile,
  type ExtrudeTarget,
} from './extrude';
import { addSketch } from './sketch';
import { distanceArrow } from './extrudeArrow';

function setup() {
  const { doc, ids } = standardDocument();
  const editor = new Editor(doc, { ids: seededIds(5) });
  const sketch = findFeature(editor.document, ids.sketch) as Json;
  const row = (((sketch.inputs as Json).regions as Json[])[0] as Json).id as string;
  return { editor, ids, row };
}

const FORM: ExtrudeForm = { extent: 'distance', distance: '10', reversed: false, operation: 'join', face: null };

function newTarget(editor: Editor, part: string): ExtrudeTarget {
  return { part, feature: editor.newId('feat'), name: nextFeatureName(editor.document, part, 'Extrude') };
}

const at = (o: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((v, k) => (v as Record<string | number, unknown> | undefined)?.[k], o);

describe('extrude inputs', () => {
  it('writes each extent as appendix A has it, binding values in scope, with bare numbers in millimetres', () => {
    const { editor, ids, row } = setup();
    const profiles: ExtrudeProfile[] = [{ sketch: ids.sketch, row }];
    const target = newTarget(editor, ids.part);
    const values = new ValueSlots(() => editor.newId('val'));
    const build = (form: Partial<ExtrudeForm>) =>
      buildExtrude(editor.document, target, { ...FORM, ...form }, profiles, values);

    const distance = build({ distance: '10' });
    if (!distance.ok) throw new Error(distance.message);
    expect(at(distance.inputs, 'sides', 0, 'extent', 'distance', 'd', 'def', 'expr', 'text')).toBe('10 mm');
    expect(at(distance.inputs, 'direction')).toMatchObject({
      normal: { ref: { object: { feature: { id: ids.sketch } } }, reversed: { def: { expr: { text: 'false' } } } },
    });
    expect(at(distance.inputs, 'profiles', 'set', 0)).toEqual(regionReference(ids.sketch, row).reference);

    // Named values of earlier features are in scope: `depth` belongs to the first extrude.
    const named = build({ distance: 'depth + 1 mm', reversed: true });
    expect(named.ok && at(named.inputs, 'sides', 0, 'extent', 'distance', 'd', 'def', 'expr', 'refs')).toEqual({
      depth: { value: { id: ids.depth } },
    });
    expect(named.ok && at(named.inputs, 'direction', 'normal', 'reversed', 'def', 'expr', 'text')).toBe('true');

    const symmetric = build({ sides: 'symmetric', distance: '8' });
    expect(
      symmetric.ok && at(symmetric.inputs, 'sides', 0, 'extent', 'symmetric', 'measure', 'def', 'expr', 'text'),
    ).toBe('"total"');
    const half = build({ sides: 'symmetric', distance: '8', measure: 'half' });
    expect(half.ok && at(half.inputs, 'sides', 0, 'extent', 'symmetric', 'measure', 'def', 'expr', 'text')).toBe(
      '"half"',
    );
    const two = build({ sides: 'two', distance: '8', side2: { extent: 'distance', distance: '-3', face: null } });
    expect(two.ok && (at(two.inputs, 'sides') as Json[]).length).toBe(2);
    // Each side has its own extent.
    const mixed = build({
      sides: 'two',
      distance: '8',
      side2: { extent: 'throughAll', distance: '0', face: null, taper: '3' },
    });
    expect(mixed.ok && at(mixed.inputs, 'sides', 1)).toMatchObject({
      extent: { throughAll: {} },
      taper: { def: { expr: { text: '3 deg' } } },
    });
    const through = build({ extent: 'throughAll' });
    expect(through.ok && at(through.inputs, 'sides', 0, 'extent')).toEqual({ throughAll: {} });
    const plane = build({
      extent: 'toFace',
      face: { reference: { standard: { name: 'xz' } }, names: {}, label: 'XZ plane' },
    });
    expect(plane.ok && at(plane.inputs, 'sides', 0, 'extent', 'toFace', 'face')).toEqual({ standard: { name: 'xz' } });
    const past = build({
      extent: 'toFace',
      face: { reference: { standard: { name: 'xz' } }, names: {}, label: 'XZ plane' },
      offset: '2',
    });
    expect(past.ok && at(past.inputs, 'sides', 0, 'extent', 'toFace', 'offset', 'def', 'expr', 'text')).toBe('2 mm');
    for (const stop of ['upToNext', 'upToLast'] as const) {
      const built = build({ extent: stop });
      expect(built.ok && at(built.inputs, 'sides', 0, 'extent')).toEqual({ [stop]: {} });
    }
    const tapered = build({ taper: '-5' });
    expect(tapered.ok && at(tapered.inputs, 'sides', 0, 'taper', 'def', 'expr', 'text')).toBe('-5 deg');

    // The same place gets the same value id every time, so a preview and the commit agree.
    const again = build({ distance: '12' });
    expect(again.ok && at(again.inputs, 'sides', 0, 'extent', 'distance', 'd', 'id')).toBe(
      at(distance.inputs, 'sides', 0, 'extent', 'distance', 'd', 'id'),
    );
  });

  it('refuses what cannot be written, saying which field', () => {
    const { editor, ids, row } = setup();
    const target = newTarget(editor, ids.part);
    const values = new ValueSlots(() => editor.newId('val'));
    const profiles: ExtrudeProfile[] = [{ sketch: ids.sketch, row }];
    expect(buildExtrude(editor.document, target, FORM, [], values)).toMatchObject({ ok: false, field: 'profiles' });
    expect(buildExtrude(editor.document, target, { ...FORM, distance: '0' }, profiles, values)).toMatchObject({
      ok: false,
      field: 'distance',
    });
    expect(buildExtrude(editor.document, target, { ...FORM, distance: 'nowhere' }, profiles, values)).toMatchObject({
      ok: false,
      field: 'distance',
    });
    expect(
      buildExtrude(
        editor.document,
        target,
        { ...FORM, sides: 'two', distance: '5', side2: { extent: 'distance', distance: '-6', face: null } },
        profiles,
        values,
      ),
    ).toMatchObject({ ok: false, field: 'second' });
    expect(buildExtrude(editor.document, target, { ...FORM, extent: 'toFace' }, profiles, values)).toMatchObject({
      ok: false,
      field: 'face',
    });
    expect(
      buildExtrude(
        editor.document,
        target,
        { ...FORM, sides: 'two', side2: { extent: 'toFace', distance: '0', face: null } },
        profiles,
        values,
      ),
    ).toMatchObject({ ok: false, field: 'face2' });
    expect(buildExtrude(editor.document, target, { ...FORM, taper: 'steep' }, profiles, values)).toMatchObject({
      ok: false,
      field: 'taper',
    });
    expect(buildExtrude(editor.document, target, { ...FORM, taper: '90' }, profiles, values)).toMatchObject({
      ok: false,
      field: 'taper',
    });
    expect(
      buildExtrude(
        editor.document,
        target,
        {
          ...FORM,
          extent: 'toFace',
          face: { reference: { standard: { name: 'xz' } }, names: {}, label: 'XZ plane' },
          offset: 'far',
        },
        profiles,
        values,
      ),
    ).toMatchObject({ ok: false, field: 'offset' });
  });
});

describe('writing an extrude', () => {
  it('adds a new one at the rollback marker as one undo step, with a detected region row first', () => {
    const { editor, ids, row } = setup();
    expect(editor.dispatch({ type: 'setRollback', part: ids.part, before: ids.extrude2 }).ok).toBe(true);
    const sketch = findFeature(editor.document, ids.sketch) as Json;
    const region = ((sketch.inputs as Json).regions as Json[])[0] as Json;
    const fresh = editor.newId('reg');
    const profiles: ExtrudeProfile[] = [
      { sketch: ids.sketch, row: fresh, detected: { loop: region.loop as Json, holes: region.holes as Json } },
    ];
    const before = insertionPoint(editor.document, ids.part);
    expect(before).toBe(ids.extrude2);
    expect(featureBefore(editor.document, ids.part, before)).toBe(ids.extrude);
    const target = { ...newTarget(editor, ids.part), before: before as string };
    const built = buildExtrude(editor.document, target, FORM, profiles, new ValueSlots(() => editor.newId('val')));
    if (!built.ok) throw new Error(built.message);

    // The candidate holds the extrude; the editor does not.
    const text = editor.save();
    const candidate = candidateDocument(editor.document, target, built, profiles, (k) => editor.newId(k));
    expect(candidate.ok && findFeature(candidate.doc, target.feature)?.name).toBe('Extrude 3');
    expect(editor.save()).toBe(text);

    expect(writeExtrude(editor, target, built, profiles).ok).toBe(true);
    expect(editor.store.undoLabel()).toBe('Add Extrude 3');
    const timeline = ((editor.document.parts as Json[])[0] as Json).timeline as Json[];
    expect(timeline.map((f) => f.id)).toEqual([ids.sketch, ids.extrude, target.feature, ids.extrude2]);
    expect(
      (((findFeature(editor.document, ids.sketch) as Json).inputs as Json).regions as Json[]).map((r) => r.id),
    ).toContain(fresh);
    expect(readDocument(editor.document).refused).toBe(false);
    expect(editor.undo()).toBe(true);
    expect(editor.save()).toBe(text);
    expect(row).not.toBe(fresh);
  });

  it('reads an existing extrude back and edits it in place as one undo step, keeping its value ids and names', () => {
    const { editor, ids, row } = setup();
    const read = readExtrude(editor.document, ids.part, ids.extrude);
    if (!read) throw new Error('not read');
    expect(read.profiles).toEqual([{ sketch: ids.sketch, row }]);
    expect(read.form).toMatchObject({ extent: 'distance', distance: 'height', reversed: false, operation: 'new' });
    const target: ExtrudeTarget = { part: ids.part, feature: ids.extrude, base: read.inputs };
    const built = buildExtrude(
      editor.document,
      target,
      { ...read.form, distance: '15', operation: 'cut' },
      read.profiles,
      new ValueSlots(() => editor.newId('val'), read.inputs),
    );
    if (!built.ok) throw new Error(built.message);
    const d = at(built.inputs, 'sides', 0, 'extent', 'distance', 'd') as Json;
    expect(d).toMatchObject({ id: ids.depth, name: 'depth', def: { expr: { text: '15 mm' } } });
    expect(writeExtrude(editor, target, built, read.profiles).ok).toBe(true);
    expect(editor.store.undoLabel()).toBe('Edit Extrude');
    // The second extrude still reads `depth`.
    expect(readDocument(editor.document).refused).toBe(false);
    expect(readExtrude(editor.document, ids.part, ids.extrude)?.form).toMatchObject({
      distance: '15 mm',
      operation: 'cut',
    });
  });

  it("reads a side's taper back into its field, and writes what the field holds under the same value", () => {
    const { editor, ids } = setup();
    const taper = at(findFeature(editor.document, ids.extrude), 'inputs', 'sides', 0, 'taper') as Json;
    const tapered = { ...taper, def: { expr: { text: '-5 deg', grammar: 1, refs: {} } } };
    expect(
      editor.dispatch({ type: 'replaceInput', feature: ids.extrude, pointer: '/sides/0/taper', with: tapered }).ok,
    ).toBe(true);
    const read = readExtrude(editor.document, ids.part, ids.extrude);
    if (!read) throw new Error('not read');
    expect(read.form.taper).toBe('-5 deg');
    const target: ExtrudeTarget = { part: ids.part, feature: ids.extrude, base: read.inputs };
    const kept = buildExtrude(
      editor.document,
      target,
      read.form,
      read.profiles,
      new ValueSlots(() => editor.newId('val'), read.inputs),
    );
    expect(kept.ok && at(kept.inputs, 'sides', 0, 'taper')).toEqual(tapered);
    for (const sides of ['one', 'symmetric'] as const) {
      const built = buildExtrude(
        editor.document,
        target,
        { ...read.form, sides, taper: '7' },
        read.profiles,
        new ValueSlots(() => editor.newId('val'), read.inputs),
      );
      if (!built.ok) throw new Error(built.message);
      expect(at(built.inputs, 'sides', 0, 'taper')).toMatchObject({ id: taper.id, def: { expr: { text: '7 deg' } } });
    }
  });

  it('reads every stored extent back as the panel shows it, so OK writes the same sides', () => {
    const { editor, ids } = setup();
    const value = (text: string) => ({ id: editor.newId('val'), def: { expr: { text, grammar: 1, refs: {} } } });
    const cases: { sides: Json[]; form: Partial<ExtrudeForm> }[] = [
      { sides: [{ extent: { upToNext: {} }, taper: value('0 deg') }], form: { sides: 'one', extent: 'upToNext' } },
      {
        sides: [{ extent: { upToLast: {} }, taper: value('2 deg') }],
        form: { sides: 'one', extent: 'upToLast', taper: '2 deg' },
      },
      {
        sides: [
          { extent: { toFace: { face: { standard: { name: 'xz' } }, offset: value('3 mm') } }, taper: value('0 deg') },
        ],
        form: {
          extent: 'toFace',
          offset: '3 mm',
          face: { reference: { standard: { name: 'xz' } }, names: {}, label: 'XZ plane' },
        },
      },
      {
        sides: [{ extent: { symmetric: { d: value('8 mm'), measure: value('"half"') } }, taper: value('0 deg') }],
        form: { sides: 'symmetric', distance: '8 mm', measure: 'half' },
      },
      {
        sides: [
          { extent: { distance: { d: value('4 mm') } }, taper: value('0 deg') },
          { extent: { throughAll: {} }, taper: value('1 deg') },
        ],
        form: {
          sides: 'two',
          distance: '4 mm',
          side2: { extent: 'throughAll', distance: '10 mm', face: null, offset: '0 mm', taper: '1 deg' },
        },
      },
    ];
    for (const c of cases) {
      expect(
        editor.dispatch({ type: 'replaceInput', feature: ids.extrude2, pointer: '/sides', with: c.sides }).ok,
      ).toBe(true);
      const read = readExtrude(editor.document, ids.part, ids.extrude2);
      if (!read) throw new Error('not read');
      expect(read.form).toMatchObject(c.form);
      const target: ExtrudeTarget = { part: ids.part, feature: ids.extrude2, base: read.inputs };
      const built = buildExtrude(
        editor.document,
        target,
        read.form,
        read.profiles,
        new ValueSlots(() => editor.newId('val'), read.inputs),
      );
      if (!built.ok) throw new Error(built.message);
      expect(built.inputs.sides).toEqual(c.sides);
    }
  });
});

describe('the profile sketch on OK', () => {
  it('is hidden as a new extrude is added, in the same undo step, and left alone by an edit or when already hidden', () => {
    const { editor, ids, row } = setup();
    const profiles: ExtrudeProfile[] = [{ sketch: ids.sketch, row }];
    expect(featureHidden(editor.document, ids.part, ids.sketch)).toBe(false);
    const target = newTarget(editor, ids.part);
    const built = buildExtrude(editor.document, target, FORM, profiles, new ValueSlots(() => editor.newId('val')));
    if (!built.ok) throw new Error(built.message);
    expect(writeExtrude(editor, target, built, profiles).ok).toBe(true);
    expect(featureHidden(editor.document, ids.part, ids.sketch)).toBe(true);
    expect(readDocument(editor.document).refused).toBe(false);
    expect(editor.undo()).toBe(true);
    expect(featureHidden(editor.document, ids.part, ids.sketch)).toBe(false);
    expect(findFeature(editor.document, target.feature)).toBeUndefined();

    // Shown again by the user, an edit of the extrude keeps it shown.
    expect(writeExtrude(editor, target, built, profiles).ok).toBe(true);
    expect(setVisible(editor, ids.part, { feature: ids.sketch }, true).ok).toBe(true);
    const read = readExtrude(editor.document, ids.part, target.feature);
    if (!read) throw new Error('not read');
    const edit: ExtrudeTarget = { part: ids.part, feature: target.feature, base: read.inputs };
    const again = buildExtrude(
      editor.document,
      edit,
      { ...read.form, distance: '12' },
      read.profiles,
      new ValueSlots(() => editor.newId('val'), read.inputs),
    );
    if (!again.ok) throw new Error(again.message);
    expect(writeExtrude(editor, edit, again, read.profiles).ok).toBe(true);
    expect(featureHidden(editor.document, ids.part, ids.sketch)).toBe(false);

    // Already hidden, a new extrude writes no second attribute.
    expect(setVisible(editor, ids.part, { feature: ids.sketch }, false).ok).toBe(true);
    const attributes = () => (((editor.document.parts as Json[])[0] as Json).attributes as Json[]).length;
    const count = attributes();
    const third = newTarget(editor, ids.part);
    const built3 = buildExtrude(editor.document, third, FORM, profiles, new ValueSlots(() => editor.newId('val')));
    if (!built3.ok) throw new Error(built3.message);
    expect(writeExtrude(editor, third, built3, profiles).ok).toBe(true);
    expect(attributes()).toBe(count);
  });
});

describe('the extrude start', () => {
  it('writes no start on the sketch plane, an offset start, and a face start with its offset, and reads each back', () => {
    const { editor, ids, row } = setup();
    const profiles: ExtrudeProfile[] = [{ sketch: ids.sketch, row }];
    const target = newTarget(editor, ids.part);
    const values = new ValueSlots(() => editor.newId('val'));
    const build = (form: Partial<ExtrudeForm>) =>
      buildExtrude(editor.document, target, { ...FORM, ...form }, profiles, values);

    for (const startOffset of [undefined, '0', '0 mm']) {
      const plain = build({ startType: 'profile', ...(startOffset === undefined ? {} : { startOffset }) });
      expect(plain.ok && 'start' in plain.inputs).toBe(false);
    }
    const offset = build({ startType: 'offset', startOffset: '3' });
    expect(offset.ok && at(offset.inputs, 'start', 'offset', 'd', 'def', 'expr', 'text')).toBe('3 mm');
    const xz = { reference: { standard: { name: 'xz' } }, names: {}, label: 'XZ plane' };
    const face = build({ startType: 'face', startFace: xz, startOffset: '-1' });
    expect(face.ok && at(face.inputs, 'start', 'object', 'face')).toEqual({ standard: { name: 'xz' } });
    expect(face.ok && at(face.inputs, 'start', 'object', 'offset', 'def', 'expr', 'text')).toBe('-1 mm');
    expect(build({ startType: 'face' })).toMatchObject({ ok: false, field: 'startFace' });
    expect(build({ startOffset: 'nowhere' })).toMatchObject({ ok: false, field: 'startOffset' });

    if (!face.ok) throw new Error(face.message);
    expect(writeExtrude(editor, target, face, profiles).ok).toBe(true);
    expect(readDocument(editor.document).refused).toBe(false);
    const read = readExtrude(editor.document, ids.part, target.feature);
    expect(read?.form).toMatchObject({
      startType: 'face',
      startOffset: '-1 mm',
      startFace: { reference: { standard: { name: 'xz' } }, label: 'XZ plane' },
    });

    // Back on the sketch plane, the edit drops the start.
    if (!read) throw new Error('not read');
    const edit: ExtrudeTarget = { part: ids.part, feature: target.feature, base: read.inputs };
    const back = buildExtrude(
      editor.document,
      edit,
      { ...read.form, startType: 'profile', startOffset: '0' },
      read.profiles,
      new ValueSlots(() => editor.newId('val'), read.inputs),
    );
    expect(back.ok && 'start' in back.inputs).toBe(false);
  });
});

describe('adding a sketch', () => {
  it('attaches it to the picked plane, names it after the part sketches, in one undo step', () => {
    const { editor, ids } = setup();
    const added = addSketch(editor, ids.part, { reference: { standard: { name: 'yz' } }, names: {} });
    if (!added.ok) throw new Error(added.message);
    const row = findFeature(editor.document, added.feature) as Json;
    expect(row.name).toBe('Sketch 1');
    expect(at(row, 'inputs', 'frame', 'attach', 'support')).toEqual([{ standard: { name: 'yz' } }]);
    expect(at(row, 'inputs', 'frame', 'attach', 'mode', 'def', 'expr', 'text')).toBe('"plane"');
    expect(editor.store.undoLabel()).toBe('Add Sketch 1');
    expect(readDocument(editor.document).refused).toBe(false);
    expect(nextFeatureName(editor.document, ids.part, 'Sketch')).toBe('Sketch 2');
    editor.undo();
    expect(findFeature(editor.document, added.feature)).toBeUndefined();
  });
});

describe('the distance arrow', () => {
  it('stands at the end of the first side, over the profile centre, along the direction', () => {
    const loop = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]);
    const display = {
      parts: { p: 0 },
      definitions: [
        {
          sketches: [
            {
              feature: 's',
              frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] },
              regions: [{ key: 1, row: 'r', loops: [loop] }],
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof distanceArrow>[0];
    const profiles: ExtrudeProfile[] = [{ sketch: 's', row: 'r' }];
    expect(distanceArrow(display, 'p', { ...FORM, distance: '7' }, profiles)).toEqual({
      at: [5, 5, 7],
      direction: [0, 0, 1],
      distance: 7,
    });
    expect(
      distanceArrow(
        display,
        'p',
        { ...FORM, distance: '7', reversed: true, startType: 'offset', startOffset: '2' },
        profiles,
      )?.at,
    ).toEqual([5, 5, -9]);
    expect(distanceArrow(display, 'p', { ...FORM, extent: 'throughAll' }, profiles)).toBeNull();
    expect(distanceArrow(display, 'p', { ...FORM, distance: 'depth' }, profiles)).toBeNull();
  });
});
