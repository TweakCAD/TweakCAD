import { describe, expect, it } from 'vitest';
import { Editor, seededIds } from '@tweakcad/editor';
import { standardDocument } from '../../../lib/editor/src/testDocs';
import { ValueSlots } from './feature';
import {
  buildPrimitive,
  isStanding,
  newPrimitiveForm,
  readPrimitive,
  SHAPE_FIELDS,
  standingZ,
  withDims,
  withShape,
  type PrimitiveShape,
} from './primitive';

function build(shape: PrimitiveShape, dims: Record<string, string>) {
  const { doc, ids } = standardDocument();
  const editor = new Editor(doc, { ids: seededIds(5) });
  const target = { part: ids.part, feature: editor.newId('feat'), name: 'Primitive 1' };
  const form = newPrimitiveForm(shape);
  return buildPrimitive(
    editor.document,
    target,
    { ...form, dims: { ...form.dims, ...dims } },
    new ValueSlots(() => editor.newId('val')),
  );
}

describe('primitive checks', () => {
  it('wants a cone with at least one radius', () => {
    expect(build('cone', { bottomRadius: '0', topRadius: '0' })).toMatchObject({
      ok: false,
      message: 'A cone needs at least one non-zero radius',
    });
    expect(build('cone', { bottomRadius: '0', topRadius: '4' }).ok).toBe(true);
  });

  it('wants a torus tube thinner than its ring', () => {
    expect(build('torus', { majorRadius: '5', minorRadius: '5' })).toMatchObject({
      ok: false,
      message: 'Tube radius must be smaller than ring radius',
    });
    expect(build('torus', { majorRadius: '20', minorRadius: '5' }).ok).toBe(true);
    expect(SHAPE_FIELDS.torus.map((f) => f.label)).toEqual(['Ring R', 'Tube R']);
  });
});

describe('a new primitive', () => {
  it('is a new body standing on the XY plane where it has a height, centred on it otherwise', () => {
    expect(newPrimitiveForm('box')).toMatchObject({ operation: 'new', z: '10', plane: { label: 'XY plane' } });
    expect(newPrimitiveForm('cylinder').z).toBe('10');
    expect(newPrimitiveForm('sphere').z).toBe('0');
  });

  it('stands on a picked plane, attached to it, and reads back on it', () => {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const target = { part: ids.part, feature: editor.newId('feat'), name: 'Primitive 1' };
    const plane = { reference: { standard: { name: 'yz' } }, names: {}, label: 'YZ plane' };
    const built = buildPrimitive(
      editor.document,
      target,
      { ...newPrimitiveForm('box'), plane, x: '5' },
      new ValueSlots(() => editor.newId('val')),
    );
    if (!built.ok) throw new Error(built.message);
    expect((built.inputs.frame as { attach?: { support: unknown[] } }).attach?.support).toEqual([plane.reference]);
    const read = readPrimitive(editor.document, ids.part, built.inputs);
    expect(read).toMatchObject({ plane: { reference: plane.reference, label: 'YZ plane' }, x: '5', z: '10' });
    expect(read?.keptFrame).toBeUndefined();
  });
});

describe('standing on the plane', () => {
  it('keeps a primitive on its plane when its height changes', () => {
    const box = newPrimitiveForm('box');
    expect(withDims(box, { ...box.dims, height: '50' })).toMatchObject({ z: '25' });
    expect(withDims(box, { ...box.dims, height: 'h' })).toMatchObject({ z: '(h) / 2' });
    expect(isStanding({ ...box, dims: { ...box.dims, height: 'h' }, z: '(h) / 2' })).toBe(true);
  });

  it('leaves a centre that was moved off the plane where it is', () => {
    const raised = { ...newPrimitiveForm('cylinder'), z: '30' };
    expect(withDims(raised, { ...raised.dims, height: '50' })).toMatchObject({ z: '30' });
  });

  it('stands as the new shape does when the shape changes', () => {
    const box = newPrimitiveForm('box');
    expect(withShape(box, 'sphere')).toMatchObject({ shape: 'sphere', z: '0' });
    expect(withShape({ ...box, shape: 'sphere', z: '0' }, 'cone')).toMatchObject({ z: '10' });
    expect(standingZ('torus', box.dims)).toBe('0');
  });

  it('writes nothing while the base is still to be drawn', () => {
    expect(build('box', {}).ok).toBe(true);
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const target = { part: ids.part, feature: editor.newId('feat'), name: 'Box 1' };
    expect(
      buildPrimitive(
        editor.document,
        target,
        { ...newPrimitiveForm('box'), drawing: true },
        new ValueSlots(() => editor.newId('val')),
      ),
    ).toMatchObject({ ok: false, quiet: true });
  });
});
