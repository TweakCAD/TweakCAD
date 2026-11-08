import { describe, expect, it } from 'vitest';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { standardDocument } from '../../../lib/editor/src/testDocs';
import {
  BOOLEAN_OPS,
  buildBoolean,
  buildPattern,
  CIRCULAR_DISTRIBUTIONS,
  clickBooleanBody,
  COPY_OPS,
  DIRECTION_TYPES,
  newBooleanForm,
  newPatternForm,
  parseSuppress,
  PATTERN_SPACING,
  readBoolean,
  readPattern,
  withDistribution,
} from './bodyFeatures';
import { ValueSlots, type PickedRef } from './feature';

const body = (n: number): PickedRef => ({ reference: { entity: { id: [`b${n}`] } }, names: {}, label: `Body ${n}` });

describe('the Combine panel', () => {
  it('takes the target first, then adds and drops tools as they are clicked', () => {
    let form = { target: null as PickedRef | null, tools: [] as PickedRef[] };
    const click = (n: number, armed: 'target' | 'tools') => {
      const next = clickBooleanBody(form, body(n), armed);
      if (typeof next === 'string') return next;
      form = next;
      return null;
    };
    click(1, 'target');
    click(2, 'tools');
    click(3, 'tools');
    expect(form.target?.label).toBe('Body 1');
    expect(form.tools.map((t) => t.label)).toEqual(['Body 2', 'Body 3']);
    // A tool clicked again is dropped; the target is no tool.
    click(2, 'tools');
    expect(form.tools.map((t) => t.label)).toEqual(['Body 3']);
    expect(click(1, 'tools')).toBe('That body is the target');
    // A tool made the target leaves the tools.
    click(3, 'target');
    expect(form).toEqual({ target: body(3), tools: [] });
  });

  it('offers Join, Cut and Intersect as one Operation', () => {
    expect(BOOLEAN_OPS.map((o) => o.label)).toEqual(['Join', 'Cut', 'Intersect']);
  });

  it('writes Keep Tools and reads it back', () => {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const target = { part: ids.part, feature: editor.newId('feat'), name: 'Combine 1' };
    const form = { ...newBooleanForm('cut'), target: body(1), tools: [body(2)], keepTools: true };
    const built = buildBoolean(editor.document, target, form, new ValueSlots(() => editor.newId('val')));
    if (!built.ok) throw new Error(built.message);
    const read = readBoolean(editor.document, ids.part, built.inputs);
    expect(read.keepTools).toBe(true);
    expect(read.op).toBe('cut');
    expect(newBooleanForm().keepTools).toBe(false);
  });

  it('reads stored bodies back under a placeholder that is no body name, until the state before names them', () => {
    const { doc, ids } = standardDocument();
    const read = readBoolean(doc, ids.part, {
      target: body(4).reference,
      tools: { set: [body(5).reference, body(6).reference] },
    });
    expect([read.target?.label, ...read.tools.map((t) => t.label)]).toEqual(['Target body', 'Tool body', 'Tool body']);
  });
});

describe('the Pattern panel', () => {
  const { doc, ids } = standardDocument();
  const editor = new Editor(doc, { ids: seededIds(7) });
  const target = { part: ids.part, feature: editor.newId('feat'), name: 'Pattern 1' };
  const build = (patch: Partial<ReturnType<typeof newPatternForm>>) =>
    buildPattern(
      editor.document,
      target,
      { ...newPatternForm(), items: [body(1)], ...patch },
      new ValueSlots(() => editor.newId('val')),
    );

  it('writes an extent as the spacing it shares out, and reads it back as an extent', () => {
    const built = build({
      distance: 'extent',
      directions: [{ ...newPatternForm().directions[0]!, count: '4', spacing: '30' }],
    });
    if (!built.ok) throw new Error(built.message);
    const read = readPattern(editor.document, ids.part, built.inputs);
    expect(read.distance).toBe('extent');
    expect(read.directions[0]?.spacing).toBe('30');
    expect(build({ distance: 'extent', directions: [{ ...newPatternForm().directions[0]!, count: '1' }] }).ok).toBe(
      false,
    );
  });

  it('shares a symmetric extent out over the copies on the side with more of them, and reads it back', () => {
    const built = build({
      distance: 'extent',
      directions: [{ ...newPatternForm().directions[0]!, count: '4', spacing: '100', symmetric: true }],
    });
    if (!built.ok) throw new Error(built.message);
    const row = ((built.inputs.layout as Json).linear as Json).directions as Json[];
    expect(((((row[0] as Json).spacing as Json).equal as Json).s as Json).def).toMatchObject({
      expr: { text: '(100 mm) / ceil((4 - 1) / 2)' },
    });
    const read = readPattern(editor.document, ids.part, built.inputs);
    expect([read.distance, read.directions[0]?.spacing, read.directions[0]?.symmetric]).toEqual([
      'extent',
      '100',
      true,
    ]);
  });

  it('writes suppressed copies and reads them back', () => {
    const built = build({ suppress: '3, 2' });
    if (!built.ok) throw new Error(built.message);
    expect(readPattern(editor.document, ids.part, built.inputs).suppress).toBe('2, 3');
    expect(parseSuppress('1', false).ok).toBe(false);
    expect(parseSuppress('2:3, 1:2', true)).toEqual({
      ok: true,
      slots: [
        { i: 1, j: 2 },
        { i: 0, j: 1 },
      ],
    });
    expect(build({ suppress: 'two' }).ok).toBe(false);
  });

  it('writes a symmetric direction and reads it back; a one-direction pattern writes no symmetric', () => {
    const one = build({});
    if (!one.ok) throw new Error(one.message);
    const row = (inputs: Record<string, unknown>) =>
      (inputs.layout as { linear: { directions: Record<string, unknown>[] } }).linear.directions[0] as Record<
        string,
        unknown
      >;
    expect('symmetric' in row(one.inputs)).toBe(false);
    const both = build({ directions: [{ ...newPatternForm().directions[0]!, symmetric: true }] });
    if (!both.ok) throw new Error(both.message);
    expect(row(both.inputs).symmetric).toMatchObject({ def: { expr: { text: 'true' } } });
    expect(readPattern(editor.document, ids.part, both.inputs).directions[0]?.symmetric).toBe(true);
    expect(DIRECTION_TYPES.map((t) => t.label)).toEqual(['One Direction', 'Symmetric']);
  });

  it('numbers the copies on the other side of the source -2, -3 in Suppress', () => {
    expect(parseSuppress('-2, 3', false)).toEqual({
      ok: true,
      slots: [
        { i: -1, j: 0 },
        { i: 2, j: 0 },
      ],
    });
    expect(parseSuppress('-3:2', true)).toEqual({ ok: true, slots: [{ i: -2, j: 1 }] });
    expect(parseSuppress('0', false).ok).toBe(false);
    expect(parseSuppress('-1', false).ok).toBe(false);
    const built = build({ directions: [{ ...newPatternForm().directions[0]!, symmetric: true }], suppress: '2, -2' });
    if (!built.ok) throw new Error(built.message);
    expect(readPattern(editor.document, ids.part, built.inputs).suppress).toBe('-2, 2');
  });

  it('offers Full, Partial and Symmetric for a circular pattern, and writes each', () => {
    expect(CIRCULAR_DISTRIBUTIONS.map((d) => d.label)).toEqual(['Full', 'Partial', 'Symmetric']);
    const circular = (patch: Partial<ReturnType<typeof newPatternForm>['circular']>) =>
      build({ layout: 'circular', circular: { ...newPatternForm().circular, ...patch } });
    const layout = (built: ReturnType<typeof build>) => {
      if (!built.ok) throw new Error(built.message);
      const c = (built.inputs.layout as { circular: Record<string, { def: { expr: { text: string } } }> }).circular;
      return {
        angle: c.angle?.def.expr.text,
        symmetric: c.symmetric?.def.expr.text,
        read: readPattern(editor.document, ids.part, built.inputs).circular.distribution,
      };
    };
    expect(layout(circular({ distribution: 'full', angle: '90' }))).toEqual({
      angle: '360 deg',
      symmetric: 'false',
      read: 'full',
    });
    expect(layout(circular({ distribution: 'partial', angle: '90' }))).toEqual({
      angle: '90 deg',
      symmetric: 'false',
      read: 'partial',
    });
    expect(layout(circular({ distribution: 'symmetric', angle: '45' }))).toEqual({
      angle: '45 deg',
      symmetric: 'true',
      read: 'symmetric',
    });
    expect(circular({ distribution: 'symmetric', angle: '180' }).ok).toBe(true);
    expect(circular({ distribution: 'symmetric', angle: '360' }).ok).toBe(false);
    // Picking Symmetric brings a full turn under a full turn; an angle that fits stays.
    expect(withDistribution(newPatternForm().circular, 'symmetric').angle).toBe('90');
    expect(withDistribution({ ...newPatternForm().circular, angle: '30' }, 'symmetric').angle).toBe('30');
  });

  it('words its Operation as Mirror does, and spaces copies as a component pattern does', () => {
    expect(COPY_OPS.map((o) => o.label)).toEqual(['Join', 'New Body']);
    expect(newPatternForm().directions[0]?.spacing).toBe(PATTERN_SPACING);
  });
});
