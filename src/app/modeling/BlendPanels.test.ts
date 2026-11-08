import { describe, expect, it } from 'vitest';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { standardDocument } from '../../../lib/editor/src/testDocs';
import { tangentChainSetting } from './BlendPanels';
import { BLEND_SIZE, buildChamfer, flipChamfer, newChamferForm, newFilletForm, readChamfer } from './blends';
import {
  buildShell,
  newShellForm,
  readShell,
  shellBodyOf,
  toggledShellBody,
  withShellFaces,
  type ShellForm,
} from './bodyFeatures';
import { shellChainSetting, toggledChain } from './BodyPanels';
import { at, exprText, ValueSlots, type PickedRef } from './feature';

const face = (n: number): PickedRef => ({ reference: { entity: { id: [`f${n}`] } }, names: {}, label: `Face ${n}` });
const edge: PickedRef = { reference: { entity: { id: ['e1'] } }, names: {}, label: 'Edge of Body 1' };

describe('Fillet and Chamfer', () => {
  it('open with Tangent chain on', () => {
    expect(tangentChainSetting.on).toBe(true);
  });

  it('flip a two-distance chamfer by swapping its distances', () => {
    expect(flipChamfer({ size: 'twoDistances', distance: '1', second: 'd2 * 2', flipped: false })).toEqual({
      distance: 'd2 * 2',
      second: '1',
    });
  });

  it('flip a distance-and-angle chamfer on and off, and write the flip only when on', () => {
    const angled = { ...newChamferForm(), size: 'distanceAngle' as const, angle: '30' };
    expect(flipChamfer(angled)).toEqual({ flipped: true });
    expect(flipChamfer({ ...angled, flipped: true })).toEqual({ flipped: false });

    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(3) });
    const target = { part: ids.part, feature: editor.newId('feat'), name: 'Chamfer 1' };
    const built = (flipped: boolean) => {
      const b = buildChamfer(
        editor.document,
        target,
        { ...angled, targets: [edge], flipped },
        new ValueSlots(() => editor.newId('val')),
      );
      if (!b.ok) throw new Error(b.message);
      return b.inputs;
    };
    const size = (inputs: Json) => at(inputs, 'sets', 0, 'size', 'distanceAngle') as Json;
    expect('flipped' in size(built(false))).toBe(false);
    expect(exprText(size(built(true)).flipped)).toBe('true');
    expect(readChamfer(editor.document, ids.part, built(true))?.flipped).toBe(true);
    expect(readChamfer(editor.document, ids.part, built(false))?.flipped).toBe(false);
  });
});

describe('Shell', () => {
  it('opens with Tangent chain on, and a face brings its tangent chain', () => {
    expect(shellChainSetting.on).toBe(true);
    expect(toggledChain([], face(1), [face(2), face(3)]).map((f) => f.label)).toEqual(['Face 1', 'Face 2', 'Face 3']);
    expect(toggledChain([face(2)], face(1), [face(2)]).map((f) => f.label)).toEqual(['Face 2', 'Face 1']);
  });

  it('drops only the face clicked again', () => {
    expect(toggledChain([face(1), face(2)], face(1), [face(2)]).map((f) => f.label)).toEqual(['Face 2']);
  });

  // Labels that never say which body a face lies on: the bodies are renamed, and the faces' labels name no body.
  const body = (n: number): PickedRef => ({
    reference: { entity: { id: [`b${n}`] } },
    names: {},
    label: `Renamed ${n}`,
  });
  const faceOf = (n: number): PickedRef => ({
    reference: { entity: { id: [`f${n}`] } },
    names: {},
    label: 'Face of Body 9',
  });
  const empty = { faces: [], bodies: [], owners: [] };
  const bodyLabels = (f: { bodies: PickedRef[] }) => f.bodies.map((x) => x.label);

  it('brings a face its body, and drops the body with its last face, by the body the pick gave', () => {
    let form = withShellFaces(empty, [faceOf(1)], body(1));
    form = withShellFaces(form, [...form.faces, faceOf(2)], body(1));
    expect(bodyLabels(form)).toEqual(['Renamed 1']);
    expect(shellBodyOf(form, faceOf(2))).toBe(form.bodies[0]);
    form = withShellFaces(form, [faceOf(2)]);
    expect(bodyLabels(form)).toEqual(['Renamed 1']);
    form = withShellFaces(form, []);
    expect(form).toEqual(empty);
  });

  it('keeps a body whose face has no known body yet', () => {
    const stored = { faces: [faceOf(1)], bodies: [body(1)], owners: [] };
    expect(shellBodyOf(stored, faceOf(1))).toBeUndefined();
    expect(withShellFaces(stored, [])).toEqual({ faces: [], bodies: [body(1)], owners: [] });
  });

  it('takes a body picked as a body, and drops it with its faces when picked again', () => {
    let form = toggledShellBody(empty, body(2));
    expect(bodyLabels(form)).toEqual(['Renamed 2']);
    form = withShellFaces(form, [faceOf(1)], body(1));
    // A face on another body leaves a body picked as a body alone, also when it goes.
    expect(bodyLabels(withShellFaces(form, []))).toEqual(['Renamed 2']);
    form = toggledShellBody(form, body(1));
    expect(form).toEqual({ faces: [], bodies: [body(2)], owners: [] });
    expect(toggledShellBody(form, body(2))).toEqual(empty);
  });

  it('writes a closed body with no removed face, and an outside thickness only on both sides', () => {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(4) });
    const target = { part: ids.part, feature: editor.newId('feat'), name: 'Shell 1' };
    const built = (patch: Partial<ShellForm>) => {
      const b = buildShell(
        editor.document,
        target,
        { ...newShellForm(), bodies: [body(1)], ...patch },
        new ValueSlots(() => editor.newId('val')),
      );
      if (!b.ok) throw new Error(b.message);
      return b.inputs;
    };
    const closed = built({});
    expect(closed.remove).toEqual({ set: [] });
    expect('outsideThickness' in closed).toBe(false);
    const both = built({ direction: 'both', thickness: '2', outside: '3' });
    expect(exprText(both.outsideThickness)).toBe('3 mm');
    expect(readShell(editor.document, ids.part, both)).toMatchObject({
      direction: 'both',
      thickness: '2',
      outside: '3',
    });
    expect(
      buildShell(editor.document, target, newShellForm(), new ValueSlots(() => editor.newId('val'))),
    ).toMatchObject({ ok: false, quiet: true });
  });
});

describe('a new blend or shell', () => {
  it('starts at one size', () => {
    expect([newFilletForm().radius, newChamferForm().distance, newShellForm().thickness]).toEqual([
      BLEND_SIZE,
      BLEND_SIZE,
      BLEND_SIZE,
    ]);
  });
});
