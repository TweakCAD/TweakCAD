import { describe, expect, it } from 'vitest';
import { ValueEvaluator, readDocument } from '@tweakcad/format';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { standardDocument } from '../../../lib/editor/src/testDocs';
import { findFeature } from '../features';
import { featureRow } from './common';
import {
  buildConstruction,
  clickedSupport,
  MODES,
  newConstructionForm,
  offsetDirection,
  readConstruction,
  SUPPORTS,
  turnOf,
  withMode,
} from './construction';
import { ValueSlots, writeFeature } from './feature';

describe('construction forms', () => {
  it('start an offset plane 10 mm off its base, and the other modes and kinds on what they attach to', () => {
    expect(newConstructionForm('plane')).toMatchObject({ mode: 'plane', offset: '10' });
    expect(newConstructionForm('axis').offset).toBe('0');
    expect(newConstructionForm('frame').offset).toBe('0');
    expect(withMode(newConstructionForm('plane'), 'threePoints').offset).toBe('0');
    expect(withMode(withMode(newConstructionForm('plane'), 'threePoints'), 'plane').offset).toBe('10');
    expect(withMode({ ...newConstructionForm('plane'), offset: '4' }, 'threePoints').offset).toBe('4');
  });

  it('drag the offset along the normal of the base, whatever the turn and the flip', () => {
    const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, 9));
    // On XY: y is +Y, the normal +Z.
    close(offsetDirection({ y: [0, 1, 0], normal: [0, 0, 1] }, 0, false), [0, 0, 1]);
    // Flipped, the shown frame's y and normal point the other way; the offset still runs along +Z.
    close(offsetDirection({ y: [0, -1, 0], normal: [0, 0, -1] }, 0, true), [0, 0, 1]);
    // Turned 90 degrees about x: the shown y is the base normal.
    close(offsetDirection({ y: [0, 0, 1], normal: [0, -1, 0] }, 90, false), [0, 0, 1]);
  });
});

describe('the offset of a plane on a face', () => {
  /** A plane on the XY plane whose offset is `text`, as a document holds it. */
  function planeWith(text: string) {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const value = (t: string) => ({ id: editor.newId('val'), def: { expr: { text: t, grammar: 1, refs: {} } } });
    const feature = editor.newId('feat');
    const inputs = {
      frame: {
        attach: {
          support: [{ standard: { name: 'xy' } }],
          mode: value('"plane"'),
          offset: value(text),
          flip: value('false'),
        },
      },
    };
    const added = editor.dispatch({
      type: 'addFeature',
      container: ids.part,
      feature: featureRow(editor, feature, 'core.constructionPlane', 'Plane 1', inputs),
      names: {},
    });
    if (!added.ok) throw new Error(added.error.message);
    const base = (findFeature(editor.document, feature) as Json).inputs as Json;
    return { editor, ids, feature, base };
  }
  /** What a placement text comes to: its position and its rotation as a quaternion in canonical sign. */
  function placed(doc: Json, text: string): { position: number[]; rotation: number[] } {
    return new ValueEvaluator(doc).evaluateDefinition(
      { expr: { text, grammar: 1, refs: {} } },
      'the offset',
    ) as unknown as { position: number[]; rotation: number[] };
  }

  it('reads the shift, the offset and a turn about the normal back into fields, and writes the same placement', () => {
    const stored = 'placement(vector(0 mm, -13.5 mm, 0 mm), rotate(vector(0, 0, -1), 90 deg))';
    const { editor, ids, feature, base } = planeWith(stored);
    const form = readConstruction('plane')(editor.document, ids.part, base);
    if (!form) throw new Error('not read');
    expect(form.kept).toBeUndefined();
    expect(form).toMatchObject({ mode: 'plane', offset: '0', shiftX: '0', shiftY: '-13.5', angle: '-90', about: 'z' });
    const target = { part: ids.part, feature, base };
    const built = buildConstruction(
      editor.document,
      target,
      form,
      new ValueSlots(() => editor.newId('val'), base, editor.document),
    );
    if (!built.ok) throw new Error(built.message);
    const text = ((((built.inputs.frame as Json).attach as Json).offset as Json).def as Json).expr as Json;
    const [a, b] = [placed(editor.document, stored), placed(editor.document, text.text as string)];
    a.position.forEach((x, i) => expect(b.position[i]).toBeCloseTo(x, 9));
    a.rotation.forEach((x, i) => expect(b.rotation[i]).toBeCloseTo(x, 9));

    // The fields write what they hold.
    const moved = buildConstruction(
      editor.document,
      target,
      { ...form, shiftX: '2', about: 'y', angle: '30' },
      new ValueSlots(() => editor.newId('val'), base, editor.document),
    );
    if (!moved.ok) throw new Error(moved.message);
    expect(((((moved.inputs.frame as Json).attach as Json).offset as Json).def as Json).expr).toMatchObject({
      text: 'placement(vector(2 mm, -13.5 mm, 0 mm), rotate(vector(0, 1, 0), 30 deg))',
    });
  });

  it('keeps a turn about another axis as it is', () => {
    const { editor, ids, base } = planeWith('placement(vector(0 mm, 0 mm, 5 mm), rotate(vector(1, 1, 0), 30 deg))');
    expect(readConstruction('plane')(editor.document, ids.part, base)?.kept?.offset).toBeDefined();
  });

  it('reads turns about each axis, with the sign of the axis in the angle', () => {
    expect(turnOf(['1', '0', '0'], '15')).toEqual({ about: 'x', angle: '15' });
    expect(turnOf(['0', '-1', '0'], '15')).toEqual({ about: 'y', angle: '-15' });
    expect(turnOf(['0', '0', '-2'], 'a')).toEqual({ about: 'z', angle: '-(a)' });
    expect(turnOf(['0', '0', '1'], '0')).toEqual({ about: 'x', angle: '0' });
    expect(turnOf(['1', '1', '0'], '10')).toBeNull();
  });

  it('drags the offset along the base normal whatever the turn axis', () => {
    const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, 9));
    // Turned 90 degrees about y: the base normal is -x of the turned frame.
    close(offsetDirection({ x: [0, 0, -1], y: [0, 1, 0], normal: [1, 0, 0] }, 90, false, 'y'), [0, 0, 1]);
    // Turned within the plane: the normal stays.
    close(offsetDirection({ x: [0, 1, 0], y: [-1, 0, 0], normal: [0, 0, 1] }, 90, false, 'z'), [0, 0, 1]);
    close(offsetDirection({ x: [0, 1, 0], y: [1, 0, 0], normal: [0, 0, -1] }, 90, true, 'z'), [0, 0, 1]);
  });
});

describe('the new construction types', () => {
  it('offer Midplane for a plane, Through cylinder for an axis and At center for a point, each with its supports', () => {
    expect(MODES.plane).toContain('midplane');
    expect(MODES.axis).toContain('faceAxis');
    expect(MODES.point).toContain('center');
    expect(SUPPORTS.midplane).toEqual(['plane', 'plane']);
    expect(withMode(newConstructionForm('axis'), 'faceAxis').supports).toEqual([null]);
  });

  it('write the attachment mode the format reads', () => {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const target = { part: ids.part, feature: editor.newId('feat'), name: 'Plane 2' };
    const form = {
      ...withMode(newConstructionForm('plane'), 'midplane'),
      supports: [
        { reference: { standard: { name: 'xy' } }, names: {}, label: 'XY plane' },
        { reference: { standard: { name: 'xy' } }, names: {}, label: 'XY plane' },
      ],
    };
    const built = buildConstruction(editor.document, target, form, new ValueSlots(() => editor.newId('val')));
    if (!built.ok) throw new Error(built.message);
    expect(((built.inputs.frame as Json).attach as Json).mode).toMatchObject({ def: { expr: { text: '"midplane"' } } });
    expect(writeFeature(editor, target, 'core.constructionPlane', built, 'Plane').ok).toBe(true);
    expect(readDocument(editor.document).refused).toBe(false);
    expect(
      readConstruction('plane')(
        editor.document,
        ids.part,
        (findFeature(editor.document, target.feature) as Json).inputs as Json,
      )?.mode,
    ).toBe('midplane');
  });
});

describe('a click on a support', () => {
  const same = (a: string, b: string) => a === b;
  it('fills the armed slot and arms the next empty one', () => {
    expect(clickedSupport<string>([null, null], 0, 'a', same)).toEqual({ supports: ['a', null], armed: 1 });
    expect(clickedSupport(['a', null], 1, 'b', same)).toEqual({ supports: ['a', 'b'], armed: 1 });
  });

  it('drops a support clicked again, and arms its slot', () => {
    expect(clickedSupport(['a', 'b'], 1, 'a', same)).toEqual({ supports: [null, 'b'], armed: 0 });
    expect(clickedSupport(['a'], 0, 'a', same)).toEqual({ supports: [null], armed: 0 });
  });
});
