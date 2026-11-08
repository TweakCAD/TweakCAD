import { describe, expect, it } from 'vitest';
import { bindExpression, freeValueName, visibleNames, withDefaultUnit } from './expressions';
import type { Json } from './rows';
import { standardDocument } from './testDocs';

const LENGTH = { type: 'number', quantity: 'length' } as const;

describe('bindExpression', () => {
  it('binds parameters of the part and the document, and earlier named values', () => {
    const { doc, ids } = standardDocument();
    const scope = { part: ids.part, feature: ids.extrude2 };
    const names = visibleNames(doc, scope);
    expect(names.get('width')).toEqual({ parameter: { id: ids.width } });
    expect(names.get('height')).toEqual({ parameter: { id: ids.height } });
    expect(names.get('depth')).toEqual({ value: { id: ids.depth } });

    const bound = bindExpression(doc, scope, ' width / 2 + depth ', LENGTH);
    expect(bound).toEqual({
      ok: true,
      def: {
        expr: {
          text: 'width / 2 + depth',
          grammar: 1,
          refs: { width: { parameter: { id: ids.width } }, depth: { value: { id: ids.depth } } },
        },
      },
      // The selected configuration row sets height to 10 mm, so depth is 10 mm.
      stored: 30,
    });
  });

  it("binds an assembly's own parameters in its scope, with the document's", () => {
    const { doc, ids, t } = standardDocument();
    const asm = (doc.assemblies as Json[]).find((a) => a.id === ids.assembly) as Json;
    const gap = t.parameter('gap', '15 mm');
    asm.parameters = [{ id: t.id('tbl'), name: 'Assembly', parameters: [gap] }];
    const names = visibleNames(doc, { part: ids.assembly, feature: '' });
    expect(names.get('gap')).toEqual({ parameter: { id: gap.id } });
    expect(names.get('width')).toEqual({ parameter: { id: ids.width } });
    expect(names.has('depth')).toBe(false);
    expect(bindExpression(doc, { part: ids.assembly, feature: '' }, 'gap * 2', LENGTH)).toMatchObject({
      ok: true,
      stored: 30,
    });
  });

  it('does not see named values of later features, or the value being edited', () => {
    const { doc, ids } = standardDocument();
    expect(visibleNames(doc, { part: ids.part, feature: ids.sketch }).has('depth')).toBe(false);
    expect(visibleNames(doc, { part: ids.part, feature: ids.extrude, self: ids.depth }).has('depth')).toBe(false);
    const refused = bindExpression(doc, { part: ids.part, feature: ids.sketch }, 'depth * 2', LENGTH);
    expect(refused).toEqual({ ok: false, message: 'depth is not a parameter or named value here' });
  });

  it('refuses bad text and the wrong quantity with a plain message', () => {
    const { doc, ids } = standardDocument();
    const scope = { part: ids.part, feature: ids.sketch };
    expect(bindExpression(doc, scope, '', LENGTH)).toEqual({ ok: false, message: 'Type a value' });
    expect(bindExpression(doc, scope, '2 *', LENGTH).ok).toBe(false);
    expect(bindExpression(doc, scope, '30 deg', LENGTH).ok).toBe(false);
    expect(bindExpression(doc, scope, '30 deg', { type: 'number', quantity: 'angle' })).toMatchObject({
      ok: true,
      stored: 30,
    });
  });

  it('binds a measured value, which has no result before the geometry is evaluated', () => {
    const { doc, ids, t } = standardDocument();
    const part = (doc.parts as Json[])[0] as Json;
    const measured = {
      id: t.id('val'),
      name: 'm1',
      def: { measure: { kind: 'area', of: [{ standard: { name: 'xy' } }] } },
    };
    const measure = {
      id: t.id('feat'),
      type: 'core.measure',
      typeVersion: 1,
      name: 'Measure 1',
      suppressed: t.flag(false),
      frozen: { live: {} },
      command: { alone: {} },
      inputs: { values: [measured] },
    };
    (part.timeline as Json[]).push(measure);
    const bound = bindExpression(doc, { part: ids.part, feature: measure.id }, 'm1 / 1 mm', LENGTH);
    expect(bound).toMatchObject({
      ok: true,
      stored: null,
      def: { expr: { refs: { m1: { value: { id: measured.id } } } } },
    });
    // Other values are still evaluated: a wrong quantity is refused.
    expect(bindExpression(doc, { part: ids.part, feature: measure.id }, 'width * 1 mm', LENGTH).ok).toBe(false);
  });

  it('finds a free value name', () => {
    const { doc, ids } = standardDocument();
    expect(freeValueName(doc, ids.part, 'd')).toBe('d1');
    const part = (doc.parts as Json[])[0] as Json;
    const sketch = (part.timeline as Json[])[0] as Json;
    for (const c of (sketch.inputs as Json).constraints as Json[]) (c.value as Json).name = 'd1';
    expect(freeValueName(doc, ids.part, 'd')).toBe('d2');
    expect(freeValueName(doc, ids.part, 'height')).toBe('height1');
  });
});

describe('withDefaultUnit', () => {
  it('puts the field unit on a bare number and leaves anything else as written', () => {
    expect(withDefaultUnit(' 20 ', 'mm')).toBe('20 mm');
    expect(withDefaultUnit('-1.5e2', 'deg')).toBe('-1.5e2 deg');
    expect(withDefaultUnit('20 in', 'mm')).toBe('20 in');
    expect(withDefaultUnit('width / 2', 'mm')).toBe('width / 2');
  });
});
