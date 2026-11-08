import { describe, expect, it } from 'vitest';
import { Editor, type Json } from '@tweakcad/editor';
import { DocBuilder } from '@tweakcad/worker/src/v2/docBuilder';
import { modelParametersOf, setModelParameter, valueLabel } from './modelParameters';
import { initialParametersTab } from './ParametersDialog';

/** A 60 × 40 sketch dimensioned along x, extruded 10 mm. */
function plate() {
  const d = new DocBuilder();
  const s = d.sketch('xy', (x) => {
    const r = x.rect(0, 0, 60, 40);
    x.distanceX(r.points[0] as string, r.points[1] as string, '60 mm');
  });
  const extrude = d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '10 mm' }] });
  return { doc: d.document(), part: d.partId, sketch: s.feature, extrude };
}

describe('model parameters', () => {
  it('lists the numbers each feature is built from, by feature, with what they come to', () => {
    const { doc, part, sketch, extrude } = plate();
    const groups = modelParametersOf(doc, part);
    expect(groups.map((g) => [g.feature, g.name])).toEqual([
      [sketch, 'Sketch 1'],
      [extrude, 'Extrude 1'],
    ]);
    expect(groups[0]?.parameters.map((p) => [p.label, p.text, p.value])).toEqual([['Dimension', '60 mm', '60 mm']]);
    const distance = groups[1]?.parameters.find((p) => p.label === 'Distance');
    expect(distance).toMatchObject({ text: '10 mm', value: '10 mm', quantity: 'length' });
    // Flags and choices (the operation, the direction's reversal) are not listed.
    expect(groups[1]?.parameters.every((p) => p.quantity !== undefined && !/op|reversed/i.test(p.label))).toBe(true);
  });

  it('shows a value by its name when it has one', () => {
    const { doc, part } = plate();
    const sketch = (doc.parts as Json[])[0]?.timeline as Json[];
    const dimension = ((sketch[0]?.inputs as Json).constraints as Json[]).find((c) => c.kind === 'distanceX') as Json;
    (dimension.value as Json).name = 'width';
    expect(modelParametersOf(doc, part)[0]?.parameters[0]).toMatchObject({ name: 'width', label: 'Dimension' });
  });

  it('edits a value in its unit, as one undo step, and refuses what does not evaluate', () => {
    const { doc, part } = plate();
    const editor = new Editor(doc);
    const distance = () => modelParametersOf(editor.document, part)[1]?.parameters.find((p) => p.label === 'Distance');
    expect(setModelParameter(editor, part, distance()!, '15').ok).toBe(true);
    expect(distance()).toMatchObject({ text: '15 mm', value: '15 mm' });
    expect(setModelParameter(editor, part, distance()!, 'nope').ok).toBe(false);
    editor.undo();
    expect(distance()?.text).toBe('10 mm');
  });

  it('labels a value by its innermost telling key', () => {
    expect(valueLabel(['sides', '0', 'extent', 'distance', 'd'])).toBe('Distance');
    expect(valueLabel(['sides', '1', 'extent', 'distance', 'd'])).toBe('Distance (side 2)');
    expect(valueLabel(['sides', '0', 'taper'])).toBe('Taper');
    expect(valueLabel(['countersinkAngle'])).toBe('Countersink angle');
  });
});

describe('the parameters dialog', () => {
  it('opens on the part shown, or the document tab when none is', () => {
    const { doc, part } = plate();
    expect(initialParametersTab(doc, part)).toBe(part);
    expect(initialParametersTab(doc, null)).toBe('document');
    expect(initialParametersTab(doc, 'part_gone')).toBe('document');
  });
});
